import {
	type AuthInfo,
	createMcpHandler,
	isLegacyRequest,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { authenticate, touchToken, unauthorized } from "./auth";
import type { Env } from "./env";
import { createRallyServer } from "./mcp";
import { handleOAuth } from "./oauth";
import { expireStaleClaims } from "./tasks";

const MCP_PATH = "/mcp";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || url.pathname === "/health") {
			return json({
				name: "rally-mcp",
				tagline: "Many agents. One main branch.",
				status: "ok",
				mcp: `${url.origin}${MCP_PATH}`,
			});
		}

		const oauthResponse = await handleOAuth(request, env, url);
		if (oauthResponse) return oauthResponse;

		if (url.pathname === MCP_PATH) {
			const auth = await authenticate(request, env);
			if (!auth.ok) return unauthorized(url.origin, auth.reason);
			ctx.waitUntil(touchToken(env, auth.actor.tokenId));

			const authInfo: AuthInfo = {
				token: auth.token,
				clientId: auth.actor.client ?? "api-token",
				scopes: ["rally"],
				extra: { role: auth.actor.role, name: auth.actor.name },
			};
			const parsedBody =
				request.method === "POST"
					? await request
							.clone()
							.json()
							.catch(() => undefined)
					: undefined;

			// Stateless serving for both protocol eras; nothing survives the request either way.
			if (await isLegacyRequest(request, parsedBody)) {
				// 2025-era clients (current ChatGPT / Claude): one server + transport per request,
				// plain JSON responses instead of SSE since Rally never streams notifications.
				const server = createRallyServer(env, auth.actor);
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				await server.connect(transport);
				try {
					return await transport.handleRequest(request, { authInfo, parsedBody });
				} finally {
					ctx.waitUntil(Promise.all([transport.close(), server.close()]));
				}
			}

			// 2026-07-28 protocol revision.
			const handler = createMcpHandler(() => createRallyServer(env, auth.actor), {
				legacy: "reject",
			});
			return handler.fetch(request, { authInfo, parsedBody });
		}

		return json({ error: "not_found" }, 404);
	},

	/** Cron trigger (see wrangler.jsonc): release lapsed claims even when no agent is asking for work. */
	async scheduled(_event, env, ctx): Promise<void> {
		ctx.waitUntil(expireStaleClaims(env.DB));
	},
} satisfies ExportedHandler<Env>;

import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { callTool, createProject } from "./helpers";

const ORIGIN = "https://rally.test";

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function registerClient(): Promise<string> {
	const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "Test Assistant",
			redirect_uris: ["https://assistant.example/callback"],
		}),
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as { client_id: string };
	return body.client_id;
}

async function authorize(
	clientId: string,
	challenge: string,
	fields: { identity: string; name: string; access_key: string },
): Promise<Response> {
	const form = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://assistant.example/callback",
		state: "xyz",
		code_challenge: challenge,
		code_challenge_method: "S256",
		scope: "rally",
		resource: `${ORIGIN}/mcp`,
		decision: "allow",
		...fields,
	});
	return SELF.fetch(`${ORIGIN}/oauth/authorize`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form.toString(),
		redirect: "manual",
	});
}

async function exchange(params: Record<string, string>): Promise<Response> {
	return SELF.fetch(`${ORIGIN}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
}

/** Run the whole authorization code flow and return the token pair. */
async function signIn(identity: string, name: string) {
	const clientId = await registerClient();
	const { verifier, challenge } = await pkce();
	const res = await authorize(clientId, challenge, {
		identity,
		name,
		access_key: "test-access-key",
	});
	expect(res.status).toBe(302);
	const code = new URL(res.headers.get("location") as string).searchParams.get("code") as string;
	const tokens = await exchange({
		grant_type: "authorization_code",
		code,
		client_id: clientId,
		redirect_uri: "https://assistant.example/callback",
		code_verifier: verifier,
	});
	expect(tokens.status).toBe(200);
	return {
		clientId,
		code,
		verifier,
		...((await tokens.json()) as { access_token: string; refresh_token: string }),
	};
}

let projectId = "";

beforeAll(async () => {
	await createProject("oauth");
	const row = await env.DB.prepare("SELECT id FROM projects WHERE slug = 'oauth'").first<{
		id: string;
	}>();
	projectId = (row as { id: string }).id;
});

describe("discovery", () => {
	it("serves protected resource and authorization server metadata", async () => {
		const prm = (await (
			await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`)
		).json()) as Record<string, unknown>;
		expect(prm.resource).toBe(`${ORIGIN}/mcp`);
		expect(prm.authorization_servers).toEqual([ORIGIN]);

		const as = (await (
			await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)
		).json()) as Record<string, unknown>;
		expect(as.issuer).toBe(ORIGIN);
		expect(as.code_challenge_methods_supported).toEqual(["S256"]);
		expect(as.scopes_supported).toEqual(["rally"]);
	});
});

describe("authorization code flow", () => {
	it("offers owner and per-project agent identities", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		const url = new URL(`${ORIGIN}/oauth/authorize`);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: "https://assistant.example/callback",
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: "abc",
		}).toString();
		const res = await SELF.fetch(url);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Test Assistant");
		expect(html).toContain('value="owner"');
		expect(html).toContain(`value="agent:${projectId}"`);
		expect(html).toContain('name="state" value="abc"');
	});

	it("rejects unregistered redirect URIs", async () => {
		const clientId = await registerClient();
		const url = new URL(`${ORIGIN}/oauth/authorize`);
		url.search = new URLSearchParams({
			client_id: clientId,
			redirect_uri: "https://evil.example/callback",
			code_challenge: "x",
		}).toString();
		expect((await SELF.fetch(url)).status).toBe(400);
	});

	it("rejects a wrong access key, a missing name and an unknown identity", async () => {
		const clientId = await registerClient();
		const { challenge } = await pkce();
		const wrongKey = await authorize(clientId, challenge, {
			identity: "owner",
			name: "Linus",
			access_key: "wrong",
		});
		expect(wrongKey.status).toBe(401);
		expect(await wrongKey.text()).toContain("Wrong access key");
		const noName = await authorize(clientId, challenge, {
			identity: "owner",
			name: " ",
			access_key: "test-access-key",
		});
		expect(await noName.text()).toContain("Enter a name");
		const badIdentity = await authorize(clientId, challenge, {
			identity: "agent:prj_nope",
			name: "x",
			access_key: "test-access-key",
		});
		expect(await badIdentity.text()).toContain("Pick how to connect");
	});

	it("issues owner tokens with PKCE and rotates refresh tokens", async () => {
		const tokens = await signIn("owner", "Linus via ChatGPT");
		expect(tokens.code).toMatch(/^rally_code_/);

		const reused = await exchange({
			grant_type: "authorization_code",
			code: tokens.code,
			client_id: tokens.clientId,
			code_verifier: tokens.verifier,
		});
		expect(reused.status).toBe(400);

		const { projects } = await callTool("list_projects", {}, tokens.access_token);
		expect(projects.map((p: { slug: string }) => p.slug)).toContain("oauth");
		await callTool(
			"create_tasks",
			{ project: "oauth", tasks: [{ title: "From ChatGPT" }] },
			tokens.access_token,
		);
		const { events } = await callTool(
			"get_activity",
			{ project: "oauth", limit: 1 },
			tokens.access_token,
		);
		expect(events[0]).toMatchObject({ actor: "Linus via ChatGPT", role: "owner" });

		const refreshed = await exchange({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: tokens.clientId,
		});
		expect(refreshed.status).toBe(200);
		const next = (await refreshed.json()) as { access_token: string };
		await callTool("list_projects", {}, next.access_token);

		const replay = await exchange({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
		});
		expect(replay.status).toBe(400);
	});

	it("issues agent tokens bound to the chosen project", async () => {
		const tokens = await signIn(`agent:${projectId}`, "laptop-agent");
		const work = await callTool("request_work", {}, tokens.access_token);
		expect(work.project.slug).toBe("oauth");
		const list = await SELF.fetch(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
				authorization: `Bearer ${tokens.access_token}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		const names = (
			(await list.json()) as { result: { tools: Array<{ name: string }> } }
		).result.tools.map((t) => t.name);
		expect(names).not.toContain("create_project");
	});
});

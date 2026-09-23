/**
 * Minimal OAuth 2.1 authorization server so ChatGPT / Claude can connect via their standard flow.
 *
 * Supports: authorization code + PKCE (S256), dynamic client registration (RFC 7591),
 * client ID metadata documents (https client_id URLs), refresh token rotation.
 * The "login" is the owner access key (Worker secret) plus picking who connects: the owner
 * (plan and monitor every project) or an agent bound to one project.
 */
import { ACCESS_TOKEN_TTL_SECONDS, issueToken, REFRESH_TOKEN_TTL_SECONDS } from "./auth";
import {
	isoPlusSeconds,
	newId,
	nowIso,
	type Role,
	randomToken,
	sha256Base64url,
	sha256Hex,
} from "./db";
import type { Env } from "./env";

const CODE_TTL_SECONDS = 10 * 60;
const SCOPE = "rally";

interface ClientRow {
	client_id: string;
	client_name: string | null;
	redirect_uris: string;
}

interface CodeRow {
	code_hash: string;
	client_id: string;
	role: Role;
	project_id: string | null;
	name: string;
	redirect_uri: string;
	code_challenge: string;
	scope: string | null;
	resource: string | null;
	expires_at: string;
	used_at: string | null;
}

interface ProjectRow {
	id: string;
	slug: string;
	name: string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
	});

const oauthError = (error: string, description: string, status = 400) =>
	json({ error, error_description: description }, status);

export function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/oauth/token`,
		registration_endpoint: `${origin}/oauth/register`,
		response_types_supported: ["code"],
		response_modes_supported: ["query"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		scopes_supported: [SCOPE],
		client_id_metadata_document_supported: true,
	};
}

export function protectedResourceMetadata(origin: string) {
	return {
		resource: `${origin}/mcp`,
		authorization_servers: [origin],
		scopes_supported: [SCOPE],
		bearer_methods_supported: ["header"],
		resource_name: "Rally task queue",
	};
}

/** Returns a Response for OAuth/discovery routes, or null if the path is not ours. */
export async function handleOAuth(request: Request, env: Env, url: URL): Promise<Response | null> {
	const { pathname } = url;
	const origin = url.origin;

	if (pathname === "/.well-known/oauth-authorization-server") {
		return json(authorizationServerMetadata(origin));
	}
	if (
		pathname === "/.well-known/oauth-protected-resource" ||
		pathname === "/.well-known/oauth-protected-resource/mcp"
	) {
		return json(protectedResourceMetadata(origin));
	}
	if (pathname === "/oauth/register" && request.method === "POST") return register(request, env);
	if (pathname === "/oauth/authorize" && request.method === "GET")
		return authorizeForm(request, env, url);
	if (pathname === "/oauth/authorize" && request.method === "POST")
		return authorizeSubmit(request, env, url);
	if (pathname === "/oauth/token" && request.method === "POST") return token(request, env);
	if (pathname.startsWith("/oauth/"))
		return oauthError("invalid_request", "Unknown OAuth endpoint", 404);
	return null;
}

// ---------- Client registration ----------

function isAllowedRedirectUri(uri: string): boolean {
	try {
		const u = new URL(uri);
		if (u.protocol === "https:") return true;
		return u.protocol === "http:" && isLoopback(u.hostname);
	} catch {
		return false;
	}
}

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Exact match, except loopback redirect URIs where the port may vary (RFC 8252 §7.3). */
function redirectUriMatches(registered: string, requested: string): boolean {
	if (registered === requested) return true;
	try {
		const a = new URL(registered);
		const b = new URL(requested);
		if (!isLoopback(a.hostname) || !isLoopback(b.hostname)) return false;
		return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname;
	} catch {
		return false;
	}
}

async function register(request: Request, env: Env): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return oauthError("invalid_client_metadata", "Body must be JSON");
	}
	const redirectUris = Array.isArray(body.redirect_uris)
		? body.redirect_uris.filter((u) => typeof u === "string")
		: [];
	if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
		return oauthError(
			"invalid_redirect_uri",
			"redirect_uris must be https URLs or http loopback URLs",
		);
	}
	const clientId = newId("client", 16);
	const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : null;
	const ts = nowIso();
	await env.DB.prepare(
		"INSERT INTO oauth_clients (client_id, client_name, redirect_uris, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(clientId, clientName, JSON.stringify(redirectUris), JSON.stringify(body), ts, ts)
		.run();
	return json(
		{
			client_id: clientId,
			client_name: clientName ?? undefined,
			redirect_uris: redirectUris,
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			client_id_issued_at: Math.floor(Date.now() / 1000),
		},
		201,
	);
}

/** Load a registered client, or fetch + cache a client ID metadata document for https client ids. */
async function resolveClient(
	env: Env,
	clientId: string,
	refresh: boolean,
): Promise<ClientRow | null> {
	const stored = await env.DB.prepare(
		"SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?",
	)
		.bind(clientId)
		.first<ClientRow>();
	if (!clientId.startsWith("https://")) return stored;
	if (stored && !refresh) return stored;

	let url: URL;
	try {
		url = new URL(clientId);
	} catch {
		return null;
	}
	if (url.pathname === "/" || isLoopback(url.hostname) || url.username || url.password) return null;

	try {
		const res = await fetch(clientId, {
			headers: { accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return stored;
		const text = (await res.text()).slice(0, 20_000);
		const doc = JSON.parse(text) as Record<string, unknown>;
		if (doc.client_id !== clientId) return stored;
		const redirectUris = Array.isArray(doc.redirect_uris)
			? doc.redirect_uris.filter((u) => typeof u === "string")
			: [];
		if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) return stored;
		const clientName = typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : null;
		const ts = nowIso();
		await env.DB.prepare(
			`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, metadata, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
			   metadata = excluded.metadata, updated_at = excluded.updated_at`,
		)
			.bind(clientId, clientName, JSON.stringify(redirectUris), text, ts, ts)
			.run();
		return {
			client_id: clientId,
			client_name: clientName,
			redirect_uris: JSON.stringify(redirectUris),
		};
	} catch {
		return stored;
	}
}

// ---------- Authorization endpoint ----------

interface AuthorizeParams {
	clientId: string;
	redirectUri: string;
	state: string | null;
	codeChallenge: string;
	scope: string | null;
	resource: string | null;
}

function readAuthorizeParams(
	params: URLSearchParams,
): { ok: true; value: AuthorizeParams } | { ok: false; error: string } {
	const clientId = params.get("client_id");
	const redirectUri = params.get("redirect_uri");
	const codeChallenge = params.get("code_challenge");
	if (!clientId) return { ok: false, error: "client_id is required" };
	if (!redirectUri) return { ok: false, error: "redirect_uri is required" };
	if ((params.get("response_type") ?? "code") !== "code")
		return { ok: false, error: "response_type must be 'code'" };
	if (!codeChallenge) return { ok: false, error: "code_challenge is required (PKCE)" };
	if ((params.get("code_challenge_method") ?? "S256") !== "S256") {
		return { ok: false, error: "code_challenge_method must be S256" };
	}
	return {
		ok: true,
		value: {
			clientId,
			redirectUri,
			state: params.get("state"),
			codeChallenge,
			scope: params.get("scope"),
			resource: params.get("resource"),
		},
	};
}

async function validateClientAndRedirect(
	env: Env,
	p: AuthorizeParams,
	refresh: boolean,
): Promise<{ ok: true; client: ClientRow } | { ok: false; error: string }> {
	const client = await resolveClient(env, p.clientId, refresh);
	if (!client) return { ok: false, error: `Unknown client_id: ${p.clientId}` };
	const uris = JSON.parse(client.redirect_uris) as string[];
	if (!uris.some((u) => redirectUriMatches(u, p.redirectUri))) {
		return { ok: false, error: "redirect_uri is not registered for this client" };
	}
	return { ok: true, client };
}

async function loadProjects(env: Env): Promise<ProjectRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT id, slug, name FROM projects ORDER BY created_at, slug",
	).all<ProjectRow>();
	return results;
}

async function authorizeForm(request: Request, env: Env, url: URL): Promise<Response> {
	const parsed = readAuthorizeParams(url.searchParams);
	if (!parsed.ok)
		return htmlPage("Invalid request", `<p class="error">${escapeHtml(parsed.error)}</p>`, 400);
	const p = parsed.value;
	const validation = await validateClientAndRedirect(env, p, true);
	if (!validation.ok)
		return htmlPage("Invalid request", `<p class="error">${escapeHtml(validation.error)}</p>`, 400);
	if (!env.RALLY_ACCESS_KEY) {
		return htmlPage(
			"Not configured",
			`<p class="error">RALLY_ACCESS_KEY is not set on this deployment, so OAuth sign-in is disabled.</p>`,
			500,
		);
	}
	const projects = await loadProjects(env);
	return htmlPage(
		"Connect to Rally",
		renderConsentForm(p, validation.client, projects, request.url, null),
	);
}

async function authorizeSubmit(request: Request, env: Env, url: URL): Promise<Response> {
	const form = await request.formData();
	const params = new URLSearchParams();
	for (const [k, v] of form.entries()) if (typeof v === "string") params.set(k, v);
	const parsed = readAuthorizeParams(params);
	if (!parsed.ok)
		return htmlPage("Invalid request", `<p class="error">${escapeHtml(parsed.error)}</p>`, 400);
	const p = parsed.value;
	const validation = await validateClientAndRedirect(env, p, false);
	if (!validation.ok)
		return htmlPage("Invalid request", `<p class="error">${escapeHtml(validation.error)}</p>`, 400);

	const projects = await loadProjects(env);
	const identity = params.get("identity") ?? "";
	const project = identity.startsWith("agent:")
		? projects.find((pr) => `agent:${pr.id}` === identity)
		: undefined;
	const identityOk = identity === "owner" || !!project;
	const name = (params.get("name") ?? "").trim().slice(0, 60);
	const accessKey = params.get("access_key") ?? "";
	const keyOk =
		!!env.RALLY_ACCESS_KEY && (await constantTimeEqual(accessKey, env.RALLY_ACCESS_KEY));

	if (params.get("decision") === "deny") {
		return redirectWithError(p, "access_denied", "The user denied the request");
	}
	if (!identityOk || !name || !keyOk) {
		const message = !identityOk
			? "Pick how to connect."
			: !name
				? "Enter a name."
				: "Wrong access key.";
		return htmlPage(
			"Connect to Rally",
			renderConsentForm(p, validation.client, projects, `${url.origin}/oauth/authorize`, message),
			401,
		);
	}

	const code = randomToken("rally_code");
	await env.DB.prepare(
		`INSERT INTO oauth_codes (code_hash, client_id, role, project_id, name, redirect_uri, code_challenge, scope, resource, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			await sha256Hex(code),
			p.clientId,
			project ? "agent" : "owner",
			project?.id ?? null,
			name,
			p.redirectUri,
			p.codeChallenge,
			p.scope,
			p.resource,
			isoPlusSeconds(CODE_TTL_SECONDS),
		)
		.run();

	const target = new URL(p.redirectUri);
	target.searchParams.set("code", code);
	if (p.state) target.searchParams.set("state", p.state);
	return Response.redirect(target.toString(), 302);
}

function redirectWithError(p: AuthorizeParams, error: string, description: string): Response {
	const target = new URL(p.redirectUri);
	target.searchParams.set("error", error);
	target.searchParams.set("error_description", description);
	if (p.state) target.searchParams.set("state", p.state);
	return Response.redirect(target.toString(), 302);
}

// ---------- Token endpoint ----------

async function token(request: Request, env: Env): Promise<Response> {
	const form = await readForm(request);
	if (!form)
		return oauthError("invalid_request", "Body must be application/x-www-form-urlencoded or JSON");
	const grantType = form.get("grant_type");
	if (grantType === "authorization_code") return exchangeCode(form, env);
	if (grantType === "refresh_token") return refresh(form, env);
	return oauthError(
		"unsupported_grant_type",
		"grant_type must be authorization_code or refresh_token",
	);
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
	const type = request.headers.get("content-type") ?? "";
	try {
		if (type.includes("application/json")) {
			const body = (await request.json()) as Record<string, unknown>;
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(body)) if (typeof v === "string") params.set(k, v);
			return params;
		}
		const params = new URLSearchParams();
		for (const [k, v] of (await request.formData()).entries())
			if (typeof v === "string") params.set(k, v);
		return params;
	} catch {
		return null;
	}
}

async function exchangeCode(form: URLSearchParams, env: Env): Promise<Response> {
	const code = form.get("code");
	const verifier = form.get("code_verifier");
	const clientId = form.get("client_id");
	const redirectUri = form.get("redirect_uri");
	if (!code || !verifier || !clientId) {
		return oauthError("invalid_request", "code, code_verifier and client_id are required");
	}
	const codeHash = await sha256Hex(code);
	const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?")
		.bind(codeHash)
		.first<CodeRow>();
	if (!row || row.used_at || row.expires_at <= nowIso()) {
		return oauthError("invalid_grant", "Authorization code is invalid, expired or already used");
	}
	if (row.client_id !== clientId)
		return oauthError("invalid_grant", "client_id does not match the authorization code");
	if (redirectUri && redirectUri !== row.redirect_uri) {
		return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
	}
	if ((await sha256Base64url(verifier)) !== row.code_challenge) {
		return oauthError("invalid_grant", "PKCE verification failed");
	}
	const client = await env.DB.prepare(
		"SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?",
	)
		.bind(clientId)
		.first<ClientRow>();
	const clientName = client?.client_name ?? clientId;

	const identity = {
		role: row.role,
		projectId: row.project_id,
		name: row.name,
		clientName,
		clientId,
	};
	const access = await issueToken(env, {
		...identity,
		kind: "access",
		ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
	});
	const refreshTok = await issueToken(env, {
		...identity,
		kind: "refresh",
		ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
	});
	await env.DB.batch([
		env.DB.prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?").bind(
			nowIso(),
			codeHash,
		),
		access.statement,
		refreshTok.statement,
	]);
	return json({
		access_token: access.token,
		token_type: "Bearer",
		expires_in: ACCESS_TOKEN_TTL_SECONDS,
		refresh_token: refreshTok.token,
		scope: row.scope ?? SCOPE,
	});
}

async function refresh(form: URLSearchParams, env: Env): Promise<Response> {
	const refreshToken = form.get("refresh_token");
	const clientId = form.get("client_id");
	if (!refreshToken) return oauthError("invalid_request", "refresh_token is required");
	const row = await env.DB.prepare(
		`SELECT id, role, project_id, name, client_name, client_id FROM auth_tokens
		 WHERE token_hash = ? AND kind = 'refresh' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
	)
		.bind(await sha256Hex(refreshToken), nowIso())
		.first<{
			id: string;
			role: Role;
			project_id: string | null;
			name: string;
			client_name: string | null;
			client_id: string | null;
		}>();
	if (!row) return oauthError("invalid_grant", "Refresh token is invalid, expired or revoked");
	if (clientId && row.client_id && clientId !== row.client_id) {
		return oauthError("invalid_grant", "client_id does not match the refresh token");
	}
	const base = {
		role: row.role,
		projectId: row.project_id,
		name: row.name,
		clientName: row.client_name,
		clientId: row.client_id,
	};
	const access = await issueToken(env, {
		...base,
		kind: "access",
		ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
	});
	const next = await issueToken(env, {
		...base,
		kind: "refresh",
		ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
	});
	await env.DB.batch([
		env.DB.prepare("UPDATE auth_tokens SET revoked_at = ? WHERE id = ?").bind(nowIso(), row.id),
		access.statement,
		next.statement,
	]);
	return json({
		access_token: access.token,
		token_type: "Bearer",
		expires_in: ACCESS_TOKEN_TTL_SECONDS,
		refresh_token: next.token,
		scope: SCOPE,
	});
}

// ---------- Helpers ----------

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
	let diff = 0;
	for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
	return diff === 0;
}

export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function htmlPage(title: string, body: string, status = 200): Response {
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Rally</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; } label { display: block; margin: .75rem 0 .25rem; }
  input[type=password], input[type=text] { width: 100%; padding: .5rem; font-size: 1rem; box-sizing: border-box; }
  .identities label { display: block; margin: .25rem 0; }
  button { padding: .6rem 1.2rem; font-size: 1rem; margin-top: 1rem; margin-right: .5rem; }
  .error { color: #b00020; } .muted { color: #666; font-size: .9rem; }
</style></head><body>${body}</body></html>`;
	return new Response(html, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

function renderConsentForm(
	p: AuthorizeParams,
	client: ClientRow,
	projects: ProjectRow[],
	action: string,
	error: string | null,
): string {
	const hidden = Object.entries({
		response_type: "code",
		client_id: p.clientId,
		redirect_uri: p.redirectUri,
		state: p.state ?? "",
		code_challenge: p.codeChallenge,
		code_challenge_method: "S256",
		scope: p.scope ?? "",
		resource: p.resource ?? "",
	})
		.map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
		.join("\n");
	const redirectHost = (() => {
		try {
			return new URL(p.redirectUri).host;
		} catch {
			return p.redirectUri;
		}
	})();
	const clientName = client.client_name ?? client.client_id;
	const identities = [
		`<label><input type="radio" name="identity" value="owner" required> Owner: plan and monitor every project</label>`,
		...projects.map(
			(pr) =>
				`<label><input type="radio" name="identity" value="agent:${escapeHtml(pr.id)}" required> Agent working on <strong>${escapeHtml(pr.name)}</strong> (${escapeHtml(pr.slug)})</label>`,
		),
	].join("");
	return `<h1>Connect to Rally</h1>
<p><strong>${escapeHtml(clientName)}</strong> wants access to Rally.</p>
<p class="muted">After signing in you will be sent back to <code>${escapeHtml(redirectHost)}</code>.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(action)}">
${hidden}
<label>Connect as</label>
<div class="identities">${identities}</div>
<label for="name">Name shown in the activity log</label>
<input type="text" id="name" name="name" maxlength="60" placeholder="Linus / agent-1" required>
<label for="access_key">Access key</label>
<input type="password" id="access_key" name="access_key" autocomplete="current-password" required>
<div>
  <button type="submit" name="decision" value="allow">Allow</button>
  <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</div>
</form>`;
}

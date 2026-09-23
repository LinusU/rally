import type { Actor, Role } from "./db";
import { isoPlusSeconds, newId, nowIso, randomToken, sha256Hex } from "./db";
import type { Env } from "./env";

export const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 180 * 24 * 3600;

interface TokenRow {
	id: string;
	role: Role;
	project_id: string | null;
	name: string;
	client_name: string | null;
}

export type AuthResult =
	| { ok: true; actor: Actor; token: string }
	| { ok: false; reason: "missing" | "invalid" };

/** Resolve `Authorization: Bearer <token>` to an actor, or explain why not. */
export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
	const header = request.headers.get("authorization");
	if (!header) return { ok: false, reason: "missing" };
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	const token = match?.[1]?.trim();
	if (!token) return { ok: false, reason: "invalid" };

	const row = await env.DB.prepare(
		`SELECT id, role, project_id, name, client_name FROM auth_tokens
		 WHERE token_hash = ? AND kind IN ('api', 'access') AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > ?)`,
	)
		.bind(await sha256Hex(token), nowIso())
		.first<TokenRow>();
	if (!row) return { ok: false, reason: "invalid" };

	return {
		ok: true,
		token,
		actor: {
			tokenId: row.id,
			role: row.role,
			projectId: row.project_id,
			name: row.name,
			client: row.client_name,
		},
	};
}

export function touchToken(env: Env, tokenId: string): Promise<unknown> {
	return env.DB.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE id = ?")
		.bind(nowIso(), tokenId)
		.run();
}

export interface IssuedToken {
	token: string;
	statement: D1PreparedStatement;
	expiresAt: string | null;
}

/** Create a token row (returned as a statement so callers can batch it) plus its plaintext. */
export async function issueToken(
	env: Env,
	opts: {
		kind: "api" | "access" | "refresh";
		role: Role;
		projectId: string | null;
		name: string;
		clientName: string | null;
		clientId: string | null;
		ttlSeconds: number | null;
	},
): Promise<IssuedToken> {
	const prefix = opts.kind === "refresh" ? "rally_rt" : "rally";
	const token = randomToken(prefix);
	const expiresAt = opts.ttlSeconds === null ? null : isoPlusSeconds(opts.ttlSeconds);
	const statement = env.DB.prepare(
		`INSERT INTO auth_tokens (id, kind, token_hash, role, project_id, name, client_name, client_id, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		newId("tok"),
		opts.kind,
		await sha256Hex(token),
		opts.role,
		opts.projectId,
		opts.name,
		opts.clientName,
		opts.clientId,
		expiresAt,
		nowIso(),
	);
	return { token, statement, expiresAt };
}

/** 401 response with the RFC 9728 pointer that OAuth-capable clients follow. */
export function unauthorized(origin: string, reason: "missing" | "invalid"): Response {
	const params = [
		`resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
		`scope="rally"`,
	];
	if (reason === "invalid") {
		params.unshift(
			`error="invalid_token"`,
			`error_description="The access token is invalid or expired"`,
		);
	}
	return new Response(
		JSON.stringify({
			error: reason === "missing" ? "unauthorized" : "invalid_token",
			message:
				reason === "missing"
					? "Send an Authorization: Bearer <token> header, or connect via OAuth."
					: "The bearer token is invalid, expired or revoked.",
		}),
		{
			status: 401,
			headers: {
				"content-type": "application/json",
				"www-authenticate": `Bearer ${params.join(", ")}`,
			},
		},
	);
}

import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { sha256Hex } from "../src/db";

export const OWNER_TOKEN = "rally-owner-token";

async function insertToken(
	token: string,
	role: "owner" | "agent",
	name: string,
	projectId: string | null,
) {
	await env.DB.prepare(
		"INSERT OR IGNORE INTO auth_tokens (id, kind, token_hash, role, project_id, name, client_name, created_at) VALUES (?, 'api', ?, ?, ?, ?, 'test client', ?)",
	)
		.bind(
			`tok_${name}_${projectId ?? "owner"}`,
			await sha256Hex(token),
			role,
			projectId,
			name,
			new Date().toISOString(),
		)
		.run();
}

export async function seedOwner(): Promise<void> {
	await insertToken(OWNER_TOKEN, "owner", "Linus", null);
}

export interface TestProject {
	slug: string;
	repo: string;
	agentA: string;
	agentB: string;
}

/** Create a project through the owner tools, plus two agent tokens bound to it. */
export async function createProject(
	slug: string,
	settings: Record<string, unknown> = {},
): Promise<TestProject> {
	await seedOwner();
	const repo = `acme/${slug}`;
	await callTool(
		"create_project",
		{ slug, name: `Project ${slug}`, repo, ...settings },
		OWNER_TOKEN,
	);
	const row = await env.DB.prepare("SELECT id FROM projects WHERE slug = ?")
		.bind(slug)
		.first<{ id: string }>();
	const projectId = (row as { id: string }).id;
	const agentA = `agent-a-${slug}`;
	const agentB = `agent-b-${slug}`;
	await insertToken(agentA, "agent", "agent-a", projectId);
	await insertToken(agentB, "agent", "agent-b", projectId);
	return { slug, repo, agentA, agentB };
}

let nextId = 1;

export async function rpc(
	method: string,
	params: unknown,
	token: string | null,
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": "2025-06-18",
	};
	if (token) headers.authorization = `Bearer ${token}`;
	return SELF.fetch("https://rally.test/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
}

export async function rpcResult<T = Record<string, unknown>>(
	method: string,
	params: unknown,
	token: string | null,
): Promise<T> {
	const res = await rpc(method, params, token);
	expect(res.status, await res.clone().text()).toBe(200);
	const body = (await parseRpcBody(res)) as { result?: T; error?: unknown };
	expect(body.error, JSON.stringify(body.error)).toBeUndefined();
	return body.result as T;
}

/** The server answers with JSON, but tolerate SSE framing in case the response mode changes. */
async function parseRpcBody(res: Response): Promise<unknown> {
	const text = await res.text();
	if (!(res.headers.get("content-type") ?? "").includes("text/event-stream"))
		return JSON.parse(text);
	const data = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	return JSON.parse(data[data.length - 1] ?? "null");
}

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}

/** Call a tool and return its structured result; fails the test if the tool reports an error. */
export async function callTool<T = any>(
	name: string,
	args: Record<string, unknown>,
	token: string,
): Promise<T> {
	const result = await rpcResult<ToolResult>("tools/call", { name, arguments: args }, token);
	expect(result.isError, result.content[0]?.text).toBeFalsy();
	return result.structuredContent as T;
}

/** Call a tool expecting an isError result; returns the error text. */
export async function callToolExpectingError(
	name: string,
	args: Record<string, unknown>,
	token: string,
): Promise<string> {
	const result = await rpcResult<ToolResult>("tools/call", { name, arguments: args }, token);
	expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
	return result.content[0]?.text ?? "";
}

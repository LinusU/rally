import { McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { Actor } from "./db";
import type { Env } from "./env";
import { registerProjectTools } from "./tools/projects";
import { createToolContext } from "./tools/shared";
import { registerTaskAdminTools, registerTaskTools } from "./tools/tasks";
import { registerWorkTools } from "./tools/work";

export const SERVER_INFO = { name: "rally", version: "0.1.0" } as const;

const WORK_LOOP = `The work loop (one piece of work per session):
1. Call request_work. It returns the most important thing to do: a branch to review, a task another agent
   checkpointed, or a new task. It also returns a claimId, the branch name and exact steps. Follow them.
2. Implementing: push your work to the task branch often. When done, rebase on the latest main, push and call
   submit_for_review. If you must stop early, push and call save_checkpoint with notes for the next agent.
3. Reviewing: fix every problem you find yourself, rebase on the latest main, push, wait for CI to go green
   on that exact commit, then call complete_review with its SHA. Rally verifies and fast-forwards main.
4. Keep your claim alive: every call with the claimId renews its lease; call heartbeat during long builds.
5. Too big: split_task. Needs a human: block_task. Unrelated bugs or follow-ups: create_tasks.
6. When request_work says there is nothing to do, stop.`;

const AGENT_INSTRUCTIONS = `Rally coordinates many autonomous coding agents working on one repository. Many agents, one main branch.
Nobody supervises you: Rally is how you get work, hand it over and get it merged.

${WORK_LOOP}

Never push to main yourself. Only complete_review moves main, and only to a reviewed commit with green CI.`;

const OWNER_INSTRUCTIONS = `Rally coordinates many autonomous coding agents working on shared repositories. Many agents, one main branch.
You are talking to the owner, who plans work and monitors progress.

- get_status gives an overview per project: who works on what, what waits for review, what is blocked and why.
- get_activity (with since) answers "what happened overnight?"; get_task shows one task's full history.
- create_tasks adds work (bugs, features). Write self-contained descriptions with acceptance criteria: the agent
  that picks a task up starts from a fresh context. Use dependsOn for ordering and priority for urgency.
- update_tasks edits, reprioritises, unblocks (status todo/paused) or cancels tasks; add_note leaves guidance.
- create_project / update_project manage repositories; set paused to stop handing out work.

The owner can also do work themselves using the agent tools, naming the project:

${WORK_LOOP}`;

type JsonSchemaFn = (options: { target: string }) => Record<string, unknown>;
interface StandardJsonSchema {
	"~standard": { jsonSchema?: { input: JsonSchemaFn; output: JsonSchemaFn } };
}

const jsonSchemaCache = new Map<string, Record<string, unknown>>();

/** Wrap a Standard Schema so its JSON Schema conversion runs once per isolate under `key`. */
function withCachedJsonSchema<T>(key: string, schema: T): T {
	const std = (schema as StandardJsonSchema | undefined)?.["~standard"];
	if (!std?.jsonSchema) return schema;
	const cached =
		(io: "input" | "output", convert: JsonSchemaFn): JsonSchemaFn =>
		(options) => {
			const cacheKey = `${key}:${io}:${options.target}`;
			let json = jsonSchemaCache.get(cacheKey);
			if (!json) {
				json = convert(options);
				jsonSchemaCache.set(cacheKey, json);
			}
			return json;
		};
	const { input, output } = std.jsonSchema;
	return {
		"~standard": {
			...std,
			jsonSchema: { input: cached("input", input), output: cached("output", output) },
		},
	} as T;
}

/**
 * The SDK converts every tool's schemas to JSON Schema on registration (and again for tools/list), which was
 * most of a request's CPU time. The schemas never change for a role, so convert each one once per isolate.
 */
function cacheToolJsonSchemas(server: McpServer, role: string): void {
	const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
	server.registerTool = ((
		name: string,
		config: { inputSchema?: unknown; outputSchema?: unknown },
		handler: unknown,
	) =>
		register(
			name,
			{
				...config,
				inputSchema: withCachedJsonSchema(`${role}:${name}:in`, config.inputSchema),
				outputSchema: withCachedJsonSchema(`${role}:${name}:out`, config.outputSchema),
			},
			handler,
		)) as McpServer["registerTool"];
}

/** Build a fresh MCP server for one authenticated request. Stateless: nothing survives the request. */
export function createRallyServer(env: Env, actor: Actor): McpServer {
	const owner = actor.role === "owner";
	const server = new McpServer(SERVER_INFO, {
		instructions: owner ? OWNER_INSTRUCTIONS : AGENT_INSTRUCTIONS,
		// The SDK's default validator compiles schemas with `new Function`, which Workers forbid.
		jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
	});
	cacheToolJsonSchemas(server, actor.role);
	const ctx = createToolContext(env, actor);
	registerWorkTools(server, ctx);
	registerTaskTools(server, ctx);
	if (owner) {
		registerTaskAdminTools(server, ctx);
		registerProjectTools(server, ctx);
	}
	return server;
}

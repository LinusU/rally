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

/** Build a fresh MCP server for one authenticated request. Stateless: nothing survives the request. */
export function createRallyServer(env: Env, actor: Actor): McpServer {
	const owner = actor.role === "owner";
	const server = new McpServer(SERVER_INFO, {
		instructions: owner ? OWNER_INSTRUCTIONS : AGENT_INSTRUCTIONS,
		// The SDK's default validator compiles schemas with `new Function`, which Workers forbid.
		jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
	});
	const ctx = createToolContext(env, actor);
	registerWorkTools(server, ctx);
	registerTaskTools(server, ctx);
	if (owner) {
		registerTaskAdminTools(server, ctx);
		registerProjectTools(server, ctx);
	}
	return server;
}

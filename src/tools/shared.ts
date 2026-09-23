import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Actor } from "../db";
import type { Env } from "../env";
import { GitHub, GitHubError } from "../github";

export interface ToolContext {
	db: D1Database;
	actor: Actor;
	env: Env;
	github: GitHub;
}

export function createToolContext(env: Env, actor: Actor): ToolContext {
	return { db: env.DB, actor, env, github: new GitHub(env.GITHUB_TOKEN) };
}

/** Thrown by tools for user-facing problems; becomes an isError result. */
export class ToolError extends Error {}

export function ok(data: Record<string, unknown>): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
		structuredContent: data,
	};
}

export function failure(message: string): CallToolResult {
	return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wrap a tool handler so ToolErrors (and GitHub failures) turn into isError results. */
export function handle<Args>(
	fn: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
	return async (args) => {
		try {
			return await fn(args);
		} catch (err) {
			if (err instanceof ToolError || err instanceof GitHubError) return failure(err.message);
			throw err;
		}
	};
}

export const taskStatusSchema = z.enum([
	"todo",
	"in_progress",
	"paused",
	"needs_review",
	"reviewing",
	"done",
	"blocked",
	"cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskIdSchema = z.number().int().positive().describe("Task id, e.g. 42 for #42");

export const projectArg = z
	.string()
	.optional()
	.describe(
		"Project slug. Agents may omit it (they are bound to one project); the owner may omit it when only one project exists.",
	);

export const shaSchema = z
	.string()
	.regex(/^[0-9a-f]{40}$/, "Use the full 40-character commit SHA")
	.describe("Full 40-character commit SHA");

/** A final integration task can wait for a whole milestone, so this is well above one batch of tasks. */
export const MAX_DEPENDENCIES = 200;

export const newTaskSchema = z.object({
	key: z
		.string()
		.min(1)
		.max(60)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Letters, digits, '.', '_' and '-' only")
		.optional()
		.describe(
			"Optional stable key, unique in the project (e.g. 'F00-A'). Other tasks can depend on it.",
		),
	title: z.string().min(1).max(200),
	description: z
		.string()
		.max(20_000)
		.default("")
		.describe(
			"Everything an agent needs: goal, context, acceptance criteria, relevant files/specs. Markdown.",
		),
	priority: z
		.number()
		.int()
		.min(-100)
		.max(100)
		.default(0)
		.describe("Higher runs first. Default 0."),
	dependsOn: z
		.array(z.union([taskIdSchema, z.string().min(1)]))
		.max(MAX_DEPENDENCIES)
		.default([])
		.describe(
			"Tasks that must be done (or cancelled) first: ids of existing tasks, or keys of existing tasks or of tasks in this same call.",
		),
	allowProtectedChanges: z
		.boolean()
		.default(false)
		.describe("Allow this task to change the project's protected paths."),
});
export type NewTask = z.infer<typeof newTaskSchema>;

// ---------- Output schemas (shapes of the structuredContent each tool returns) ----------
// Responses omit null fields, so anything nullable is optional here.

export const claimOutput = z.object({
	kind: z.enum(["implement", "review"]),
	by: z.string(),
	since: z.string(),
	leaseExpiresAt: z.string(),
});

export const taskSummaryOutput = z.object({
	id: z.number(),
	key: z.string().optional(),
	project: z.string(),
	title: z.string(),
	status: taskStatusSchema,
	priority: z.number(),
	ready: z
		.boolean()
		.optional()
		.describe("For todo/paused tasks: whether every dependency is done or cancelled"),
	dependsOn: z.array(z.number()),
	waitingOn: z.array(z.number()).optional().describe("Dependencies that are not finished yet"),
	branch: z.string().optional(),
	headSha: z.string().optional(),
	mergedSha: z.string().optional(),
	blockedReason: z.string().optional(),
	claim: claimOutput.optional(),
	claimCount: z.number(),
	createdBy: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	doneAt: z.string().optional(),
});

export const eventOutput = z.object({
	id: z.number(),
	at: z.string(),
	project: z.string(),
	taskId: z.number().optional(),
	actor: z.string(),
	role: z.string(),
	type: z.string(),
	summary: z.string(),
	details: z.unknown().optional(),
});

export const taskRefOutput = z.object({
	id: z.number(),
	key: z.string().optional(),
	title: z.string(),
	status: taskStatusSchema,
});

export const taskDetailOutput = taskSummaryOutput.extend({
	description: z.string(),
	allowProtectedChanges: z.boolean(),
	dependencies: z.array(taskRefOutput),
	dependents: z.array(taskRefOutput),
	history: z.array(eventOutput).describe("Recent events for this task, oldest first"),
});

export const projectOutput = z.object({
	slug: z.string(),
	name: z.string(),
	repo: z.string(),
	mainBranch: z.string(),
	branchPrefix: z.string(),
	instructions: z.string().optional(),
	requiredChecks: z.array(z.string()),
	protectedPaths: z.array(z.string()),
	leaseMinutes: z.number(),
	paused: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { eventStatement, newId, nowIso, setClause } from "../db";
import { type ProjectRow, resolveProject, toProject } from "../tasks";
import { handle, ok, projectOutput, type ToolContext, ToolError } from "./shared";

const repoSchema = z
	.string()
	.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/name")
	.describe("GitHub repository, owner/name");

const settings = {
	name: z.string().min(1).max(100),
	repo: repoSchema,
	mainBranch: z
		.string()
		.min(1)
		.max(100)
		.describe("The branch Rally fast-forwards (default 'main')"),
	branchPrefix: z.string().max(40).describe("Prefix for task branches (default 'rally/')"),
	instructions: z
		.string()
		.max(20_000)
		.describe(
			"Guidance handed to agents with every piece of work: docs to read first, checks to run before pushing, conventions",
		),
	requiredChecks: z
		.array(z.string().min(1))
		.max(30)
		.describe(
			"GitHub Actions workflow names / commit status contexts that must be reported and green before main moves. Empty: every reported workflow and status must be green, and at least one must exist.",
		),
	protectedPaths: z
		.array(z.string().min(1))
		.max(50)
		.describe(
			"Path prefixes agents may not change (e.g. '.github/', 'specs/'). A trailing '/' means a directory.",
		),
	leaseMinutes: z
		.number()
		.int()
		.min(5)
		.max(24 * 60)
		.describe("How long a claim lives without a call from its agent (default 60)"),
};

/** Owner-only: projects. */
export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"list_projects",
		{
			title: "List projects",
			description: "All projects with their settings.",
			inputSchema: z.object({}),
			outputSchema: z.object({ projects: z.array(projectOutput) }),
			annotations: { readOnlyHint: true },
		},
		handle(async () => {
			const { results } = await ctx.db
				.prepare("SELECT * FROM projects ORDER BY created_at, slug")
				.all<ProjectRow>();
			return ok({ projects: results.map(toProject) });
		}),
	);

	server.registerTool(
		"create_project",
		{
			title: "Create project",
			description:
				"Register a GitHub repository for agents to work on. Rally's GitHub token must be able to push to it, and its CI must run on pushes to task branches.",
			inputSchema: z.object({
				slug: z
					.string()
					.regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Lowercase letters, digits and '-'")
					.describe("Short id used in tool calls, e.g. 'crimson-skies'"),
				name: settings.name,
				repo: settings.repo,
				mainBranch: settings.mainBranch.default("main"),
				branchPrefix: settings.branchPrefix.default("rally/"),
				instructions: settings.instructions.optional(),
				requiredChecks: settings.requiredChecks.default([]),
				protectedPaths: settings.protectedPaths.default([]),
				leaseMinutes: settings.leaseMinutes.default(60),
			}),
			outputSchema: z.object({ project: projectOutput }),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const exists = await ctx.db
				.prepare("SELECT 1 FROM projects WHERE slug = ?")
				.bind(args.slug)
				.first();
			if (exists) throw new ToolError(`A project with slug '${args.slug}' already exists.`);
			const id = newId("prj");
			const ts = nowIso();
			await ctx.db.batch([
				ctx.db
					.prepare(
						`INSERT INTO projects (id, slug, name, repo, main_branch, branch_prefix, instructions, required_checks, protected_paths, lease_minutes, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						id,
						args.slug,
						args.name,
						args.repo,
						args.mainBranch,
						args.branchPrefix,
						args.instructions ?? null,
						JSON.stringify(args.requiredChecks),
						JSON.stringify(args.protectedPaths),
						args.leaseMinutes,
						ts,
						ts,
					),
				eventStatement(ctx.db, ctx.actor, {
					projectId: id,
					type: "project.created",
					summary: `${ctx.actor.name} created project ${args.slug} (${args.repo})`,
				}),
			]);
			const row = await ctx.db
				.prepare("SELECT * FROM projects WHERE id = ?")
				.bind(id)
				.first<ProjectRow>();
			return ok({ project: toProject(row as ProjectRow) });
		}),
	);

	server.registerTool(
		"update_project",
		{
			title: "Update project",
			description:
				"Change a project's settings. Set `paused` to stop handing out new work (agents finish what they hold); unpause to resume.",
			inputSchema: z.object({
				project: z.string().describe("Project slug"),
				name: settings.name.optional(),
				repo: settings.repo.optional(),
				mainBranch: settings.mainBranch.optional(),
				branchPrefix: settings.branchPrefix.optional(),
				instructions: settings.instructions.nullable().optional(),
				requiredChecks: settings.requiredChecks.optional(),
				protectedPaths: settings.protectedPaths.optional(),
				leaseMinutes: settings.leaseMinutes.optional(),
				paused: z.boolean().optional(),
			}),
			outputSchema: z.object({ project: projectOutput }),
			annotations: { destructiveHint: false, idempotentHint: true },
		},
		handle(async (args) => {
			const project = await resolveProject(ctx, args.project);
			const { sql, values } = setClause({
				name: args.name,
				repo: args.repo,
				main_branch: args.mainBranch,
				branch_prefix: args.branchPrefix,
				instructions: args.instructions,
				required_checks: args.requiredChecks && JSON.stringify(args.requiredChecks),
				protected_paths: args.protectedPaths && JSON.stringify(args.protectedPaths),
				lease_minutes: args.leaseMinutes,
				paused: args.paused === undefined ? undefined : args.paused ? 1 : 0,
			});
			if (!sql) throw new ToolError("Nothing to change.");
			const changed = Object.keys(args).filter((k) => k !== "project");
			await ctx.db.batch([
				ctx.db
					.prepare(`UPDATE projects SET ${sql}, updated_at = ? WHERE id = ?`)
					.bind(...values, nowIso(), project.id),
				eventStatement(ctx.db, ctx.actor, {
					projectId: project.id,
					type:
						args.paused === true
							? "project.paused"
							: args.paused === false
								? "project.resumed"
								: "project.updated",
					summary: `${ctx.actor.name} updated project ${project.slug}: ${changed.join(", ")}`,
					details: args,
				}),
			]);
			const row = await ctx.db
				.prepare("SELECT * FROM projects WHERE id = ?")
				.bind(project.id)
				.first<ProjectRow>();
			return ok({ project: toProject(row as ProjectRow) });
		}),
	);
}

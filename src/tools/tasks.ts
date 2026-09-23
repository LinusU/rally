import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { eventStatement, nowIso, placeholders, setClause } from "../db";
import {
	createTasks,
	DEPS_SATISFIED,
	expireStaleClaims,
	loadTask,
	queryEvents,
	resolveProject,
	TASK_SELECT,
	type TaskRow,
	taskDetail,
	toTaskSummary,
	visibleProjects,
	wouldCycle,
} from "../tasks";
import {
	eventOutput,
	handle,
	MAX_DEPENDENCIES,
	newTaskSchema,
	ok,
	projectArg,
	type ToolContext,
	ToolError,
	taskDetailOutput,
	taskIdSchema,
	taskStatusSchema,
	taskSummaryOutput,
} from "./shared";

/** Tools for everyone: reading the queue, planning new tasks and leaving notes. */
export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"get_status",
		{
			title: "Get status",
			description:
				"Overview of each project: task counts per status, who is working on what right now, what is blocked and why, what is up next and what was merged recently. " +
				"Start here to see how things are going.",
			inputSchema: z.object({
				project: projectArg.describe("Project slug; omit to see every project you have access to"),
			}),
			outputSchema: z.object({
				now: z.string(),
				projects: z.array(
					z.object({
						project: z.string(),
						name: z.string(),
						repo: z.string(),
						paused: z.boolean(),
						counts: z.record(z.string(), z.number()),
						readyCount: z
							.number()
							.describe("todo/paused tasks whose dependencies are all finished"),
						active: z.array(taskSummaryOutput).describe("Tasks currently claimed by an agent"),
						awaitingReview: z.array(taskSummaryOutput),
						blocked: z.array(taskSummaryOutput),
						upNext: z.array(taskSummaryOutput),
						recentlyDone: z.array(taskSummaryOutput),
					}),
				),
			}),
			annotations: { readOnlyHint: true },
		},
		handle(async (args) => {
			const projects = await visibleProjects(ctx, args.project);
			await expireStaleClaims(ctx.db);
			const out = await Promise.all(
				projects.map(async (p) => {
					const q = (where: string, order: string, limit: number) =>
						ctx.db
							.prepare(
								`${TASK_SELECT} WHERE t.project_id = ? AND ${where} ORDER BY ${order} LIMIT ${limit}`,
							)
							.bind(p.id)
							.all<TaskRow>()
							.then((r) => r.results.map(toTaskSummary));
					const [counts, ready, active, awaitingReview, blocked, upNext, recentlyDone] =
						await Promise.all([
							ctx.db
								.prepare(
									"SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status",
								)
								.bind(p.id)
								.all<{ status: string; n: number }>(),
							ctx.db
								.prepare(
									`SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND t.status IN ('todo', 'paused') AND ${DEPS_SATISFIED}`,
								)
								.bind(p.id)
								.first<{ n: number }>(),
							q("t.claim_id IS NOT NULL", "t.claimed_at", 50),
							q("t.status = 'needs_review'", "t.updated_at", 20),
							q("t.status = 'blocked'", "t.updated_at DESC", 20),
							q(
								`t.status IN ('todo', 'paused') AND ${DEPS_SATISFIED}`,
								"CASE t.status WHEN 'paused' THEN 0 ELSE 1 END, t.priority DESC, t.updated_at, t.id",
								5,
							),
							q("t.status = 'done'", "t.done_at DESC", 5),
						]);
					return {
						project: p.slug,
						name: p.name,
						repo: p.repo,
						paused: p.paused === 1,
						counts: Object.fromEntries(counts.results.map((c) => [c.status, c.n])),
						readyCount: ready?.n ?? 0,
						active,
						awaitingReview,
						blocked,
						upNext,
						recentlyDone,
					};
				}),
			);
			return ok({ now: nowIso(), projects: out });
		}),
	);

	server.registerTool(
		"list_tasks",
		{
			title: "List tasks",
			description:
				"List tasks in a project, highest priority first. By default finished (done/cancelled) tasks are left out; pass `status` to choose.",
			inputSchema: z.object({
				project: projectArg,
				status: z
					.array(taskStatusSchema)
					.min(1)
					.optional()
					.describe("Only these statuses (default: everything except done and cancelled)"),
				search: z
					.string()
					.max(100)
					.optional()
					.describe("Case-insensitive match on key, title or description"),
				limit: z.number().int().min(1).max(200).default(50),
				offset: z.number().int().min(0).default(0),
			}),
			outputSchema: z.object({
				project: z.string(),
				total: z.number(),
				tasks: z.array(taskSummaryOutput),
			}),
			annotations: { readOnlyHint: true },
		},
		handle(async (args) => {
			const project = await resolveProject(ctx, args.project);
			await expireStaleClaims(ctx.db, project.id);
			const where = ["t.project_id = ?"];
			const values: unknown[] = [project.id];
			if (args.status) {
				where.push(`t.status IN (${placeholders(args.status.length)})`);
				values.push(...args.status);
			} else {
				where.push("t.status NOT IN ('done', 'cancelled')");
			}
			if (args.search) {
				where.push("(t.key LIKE ? OR t.title LIKE ? OR t.description LIKE ?)");
				const like = `%${args.search.replace(/[%_]/g, "")}%`;
				values.push(like, like, like);
			}
			const sql = where.join(" AND ");
			const [total, rows] = await Promise.all([
				ctx.db
					.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${sql}`)
					.bind(...values)
					.first<{ n: number }>(),
				ctx.db
					.prepare(`${TASK_SELECT} WHERE ${sql} ORDER BY t.priority DESC, t.id LIMIT ? OFFSET ?`)
					.bind(...values, args.limit, args.offset)
					.all<TaskRow>(),
			]);
			return ok({
				project: project.slug,
				total: total?.n ?? 0,
				tasks: rows.results.map(toTaskSummary),
			});
		}),
	);

	server.registerTool(
		"get_task",
		{
			title: "Get task",
			description:
				"Everything about one task: description, dependencies, dependents, branch, current claim and its history (checkpoints, reviews, notes).",
			inputSchema: z.object({ taskId: taskIdSchema }),
			outputSchema: z.object({ task: taskDetailOutput }),
			annotations: { readOnlyHint: true },
		},
		handle(async (args) => {
			const task = await loadTask(ctx, args.taskId);
			await expireStaleClaims(ctx.db, task.project_id);
			return ok({ task: await taskDetail(ctx, await loadTask(ctx, args.taskId)) });
		}),
	);

	server.registerTool(
		"get_activity",
		{
			title: "Get activity",
			description:
				"The activity log, newest first: tasks created, started, checkpointed, submitted, reviewed, merged, blocked, expired leases and notes. " +
				"Use `since` to answer 'what happened overnight?'.",
			inputSchema: z.object({
				project: projectArg.describe("Project slug; omit for every project you have access to"),
				since: z
					.string()
					.datetime({ offset: true })
					.optional()
					.describe("Only events at or after this ISO 8601 time"),
				taskId: taskIdSchema.optional(),
				limit: z.number().int().min(1).max(500).default(100),
			}),
			outputSchema: z.object({ events: z.array(eventOutput), truncated: z.boolean() }),
			annotations: { readOnlyHint: true },
		},
		handle(async (args) => {
			const projects = await visibleProjects(ctx, args.project);
			if (projects.length === 0) return ok({ events: [], truncated: false });
			const where = [`e.project_id IN (${placeholders(projects.length)})`];
			const values: unknown[] = projects.map((p) => p.id);
			if (args.since) {
				where.push("e.created_at >= ?");
				values.push(new Date(args.since).toISOString());
			}
			if (args.taskId !== undefined) {
				where.push("e.task_id = ?");
				values.push(args.taskId);
			}
			const events = await queryEvents(ctx, where.join(" AND "), values, args.limit + 1);
			return ok({ events: events.slice(0, args.limit), truncated: events.length > args.limit });
		}),
	);

	server.registerTool(
		"create_tasks",
		{
			title: "Create tasks",
			description:
				"Add tasks to a project's queue in one atomic call. Give each task a self-contained description with acceptance criteria: the agent that picks it up starts with a fresh context. " +
				"Tasks can depend on existing tasks (by id or key) or on each other within the call (by key). Agents use this for follow-up work and bugs they discover.",
			inputSchema: z.object({ project: projectArg, tasks: z.array(newTaskSchema).min(1).max(50) }),
			outputSchema: z.object({ created: z.array(taskSummaryOutput) }),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const project = await resolveProject(ctx, args.project);
			const ids = await createTasks(ctx, project, args.tasks);
			const { results } = await ctx.db
				.prepare(`${TASK_SELECT} WHERE t.id BETWEEN ? AND ? AND t.project_id = ? ORDER BY t.id`)
				.bind(ids[0], ids[ids.length - 1], project.id)
				.all<TaskRow>();
			return ok({ created: results.map(toTaskSummary) });
		}),
	);

	server.registerTool(
		"add_note",
		{
			title: "Add note",
			description:
				"Attach a note to a task: guidance for whoever works on it next, a finding, a correction. Notes show up in the task history that agents receive with their work.",
			inputSchema: z.object({ taskId: taskIdSchema, text: z.string().min(1).max(20_000) }),
			outputSchema: z.object({ taskId: z.number(), event: eventOutput }),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const task = await loadTask(ctx, args.taskId);
			const firstLine = args.text.trim().split("\n")[0]?.slice(0, 200) ?? "";
			await eventStatement(ctx.db, ctx.actor, {
				projectId: task.project_id,
				taskId: task.id,
				type: "task.note",
				summary: `${ctx.actor.name} on #${task.id}: ${firstLine}`,
				details: { text: args.text },
			}).run();
			const [event] = await queryEvents(ctx, "e.task_id = ?", [task.id], 1);
			return ok({ taskId: task.id, event });
		}),
	);
}

const settableStatus = z.enum(["todo", "paused", "needs_review", "blocked", "cancelled"]);

/** Owner-only: change existing tasks. */
export function registerTaskAdminTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"update_tasks",
		{
			title: "Update tasks",
			description:
				"Change existing tasks atomically: edit title/description/priority, replace dependencies, or set the status to unblock (todo/paused), re-queue for review, block or cancel. " +
				"Changing the status of a claimed task ends that claim; the agent is told to stop on its next call. Done tasks cannot change status (create a new task instead).",
			inputSchema: z.object({
				updates: z
					.array(
						z.object({
							taskId: taskIdSchema,
							title: z.string().min(1).max(200).optional(),
							description: z.string().max(20_000).optional(),
							priority: z.number().int().min(-100).max(100).optional(),
							dependsOn: z
								.array(z.union([taskIdSchema, z.string().min(1)]))
								.max(MAX_DEPENDENCIES)
								.optional()
								.describe("Replaces all dependencies: task ids or keys in the same project"),
							status: settableStatus.optional(),
							blockedReason: z
								.string()
								.max(20_000)
								.optional()
								.describe("Why, when setting status 'blocked'"),
							allowProtectedChanges: z.boolean().optional(),
						}),
					)
					.min(1)
					.max(50),
			}),
			outputSchema: z.object({ updated: z.array(taskSummaryOutput) }),
			annotations: { destructiveHint: false, idempotentHint: true },
		},
		handle(async (args) => {
			const ids = [...new Set(args.updates.map((u) => u.taskId))];
			if (ids.length !== args.updates.length)
				throw new ToolError("Each task may appear only once per call.");
			const tasks = new Map<number, TaskRow>();
			for (const id of ids) tasks.set(id, await loadTask(ctx, id));

			const ts = nowIso();
			const statements: D1PreparedStatement[] = [];
			for (const u of args.updates) {
				const task = tasks.get(u.taskId) as TaskRow;
				const changes: string[] = [];
				const fields: Record<string, unknown> = {
					title: u.title,
					description: u.description,
					priority: u.priority,
					allow_protected_changes:
						u.allowProtectedChanges === undefined ? undefined : u.allowProtectedChanges ? 1 : 0,
				};
				for (const [k, v] of Object.entries(fields)) if (v !== undefined) changes.push(k);

				if (u.status !== undefined && u.status !== task.status) {
					if (task.status === "done")
						throw new ToolError(
							`#${task.id} is done (merged); its status cannot change. Create a new task instead.`,
						);
					if (u.status === "needs_review" && !task.branch)
						throw new ToolError(`#${task.id} has no branch to review.`);
					fields.status = u.status;
					fields.claim_id = null;
					fields.lease_expires_at = null;
					fields.expired_claim_id = null;
					if (u.status === "blocked")
						fields.blocked_reason = u.blockedReason ?? `Blocked by ${ctx.actor.name}`;
					changes.push(
						`status ${task.status} -> ${u.status}${task.claim_id ? ` (ended ${task.claimed_by}'s claim)` : ""}`,
					);
				} else if (u.blockedReason !== undefined && task.status === "blocked") {
					fields.blocked_reason = u.blockedReason;
					changes.push("blocked reason");
				}

				if (u.dependsOn !== undefined) {
					const depIds: number[] = [];
					for (const ref of u.dependsOn) {
						const row = await ctx.db
							.prepare(
								typeof ref === "number"
									? "SELECT id FROM tasks WHERE id = ? AND project_id = ?"
									: "SELECT id FROM tasks WHERE key = ? AND project_id = ?",
							)
							.bind(ref, task.project_id)
							.first<{ id: number }>();
						if (!row)
							throw new ToolError(
								`Unknown dependency ${typeof ref === "number" ? `#${ref}` : `'${ref}'`} for #${task.id}. Nothing was changed.`,
							);
						if (await wouldCycle(ctx.db, task.id, row.id)) {
							throw new ToolError(
								`#${task.id} cannot depend on #${row.id}: that would create a dependency cycle. Nothing was changed.`,
							);
						}
						depIds.push(row.id);
					}
					statements.push(ctx.db.prepare("DELETE FROM task_deps WHERE task_id = ?").bind(task.id));
					for (const dep of new Set(depIds)) {
						statements.push(
							ctx.db
								.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)")
								.bind(task.id, dep),
						);
					}
					changes.push(`dependencies -> [${[...new Set(depIds)].map((d) => `#${d}`).join(", ")}]`);
				}
				if (changes.length === 0) continue;

				const { sql, values } = setClause(fields);
				if (sql)
					statements.push(
						ctx.db
							.prepare(`UPDATE tasks SET ${sql}, updated_at = ? WHERE id = ?`)
							.bind(...values, ts, task.id),
					);
				else
					statements.push(
						ctx.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(ts, task.id),
					);
				statements.push(
					eventStatement(ctx.db, ctx.actor, {
						projectId: task.project_id,
						taskId: task.id,
						type: "task.updated",
						summary: `${ctx.actor.name} updated #${task.id}: ${changes.join(", ")}`,
						details: u,
					}),
				);
			}
			if (statements.length > 0) await ctx.db.batch(statements);
			const updated = await Promise.all(ids.map((id) => loadTask(ctx, id)));
			return ok({ updated: updated.map(toTaskSummary) });
		}),
	);
}

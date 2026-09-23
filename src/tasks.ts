/** Task and project domain helpers shared by the MCP tools. */
import { type Actor, compact, eventStatement, nowIso, parseJsonArray, placeholders } from "./db";
import type { NewTask, TaskStatus, ToolContext } from "./tools/shared";
import { ToolError } from "./tools/shared";

// ---------- Projects ----------

export interface ProjectRow {
	id: string;
	slug: string;
	name: string;
	repo: string;
	main_branch: string;
	branch_prefix: string;
	instructions: string | null;
	required_checks: string;
	protected_paths: string;
	lease_minutes: number;
	paused: number;
	created_at: string;
	updated_at: string;
}

export function toProject(row: ProjectRow) {
	return compact({
		slug: row.slug,
		name: row.name,
		repo: row.repo,
		mainBranch: row.main_branch,
		branchPrefix: row.branch_prefix,
		instructions: row.instructions,
		requiredChecks: parseJsonArray<string>(row.required_checks),
		protectedPaths: parseJsonArray<string>(row.protected_paths),
		leaseMinutes: row.lease_minutes,
		paused: row.paused === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

export async function projectById(ctx: ToolContext, id: string): Promise<ProjectRow> {
	const row = await ctx.db
		.prepare("SELECT * FROM projects WHERE id = ?")
		.bind(id)
		.first<ProjectRow>();
	if (!row) throw new ToolError(`Project ${id} no longer exists.`);
	return row;
}

/**
 * The project a call is about. Agents are bound to one project; the owner names one by slug,
 * or may leave it out while only a single project exists.
 */
export async function resolveProject(
	ctx: ToolContext,
	slug: string | undefined,
): Promise<ProjectRow> {
	if (ctx.actor.projectId) {
		const own = await projectById(ctx, ctx.actor.projectId);
		if (slug !== undefined && slug !== own.slug) {
			throw new ToolError(`This agent token only has access to project '${own.slug}'.`);
		}
		return own;
	}
	if (slug !== undefined) {
		const row = await ctx.db
			.prepare("SELECT * FROM projects WHERE slug = ?")
			.bind(slug)
			.first<ProjectRow>();
		if (!row) throw new ToolError(`Unknown project '${slug}'. Use list_projects to see them.`);
		return row;
	}
	const { results } = await ctx.db.prepare("SELECT * FROM projects LIMIT 2").all<ProjectRow>();
	if (results.length === 1 && results[0]) return results[0];
	if (results.length === 0)
		throw new ToolError("No projects exist yet. Create one with create_project.");
	throw new ToolError("Several projects exist; pass `project` (see list_projects).");
}

/** Projects visible to the caller: all of them for the owner, the bound one for an agent. */
export async function visibleProjects(
	ctx: ToolContext,
	slug: string | undefined,
): Promise<ProjectRow[]> {
	if (slug !== undefined || ctx.actor.projectId) return [await resolveProject(ctx, slug)];
	const { results } = await ctx.db
		.prepare("SELECT * FROM projects ORDER BY created_at, slug")
		.all<ProjectRow>();
	return results;
}

// ---------- Tasks ----------

export interface TaskRow {
	id: number;
	project_id: string;
	project_slug: string;
	key: string | null;
	title: string;
	description: string;
	priority: number;
	status: TaskStatus;
	allow_protected_changes: number;
	branch: string | null;
	head_sha: string | null;
	merged_sha: string | null;
	blocked_reason: string | null;
	claim_id: string | null;
	claim_kind: "implement" | "review" | null;
	claimed_by: string | null;
	claimed_at: string | null;
	lease_expires_at: string | null;
	expired_claim_id: string | null;
	claim_count: number;
	created_by: string;
	created_at: string;
	updated_at: string;
	done_at: string | null;
	deps_json: string;
	open_deps_json: string;
}

/** Statuses that satisfy a dependency. Cancelling a task means "no longer needed". */
export const FINISHED = "('done', 'cancelled')";

export const TASK_SELECT = `SELECT t.*, p.slug AS project_slug,
	(SELECT json_group_array(d.depends_on) FROM task_deps d WHERE d.task_id = t.id) AS deps_json,
	(SELECT json_group_array(d.depends_on) FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on
	  WHERE d.task_id = t.id AND dt.status NOT IN ${FINISHED}) AS open_deps_json
	FROM tasks t JOIN projects p ON p.id = t.project_id`;

/** SQL condition: every dependency of `t` is finished. */
export const DEPS_SATISFIED = `NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on
	WHERE d.task_id = t.id AND dt.status NOT IN ${FINISHED})`;

export function toTaskSummary(row: TaskRow) {
	const dependsOn = parseJsonArray<number>(row.deps_json).sort((a, b) => a - b);
	const waitingOn = parseJsonArray<number>(row.open_deps_json).sort((a, b) => a - b);
	const queued = row.status === "todo" || row.status === "paused";
	return compact({
		id: row.id,
		key: row.key,
		project: row.project_slug,
		title: row.title,
		status: row.status,
		priority: row.priority,
		ready: queued ? waitingOn.length === 0 : null,
		dependsOn,
		waitingOn: waitingOn.length > 0 ? waitingOn : null,
		branch: row.branch,
		headSha: row.head_sha,
		mergedSha: row.merged_sha,
		blockedReason: row.status === "blocked" ? row.blocked_reason : null,
		claim:
			row.claim_id && row.claim_kind && row.claimed_by && row.claimed_at && row.lease_expires_at
				? {
						kind: row.claim_kind,
						by: row.claimed_by,
						since: row.claimed_at,
						leaseExpiresAt: row.lease_expires_at,
					}
				: null,
		claimCount: row.claim_count,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		doneAt: row.done_at,
	});
}

/** Load a task the caller may see, or throw. */
export async function loadTask(ctx: ToolContext, id: number): Promise<TaskRow> {
	const row = await ctx.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).bind(id).first<TaskRow>();
	if (!row || (ctx.actor.projectId && row.project_id !== ctx.actor.projectId)) {
		throw new ToolError(`Unknown task #${id}.`);
	}
	return row;
}

interface EventRow {
	id: number;
	project_slug: string;
	task_id: number | null;
	created_at: string;
	actor: string;
	role: string;
	type: string;
	summary: string;
	details: string | null;
}

export const EVENT_SELECT = `SELECT e.*, p.slug AS project_slug FROM events e JOIN projects p ON p.id = e.project_id`;

export function toEvent(row: EventRow) {
	let details: unknown = null;
	if (row.details) {
		try {
			details = JSON.parse(row.details);
		} catch {
			details = row.details;
		}
	}
	return compact({
		id: row.id,
		at: row.created_at,
		project: row.project_slug,
		taskId: row.task_id,
		actor: row.actor,
		role: row.role,
		type: row.type,
		summary: row.summary,
		details,
	});
}

export async function taskEvents(ctx: ToolContext, taskId: number, limit = 30) {
	const { results } = await ctx.db
		.prepare(`${EVENT_SELECT} WHERE e.task_id = ? ORDER BY e.id DESC LIMIT ?`)
		.bind(taskId, limit)
		.all<EventRow>();
	return results.reverse().map(toEvent);
}

export async function queryEvents(
	ctx: ToolContext,
	where: string,
	values: unknown[],
	limit: number,
) {
	const { results } = await ctx.db
		.prepare(`${EVENT_SELECT} WHERE ${where} ORDER BY e.id DESC LIMIT ?`)
		.bind(...values, limit)
		.all<EventRow>();
	return results.map(toEvent);
}

export async function taskDetail(ctx: ToolContext, row: TaskRow) {
	const ref = `SELECT t.id, t.key, t.title, t.status FROM tasks t`;
	type RefRow = { id: number; key: string | null; title: string; status: TaskStatus };
	const [deps, dependents, history] = await Promise.all([
		ctx.db
			.prepare(`${ref} JOIN task_deps d ON d.depends_on = t.id WHERE d.task_id = ? ORDER BY t.id`)
			.bind(row.id)
			.all<RefRow>(),
		ctx.db
			.prepare(`${ref} JOIN task_deps d ON d.task_id = t.id WHERE d.depends_on = ? ORDER BY t.id`)
			.bind(row.id)
			.all<RefRow>(),
		taskEvents(ctx, row.id),
	]);
	return {
		...toTaskSummary(row),
		description: row.description,
		allowProtectedChanges: row.allow_protected_changes === 1,
		dependencies: deps.results.map((r) => compact(r)),
		dependents: dependents.results.map((r) => compact(r)),
		history,
	};
}

/** Who Rally itself acts as when it changes state on its own (lease expiry). */
const SYSTEM = { name: "rally", role: "system" as Actor["role"] };

/**
 * Release claims whose lease lapsed: implementation goes back to `paused` (resumable), review back
 * to `needs_review`. The agent that held the lease can still pick the task back up with its old
 * claim id as long as nobody else has claimed it in the meantime.
 */
export async function expireStaleClaims(db: D1Database, projectId?: string): Promise<void> {
	const now = nowIso();
	const { results } = await db
		.prepare(
			`SELECT id, project_id, claim_id, claim_kind, claimed_by FROM tasks
			 WHERE claim_id IS NOT NULL AND lease_expires_at < ? ${projectId ? "AND project_id = ?" : ""}
			 LIMIT 50`,
		)
		.bind(...(projectId ? [now, projectId] : [now]))
		.all<{
			id: number;
			project_id: string;
			claim_id: string;
			claim_kind: string;
			claimed_by: string;
		}>();
	if (results.length === 0) return;
	const statements = results.flatMap((t) => [
		db
			.prepare(
				`UPDATE tasks SET status = CASE status WHEN 'reviewing' THEN 'needs_review' ELSE 'paused' END,
				   expired_claim_id = claim_id, claim_id = NULL, lease_expires_at = NULL, updated_at = ?
				 WHERE id = ? AND claim_id = ?`,
			)
			.bind(now, t.id, t.claim_id),
		eventStatement(
			db,
			SYSTEM,
			{
				projectId: t.project_id,
				taskId: t.id,
				type: "claim.expired",
				summary: `${t.claimed_by}'s ${t.claim_kind} lease on #${t.id} expired; the task is back in the queue`,
			},
			true,
		),
	]);
	await db.batch(statements);
}

export function slugify(text: string, max = 40): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.slice(0, max).replace(/-+$/, "");
}

export function branchFor(project: ProjectRow, task: Pick<TaskRow, "id" | "title">): string {
	const slug = slugify(task.title);
	return `${project.branch_prefix}${task.id}${slug ? `-${slug}` : ""}`;
}

/** D1 allows at most 100 bound parameters per query; leave room for the others. */
function chunks<T>(items: T[], size = 90): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Create tasks atomically. Dependencies may name existing tasks (id or key) or keys of tasks in the
 * same call. With `dependent`, that existing task is made to depend on every new task (splitting).
 */
export async function createTasks(
	ctx: ToolContext,
	project: ProjectRow,
	inputs: NewTask[],
	opts: { dependent?: number; extraStatements?: D1PreparedStatement[] } = {},
): Promise<number[]> {
	const batchKeys = new Map<string, number>();
	inputs.forEach((t, i) => {
		if (!t.key) return;
		if (batchKeys.has(t.key)) throw new ToolError(`Key '${t.key}' is used twice in this call.`);
		batchKeys.set(t.key, i);
	});

	// Resolve references to existing tasks.
	const refIds = new Set<number>();
	const refKeys = new Set<string>([...batchKeys.keys()]);
	for (const t of inputs) {
		for (const d of t.dependsOn) {
			if (typeof d === "number") refIds.add(d);
			else if (!batchKeys.has(d)) refKeys.add(d);
		}
	}
	const existingByKey = new Map<string, number>();
	for (const keys of chunks([...refKeys])) {
		const { results } = await ctx.db
			.prepare(
				`SELECT id, key FROM tasks WHERE project_id = ? AND key IN (${placeholders(keys.length)})`,
			)
			.bind(project.id, ...keys)
			.all<{ id: number; key: string }>();
		for (const r of results) existingByKey.set(r.key, r.id);
	}
	const taken = [...batchKeys.keys()].filter((k) => existingByKey.has(k));
	if (taken.length > 0) {
		throw new ToolError(
			`Key(s) already used in this project: ${taken.join(", ")}. Nothing was created.`,
		);
	}
	if (refIds.size > 0) {
		const ids = [...refIds];
		const found = new Set<number>();
		for (const chunk of chunks(ids)) {
			const { results } = await ctx.db
				.prepare(
					`SELECT id FROM tasks WHERE project_id = ? AND id IN (${placeholders(chunk.length)})`,
				)
				.bind(project.id, ...chunk)
				.all<{ id: number }>();
			for (const r of results) found.add(r.id);
		}
		const missing = ids.filter((id) => !found.has(id));
		if (missing.length > 0) {
			throw new ToolError(
				`Unknown dependency task id(s): ${missing.map((id) => `#${id}`).join(", ")}. Nothing was created.`,
			);
		}
	}
	for (const t of inputs) {
		for (const d of t.dependsOn) {
			if (typeof d === "string" && !batchKeys.has(d) && !existingByKey.has(d)) {
				throw new ToolError(`Unknown dependency key '${d}'. Nothing was created.`);
			}
		}
	}

	// Edges between new tasks can form a cycle; edges to existing tasks cannot.
	const state = new Map<number, "visiting" | "done">();
	const visit = (i: number, path: string[]): void => {
		if (state.get(i) === "done") return;
		const task = inputs[i] as NewTask;
		const label = task.key ?? task.title;
		if (state.get(i) === "visiting") {
			throw new ToolError(
				`Dependency cycle: ${[...path, label].join(" -> ")}. Nothing was created.`,
			);
		}
		state.set(i, "visiting");
		for (const d of task.dependsOn) {
			const j = typeof d === "string" ? batchKeys.get(d) : undefined;
			if (j !== undefined) visit(j, [...path, label]);
		}
		state.set(i, "done");
	};
	inputs.forEach((_, i) => {
		visit(i, []);
	});

	// Ids are allocated up front so dependencies between new tasks can be written in the same batch.
	for (let attempt = 0; ; attempt++) {
		const max = await ctx.db
			.prepare("SELECT COALESCE(MAX(id), 0) AS max FROM tasks")
			.first<{ max: number }>();
		const firstId = (max?.max ?? 0) + 1;
		const ids = inputs.map((_, i) => firstId + i);
		const ts = nowIso();
		// Every task row goes in before any dependency row: D1 checks foreign keys per statement.
		const tasks: D1PreparedStatement[] = [];
		const links: D1PreparedStatement[] = [];
		inputs.forEach((t, i) => {
			const id = ids[i] as number;
			tasks.push(
				ctx.db
					.prepare(
						`INSERT INTO tasks (id, project_id, key, title, description, priority, status, allow_protected_changes, created_by, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
					)
					.bind(
						id,
						project.id,
						t.key ?? null,
						t.title,
						t.description,
						t.priority,
						t.allowProtectedChanges ? 1 : 0,
						ctx.actor.name,
						ts,
						ts,
					),
			);
			const depIds = new Set(
				t.dependsOn.map((d) =>
					typeof d === "number"
						? d
						: batchKeys.has(d)
							? (ids[batchKeys.get(d) as number] as number)
							: (existingByKey.get(d) as number),
				),
			);
			for (const dep of depIds) {
				links.push(
					ctx.db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)").bind(id, dep),
				);
			}
			links.push(
				eventStatement(ctx.db, ctx.actor, {
					projectId: project.id,
					taskId: id,
					type: "task.created",
					summary: `Created #${id} ${t.title}`,
					details: compact({
						key: t.key,
						priority: t.priority,
						dependsOn: depIds.size > 0 ? [...depIds] : null,
					}),
				}),
			);
			if (opts.dependent !== undefined) {
				links.push(
					ctx.db
						.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)")
						.bind(opts.dependent, id),
				);
			}
		});
		try {
			await ctx.db.batch([...tasks, ...links, ...(opts.extraStatements ?? [])]);
			return ids;
		} catch (err) {
			// Someone else created tasks between reading MAX(id) and writing; try again with fresh ids.
			if (attempt < 3 && String(err).includes("UNIQUE constraint failed: tasks.id")) continue;
			throw err;
		}
	}
}

/** Would making `taskId` depend on `dependsOn` create a cycle? True if `dependsOn` already (transitively) depends on `taskId`. */
export async function wouldCycle(
	db: D1Database,
	taskId: number,
	dependsOn: number,
): Promise<boolean> {
	if (taskId === dependsOn) return true;
	const row = await db
		.prepare(
			`WITH RECURSIVE up(id) AS (
			   SELECT ? UNION SELECT d.depends_on FROM task_deps d JOIN up ON d.task_id = up.id
			 ) SELECT 1 AS hit FROM up WHERE id = ? LIMIT 1`,
		)
		.bind(dependsOn, taskId)
		.first<{ hit: number }>();
	return !!row;
}

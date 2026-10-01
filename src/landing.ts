/**
 * The landing queue. In a project with `landing_mode = 'queue'`, complete_review approves a
 * reviewed, CI-green commit instead of insisting that it fast-forwards the current main. Rally then
 * lands approved commits one at a time, oldest approval first:
 *
 * 1. If the approved commit already fast-forwards main, it only needs CI (it has it) and the ref update.
 * 2. Otherwise Rally dispatches the project's lander workflow (`repository_dispatch`, event
 *    `rally-land`). The lander rebases the approved commit onto main, checks that the change is still
 *    exactly the approved one (`git patch-id`), force-pushes it to the task branch, starts CI on it
 *    and reports through the commit status `rally/land` on the approved commit.
 * 3. Rally waits for CI on the rebased commit and fast-forwards main to it.
 *
 * Only one task per project is ever landing (a unique index enforces it) and only Rally moves main,
 * so nothing races. A landing that cannot succeed as approved (rebase conflict, a different change,
 * red CI, the branch moved) goes back to review; one that merely stalled is retried.
 */
import { eventStatement, nowIso, parseJsonArray } from "./db";
import { type CommitStatus, type GitHub, GitHubError } from "./github";
import { branchFor, type ProjectRow, SYSTEM, TASK_SELECT, type TaskRow } from "./tasks";

export const LAND_EVENT = "rally-land";
export const LAND_CONTEXT = "rally/land";
export const MAX_LANDING_ATTEMPTS = 3;
/** How long the lander may take to report, and a whole attempt (including CI) may take. */
const LANDER_TIMEOUT_MS = 20 * 60_000;
const ATTEMPT_TIMEOUT_MS = 90 * 60_000;

/** True when protected paths are touched without permission. */
export function touchesProtected(files: string[], project: ProjectRow, task: TaskRow): string[] {
	if (task.allow_protected_changes === 1) return [];
	const prefixes = parseJsonArray<string>(project.protected_paths);
	return files.filter((path) =>
		prefixes.some((p) =>
			p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(`${p}/`),
		),
	);
}

/** Tasks approved or landing in a project, as the queue an approval joins. */
export async function landingQueueLength(db: D1Database, projectId: string): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('approved', 'landing')",
		)
		.bind(projectId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * Move the project's landing queue along as far as it goes right now. Safe to call often and from
 * several places at once (the cron, complete_review, request_work): every transition is conditional.
 */
export async function advanceLanding(
	db: D1Database,
	github: GitHub,
	project: ProjectRow,
): Promise<void> {
	try {
		// A landing that ends lets the next one start in the same call; the bound keeps the call short.
		for (let i = 0; i < 4; i++) {
			const landing = await db
				.prepare(`${TASK_SELECT} WHERE t.project_id = ? AND t.status = 'landing'`)
				.bind(project.id)
				.first<TaskRow>();
			if (landing) {
				if (!(await stepLanding(db, github, project, landing))) return;
				continue;
			}
			const next = await db
				.prepare(
					`${TASK_SELECT} WHERE t.project_id = ? AND t.status = 'approved' ORDER BY t.approved_at, t.id LIMIT 1`,
				)
				.bind(project.id)
				.first<TaskRow>();
			if (!next) return;
			await startLanding(db, github, project, next);
		}
	} catch (err) {
		// GitHub hiccups must not break the caller (an agent's request_work, the cron); try again later.
		if (err instanceof GitHubError) {
			console.warn(`landing queue of ${project.slug}: ${err.message}`);
			return;
		}
		throw err;
	}
}

/** Advance every project that has something approved or landing (the cron). */
export async function advanceAllLanding(db: D1Database, github: GitHub): Promise<void> {
	const { results } = await db
		.prepare(
			"SELECT * FROM projects p WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.status IN ('approved', 'landing'))",
		)
		.all<ProjectRow>();
	for (const project of results) await advanceLanding(db, github, project);
}

async function startLanding(
	db: D1Database,
	github: GitHub,
	project: ProjectRow,
	task: TaskRow,
): Promise<void> {
	const ts = nowIso();
	const attempt = task.landing_attempts + 1;
	try {
		const [update] = await db.batch([
			db
				.prepare(
					`UPDATE tasks SET status = 'landing', landing_started_at = ?, landing_sha = NULL, landing_attempts = ?, updated_at = ?
					 WHERE id = ? AND status = 'approved'`,
				)
				.bind(ts, attempt, ts, task.id),
			eventStatement(
				db,
				SYSTEM,
				{
					projectId: project.id,
					taskId: task.id,
					type: "landing.started",
					summary: `Rally started landing #${task.id} ${task.title} (attempt ${attempt} of ${MAX_LANDING_ATTEMPTS})`,
					details: { approvedSha: task.approved_sha, attempt },
				},
				true,
			),
		]);
		if (update?.meta.changes !== 1) return;
	} catch (err) {
		// Another caller started a landing for this project first (tasks_one_landing_idx).
		if (String(err).includes("UNIQUE constraint failed")) return;
		throw err;
	}

	const approved = task.approved_sha as string;
	const cmp = await github.compare(project.repo, project.main_branch, approved);
	if (cmp.status === "identical" || cmp.status === "behind") {
		await finishLanding(db, github, project, task, approved);
		return;
	}
	if (cmp.status === "ahead") {
		// Nothing to rebase: CI already passed on the approved commit, so only the ref update is left.
		await db
			.prepare(
				"UPDATE tasks SET landing_sha = ?, updated_at = ? WHERE id = ? AND status = 'landing'",
			)
			.bind(approved, nowIso(), task.id)
			.run();
		return;
	}
	const branch = task.branch ?? branchFor(project, task);
	try {
		await github.dispatch(project.repo, LAND_EVENT, {
			task: task.id,
			branch,
			approvedSha: approved,
			mainBranch: project.main_branch,
		});
	} catch (err) {
		if (!(err instanceof GitHubError)) throw err;
		// The attempt times out and is retried; the event tells the owner why nothing happens.
		await eventStatement(db, SYSTEM, {
			projectId: project.id,
			taskId: task.id,
			type: "landing.error",
			summary: `Rally could not start the lander for #${task.id}: ${err.message}`,
		}).run();
	}
}

/** One look at the landing in progress. Returns true when it ended (landed, retried or failed). */
async function stepLanding(
	db: D1Database,
	github: GitHub,
	project: ProjectRow,
	task: TaskRow,
): Promise<boolean> {
	const started = Date.parse(task.landing_started_at ?? "") || 0;
	const elapsed = Date.now() - started;
	const branch = task.branch ?? branchFor(project, task);

	let rebased = task.landing_sha;
	if (!rebased) {
		const report = await github.commitStatus(
			project.repo,
			task.approved_sha as string,
			LAND_CONTEXT,
		);
		// A report from an earlier attempt says nothing about this one. (The lander only reports after
		// it was dispatched, which is after the attempt started, so no clock slack is needed.)
		const fresh = report && Date.parse(report.updatedAt) > started ? report : null;
		if (fresh?.state === "failure" || fresh?.state === "error") {
			await failLanding(db, project, task, `the lander reported: ${fresh.description}`, fresh);
			return true;
		}
		if (fresh?.state !== "success") {
			if (elapsed > LANDER_TIMEOUT_MS) {
				await retryLanding(db, project, task, "the lander did not report back in time");
				return true;
			}
			return false;
		}
		const head = await github.branchHead(project.repo, branch);
		if (!head || head === task.approved_sha) return false; // The push has not shown up yet.
		const [update] = await db.batch([
			db
				.prepare(
					"UPDATE tasks SET landing_sha = ?, updated_at = ? WHERE id = ? AND status = 'landing' AND landing_sha IS NULL",
				)
				.bind(head, nowIso(), task.id),
			eventStatement(
				db,
				SYSTEM,
				{
					projectId: project.id,
					taskId: task.id,
					type: "landing.rebased",
					summary: `The lander rebased #${task.id} onto ${project.main_branch} as ${head.slice(0, 10)}; waiting for CI`,
					details: { rebasedSha: head, report: fresh.description },
				},
				true,
			),
		]);
		if (update?.meta.changes !== 1) return false;
		rebased = head;
	}

	const head = await github.branchHead(project.repo, branch);
	if (head !== rebased) {
		await failLanding(
			db,
			project,
			task,
			`${branch} changed during the landing (it is at ${head ?? "nothing"}, not ${rebased})`,
		);
		return true;
	}
	const cmp = await github.compare(project.repo, project.main_branch, rebased);
	if (cmp.status === "identical" || cmp.status === "behind") {
		await finishLanding(db, github, project, task, rebased);
		return true;
	}
	if (cmp.status === "diverged") {
		await retryLanding(db, project, task, `${project.main_branch} moved during the landing`);
		return true;
	}
	const touched = touchesProtected(cmp.files, project, task);
	if (touched.length > 0) {
		await failLanding(
			db,
			project,
			task,
			`the rebased branch changes protected paths (${touched.join(", ")})`,
		);
		return true;
	}
	const ci = await github.ci(
		project.repo,
		rebased,
		parseJsonArray<string>(project.required_checks),
	);
	if (ci.state === "failure") {
		const failed = ci.checks
			.filter((c) => c.state === "failure")
			.map((c) => `${c.name} (${c.detail})`);
		await failLanding(
			db,
			project,
			task,
			`CI failed on the rebased commit ${rebased.slice(0, 10)}: ${failed.join(", ")}`,
		);
		return true;
	}
	if (ci.state !== "success") {
		if (elapsed > ATTEMPT_TIMEOUT_MS) {
			await retryLanding(db, project, task, "CI on the rebased commit did not finish in time");
			return true;
		}
		return false;
	}
	if (!(await github.fastForward(project.repo, project.main_branch, rebased))) {
		await retryLanding(db, project, task, `${project.main_branch} moved during the landing`);
		return true;
	}
	await finishLanding(db, github, project, task, rebased);
	return true;
}

async function finishLanding(
	db: D1Database,
	github: GitHub,
	project: ProjectRow,
	task: TaskRow,
	sha: string,
): Promise<void> {
	const ts = nowIso();
	const branch = task.branch ?? branchFor(project, task);
	const [update] = await db.batch([
		db
			.prepare(
				`UPDATE tasks SET status = 'done', head_sha = ?, merged_sha = ?, done_at = ?, landing_started_at = NULL, updated_at = ?
				 WHERE id = ? AND status = 'landing'`,
			)
			.bind(sha, sha, ts, ts, task.id),
		eventStatement(
			db,
			SYSTEM,
			{
				projectId: project.id,
				taskId: task.id,
				type: "task.merged",
				summary: `Rally landed #${task.id} ${task.title} (approved by ${task.approved_by ?? "a reviewer"}); ${project.main_branch} is now at ${sha.slice(0, 10)}`,
				details: {
					commitSha: sha,
					approvedSha: task.approved_sha,
					approvedBy: task.approved_by,
					branch,
				},
			},
			true,
		),
	]);
	if (update?.meta.changes === 1) await github.deleteBranch(project.repo, branch);
}

/** A stalled attempt: try again (it keeps its place at the front), or give up after the last one. */
async function retryLanding(
	db: D1Database,
	project: ProjectRow,
	task: TaskRow,
	reason: string,
): Promise<void> {
	if (task.landing_attempts >= MAX_LANDING_ATTEMPTS) {
		await failLanding(
			db,
			project,
			task,
			`${reason}, and that was the last of ${MAX_LANDING_ATTEMPTS} attempts`,
		);
		return;
	}
	await db.batch([
		db
			.prepare(
				`UPDATE tasks SET status = 'approved', landing_started_at = NULL, landing_sha = NULL, updated_at = ?
				 WHERE id = ? AND status = 'landing'`,
			)
			.bind(nowIso(), task.id),
		eventStatement(
			db,
			SYSTEM,
			{
				projectId: project.id,
				taskId: task.id,
				type: "landing.retry",
				summary: `Rally will retry landing #${task.id}: ${reason}`,
				details: { reason, attempt: task.landing_attempts },
			},
			true,
		),
	]);
}

/** The approved change cannot land as it is: back to review, with the reason in the history. */
async function failLanding(
	db: D1Database,
	project: ProjectRow,
	task: TaskRow,
	reason: string,
	report?: CommitStatus,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`UPDATE tasks SET status = 'needs_review', approved_sha = NULL, landing_started_at = NULL, landing_sha = NULL,
				   landing_attempts = 0, updated_at = ?
				 WHERE id = ? AND status = 'landing'`,
			)
			.bind(nowIso(), task.id),
		eventStatement(
			db,
			SYSTEM,
			{
				projectId: project.id,
				taskId: task.id,
				type: "landing.failed",
				summary: `Rally could not land #${task.id}: ${reason}. It is back in review: rebase it onto ${project.main_branch}, fix what is needed, push, wait for CI and call complete_review again.`,
				details: {
					reason,
					approvedSha: task.approved_sha,
					rebasedSha: task.landing_sha,
					report: report?.targetUrl ?? undefined,
				},
			},
			true,
		),
	]);
}

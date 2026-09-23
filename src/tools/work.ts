import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compact, eventStatement, isoPlusSeconds, newId, nowIso, parseJsonArray } from "../db";
import {
	branchFor,
	createTasks,
	DEPS_SATISFIED,
	expireStaleClaims,
	loadTask,
	type ProjectRow,
	projectById,
	resolveProject,
	TASK_SELECT,
	type TaskRow,
	taskDetail,
	toTaskSummary,
} from "../tasks";
import {
	handle,
	newTaskSchema,
	ok,
	projectArg,
	shaSchema,
	type ToolContext,
	ToolError,
	taskDetailOutput,
	taskSummaryOutput,
} from "./shared";

const claimIdSchema = z.string().min(1).describe("The claimId that request_work returned");

type WorkType = "implement" | "resume" | "review";

function leaseEnd(project: ProjectRow): string {
	return isoPlusSeconds(project.lease_minutes * 60);
}

function isProtected(path: string, prefixes: string[]): boolean {
	return prefixes.some((p) =>
		p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(`${p}/`),
	);
}

/** Step-by-step instructions for one piece of work. The agent needs nothing else to do it right. */
function workSteps(type: WorkType, project: ProjectRow, task: TaskRow, branch: string): string {
	const main = project.main_branch;
	const heartbeatEvery = Math.max(1, Math.floor(project.lease_minutes / 3));
	const protectedPaths = parseJsonArray<string>(project.protected_paths);
	const lines: string[] = [];
	const add = (s: string) => lines.push(`${lines.length + 1}. ${s}`);

	if (type === "review") {
		add(
			`\`git fetch origin && git checkout -B ${branch} origin/${branch}\`. Inspect the work with \`git diff origin/${main}...HEAD\`.`,
		);
		add(
			"Review it critically against the task description and acceptance criteria below, the project instructions and the repository's own agent docs (AGENTS.md, CLAUDE.md, ...). Look for bugs, missing tests, missed requirements and shortcuts such as weakened tests or checks.",
		);
		add(
			"Fix every problem you find yourself and commit the fixes. Do not hand the task back for small things.",
		);
		add(
			`Rebase onto the latest main: \`git fetch origin && git rebase origin/${main}\`, resolve conflicts, run the project's checks locally, then \`git push --force-with-lease origin ${branch}\`.`,
		);
		add(
			`Wait until GitHub CI has finished and is green for exactly the pushed commit (\`git rev-parse HEAD\`), e.g. with \`gh run list --commit <sha>\` and \`gh run watch <run-id> --exit-status\`. If CI fails, fix, push and wait again.`,
		);
		add(
			`Call complete_review with that commit SHA. Rally re-checks the branch head and CI, then fast-forwards ${main} to it. If ${main} moved in the meantime, Rally refuses: rebase again and repeat from step 4.`,
		);
		add(
			"If you have to stop before finishing, push what you have and call save_checkpoint with precise notes; the task stays in review for the next agent. If the task cannot be finished without a human, call block_task.",
		);
	} else {
		if (type === "resume") {
			add(
				`Continue the earlier work: \`git fetch origin && git checkout -B ${branch} origin/${branch}\` (if that branch is missing on origin, start from \`origin/${main}\` instead). Read the checkpoint notes in the task history first.`,
			);
		} else {
			add(`\`git fetch origin && git checkout -B ${branch} origin/${main}\`.`);
		}
		add(
			"Do the task as described below. Follow the project instructions and the repository's own agent docs (AGENTS.md, CLAUDE.md, ...). Keep the change focused on this task.",
		);
		add(
			`Commit in small steps and push often: \`git push -u origin ${branch}\`. Pushed work survives if you are interrupted.`,
		);
		add(
			`When the task is complete and the project's checks pass locally: \`git fetch origin && git rebase origin/${main}\`, \`git push --force-with-lease origin ${branch}\`, then call submit_for_review with the pushed commit SHA and a short summary. Another agent will review it and merge it.`,
		);
		add(
			"If you have to stop before the task is complete, push what you have and call save_checkpoint with notes precise enough for another agent to continue: what is done, what is left, what you learned.",
		);
		add(
			"If the task is too big for one session, call split_task with smaller subtasks. If it cannot be done without a human decision or missing information, call block_task with the reason. If you discover unrelated bugs or follow-up work, record them with create_tasks instead of fixing them here.",
		);
	}
	add(
		`Your claim is a lease of ${project.lease_minutes} minutes, renewed by every call you make with the claimId. Call heartbeat at least every ${heartbeatEvery} minutes (e.g. while builds or CI run). If the lease runs out, the task goes back to the queue and your claimId only works again if nobody else took it.`,
	);
	if (protectedPaths.length > 0 && task.allow_protected_changes !== 1) {
		add(
			`Do not change these protected paths: ${protectedPaths.join(", ")}. Rally will refuse to merge a branch that touches them. If the task truly requires it, call block_task and explain why.`,
		);
	}
	add("Never push to main yourself and never force-push any branch other than this task's branch.");
	return lines.join("\n");
}

/**
 * Resolve a claim for a claim-bound call and renew its lease. A lapsed claim is re-adopted if the
 * task is still unclaimed, so a slow agent does not lose its work to a timeout nobody acted on.
 */
async function useClaim(
	ctx: ToolContext,
	claimId: string,
): Promise<{ task: TaskRow; project: ProjectRow }> {
	let task = await ctx.db
		.prepare(`${TASK_SELECT} WHERE t.claim_id = ?`)
		.bind(claimId)
		.first<TaskRow>();
	if (!task) {
		const lapsed = await ctx.db
			.prepare(`${TASK_SELECT} WHERE t.expired_claim_id = ? AND t.claim_id IS NULL`)
			.bind(claimId)
			.first<TaskRow>();
		if (
			lapsed &&
			(lapsed.status === "paused" || lapsed.status === "needs_review") &&
			canSee(ctx, lapsed)
		) {
			const project = await projectById(ctx, lapsed.project_id);
			const status = lapsed.status === "paused" ? "in_progress" : "reviewing";
			const [update] = await ctx.db.batch([
				ctx.db
					.prepare(
						`UPDATE tasks SET status = ?, claim_id = ?, lease_expires_at = ?, expired_claim_id = NULL, updated_at = ?
						 WHERE id = ? AND claim_id IS NULL AND expired_claim_id = ? AND status = ?`,
					)
					.bind(status, claimId, leaseEnd(project), nowIso(), lapsed.id, claimId, lapsed.status),
				eventStatement(
					ctx.db,
					ctx.actor,
					{
						projectId: lapsed.project_id,
						taskId: lapsed.id,
						type: "claim.resumed",
						summary: `${lapsed.claimed_by} picked #${lapsed.id} back up after its lease had expired`,
						actorName: lapsed.claimed_by ?? ctx.actor.name,
					},
					true,
				),
			]);
			if (update?.meta.changes === 1) {
				task = await ctx.db
					.prepare(`${TASK_SELECT} WHERE t.claim_id = ?`)
					.bind(claimId)
					.first<TaskRow>();
			}
		}
	}
	if (!task || !canSee(ctx, task)) {
		throw new ToolError(
			`Claim ${claimId} is no longer valid: its lease expired and another agent took the task, or the owner changed the task. Stop working on it (do not push to its branch again) and call request_work for new work.`,
		);
	}
	const project = await projectById(ctx, task.project_id);
	const lease = leaseEnd(project);
	await ctx.db
		.prepare("UPDATE tasks SET lease_expires_at = ? WHERE claim_id = ?")
		.bind(lease, claimId)
		.run();
	task.lease_expires_at = lease;
	return { task, project };
}

function canSee(ctx: ToolContext, task: TaskRow): boolean {
	return !ctx.actor.projectId || ctx.actor.projectId === task.project_id;
}

/** Release the claim with a status change. Fails if the claim was lost in the meantime. */
async function releaseClaim(
	ctx: ToolContext,
	claimId: string,
	fields: Record<string, unknown>,
	event: {
		projectId: string;
		taskId: number;
		type: string;
		summary: string;
		details?: unknown;
		actorName: string;
	},
	extra: D1PreparedStatement[] = [],
): Promise<void> {
	const cols = Object.keys(fields);
	const [update] = await ctx.db.batch([
		ctx.db
			.prepare(
				`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, claim_id = NULL, lease_expires_at = NULL, updated_at = ?
				 WHERE claim_id = ?`,
			)
			.bind(...Object.values(fields), nowIso(), claimId),
		eventStatement(ctx.db, ctx.actor, event, true),
		...extra,
	]);
	if (update?.meta.changes !== 1) {
		throw new ToolError(
			`Claim ${claimId} was released while this call ran. Call request_work for new work.`,
		);
	}
}

function firstLine(text: string, max = 200): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

async function requireBranchHead(
	ctx: ToolContext,
	project: ProjectRow,
	branch: string,
	sha: string,
): Promise<void> {
	const head = await ctx.github.branchHead(project.repo, branch);
	if (!head)
		throw new ToolError(
			`Branch ${branch} does not exist on GitHub (${project.repo}). Push it first: \`git push -u origin ${branch}\`.`,
		);
	if (head !== sha) {
		throw new ToolError(
			`Branch ${branch} is at ${head} on GitHub, not ${sha}. Push your latest commit (or pass the SHA that is actually on GitHub) and call again.`,
		);
	}
}

export function registerWorkTools(server: McpServer, ctx: ToolContext): void {
	server.registerTool(
		"request_work",
		{
			title: "Request work",
			description:
				"Claim the next piece of work in a project. Priority: (1) branches waiting for review, (2) tasks another agent started and checkpointed, (3) the highest-priority task whose dependencies are done. " +
				"Returns the task, the branch to use, a claimId for all follow-up calls and step-by-step instructions. Returns type 'none' when there is nothing to do right now.",
			inputSchema: z.object({
				project: projectArg,
				agentName: z
					.string()
					.max(60)
					.optional()
					.describe(
						"Optional label for this agent session, shown in the activity log (e.g. 'mini-2')",
					),
			}),
			outputSchema: z.object({
				type: z.enum(["implement", "resume", "review", "none"]),
				claimId: z.string().optional(),
				leaseExpiresAt: z.string().optional(),
				project: z.object({
					slug: z.string(),
					repo: z.string(),
					mainBranch: z.string(),
					instructions: z.string().optional(),
				}),
				branch: z.string().optional(),
				steps: z.string().optional().describe("Exactly how to do this piece of work"),
				task: taskDetailOutput.optional(),
				reason: z.string().optional().describe("Why there is no work (type 'none')"),
			}),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const project = await resolveProject(ctx, args.project);
			await expireStaleClaims(ctx.db, project.id);
			const projectInfo = compact({
				slug: project.slug,
				repo: project.repo,
				mainBranch: project.main_branch,
				instructions: project.instructions,
			});
			if (project.paused) {
				return ok({
					type: "none",
					project: projectInfo,
					reason: "The owner has paused this project. Stop and try again later.",
				});
			}

			const { results: candidates } = await ctx.db
				.prepare(
					`${TASK_SELECT} WHERE t.project_id = ? AND t.claim_id IS NULL
					   AND (t.status = 'needs_review' OR (t.status IN ('paused', 'todo') AND ${DEPS_SATISFIED}))
					 ORDER BY CASE t.status WHEN 'needs_review' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
					   t.priority DESC, t.updated_at, t.id
					 LIMIT 10`,
				)
				.bind(project.id)
				.all<TaskRow>();

			const by = args.agentName ? `${ctx.actor.name}/${args.agentName}` : ctx.actor.name;
			for (const candidate of candidates) {
				const review = candidate.status === "needs_review";
				const type: WorkType = review
					? "review"
					: candidate.status === "paused" || candidate.head_sha
						? "resume"
						: "implement";
				const claimId = newId("clm", 16);
				const branch = candidate.branch ?? branchFor(project, candidate);
				const ts = nowIso();
				const [update] = await ctx.db.batch([
					ctx.db
						.prepare(
							`UPDATE tasks SET status = ?, claim_id = ?, claim_kind = ?, claimed_by = ?, claimed_at = ?, lease_expires_at = ?,
							   expired_claim_id = NULL, claim_count = claim_count + 1, branch = ?, updated_at = ?
							 WHERE id = ? AND status = ? AND claim_id IS NULL`,
						)
						.bind(
							review ? "reviewing" : "in_progress",
							claimId,
							review ? "review" : "implement",
							by,
							ts,
							leaseEnd(project),
							branch,
							ts,
							candidate.id,
							candidate.status,
						),
					eventStatement(
						ctx.db,
						ctx.actor,
						{
							projectId: project.id,
							taskId: candidate.id,
							type: review ? "review.started" : type === "resume" ? "task.resumed" : "task.started",
							summary: `${by} ${review ? "started reviewing" : type === "resume" ? "resumed" : "started"} #${candidate.id} ${candidate.title}`,
							actorName: by,
						},
						true,
					),
				]);
				if (update?.meta.changes !== 1) continue; // Another agent got there first.

				const task = await loadTask(ctx, candidate.id);
				return ok({
					type,
					claimId,
					leaseExpiresAt: task.lease_expires_at,
					project: projectInfo,
					branch,
					steps: workSteps(type, project, task, branch),
					task: await taskDetail(ctx, task),
				});
			}

			const { results: counts } = await ctx.db
				.prepare(
					`SELECT t.status, COUNT(*) AS n, SUM(CASE WHEN ${DEPS_SATISFIED} THEN 0 ELSE 1 END) AS waiting
					 FROM tasks t WHERE t.project_id = ? GROUP BY t.status`,
				)
				.bind(project.id)
				.all<{ status: string; n: number; waiting: number }>();
			const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
			const waiting = counts
				.filter((c) => c.status === "todo" || c.status === "paused")
				.reduce((sum, c) => sum + c.waiting, 0);
			const parts = [
				`${n("in_progress")} in progress`,
				`${n("reviewing")} being reviewed`,
				`${waiting} waiting on dependencies`,
				`${n("blocked")} blocked`,
				`${n("done")} done`,
			];
			return ok({
				type: "none",
				project: projectInfo,
				reason: `Nothing to pick up right now (${parts.join(", ")}). Stop here; try again later.`,
			});
		}),
	);

	server.registerTool(
		"heartbeat",
		{
			title: "Heartbeat",
			description:
				"Renew the lease on your claim while you keep working (every call with a claimId renews it too). Optionally log a short progress note.",
			inputSchema: z.object({
				claimId: claimIdSchema,
				note: z
					.string()
					.max(2000)
					.optional()
					.describe("Optional progress note for the activity log"),
			}),
			outputSchema: z.object({ taskId: z.number(), leaseExpiresAt: z.string() }),
			annotations: { destructiveHint: false, idempotentHint: true },
		},
		handle(async (args) => {
			const { task } = await useClaim(ctx, args.claimId);
			if (args.note) {
				await eventStatement(ctx.db, ctx.actor, {
					projectId: task.project_id,
					taskId: task.id,
					type: "task.progress",
					summary: `${task.claimed_by} on #${task.id}: ${firstLine(args.note)}`,
					details: { note: args.note },
					actorName: task.claimed_by ?? ctx.actor.name,
				}).run();
			}
			return ok({ taskId: task.id, leaseExpiresAt: task.lease_expires_at as string });
		}),
	);

	server.registerTool(
		"save_checkpoint",
		{
			title: "Save checkpoint",
			description:
				"Stop working on a claimed task that is not finished, after pushing your work to the task branch. The task goes back to the queue: an implementation " +
				"as a paused task that the next agent resumes, a review back to 'needs review'. Write notes a fresh agent can continue from.",
			inputSchema: z.object({
				claimId: claimIdSchema,
				notes: z
					.string()
					.min(1)
					.max(20_000)
					.describe(
						"What is done, what is left, what you tried and learned, anything the next agent must know",
					),
				commitSha: shaSchema
					.optional()
					.describe("The commit you pushed to the task branch, if any"),
			}),
			outputSchema: z.object({ task: taskSummaryOutput }),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const { task, project } = await useClaim(ctx, args.claimId);
			const branch = task.branch ?? branchFor(project, task);
			if (args.commitSha) await requireBranchHead(ctx, project, branch, args.commitSha);
			const review = task.claim_kind === "review";
			await releaseClaim(
				ctx,
				args.claimId,
				{ status: review ? "needs_review" : "paused", head_sha: args.commitSha ?? task.head_sha },
				{
					projectId: project.id,
					taskId: task.id,
					type: review ? "review.checkpoint" : "task.checkpoint",
					summary: `${task.claimed_by} checkpointed ${review ? "the review of " : ""}#${task.id}: ${firstLine(args.notes)}`,
					details: compact({ notes: args.notes, commitSha: args.commitSha }),
					actorName: task.claimed_by ?? ctx.actor.name,
				},
			);
			return ok({ task: toTaskSummary(await loadTask(ctx, task.id)) });
		}),
	);

	server.registerTool(
		"submit_for_review",
		{
			title: "Submit for review",
			description:
				"Hand a finished implementation over for review. Push the task branch first (rebased on the latest main); Rally checks that the branch on GitHub is at exactly commitSha.",
			inputSchema: z.object({
				claimId: claimIdSchema,
				commitSha: shaSchema.describe("The pushed head of the task branch (`git rev-parse HEAD`)"),
				summary: z
					.string()
					.min(1)
					.max(20_000)
					.describe("What you changed, how you verified it, anything a reviewer should look at"),
			}),
			outputSchema: z.object({ task: taskSummaryOutput }),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const { task, project } = await useClaim(ctx, args.claimId);
			if (task.claim_kind !== "implement") {
				throw new ToolError(
					"This is a review claim. Finish it with complete_review (or save_checkpoint / block_task).",
				);
			}
			const branch = task.branch ?? branchFor(project, task);
			await requireBranchHead(ctx, project, branch, args.commitSha);
			const cmp = await ctx.github.compare(project.repo, project.main_branch, args.commitSha);
			if (cmp.aheadBy === 0) {
				throw new ToolError(
					`Branch ${branch} has no commits that are not already on ${project.main_branch}. Commit and push your work first.`,
				);
			}
			await releaseClaim(
				ctx,
				args.claimId,
				{ status: "needs_review", head_sha: args.commitSha },
				{
					projectId: project.id,
					taskId: task.id,
					type: "task.submitted",
					summary: `${task.claimed_by} submitted #${task.id} for review: ${firstLine(args.summary)}`,
					details: { summary: args.summary, commitSha: args.commitSha, branch },
					actorName: task.claimed_by ?? ctx.actor.name,
				},
			);
			return ok({ task: toTaskSummary(await loadTask(ctx, task.id)) });
		}),
	);

	server.registerTool(
		"complete_review",
		{
			title: "Complete review",
			description:
				"Approve the reviewed branch at exactly commitSha and merge it. Rally verifies that the task branch on GitHub is at that commit, that it is rebased on the latest main " +
				"(a fast-forward), that it leaves protected paths alone and that CI on that commit is green. Then it fast-forwards main to the commit and marks the task done. " +
				"If any check fails nothing is merged and the error says what to do.",
			inputSchema: z.object({
				claimId: claimIdSchema,
				commitSha: shaSchema.describe("The reviewed, rebased and pushed head of the task branch"),
				notes: z
					.string()
					.max(20_000)
					.optional()
					.describe("What you checked and fixed during the review"),
			}),
			outputSchema: z.object({ merged: z.boolean(), mainSha: z.string(), task: taskSummaryOutput }),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const { task, project } = await useClaim(ctx, args.claimId);
			if (task.claim_kind !== "review") {
				throw new ToolError(
					"This is an implementation claim. Hand it over with submit_for_review; another agent reviews and merges it.",
				);
			}
			const branch = task.branch ?? branchFor(project, task);
			const main = project.main_branch;
			await requireBranchHead(ctx, project, branch, args.commitSha);

			const cmp = await ctx.github.compare(project.repo, main, args.commitSha);
			// "identical"/"behind": main already contains the commit, e.g. a retry after main was moved but before Rally recorded it.
			const alreadyMerged = cmp.status === "identical" || cmp.status === "behind";
			if (cmp.status === "diverged") {
				throw new ToolError(
					`Not merged: ${branch} is not based on the latest ${main} (${main} is at ${cmp.baseSha}, ${cmp.behindBy} commit(s) the branch lacks). ` +
						`Run \`git fetch origin && git rebase origin/${main}\`, push with --force-with-lease, wait for CI to pass on the new head and call complete_review again with the new SHA.`,
				);
			}
			if (!alreadyMerged) {
				const protectedPaths = parseJsonArray<string>(project.protected_paths);
				if (task.allow_protected_changes !== 1 && protectedPaths.length > 0) {
					const touched = cmp.files.filter((f) => isProtected(f, protectedPaths));
					if (touched.length > 0) {
						throw new ToolError(
							`Not merged: the branch changes protected paths (${touched.join(", ")}). Only the owner may change these. Revert those changes, or call block_task if the task cannot be done without them.`,
						);
					}
				}
				const ci = await ctx.github.ci(
					project.repo,
					args.commitSha,
					parseJsonArray<string>(project.required_checks),
				);
				if (ci.state === "failure") {
					const failed = ci.checks
						.filter((c) => c.state === "failure")
						.map((c) => `${c.name} (${c.detail})`);
					throw new ToolError(
						`Not merged: CI failed on ${args.commitSha}: ${failed.join(", ")}. Fix the problems, push, wait for CI to pass and call complete_review again with the new SHA.`,
					);
				}
				if (ci.state === "none") {
					throw new ToolError(
						`Not merged: GitHub has no CI results for ${args.commitSha} yet. If CI was just triggered, wait a minute and call complete_review again. If it never starts, check that the workflow runs on pushes to ${branch}.`,
					);
				}
				if (ci.state === "pending") {
					const pending = ci.checks.filter((c) => c.state === "pending").map((c) => c.name);
					const missing =
						ci.missingRequired.length > 0
							? ` Required checks not reported yet: ${ci.missingRequired.join(", ")}.`
							: "";
					throw new ToolError(
						`Not merged: CI is still running on ${args.commitSha}${pending.length > 0 ? ` (${pending.join(", ")})` : ""}.${missing} Wait (call heartbeat meanwhile) and call complete_review again.`,
					);
				}
				const moved = await ctx.github.fastForward(project.repo, main, args.commitSha);
				if (!moved) {
					throw new ToolError(
						`Not merged: ${main} moved while you were reviewing, so this is no longer a fast-forward. Rebase onto the latest origin/${main}, push, wait for CI and call complete_review again with the new SHA.`,
					);
				}
			}
			await ctx.github.deleteBranch(project.repo, branch);

			const ts = nowIso();
			await releaseClaim(
				ctx,
				args.claimId,
				{ status: "done", head_sha: args.commitSha, merged_sha: args.commitSha, done_at: ts },
				{
					projectId: project.id,
					taskId: task.id,
					type: "task.merged",
					summary: `${task.claimed_by} approved #${task.id} ${task.title}; ${main} is now at ${args.commitSha.slice(0, 10)}`,
					details: compact({ commitSha: args.commitSha, branch, notes: args.notes }),
					actorName: task.claimed_by ?? ctx.actor.name,
				},
			);
			return ok({
				merged: true,
				mainSha: args.commitSha,
				task: toTaskSummary(await loadTask(ctx, task.id)),
			});
		}),
	);

	server.registerTool(
		"block_task",
		{
			title: "Block task",
			description:
				"Give up on a claimed task because it cannot be finished without a human (missing information, a decision, access, a contradiction in the spec). " +
				"The task is not handed out again until the owner unblocks it. Push any useful work first.",
			inputSchema: z.object({
				claimId: claimIdSchema,
				reason: z
					.string()
					.min(1)
					.max(20_000)
					.describe(
						"What is blocking, what you tried, and what the owner needs to decide or provide",
					),
			}),
			outputSchema: z.object({ task: taskSummaryOutput }),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const { task, project } = await useClaim(ctx, args.claimId);
			await releaseClaim(
				ctx,
				args.claimId,
				{ status: "blocked", blocked_reason: args.reason },
				{
					projectId: project.id,
					taskId: task.id,
					type: "task.blocked",
					summary: `${task.claimed_by} blocked #${task.id}: ${firstLine(args.reason)}`,
					details: { reason: args.reason },
					actorName: task.claimed_by ?? ctx.actor.name,
				},
			);
			return ok({ task: toTaskSummary(await loadTask(ctx, task.id)) });
		}),
	);

	server.registerTool(
		"split_task",
		{
			title: "Split task",
			description:
				"Break a claimed task that is too big into smaller subtasks. The subtasks are queued, the original task waits until they are all done and then " +
				"comes back as the integration step that checks its full acceptance criteria. Your claim on the original task ends.",
			inputSchema: z.object({
				claimId: claimIdSchema,
				notes: z
					.string()
					.min(1)
					.max(20_000)
					.describe(
						"Why and how the task was split; what remains for the original task afterwards",
					),
				subtasks: z
					.array(
						newTaskSchema.extend({
							priority: z
								.number()
								.int()
								.min(-100)
								.max(100)
								.optional()
								.describe("Default: the original task's priority"),
						}),
					)
					.min(1)
					.max(30),
			}),
			outputSchema: z.object({ task: taskSummaryOutput, subtasks: z.array(taskSummaryOutput) }),
			annotations: { destructiveHint: false },
		},
		handle(async (args) => {
			const { task, project } = await useClaim(ctx, args.claimId);
			if (task.claim_kind !== "implement") {
				throw new ToolError(
					"Only implementation claims can be split. For a review, fix what you can, or create follow-up tasks with create_tasks.",
				);
			}
			const subtasks = args.subtasks.map((s) => ({ ...s, priority: s.priority ?? task.priority }));
			const actorName = task.claimed_by ?? ctx.actor.name;
			const ids = await createTasks(ctx, project, subtasks, {
				dependent: task.id,
				extraStatements: [
					ctx.db
						.prepare(
							`UPDATE tasks SET status = ?, claim_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE claim_id = ?`,
						)
						.bind(task.head_sha ? "paused" : "todo", nowIso(), args.claimId),
					eventStatement(ctx.db, ctx.actor, {
						projectId: project.id,
						taskId: task.id,
						type: "task.split",
						summary: `${actorName} split #${task.id} into ${args.subtasks.length} subtask(s): ${firstLine(args.notes)}`,
						details: { notes: args.notes },
						actorName,
					}),
				],
			});
			const created = await Promise.all(ids.map((id) => loadTask(ctx, id)));
			return ok({
				task: toTaskSummary(await loadTask(ctx, task.id)),
				subtasks: created.map(toTaskSummary),
			});
		}),
	);
}

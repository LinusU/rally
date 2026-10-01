import {
	createExecutionContext,
	createScheduledController,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { FakeGitHub } from "./github";
import {
	callTool,
	callToolExpectingError,
	createProject,
	OWNER_TOKEN,
	seedOwner,
	type TestProject,
} from "./helpers";

beforeAll(seedOwner);
afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Implement and submit a task as agent A, then claim its review as agent B. Each task gets its own
 * agent labels: request_work hands an agent back a claim it already holds under the same label.
 */
async function inReview(p: TestProject, gh: FakeGitHub, title: string) {
	await callTool("create_tasks", { tasks: [{ title }] }, p.agentA);
	const work = await callTool("request_work", { agentName: `impl-${title}` }, p.agentA);
	const sha = gh.push(work.branch);
	await callTool(
		"submit_for_review",
		{ claimId: work.claimId, commitSha: sha, summary: "done" },
		p.agentA,
	);
	const review = await callTool("request_work", { agentName: `review-${title}` }, p.agentB);
	expect(review.type).toBe("review");
	expect(review.task.title).toBe(title);
	return {
		taskId: review.task.id as number,
		branch: review.branch as string,
		claimId: review.claimId as string,
		sha,
	};
}

const moveMain = (gh: FakeGitHub) =>
	gh.branches.set("main", gh.commit(gh.branches.get("main") as string, ["docs/other.md"]));

const task = async (p: TestProject, id: number) =>
	(await callTool("get_task", { taskId: id }, p.agentA)).task;

/** Run the cron, which moves every landing queue along (request_work does it too). */
async function tick(_p?: TestProject): Promise<void> {
	const ctx = createExecutionContext();
	await worker.scheduled?.(createScheduledController({ cron: "* * * * *" }), env, ctx);
	await waitOnExecutionContext(ctx);
}

async function makeLandingStale(taskId: number): Promise<void> {
	await env.DB.prepare("UPDATE tasks SET landing_started_at = ? WHERE id = ?")
		.bind("2000-01-01T00:00:00.000Z", taskId)
		.run();
}

describe("landing queue", () => {
	it("approves a review that main has moved past and lands it with the lander", async () => {
		const p = await createProject("land-basic", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const r = await inReview(p, gh, "Land me");
		moveMain(gh);
		gh.green(r.sha);

		const done = await callTool(
			"complete_review",
			{ claimId: r.claimId, commitSha: r.sha },
			p.agentB,
		);
		expect(done).toMatchObject({ merged: false, queued: true, queuePosition: 1 });
		expect(done.next).toContain("do not rebase");
		expect(done.task.status).toBe("landing");
		expect(done.task.approvedSha).toBe(r.sha);
		expect(gh.dispatches).toEqual([
			{
				event_type: "rally-land",
				client_payload: {
					task: r.taskId,
					branch: r.branch,
					approvedSha: r.sha,
					mainBranch: "main",
				},
			},
		]);
		// The reviewer's claim has ended.
		expect(await callToolExpectingError("heartbeat", { claimId: r.claimId }, p.agentB)).toContain(
			"no longer valid",
		);
		const status = await callTool("get_status", {}, p.agentA);
		expect(status.projects[0].landingQueue.map((t: { id: number }) => t.id)).toEqual([r.taskId]);

		// The lander rebases and pushes; Rally waits for CI on the rebased commit.
		const rebased = gh.land(r.branch);
		await tick(p);
		expect((await task(p, r.taskId)).landing).toMatchObject({ attempt: 1, rebasedSha: rebased });
		gh.green(rebased);
		await tick(p);
		const landed = await task(p, r.taskId);
		expect(landed).toMatchObject({ status: "done", mergedSha: rebased });
		expect(gh.branches.get("main")).toBe(rebased);
		expect(gh.branches.has(r.branch)).toBe(false);
		const types = landed.history.map((e: { type: string }) => e.type);
		expect(types).toEqual(
			expect.arrayContaining([
				"task.approved",
				"landing.started",
				"landing.rebased",
				"task.merged",
			]),
		);
		const merged = landed.history.find((e: { type: string }) => e.type === "task.merged");
		expect(merged.actor).toBe("rally");
		expect(merged.summary).toContain("approved by agent-b/review-Land me");
	});

	it("still fast-forwards at once when nothing else is waiting", async () => {
		const p = await createProject("land-ff", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const r = await inReview(p, gh, "Fast");
		gh.green(r.sha);
		const done = await callTool(
			"complete_review",
			{ claimId: r.claimId, commitSha: r.sha },
			p.agentB,
		);
		expect(done).toMatchObject({ merged: true, mainSha: r.sha });
		expect(gh.dispatches).toEqual([]);
	});

	it("lands approvals one at a time, oldest first", async () => {
		const p = await createProject("land-order", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const a = await inReview(p, gh, "First");
		const b = await inReview(p, gh, "Second");
		moveMain(gh);
		gh.green(a.sha);
		await callTool("complete_review", { claimId: a.claimId, commitSha: a.sha }, p.agentB);
		// b is behind main too, and a is landing: b waits its turn instead of racing.
		gh.green(b.sha);
		const second = await callTool(
			"complete_review",
			{ claimId: b.claimId, commitSha: b.sha },
			p.agentB,
		);
		expect(second).toMatchObject({ queued: true, queuePosition: 2 });
		expect((await task(p, b.taskId)).status).toBe("approved");
		expect(gh.dispatches.map((d) => d.client_payload.task)).toEqual([a.taskId]);

		gh.green(gh.land(a.branch));
		await tick(p);
		expect((await task(p, a.taskId)).status).toBe("done");
		// main moved again (a landed), so b gets rebased by the lander in turn.
		expect((await task(p, b.taskId)).status).toBe("landing");
		expect(gh.dispatches.map((d) => d.client_payload.task)).toEqual([a.taskId, b.taskId]);
		const rebasedB = gh.land(b.branch);
		gh.green(rebasedB);
		await tick(p);
		expect((await task(p, b.taskId)).status).toBe("done");
		expect(gh.ancestors(gh.branches.get("main") as string)).toContain(rebasedB);
	});

	it("waits its turn even when it fast-forwards, then lands without the lander", async () => {
		const p = await createProject("land-turn", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const a = await inReview(p, gh, "Behind");
		moveMain(gh);
		const b = await inReview(p, gh, "Current"); // branched from the moved main
		gh.green(a.sha);
		await callTool("complete_review", { claimId: a.claimId, commitSha: a.sha }, p.agentB);
		gh.green(b.sha);
		expect(
			await callTool("complete_review", { claimId: b.claimId, commitSha: b.sha }, p.agentB),
		).toMatchObject({ queued: true });
		// a's lander reports a conflict, so a goes back to review; b fast-forwards with no rebase.
		gh.setStatus(a.sha, "rally/land", "failure", "rebase conflict with main");
		await tick(p);
		expect((await task(p, a.taskId)).status).toBe("needs_review");
		expect((await task(p, b.taskId)).status).toBe("done");
		expect(gh.branches.get("main")).toBe(b.sha);
		expect(gh.dispatches.map((d) => d.client_payload.task)).toEqual([a.taskId]);
	});

	it("sends a conflicting landing back to review and accepts it again later", async () => {
		const p = await createProject("land-conflict", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const r = await inReview(p, gh, "Conflicted");
		moveMain(gh);
		gh.green(r.sha);
		await callTool("complete_review", { claimId: r.claimId, commitSha: r.sha }, p.agentB);
		gh.setStatus(r.sha, "rally/land", "failure", "rebase conflict with main");
		await tick(p);
		const back = await task(p, r.taskId);
		expect(back.status).toBe("needs_review");
		const failed = back.history.find((e: { type: string }) => e.type === "landing.failed");
		expect(failed.summary).toContain("rebase conflict with main");
		expect(failed.summary).toContain("back in review");

		// The next reviewer resolves it. Rally's own rally/land status is not CI, so the same commit
		// with its old failed landing report could be approved again too; here it is rebased first.
		const review = await callTool("request_work", {}, p.agentB);
		expect(review.task.id).toBe(r.taskId);
		const resolved = gh.rebase(r.branch);
		gh.green(resolved);
		expect(
			await callTool("complete_review", { claimId: review.claimId, commitSha: resolved }, p.agentB),
		).toMatchObject({ merged: true });
	});

	it("does not count Rally's own landing report as CI", async () => {
		const p = await createProject("land-context", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const r = await inReview(p, gh, "Again");
		moveMain(gh);
		gh.green(r.sha);
		gh.setStatus(r.sha, "rally/land", "failure", "an old attempt");
		expect(
			await callTool("complete_review", { claimId: r.claimId, commitSha: r.sha }, p.agentB),
		).toMatchObject({ queued: true });
		// ... and that stale report predates this landing attempt, so it does not fail it either.
		await tick(p);
		expect((await task(p, r.taskId)).status).toBe("landing");
	});

	it("sends a landing back to review when CI fails on the rebased commit", async () => {
		const p = await createProject("land-red", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const r = await inReview(p, gh, "Red");
		moveMain(gh);
		gh.green(r.sha);
		await callTool("complete_review", { claimId: r.claimId, commitSha: r.sha }, p.agentB);
		const rebased = gh.land(r.branch);
		gh.setChecks(rebased, ["test", "completed", "failure"]);
		await tick(p);
		const back = await task(p, r.taskId);
		expect(back.status).toBe("needs_review");
		expect(back.history.at(-1).summary).toContain("CI failed on the rebased commit");
		expect(gh.branches.get("main")).not.toBe(rebased);
	});

	it("retries a stalled landing and gives up after the last attempt", async () => {
		const p = await createProject("land-stall", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const r = await inReview(p, gh, "Stalled");
		moveMain(gh);
		gh.green(r.sha);
		await callTool("complete_review", { claimId: r.claimId, commitSha: r.sha }, p.agentB);
		for (const attempt of [2, 3]) {
			await makeLandingStale(r.taskId);
			await tick(p);
			expect((await task(p, r.taskId)).landing.attempt).toBe(attempt);
		}
		expect(gh.dispatches).toHaveLength(3);
		await makeLandingStale(r.taskId);
		await tick(p);
		const back = await task(p, r.taskId);
		expect(back.status).toBe("needs_review");
		expect(back.history.at(-1).summary).toContain("last of 3 attempts");
	});

	it("sends a landing back to review when the branch changes under it", async () => {
		const p = await createProject("land-moved", { landingMode: "queue" });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const r = await inReview(p, gh, "Moved");
		moveMain(gh);
		gh.green(r.sha);
		await callTool("complete_review", { claimId: r.claimId, commitSha: r.sha }, p.agentB);
		gh.land(r.branch);
		await tick(p);
		gh.push(r.branch, ["src/sneaky.rs"]); // someone pushes over the rebased commit
		await tick(p);
		const back = await task(p, r.taskId);
		expect(back.status).toBe("needs_review");
		expect(back.history.at(-1).summary).toContain("changed during the landing");
	});

	it("keeps refusing a branch behind main without a landing queue", async () => {
		const p = await createProject("land-off");
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const r = await inReview(p, gh, "Classic");
		moveMain(gh);
		gh.green(r.sha);
		expect(
			await callToolExpectingError(
				"complete_review",
				{ claimId: r.claimId, commitSha: r.sha },
				p.agentB,
			),
		).toContain("not based on the latest main");
		expect(gh.dispatches).toEqual([]);
		const { project } = await callTool(
			"update_project",
			{ project: "land-off", landingMode: "queue" },
			OWNER_TOKEN,
		);
		expect(project.landingMode).toBe("queue");
		expect(
			await callTool("complete_review", { claimId: r.claimId, commitSha: r.sha }, p.agentB),
		).toMatchObject({ queued: true });
	});
});

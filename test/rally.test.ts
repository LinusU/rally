import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeGitHub } from "./github";
import {
	callTool,
	callToolExpectingError,
	createProject,
	OWNER_TOKEN,
	rpc,
	rpcResult,
	seedOwner,
} from "./helpers";

beforeAll(seedOwner);
afterEach(() => {
	vi.restoreAllMocks();
});

const toolNames = async (token: string) =>
	(await rpcResult<{ tools: Array<{ name: string }> }>("tools/list", {}, token)).tools
		.map((t) => t.name)
		.sort();

async function expireLease(taskId: number): Promise<void> {
	await env.DB.prepare("UPDATE tasks SET lease_expires_at = ? WHERE id = ?")
		.bind("2000-01-01T00:00:00.000Z", taskId)
		.run();
}

describe("MCP protocol", () => {
	it("rejects requests without a valid token", async () => {
		const res = await rpc("tools/list", {}, null);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
		expect((await rpc("tools/list", {}, "nope")).status).toBe(401);
	});

	it("gives the owner every tool and agents the work tools", async () => {
		const p = await createProject("protocol");
		const init = await rpcResult<{ serverInfo: { name: string }; instructions: string }>(
			"initialize",
			{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
			p.agentA,
		);
		expect(init.serverInfo.name).toBe("rally");
		expect(init.instructions).toContain("request_work");

		const agentTools = await toolNames(p.agentA);
		expect(agentTools).toEqual(
			[
				"add_note",
				"block_task",
				"complete_review",
				"create_tasks",
				"get_activity",
				"get_status",
				"get_task",
				"heartbeat",
				"list_tasks",
				"request_work",
				"save_checkpoint",
				"split_task",
				"submit_for_review",
			].sort(),
		);
		const ownerTools = await toolNames(OWNER_TOKEN);
		expect(ownerTools).toEqual(
			[...agentTools, "create_project", "list_projects", "update_project", "update_tasks"].sort(),
		);
	});

	it("keeps agents inside their own project", async () => {
		const a = await createProject("fence-a");
		const b = await createProject("fence-b");
		const {
			created: [task],
		} = await callTool(
			"create_tasks",
			{ project: "fence-b", tasks: [{ title: "Secret" }] },
			OWNER_TOKEN,
		);
		expect(await callToolExpectingError("get_task", { taskId: task.id }, a.agentA)).toContain(
			"Unknown task",
		);
		expect(await callToolExpectingError("list_tasks", { project: "fence-b" }, a.agentA)).toContain(
			"only has access to project 'fence-a'",
		);
		expect((await callTool("get_task", { taskId: task.id }, b.agentA)).task.title).toBe("Secret");
	});
});

describe("planning", () => {
	it("creates tasks with dependencies by key and rejects cycles", async () => {
		await createProject("plan");
		const { created } = await callTool(
			"create_tasks",
			{
				project: "plan",
				tasks: [
					{ key: "B", title: "Second", dependsOn: ["A"] },
					{ key: "A", title: "First", description: "Do it", priority: 5 },
				],
			},
			OWNER_TOKEN,
		);
		const [b, a] = created;
		expect(b.dependsOn).toEqual([a.id]);
		expect(b.ready).toBe(false);
		expect(a.ready).toBe(true);

		expect(
			await callToolExpectingError(
				"create_tasks",
				{
					project: "plan",
					tasks: [
						{ key: "X", title: "x", dependsOn: ["Y"] },
						{ key: "Y", title: "y", dependsOn: ["X"] },
					],
				},
				OWNER_TOKEN,
			),
		).toContain("cycle");
		expect(
			await callToolExpectingError(
				"update_tasks",
				{ updates: [{ taskId: a.id, dependsOn: [b.id] }] },
				OWNER_TOKEN,
			),
		).toContain("cycle");
		expect(
			await callToolExpectingError(
				"create_tasks",
				{ project: "plan", tasks: [{ key: "A", title: "dup" }] },
				OWNER_TOKEN,
			),
		).toContain("already used");
	});

	it("creates a large plan in one call", async () => {
		await createProject("big-plan");
		const tasks = Array.from({ length: 50 }, (_, i) => ({
			key: `T${i}`,
			title: `Task ${i}`,
			dependsOn: Array.from({ length: i }, (_, j) => `T${j}`).slice(-3),
		}));
		const first = await callTool("create_tasks", { project: "big-plan", tasks }, OWNER_TOKEN);
		expect(first.created).toHaveLength(50);
		const more = Array.from({ length: 50 }, (_, i) => ({
			key: `U${i}`,
			title: `Follow-up ${i}`,
			dependsOn: [`T${i}`, `T${49 - i}`, ...(i > 0 ? [`U${i - 1}`] : [])],
		}));
		const second = await callTool(
			"create_tasks",
			{ project: "big-plan", tasks: more },
			OWNER_TOKEN,
		);
		expect(second.created[49].dependsOn).toHaveLength(3);
	});

	it("requires a project for the owner once several exist", async () => {
		await createProject("many-1");
		await createProject("many-2");
		expect(
			await callToolExpectingError("create_tasks", { tasks: [{ title: "x" }] }, OWNER_TOKEN),
		).toContain("pass `project`");
	});
});

describe("work loop", () => {
	it("implements, reviews and fast-forwards main", async () => {
		const p = await createProject("loop", { protectedPaths: [".github/"] });
		const gh = new FakeGitHub(p.repo);
		gh.install();

		const { created } = await callTool(
			"create_tasks",
			{
				project: "loop",
				tasks: [
					{ key: "core", title: "Build the core", priority: 1 },
					{ key: "ui", title: "Build the UI", dependsOn: ["core"] },
				],
			},
			OWNER_TOKEN,
		);
		const [core, ui] = created;

		const work = await callTool("request_work", { agentName: "s1" }, p.agentA);
		expect(work.type).toBe("implement");
		expect(work.task.id).toBe(core.id);
		expect(work.branch).toBe(`rally/${core.id}-build-the-core`);
		expect(work.steps).toContain(`git checkout -B ${work.branch} origin/main`);
		expect(work.steps).toContain(".github/");

		// The UI waits on the core, so the second agent has nothing to do.
		const idle = await callTool("request_work", {}, p.agentB);
		expect(idle.type).toBe("none");
		expect(idle.reason).toContain("1 waiting on dependencies");

		// Submitting needs the branch on GitHub at exactly that commit.
		const wrong = "f".repeat(40);
		expect(
			await callToolExpectingError(
				"submit_for_review",
				{ claimId: work.claimId, commitSha: wrong, summary: "done" },
				p.agentA,
			),
		).toContain("does not exist on GitHub");
		const sha1 = gh.push(work.branch);
		expect(
			await callToolExpectingError(
				"submit_for_review",
				{ claimId: work.claimId, commitSha: wrong, summary: "done" },
				p.agentA,
			),
		).toContain(`is at ${sha1}`);
		const submitted = await callTool(
			"submit_for_review",
			{ claimId: work.claimId, commitSha: sha1, summary: "Core is built" },
			p.agentA,
		);
		expect(submitted.task.status).toBe("needs_review");
		expect(
			await callToolExpectingError("heartbeat", { claimId: work.claimId }, p.agentA),
		).toContain("no longer valid");

		// Meanwhile main moves on, so the review has to rebase.
		gh.branches.set("main", gh.commit(gh.branches.get("main") as string, ["docs/x.md"]));

		const review = await callTool("request_work", {}, p.agentB);
		expect(review.type).toBe("review");
		expect(review.task.id).toBe(core.id);
		expect(review.task.history.map((e: { type: string }) => e.type)).toContain("task.submitted");
		const claimId = review.claimId;

		expect(
			await callToolExpectingError("complete_review", { claimId, commitSha: sha1 }, p.agentB),
		).toContain("not based on the latest main");

		const sha2 = gh.rebase(review.branch);
		expect(
			await callToolExpectingError("complete_review", { claimId, commitSha: sha2 }, p.agentB),
		).toContain("no CI results");
		gh.setChecks(sha2, ["test", "in_progress", null], ["lint", "completed", "success"]);
		expect(
			await callToolExpectingError("complete_review", { claimId, commitSha: sha2 }, p.agentB),
		).toContain("still running on");
		gh.setChecks(sha2, ["test", "completed", "failure"]);
		expect(
			await callToolExpectingError("complete_review", { claimId, commitSha: sha2 }, p.agentB),
		).toContain("CI failed");

		// A fix that touches a protected path is refused.
		const sha3 = gh.push(review.branch, [".github/workflows/ci.yml"]);
		gh.green(sha3);
		expect(
			await callToolExpectingError("complete_review", { claimId, commitSha: sha3 }, p.agentB),
		).toContain("protected paths (.github/workflows/ci.yml)");

		// Revert it: a clean branch with green CI gets merged.
		gh.branches.set(review.branch, sha2);
		const sha4 = gh.push(review.branch, ["src/fix.rs"]);
		gh.green(sha4);
		const merged = await callTool(
			"complete_review",
			{ claimId, commitSha: sha4, notes: "Fixed an off-by-one" },
			p.agentB,
		);
		expect(merged).toMatchObject({ merged: true, mainSha: sha4 });
		expect(merged.task).toMatchObject({ status: "done", mergedSha: sha4 });
		expect(gh.branches.get("main")).toBe(sha4);
		expect(gh.branches.has(review.branch)).toBe(false);

		// Now the UI is unblocked.
		const next = await callTool("request_work", {}, p.agentA);
		expect(next.task.id).toBe(ui.id);

		const { events } = await callTool("get_activity", { project: "loop" }, OWNER_TOKEN);
		const types = events.map((e: { type: string }) => e.type);
		expect(types).toContain("task.merged");
		expect(events.find((e: { type: string }) => e.type === "task.merged").actor).toBe("agent-b");
		const started = events.filter((e: { type: string }) => e.type === "task.started");
		expect(started.map((e: { actor: string; taskId: number }) => [e.taskId, e.actor])).toEqual([
			[ui.id, "agent-a"],
			[core.id, "agent-a/s1"],
		]);
	});

	it("refuses to merge when main moves between the checks and the ref update", async () => {
		const p = await createProject("race");
		const gh = new FakeGitHub(p.repo);
		gh.install();
		await callTool("create_tasks", { tasks: [{ title: "Race" }] }, p.agentA);
		const work = await callTool("request_work", {}, p.agentA);
		const sha = gh.push(work.branch);
		await callTool(
			"submit_for_review",
			{ claimId: work.claimId, commitSha: sha, summary: "x" },
			p.agentA,
		);
		const review = await callTool("request_work", {}, p.agentB);
		gh.green(sha);

		// Another merge lands right after Rally compared: the ref update is no longer a fast-forward.
		gh.beforeRefUpdate = () => {
			gh.branches.set("main", gh.commit(gh.branches.get("main") as string));
		};
		expect(
			await callToolExpectingError(
				"complete_review",
				{ claimId: review.claimId, commitSha: sha },
				p.agentB,
			),
		).toContain("moved while you were reviewing");
		expect((await callTool("get_task", { taskId: review.task.id }, p.agentB)).task.status).toBe(
			"reviewing",
		);
	});

	it("waits for every required check before merging", async () => {
		const p = await createProject("required", { requiredChecks: ["test", "e2e"] });
		const gh = new FakeGitHub(p.repo);
		gh.install();
		await callTool("create_tasks", { tasks: [{ title: "Checked" }] }, p.agentA);
		const work = await callTool("request_work", {}, p.agentA);
		const sha = gh.push(work.branch);
		await callTool(
			"submit_for_review",
			{ claimId: work.claimId, commitSha: sha, summary: "x" },
			p.agentA,
		);
		const review = await callTool("request_work", {}, p.agentB);
		gh.green(sha);
		expect(
			await callToolExpectingError(
				"complete_review",
				{ claimId: review.claimId, commitSha: sha },
				p.agentB,
			),
		).toContain("Required checks not reported yet: e2e");
		gh.setChecks(sha, ["test", "completed", "success"], ["e2e", "completed", "skipped"]);
		const merged = await callTool(
			"complete_review",
			{ claimId: review.claimId, commitSha: sha },
			p.agentB,
		);
		expect(merged.merged).toBe(true);
	});

	it("marks the task done when main already contains the commit", async () => {
		const p = await createProject("idempotent");
		const gh = new FakeGitHub(p.repo);
		gh.install();
		await callTool("create_tasks", { tasks: [{ title: "Retry" }] }, p.agentA);
		const work = await callTool("request_work", {}, p.agentA);
		const sha = gh.push(work.branch);
		await callTool(
			"submit_for_review",
			{ claimId: work.claimId, commitSha: sha, summary: "x" },
			p.agentA,
		);
		const review = await callTool("request_work", {}, p.agentB);
		gh.branches.set("main", sha); // main was already moved, e.g. before a crash
		const merged = await callTool(
			"complete_review",
			{ claimId: review.claimId, commitSha: sha },
			p.agentB,
		);
		expect(merged.task.status).toBe("done");
	});

	it("hands out reviews first, then checkpointed work, then new tasks by priority", async () => {
		const p = await createProject("order");
		const gh = new FakeGitHub(p.repo);
		gh.install();
		const { created } = await callTool(
			"create_tasks",
			{
				tasks: [{ title: "Low", priority: -1 }, { title: "High", priority: 10 }, { title: "Mid" }],
			},
			p.agentA,
		);
		const [low, high, mid] = created;

		const first = await callTool("request_work", {}, p.agentA);
		expect(first.task.id).toBe(high.id);
		const second = await callTool("request_work", {}, p.agentB);
		expect(second.task.id).toBe(mid.id);

		const sha = gh.push(first.branch);
		await callTool(
			"save_checkpoint",
			{ claimId: first.claimId, notes: "Half done.\nNext: wire up X.", commitSha: sha },
			p.agentA,
		);
		const sha2 = gh.push(second.branch);
		await callTool(
			"submit_for_review",
			{ claimId: second.claimId, commitSha: sha2, summary: "Mid done" },
			p.agentB,
		);

		const third = await callTool("request_work", {}, p.agentA);
		expect(third).toMatchObject({ type: "review", task: { id: mid.id } });

		const fourth = await callTool("request_work", {}, p.agentB);
		expect(fourth).toMatchObject({ type: "resume", task: { id: high.id, headSha: sha } });
		expect(fourth.steps).toContain(`origin/${fourth.branch}`);
		const checkpoint = fourth.task.history.find(
			(e: { type: string }) => e.type === "task.checkpoint",
		);
		expect(checkpoint.details.notes).toContain("Next: wire up X.");

		const fifth = await callTool("request_work", {}, p.agentB);
		expect(fifth.task.id).toBe(low.id);
	});

	it("requeues work whose lease expired, and lets the old holder resume if nobody took it", async () => {
		const p = await createProject("lease");
		await callTool("create_tasks", { tasks: [{ title: "One" }, { title: "Two" }] }, p.agentA);

		const a = await callTool("request_work", {}, p.agentA);
		await expireLease(a.task.id);
		// Nobody else claimed it: the original holder carries on with the same claim.
		const beat = await callTool(
			"heartbeat",
			{ claimId: a.claimId, note: "still building" },
			p.agentA,
		);
		expect(beat.taskId).toBe(a.task.id);
		const history = (await callTool("get_task", { taskId: a.task.id }, p.agentA)).task.history.map(
			(e: { type: string }) => e.type,
		);
		expect(history).toEqual(["task.created", "task.started", "task.progress"]);

		await expireLease(a.task.id);
		const b = await callTool("request_work", {}, p.agentB);
		expect(b).toMatchObject({ type: "resume", task: { id: a.task.id, status: "in_progress" } });
		expect(b.task.history.map((e: { type: string }) => e.type)).toContain("claim.expired");
		expect(await callToolExpectingError("heartbeat", { claimId: a.claimId }, p.agentA)).toContain(
			"no longer valid",
		);
	});

	it("blocks, splits and lets the owner unblock", async () => {
		const p = await createProject("block");
		await callTool("create_tasks", { tasks: [{ title: "Huge", priority: 3 }] }, p.agentA);
		const work = await callTool("request_work", {}, p.agentA);
		const split = await callTool(
			"split_task",
			{
				claimId: work.claimId,
				notes: "Too big",
				subtasks: [
					{ key: "part-1", title: "Part 1" },
					{ title: "Part 2", dependsOn: ["part-1"] },
				],
			},
			p.agentA,
		);
		expect(split.task.status).toBe("todo");
		expect(split.task.dependsOn).toEqual(split.subtasks.map((t: { id: number }) => t.id));
		expect(split.subtasks[0].priority).toBe(3);

		const part1 = await callTool("request_work", {}, p.agentB);
		expect(part1.task.title).toBe("Part 1");
		const blocked = await callTool(
			"block_task",
			{ claimId: part1.claimId, reason: "Which file format?" },
			p.agentB,
		);
		expect(blocked.task).toMatchObject({ status: "blocked", blockedReason: "Which file format?" });
		expect((await callTool("request_work", {}, p.agentB)).type).toBe("none");

		const status = await callTool("get_status", {}, OWNER_TOKEN);
		const mine = status.projects.find((x: { project: string }) => x.project === "block");
		expect(mine.blocked.map((t: { id: number }) => t.id)).toEqual([part1.task.id]);

		await callTool("add_note", { taskId: part1.task.id, text: "Use JSON." }, OWNER_TOKEN);
		await callTool(
			"update_tasks",
			{ updates: [{ taskId: part1.task.id, status: "todo" }] },
			OWNER_TOKEN,
		);
		const again = await callTool("request_work", {}, p.agentB);
		expect(again.task.id).toBe(part1.task.id);
		expect(
			again.task.history.find((e: { type: string }) => e.type === "task.note").details.text,
		).toBe("Use JSON.");
	});

	it("ends an agent's claim when the owner changes the task status", async () => {
		const p = await createProject("override");
		await callTool("create_tasks", { tasks: [{ title: "Wrong idea" }] }, p.agentA);
		const work = await callTool("request_work", {}, p.agentA);
		await callTool(
			"update_tasks",
			{ updates: [{ taskId: work.task.id, status: "cancelled" }] },
			OWNER_TOKEN,
		);
		expect(
			await callToolExpectingError(
				"save_checkpoint",
				{ claimId: work.claimId, notes: "x" },
				p.agentA,
			),
		).toContain("no longer valid");
	});

	it("stops handing out work while the project is paused", async () => {
		const p = await createProject("paused");
		await callTool("create_tasks", { tasks: [{ title: "Later" }] }, p.agentA);
		await callTool("update_project", { project: "paused", paused: true }, OWNER_TOKEN);
		expect((await callTool("request_work", {}, p.agentA)).reason).toContain("paused");
		await callTool("update_project", { project: "paused", paused: false }, OWNER_TOKEN);
		expect((await callTool("request_work", {}, p.agentA)).type).toBe("implement");
	});

	it("lets the owner do work by naming the project", async () => {
		await createProject("owner-work");
		await callTool(
			"create_tasks",
			{ project: "owner-work", tasks: [{ title: "Hands on" }] },
			OWNER_TOKEN,
		);
		const work = await callTool("request_work", { project: "owner-work" }, OWNER_TOKEN);
		expect(work).toMatchObject({ type: "implement", task: { title: "Hands on" } });
		expect(work.task.claim.by).toBe("Linus");
		const blocked = await callTool(
			"block_task",
			{ claimId: work.claimId, reason: "Needs a decision" },
			OWNER_TOKEN,
		);
		expect(blocked.task.status).toBe("blocked");
	});
});

describe("activity", () => {
	it("filters by time", async () => {
		const p = await createProject("activity");
		await callTool("create_tasks", { tasks: [{ title: "Before" }] }, p.agentA);
		await new Promise((r) => setTimeout(r, 5));
		const since = new Date().toISOString();
		await callTool("create_tasks", { tasks: [{ title: "After" }] }, p.agentA);
		const { events } = await callTool("get_activity", { project: "activity", since }, OWNER_TOKEN);
		expect(events.map((e: { summary: string }) => e.summary)).toEqual([
			expect.stringContaining("After"),
		]);
	});

	it("serves a health check", async () => {
		const res = await SELF.fetch("https://rally.test/health");
		expect(await res.json()).toMatchObject({
			status: "ok",
			tagline: "Many agents. One main branch.",
		});
	});
});

import { vi } from "vitest";

interface CommitStatusRow {
	context: string;
	state: string;
	description: string;
	target_url: string;
	updated_at: string;
}

/** A GitHub Actions workflow run, as far as Rally looks at it. */
interface CheckRun {
	name: string;
	status: "queued" | "in_progress" | "completed";
	conclusion: string | null;
}

/**
 * An in-memory GitHub: a commit graph, branches, check runs, and the REST endpoints Rally calls.
 * Installed by stubbing globalThis.fetch, which the Worker under test shares with the test runner.
 */
export class FakeGitHub {
	readonly parents = new Map<string, string | null>();
	readonly files = new Map<string, string[]>();
	readonly branches = new Map<string, string>();
	readonly checks = new Map<string, CheckRun[]>();
	readonly statuses = new Map<string, CommitStatusRow[]>();
	/** repository_dispatch payloads, oldest first. */
	readonly dispatches: Array<{ event_type: string; client_payload: Record<string, unknown> }> = [];
	readonly calls: string[] = [];
	/** Runs just before a ref update is applied, to simulate concurrent pushes. */
	beforeRefUpdate: (() => void) | null = null;
	private counter = 0;

	constructor(readonly repo: string) {
		this.branches.set("main", this.commit(null, ["README.md"]));
	}

	commit(parent: string | null, files: string[] = ["src/lib.rs"]): string {
		this.counter++;
		const sha = [...crypto.getRandomValues(new Uint8Array(20))]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		this.parents.set(sha, parent);
		this.files.set(sha, files);
		return sha;
	}

	/** Commit on top of a branch (creating it from main if needed) and move the branch there. */
	push(branch: string, files?: string[]): string {
		const base = this.branches.get(branch) ?? (this.branches.get("main") as string);
		const sha = this.commit(base, files);
		this.branches.set(branch, sha);
		return sha;
	}

	/** Replay a branch's commits onto the current main, like `git rebase origin/main && git push -f`. */
	rebase(branch: string): string {
		const main = this.branches.get("main") as string;
		const own = this.ancestors(this.branches.get(branch) as string).filter(
			(c) => !this.ancestors(main).includes(c),
		);
		let head = main;
		for (const c of own.reverse()) head = this.commit(head, this.files.get(c));
		this.branches.set(branch, head);
		return head;
	}

	setChecks(sha: string, ...runs: Array<[string, CheckRun["status"], string | null]>): void {
		this.checks.set(
			sha,
			runs.map(([name, status, conclusion]) => ({ name, status, conclusion })),
		);
	}

	green(sha: string): void {
		this.setChecks(sha, ["test", "completed", "success"]);
	}

	/** Report a commit status, replacing an earlier one of the same context. */
	setStatus(sha: string, context: string, state: string, description = ""): void {
		const rows = (this.statuses.get(sha) ?? []).filter((r) => r.context !== context);
		rows.push({
			context,
			state,
			description,
			target_url: `https://github.com/${this.repo}/actions/runs/1`,
			updated_at: new Date().toISOString(),
		});
		this.statuses.set(sha, rows);
	}

	/** What the lander workflow does: rebase the approved branch onto main, push it, report success. */
	land(branch: string): string {
		const approved = this.branches.get(branch) as string;
		const rebased = this.rebase(branch);
		this.setStatus(approved, "rally/land", "success", `rebased as ${rebased.slice(0, 7)}`);
		return rebased;
	}

	ancestors(sha: string): string[] {
		const out: string[] = [];
		let c: string | null | undefined = sha;
		while (c) {
			out.push(c);
			c = this.parents.get(c);
		}
		return out;
	}

	install(): void {
		const real = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.hostname !== "api.github.com") return real(input, init);
			return this.handle(
				init?.method ?? "GET",
				url,
				init?.body ? JSON.parse(String(init.body)) : undefined,
			);
		});
	}

	private handle(
		method: string,
		url: URL,
		body:
			| {
					sha?: string;
					force?: boolean;
					event_type?: string;
					client_payload?: Record<string, unknown>;
			  }
			| undefined,
	): Response {
		const prefix = `/repos/${this.repo}/`;
		const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
		this.calls.push(`${method} ${url.pathname}`);
		if (!url.pathname.startsWith(prefix)) return reply(404, { message: "Not Found" });
		const path = decodeURIComponent(url.pathname.slice(prefix.length));

		let m = /^git\/refs?\/heads\/(.+)$/.exec(path);
		if (m?.[1]) {
			const branch = m[1];
			if (method === "GET") {
				const sha = this.branches.get(branch);
				return sha ? reply(200, { object: { sha } }) : reply(404, { message: "Not Found" });
			}
			if (method === "PATCH") {
				this.beforeRefUpdate?.();
				const current = this.branches.get(branch);
				const target = body?.sha as string;
				if (!current || !this.parents.has(target))
					return reply(422, { message: "Reference does not exist" });
				if (!body?.force && !this.ancestors(target).includes(current)) {
					return reply(422, { message: "Update is not a fast forward" });
				}
				this.branches.set(branch, target);
				return reply(200, { object: { sha: target } });
			}
			if (method === "DELETE") {
				this.branches.delete(branch);
				return new Response(null, { status: 204 });
			}
		}

		m = /^compare\/(.+)\.\.\.(.+)$/.exec(path);
		if (m?.[1] && m[2]) {
			const base = this.branches.get(m[1]) ?? m[1];
			const head = this.branches.get(m[2]) ?? m[2];
			const baseAnc = this.ancestors(base);
			const headAnc = this.ancestors(head);
			const ahead = headAnc.filter((c) => !baseAnc.includes(c));
			const behind = baseAnc.filter((c) => !headAnc.includes(c));
			const status =
				ahead.length === 0 && behind.length === 0
					? "identical"
					: behind.length === 0
						? "ahead"
						: ahead.length === 0
							? "behind"
							: "diverged";
			return reply(200, {
				status,
				ahead_by: ahead.length,
				behind_by: behind.length,
				base_commit: { sha: base },
				files: [...new Set(ahead.flatMap((c) => this.files.get(c) ?? []))].map((filename) => ({
					filename,
				})),
			});
		}

		if (path === "actions/runs") {
			const runs = this.checks.get(url.searchParams.get("head_sha") ?? "") ?? [];
			return reply(200, {
				total_count: runs.length,
				workflow_runs: runs.map((r, i) => ({ id: i + 1, ...r })),
			});
		}
		m = /^commits\/([0-9a-f]{40})\/status$/.exec(path);
		if (m?.[1]) {
			const statuses = this.statuses.get(m[1]) ?? [];
			return reply(200, { state: "pending", total_count: statuses.length, statuses });
		}
		if (path === "dispatches" && method === "POST") {
			this.dispatches.push({
				event_type: body?.event_type ?? "",
				client_payload: body?.client_payload ?? {},
			});
			return new Response(null, { status: 204 });
		}

		return reply(404, { message: `Fake GitHub has no route for ${method} ${path}` });
	}
}

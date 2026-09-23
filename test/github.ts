import { vi } from "vitest";

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
		body: { sha?: string; force?: boolean } | undefined,
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
		if (m?.[1]) return reply(200, { state: "pending", total_count: 0, statuses: [] });

		return reply(404, { message: `Fake GitHub has no route for ${method} ${path}` });
	}
}

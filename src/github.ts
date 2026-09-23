/**
 * The handful of GitHub REST calls Rally needs: branch heads, compare, CI results, ref updates.
 * All of them work with a fine-grained PAT (Contents read/write, Actions read, Commit statuses read).
 */

const API = "https://api.github.com";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface Comparison {
	/** "ahead": head strictly contains base; "identical": same commit; "behind"/"diverged": base has commits head lacks. */
	status: "ahead" | "behind" | "identical" | "diverged";
	aheadBy: number;
	behindBy: number;
	baseSha: string;
	/** Changed paths (both sides of renames). GitHub lists at most 300 files. */
	files: string[];
}

export type CheckState = "success" | "pending" | "failure";

export interface CiResult {
	/** "none" means GitHub has no workflow runs or statuses for the commit (yet). */
	state: CheckState | "none";
	checks: Array<{ name: string; state: CheckState; detail?: string }>;
	missingRequired: string[];
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export class GitHub {
	constructor(
		private readonly token: string | undefined,
		// Looked up per call (not captured) so tests can stub globalThis.fetch.
		private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
	) {}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<{ status: number; data: T }> {
		if (!this.token) {
			throw new GitHubError(
				"Rally has no GITHUB_TOKEN configured, so it cannot talk to GitHub. The owner must set it with `wrangler secret put GITHUB_TOKEN`.",
				500,
			);
		}
		const init: RequestInit = {
			method,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${this.token}`,
				"x-github-api-version": "2022-11-28",
				"user-agent": "rally-mcp",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
		};
		if (body !== undefined) init.body = JSON.stringify(body);
		const res = await this.fetchFn(`${API}${path}`, init);
		const text = await res.text();
		let data: unknown = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = text;
		}
		return { status: res.status, data: data as T };
	}

	private fail(what: string, status: number, data: unknown): never {
		const message =
			data && typeof data === "object" && "message" in data ? String(data.message) : "";
		const hint =
			status === 401
				? " Rally's GITHUB_TOKEN is invalid or expired."
				: status === 403 || status === 404
					? " Check that Rally's GITHUB_TOKEN can access this repository."
					: "";
		throw new GitHubError(
			`GitHub ${what} failed (HTTP ${status}${message ? `: ${message}` : ""}).${hint}`,
			status,
		);
	}

	/** Current commit of a branch, or null when the branch does not exist. */
	async branchHead(repo: string, branch: string): Promise<string | null> {
		const { status, data } = await this.request<{ object?: { sha?: string } }>(
			"GET",
			`/repos/${repo}/git/ref/heads/${encodePath(branch)}`,
		);
		if (status === 404) return null;
		if (status !== 200 || !data.object?.sha) this.fail(`reading branch ${branch}`, status, data);
		return data.object.sha;
	}

	async compare(repo: string, base: string, head: string): Promise<Comparison> {
		const { status, data } = await this.request<{
			status: Comparison["status"];
			ahead_by: number;
			behind_by: number;
			base_commit: { sha: string };
			files?: Array<{ filename: string; previous_filename?: string }>;
		}>("GET", `/repos/${repo}/compare/${encodePath(base)}...${encodePath(head)}`);
		if (status !== 200) this.fail(`comparing ${base}...${head}`, status, data);
		const files = new Set<string>();
		for (const f of data.files ?? []) {
			files.add(f.filename);
			if (f.previous_filename) files.add(f.previous_filename);
		}
		return {
			status: data.status,
			aheadBy: data.ahead_by,
			behindBy: data.behind_by,
			baseSha: data.base_commit.sha,
			files: [...files],
		};
	}

	/**
	 * Combine GitHub Actions workflow runs and commit statuses for one commit. (The Checks API would
	 * also cover third-party apps, but fine-grained personal access tokens cannot read it.)
	 */
	async ci(repo: string, sha: string, required: string[]): Promise<CiResult> {
		const [runs, statuses] = await Promise.all([
			this.request<{
				workflow_runs: Array<{
					id: number;
					name: string | null;
					status: string | null;
					conclusion: string | null;
				}>;
			}>("GET", `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`),
			this.request<{ statuses: Array<{ context: string; state: string }> }>(
				"GET",
				`/repos/${repo}/commits/${sha}/status?per_page=100`,
			),
		]);
		if (runs.status !== 200) this.fail(`listing workflow runs for ${sha}`, runs.status, runs.data);
		if (statuses.status !== 200)
			this.fail(`reading commit status for ${sha}`, statuses.status, statuses.data);

		// A workflow can run more than once for a commit (e.g. re-triggered); the newest run counts.
		const latest = new Map<string, (typeof runs.data.workflow_runs)[number]>();
		for (const run of runs.data.workflow_runs) {
			const name = run.name ?? `workflow run ${run.id}`;
			const seen = latest.get(name);
			if (!seen || run.id > seen.id) latest.set(name, run);
		}
		const checks: CiResult["checks"] = [
			...[...latest].map(([name, r]) => {
				const state: CheckState =
					r.status !== "completed"
						? "pending"
						: PASSING_CONCLUSIONS.has(r.conclusion ?? "")
							? "success"
							: "failure";
				return state === "failure"
					? { name, state, detail: r.conclusion ?? "unknown" }
					: { name, state };
			}),
			...statuses.data.statuses.map((s) => {
				const state: CheckState =
					s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure";
				return state === "failure"
					? { name: s.context, state, detail: s.state }
					: { name: s.context, state };
			}),
		];
		const names = new Set(checks.map((c) => c.name));
		const missingRequired = required.filter((name) => !names.has(name));

		let state: CiResult["state"];
		if (checks.some((c) => c.state === "failure")) state = "failure";
		else if (checks.length === 0) state = "none";
		else if (missingRequired.length > 0 || checks.some((c) => c.state === "pending"))
			state = "pending";
		else state = "success";
		return { state, checks, missingRequired };
	}

	/** Move a branch to `sha` without force. Returns false when that would not be a fast-forward. */
	async fastForward(repo: string, branch: string, sha: string): Promise<boolean> {
		const { status, data } = await this.request(
			"PATCH",
			`/repos/${repo}/git/refs/heads/${encodePath(branch)}`,
			{ sha, force: false },
		);
		if (status === 200) return true;
		if (status === 422) return false;
		this.fail(`updating ${branch}`, status, data);
	}

	/** Best effort: a leftover branch is harmless. */
	async deleteBranch(repo: string, branch: string): Promise<void> {
		await this.request("DELETE", `/repos/${repo}/git/refs/heads/${encodePath(branch)}`).catch(
			() => undefined,
		);
	}
}

/** Encode each path segment but keep the slashes that branch names like `rally/42-x` contain. */
function encodePath(ref: string): string {
	return ref.split("/").map(encodeURIComponent).join("/");
}

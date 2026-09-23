export interface Env {
	DB: D1Database;
	/** Owner access key typed into the OAuth sign-in page. Set with `wrangler secret put`. */
	RALLY_ACCESS_KEY?: string;
	/** Fine-grained GitHub PAT used to read CI results and fast-forward main. Set with `wrangler secret put`. */
	GITHUB_TOKEN?: string;
}

import type { Env as RallyEnv } from "../src/env";

// `cloudflare:test` types `env` as Cloudflare.Env (the namespace `wrangler types` would generate).
declare global {
	namespace Cloudflare {
		interface Env extends RallyEnv {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

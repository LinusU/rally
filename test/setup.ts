import { applyD1Migrations, env } from "cloudflare:test";

// Setup files run outside per-test storage isolation and may run more than once;
// applyD1Migrations only applies migrations that have not been applied yet.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

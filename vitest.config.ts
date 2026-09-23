import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					RALLY_ACCESS_KEY: "test-access-key",
					GITHUB_TOKEN: "test-github-token",
				},
			},
		}),
	],
	test: {
		setupFiles: ["./test/setup.ts"],
	},
});

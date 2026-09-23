#!/usr/bin/env node
// Create a static API token and store its hash in D1 via wrangler.
//
//   npm run token:create -- owner <name> [--remote]
//   npm run token:create -- agent <name> --project <slug> [--remote]
//
// Owner tokens can plan, monitor and work on every project. Agent tokens are bound to one project.
// Prints the token once. Only its SHA-256 hash is stored.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const projectIndex = args.indexOf("--project");
const projectSlug = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
const positional = args.filter(
	(a, i) => !a.startsWith("--") && (projectIndex < 0 || i !== projectIndex + 1),
);
const [role, name] = positional;

const usage = `Usage:
  npm run token:create -- owner <name> [--remote]
  npm run token:create -- agent <name> --project <slug> [--remote]`;

if ((role !== "owner" && role !== "agent") || !name || (role === "agent") !== !!projectSlug) {
	console.error(usage);
	process.exit(1);
}

const sql = (s) => s.replaceAll("'", "''");

function execute(statement) {
	const result = spawnSync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"rally",
			remote ? "--remote" : "--local",
			"--json",
			"--command",
			statement,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		console.error(result.stdout, result.stderr);
		process.exit(result.status ?? 1);
	}
	try {
		return JSON.parse(result.stdout)[0]?.results ?? [];
	} catch {
		console.error(result.stdout);
		process.exit(1);
	}
}

let projectId = null;
if (role === "agent") {
	const rows = execute(`SELECT id FROM projects WHERE slug = '${sql(projectSlug)}' LIMIT 1;`);
	if (rows.length === 0) {
		console.error(
			`No project with slug "${projectSlug}". Create it first with the create_project tool.`,
		);
		process.exit(1);
	}
	projectId = rows[0].id;
}

const token = `rally_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
const tokenId = `tok_${randomBytes(6).toString("hex")}`;

execute(
	`INSERT INTO auth_tokens (id, kind, token_hash, role, project_id, name, client_name, created_at)
	 VALUES ('${tokenId}', 'api', '${hash}', '${role}', ${projectId ? `'${sql(projectId)}'` : "NULL"}, '${sql(name)}', 'api token', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`,
);

const scope = role === "agent" ? `agent on ${projectSlug}` : "owner";
console.log(`Created ${remote ? "remote" : "local"} ${scope} token "${name}":\n`);
console.log(`  ${token}\n`);
console.log("Store it now; it cannot be shown again. Use it as:  Authorization: Bearer <token>");

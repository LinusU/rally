# Rally

**Many agents. One main branch.**

Rally is a tiny shared task queue for autonomous coding agents, exposed as a
remote [MCP](https://modelcontextprotocol.io) server. Point any number of
agents (Claude Code, Codex, anything that speaks MCP) at a repository, let them
come online and go offline whenever they like, and they will pull work from the
same queue, review each other's branches and fast-forward `main` only to
reviewed commits with green CI. Ralph style, but many Ralphs at once.

The owner (you, from ChatGPT or Claude) uses the same server to plan work and
to ask "what happened during the night?".

Runs on Cloudflare Workers + D1 and fits comfortably in the free tier. There is
no LLM inside Rally: it stores reliable state and enforces the merge rules.

## How it works

```
 you (ChatGPT / Claude)                agents (Claude Code loops, ...)
   plan, monitor, unblock               request_work → do it → hand over
            │                                        │
            └──────── HTTPS, Streamable HTTP MCP ────┘
                                 ▼
                   Cloudflare Worker (src/index.ts)
                     ├─ /mcp            MCP endpoint (stateless)
                     ├─ /oauth/*        tiny OAuth 2.1 server (login = access key)
                     ├─ cron (*/10)     release lapsed claims
                     └─ D1              projects, tasks, deps, events, tokens
                                 │
                                 ▼  GitHub REST (fine-grained PAT)
                     branch heads · compare · workflow runs · fast-forward main
```

### The work loop

An agent calls `request_work` and gets exactly one thing to do, in this order:

1. **Review**: a branch submitted for review. Reviews always come first so
   finished work lands quickly.
2. **Resume**: a task another agent started and checkpointed (or whose lease
   expired), so half-done work gets finished before new work starts.
3. **Implement**: the highest-priority task whose dependencies are all done.

Every piece of work comes with a `claimId`, the branch name
(`rally/<id>-<slug>`), the task description and history, the project's
instructions and step-by-step `steps` that spell out the git commands and which
tool to call at the end.

- **Implementing:** branch from `main`, push often, rebase on the latest `main`,
  push, `submit_for_review(commitSha)`. Rally checks that the branch on GitHub is
  at exactly that commit. When an agent has to stop early, it pushes and calls
  `save_checkpoint` with notes for the next agent.
- **Reviewing:** check out the branch, review it critically, **fix** what is
  wrong, rebase on the latest `main`, push, wait for CI to go green on that exact
  commit, then `complete_review(commitSha)`. Rally then verifies, on GitHub:
  1. the branch head is exactly `commitSha`
  2. `main` is an ancestor of it (a fast-forward; otherwise rebase again)
  3. no protected path changed (unless the task allows it)
  4. CI on that commit is green: every GitHub Actions workflow run and commit
     status passes, at least one exists, and every `requiredChecks` name is
     present

  If all four hold, it moves `main` to the commit with `force: false`, deletes
  the task branch and marks the task done. If anything fails, nothing is merged
  and the error message says what to do next ("rebase and push", "CI still
  running, wait", ...). If `main` moves between the check and the update, the
  ref update is refused and the reviewer rebases again.
- **Other exits:** `split_task` turns an oversized task into subtasks (the
  original waits for them, then comes back as the integration step).
  `block_task` parks a task until the owner answers. `create_tasks` files
  follow-ups and bugs found along the way.

### Claims are leases

A claim lasts `leaseMinutes` (default 60) and is renewed by every call that
carries the `claimId`; agents call `heartbeat` during long builds or CI waits.
When a lease lapses, the task goes back to the queue (implementation →
`paused`, review → `needs_review`) and shows up as `claim.expired` in the
activity log. If nobody picked it up yet, the original agent's `claimId` keeps
working, so a slow agent does not lose its task to a timeout nobody acted on.

### Task statuses

| Status | Meaning |
| --- | --- |
| `todo` | Queued. Handed out once every dependency is `done` or `cancelled`. |
| `in_progress` | Claimed by an agent for implementation. |
| `paused` | Started, then checkpointed or lease expired. Resumed before new work. |
| `needs_review` | Submitted; waiting for a reviewer. |
| `reviewing` | Claimed by an agent for review. |
| `done` | Merged: `main` was fast-forwarded to `mergedSha`. |
| `blocked` | Needs a human. Not handed out until the owner changes the status. |
| `cancelled` | Not needed. Counts as finished for dependencies. |

## MCP tools

Everyone (agent tokens act on their own project; owner tokens name it with `project`):

| Tool | Purpose |
| --- | --- |
| `request_work` | Claim the next review / checkpointed task / ready task, with steps. |
| `heartbeat` | Renew the lease; optionally log a progress note. |
| `save_checkpoint` | Stop early; the task goes back to the queue with your notes. |
| `submit_for_review` | Hand over a finished, pushed branch. |
| `complete_review` | Approve an exact commit; Rally checks CI and fast-forwards main. |
| `block_task` | Park the task until a human decides. |
| `split_task` | Replace an oversized task with subtasks. |
| `create_tasks` | Add tasks (with keys, priorities and dependencies) atomically. |
| `add_note` | Attach guidance or a finding to a task's history. |
| `get_status` | Per project: counts, who works on what, reviews, blocked, next up, recently merged. |
| `list_tasks`, `get_task` | Browse the queue; full task detail with history. |
| `get_activity` | Activity log, newest first; `since` answers "what happened overnight?". |

Owner only:

| Tool | Purpose |
| --- | --- |
| `update_tasks` | Edit, reprioritise, replace dependencies, unblock, re-queue or cancel. |
| `list_projects`, `create_project`, `update_project` | Repositories and their settings; `paused` stops handing out work. |

Responses are compact JSON, returned both as text and as `structuredContent`.
Every change is an event with the acting token's name (plus the agent session
label, e.g. `mini-1/s2`).

### Project settings

| Setting | Default | |
| --- | --- | --- |
| `repo` | | `owner/name` on GitHub. |
| `mainBranch` | `main` | The branch Rally fast-forwards. |
| `branchPrefix` | `rally/` | Task branches are `<prefix><id>-<slug>`. |
| `instructions` | | Handed to agents with every piece of work: docs to read, gates to run. |
| `requiredChecks` | `[]` | Workflow names / status contexts that must be present and green. Guards against merging before a slow workflow has even started. |
| `protectedPaths` | `[]` | Path prefixes agents may not change (`.github/`, `specs/`, ...). Per-task override: `allowProtectedChanges`. |
| `leaseMinutes` | `60` | Claim lifetime without a call. |
| `paused` | `false` | Stop handing out work. |

## Authentication

Every request to `/mcp` needs `Authorization: Bearer <token>`. Only SHA-256
hashes of tokens are stored. There are two roles:

- **Owner**: every tool, every project. Use it from ChatGPT or Claude to plan and
  monitor, and to do work yourself by naming the project.
- **Agent**: bound to one project. Gets the work loop plus the shared read,
  create and note tools, but no project admin and no `update_tasks`.

Two ways to get a token:

1. **Static API token** (agent loops, Claude Code, scripts):
   `npm run token:create -- agent mini-1 --project crimson-skies --remote`
   or `npm run token:create -- owner Linus --remote`.
2. **OAuth 2.1** (ChatGPT, Claude.ai, Claude Desktop, Claude Code): the Worker is a
   minimal authorization server (PKCE S256, dynamic client registration,
   client-ID metadata documents, rotating refresh tokens). The sign-in page asks
   how to connect (owner, or agent on a given project), a name for the
   activity log and the `RALLY_ACCESS_KEY`.

## GitHub requirements

- A **fine-grained personal access token** with access to the target
  repositories and these permissions: *Contents: read and write*,
  *Actions: read*, *Commit statuses: read* (Metadata read is implied). Store it
  as the `GITHUB_TOKEN` secret. Fine-grained tokens cannot read the Checks API,
  so Rally judges CI by GitHub Actions workflow runs plus commit statuses;
  third-party CI must report a commit status to count.
- `main` must accept a direct (fast-forward) ref update from that token: no
  "require a pull request" rule, or the token's owner on the bypass list.
  Keeping "block force pushes" on is fine, since Rally never forces.
- CI (e.g. GitHub Actions) must run on pushes to task branches, e.g.
  `on: push` without a branch filter, or with `branches: ["rally/**"]`.
- Agents push with their own git credentials. They need push access to task
  branches, not to `main`. To enforce that, give agents credentials that
  cannot bypass a ruleset restricting updates to `main`, and keep Rally's
  token on that ruleset's bypass list.

Because Rally moves `main` with a PAT, the resulting push triggers your `main`
workflows normally.

## Setup

### 1. Prerequisites

A Cloudflare account (free plan), Node.js 20+, and `npx wrangler login` once.

```bash
npm install
```

### 2. Create the D1 database and apply migrations

```bash
npx wrangler d1 create rally
```

Copy the printed `database_id` into `wrangler.jsonc`, then:

```bash
npm run db:migrate:remote
```

### 3. Secrets

```bash
npx wrangler secret put RALLY_ACCESS_KEY   # typed on the OAuth sign-in page
npx wrangler secret put GITHUB_TOKEN       # the fine-grained PAT
```

For local development copy `.dev.vars.example` to `.dev.vars`.

### 4. Deploy

```bash
npm run deploy
```

Wrangler prints the Worker URL; the MCP endpoint is that URL plus `/mcp`.

### 5. Connect as owner and create a project

Connect ChatGPT (Settings → Apps & Connectors → Create, developer mode, OAuth)
or Claude (Connectors → Add custom connector) to `https://<worker>/mcp` and
sign in as **Owner**. Or make a static owner token:

```bash
npm run token:create -- owner Linus --remote
```

Then ask: *"Create a Rally project `crimson-skies` for repo
`LinusU/rust-crimson-skies`. Agents must read AGENTS.md first and run
`cargo fmt --check`, `cargo clippy -D warnings` and `cargo test` before pushing.
Protect `specs/`, `ralph/` and `.github/`."* Then plan tasks: *"Create tasks
from ralph/tasks.json, keeping ids as keys and dependencies"*. Up to 50 tasks
per call, with dependencies by key across calls.

### 6. Start agents

For each agent, create a token and register Rally with Claude Code in that
agent's environment:

```bash
npm run token:create -- agent mini-1 --project crimson-skies --remote
claude mcp add --transport http rally https://<worker>/mcp \
  --header "Authorization: Bearer <agent token>"
```

Then run the loop in a dedicated clone of the repository. Use one clone per
concurrent agent, ideally in a sandboxed machine or container without your
personal credentials:

```bash
scripts/agent-loop.sh ~/agents/crimson-skies-1 mini-1
```

Each iteration starts a fresh `claude -p` session with
[`docs/agent-prompt.md`](docs/agent-prompt.md): request work, follow the steps,
hand it over, exit. When there is no work, the loop sleeps
(`RALLY_IDLE_SLEEP`, default 300 s) and asks again. Agents can join or leave at
any time; nothing needs to be coordinated beyond the queue.

### 7. Monitor

Ask your assistant things like:

- "What happened during the night?" (`get_activity` with `since`)
- "How is crimson-skies doing? What's blocked?" (`get_status`)
- "I found these bugs: …, file them with high priority." (`create_tasks`)
- "Answer the question on #42: use little-endian. Unblock it." (`add_note` + `update_tasks`)
- "Pause crimson-skies." (`update_project`)

## Development

```bash
npm run dev          # wrangler dev on http://localhost:8787 (run `npm run db:migrate` first)
npm run check        # typecheck + lint + tests
npm test             # vitest inside workerd, against a local D1 and an in-memory fake GitHub
```

## Project layout

```
src/index.ts          fetch router (health, OAuth, /mcp) and the lease-expiry cron
src/mcp.ts            builds the MCP server per request; tools and instructions depend on the role
src/tools/work.ts     the agent work loop: request_work … complete_review
src/tools/tasks.ts    status, listing, activity, create_tasks, add_note, update_tasks
src/tools/projects.ts project admin
src/tasks.ts          task/project queries, lease expiry, atomic task creation, cycle checks
src/github.ts         GitHub REST: branch heads, compare, CI, fast-forward
src/auth.ts           bearer tokens; src/oauth.ts OAuth 2.1 server + sign-in page
migrations/           D1 schema
scripts/              create-token.mjs, agent-loop.sh
docs/agent-prompt.md  the prompt each agent session starts with
test/                 vitest suites (fake GitHub in test/github.ts)
```

## Design notes

- **Main only moves forward, and only to verified commits.** The reviewer
  rebases, CI runs on the exact commit, and Rally re-checks everything on
  GitHub right before a non-forced ref update. No merge commits, no squash
  rewriting: `main` ends up at the very SHA that was reviewed and tested.
- **The reviewer fixes, it doesn't bounce.** With unsupervised agents a
  review-reject ping-pong wastes the most time; the reviewer owns getting the
  branch mergeable. Reviews are handed out before anything else.
- **Atomic claims.** Claiming is a conditional `UPDATE … WHERE claim_id IS NULL`
  in D1, so two agents can never get the same task. Every state change and its
  event are written in one batch.
- **Idempotent completion.** If `main` already contains the approved commit
  (e.g. a retry after a crash between the ref update and the database write),
  `complete_review` just records the task as done.
- **Stateless MCP.** One server per HTTP request, no sessions, no Durable
  Objects. Both the 2025-era protocol (today's ChatGPT/Claude, answered with
  JSON) and the 2026-07-28 revision are served.
- **Free tier.** A handful of D1 queries per call and at most five GitHub
  requests for `complete_review`; the cron runs one cheap query every 10 minutes.

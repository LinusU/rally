-- Rally initial schema. All timestamps are ISO 8601 UTC strings.

-- A codebase that agents work on. Each project is one GitHub repository with one main branch.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,
  main_branch TEXT NOT NULL DEFAULT 'main',
  branch_prefix TEXT NOT NULL DEFAULT 'rally/',
  -- Free-form guidance handed to agents with every piece of work (gates to run, docs to read, ...).
  instructions TEXT,
  -- JSON array of workflow names / status contexts that must be present and green before main moves.
  required_checks TEXT NOT NULL DEFAULT '[]',
  -- JSON array of path prefixes that agents may not change unless the task allows it.
  protected_paths TEXT NOT NULL DEFAULT '[]',
  lease_minutes INTEGER NOT NULL DEFAULT 60,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  -- Optional human key, unique per project (e.g. "F00-A"); lets plans reference each other.
  key TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN (
    'todo', 'in_progress', 'paused', 'needs_review', 'reviewing', 'done', 'blocked', 'cancelled'
  )),
  allow_protected_changes INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  -- Last commit an agent reported for the branch (checkpoint or submission).
  head_sha TEXT,
  merged_sha TEXT,
  blocked_reason TEXT,
  -- The active claim. A claim is a lease: it lapses at lease_expires_at unless renewed.
  claim_id TEXT UNIQUE,
  claim_kind TEXT CHECK (claim_kind IN ('implement', 'review')),
  claimed_by TEXT,
  claimed_at TEXT,
  lease_expires_at TEXT,
  -- Set when a lease lapses, so the agent holding it can pick the task back up if nobody else did.
  expired_claim_id TEXT,
  claim_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (project_id, key)
);
CREATE INDEX tasks_queue_idx ON tasks (project_id, status, priority DESC, id);
CREATE INDEX tasks_lease_idx ON tasks (lease_expires_at) WHERE claim_id IS NOT NULL;
CREATE INDEX tasks_expired_claim_idx ON tasks (expired_claim_id) WHERE expired_claim_id IS NOT NULL;

CREATE TABLE task_deps (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX task_deps_reverse_idx ON task_deps (depends_on);

-- Append-only activity log: everything agents and the owner do.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT
);
CREATE INDEX events_project_idx ON events (project_id, id DESC);
CREATE INDEX events_task_idx ON events (task_id, id);

-- Bearer tokens (static API tokens and OAuth access/refresh tokens). Only the hash is stored.
-- Owner tokens see every project; agent tokens are bound to exactly one.
CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('api', 'access', 'refresh')),
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  client_name TEXT,
  client_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  CHECK ((role = 'agent') = (project_id IS NOT NULL))
);

-- OAuth clients: dynamically registered (random id) or client-id metadata documents (https URL id).
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Landing queue: a review can approve a commit without landing it, and Rally lands approved
-- commits one at a time. Adds the 'approved' and 'landing' statuses (SQLite cannot change a CHECK
-- constraint, so the tasks table is rebuilt) and the per-project landing mode.

-- task_deps and events reference tasks. Dropping tasks orphans their rows; SQLite counts that as a
-- deferred violation and clears it again only when matching task rows are inserted. So: copy the
-- rows aside, drop and recreate tasks, then insert the rows back (not insert-then-rename).
PRAGMA defer_foreign_keys = true;

CREATE TABLE tasks_copy AS SELECT * FROM tasks;
DROP TABLE tasks;

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  -- Optional human key, unique per project (e.g. "F00-A"); lets plans reference each other.
  key TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN (
    'todo', 'in_progress', 'paused', 'needs_review', 'reviewing', 'approved', 'landing', 'done',
    'blocked', 'cancelled'
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
  -- The reviewed commit (CI green) waiting to land, and who approved it when.
  approved_sha TEXT,
  approved_by TEXT,
  approved_at TEXT,
  -- The current landing attempt: when it started and the rebased commit the lander pushed.
  landing_started_at TEXT,
  landing_sha TEXT,
  landing_attempts INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (project_id, key)
);

INSERT INTO tasks (
  id, project_id, key, title, description, priority, status, allow_protected_changes, branch,
  head_sha, merged_sha, blocked_reason, claim_id, claim_kind, claimed_by, claimed_at,
  lease_expires_at, expired_claim_id, claim_count, created_by, created_at, updated_at, done_at
)
SELECT
  id, project_id, key, title, description, priority, status, allow_protected_changes, branch,
  head_sha, merged_sha, blocked_reason, claim_id, claim_kind, claimed_by, claimed_at,
  lease_expires_at, expired_claim_id, claim_count, created_by, created_at, updated_at, done_at
FROM tasks_copy;

DROP TABLE tasks_copy;

CREATE INDEX tasks_queue_idx ON tasks (project_id, status, priority DESC, id);
CREATE INDEX tasks_lease_idx ON tasks (lease_expires_at) WHERE claim_id IS NOT NULL;
CREATE INDEX tasks_expired_claim_idx ON tasks (expired_claim_id) WHERE expired_claim_id IS NOT NULL;
-- The landing lock: at most one task per project is landing at any time.
CREATE UNIQUE INDEX tasks_one_landing_idx ON tasks (project_id) WHERE status = 'landing';

-- 'ff': complete_review fast-forwards main or refuses (the original behaviour).
-- 'queue': complete_review approves; Rally lands approved commits one at a time.
ALTER TABLE projects ADD COLUMN landing_mode TEXT NOT NULL DEFAULT 'ff'
  CHECK (landing_mode IN ('ff', 'queue'));

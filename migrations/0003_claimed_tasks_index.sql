-- The claimed tasks of a project. Lease expiry and "does this agent still hold a claim?" both filter
-- on project_id and claim_id IS NOT NULL; without this index SQLite takes tasks_queue_idx and reads
-- every task the project ever had, while only a handful are claimed at any time.
CREATE INDEX tasks_claimed_idx ON tasks (project_id) WHERE claim_id IS NOT NULL;

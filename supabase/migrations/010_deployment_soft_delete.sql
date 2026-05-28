-- Migration 010: Soft-Delete Tombstone for Deployments
--
-- Adds a deleted_at tombstone column so that DELETE operations archive the record
-- instead of hard-deleting it.  Records are excluded from default queries via the
-- application layer (is('deleted_at', null)).  A scheduled purge permanently removes
-- tombstoned records after the retention window (DEPLOYMENT_TOMBSTONE_RETENTION_DAYS,
-- default 30).

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Efficient filter for the common "active deployments" query pattern
CREATE INDEX IF NOT EXISTS idx_deployments_user_active
    ON deployments(user_id, deleted_at)
    WHERE deleted_at IS NULL;

-- Efficient purge scan: find all tombstoned records older than the cutoff
CREATE INDEX IF NOT EXISTS idx_deployments_deleted_at
    ON deployments(deleted_at)
    WHERE deleted_at IS NOT NULL;

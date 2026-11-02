-- Source-only proposal: additive isolated D1 migration, never auto-run.
-- Requires independent release approval, backup and isolated rehearsal.
CREATE TABLE IF NOT EXISTS station_presence_vault (
 owner_sub TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision > 0),
 envelope TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 last_operation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS station_presence_vault_audit (
 owner_sub TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 content_sha256 TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_sub,operation_id),
 UNIQUE(owner_sub,revision)
);
CREATE INDEX IF NOT EXISTS station_presence_vault_audit_owner_time ON station_presence_vault_audit(owner_sub,created_at);

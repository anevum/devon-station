-- V1.0 additive, owner-scoped private state. Existing push tables stay untouched.
CREATE TABLE IF NOT EXISTS station_documents (
 owner_sub TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK (revision > 0),
 schema_version INTEGER NOT NULL DEFAULT 1,
 payload TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 last_operation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS station_write_audit (
 owner_sub TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 action TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_sub,operation_id),
 UNIQUE(owner_sub,revision)
);
CREATE INDEX IF NOT EXISTS station_audit_owner_time ON station_write_audit(owner_sub,created_at);
-- Optional read-only cache of specifically allowlisted Notion project metadata.
-- Cache is replace-only after an entire successful upstream fetch.
CREATE TABLE IF NOT EXISTS station_portfolio_cache (
 owner_sub TEXT PRIMARY KEY,
 source_id TEXT NOT NULL,
 fetch_time INTEGER NOT NULL,
 payload TEXT NOT NULL
);

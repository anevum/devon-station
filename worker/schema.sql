CREATE TABLE IF NOT EXISTS push_devices (
 owner_sub TEXT NOT NULL,
 device_id TEXT NOT NULL,
 endpoint_hash TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 last_sent_at INTEGER,
 active INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(owner_sub,device_id),
 UNIQUE(owner_sub,endpoint_hash)
);
CREATE TABLE IF NOT EXISTS push_delivery_log (
 id TEXT PRIMARY KEY,
 owner_sub TEXT NOT NULL,
 device_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 status TEXT NOT NULL,
 service_status INTEGER,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_log_owner_time ON push_delivery_log(owner_sub,created_at);

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

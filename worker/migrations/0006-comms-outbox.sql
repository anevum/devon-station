-- Candidate dedicated MAIL_DB migration. Source only; no production execution.
CREATE TABLE IF NOT EXISTS comms_outbox (
 installation_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, owner_sub TEXT NOT NULL,
 delivery_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 state TEXT NOT NULL CHECK(state IN ('queued','claimed','accepted','rejected','failed','uncertain')),
 claim_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,mailbox_id,owner_sub,delivery_id)
);

-- DS011-COMMS-12: dedicated MAIL_DB draft-store candidate. DO NOT APPLY TO PRODUCTION.
-- Requires separately approved schema migration, backup/restore and plaintext-data retention policy.
CREATE TABLE IF NOT EXISTS comms_mail_drafts (
 installation_id TEXT NOT NULL,
 mailbox_id TEXT NOT NULL,
 owner_sub TEXT NOT NULL,
 draft_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000000),
 recipients_json TEXT NOT NULL CHECK(json_valid(recipients_json)),
 subject TEXT NOT NULL CHECK(length(subject)<=512),
 body_text TEXT NOT NULL CHECK(length(body_text)<=32768),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 last_operation TEXT NOT NULL,
 PRIMARY KEY(installation_id,mailbox_id,owner_sub,draft_id)
);
CREATE INDEX IF NOT EXISTS comms_mail_drafts_owner_order
 ON comms_mail_drafts(installation_id,mailbox_id,owner_sub,updated_at DESC);

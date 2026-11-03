-- DS011-COMMS-06 source-only migration candidate. DO NOT APPLY TO PRODUCTION.
-- Intentionally preserves the COMMS-05 disposable SQLite table contract.
CREATE TABLE IF NOT EXISTS comms_ro_mailboxes (
 installation_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 last_operation TEXT,
 uid_validity INTEGER, highest_uid INTEGER,
 PRIMARY KEY(installation_id, mailbox_id),
 CHECK((uid_validity IS NULL AND highest_uid IS NULL) OR (uid_validity > 0 AND highest_uid >= 0))
);
CREATE TABLE IF NOT EXISTS comms_ro_messages (
 installation_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
 uid_validity INTEGER NOT NULL CHECK(uid_validity > 0),
 uid INTEGER NOT NULL CHECK(uid > 0),
 from_address TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
 received_at TEXT NOT NULL, flags_json TEXT NOT NULL CHECK(json_valid(flags_json)),
 PRIMARY KEY(installation_id, mailbox_id, uid_validity, uid),
 FOREIGN KEY(installation_id, mailbox_id) REFERENCES comms_ro_mailboxes(installation_id, mailbox_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS comms_ro_message_order ON comms_ro_messages(installation_id, mailbox_id, received_at DESC);

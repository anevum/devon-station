-- DS011-COMMS-39: encrypted provider-independent Sent history.
-- SOURCE ONLY. Requires separate approval for applying any D1 migration.
-- Prerequisites: 0005 through 0008 and a verified backup/restore.
-- Captures the existing AES-GCM outbox ciphertext; no plaintext message
-- contents or server keys are stored in the archive.
CREATE TABLE IF NOT EXISTS comms_sent_archive (
 installation_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, owner_sub TEXT NOT NULL,
 delivery_id TEXT NOT NULL, draft_id TEXT NOT NULL,
 draft_revision INTEGER NOT NULL CHECK(draft_revision BETWEEN 1 AND 1000000000),
 payload_json TEXT NOT NULL CHECK(
  json_valid(payload_json) AND json_extract(payload_json,'$.v')=1 AND
  json_extract(payload_json,'$.alg')='A256GCM'
 ),
 accepted_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,mailbox_id,owner_sub,delivery_id)
);
-- Keep owner-scoped keyset paging efficient as the archive grows.
CREATE INDEX IF NOT EXISTS comms_sent_archive_owner_time
 ON comms_sent_archive(installation_id,mailbox_id,owner_sub,accepted_at DESC,delivery_id DESC);
-- SQLite triggers are atomic with the UPDATE that marks SMTP acceptance.
-- If archival fails, the receipt cannot silently become accepted. Never
-- retry SMTP after that failure: it may already have delivered.
CREATE TRIGGER IF NOT EXISTS comms_archive_accepted_outbox
 AFTER UPDATE OF state ON comms_outbox
 WHEN OLD.state='claimed' AND NEW.state='accepted'
  AND NEW.draft_id IS NOT NULL AND NEW.draft_revision IS NOT NULL
 BEGIN
  INSERT INTO comms_sent_archive
   (installation_id,mailbox_id,owner_sub,delivery_id,draft_id,draft_revision,payload_json,accepted_at)
  VALUES
   (NEW.installation_id,NEW.mailbox_id,NEW.owner_sub,NEW.delivery_id,
    NEW.draft_id,NEW.draft_revision,NEW.payload_json,NEW.updated_at);
 END;
-- Backfill only preexisting encrypted accepted linked deliveries. Skip old
-- scrubbed payloads and unlinked/uncertain/failed/rejected rows. Reapplying
-- is idempotent, preserving the original accepted snapshot.
INSERT OR IGNORE INTO comms_sent_archive
 (installation_id,mailbox_id,owner_sub,delivery_id,draft_id,draft_revision,payload_json,accepted_at)
 SELECT installation_id,mailbox_id,owner_sub,delivery_id,draft_id,draft_revision,payload_json,updated_at
 FROM comms_outbox
 WHERE state='accepted' AND draft_id IS NOT NULL AND draft_revision IS NOT NULL
  AND payload_json!='null' AND json_valid(payload_json)
  AND json_extract(payload_json,'$.v')=1
  AND json_extract(payload_json,'$.alg')='A256GCM';
-- Reject ordinary application UPDATE/DELETE, preserving an append-only Sent
-- history. Administrators able to DROP these triggers can still destroy data;
-- this is a defense against accidental/application mutations, not WORM storage.
-- Deliberate future key re-encryption needs a separate reviewed migration.
CREATE TRIGGER IF NOT EXISTS comms_sent_archive_immutable_update
 BEFORE UPDATE ON comms_sent_archive
 BEGIN
  SELECT RAISE(ABORT,'sent_archive_immutable');
 END;
CREATE TRIGGER IF NOT EXISTS comms_sent_archive_immutable_delete
 BEFORE DELETE ON comms_sent_archive
 BEGIN
  SELECT RAISE(ABORT,'sent_archive_immutable');
 END;

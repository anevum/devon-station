-- DS011-COMMS-18 candidate migration for the dedicated, isolated MAIL_DB.
-- Apply ONCE only after the COMMS-05/06 and 0006 migrations, in an approved test database.
-- DO NOT APPLY TO PRODUCTION. Preserve all existing outbox rows, including claimed and uncertain.
-- Older entries remain unlinked and cannot be retrospectively marked as Sent.
ALTER TABLE comms_outbox ADD COLUMN draft_id TEXT;
ALTER TABLE comms_outbox ADD COLUMN draft_revision INTEGER
 CHECK (draft_revision IS NULL OR (draft_revision BETWEEN 1 AND 1000000000));
-- SQLite unique indices allow the null draft fields on historical rows.
-- All newly prepared saved-draft deliveries are unique by signed owner and exact revision.
CREATE UNIQUE INDEX IF NOT EXISTS comms_outbox_saved_draft_revision
 ON comms_outbox(installation_id,mailbox_id,owner_sub,draft_id,draft_revision)
 WHERE draft_id IS NOT NULL AND draft_revision IS NOT NULL;

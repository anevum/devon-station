-- DS011-COMMS-19. Candidate-only additive safety migration; DO NOT APPLY TO PRODUCTION.
-- Requires previously approved 0005/0006/0007 dedicated MAIL_DB schemas and backed-up restore test.
-- Preserve all existing rows; unlinked historical records have NULL draft_id and are unaffected.
-- One source draft must never create a second delivery, even after editing/reopening
-- the draft or after browser restart. Intentional new mail uses a fresh draft UUID.
-- If duplicate linked draft IDs already exist, fail migration closed and reconcile first.
CREATE UNIQUE INDEX IF NOT EXISTS comms_outbox_saved_draft_once
 ON comms_outbox(installation_id,mailbox_id,owner_sub,draft_id)
 WHERE draft_id IS NOT NULL;

-- DS011-RB02-01B: source-only, additive and strictly nonclinical.
-- Requires 0004-newsroom-p1a.sql and a separately authorized synthetic D1.
-- No existing journal, legacy or patient/client tables are modified.
CREATE TABLE IF NOT EXISTS nr_thread_messages (
 org_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 revision_id TEXT NOT NULL,
 block_id TEXT NOT NULL,
 author_sub TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
 body_text TEXT NOT NULL CHECK(length(body_text) BETWEEN 1 AND 1600),
 created_at INTEGER NOT NULL CHECK(created_at>0),
 PRIMARY KEY(org_id,message_id),
 UNIQUE(org_id,author_sub,operation_id),
 FOREIGN KEY(org_id,revision_id,block_id) REFERENCES nr_revision_blocks(org_id,revision_id,block_id),
 FOREIGN KEY(org_id,author_sub) REFERENCES nr_memberships(org_id,subject)
);
CREATE INDEX IF NOT EXISTS nr_thread_anchor_time ON nr_thread_messages(org_id,revision_id,block_id,created_at,message_id);
-- A revoked or read-only subject must not be able to append even if membership
-- changed after the HTTP layer's permission check.
CREATE TRIGGER IF NOT EXISTS nr_thread_active_writer BEFORE INSERT ON nr_thread_messages
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM nr_memberships
   WHERE org_id=NEW.org_id AND subject=NEW.author_sub AND active=1
    AND role IN ('commenter','publisher','owner')
 ) THEN RAISE(ABORT,'newsroom_comment_not_authorized') END;
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM nr_revision_blocks b
  JOIN nr_revisions r ON r.org_id=b.org_id AND r.revision_id=b.revision_id
  JOIN nr_editions e ON e.org_id=r.org_id AND e.edition_id=r.edition_id
  WHERE b.org_id=NEW.org_id AND b.revision_id=NEW.revision_id AND b.block_id=NEW.block_id
   AND e.lifecycle='published'
 ) THEN RAISE(ABORT,'newsroom_anchor_not_published') END;
END;
CREATE TRIGGER IF NOT EXISTS nr_thread_message_no_update BEFORE UPDATE ON nr_thread_messages
BEGIN SELECT RAISE(ABORT,'newsroom_message_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nr_thread_message_no_delete BEFORE DELETE ON nr_thread_messages
BEGIN SELECT RAISE(ABORT,'newsroom_message_immutable'); END;

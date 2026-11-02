-- DS011-RB02-01A: source-only, additive, nonclinical Newsroom contract.
-- NEVER run against an existing Cloudflare D1 without a separate reviewed approval.
-- Existing RB01 owner-state, journal, push, and cache tables are unaffected.
CREATE TABLE IF NOT EXISTS nr_organizations (
 org_id TEXT PRIMARY KEY NOT NULL,
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 100),
 classification TEXT NOT NULL DEFAULT 'nonclinical' CHECK(classification='nonclinical')
);
CREATE TABLE IF NOT EXISTS nr_memberships (
 org_id TEXT NOT NULL,
 subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 128),
 role TEXT NOT NULL CHECK(role IN ('reader','commenter','publisher','owner')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(org_id,subject),
 FOREIGN KEY(org_id) REFERENCES nr_organizations(org_id)
);
CREATE TABLE IF NOT EXISTS nr_editions (
 org_id TEXT NOT NULL,
 edition_id TEXT NOT NULL,
 slug TEXT NOT NULL CHECK(length(slug) BETWEEN 1 AND 90),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK(lifecycle IN ('draft','published','withdrawn')),
 current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version>=0),
 created_by TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(org_id,edition_id),
 UNIQUE(org_id,slug),
 FOREIGN KEY(org_id,created_by) REFERENCES nr_memberships(org_id,subject)
);
CREATE TABLE IF NOT EXISTS nr_drafts (
 org_id TEXT NOT NULL,
 edition_id TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>=1),
 last_published_generation INTEGER NOT NULL DEFAULT 0 CHECK(last_published_generation>=0),
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 updated_by TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(org_id,edition_id),
 FOREIGN KEY(org_id,edition_id) REFERENCES nr_editions(org_id,edition_id),
 FOREIGN KEY(org_id,updated_by) REFERENCES nr_memberships(org_id,subject)
);
CREATE TABLE IF NOT EXISTS nr_revisions (
 org_id TEXT NOT NULL,
 revision_id TEXT NOT NULL,
 edition_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=1),
 source_generation INTEGER NOT NULL CHECK(source_generation>=1),
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 published_by TEXT NOT NULL,
 published_at INTEGER NOT NULL,
 PRIMARY KEY(org_id,revision_id),
 UNIQUE(org_id,edition_id,version),
 UNIQUE(org_id,edition_id,source_generation),
 FOREIGN KEY(org_id,edition_id) REFERENCES nr_editions(org_id,edition_id),
 FOREIGN KEY(org_id,published_by) REFERENCES nr_memberships(org_id,subject)
);
CREATE INDEX IF NOT EXISTS nr_revision_latest ON nr_revisions(org_id,edition_id,version DESC);
CREATE TABLE IF NOT EXISTS nr_revision_blocks (
 org_id TEXT NOT NULL,
 revision_id TEXT NOT NULL,
 block_id TEXT NOT NULL,
 article_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 block_kind TEXT NOT NULL CHECK(block_kind IN ('heading','paragraph','figure')),
 body_text TEXT NOT NULL,
 source_uri TEXT,
 PRIMARY KEY(org_id,revision_id,block_id),
 UNIQUE(org_id,revision_id,article_id,ordinal),
 FOREIGN KEY(org_id,revision_id) REFERENCES nr_revisions(org_id,revision_id)
);
CREATE TABLE IF NOT EXISTS nr_operations (
 org_id TEXT NOT NULL,
 actor_sub TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action='publish'),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 result_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(org_id,actor_sub,operation_id),
 FOREIGN KEY(org_id,actor_sub) REFERENCES nr_memberships(org_id,subject)
);
CREATE TABLE IF NOT EXISTS nr_audit_events (
 org_id TEXT NOT NULL,
 audit_id TEXT NOT NULL,
 actor_sub TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('draft_create','draft_update','publish','correct','export')),
 resource_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(org_id,audit_id),
 FOREIGN KEY(org_id) REFERENCES nr_organizations(org_id)
);
-- A stale generation, a concurrent publication, or an already-published draft
-- must abort the whole D1.batch transaction before any revision can be added.
CREATE TRIGGER IF NOT EXISTS nr_revision_preflight BEFORE INSERT ON nr_revisions
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM nr_drafts d JOIN nr_editions e
   ON e.org_id=d.org_id AND e.edition_id=d.edition_id
  WHERE d.org_id=NEW.org_id AND d.edition_id=NEW.edition_id
   AND d.generation=NEW.source_generation
   AND d.last_published_generation<NEW.source_generation
   AND e.current_version=NEW.version-1
 ) THEN RAISE(ABORT,'newsroom_publish_conflict') END;
END;
CREATE TRIGGER IF NOT EXISTS nr_revision_no_update BEFORE UPDATE ON nr_revisions BEGIN SELECT RAISE(ABORT,'newsroom_revision_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nr_revision_no_delete BEFORE DELETE ON nr_revisions BEGIN SELECT RAISE(ABORT,'newsroom_revision_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nr_block_no_update BEFORE UPDATE ON nr_revision_blocks BEGIN SELECT RAISE(ABORT,'newsroom_block_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nr_block_no_delete BEFORE DELETE ON nr_revision_blocks BEGIN SELECT RAISE(ABORT,'newsroom_block_immutable'); END;

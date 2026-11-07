-- Review/apply separately to the existing private station DB. Never run in HTTP handlers.
-- Only fixed project IDs and lifecycle metadata are plaintext; private payload is AES-GCM.
CREATE TABLE ai_work_jobs (
 owner_sub TEXT NOT NULL,
 job_id TEXT NOT NULL,
 project_slug TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 state TEXT NOT NULL CHECK(state IN ('review','ready','rejected','cancelled')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY(owner_sub,job_id)
);
CREATE INDEX ai_work_jobs_owner_recent ON ai_work_jobs(owner_sub,created_at DESC,job_id DESC);

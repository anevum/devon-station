-- Source-only. Apply separately after 0010 to the existing private station DB.
CREATE TABLE ai_work_executions (
 owner_sub TEXT NOT NULL,
 job_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 phase TEXT NOT NULL CHECK(phase IN ('authorized','submitting','running','waiting','unverified','cancel_requested','cancelled','completed','failed','blocked')),
 updated_at INTEGER NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY(owner_sub,job_id)
);

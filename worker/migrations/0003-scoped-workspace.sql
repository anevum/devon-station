-- Apply only to an independently authorized isolated target before release.
-- Existing documents, push subscriptions and portfolio cache remain untouched.
CREATE TABLE IF NOT EXISTS station_workspace_state (
  owner_sub TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('personal','business','creative')),
  scope_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  snapshot TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  PRIMARY KEY(owner_sub, scope_kind, scope_id)
);

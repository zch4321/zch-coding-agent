CREATE TABLE project_runtime_roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL UNIQUE,
  workspace TEXT NOT NULL,
  layout_version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE project_artifact_sequences (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  next_id INTEGER NOT NULL CHECK (next_id > 0 AND next_id <= 9007199254740991),
  PRIMARY KEY (project_id, kind)
) STRICT;

CREATE TABLE project_artifacts (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id INTEGER NOT NULL CHECK (id > 0 AND id <= 9007199254740991),
  owner_session_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'complete', 'failed', 'interrupted', 'expired')),
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  capture_error TEXT,
  PRIMARY KEY (project_id, kind, id),
  UNIQUE (project_id, kind, owner_session_id, source_key)
) STRICT;

CREATE INDEX project_artifacts_expiry ON project_artifacts(status, finalized_at);

CREATE TABLE project_artifact_legacy_paths (
  project_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  old_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
  relative_path TEXT NOT NULL,
  PRIMARY KEY (project_id, old_path)
) STRICT;

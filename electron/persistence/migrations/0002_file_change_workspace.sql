DROP INDEX file_changes_session_idx;
DROP INDEX file_changes_retention_idx;

ALTER TABLE file_changes RENAME TO file_changes_legacy;

CREATE TABLE file_changes (
  schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL CHECK (
    length(assistant_message_id) BETWEEN 1 AND 128
  ),
  call_id         TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 128),
  workspace_path  TEXT NOT NULL CHECK (length(workspace_path) BETWEEN 1 AND 4096),
  path            TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  operation       TEXT NOT NULL CHECK (operation IN ('write', 'patch', 'delete')),
  diff            TEXT NOT NULL CHECK (length(diff) <= 262144),
  diff_hash       TEXT NOT NULL CHECK (
    length(diff_hash) = 64 AND diff_hash NOT GLOB '*[^a-f0-9]*'
  ),
  diff_truncated  INTEGER NOT NULL CHECK (diff_truncated IN (0, 1)),
  before_exists   INTEGER NOT NULL CHECK (before_exists IN (0, 1)),
  before_hash     TEXT NOT NULL CHECK (
    length(before_hash) = 64 AND before_hash NOT GLOB '*[^a-f0-9]*'
  ),
  before_content  TEXT,
  before_mode     INTEGER CHECK (
    before_mode IS NULL OR before_mode BETWEEN 0 AND 511
  ),
  after_exists    INTEGER NOT NULL CHECK (after_exists IN (0, 1)),
  after_hash      TEXT NOT NULL CHECK (
    length(after_hash) = 64 AND after_hash NOT GLOB '*[^a-f0-9]*'
  ),
  payload_bytes   INTEGER NOT NULL CHECK (payload_bytes >= 0),
  revision        INTEGER NOT NULL CHECK (revision >= 1),
  created_at      TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at      TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  reverted_at     TEXT CHECK (reverted_at IS NULL OR length(reverted_at) BETWEEN 1 AND 64),
  UNIQUE (session_id, assistant_message_id, call_id, path),
  CHECK (
    (before_exists = 0 AND before_content IS NULL)
    OR (before_exists = 1 AND before_content IS NOT NULL)
  ),
  CHECK (
    (before_exists = 0 AND before_mode IS NULL)
    OR (before_exists = 1 AND before_mode IS NOT NULL)
  ),
  CHECK (
    before_exists = 1
    OR before_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ),
  CHECK (
    after_exists = 1
    OR after_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  )
) STRICT;

INSERT INTO file_changes (
  schema_version, id, session_id, assistant_message_id, call_id,
  workspace_path, path, operation, diff, diff_hash, diff_truncated,
  before_exists, before_hash, before_content, before_mode, after_exists,
  after_hash, payload_bytes, revision, created_at, updated_at, reverted_at
)
SELECT
  changes.schema_version,
  changes.id,
  changes.session_id,
  changes.assistant_message_id,
  changes.call_id,
  projects.path,
  changes.path,
  changes.operation,
  changes.diff,
  changes.diff_hash,
  changes.diff_truncated,
  changes.before_exists,
  changes.before_hash,
  changes.before_content,
  changes.before_mode,
  changes.after_exists,
  changes.after_hash,
  changes.payload_bytes,
  changes.revision,
  changes.created_at,
  changes.updated_at,
  changes.reverted_at
FROM file_changes_legacy AS changes
JOIN sessions ON sessions.id = changes.session_id
JOIN projects ON projects.id = sessions.project_id;

DROP TABLE file_changes_legacy;

CREATE INDEX file_changes_session_idx
  ON file_changes(session_id, created_at DESC, id DESC);

CREATE INDEX file_changes_retention_idx
  ON file_changes(created_at ASC, id ASC);

CREATE TABLE subagent_executions (
  schema_version       INTEGER NOT NULL CHECK (schema_version = 1),
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  parent_session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_run_id        TEXT NOT NULL CHECK (length(parent_run_id) BETWEEN 1 AND 128),
  parent_call_id       TEXT NOT NULL CHECK (length(parent_call_id) BETWEEN 1 AND 128),
  spec_hash            TEXT NOT NULL CHECK (length(spec_hash) = 64),
  status               TEXT NOT NULL CHECK (
    status IN (
      'preparing', 'running', 'completed', 'failed', 'cancelled',
      'timed_out', 'interrupted'
    )
  ),
  route_json           TEXT NOT NULL CHECK (json_valid(route_json)),
  source_identity_json TEXT CHECK (
    source_identity_json IS NULL OR json_valid(source_identity_json)
  ),
  usage_json           TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  result_json          TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code           TEXT CHECK (
    error_code IS NULL OR length(error_code) BETWEEN 1 AND 128
  ),
  error_message        TEXT CHECK (
    error_message IS NULL OR length(error_message) BETWEEN 1 AND 65536
  ),
  created_at           TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at           TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  completed_at         TEXT CHECK (
    completed_at IS NULL OR length(completed_at) BETWEEN 1 AND 64
  ),
  UNIQUE (parent_session_id, parent_run_id, parent_call_id)
) STRICT;

CREATE TABLE subagent_sessions (
  schema_version    INTEGER NOT NULL CHECK (schema_version = 1),
  session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  execution_id      TEXT NOT NULL UNIQUE
    REFERENCES subagent_executions(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64)
) STRICT;

CREATE INDEX subagent_executions_parent_idx
  ON subagent_executions(parent_session_id, created_at DESC);

CREATE INDEX subagent_sessions_parent_idx
  ON subagent_sessions(parent_session_id, session_id);

CREATE TRIGGER sessions_delete_subagent_children
BEFORE DELETE ON sessions
BEGIN
  DELETE FROM sessions
  WHERE id IN (
    SELECT session_id
    FROM subagent_sessions
    WHERE parent_session_id = OLD.id
  );
END;

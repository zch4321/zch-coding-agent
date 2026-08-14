DROP TRIGGER sessions_delete_subagent_children;

ALTER TABLE subagent_sessions RENAME TO subagent_sessions_v1;
ALTER TABLE subagent_executions RENAME TO subagent_executions_v1;

CREATE TABLE subagent_executions (
  schema_version       INTEGER NOT NULL CHECK (schema_version = 2),
  id                   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  kind                 TEXT NOT NULL CHECK (kind IN ('subagent', 'swarm')),
  parent_execution_id  TEXT REFERENCES subagent_executions(id) ON DELETE CASCADE,
  child_ordinal        INTEGER CHECK (
    child_ordinal IS NULL OR child_ordinal BETWEEN 0 AND 31
  ),
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  parent_session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_run_id        TEXT NOT NULL CHECK (length(parent_run_id) BETWEEN 1 AND 128),
  parent_call_id       TEXT NOT NULL CHECK (length(parent_call_id) BETWEEN 1 AND 128),
  spec_hash            TEXT NOT NULL CHECK (length(spec_hash) = 64),
  status               TEXT NOT NULL CHECK (
    status IN (
      'queued', 'preparing', 'running', 'completed', 'partial', 'failed',
      'cancelled', 'timed_out', 'interrupted'
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
  CHECK (
    (parent_execution_id IS NULL AND child_ordinal IS NULL) OR
    (parent_execution_id IS NOT NULL AND child_ordinal IS NOT NULL)
  ),
  CHECK (kind = 'subagent' OR parent_execution_id IS NULL)
) STRICT;

INSERT INTO subagent_executions (
  schema_version, id, kind, parent_execution_id, child_ordinal, name,
  parent_session_id, parent_run_id, parent_call_id, spec_hash, status,
  route_json, source_identity_json, usage_json, result_json, error_code,
  error_message, created_at, updated_at, completed_at
)
SELECT
  2, id, 'subagent', NULL, NULL, 'Subagent', parent_session_id, parent_run_id,
  parent_call_id, spec_hash, status, route_json, source_identity_json,
  usage_json, result_json, error_code, error_message, created_at, updated_at,
  completed_at
FROM subagent_executions_v1;

CREATE TABLE subagent_sessions (
  schema_version    INTEGER NOT NULL CHECK (schema_version = 1),
  session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  execution_id      TEXT NOT NULL UNIQUE
    REFERENCES subagent_executions(id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64)
) STRICT;

INSERT INTO subagent_sessions (
  schema_version, session_id, execution_id, parent_session_id, created_at
)
SELECT schema_version, session_id, execution_id, parent_session_id, created_at
FROM subagent_sessions_v1;

DROP TABLE subagent_sessions_v1;
DROP TABLE subagent_executions_v1;

CREATE UNIQUE INDEX subagent_executions_root_call_idx
  ON subagent_executions(parent_session_id, parent_run_id, parent_call_id)
  WHERE parent_execution_id IS NULL;

CREATE UNIQUE INDEX subagent_executions_child_ordinal_idx
  ON subagent_executions(parent_execution_id, child_ordinal)
  WHERE parent_execution_id IS NOT NULL;

CREATE INDEX subagent_executions_parent_idx
  ON subagent_executions(parent_session_id, created_at DESC);

CREATE INDEX subagent_executions_tree_idx
  ON subagent_executions(parent_execution_id, child_ordinal);

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

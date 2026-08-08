CREATE TABLE sessions_v6 (
  schema_version     INTEGER NOT NULL CHECK (schema_version = 1),
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  lifecycle          TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  permission_mode    TEXT NOT NULL CHECK (
    permission_mode IN ('readonly', 'auto', 'confirm', 'yolo')
  ),
  provider_id        TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  model              TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  reasoning          TEXT NOT NULL CHECK (
    reasoning IN ('off', 'low', 'medium', 'high', 'xhigh', 'max')
  ),
  goal_json          TEXT CHECK (goal_json IS NULL OR json_valid(goal_json)),
  plan_json          TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
  parent_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  forked_from_seq    INTEGER CHECK (forked_from_seq IS NULL OR forked_from_seq >= 0),
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  last_seq           INTEGER NOT NULL CHECK (last_seq >= 0),
  created_at         TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at         TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  archived_at        TEXT CHECK (archived_at IS NULL OR length(archived_at) BETWEEN 1 AND 64),
  CHECK (
    (lifecycle = 'active' AND archived_at IS NULL)
    OR (lifecycle = 'archived' AND archived_at IS NOT NULL)
  ),
  CHECK (
    (parent_session_id IS NULL AND forked_from_seq IS NULL)
    OR (parent_session_id IS NOT NULL AND forked_from_seq IS NOT NULL)
  )
) STRICT;

INSERT INTO sessions_v6 (
  schema_version, id, project_id, title, lifecycle, permission_mode,
  provider_id, model, reasoning, goal_json, plan_json,
  parent_session_id, forked_from_seq, revision, last_seq,
  created_at, updated_at, archived_at
)
SELECT
  schema_version, id, project_id, title, lifecycle, permission_mode,
  provider_id, model, reasoning, goal_json, plan_json,
  parent_session_id, forked_from_seq, revision, last_seq,
  created_at, updated_at, archived_at
FROM sessions;

DROP TABLE sessions;

ALTER TABLE sessions_v6 RENAME TO sessions;

CREATE TRIGGER sessions_clear_parent_before_delete
BEFORE DELETE ON sessions
BEGIN
  UPDATE sessions
  SET parent_session_id = NULL, forked_from_seq = NULL
  WHERE parent_session_id = OLD.id;
END;

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

CREATE INDEX sessions_project_updated_idx
  ON sessions(project_id, updated_at DESC, id DESC);

CREATE INDEX sessions_lifecycle_updated_idx
  ON sessions(lifecycle, updated_at DESC, id DESC);

CREATE INDEX sessions_parent_idx
  ON sessions(parent_session_id);

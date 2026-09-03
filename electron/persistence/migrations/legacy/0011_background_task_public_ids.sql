ALTER TABLE subagent_executions
ADD COLUMN public_id INTEGER CHECK (
  public_id IS NULL OR public_id BETWEEN 1 AND 9007199254740991
);

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY parent_session_id
      ORDER BY created_at ASC, id ASC
    ) AS public_id
  FROM subagent_executions
)
UPDATE subagent_executions
SET public_id = (
  SELECT ranked.public_id
  FROM ranked
  WHERE ranked.id = subagent_executions.id
);

CREATE UNIQUE INDEX subagent_executions_public_id_idx
  ON subagent_executions(parent_session_id, public_id);

CREATE TRIGGER subagent_executions_require_public_id
BEFORE INSERT ON subagent_executions
WHEN NEW.public_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'subagent execution public_id is required');
END;

CREATE TABLE session_background_id_sequences (
  parent_session_id TEXT PRIMARY KEY
    REFERENCES sessions(id) ON DELETE CASCADE,
  next_id           INTEGER NOT NULL CHECK (
    next_id BETWEEN 1 AND 9007199254740991
  )
) STRICT;

INSERT INTO session_background_id_sequences (parent_session_id, next_id)
SELECT parent_session_id, MAX(public_id) + 1
FROM subagent_executions
GROUP BY parent_session_id;

CREATE TABLE terminal_executions (
  schema_version    INTEGER NOT NULL CHECK (schema_version = 1),
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  public_id         INTEGER NOT NULL CHECK (
    public_id BETWEEN 1 AND 9007199254740991
  ),
  status            TEXT NOT NULL CHECK (
    status IN ('opening', 'running', 'closed', 'failed', 'interrupted')
  ),
  exit_code         INTEGER,
  cursor             INTEGER NOT NULL CHECK (cursor >= 0),
  artifact_available INTEGER NOT NULL CHECK (artifact_available IN (0, 1)),
  artifact_path     TEXT CHECK (
    artifact_path IS NULL OR length(artifact_path) BETWEEN 1 AND 8192
  ),
  capture_error     TEXT CHECK (
    capture_error IS NULL OR length(capture_error) BETWEEN 1 AND 65536
  ),
  created_at        TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at        TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  completed_at      TEXT CHECK (
    completed_at IS NULL OR length(completed_at) BETWEEN 1 AND 64
  ),
  PRIMARY KEY (parent_session_id, public_id)
) STRICT;

CREATE INDEX terminal_executions_parent_created_idx
  ON terminal_executions(parent_session_id, created_at DESC, public_id DESC);

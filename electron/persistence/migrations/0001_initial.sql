CREATE TABLE projects (
  schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE CHECK (length(path) BETWEEN 1 AND 4096),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  revision        INTEGER NOT NULL CHECK (revision >= 1),
  created_at      TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at      TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64)
) STRICT;

CREATE TABLE sessions (
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
  reasoning          TEXT NOT NULL CHECK (reasoning IN ('off', 'high', 'max')),
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

CREATE TRIGGER sessions_clear_parent_before_delete
BEFORE DELETE ON sessions
BEGIN
  UPDATE sessions
  SET parent_session_id = NULL, forked_from_seq = NULL
  WHERE parent_session_id = OLD.id;
END;

CREATE INDEX sessions_project_updated_idx
  ON sessions(project_id, updated_at DESC, id DESC);

CREATE INDEX sessions_lifecycle_updated_idx
  ON sessions(lifecycle, updated_at DESC, id DESC);

CREATE INDEX sessions_parent_idx
  ON sessions(parent_session_id);

CREATE TABLE messages (
  schema_version       INTEGER NOT NULL CHECK (schema_version = 1),
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq                  INTEGER NOT NULL CHECK (seq >= 1),
  client_request_id    TEXT CHECK (
    client_request_id IS NULL
    OR length(client_request_id) BETWEEN 1 AND 128
  ),
  replayed_from_message_id TEXT,
  derived_from_message_id TEXT,
  kind                 TEXT NOT NULL CHECK (
    kind IN (
      'user_input',
      'assistant_turn',
      'tool_result',
      'system_instruction',
      'assistant_preferences',
      'selected_context',
      'benchmark_context',
      'runtime_context',
      'agents_context',
      'orchestrator',
      'interjection',
      'compact_summary'
    )
  ),
  parts_json           TEXT NOT NULL CHECK (
    json_valid(parts_json)
    AND json_type(parts_json) = 'array'
    AND json_array_length(parts_json) > 0
  ),
  normalized_reasoning_text  TEXT,
  provider_continuation_json TEXT CHECK (
    provider_continuation_json IS NULL
    OR json_valid(provider_continuation_json)
  ),
  model_route_json     TEXT CHECK (
    model_route_json IS NULL OR json_valid(model_route_json)
  ),
  metadata_json        TEXT CHECK (
    metadata_json IS NULL OR json_valid(metadata_json)
  ),
  in_history           INTEGER NOT NULL CHECK (in_history IN (0, 1)),
  created_at           TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  FOREIGN KEY (replayed_from_message_id, session_id)
    REFERENCES messages(id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (derived_from_message_id, session_id)
    REFERENCES messages(id, session_id) ON DELETE CASCADE,
  UNIQUE (id, session_id),
  UNIQUE (session_id, seq),
  UNIQUE (session_id, client_request_id),
  CHECK (
    (
      kind = 'user_input'
      AND (
        (
          client_request_id IS NOT NULL
          AND replayed_from_message_id IS NULL
          AND derived_from_message_id IS NULL
        )
        OR
        (
          client_request_id IS NULL
          AND replayed_from_message_id IS NOT NULL
          AND derived_from_message_id IS NULL
        )
        OR
        (
          client_request_id IS NULL
          AND replayed_from_message_id IS NULL
          AND derived_from_message_id IS NOT NULL
        )
      )
    )
    OR (
      kind <> 'user_input'
      AND client_request_id IS NULL
      AND replayed_from_message_id IS NULL
      AND derived_from_message_id IS NULL
    )
  ),
  CHECK (
    (kind = 'assistant_turn' AND model_route_json IS NOT NULL)
    OR (kind <> 'assistant_turn' AND model_route_json IS NULL)
  ),
  CHECK (
    kind = 'assistant_turn'
    OR (
      normalized_reasoning_text IS NULL
      AND provider_continuation_json IS NULL
    )
  )
) STRICT;

CREATE INDEX messages_history_idx
  ON messages(session_id, in_history, seq);

CREATE INDEX messages_replayed_from_idx
  ON messages(replayed_from_message_id, session_id);

CREATE INDEX messages_derived_from_idx
  ON messages(derived_from_message_id, session_id);

CREATE TABLE file_changes (
  schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL CHECK (
    length(assistant_message_id) BETWEEN 1 AND 128
  ),
  call_id         TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 128),
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

CREATE INDEX file_changes_session_idx
  ON file_changes(session_id, created_at DESC, id DESC);

CREATE INDEX file_changes_retention_idx
  ON file_changes(created_at ASC, id ASC);

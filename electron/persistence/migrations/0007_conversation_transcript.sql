CREATE TABLE messages_v7 (
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
      'compact_summary',
      'conversation_transcript'
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
  visibility           TEXT NOT NULL CHECK (
    visibility IN ('visible', 'hidden', 'superseded')
  ),
  turn_id              TEXT,
  in_history           INTEGER NOT NULL CHECK (in_history IN (0, 1)),
  created_at           TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  FOREIGN KEY (replayed_from_message_id, session_id)
    REFERENCES messages_v7(id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (derived_from_message_id, session_id)
    REFERENCES messages_v7(id, session_id) ON DELETE CASCADE,
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
    (kind IN ('assistant_turn', 'conversation_transcript') AND model_route_json IS NOT NULL)
    OR kind = 'compact_summary'
    OR (kind NOT IN ('assistant_turn', 'compact_summary', 'conversation_transcript') AND model_route_json IS NULL)
  ),
  CHECK (
    kind = 'assistant_turn'
    OR (
      normalized_reasoning_text IS NULL
      AND provider_continuation_json IS NULL
    )
  ),
  CHECK (
    visibility <> 'superseded' OR in_history = 0
  )
) STRICT;

INSERT INTO messages_v7 (
  schema_version, id, session_id, seq, client_request_id,
  replayed_from_message_id, derived_from_message_id, kind, parts_json,
  normalized_reasoning_text, provider_continuation_json, model_route_json,
  metadata_json, visibility, turn_id, in_history, created_at
)
SELECT
  schema_version, id, session_id, seq, client_request_id,
  replayed_from_message_id, derived_from_message_id, kind, parts_json,
  normalized_reasoning_text, provider_continuation_json, model_route_json,
  metadata_json, visibility, turn_id, in_history, created_at
FROM messages;

DROP TABLE messages;

ALTER TABLE messages_v7 RENAME TO messages;

CREATE INDEX messages_history_idx
  ON messages(session_id, visibility, in_history, seq);

CREATE INDEX messages_turn_idx
  ON messages(session_id, turn_id, seq);

CREATE INDEX messages_replayed_from_idx
  ON messages(replayed_from_message_id, session_id);

CREATE INDEX messages_derived_from_idx
  ON messages(derived_from_message_id, session_id);

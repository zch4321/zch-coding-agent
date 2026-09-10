CREATE TABLE session_usage_calls (
  ordinal INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('main', 'subagent', 'approval', 'compression', 'title')),
  purpose TEXT NOT NULL CHECK (purpose IN ('main', 'approval', 'compression', 'title')),
  execution_id TEXT,
  task_name TEXT,
  provider_id TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER CHECK (completion_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens >= 0),
  cache_hit_tokens INTEGER CHECK (cache_hit_tokens >= 0),
  cache_miss_tokens INTEGER CHECK (cache_miss_tokens >= 0),
  context_window_tokens INTEGER NOT NULL CHECK (context_window_tokens > 0),
  context_window_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_session_id, call_id)
) STRICT;

CREATE INDEX session_usage_calls_run_idx ON session_usage_calls(session_id, run_id, scope);

CREATE TABLE session_context_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  history_revision INTEGER NOT NULL,
  snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
  recipe_json TEXT CHECK (recipe_json IS NULL OR json_valid(recipe_json))
) STRICT;

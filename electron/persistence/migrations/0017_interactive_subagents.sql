ALTER TABLE sessions ADD COLUMN owner_session_id TEXT
  REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE sessions ADD COLUMN agent_metadata_json TEXT
  CHECK (agent_metadata_json IS NULL OR json_valid(agent_metadata_json));

ALTER TABLE subagent_executions ADD COLUMN child_session_id TEXT
  REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE subagent_executions ADD COLUMN child_run_id TEXT
  CHECK (child_run_id IS NULL OR length(child_run_id) BETWEEN 1 AND 128);

UPDATE sessions
SET owner_session_id = (SELECT parent_session_id FROM subagent_sessions WHERE session_id = sessions.id),
    agent_metadata_json = (
      SELECT json_object('initialExecutionId', execution_id)
      FROM subagent_sessions WHERE session_id = sessions.id
    )
WHERE id IN (SELECT session_id FROM subagent_sessions);

UPDATE subagent_executions
SET child_session_id = (SELECT session_id FROM subagent_sessions WHERE execution_id = subagent_executions.id);

DROP TRIGGER sessions_delete_subagent_children;
DROP TABLE subagent_sessions;

CREATE INDEX sessions_owner_idx ON sessions(owner_session_id, id);
CREATE INDEX subagent_executions_session_idx
  ON subagent_executions(child_session_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX subagent_executions_run_idx
  ON subagent_executions(child_session_id, child_run_id)
  WHERE child_run_id IS NOT NULL;

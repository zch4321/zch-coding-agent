CREATE INDEX subagent_executions_active_leaf_idx
  ON subagent_executions(parent_session_id, status, kind)
  WHERE kind = 'subagent' AND status IN ('queued', 'preparing', 'running');

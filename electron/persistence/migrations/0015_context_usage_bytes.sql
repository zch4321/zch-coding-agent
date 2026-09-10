-- Context summaries are derived caches. Token estimates cannot recover exact bytes.
-- Keep call accounting and the latest public Run selection intact.
UPDATE session_context_snapshots
SET snapshot_json = NULL, recipe_json = NULL, history_revision = 0;

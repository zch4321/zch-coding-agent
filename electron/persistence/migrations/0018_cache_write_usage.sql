ALTER TABLE session_usage_calls
ADD COLUMN cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0);

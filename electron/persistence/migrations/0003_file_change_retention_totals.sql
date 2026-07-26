CREATE TABLE file_change_retention_state (
  singleton           INTEGER PRIMARY KEY CHECK (singleton = 1),
  total_payload_bytes INTEGER NOT NULL CHECK (total_payload_bytes >= 0)
) STRICT;

INSERT INTO file_change_retention_state (singleton, total_payload_bytes)
SELECT 1, COALESCE(SUM(payload_bytes), 0)
FROM file_changes;

CREATE TRIGGER file_changes_retention_insert
AFTER INSERT ON file_changes
BEGIN
  UPDATE file_change_retention_state
  SET total_payload_bytes = total_payload_bytes + NEW.payload_bytes
  WHERE singleton = 1;
END;

CREATE TRIGGER file_changes_retention_delete
AFTER DELETE ON file_changes
BEGIN
  UPDATE file_change_retention_state
  SET total_payload_bytes = total_payload_bytes - OLD.payload_bytes
  WHERE singleton = 1;
END;

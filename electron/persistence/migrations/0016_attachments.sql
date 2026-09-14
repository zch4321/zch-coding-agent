CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  status TEXT NOT NULL CHECK (status IN ('ready', 'deleting')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX attachments_project ON attachments(project_id);

CREATE TABLE message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (message_id, attachment_id),
  UNIQUE (message_id, position)
) STRICT;
CREATE INDEX message_attachments_asset ON message_attachments(attachment_id);

CREATE TABLE attachment_drafts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  draft_key TEXT NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, draft_key, attachment_id)
) STRICT;
CREATE INDEX attachment_drafts_asset ON attachment_drafts(attachment_id);

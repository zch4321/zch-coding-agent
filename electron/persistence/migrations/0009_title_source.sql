ALTER TABLE sessions
  ADD COLUMN title_source TEXT NOT NULL DEFAULT 'user'
  CHECK (title_source IN ('auto', 'user', 'model'));

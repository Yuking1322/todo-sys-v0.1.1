CREATE TABLE IF NOT EXISTS app_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT app_state_single_row CHECK (id = TRUE)
);

INSERT INTO app_state (id, sync_version)
VALUES (TRUE, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE,
  title VARCHAR(120) NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL CHECK (status IN ('todo', 'done')),
  source TEXT NOT NULL DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ NULL,
  version BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_version ON tasks (version);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks (deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

CREATE TABLE IF NOT EXISTS day_notes (
  date_key DATE PRIMARY KEY,
  content VARCHAR(500) NOT NULL
);

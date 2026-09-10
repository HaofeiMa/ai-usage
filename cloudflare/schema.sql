CREATE TABLE buckets (
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  project TEXT NOT NULL,
  hostname TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, model, project, hostname, bucket_start)
);
CREATE INDEX idx_buckets_start ON buckets(bucket_start);
CREATE INDEX idx_buckets_updated ON buckets(updated_at);

CREATE TABLE sessions (
  source TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  hostname TEXT NOT NULL,
  project TEXT,
  first_message_at TEXT,
  last_message_at TEXT,
  duration_seconds INTEGER,
  active_seconds INTEGER,
  message_count INTEGER,
  user_message_count INTEGER,
  user_prompt_hours TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, session_hash, hostname)
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at);

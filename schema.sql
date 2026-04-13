CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT UNIQUE NOT NULL,
  repo TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_location TEXT,
  http_status INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  total_count INTEGER DEFAULT 1,
  window_count INTEGER DEFAULT 0,
  release_versions TEXT DEFAULT '[]',
  github_issue_number INTEGER,
  github_issue_state TEXT,
  last_commented_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  errors_found INTEGER DEFAULT 0,
  issues_created INTEGER DEFAULT 0,
  issues_commented INTEGER DEFAULT 0,
  issues_reopened INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  log TEXT
);

CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON errors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_errors_repo ON errors(repo);
CREATE INDEX IF NOT EXISTS idx_errors_issue_state ON errors(github_issue_state);

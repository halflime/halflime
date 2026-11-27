CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('app','website')),
  key_hash TEXT NOT NULL UNIQUE,
  origins TEXT NOT NULL DEFAULT '[]',
  properties TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  project_id TEXT NOT NULL REFERENCES projects(id),
  event_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  event_name TEXT NOT NULL,
  system_props TEXT NOT NULL,
  props TEXT NOT NULL,
  path TEXT,
  referrer TEXT,
  PRIMARY KEY(project_id, event_id)
) WITHOUT ROWID;
CREATE INDEX events_project_time ON events(project_id, timestamp);

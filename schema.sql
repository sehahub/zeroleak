CREATE TABLE IF NOT EXISTS subscribers (
  email      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Aggregate counts only: no cookie, no IP, no visitor identifier of any kind.
CREATE TABLE IF NOT EXISTS hits (
  day  TEXT NOT NULL,
  path TEXT NOT NULL,
  ref  TEXT NOT NULL,
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, ref)
);

-- Three tallies, so the funnel from visit to scan to clean is visible. The
-- event name is checked against a fixed list in the Worker, so this table can
-- only ever hold those names and a count. Nothing about a document reaches it.
CREATE TABLE IF NOT EXISTS events (
  day  TEXT NOT NULL,
  name TEXT NOT NULL,
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);

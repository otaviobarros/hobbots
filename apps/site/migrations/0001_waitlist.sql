-- One row per wait-list sign-up. The email is stored trimmed and lowercased, once.
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  wants_more_platforms INTEGER NOT NULL DEFAULT 0 CHECK (wants_more_platforms IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('hero', 'roll')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

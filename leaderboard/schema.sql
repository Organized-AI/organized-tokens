-- Organized Tokens — workshop leaderboard
-- D1. Aggregates only: no transcript content, no file paths, no project names.

CREATE TABLE IF NOT EXISTS workshops (
  id          TEXT PRIMARY KEY,           -- slug, e.g. aiic-2026-07
  code        TEXT UNIQUE NOT NULL,       -- join code attendees type
  name        TEXT NOT NULL,
  started_at  INTEGER NOT NULL,           -- unix seconds; nothing before this counts
  ends_at     INTEGER,                    -- optional hard stop
  open        INTEGER NOT NULL DEFAULT 1  -- 0 closes joins and pushes
);

CREATE TABLE IF NOT EXISTS attendees (
  token_hash  TEXT PRIMARY KEY,           -- SHA-256 of the bearer token; the token itself is never stored
  workshop_id TEXT NOT NULL,
  handle      TEXT NOT NULL,
  joined_at   INTEGER NOT NULL,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendee_handle ON attendees(workshop_id, handle);

CREATE TABLE IF NOT EXISTS stats (
  token_hash  TEXT PRIMARY KEY,
  workshop_id TEXT NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  turns       INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0, -- USD * 1e6, integer to dodge float drift
  by_model    TEXT NOT NULL DEFAULT '{}', -- {"claude-opus-5":{"turns":N,"cost_micros":N}}
  pushes      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (token_hash) REFERENCES attendees(token_hash)
);
CREATE INDEX IF NOT EXISTS idx_stats_workshop ON stats(workshop_id, updated_at);

-- Candidate-consented account creation. No passwords or email addresses are stored.
CREATE TABLE IF NOT EXISTS candidate_registrations (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','created','rejected','unknown')),
  niceboard_id TEXT,
  consent_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_rate_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

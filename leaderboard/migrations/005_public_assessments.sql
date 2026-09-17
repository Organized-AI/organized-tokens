-- Explicit owner consent only. Management tokens are stored as hashes.
CREATE TABLE IF NOT EXISTS public_assessments (
 id TEXT PRIMARY KEY,
 manage_hash TEXT NOT NULL,
 profile_hash TEXT NOT NULL,
 profile TEXT,
 revoked_at INTEGER,
 consent_version TEXT NOT NULL,
 created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public_assessment_rate_limits (
 bucket TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);

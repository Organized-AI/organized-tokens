-- Organized Proof — talent-directory consent.
-- Recorded per snapshot at submit time: 'public' lists the profile on
-- board.organizedai.vip/talent and the owner's /@handle page; 'private' keeps
-- it cohort-only. Never updated in place — the LATEST snapshot's visibility
-- wins, so re-submitting privately unlists a profile.
ALTER TABLE assessments ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
CREATE INDEX IF NOT EXISTS idx_assess_latest_public ON assessments(handle, snapshot_seq, visibility);

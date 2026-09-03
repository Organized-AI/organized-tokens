-- Organized Proof — assessment intake.
-- Append-only ledger. Never UPDATE; only DELETE on the participant's own request.
-- Longitudinal accumulation is the anti-gaming signal, so history is kept.

CREATE TABLE IF NOT EXISTS assessments (
  id           TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  workshop_id  TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assess_seq  ON assessments(handle, workshop_id, snapshot_seq);
CREATE INDEX        IF NOT EXISTS idx_assess_time ON assessments(handle, created_at);

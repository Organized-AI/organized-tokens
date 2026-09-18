/** D1 batches are transactional: a failed deletion preserves the credential for retry. */
export async function removeAttendeeData(
  db: D1Database,
  owner: { handle: string; workshop_id: string; token_hash: string },
) {
  await db.batch([
    db.prepare(`DELETE FROM assessments WHERE handle = ? AND workshop_id = ?`)
      .bind(owner.handle, owner.workshop_id),
    db.prepare(`DELETE FROM stats WHERE token_hash = ?`).bind(owner.token_hash),
    db.prepare(`DELETE FROM attendees WHERE token_hash = ?`).bind(owner.token_hash),
  ]);
}

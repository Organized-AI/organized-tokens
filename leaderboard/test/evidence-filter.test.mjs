import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBundle, consolidateBundles, nativeSessionDigest, projectFingerprint } from 'ai-work-assessment/evidence-bundle';
import { filterBundle, filterDirectory } from '../public/filter-bundles.mjs';

function fixture() {
  return {
    bundle_schema_version: 1, collector_prompt_version: 8,
    environment: { id: 'abcdef0123456789abcdef01', kind: 'computer' },
    collected_at: '2026-09-17T12:00:00Z',
    source_coverage: ['claude', 'codex'].map(source => ({ source, from: '2026-09-01', to: '2026-09-16', coverage_days: 16, sessions: 1, retention: 'retention-limited', limitations: ['Only recent retained sessions were sampled.'] })),
    session_evidence: ['claude', 'codex'].map(source => ({ source, native_session_digest: nativeSessionDigest(source, 'synthetic-' + source), project_fingerprint: projectFingerprint('synthetic-project'), first_event: '2026-09-15T12:00:00Z', last_event: '2026-09-15T13:00:00Z', evidence_quality: 'partial-transcript', event_count: 4, observations: { purpose: source === 'claude' ? 'Omitted family project' : 'Selected family project' }, limitations: ['Outcome was not observed.'] })),
    collection_limits: ['Only the most recent sessions were sampled; retained coverage is incomplete.'],
    privacy_scan: { passed: true, scanner_version: 1 },
  };
}
test('filtered bundles remain compatible with the pinned consolidator and preserve uncertainty', () => {
  const bundle = validateBundle(fixture());
  assert.deepEqual(filterBundle(bundle, ['claude', 'codex']).collection_limits, bundle.collection_limits);
  const selected = filterBundle(bundle, ['codex']);
  validateBundle(selected);
  assert.match(selected.collection_limits.join(' '), /caveats were withheld/);
  assert.deepEqual(selected.session_evidence[0].limitations, ['Outcome was not observed.']);
  const consolidated = consolidateBundles([selected]);
  assert.doesNotMatch(JSON.stringify(consolidated), /Omitted family project/);
  assert.match(JSON.stringify(consolidated), /Selected family project/);
});
test('repeated selections create separate private directories and never modify originals', t => {
  const folder = mkdtempSync(join(tmpdir(), 'synthetic-assessment-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'ai-work-evidence-abcdef01.json');
  const original = JSON.stringify(fixture()); writeFileSync(path, original);
  const first = filterDirectory(folder, ['codex']);
  const second = filterDirectory(folder, ['claude']);
  assert.notEqual(first, second);
  assert.equal(readFileSync(path, 'utf8'), original);
  const selectedPath = join(first, 'ai-work-evidence-abcdef01.json');
  const selected = JSON.parse(readFileSync(selectedPath));
  assert.deepEqual(selected.session_evidence.map(s => s.source), ['codex']);
  assert.equal(statSync(selectedPath).mode & 0o777, 0o600);
  assert.equal(statSync(first).mode & 0o777, 0o700);
});

import {
  parseProfileData, assertNoSecrets, assertNoLocalEvidenceLeaks,
  validateRawProfileV9, sanitizeProfile, validateProfileV9,
} from './validate-profile.js';

export function validateReport(text) {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('The report is larger than 2 MB.');
  const profile = parseProfileData(text);
  const serialized = JSON.stringify(profile);
  assertNoSecrets(serialized);
  assertNoLocalEvidenceLeaks(serialized);
  if (profile?.schema_version !== 9 || profile?.prompt_version !== 8) {
    throw new Error('Use the current Assessment v8 prompt to create a schema v9 report.');
  }
  validateRawProfileV9(profile);
  sanitizeProfile(profile);
  validateProfileV9(profile);
  return profile;
}

if (typeof document !== 'undefined') {
  const file = document.querySelector('#report-file');
  const reviewed = document.querySelector('#report-reviewed');
  const result = document.querySelector('#report-result');
  const next = document.querySelector('#continue-resume');
  let valid = false;
  let selection = 0;
  const update = () => { next.disabled = !(valid && reviewed.checked); };
  reviewed.addEventListener('change', update);
  file.addEventListener('change', async () => {
    const version = ++selection;
    valid = false;
    reviewed.checked = false;
    update();
    result.textContent = '';
    const report = file.files?.[0];
    if (!report) return;
    try {
      if (report.size > 2 * 1024 * 1024) throw new Error('The report is larger than 2 MB.');
      const text = await report.text();
      if (version !== selection) return;
      validateReport(text);
      valid = true;
      result.textContent = 'The report passes the Assessment v8 structure and privacy checks. This checks the file, not the accuracy of its claims. Nothing was uploaded.';
      result.className = 'msg ok';
    } catch (error) {
      if (version !== selection) return;
      result.textContent = 'Report not ready: ' + (error.message || 'Validation failed. Ask your coding agent to repair and re-render it.');
      result.className = 'msg err';
    }
    update();
  });
  next.addEventListener('click', () => {
    if (valid && reviewed.checked) window.location.assign('https://jobs.organizedai.vip/seeker/signup');
  });
}

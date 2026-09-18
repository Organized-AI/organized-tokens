// Regenerate vendored code, fixtures and a clearly synthetic example from the pinned dependency.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure } from 'ai-work-assessment/config';
import { renderProfileDocument } from 'ai-work-assessment/render';
import { validateRawProfileV9, validateProfileV9 } from 'ai-work-assessment';

const upstream = new URL('../', import.meta.resolve('ai-work-assessment'));
const root = new URL('../', import.meta.url);
const fixture = readFileSync(new URL('fixtures/profile-v9.sample.json', upstream), 'utf8');
const profile = JSON.parse(fixture);
validateRawProfileV9(profile);
validateProfileV9(profile);
configure({ siteName: 'Organized AI · Synthetic example', siteUrl: 'https://assessment.organizedai.vip/', accentColor: '#F2C000', cohortComparison: false });
const banner = '<aside style="padding:20px;text-align:center;background:#F2C000;color:#171717;font:16px/1.6 system-ui"><strong>SYNTHETIC EXAMPLE</strong> — This fictional fixture demonstrates the report format. It is not a candidate assessment. <a style="color:inherit" href="/">Create your work profile →</a></aside>';
const example = renderProfileDocument(profile).replace(/<body([^>]*)>/, `<body$1>${banner}`).replace(/[ \t]+$/gm, '');
const files = new Map([
  ['src/validate.js', readFileSync(new URL('src/validate.js', upstream))],
  ['public/validate-profile.js', readFileSync(new URL('src/validate.js', upstream))],
  ['test/fixtures/profile-v9.sample.json', fixture],
  ['THIRD_PARTY/ai-work-assessment-LICENSE', readFileSync(new URL('LICENSE', upstream))],
  ['public/example.html', example],
]);
let failed = false;
for (const [relative, content] of files) {
  const file = fileURLToPath(new URL(relative, root));
  if (process.argv.includes('--check')) {
    let actual; try { actual = readFileSync(file); } catch { actual = Buffer.alloc(0); }
    if (!actual.equals(Buffer.from(content))) { console.error(`Out of date: ${relative}`); failed = true; }
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`Generated ${relative}`);
  }
}
if (failed) process.exitCode = 1;

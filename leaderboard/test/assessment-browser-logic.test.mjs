import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {configuredPrompt} from '../public/prompt-config.js';
import {validateReport} from '../public/assessment-flow.js';
import {filterBundle} from '../public/filter-bundles.mjs';

const base=readFileSync(new URL('../node_modules/ai-work-assessment/prompt.md',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/example.html',import.meta.url),'utf8');
test('single environment preserves pinned base and explicitly omits unselected sources',()=>{
 const output=configuredPrompt(base,['codex']);
 assert.ok(output.endsWith(base));assert.match(output,/- codex: include/);assert.match(output,/- linkedin: omit/);
});
test('multi-environment prompts have distinct collection and final instructions',()=>{
 const collect=configuredPrompt(base,['codex','linkedin'],'multi','collect');
 assert.match(collect,/collection only/);assert.match(collect,/- linkedin: omit/);assert.match(collect,/validate-bundle/);
 assert.ok(!collect.endsWith(base));
 const final=configuredPrompt(base,['codex','linkedin'],'multi','final');
 assert.match(final,/consolidate/);assert.match(final,/- linkedin: include/);assert.ok(final.endsWith(base));
});
test('empty source selections and nonlocal collection are blocked',()=>{
 assert.throws(()=>configuredPrompt(base,[]));
 assert.throws(()=>configuredPrompt(base,['github'],'multi','collect'));
});
test('omitted sources never reach the final synthesis bundle or coverage',()=>{
 const bundle={bundle_schema_version:1,source_coverage:[{source:'claude',sessions:20},{source:'codex',sessions:5}],session_evidence:[{source:'claude',observations:{text:'omitted secret work'}},{source:'codex',observations:{text:'included work'}}],collection_limits:['Claude-specific detail']};
 const filtered=filterBundle(bundle,['codex']);
 assert.deepEqual(filtered.source_coverage,[{source:'codex',sessions:5}]);
 assert.equal(filtered.session_evidence.length,1);
 assert.doesNotMatch(JSON.stringify(filtered),/omitted secret|Claude-specific/);
 assert.equal(bundle.session_evidence.length,2);
});
test('browser validation accepts the canonical rendered report',()=>{
 assert.equal(validateReport(html).schema_version,9);
});
test('browser validation rejects malformed reports, raw data, secrets, and oversized files',()=>{
 assert.throws(()=>validateReport('<html>not a report</html>'));
 assert.throws(()=>validateReport('x'.repeat(2*1024*1024+1)));
 assert.throws(()=>validateReport(html.replace('Riley Okafor','sk-proj-'+ 'X'.repeat(40)).replaceAll('Riley Okafor','sk-proj-'+ 'X'.repeat(40))));
});

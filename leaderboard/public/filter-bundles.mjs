// Local-only helper. Filter before the synthesis agent reads any bundle content.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAMILY = {claude:['claude','cowork'],codex:['codex'],other_local:['other']};
export function filterBundle(bundle, families) {
  if (!families.length || families.some(key => !Object.hasOwn(FAMILY,key))) throw new Error('Choose claude, codex, or other_local.');
  const allowed=new Set(families.flatMap(key=>FAMILY[key]));
  if (!bundle || bundle.bundle_schema_version !== 1 || !Array.isArray(bundle.session_evidence) || !Array.isArray(bundle.source_coverage)) throw new Error('Invalid evidence bundle shape.');
  const omitted = [...bundle.source_coverage, ...bundle.session_evidence].some(row => !allowed.has(row.source));
  return {
    bundle_schema_version: bundle.bundle_schema_version,
    collector_prompt_version: bundle.collector_prompt_version,
    environment: bundle.environment,
    collected_at: bundle.collected_at,
    source_coverage: bundle.source_coverage.filter(row=>allowed.has(row.source)),
    session_evidence: bundle.session_evidence.filter(row=>allowed.has(row.source)),
    collection_limits: omitted
      ? ['Only selected source families are retained. Bundle-wide caveats were withheld because they may describe omitted sources. Coverage may be incomplete; use selected per-source and per-session limits, and do not infer complete coverage. Original bundles remain unchanged.']
      : [...(bundle.collection_limits || [])],
    privacy_scan: bundle.privacy_scan,
  };
}
export function filterDirectory(directory,families) {
  const source=resolve(directory);
  const output=join(source,'selected-evidence');
  // Never mix an earlier selection into a new run. Use a fresh subdirectory.
  const destination=join(output,Date.now()+'-'+Math.random().toString(16).slice(2,10));
  const files=readdirSync(source).filter(name=>/^ai-work-evidence-[a-f0-9]{8}\.json$/i.test(name)).sort();
  if (!files.length) throw new Error('No evidence bundle files found.');
  const filtered=files.map(name=>{
    const path=join(source,name);
    if (statSync(path).size>4*1024*1024) throw new Error('An evidence bundle exceeds 4 MB.');
    return [name,filterBundle(JSON.parse(readFileSync(path,'utf8')),families)];
  });
  mkdirSync(destination,{recursive:true,mode:0o700});
  for (const [name,bundle] of filtered) writeFileSync(join(destination,name),JSON.stringify(bundle,null,2)+'\n',{mode:0o600,flag:'wx'});
  return destination;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [, , directory, families]=process.argv;
    if (!directory || !families) throw new Error('Usage: node filter-bundles.mjs <bundle-folder> <claude,codex,other_local>');
    console.log(filterDirectory(directory,families.split(',')));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}

import {httpsUrl,normalizeRole} from './core.mjs';

/** Remove tracking only; preserve identity parameters such as gh_jid. */
export function jobIdentity(value) {
  if(!httpsUrl(value))return null;
  const u=new URL(value);
  for(const k of [...u.searchParams.keys()])if(k==='ref'||k.startsWith('utm_'))u.searchParams.delete(k);
  u.hash='';
  if(u.hostname==='jobs.lever.co')u.pathname=u.pathname.replace(/\/apply\/?$/,'');
  u.pathname=u.pathname.replace(/\/$/,'');u.searchParams.sort();
  return u.href;
}

function providerIdentity(value){
  const normalized=jobIdentity(value);if(!normalized)return null;
  const u=new URL(normalized),parts=u.pathname.split('/').filter(Boolean);
  if(u.hostname==='jobs.lever.co'&&parts.length===2&&/^[a-f\d-]{36}$/i.test(parts[1]))return 'lever:'+parts.join(':');
  if(/(^|\.)greenhouse\.io$/.test(u.hostname)&&parts.length===3&&parts[1]==='jobs'&&/^\d+$/.test(parts[2]))return 'greenhouse:'+parts[0]+':'+parts[2];
  if(/^\d+$/.test(u.searchParams.get('gh_jid')??''))return 'greenhouse-custom:'+u.hostname+':'+u.searchParams.get('gh_jid');
  return null;
}
function sameListing(a,b){
  if(a.company_id!==b.company_id)return false;
  if(a.id===b.id)return true;
  const ids=new Set([providerIdentity(a.source_url),providerIdentity(a.apply_url)].filter(Boolean));
  if([providerIdentity(b.source_url),providerIdentity(b.apply_url)].some(id=>id&&ids.has(id)))return true;
  // An ordinary careers index is not a per-job identifier. Outside known ATS
  // IDs require all URL/title/location observations to agree.
  const source=jobIdentity(a.source_url),apply=jobIdentity(a.apply_url);
  if(!source||!apply||/^\/(?:careers|jobs|positions|openings)?\/?$/.test(new URL(source).pathname))return false;
  return source===jobIdentity(b.source_url)&&apply===jobIdentity(b.apply_url)&&a.title.toLowerCase()===b.title.toLowerCase()&&a.location_name===b.location_name;
}
const observed=role=>Math.max(...[role.collected_at,role.availability_checked_at].map(t=>Number.isFinite(Date.parse(t))?Date.parse(t):-Infinity));

/** Prefer fresh employer records for identical listings and retain board provenance.
 * Absence from a feed alone does not close an unrelated board listing.
 */
export function mergeRoleSources(boardRoles,employerRoles) {
  const merged=boardRoles.map(normalizeRole);
  for(const raw of employerRoles){
    const role=normalizeRole(raw);
    const index=merged.findIndex(old=>sameListing(old,role));
    if(index<0){merged.push(role);continue;}
    const old=merged[index];
    const keepOld=observed(old)>observed(role)||(observed(old)===observed(role)&&old.availability==='closed');
    const [winner,other]=keepOld?[old,role]:[role,old];
    merged[index]={...winner,alternate_sources:[...(winner.alternate_sources??[]),...(other.alternate_sources??[]),{id:other.id,url:other.source_url,apply_url:other.apply_url,collected_at:other.collected_at,source_kind:other.source_kind,availability:other.availability,availability_checked_at:other.availability_checked_at}]};
  }
  return merged;
}

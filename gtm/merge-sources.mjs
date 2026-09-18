import {httpsUrl,normalizeRole,text} from './core.mjs';

/** Remove tracking only; preserve identity parameters such as gh_jid. */
export function jobIdentity(value) {
  if(!httpsUrl(value))return null;
  const u=new URL(value);
  for(const k of [...u.searchParams.keys()])if(k==='ref'||k.startsWith('utm_'))u.searchParams.delete(k);
  u.hash='';
  if(u.hostname==='jobs.lever.co')u.pathname=u.pathname.replace(/\/apply\/?$/,'');
  if(u.hostname==='jobs.ashbyhq.com')u.pathname=u.pathname.replace(/\/application\/?$/,'');
  u.pathname=u.pathname.replace(/\/$/,'');u.searchParams.sort();
  return u.href;
}

function providerIdentity(value){
  const normalized=jobIdentity(value);if(!normalized)return null;
  const u=new URL(normalized),parts=u.pathname.split('/').filter(Boolean);
  if(u.hostname==='jobs.lever.co'&&parts.length===2&&/^[a-f\d-]{36}$/i.test(parts[1]))return 'lever:'+parts.join(':');
  if(u.hostname==='jobs.ashbyhq.com'&&parts.length===2&&/^[a-f\d-]{36}$/i.test(parts[1]))return 'ashby:'+parts.join(':');
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

/** Apply explicit cross-provider same-opening decisions when URLs cannot prove identity. */
export function reconcileRoleAliases(roles,decisions=[]) {
  let result=roles.map(normalizeRole);const claimed=new Set();
  for(const decision of decisions){
    if(decision?.status!=='reviewed-same-opening'||!Array.isArray(decision.role_ids)||decision.role_ids.length<2||!text(decision.reason)||!Array.isArray(decision.source_urls)||!decision.source_urls.length||decision.source_urls.some(url=>!httpsUrl(url)))throw new Error('Invalid role reconciliation decision');
    const ids=decision.role_ids.map(String);if(new Set(ids).size!==ids.length||ids.some(id=>claimed.has(id)))throw new Error('Overlapping role reconciliation decision');
    const locate=id=>result.findIndex(role=>String(role.id)===id||(role.alternate_sources??[]).some(source=>String(source.id)===id));
    const indexes=[...new Set(ids.map(locate))];if(indexes.includes(-1)||indexes.length<2)throw new Error('Unknown or already-merged role reconciliation identity');
    const selected=indexes.map(i=>result[i]),company=String(selected[0].company_id),title=selected[0].title.toLowerCase();
    if(selected.some(role=>String(role.company_id)!==company||role.title.toLowerCase()!==title))throw new Error('Role reconciliation company/title mismatch');
    const canonical=String(decision.canonical_id),winnerIndex=selected.findIndex(role=>String(role.id)===canonical||(role.alternate_sources??[]).some(source=>String(source.id)===canonical));
    if(winnerIndex<0)throw new Error('Unknown canonical role identity');
    const winner=selected[winnerIndex],others=selected.filter((_,i)=>i!==winnerIndex),alternate=[...(winner.alternate_sources??[])];
    for(const other of others)alternate.push(...(other.alternate_sources??[]),{id:other.id,url:other.source_url,apply_url:other.apply_url,collected_at:other.collected_at,source_kind:other.source_kind,availability:other.availability,availability_checked_at:other.availability_checked_at});
    const merged={...winner,alternate_sources:alternate,role_reconciliation:{status:decision.status,role_ids:ids,source_urls:decision.source_urls,reason:decision.reason}};
    result=result.filter((_,i)=>!indexes.includes(i));result.push(merged);ids.forEach(id=>claimed.add(id));
  }
  return result;
}

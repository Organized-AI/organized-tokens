import {createHash} from 'node:crypto';
import {httpsUrl, normalizeRole, text} from './core.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function boardToken(value) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value ?? '')) throw new Error('Invalid public ATS board token');
  return value;
}
async function jsonSource(url, fetcher) {
  const response = await fetcher(url, {headers:{Accept:'application/json','User-Agent':'OrganizedAI-GTM/1.0'}, signal:AbortSignal.timeout(20000), redirect:'error'});
  if (!response.ok) throw new Error(`Public ATS returned HTTP ${response.status}`);
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty ATS response');
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw new Error('ATS response exceeds 8 MB');}chunks.push(Buffer.from(value));}
  const body=Buffer.concat(chunks).toString('utf8');
  return {data:JSON.parse(body), source_sha256:sha(body)};
}

/** Official public feed only; no authenticated ATS records or application submission. */
export async function greenhouse({board, company_id, company_name}, fetcher=fetch, now=Date.now()) {
  const url=`https://boards-api.greenhouse.io/v1/boards/${boardToken(board)}/jobs?content=true`;
  const {data,source_sha256}=await jsonSource(url,fetcher);
  if (!Array.isArray(data.jobs) || !Number.isInteger(data.meta?.total) || data.meta.total!==data.jobs.length) throw new Error('Incomplete Greenhouse inventory');
  const at=new Date(now).toISOString();
  if(data.jobs.some(j=>!j.id||!text(j.title)||!httpsUrl(j.absolute_url)))throw new Error('Malformed Greenhouse job');
  return data.jobs.map(j=>normalizeRole({id:`greenhouse:${board}:${j.id}`,company_id,company_name,title:j.title,
    description:j.content,location:j.location?.name,source_url:j.absolute_url,apply_url:j.absolute_url,
    source_kind:'greenhouse',source_sha256,collected_at:at,availability:'employer-confirmed',
    availability_checked_at:at,availability_source_url:url}));
}

export async function lever({board, company_id, company_name}, fetcher=fetch, now=Date.now()) {
  const url=`https://api.lever.co/v0/postings/${boardToken(board)}?mode=json`;
  const {data,source_sha256}=await jsonSource(url,fetcher);
  if (!Array.isArray(data)) throw new Error('Invalid Lever inventory');
  const at=new Date(now).toISOString();
  if(data.some(j=>!j.id||!text(j.text)||!httpsUrl(j.hostedUrl)))throw new Error('Malformed Lever job');
  return data.map(j=>normalizeRole({id:`lever:${board}:${j.id}`,company_id,company_name,title:j.text,
    description:[j.descriptionPlain,...(j.lists??[]).map(l=>`${l.text} ${l.content}`),j.additionalPlain].filter(Boolean).join('\n'),
    location:j.categories?.location,source_url:j.hostedUrl,apply_url:j.applyUrl,source_kind:'lever',source_sha256,
    collected_at:at,availability:'employer-confirmed',availability_checked_at:at,availability_source_url:url}));
}

/** Normalize already-collected JobPosting JSON-LD from an employer career page.
 * This does not fetch arbitrary URLs or treat HTTP 200 as proof a job is open.
 */
export function careerJobPostings({html, source_url, company_id, company_name, collected_at}) {
  if (!httpsUrl(source_url) || !Number.isFinite(Date.parse(collected_at))) throw new Error('Career snapshot needs HTTPS source and capture time');
  const nodes=[];
  function walk(v){if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(walk);return;}
    if([v['@type']].flat().includes('JobPosting'))nodes.push(v);
    if(v['@graph'])walk(v['@graph']);}
  for(const s of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try{walk(JSON.parse(s[1]));}catch{throw new Error('Malformed career JobPosting JSON-LD');}
  }
  return nodes.map((j,i)=>{
    const url=httpsUrl(j.url)??source_url;
    return normalizeRole({id:`career:${sha(url+'|'+text(j.title)).slice(0,24)}`,company_id,company_name,title:j.title,
      description:j.description,location:text(j.jobLocation?.address?.addressLocality),source_url:url,apply_url:url,
      expires_on:j.validThrough,collected_at,source_kind:'career-jsonld',source_sha256:sha(html),availability:'unknown'});
  });
}

/** Indeed/LinkedIn/other lawful exports retain original source, capture time and unverified state. */
export function importedRoles(rows, source_kind) {
  if(!['indeed','linkedin','career-page','niceboard','other'].includes(source_kind))throw new Error('Unknown import source');
  return rows.map(r=>{
    if(!Number.isFinite(Date.parse(r.collected_at)))throw new Error('Imported roles need collected_at');
    return normalizeRole({...r,source_kind,availability:'board-listed',availability_checked_at:null,availability_source_url:null});
  });
}

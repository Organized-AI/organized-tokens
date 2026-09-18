import {createHash} from 'node:crypto';
import {plainText} from './text.mjs';

const ORIGIN='https://jobs.organizedai.vip';
const PAGE_SIZE=30;
const sha=body=>createHash('sha256').update(body).digest('hex');

function query(kind,page){
  if(!Number.isInteger(page)||page<1)throw new Error('Niceboard page must be a positive integer');
  if(kind==='companies')return `${ORIGIN}/api/companies?limit=${PAGE_SIZE}&page=${page}&keyword=&has_live_jobs=false&is_verified=false`;
  if(kind==='jobs')return `${ORIGIN}/api/jobs?limit=${PAGE_SIZE}&page=${page}&keyword=&jobtype=%5B%5D&category=%5B%5D&secondary_category=%5B%5D&tags=%5B%5D&city=%5B%5D&state=%5B%5D&country=%5B%5D&company=all&remote_ok=false&remote_only=false&salary_timeframe=&salary_min=&salary_max=&custom_fields=%7B%7D&sortby=newest`;
  throw new Error('Unknown Niceboard collection kind');
}

async function page(kind,index,fetcher){
  const url=query(kind,index);
  const response=await fetcher(url,{headers:{Accept:'application/json','User-Agent':'OrganizedAI-GTM/1.0'},signal:AbortSignal.timeout(20000),redirect:'error'});
  if(!response.ok)throw new Error(`Niceboard ${kind} page ${index} returned HTTP ${response.status}`);
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty Niceboard response');
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>8*1024*1024){await reader.cancel();throw new Error('Niceboard response exceeds 8 MB');}chunks.push(Buffer.from(value));}
  const body=Buffer.concat(chunks).toString('utf8');
  const data=JSON.parse(body),rows=data?.[kind];
  if(!Array.isArray(rows)||!Number.isInteger(data.count)||data.count<0)throw new Error(`Malformed Niceboard ${kind} page`);
  return {url,index,count:data.count,rows,sha256:sha(body),body};
}

async function allPages(kind,fetcher){
  const pages=[],rows=[];let total=null;
  for(let index=1;;index++){
    const current=await page(kind,index,fetcher);pages.push(current);
    if(total===null)total=current.count;
    if(current.count!==total)throw new Error(`Niceboard ${kind} total changed during pagination`);
    rows.push(...current.rows);
    if(rows.length>=total)break;
    if(current.rows.length!==PAGE_SIZE)throw new Error(`Incomplete Niceboard ${kind} pagination`);
  }
  if(rows.length!==total)throw new Error(`Niceboard ${kind} count mismatch`);
  const ids=rows.map(row=>String(row?.id??''));
  if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw new Error(`Missing or duplicate Niceboard ${kind} identity`);
  return {rows,pages,total};
}

function integer(value,label){const n=Number(value);if(!Number.isInteger(n)||n<0)throw new Error(`Invalid ${label}`);return n;}
function required(value,label){const s=String(value??'').trim();if(!s)throw new Error(`Missing ${label}`);return s;}

export async function niceboardInventory(fetcher=fetch,now=Date.now()){
  const collected_at=new Date(now).toISOString();
  const [companyResult,jobResult]=await Promise.all([allPages('companies',fetcher),allPages('jobs',fetcher)]);
  const roles=jobResult.rows.filter(j=>!j.anonymity_enabled).map(j=>({
    id:integer(j.id,'job id'),company_id:integer(j.company_id??j.company?.id,'job company id'),
    company_name:required(j.company_name??j.company?.name,'job company name'),title:required(j.title,'job title'),
    source_url:`${ORIGIN}/job/${integer(j.id,'job id')}-${required(j.slug,'job slug')}-${required(j.company_slug??j.company?.slug,'job company slug')}`,
    apply_url:String(j.apply_url??''),apply_email:String(j.apply_email??''),location:String(j.location_name??''),
    remote:Boolean(j.is_remote||j.remote_only),published_at:j.published_at??null,expires_on:j.expires_on??null,
    description:plainText(String(j.description_html??'')),collected_at,
  }));
  const rolesByCompany=new Map();
  for(const role of roles){const group=rolesByCompany.get(role.company_id)??[];group.push(role);rolesByCompany.set(role.company_id,group);}
  const employers=companyResult.rows.map(c=>{
    const id=integer(c.id,'company id'),companyRoles=rolesByCompany.get(id)??[];
    return {id,name:required(c.name,'company name'),slug:required(c.slug,'company slug'),website:String(c.site_url??''),
      linkedin_url:String(c.linkedin_url??''),source_url:`${ORIGIN}/company/${required(c.slug,'company slug')}`,
      directory_jobs_count:integer(c.jobs_count??0,'directory job count'),live_job_count:companyRoles.length,
      job_titles:companyRoles.map(r=>r.title),collected_at};
  });
  const employerIds=new Set(employers.map(e=>e.id));
  const unknown=roles.filter(role=>!employerIds.has(role.company_id));
  if(unknown.length)throw new Error(`Niceboard jobs reference ${unknown.length} absent companies`);
  return {source:ORIGIN,collected_at,employers,roles,excluded_anonymous_jobs:jobResult.total-roles.length,
    pages:[...companyResult.pages.map(p=>({...p,kind:'companies'})),...jobResult.pages.map(p=>({...p,kind:'jobs'}))]};
}

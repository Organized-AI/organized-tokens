/** Explainable opportunity suggestions, not a hiring decision or talent score. */
type Role = {id:number|string;title:string;company_name:string;company_slug?:string;slug?:string;location_name?:string;description_html?:string;expires_on?:string;anonymity_enabled?:boolean};
const vocabulary: [string,RegExp][] = [
 ['agent workflows',/\b(?:agent(?:ic|s)?|orchestrat\w*|multi.agent|llm|large language models?)\b/i],
 ['automation',/\bautomat\w*\b/i],
 ['data systems',/\b(?:data (?:pipeline|model|integration|engineer|platform)\w*|etl|ingestion)\b/i],
 ['APIs and integrations',/\b(?:apis?|integrations?|webhooks?)\b/i],
 ['product delivery',/\b(?:product (?:operations?|development|ownership|management)|product (?:lead|manager)|roadmap)\b/i],
 ['web applications',/\b(?:web (?:applications?|development)|frontend|front.end|full.stack|react|next\.js)\b/i],
 ['infrastructure and operations',/\b(?:infrastructure|devops|reliability|deployment|distributed systems|linux|kubernetes)\b/i],
 ['testing and quality',/\b(?:testing|quality assurance|test automation|verification|sdet)\b/i],
 ['marketing measurement',/\b(?:marketing|conversion|attribution|analytics)\b/i],
 ['media production',/\b(?:video|audio|media processing|rendering)\b/i],
];
const plain=(value:unknown)=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp);/g,' ').replace(/\s+/g,' ').trim();
export function supportedCapabilities(profile:any) {
 const arcs=new Map((profile.work_arcs||[]).map((arc:any)=>[arc.id,arc]));
 const evidence=new Map((profile.evidence_index||[]).map((item:any)=>[item.id,item]));
 return (profile.matching_index?.capabilities||[]).flatMap((cap:any)=>{
  if(!['deep','working'].includes(cap.depth))return [];
  const work=(cap.arc_ids||[]).map((id:string)=>arcs.get(id)).filter((arc:any)=>arc && ['working-prototype','deployed','live-use','ongoing-operation','merged','released'].includes(arc.delivery_state));
  const ids=(cap.evidence_ids||[]).filter((id:string)=>{const item:any=evidence.get(id);return item && ['sessions','assessment'].includes(item.source) && (item.arc_ids||[]).some((arcId:string)=>work.some((arc:any)=>arc.id===arcId));});
  if (!work.length||!ids.length) return [];
  // Capability labels and completed-work descriptions, not career titles or personal data.
  const text=[cap.tag,cap.label,...work.flatMap((a:any)=>[a.label,...(a.evidence||[])])].join(' ');
  return [{label:plain(cap.label),evidence_ids:ids,arc_ids:work.map((a:any)=>a.id),delivery_states:[...new Set(work.map((a:any)=>a.delivery_state))],topics:vocabulary.filter(([,re])=>re.test(text)).map(([name])=>name)}];
 });
}
export function candidateSummary(profile:any) {
 const caps=supportedCapabilities(profile);
 const lines=['AI work assessment — candidate-reviewed evidence, not independent certification.', ...caps.slice(0,5).map((c:any)=>`${c.label} (work evidence: ${c.evidence_ids.join(', ')})`),
  `Evidence limits: ${plain(profile.profile_view?.matching?.not_shown?.summary || 'Discuss role-specific depth, qualifications and eligibility with the candidate.')}`,
  'Ask the candidate for their full assessment report.'];
 return lines.join('\n').slice(0,2000);
}
export function matchJobs(profile:any,roles:Role[],now=Date.now()) {
 const caps=supportedCapabilities(profile);
 const seen=new Set();
 return roles.flatMap(role=>{
  if(!role.id||seen.has(String(role.id))||role.anonymity_enabled) return [];
  seen.add(String(role.id));
  if(role.expires_on && Date.parse(role.expires_on)<now) return [];
  const text=plain(role.description_html);
  const jobText=plain(role.title)+' '+text;
  const topics=vocabulary.filter(([,re])=>re.test(jobText));
  const reasons=caps.flatMap((cap:any)=>{
   const topic=topics.find(([name])=>cap.topics.includes(name));
   if(!topic)return [];
   const at=jobText.search(topic[1]);
   return [{capability:cap.label,evidence_ids:cap.evidence_ids,arc_ids:cap.arc_ids,delivery_states:cap.delivery_states,topic:topic[0],job_excerpt:jobText.slice(Math.max(0,at-75),at+180)}];
  });
  if(!reasons.length)return [];
  return [{id:String(role.id),title:plain(role.title),company:plain(role.company_name),location:plain(role.location_name),url:`https://jobs.organizedai.vip/job/${encodeURIComponent(String(role.id))}-${encodeURIComponent(role.slug||'')}-${encodeURIComponent(role.company_slug||'')}`,reasons:reasons.slice(0,3),limits:['Potential fit from overlapping work evidence; no application has been sent.','Confirm required technologies, experience, location, work authorization and compensation with the employer.',plain(profile.profile_view?.matching?.not_shown?.summary)].filter(Boolean)}];
 }).sort((a,b)=>b.reasons.length-a.reasons.length||a.title.localeCompare(b.title)).slice(0,8);
}
export async function liveRoles(fetcher:typeof fetch=fetch):Promise<Role[]> {
 const roles:Role[]=[];let expected:number|undefined;
 for(let page=1;page<=20;page++){
  const query=new URLSearchParams({limit:'30',page:String(page),keyword:'',company:'all',sortby:'newest',remote_ok:'false',remote_only:'false',jobtype:'[]',category:'[]',secondary_category:'[]',tags:'[]',city:'[]',state:'[]',country:'[]',salary_timeframe:'',salary_min:'',salary_max:'',custom_fields:'{}'});
  const response=await fetcher('https://jobs.organizedai.vip/api/jobs?'+query,{headers:{'User-Agent':'OrganizedAI-Assessment/1.0','Accept':'application/json'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Jobs unavailable');
  const data:any=await response.json();
  if(!Array.isArray(data.jobs)||!Number.isInteger(data.count))throw new Error('Invalid jobs response');
  if(expected===undefined)expected=data.count;
  if(data.count!==expected)throw new Error('Jobs changed during retrieval');
  roles.push(...data.jobs);
  if(roles.length===expected)return roles;
  if(!data.jobs.length||roles.length>(expected??0))throw new Error('Incomplete jobs response');
 }
 throw new Error('Jobs pagination limit reached');
}

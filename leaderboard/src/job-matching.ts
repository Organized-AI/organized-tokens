/** Explainable opportunity suggestions, not a hiring decision or talent score. */
type Role = {id:number|string;title:string;company_name:string;company_slug?:string;slug?:string;location_name?:string;description_html?:string;expires_on?:string;apply_url?:string;anonymity_enabled?:boolean};
const vocabulary: [string,RegExp][] = [
 ['agent workflows',/\b(?:agent(?:ic|s)?|orchestrat\w*|multi.agent|llm|large language models?)\b/i],
 ['automation',/\bautomat\w*\b/i],
 ['data systems',/\b(?:data (?:pipeline|model|integration|engineer|platform)\w*|etl|ingestion)\b/i],
 ['APIs and integrations',/\b(?:apis?|integrations?|webhooks?)\b/i],
 ['product delivery',/\b(?:product (?:operations?|development|ownership|management)|product (?:lead|manager)|roadmap)\b/i],
 ['web applications',/\b(?:web (?:applications?|development)|frontend|front.end|full.stack|react|next\.js|websites?|live site|dashboard|widget|quiz funnel)\b/i],
 ['infrastructure and operations',/\b(?:infrastructure|devops|reliability|deployment|distributed systems|linux|kubernetes)\b/i],
 ['testing and quality',/\b(?:testing|quality assurance|test automation|verification|sdet|acceptance|evaluation|qa)\b/i],
 ['marketing measurement',/\b(?:marketing|conversion|attribution|analytics)\b/i],
 ['media production',/\b(?:video|audio|media processing|rendering)\b/i],
];
const plain=(value:unknown)=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp);/g,' ').replace(/\s+/g,' ').trim();
export function supportedCapabilities(profile:any) {
 const arcs=new Map((profile.work_arcs||[]).map((arc:any)=>[arc.id,arc]));
 const evidence=new Map((profile.evidence_index||[]).map((item:any)=>[item.id,item]));
 return (profile.matching_index?.capabilities||[]).flatMap((cap:any)=>{
  if(!['deep','working'].includes(cap.depth))return [];
  const completed=(cap.arc_ids||[]).map((id:string)=>arcs.get(id)).filter((arc:any)=>arc && ['working-prototype','deployed','live-use','ongoing-operation','merged','released'].includes(arc.delivery_state));
  const cited=(cap.evidence_ids||[]).map((id:string)=>evidence.get(id)).filter((item:any)=>item && ['sessions','assessment'].includes(item.source));
  const work=completed.filter((arc:any)=>cited.some((item:any)=>(item.arc_ids||[]).includes(arc.id)));
  if(!work.length)return [];
  const supporting=(subset:any[])=>({evidence_ids:cited.filter((item:any)=>(item.arc_ids||[]).some((id:string)=>subset.some((arc:any)=>arc.id===id))).map((item:any)=>item.id),arc_ids:subset.map((a:any)=>a.id),delivery_states:[...new Set(subset.map((a:any)=>a.delivery_state))]});
  const topicEvidence:Record<string,any>={};
  for(const [name,re] of vocabulary){
   const labelMatch=re.test([cap.tag,cap.label].join(' '));
   const topicArcs=labelMatch?work:work.filter((a:any)=>re.test([a.label,String(a.primary_surface||'').replaceAll('-',' '),String(a.change_type||'').replaceAll('-',' '),...(a.evidence||[])].join(' ')));
   if(topicArcs.length)topicEvidence[name]=supporting(topicArcs);
  }
  return [{label:plain(cap.label),...supporting(work),topics:Object.keys(topicEvidence),topic_evidence:topicEvidence}];
 });
}
export function candidateSummary(profile:any) {
 const caps=supportedCapabilities(profile);
 const lines=['AI work assessment — candidate-reviewed evidence, not independent certification.', ...caps.slice(0,5).map((c:any)=>`${c.label} (work evidence: ${c.evidence_ids.join(', ')})`),
  `Evidence limits: ${plain(profile.profile_view?.matching?.not_shown?.summary || 'Discuss role-specific depth, qualifications and eligibility with the candidate.')}`,
  'Ask the candidate for their full assessment report.'];
 return lines.join('\n').slice(0,2000);
}
// Specialist roles need matching evidence in the capability itself, not incidental
// references to software in a hardware, research, sales or community description.
const specialties:[RegExp,RegExp][]=[
 [/\bcuda\b/i,/\bcuda\b/i],
 [/\b(?:compiler|kernel)\b/i,/\b(?:compiler|kernel)\b/i],
 [/\b(?:hardware|silicon|asic|rtl|chip|semiconductor)\b/i,/\b(?:hardware design|silicon|asic|rtl|chip design|semiconductor)\b/i],
 [/\b(?:research scientist|research engineer)\b/i,/\b(?:machine learning research|model research|research experiments|model training|fine.tuning)\b/i],
 [/\b(?:sales|account executive|business development|customer success)\b/i,/\b(?:sales|business development|customer success|commercial partnerships)\b/i],
 [/\b(?:community manager|developer relations|developer advocate|recruiter)\b/i,/\b(?:community|developer relations|developer advocacy|recruiting)\b/i],
];
export function matchJobs(profile:any,roles:Role[],now=Date.now()) {
 const caps=supportedCapabilities(profile);
 const capabilityLabels=caps.map((c:any)=>c.label).join(' ');
 const seen=new Set(),seenListings=new Set();
 return roles.flatMap(role=>{
  if(!role.id||seen.has(String(role.id))||role.anonymity_enabled) return [];
  if(role.expires_on && Date.parse(role.expires_on)<now) return [];
  seen.add(String(role.id));
  const title=plain(role.title);
  if(specialties.some(([roleType,evidence])=>roleType.test(title)&&!evidence.test(capabilityLabels)))return [];
  const listingKey=role.apply_url?`${plain(role.company_name).toLowerCase()}|${title.toLowerCase()}|${role.apply_url}`:null;
  const text=plain(role.description_html);
  const jobText=title+' '+text;
  // Count each overlapping area once. Several capabilities pointing at the same
  // word in a job description do not create several independent fit signals.
  const topics=vocabulary.filter(([name,re])=>re.test(jobText)&&caps.some((cap:any)=>cap.topics.includes(name)));
  const titleTopics=topics.filter(([,re])=>re.test(title));
  if(!titleTopics.length&&topics.length<2)return [];
  const ordered=[...titleTopics,...topics.filter(t=>!titleTopics.includes(t))];
  const reasons=ordered.map(([topic,re])=>{
   const cap=caps.find((c:any)=>c.topics.includes(topic)&&re.test(c.label))||caps.find((c:any)=>c.topics.includes(topic));const at=jobText.search(re);
   return {capability:cap.label,...cap.topic_evidence[topic],topic,job_excerpt:jobText.slice(Math.max(0,at-75),at+180)};
  });
  return [{id:String(role.id),title,company:plain(role.company_name),location:plain(role.location_name),url:`https://jobs.organizedai.vip/job/${encodeURIComponent(String(role.id))}-${encodeURIComponent(role.slug||'')}-${encodeURIComponent(role.company_slug||'')}`,reasons:reasons.slice(0,3),limits:['Potential fit from overlapping work evidence; no application has been sent.','Job-board listing status is not independent confirmation that the employer is still hiring.','Confirm required technologies, experience, location, work authorization and compensation with the employer.',plain(profile.profile_view?.matching?.not_shown?.summary)].filter(Boolean),listingKey,titleOverlap:titleTopics.length,topicOverlap:topics.length}];
 }).sort((a,b)=>b.titleOverlap-a.titleOverlap||b.topicOverlap-a.topicOverlap||a.title.localeCompare(b.title)).filter(m=>{if(!m.listingKey)return true;if(seenListings.has(m.listingKey))return false;seenListings.add(m.listingKey);return true;}).slice(0,8).map(({listingKey,titleOverlap,topicOverlap,...match})=>match);
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

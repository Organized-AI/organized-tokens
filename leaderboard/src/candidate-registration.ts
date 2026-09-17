import {assertNoSecrets,assertNoLocalEvidenceLeaks,validateRawProfileV9,sanitizeProfile,validateProfileV9} from './validate.js';
import {ownedPublicUrl} from './public-assessments.ts';
import {candidateSummary,liveRoles,matchJobs,supportedCapabilities} from './job-matching.ts';
interface Env {DB:D1Database;NICEBOARD_API_KEY?:string;NICEBOARD_API_BASE?:string;CANDIDATE_SIGNUP_ENABLED?:string;}
export const CONSENT_VERSION='assessment-employer-profile-2026-09-17';
const MAX_BODY=2*1024*1024;
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
function enabled(env:Env){return env.CANDIDATE_SIGNUP_ENABLED==='true'&&!!env.NICEBOARD_API_KEY&&!!env.NICEBOARD_API_BASE;}
async function boundedJson(req:Request){
 if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Error('json');
 const reader=req.body?.getReader();if(!reader)throw new Error('json');
 const chunks:Uint8Array[]=[];let size=0;
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new Error('size');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
function validate(body:any){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('request');
 const allowed=['request_id','first_name','last_name','email','password','profile','reviewed','employer_consent','terms_consent','consent_version','public_share_id','public_share_token'];
 if(Object.keys(body).some(k=>!allowed.includes(k)))throw new Error('fields');
 if(!/^[a-f0-9]{64}$/.test(body.request_id))throw new Error('request_id');
 for(const name of ['first_name','last_name'])if(typeof body[name]!=='string'||!body[name].trim()||body[name].length>100||/[<>\r\n]/.test(body[name]))throw new Error('name');
 if(typeof body.email!=='string'||body.email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))throw new Error('email');
 if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)throw new Error('password');
 if(body.reviewed!==true||body.employer_consent!==true||body.terms_consent!==true||body.consent_version!==CONSENT_VERSION)throw new Error('consent');
 const profile=body.profile;
 const serialized=JSON.stringify(profile);
 assertNoSecrets(serialized);assertNoLocalEvidenceLeaks(serialized);
 if(profile?.schema_version!==9||profile?.prompt_version!==8)throw new Error('profile');
 validateRawProfileV9(profile);sanitizeProfile(profile);validateProfileV9(profile);
 if(!supportedCapabilities(profile).length)throw new Error('delivery_evidence');
 return {...body,first_name:body.first_name.trim(),last_name:body.last_name.trim(),email:body.email.trim().toLowerCase(),profile};
}
async function completed(profile:any,fetcher:typeof fetch){
 try{return json({status:'created',login_url:'https://jobs.organizedai.vip/seeker/login',matches:matchJobs(profile,await liveRoles(fetcher)),matching_status:'ready',notice:'Your job-seeker account was created. Your assessment-derived summary is visible through the job board. No applications or outreach were sent.'},201);}
 catch{return json({status:'created',login_url:'https://jobs.organizedai.vip/seeker/login',matches:[],matching_status:'unavailable',notice:'Your account was created. Jobs could not be loaded right now; browse the job board or try matching again later. Do not create another account.'},201);}
}
const uncertain=()=>json({status:'outcome_unknown',error:'Niceboard may have created your account. To avoid a duplicate, this request will not create it again. Try signing in or recovering your account on the job board.',login_url:'https://jobs.organizedai.vip/seeker/login'},202);
export async function candidateRoutes(req:Request,env:Env,fetcher:typeof fetch=fetch):Promise<Response|null>{
 const url=new URL(req.url);
 if(url.pathname==='/api/candidate-setup'&&req.method==='GET')return json({enabled:enabled(env),consent_version:CONSENT_VERSION});
 if(url.pathname!=='/api/candidates/complete')return null;
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 if(req.headers.get('origin')!==url.origin||url.hostname!=='assessment.organizedai.vip')return json({error:'Use the assessment page to complete your profile.'},403);
 if(!enabled(env))return json({error:'Account creation is not available yet.'},503);
 let body:any;
 try{body=validate(await boundedJson(req));}catch(error:any){return json({error:error.message==='size'?'The report exceeds 2 MB.':'Check your account details, consent and report. Use at least 12 characters for your password; completed-work evidence is required.'},error.message==='size'?413:422);}
 // Never hash or persist the password; retries bind only the reviewed payload and identity.
 const fingerprint=await hash(JSON.stringify({name:[body.first_name,body.last_name],email:body.email,profile:body.profile,public_share_id:body.public_share_id||null,consent:CONSENT_VERSION}));
 const now=Math.floor(Date.now()/1000);
 let publicUrl:string|null=null;
 if(body.public_share_id||body.public_share_token){publicUrl=await ownedPublicUrl(env,body.public_share_id,body.public_share_token,body.profile);if(!publicUrl)return json({error:'The public assessment link does not match this report or management key.'},422);}
 let existing:any;
 try{
  existing=await env.DB.prepare('SELECT request_hash,state FROM candidate_registrations WHERE request_id=?').bind(body.request_id).first();
  if(existing){
   if(existing.request_hash!==fingerprint)return json({status:'outcome_unknown',error:'This request was already used with different details. Sign in or recover the original account before starting another signup.',login_url:'https://jobs.organizedai.vip/seeker/login'},409);
   if(existing.state==='created')return json({status:'created',matching_status:'already_created',matches:[],login_url:'https://jobs.organizedai.vip/seeker/login',notice:'Your account was already created. Sign in to manage it or browse current jobs.'},201);
   if(existing.state==='rejected')return json({status:'rejected',error:'This account request was rejected. If you already have an account, sign in; this flow will not change an existing account.',login_url:'https://jobs.organizedai.vip/seeker/login'},409);
   return uncertain();
  }
  await env.DB.prepare('DELETE FROM candidate_rate_limits WHERE expires_at<?').bind(now).run();
  await env.DB.prepare('DELETE FROM candidate_registrations WHERE created_at<?').bind(now-90*86400).run();
  const bucket=await hash((req.headers.get('cf-connecting-ip')||'unknown')+':'+Math.floor(now/3600));
  const rate:any=await env.DB.prepare('INSERT INTO candidate_rate_limits(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(bucket,now+7200).first();
  if(rate.attempts>5)return json({error:'Too many attempts. Please try again later.'},429);
  // No downstream request unless its durable reservation is confirmed.
  const inserted=await env.DB.prepare("INSERT OR IGNORE INTO candidate_registrations(request_id,request_hash,state,consent_version,created_at,updated_at) VALUES(?,?,'pending',?,?,?)").bind(body.request_id,fingerprint,CONSENT_VERSION,now,now).run();
  if(inserted.meta.changes!==1)return uncertain();
 }catch{return json({error:'Account creation is temporarily unavailable. Nothing was sent to Niceboard.'},503);}
 const form=new FormData();
 for(const field of ['first_name','last_name','email','password'])form.set(field,body[field]);
 form.set('summary',candidateSummary(body.profile)+(publicUrl?'\nPublic assessment: '+publicUrl:''));form.set('is_public','true');form.set('is_verified','false');
 let result:Response;
 try{
  const base=new URL(env.NICEBOARD_API_BASE!);
  if(base.protocol!=='https:'||base.hostname!=='jobs.organizedai.vip')throw new Error('Invalid API host');
  result=await fetcher(base.toString().replace(/\/$/,'')+'/jobseekers',{method:'POST',headers:{Authorization:'Bearer '+env.NICEBOARD_API_KEY,'User-Agent':'OrganizedAI-Assessment/1.0','Accept':'application/json'},body:form,signal:AbortSignal.timeout(20000),redirect:'error'});
 }catch{
  await env.DB.prepare("UPDATE candidate_registrations SET state='unknown',updated_at=? WHERE request_id=?").bind(now,body.request_id).run().catch(()=>{});
  return uncertain();
 }
 if(!result.ok){
  // 5xx/408 can follow a committed creation; do not retry them as a new request.
  const rejected=result.status>=400&&result.status<500&&result.status!==408;
  await env.DB.prepare('UPDATE candidate_registrations SET state=?,updated_at=? WHERE request_id=?').bind(rejected?'rejected':'unknown',now,body.request_id).run().catch(()=>{});
  return rejected?json({status:'rejected',error:'Niceboard could not create this account. Check your details or sign in if you already have an account. No existing account was modified.',login_url:'https://jobs.organizedai.vip/seeker/login'},409):uncertain();
 }
 let data:any;try{data=await result.json();}catch{return uncertain();}
 if(![200,201].includes(result.status)||data?.error||data?.success===false)return uncertain();
 const id=data?.jobseeker?.id??data?.jobseeker_id??data?.data?.id??data?.id;
 if(!/^[1-9][0-9]*$/.test(String(id))||!Number.isSafeInteger(Number(id)))return uncertain();
 // Creation response envelopes are not documented. Confirm the returned ID with
 // the documented single-jobseeker endpoint before claiming success.
 try {
  const verified=await fetcher(env.NICEBOARD_API_BASE!.replace(/\/$/,'')+'/jobseekers/'+id,{headers:{Authorization:'Bearer '+env.NICEBOARD_API_KEY,'User-Agent':'OrganizedAI-Assessment/1.0','Accept':'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!verified.ok)return uncertain();
  const value:any=await verified.json();const account=value?.jobseeker??value?.data??value;
  if(String(account?.id)!==String(id)||String(account?.email).toLowerCase()!==body.email||account?.first_name!==body.first_name||account?.last_name!==body.last_name||!['true','1'].includes(String(account?.is_public)))return uncertain();
 } catch { return uncertain(); }
 try{await env.DB.prepare("UPDATE candidate_registrations SET state='created',niceboard_id=?,updated_at=? WHERE request_id=?").bind(String(id),now,body.request_id).run();}
 catch{return uncertain();}
 // Job lookup failure cannot undo account creation or cause duplicate retries.
 return completed(body.profile,fetcher);
}

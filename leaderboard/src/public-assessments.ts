import {assertNoSecrets,assertNoLocalEvidenceLeaks,validateRawProfileV9,sanitizeProfile,validateProfileV9} from './validate.js';
import {renderProfileV9Document} from 'ai-work-assessment/profile-template';
import {addScriptNonce,profileDocumentHeaders} from 'ai-work-assessment/render';
interface Env {DB:D1Database;}
export const PUBLIC_CONSENT='public-assessment-2026-09-17';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export const profileHash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export async function ownedPublicUrl(env:Env,id:unknown,token:unknown,profile:any){
 if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
 const row:any=await env.DB.prepare('SELECT profile_hash FROM public_assessments WHERE id=? AND manage_hash=? AND revoked_at IS NULL').bind(id,await profileHash(token)).first();
 return row?.profile_hash===await profileHash(JSON.stringify(profile))?'https://assessment.organizedai.vip/p/'+id:null;
}
async function readProfile(req:Request){
 if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Error('json');
 const reader=req.body?.getReader();if(!reader)throw new Error('json');let n=0;const parts:Uint8Array[]=[];
 for(;;){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>2*1024*1024){await reader.cancel();throw new Error('size');}parts.push(value);}
 const bytes=new Uint8Array(n);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
export async function publicAssessmentRoutes(req:Request,env:Env):Promise<Response|null>{
 const url=new URL(req.url),path=url.pathname;
 const view=path.match(/^\/p\/([a-f0-9]{32})$/),api=path.match(/^\/api\/public-assessments(?:\/([a-f0-9]{32}))?$/);
 if(view){
  if(!['GET','HEAD'].includes(req.method))return json({error:'Method not allowed'},405);
  const row:any=await env.DB.prepare('SELECT profile FROM public_assessments WHERE id=? AND revoked_at IS NULL').bind(view[1]).first();
  if(!row)return new Response('This assessment is unavailable or its owner removed the public link.',{status:404,headers:{'cache-control':'no-store','content-type':'text/plain','x-robots-tag':'noindex'}});
  const profile=JSON.parse(row.profile),nonce=crypto.randomUUID();
  let html=renderProfileV9Document(profile,{localPreview:false,showUpload:false,cohortMode:'none',branding:{siteName:'Organized AI',initial:'OA',accentColor:'#f2c000',headerLabel:'Organized AI / Public assessment',titleSuffix:'Organized AI work assessment',footerLabel:'Shared by the candidate · evidence-based work profile',manageUrl:null,shareLabel:'ORGANIZED AI / WORK ASSESSMENT',shareFooter:'ORGANIZED AI'}});
  html=html.replace('<main id="top">','<main id="top"><aside class="shell local-only-notice">Public assessment shared with the owner’s consent. Claims are supported by the submitted evidence, not independently certified. This is not a hiring decision.</aside>');
  return new Response(req.method==='HEAD'?null:addScriptNonce(html,nonce),{headers:{...profileDocumentHeaders({nonce,published:false}),'x-robots-tag':'noindex, noarchive'}});
 }
 if(!api)return null;
 if(req.headers.get('origin')!==url.origin||url.hostname!=='assessment.organizedai.vip')return json({error:'Use the assessment website.'},403);
 if(api[1]&&req.method==='DELETE'){
  const token=req.headers.get('authorization')?.replace(/^Bearer /,'')||'';
  if(!/^[a-f0-9]{64}$/.test(token))return json({error:'The private management key is required.'},401);
  const removed=await env.DB.prepare('UPDATE public_assessments SET profile=NULL,revoked_at=COALESCE(revoked_at,unixepoch()) WHERE id=? AND manage_hash=?').bind(api[1],await profileHash(token)).run();
  return removed.meta.changes===1?json({status:'removed'}):json({error:'Link not found or management key is incorrect.'},404);
 }
 if(api[1]||req.method!=='POST')return json({error:'Method not allowed'},405);
 let body:any,serialized:string;
 try{
  body=await readProfile(req);
  if(!body||Object.keys(body).some(k=>!['id','manage_token','profile','reviewed','publish_consent','consent_version'].includes(k)))throw new Error('fields');
  if(!/^[a-f0-9]{32}$/.test(body.id)||!/^[a-f0-9]{64}$/.test(body.manage_token)||body.reviewed!==true||body.publish_consent!==true||body.consent_version!==PUBLIC_CONSENT)throw new Error('consent');
  serialized=JSON.stringify(body.profile);assertNoSecrets(serialized);assertNoLocalEvidenceLeaks(serialized);
  if(body.profile?.schema_version!==9||body.profile?.prompt_version!==8)throw new Error('profile');
  validateRawProfileV9(body.profile);sanitizeProfile(body.profile);validateProfileV9(body.profile);serialized=JSON.stringify(body.profile);
 }catch(error:any){return json({error:error.message==='size'?'Report exceeds 2 MB.':'A reviewed valid assessment and explicit public-sharing consent are required.'},error.message==='size'?413:422);}
 const tokenHash=await profileHash(body.manage_token),digest=await profileHash(serialized);
 const existing:any=await env.DB.prepare('SELECT manage_hash,profile_hash,revoked_at FROM public_assessments WHERE id=?').bind(body.id).first();
 if(existing){
  if(existing.revoked_at!==null)return json({error:'This public link was removed. Create a new link for another publication.'},410);
  if(existing.manage_hash!==tokenHash||existing.profile_hash!==digest)return json({error:'This link belongs to a different report or owner.'},409);
  return json({status:'published',url:'https://assessment.organizedai.vip/p/'+body.id},200);
 }
 const now=Math.floor(Date.now()/1000),bucket=await profileHash('public:'+(req.headers.get('cf-connecting-ip')||'unknown')+':'+Math.floor(now/3600));
 await env.DB.prepare('DELETE FROM public_assessment_rate_limits WHERE expires_at<?').bind(now).run();
 const rate:any=await env.DB.prepare('INSERT INTO public_assessment_rate_limits(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(bucket,now+7200).first();
 if(rate.attempts>5)return json({error:'Too many new links. Try again later.'},429);
 const created=await env.DB.prepare('INSERT OR IGNORE INTO public_assessments(id,manage_hash,profile_hash,profile,consent_version,created_at) VALUES(?,?,?,?,?,?)').bind(body.id,tokenHash,digest,serialized,PUBLIC_CONSENT,now).run();
 if(created.meta.changes!==1)return json({error:'The link changed during publication. Retry this same request.'},409);
 return json({status:'published',url:'https://assessment.organizedai.vip/p/'+body.id},201);
}

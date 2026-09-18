import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {sanitizeProfile} from '../src/validate.js';
import {publicAssessmentRoutes,ownedPublicUrl,PUBLIC_CONSENT} from '../src/public-assessments.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/profile-v9.sample.json',import.meta.url)));
function setup(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const file of ['004_candidate_registrations.sql','005_public_assessments.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const DB = {
  prepare(sql) {
   let args=[];
   return {
    bind(...values) { args=values; return this; },
    async first() { return sqlite.prepare(sql).get(...args)||null; },
    async run() { return {meta:{changes:sqlite.prepare(sql).run(...args).changes}}; },
   };
  },
 };
 return {sqlite,DB};
}
const payload=(change={})=>({id:'a'.repeat(32),manage_token:'b'.repeat(64),profile:structuredClone(fixture),reviewed:true,publish_consent:true,consent_version:PUBLIC_CONSENT,...change});
const post=(body,origin='https://assessment.organizedai.vip')=>new Request('https://assessment.organizedai.vip/api/public-assessments',{method:'POST',headers:{origin,'content-type':'application/json','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify(body)});
const view=()=>new Request('https://assessment.organizedai.vip/p/'+'a'.repeat(32));
const remove=token=>new Request('https://assessment.organizedai.vip/api/public-assessments/'+'a'.repeat(32),{method:'DELETE',headers:{origin:'https://assessment.organizedai.vip',authorization:'Bearer '+token}});
test('explicit sharing creates a stable canonical public URL, no account details or management secret exposed',async t=>{
 const env=setup(t),body=payload();sanitizeProfile(body.profile);const first=await publicAssessmentRoutes(post(body),env);assert.equal(first.status,201);assert.equal((await first.json()).url,'https://assessment.organizedai.vip/p/'+body.id);
 assert.equal((await publicAssessmentRoutes(post(body),env)).status,200);
 const response=await publicAssessmentRoutes(view(),env),html=await response.text();assert.equal(response.status,200);
 assert.match(html,/Public assessment shared/);assert.match(html,/Riley/);assert.doesNotMatch(html,/Private preview\. Nothing has been uploaded|overflowbuilders\.com/);
 assert.doesNotMatch(html,new RegExp(body.manage_token));assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('x-robots-tag'),/noindex/);
 const row=env.sqlite.prepare('SELECT * FROM public_assessments').get();assert.notEqual(row.manage_hash,body.manage_token);assert.equal(JSON.stringify(row).includes(body.manage_token),false);
 assert.equal(await ownedPublicUrl(env,body.id,body.manage_token,body.profile),'https://assessment.organizedai.vip/p/'+body.id);
 assert.equal(await ownedPublicUrl(env,body.id,'c'.repeat(64),body.profile),null);
 assert.equal(await ownedPublicUrl(env,body.id,body.manage_token,{...body.profile,name:'Different'}),null);
});
test('public publishing requires consent, review, schema privacy and same origin',async t=>{
 const env=setup(t);
 for(const patch of [{publish_consent:false},{reviewed:false},{email:'not-allowed@example.test'},{profile:{...fixture,name:'sk-proj-'+'x'.repeat(40)}},{profile:{...fixture,raw_transcript:'private'}}])assert.equal((await publicAssessmentRoutes(post(payload(patch)),env)).status,422);
 assert.equal((await publicAssessmentRoutes(post(payload(),'https://other.test'),env)).status,403);
 assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM public_assessments').get().n,0);
});
test('management token revokes immediately, erases report, and leaves a tombstone to prevent link takeover',async t=>{
 const env=setup(t),body=payload();await publicAssessmentRoutes(post(body),env);
 assert.equal((await publicAssessmentRoutes(remove('c'.repeat(64)),env)).status,404);assert.equal((await publicAssessmentRoutes(view(),env)).status,200);
 assert.equal((await publicAssessmentRoutes(remove(body.manage_token),env)).status,200);assert.equal((await publicAssessmentRoutes(view(),env)).status,404);
 assert.equal(env.sqlite.prepare('SELECT profile FROM public_assessments').get().profile,null);
 assert.equal((await publicAssessmentRoutes(post(payload({manage_token:'c'.repeat(64)})),env)).status,410);
 assert.equal(await ownedPublicUrl(env,body.id,body.manage_token,body.profile),null);
});
test('public link cannot overwrite another report or owner, and bursts are bounded',async t=>{
 const env=setup(t);await publicAssessmentRoutes(post(payload()),env);
 assert.equal((await publicAssessmentRoutes(post(payload({manage_token:'c'.repeat(64)})),env)).status,409);
 assert.equal((await publicAssessmentRoutes(post(payload({profile:{...fixture,name:'Other'}})),env)).status,409);
 for(let i=0;i<4;i++)assert.equal((await publicAssessmentRoutes(post(payload({id:String(i).repeat(32)})),env)).status,201);
 assert.equal((await publicAssessmentRoutes(post(payload({id:'f'.repeat(32)})),env)).status,429);
});

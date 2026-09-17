import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {candidateRoutes,CONSENT_VERSION} from '../src/candidate-registration.ts';
import {matchJobs,candidateSummary,liveRoles} from '../src/job-matching.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/profile-v9.sample.json',import.meta.url)));
function setup(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec(readFileSync(new URL('../migrations/004_candidate_registrations.sql',import.meta.url),'utf8'));
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
 const env={DB,NICEBOARD_API_BASE:'https://jobs.organizedai.vip/api/v1',NICEBOARD_API_KEY:'synthetic-api-key',CANDIDATE_SIGNUP_ENABLED:'true'};
 const calls=[];
 const fetcher=async(url,options)=>{calls.push({url,options});if(options.method==='POST')return Response.json({jobseeker:{id:42}}, {status:201});if(url.endsWith('/jobseekers/42'))return Response.json({jobseeker:{id:42,first_name:'Riley',last_name:'Okafor',email:'riley@example.test',is_public:true}});return Response.json({count:1,jobs:[{id:1,title:'Agent automation engineer',company_name:'Fictional Company',company_slug:'fictional',slug:'agent-engineer',description_html:'Build agent orchestration and automation for product operations.'}]});};
 return {sqlite,env,calls,fetcher};
}
function body(changes={}){return {request_id:'a'.repeat(64),first_name:'Riley',last_name:'Okafor',email:'riley@example.test',password:'synthetic-password-only',profile:structuredClone(fixture),reviewed:true,employer_consent:true,terms_consent:true,consent_version:CONSENT_VERSION,...changes};}
function request(data=body(),origin='https://assessment.organizedai.vip'){return new Request('https://assessment.organizedai.vip/api/candidates/complete',{method:'POST',headers:{'content-type':'application/json',origin,'cf-connecting-ip':'192.0.2.1'},body:JSON.stringify(data)});}
test('consented assessment creates an employer-visible account once without persisting credentials or profile',async t=>{
 const s=setup(t);const data=body();const response=await candidateRoutes(request(data),s.env,s.fetcher);assert.equal(response.status,201);
 const result=await response.json();assert.equal(result.status,'created');assert.equal(result.matches.length,1);
 const form=s.calls[0].options.body;assert.equal(form.get('is_public'),'true');assert.equal(form.get('is_verified'),'false');assert.equal(form.get('password'),data.password);assert.equal(form.has('resume'),false);
 assert.match(form.get('summary'),/candidate-reviewed evidence/);
 const receipt=s.sqlite.prepare('SELECT * FROM candidate_registrations').get();assert.equal(receipt.state,'created');assert.equal(receipt.niceboard_id,'42');
 const persisted=JSON.stringify(receipt);assert.doesNotMatch(persisted,/synthetic-password|riley@|Riley|work_arcs|synthetic-api-key/);
 const retry=await candidateRoutes(request(data),s.env,s.fetcher);assert.equal(retry.status,201);assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);
});
test('consent, origin, strict fields and profile privacy failures never dispatch an account creation',async t=>{
 const s=setup(t);
 for(const patch of [{employer_consent:false},{terms_consent:false},{reviewed:false},{is_verified:true},{password:'short'},{profile:{...fixture,name:'sk-proj-'+ 'x'.repeat(30)}}]){
  assert.equal((await candidateRoutes(request(body(patch)),s.env,s.fetcher)).status,422);
 }
 assert.equal((await candidateRoutes(request(body(),'https://untrusted.test'),s.env,s.fetcher)).status,403);
 assert.equal(s.calls.length,0);assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS n FROM candidate_registrations').get().n,0);
});
test('oversized streaming bodies are bounded before downstream creation',async t=>{
 const s=setup(t);const response=await candidateRoutes(request(body({first_name:'x'.repeat(2*1024*1024)})),s.env,s.fetcher);
 assert.equal(response.status,413);assert.equal(s.calls.length,0);
});
test('duplicate email rejection never updates an existing account and never retries the create',async t=>{
 const s=setup(t);let calls=0;const f=async()=>{calls++;return Response.json({error:'riley@example.test already exists, synthetic-provider-detail'}, {status:409});};
 const first=await candidateRoutes(request(),s.env,f);assert.equal(first.status,409);assert.doesNotMatch(await first.text(),/riley@example|synthetic-provider-detail/);
 assert.equal((await candidateRoutes(request(),s.env,f)).status,409);assert.equal(calls,1);
});
test('timeout after dispatch is unknown and is not automatically re-created',async t=>{
 const s=setup(t);let calls=0;const f=async()=>{calls++;throw new Error('synthetic network failure');};
 assert.equal((await candidateRoutes(request(),s.env,f)).status,202);assert.equal((await candidateRoutes(request(),s.env,f)).status,202);assert.equal(calls,1);
 assert.equal(s.sqlite.prepare('SELECT state FROM candidate_registrations').get().state,'unknown');
});
test('durable reservation failure prevents Niceboard side effects',async t=>{
 const s=setup(t);s.sqlite.exec("CREATE TRIGGER refuse BEFORE INSERT ON candidate_registrations BEGIN SELECT RAISE(ABORT,'failure'); END");
 assert.equal((await candidateRoutes(request(),s.env,s.fetcher)).status,503);assert.equal(s.calls.length,0);
});
test('local recording failure after account creation is unknown and retry never recreates it',async t=>{
 const s=setup(t);s.sqlite.exec("CREATE TRIGGER refuse BEFORE UPDATE ON candidate_registrations WHEN NEW.state='created' BEGIN SELECT RAISE(ABORT,'failure'); END");
 assert.equal((await candidateRoutes(request(),s.env,s.fetcher)).status,202);assert.equal((await candidateRoutes(request(),s.env,s.fetcher)).status,202);assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);
});
test('a concurrent duplicate cannot dispatch two account creations',async t=>{
 const s=setup(t);const responses=await Promise.all([candidateRoutes(request(),s.env,s.fetcher),candidateRoutes(request(),s.env,s.fetcher)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,202]);assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);
});
test('matching failure preserves successful creation and does not create again',async t=>{
 const s=setup(t);const f=async(url,opts)=>opts.method==='POST'||url.endsWith('/jobseekers/42')?s.fetcher(url,opts):new Response('',{status:503});
 const r=await(await candidateRoutes(request(),s.env,f)).json();assert.equal(r.status,'created');assert.equal(r.matching_status,'unavailable');
 await candidateRoutes(request(),s.env,f);assert.equal(s.calls.length,2);
});
test('same key cannot be reused for a different identity or evidence',async t=>{
 const s=setup(t);await candidateRoutes(request(),s.env,s.fetcher);
 assert.equal((await candidateRoutes(request(body({email:'someone-else@example.test'})),s.env,s.fetcher)).status,409);assert.equal(s.calls.filter(c=>c.options.method==='POST').length,1);
});
test('per-IP rate limit bounds new account attempts',async t=>{
 const s=setup(t);
 for(let i=0;i<5;i++)assert.equal((await candidateRoutes(request(body({request_id:String(i).repeat(64)})),s.env,s.fetcher)).status,201);
 assert.equal((await candidateRoutes(request(body({request_id:'f'.repeat(64)})),s.env,s.fetcher)).status,429);assert.equal(s.calls.filter(c=>c.options.method==='POST').length,5);
});
test('suggestions require work-backed capability, ignore names and omit expired or anonymous jobs',()=>{
 const role={id:1,title:'Agent orchestration engineer',company_name:'Fictional',description_html:'Maintain agent workflows.'};
 const first=matchJobs(fixture,[role]);assert.equal(first.length,1);assert.deepEqual(first[0].reasons[0].evidence_ids,['ev-002','ev-003']);
 assert.deepEqual(matchJobs({...fixture,name:'Different identity'},[role]),first);
 const unproven=structuredClone(fixture);unproven.work_arcs.forEach(a=>a.delivery_state='exploration');assert.equal(matchJobs(unproven,[role]).length,0);
 assert.equal(matchJobs(fixture,[{...role,expires_on:'2000-01-01'}]).length,0);assert.equal(matchJobs(fixture,[{...role,anonymity_enabled:true}]).length,0);
 assert.equal(matchJobs(fixture,[{...role,title:'Dental hygienist',description_html:'Clinical dental cleaning.'}]).length,0);
 assert.doesNotMatch(candidateSummary(fixture),/three-time|founder|Riley/);
});
test('job inventory pagination refuses partial or drifting results',async()=>{
 await assert.rejects(liveRoles(async()=>Response.json({count:2,jobs:[]})),/Incomplete/);
 let n=0;await assert.rejects(liveRoles(async()=>Response.json({count:++n===1?2:3,jobs:[{id:n}]})),/changed/);
});
test('unestablished, touched and career-only capabilities cannot become work matches or create an account',async t=>{
 const s=setup(t);const role={id:1,title:'Agent orchestration engineer',company_name:'Fictional',description_html:'Build agent workflows.'};
 for(const change of ['not-established','touched','career-only']){
  const p=structuredClone(fixture);for(const cap of p.matching_index.capabilities){if(change==='career-only')cap.evidence_ids=['ev-004'];else cap.depth=change;}
  assert.equal(matchJobs(p,[role]).length,0);assert.doesNotMatch(candidateSummary(p),/Agent orchestration|Product operations/);
  assert.equal((await candidateRoutes(request(body({profile:p})),s.env,s.fetcher)).status,422);
 }
 assert.equal(s.calls.length,0);
});
test('empty IDs, accepted-but-pending responses and mismatched account verification remain unknown',async t=>{
 const s=setup(t);
 for(const [i,variant] of ['empty','pending','mismatch'].entries()){
  let posts=0;const f=async(url,opts)=>{if(opts.method==='POST'){posts++;return Response.json({jobseeker:{id:variant==='empty'?'':42}},{status:variant==='pending'?202:201});}return Response.json({jobseeker:{id:42,first_name:'Different',last_name:'Person',email:'not-the-candidate@example.test',is_public:true}});};
  const b=body({request_id:String(i).repeat(64)});
  assert.equal((await candidateRoutes(request(b),s.env,f)).status,202);assert.equal((await candidateRoutes(request(b),s.env,f)).status,202);assert.equal(posts,1);
 }
});
test('created receipt replay never re-fetches the inventory',async t=>{
 const s=setup(t);await candidateRoutes(request(),s.env,s.fetcher);const count=s.calls.length;
 const r=await(await candidateRoutes(request(),s.env,s.fetcher)).json();assert.equal(r.matching_status,'already_created');assert.equal(s.calls.length,count);
});

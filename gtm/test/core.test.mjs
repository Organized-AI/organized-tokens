import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildCampaign,digest,engramHandoff,DAY} from '../core.mjs';
import {greenhouse,lever,ashby,careerJobPostings,importedRoles} from '../sources.mjs';
import {render} from '../render.mjs';
import {plainText} from '../text.mjs';
import {reconcileAccounts} from '../reconcile-accounts.mjs';
import {mergeRoleSources,reconcileRoleAliases,jobIdentity} from '../merge-sources.mjs';
import {sanitizeProfile} from '../../leaderboard/src/validate.js';
const profile=JSON.parse(fs.readFileSync(new URL('../../leaderboard/test/fixtures/profile-v9.sample.json',import.meta.url)));
const now=Date.parse('2026-09-17T23:00:00Z'),at='2026-09-17T22:00:00Z';
function input(){return {
 campaign:{id:'sponsor-test',event_series:'Austin AI workshops',sender_name:'Organizer',sponsor_url:'https://sponsor.organizedai.vip/',job_board_url:'https://jobs.organizedai.vip/',assessment_url:'https://assessment.organizedai.vip/'},
 companies:[{id:1,name:'Fictional',website:'https://example.test',source_url:'https://example.test/company'}],
 roles:[{id:1,company_id:1,company_name:'Fictional',title:'Agent orchestration engineer',description:'Build agent workflows and automation.',source_url:'https://example.test/job/1',collected_at:at,availability:'employer-confirmed',availability_checked_at:at,availability_source_url:'https://example.test/careers'}],
 contacts:[{company_id:1,kind:'email',value:'hello@example.test',purpose:'general',title_or_function:'Company contact',url:'https://example.test/contact',checked_at:at,verification:'employer-published-role-and-route-reviewed'}],
 candidates:[{profile:structuredClone(profile),consent:{matching:true,public_link_in_drafts:true,profile_sha256:digest(profile),public_url:'https://assessment.organizedai.vip/p/'+'a'.repeat(32),source:'synthetic-test-consent',recorded_at:at}}],
};}
test('prepares sponsor-first sequence and cites consented completed work for confirmed roles',()=>{
 const r=buildCampaign(input(),now),a=r.accounts[0];
 assert.equal(r.outreach_status,'paused');assert.equal(a.drafts[0].stage,'sponsor-introduction');assert.equal(a.drafts[1].kind,'candidate-specific');
 assert.match(a.drafts[1].body,/Riley Okafor/);assert.match(a.drafts[1].body,/potential fit/);
 assert.equal(a.hiring.candidate_matches[0].reasons[0].work[0].authorship,'directed-reviewed');
 assert.equal(a.next_action,'review-candidate-fit-and-copy');assert.equal(a.sponsorship.intent,'unknown');
});
test('every consent failure omits candidate identity, public link and evidence',()=>{
 for(const patch of [{matching:false},{public_link_in_drafts:false},{revoked:true},{profile_sha256:'wrong'},{public_url:'https://evil.test/p/x'},{source:''},{recorded_at:'2027-01-01'}]){
  const i=input();Object.assign(i.candidates[0].consent,patch);const r=buildCampaign(i,now);
  assert.equal(r.accounts[0].hiring.candidate_matches.length,0);assert.equal(r.accounts[0].drafts[1].kind,'general-job-board-invitation');
  assert.doesNotMatch(JSON.stringify(r),/Riley|ev-002|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
 }
});
test('missing evidence, exploratory work and specialist mismatch do not become candidate pitches',()=>{
 for(const type of ['no-evidence','exploration','hardware']){
  const i=input(),c=i.candidates[0];
  if(type==='no-evidence')c.profile.evidence_index=[];
  if(type==='exploration')c.profile.work_arcs.forEach(a=>a.delivery_state='exploration');
  if(type==='hardware')i.roles[0].title='Silicon Hardware Architect';
  c.consent.profile_sha256=digest(c.profile);
  assert.equal(buildCampaign(i,now).counts.specific_followups,0);
 }
});
test('financial and insurance agents are not AI-agent evidence',()=>{
 for(const title of ['Transfer Agent','Insurance Agent']){
  const i=input();i.roles[0].title=title;i.roles[0].description='Serve customers and manage financial accounts.';
  assert.equal(buildCampaign(i,now).counts.specific_followups,0);
 }
 const i=input();i.roles[0].title='Automation Engineer';i.roles[0].description='Build automation for an internal Transfer Agent.';
 const r=buildCampaign(i,now);assert.ok(r.accounts[0].hiring.candidate_matches.length);
 assert.ok(r.accounts[0].hiring.candidate_matches[0].reasons.every(r=>r.topic!=='agent workflows'));
});
test('board status, stale timestamps and unknown employer availability never establish active hiring',()=>{
 for(const patch of [{availability:'board-listed'},{availability_checked_at:'2026-08-01'},{availability_source_url:null},{availability_checked_at:'2027-01-01'},{collected_at:'2026-08-01'}]){
  const i=input();Object.assign(i.roles[0],patch);const r=buildCampaign(i,now);
  assert.equal(r.counts.specific_followups,0);assert.equal(r.accounts[0].hiring.confirmed_openings,0);
 }
});
test('expired roles and source discrepancies remove otherwise matching openings',()=>{
 for(const type of ['expiry','closed','discrepancy']){
  const i=input();if(type==='expiry')i.roles[0].expires_on=at;
  if(type==='closed')i.roles[0].availability='closed';
  if(type==='discrepancy')i.findings=[{roles:[{id:1}],finding:{status:'no-current-openings-at-source'}}];
  const r=buildCampaign(i,now);assert.equal(r.accounts[0].hiring.candidate_matches.length,0);assert.equal(r.accounts[0].hiring.unavailable_or_stale.length,1);
 }
});
test('recruiting contacts are not repurposed for sponsorship and stale/unreviewed routes are excluded',()=>{
 const i=input();i.contacts[0].purpose='recruiting';let a=buildCampaign(i,now).accounts[0];
 assert.equal(a.sponsorship.routes.length,0);assert.equal(a.hiring.routes.length,1);
 for(const patch of [{checked_at:'2026-01-01'},{verification:'unreviewed'},{url:'javascript:alert(1)'}]){
  const j=input();Object.assign(j.contacts[0],patch);assert.equal(buildCampaign(j,now).counts.reviewed_routes,0);
 }
});
test('company suppressions remove all drafts and route suppression is case insensitive',()=>{
 const i=input();i.suppressed=[{company_id:1}];let r=buildCampaign(i,now);
 assert.deepEqual(r.accounts[0].drafts,[]);assert.deepEqual(r.accounts[0].hiring.candidate_matches,[]);assert.equal(engramHandoff(r).accounts.length,0);
 i.suppressed=[{value:'HELLO@EXAMPLE.TEST'}];assert.equal(buildCampaign(i,now).counts.reviewed_routes,0);
});
test('duplicate accounts require reconciliation and handoff excludes candidates and drafts',()=>{
 const i=input();i.companies.push({...i.companies[0],id:2});const r=buildCampaign(i,now);
 assert.deepEqual(r.duplicate_company_groups,[['1','2']]);assert.ok(r.accounts[0].blockers.includes('duplicate-company-review'));
 const h=JSON.stringify(engramHandoff(r));assert.doesNotMatch(h,/Riley|ev-002|public_url|Following up|hello@example/);assert.match(h,/review-only/);
});
test('review page escapes source content and has no send controls',()=>{
 const i=input();i.companies[0].name='<img src=x onerror=alert(1)> Evil';i.contacts[0].evidence_excerpt='</script><script>evil()</script>';
 const html=render(buildCampaign(i,now));assert.doesNotMatch(html,/<img src=x|evil\(\)|onclick=|fetch\(/);assert.match(html,/Copy draft/);
});
test('consent digest survives CLI normalization but changes when evidence changes',()=>{
 const i=input(),before=digest(i.candidates[0].profile);sanitizeProfile(i.candidates[0].profile);
 assert.equal(digest(i.candidates[0].profile),before);assert.equal(buildCampaign(i,now).counts.specific_followups,1);
 i.candidates[0].profile.work_arcs[0].label='Different delivered work';assert.notEqual(digest(i.candidates[0].profile),before);
 assert.equal(buildCampaign(i,now).counts.specific_followups,0);
});
test('hiring-only route details are independently reviewable',()=>{
 const i=input();i.contacts=[{...i.contacts[0],purpose:'recruiting',value:'careers@example.test',name:'Talent team',url:'https://example.test/careers'}];
 const report=buildCampaign(i,now),html=render(report);
 assert.equal(report.accounts[0].sponsorship.routes.length,0);assert.match(html,/Talent team — careers@example.test/);assert.match(html,/href="https:\/\/example.test\/careers"/);
});
test('Greenhouse collection checks completeness and preserves provenance',async()=>{
 const fetcher=async url=>{assert.equal(new URL(url).hostname,'boards-api.greenhouse.io');return Response.json({meta:{total:1},jobs:[{id:42,title:'Agent engineer',content:'Build agents.',absolute_url:'https://boards.greenhouse.io/test/jobs/42',location:{name:'Austin'}}]});};
 const r=await greenhouse({board:'test',company_id:1,company_name:'Fictional'},fetcher,now);
 assert.equal(r[0].availability,'employer-confirmed');assert.equal(r[0].source_sha256.length,64);assert.equal(r[0].availability_checked_at,new Date(now).toISOString());
 await assert.rejects(greenhouse({board:'test',company_id:1},async()=>Response.json({meta:{total:2},jobs:[]})),/Incomplete/);
 await assert.rejects(greenhouse({board:'../other',company_id:1},fetcher),/Invalid/);
});
test('Lever keeps description and source; failed feeds cannot masquerade as empty inventory',async()=>{
 const r=await lever({board:'test',company_id:1,company_name:'Fictional'},async()=>Response.json([{id:'a',text:'Engineer',descriptionPlain:'Agents',lists:[{text:'Requirements',content:'APIs'}],hostedUrl:'https://jobs.lever.co/test/a',applyUrl:'https://jobs.lever.co/test/a/apply'}]),now);
 assert.match(r[0].description_html,/APIs/);assert.equal(r[0].source_kind,'lever');
 await assert.rejects(lever({board:'test',company_id:1},async()=>new Response('',{status:429})),/429/);
});
test('Ashby confirms only public listed jobs and preserves its board receipt',async()=>{
 const jobs=[{id:'a',title:'AI Engineer',location:'Austin',isListed:true,jobUrl:'https://jobs.ashbyhq.com/test/a',applyUrl:'https://jobs.ashbyhq.com/test/a/application',descriptionHtml:'<p>Build agents</p>'},
  {id:'hidden',title:'Hidden',isListed:false,jobUrl:'https://jobs.ashbyhq.com/test/hidden',applyUrl:'https://jobs.ashbyhq.com/test/hidden/application'}];
 const fetcher=async url=>{assert.equal(url,'https://api.ashbyhq.com/posting-api/job-board/Solana%20Foundation');return Response.json({apiVersion:'1',jobs});};
 const r=await ashby({board:'Solana Foundation',company_id:1,company_name:'Fictional'},fetcher,now);
 assert.equal(r.length,1);assert.equal(r[0].source_kind,'ashby');assert.equal(r[0].availability,'employer-confirmed');
 assert.equal(r[0].availability_source_url,'https://api.ashbyhq.com/posting-api/job-board/Solana%20Foundation');assert.equal(r[0].source_sha256.length,64);
 await assert.rejects(ashby({board:'../other',company_id:1},fetcher),/Invalid public Ashby/);
 await assert.rejects(ashby({board:'test',company_id:1},async()=>Response.json({jobs})),/Invalid Ashby/);
 await assert.rejects(ashby({board:'test',company_id:1},async()=>Response.json({apiVersion:'1',jobs:[{id:'a',title:'',jobUrl:'https://example.test'}]})),/Malformed Ashby/);
});
test('career JSON-LD and third-party imports preserve uncertain status',()=>{
 const html='<script type="application/ld+json">'+JSON.stringify({'@graph':[{'@type':'JobPosting',title:'Engineer',description:'Build agents',url:'https://example.test/job/1'}]})+'</script>';
 const r=careerJobPostings({html,source_url:'https://example.test/careers',company_id:1,company_name:'Fictional',collected_at:at});
 assert.equal(r.length,1);assert.equal(r[0].availability,'unknown');
 const imported=importedRoles(input().roles,'linkedin');assert.equal(imported[0].availability,'board-listed');assert.equal(imported[0].availability_source_url,null);
 assert.throws(()=>importedRoles([{...input().roles[0],collected_at:null}],'indeed'),/collected_at/);
});
test('actual CLI normalizes consent, writes private review files, and works with all network calls disabled',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'organizedai-gtm-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const i=input(),today=new Date().toISOString();
 i.roles[0].collected_at=today;i.roles[0].availability_checked_at=today;i.candidates[0].consent.recorded_at=today;i.contacts[0].checked_at=today;
 const files={'companies.json':i.companies,'roles.json':i.roles.map(r=>({...r,availability:'board-listed'})),'employer.json':i.roles,'contacts.json':i.contacts,'profile.json':i.candidates[0].profile,'consent.json':i.candidates[0].consent,
 'config.json':{campaign:i.campaign,companies:'companies.json',roles:'roles.json',employer_roles:'employer.json',contacts:'contacts.json',candidates:[{profile:'profile.json',consent:'consent.json'}]}};
 for(const [name,data] of Object.entries(files))fs.writeFileSync(path.join(dir,name),JSON.stringify(data));
 fs.writeFileSync(path.join(dir,'deny-network.mjs'),"globalThis.fetch=()=>{throw new Error('Network forbidden in draft preparation test')};");
 const cli=fileURLToPath(new URL('../prepare.mjs',import.meta.url));
 const run=()=>execFileSync(process.execPath,['--experimental-strip-types','--import',path.join(dir,'deny-network.mjs'),cli,'--config',path.join(dir,'config.json'),'--out',path.join(dir,'out')],{encoding:'utf8'});
 run();const report=JSON.parse(fs.readFileSync(path.join(dir,'out/campaign-review.json')));
 assert.equal(report.counts.specific_followups,1);assert.equal(report.outreach_status,'paused');assert.equal(report.counts.roles,1);
 assert.equal(report.accounts[0].hiring.candidate_matches[0].alternate_sources[0].source_kind,'import');
 assert.equal(fs.statSync(path.join(dir,'out/campaign-review.html')).mode&0o777,0o600);
 const handoff=fs.readFileSync(path.join(dir,'out/engram-handoff.json'),'utf8');assert.doesNotMatch(handoff,/Riley|ev-002|public_url/);
 i.candidates[0].consent.matching=false;fs.writeFileSync(path.join(dir,'consent.json'),JSON.stringify(i.candidates[0].consent));run();
 assert.doesNotMatch(fs.readFileSync(path.join(dir,'out/campaign-review.json'),'utf8'),/Riley|ev-002|public_url/);
});
test('real-world Greenhouse encoding is decoded as text, never executable markup',()=>{
 const s='&lt;p&gt;Seekr&#39;s role: &lt;strong&gt;AI&lt;/strong&gt; &amp;amp; APIs&amp;nbsp;&lt;/p&gt;';
 assert.equal(plainText(s),"Seekr's role: AI & APIs");
 assert.equal(plainText('&lt;script&gt;alert(1)&lt;/script&gt;Engineer'),'Engineer');
 assert.doesNotThrow(()=>plainText('&#99999999;'));
});
test('source merge deduplicates tracking variants without conflating separate jobs or companies',()=>{
 const uuid='381b3714-9e17-4190-973c-20f01bfadbb9';
 const old={...input().roles[0],source_url:'https://jobs.organizedai.vip/job/1',apply_url:`https://jobs.lever.co/acme/${uuid}?ref=board`,availability:'board-listed'};
 const current={...input().roles[0],id:'lever:acme:'+uuid,source_url:`https://jobs.lever.co/acme/${uuid}`,apply_url:`https://jobs.lever.co/acme/${uuid}/apply`};
 const r=mergeRoleSources([old],[current]);assert.equal(r.length,1);assert.equal(r[0].id,current.id);assert.equal(r[0].alternate_sources[0].id,'1');
  assert.equal(mergeRoleSources([old],[{...current,company_id:2}]).length,2);
  assert.notEqual(jobIdentity('https://www.seekr.com/careers/?gh_jid=1'),jobIdentity('https://www.seekr.com/careers/?gh_jid=2'));
  const ashby='344dfa55-e642-41d0-b85c-124c36f40940';
  const board={...old,id:'niceboard-ashby',source_url:'https://jobs.organizedai.vip/job/1',apply_url:`https://jobs.ashbyhq.com/polymarket/${ashby}/application?departmentId=abc`};
  const employer={...current,id:'ashby:polymarket:'+ashby,source_url:`https://jobs.ashbyhq.com/polymarket/${ashby}`,apply_url:`https://jobs.ashbyhq.com/polymarket/${ashby}/application`};
  assert.equal(mergeRoleSources([board],[employer]).length,1);
  assert.equal(jobIdentity(board.apply_url),`https://jobs.ashbyhq.com/polymarket/${ashby}?departmentId=abc`);
});
test('shared careers indexes do not conflate distinct openings',()=>{
 const a={...input().roles[0],id:'board-1',title:'Automation Engineer',source_url:'https://example.test/careers',apply_url:'https://example.test/apply/automation'};
 const b={...a,id:'employer-2',title:'Research Scientist',apply_url:'https://example.test/apply/scientist'};
 assert.equal(mergeRoleSources([a],[b]).length,2);
 assert.equal(mergeRoleSources([a],[{...b,title:a.title}]).length,2);
});
test('reviewed cross-provider role aliases merge with provenance and reject unsafe decisions',()=>{
 const board={...input().roles[0],id:'board-1',source_url:'https://jobs.organizedai.vip/job/1',apply_url:'https://builtin.com/job/agent-engineer/1',availability:'board-listed'};
 const employer={...input().roles[0],id:'ashby:acme:a',source_url:'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',apply_url:'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/application',source_kind:'ashby'};
 const decision={status:'reviewed-same-opening',canonical_id:employer.id,role_ids:[board.id,employer.id],source_urls:[board.apply_url,employer.source_url],reason:'Exact title and employer pages were reviewed.'};
 const r=reconcileRoleAliases([board,employer],[decision]);assert.equal(r.length,1);assert.equal(r[0].id,employer.id);assert.equal(r[0].alternate_sources[0].id,board.id);assert.equal(r[0].role_reconciliation.reason,decision.reason);
 for(const bad of [{...decision,role_ids:['missing',employer.id]},{...decision,canonical_id:'missing'},{...decision,source_urls:['javascript:bad']},{...decision,role_ids:[board.id,employer.id],reason:''}])assert.throws(()=>reconcileRoleAliases([board,employer],[bad]));
 assert.throws(()=>reconcileRoleAliases([board,{...employer,company_id:2}],[decision]),/mismatch/);
 assert.throws(()=>reconcileRoleAliases([board,{...employer,title:'Different'}],[decision]),/mismatch/);
 assert.throws(()=>reconcileRoleAliases([board,employer],[decision,decision]),/Overlapping/);
});
test('older employer snapshots cannot revive newer closed observations',()=>{
 const latest={...input().roles[0],availability:'closed',availability_checked_at:at,collected_at:at};
 const older={...latest,availability:'employer-confirmed',availability_checked_at:'2026-09-16T22:00:00Z',collected_at:'2026-09-16T22:00:00Z'};
 for(const rows of [[latest,older],[older,latest]])assert.equal(mergeRoleSources([rows[0]],[rows[1]])[0].availability,'closed');
});
test('closure findings follow merged aliases until a later confirmed reopening',()=>{
 const i=input();i.roles[0].alternate_sources=[{id:'board-previous'}];
 i.findings=[{roles:[{id:'board-previous'}],finding:{status:'no-current-openings-at-source',checked_at:'2026-09-17T22:30:00Z'}}];
 assert.equal(buildCampaign(i,now).counts.specific_followups,0);
 i.roles[0].availability_checked_at='2026-09-17T22:45:00Z';assert.equal(buildCampaign(i,now).counts.specific_followups,1);
});
test('duplicate closure findings keep the latest or undated closure in either order',()=>{
 const finding=checked_at=>({roles:[{id:1}],finding:{status:'no-current-openings-at-source',checked_at}});
 for(const dates of [['2026-09-17T22:30:00Z','2026-09-17T21:00:00Z'],[undefined,'2026-09-17T21:00:00Z'],['invalid','2026-09-17T21:00:00Z']]){
  for(const ordered of [dates,[...dates].reverse()]){
   const i=input();i.findings=ordered.map(finding);
   assert.equal(buildCampaign(i,now).counts.specific_followups,0);
   i.roles[0].availability_checked_at='2026-09-17T22:45:00Z';
   assert.equal(buildCampaign(i,now).counts.specific_followups,dates.every(d=>Number.isFinite(Date.parse(d)))?1:0);
  }
 }
});
test('malformed provider records cannot become confirmed openings',async()=>{
 await assert.rejects(greenhouse({board:'test',company_id:1},async()=>Response.json({meta:{total:1},jobs:[{title:'Engineer',absolute_url:'https://example.test/1'}]})),/Malformed/);
 await assert.rejects(lever({board:'test',company_id:1},async()=>Response.json([{id:'a',text:'',hostedUrl:'https://example.test/1'}])),/Malformed/);
});
test('campaign preserves role-title ranking and candidate targets cannot bypass evidence checks',()=>{
 const i=input(),base=i.roles[0];i.roles=[{...base,id:'generic',title:'Engineer',description:'Build agent workflows and automation for product operations.'},{...base,id:'specific',title:'Automation Engineer',description:'Build automation.'}];
 assert.equal(buildCampaign(i,now).accounts[0].hiring.candidate_matches[0].role_id,'specific');
 i.candidates[0].target_role_ids=['generic'];assert.equal(buildCampaign(i,now).accounts[0].hiring.candidate_matches[0].role_id,'generic');
 i.roles[0].title='AI Engineer / Scientist';assert.equal(buildCampaign(i,now).accounts[0].hiring.candidate_matches[0].role_id,'specific');
 i.roles[0].title='Engineer';i.roles[0].availability='closed';assert.equal(buildCampaign(i,now).accounts[0].hiring.candidate_matches[0].role_id,'specific');
});

test('excluded company identities disappear from openings, drafts and handoff',()=>{
 for(const selector of [{company_id:1},{company_name:'FICTIONAL'},{company_domain:'example.test'}]){
  const i=input();i.suppressed=[{...selector,exclude_from_campaign:true}];
  const r=buildCampaign(i,now);assert.equal(r.counts.roles,0);assert.equal(r.counts.companies,0);
  assert.deepEqual(r.accounts,[]);assert.deepEqual(engramHandoff(r).accounts,[]);
 }
 const i=input();i.companies.push({id:2,name:'Another',website:'https://another.test'});
 i.roles.push({...i.roles[0],id:2,company_id:2});i.suppressed=[{company_id:1,exclude_from_campaign:true}];
 const r=buildCampaign(i,now);assert.equal(r.counts.roles,1);assert.equal(r.accounts[0].company,'Another');
});
test('permission-first copy asks before sharing a candidate while retaining private fit review',()=>{
 const i=input();i.campaign.hiring_mode='permission-first';const r=buildCampaign(i,now),a=r.accounts[0];
 assert.ok(a.hiring.candidate_matches.length);assert.equal(r.counts.specific_followups,0);
 for(const d of a.drafts){assert.match(d.body,/may we.*send you relevant candidates/i);assert.doesNotMatch(d.body,/Riley|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);}
 assert.match(a.drafts[0].body,/independently of sponsorship/);
});
test('current employer permission unlocks only a consented confirmed candidate introduction',()=>{
 const i=input();i.campaign.hiring_mode='permission-first';i.employer_permissions=[{company_id:1,scope:'candidate-introductions',status:'approved',route_value:'hello@example.test',source:'crm-response-1',recorded_at:at}];
 let report=buildCampaign(i,now),a=report.accounts[0];assert.equal(a.hiring.candidate_introduction_permission.status,'approved');assert.equal(a.drafts[1].kind,'candidate-specific');
 assert.match(a.drafts[1].body,/Riley Okafor/);assert.match(a.drafts[1].body,/assessment\.organizedai\.vip/);assert.doesNotMatch(a.drafts[0].body,/may we.*send you relevant candidates/i);
 assert.doesNotMatch(a.drafts[1].body,/sponsor/i);
 assert.deepEqual(a.drafts[1].prerequisites,['employer-permission-current','candidate-consent-current','employer-opening-current','review-recipient-and-final-copy']);assert.equal(a.next_action,'review-permitted-candidate-introduction');
 assert.doesNotMatch(render(report),/crm-response-1/);assert.doesNotMatch(JSON.stringify(engramHandoff(report)),/crm-response-1|hello@example/);
 i.candidates[0].consent.revoked=true;a=buildCampaign(i,now).accounts[0];assert.equal(a.drafts[1].kind,'general-job-board-invitation');assert.deepEqual(a.drafts[1].prerequisites,['employer-permission-current','review-current-opening','review-recipient-and-final-copy']);
 i.candidates[0].consent.revoked=false;i.roles[0].availability='board-listed';a=buildCampaign(i,now).accounts[0];assert.equal(a.drafts[1].kind,'general-job-board-invitation');
});
test('latest decline, revocation, expiry or unverified response route cannot unlock an introduction',()=>{
 const base={company_id:1,scope:'candidate-introductions',status:'approved',route_value:'hello@example.test',source:'crm-response',recorded_at:at};
 for(const record of [{...base,status:'declined'},{...base,status:'revoked'},{...base,recorded_at:'2026-01-01T00:00:00Z'},{...base,expires_at:'2026-09-17T22:30:00Z'},{...base,route_value:'other@example.test'}]){
  const i=input();i.campaign.hiring_mode='permission-first';i.employer_permissions=[record];const a=buildCampaign(i,now).accounts[0],hiring=a.drafts.find(d=>d.stage==='hiring-follow-up');
  assert.notEqual(a.hiring.candidate_introduction_permission.status,'approved');
  if(['declined','revoked'].includes(record.status))assert.equal(hiring,undefined);else assert.equal(hiring.kind,'general-job-board-invitation');
 }
 const i=input();i.campaign.hiring_mode='permission-first';i.employer_permissions=[base,{...base,status:'declined',recorded_at:'2026-09-17T22:30:00Z'}];assert.equal(buildCampaign(i,now).accounts[0].hiring.candidate_introduction_permission.status,'declined');
});
test('declined or revoked introduction permission suppresses hiring drafts without suppressing sponsorship',()=>{
 const base={company_id:1,scope:'candidate-introductions',route_value:'hello@example.test',source:'crm-response',recorded_at:at};
 for(const status of ['declined','revoked']){
  const i=input();i.campaign.hiring_mode='permission-first';i.employer_permissions=[{...base,status}];const a=buildCampaign(i,now).accounts[0];
  assert.deepEqual(a.drafts.map(d=>d.stage),['sponsor-introduction']);assert.doesNotMatch(a.drafts[0].body,/may we.*send you relevant candidates/i);
  assert.equal(a.next_action,'review-sponsorship-copy');assert.ok(a.blockers.includes(`candidate-introductions-${status}`));
 }
});
test('malformed or unknown employer permission records fail closed',()=>{
 const base={company_id:1,scope:'candidate-introductions',status:'approved',route_value:'hello@example.test',source:'crm-response',recorded_at:at};
 for(const record of [{...base,company_id:99},{...base,scope:'sponsorship'},{...base,status:'maybe'},{...base,source:''},{...base,recorded_at:'future',expires_at:'invalid'},{...base,recorded_at:'2027-01-01T00:00:00Z'},{...base,expires_at:'2026-09-17T21:59:59Z'}]){
  const i=input();i.employer_permissions=[record];assert.throws(()=>buildCampaign(i,now));
 }
 for(const status of ['approved','declined']){
  const i=input();i.employer_permissions=[base,{...base,status,source:'another-response'}];assert.throws(()=>buildCampaign(i,now),/distinct recorded_at/);
 }
});
test('permission expiry is exclusive at the boundary and duplicate reviewed routes remain valid',()=>{
 const base={company_id:1,scope:'candidate-introductions',status:'approved',route_value:'hello@example.test',source:'crm-response',recorded_at:at};
 const i=input();i.campaign.hiring_mode='permission-first';i.contacts.push({...i.contacts[0],purpose:'recruiting',url:'https://example.test/careers'});
 i.employer_permissions=[{...base,route_value:' HELLO@EXAMPLE.TEST ',expires_at:'2026-09-17T23:00:00.001Z'}];assert.equal(buildCampaign(i,now).counts.specific_followups,1);
 i.employer_permissions=[{...base,expires_at:'2026-09-17T23:00:00.000Z'}];assert.equal(buildCampaign(i,now).counts.specific_followups,0);
});
test('permission recorded against a reconciled source company applies to the canonical account',()=>{
 const i=duplicateInput();i.campaign.hiring_mode='permission-first';i.employer_permissions=[{company_id:2,scope:'candidate-introductions',status:'approved',route_value:'hello@example.test',source:'crm-response',recorded_at:at}];
 assert.equal(buildCampaign(reconcileAccounts(i,[duplicateDecision]),now).counts.specific_followups,1);
});

function duplicateInput(){const i=input();i.companies.push({...i.companies[0],id:2});i.roles.push({...i.roles[0],id:2,company_id:2});i.contacts.push({...i.contacts[0],company_id:2});return i;}
const duplicateDecision={canonical_id:1,company_ids:[1,2],status:'reviewed-same-directory-company',source_url:'https://example.test/company',reason:'Same directory identity reviewed.'};
test('reviewed directory duplicates become one account with retained role/contact provenance',()=>{
 const i=reconcileAccounts(duplicateInput(),[duplicateDecision]);assert.equal(i.companies.length,1);
 assert.deepEqual(i.companies[0].source_company_ids,['1','2']);assert.equal(i.roles[1].original_company_id,'2');assert.equal(i.roles[1].company_id,'1');
 const r=buildCampaign(i,now);assert.equal(r.accounts.length,1);assert.equal(r.counts.roles,2);assert.equal(r.counts.reviewed_routes,1);assert.equal(r.duplicate_company_groups.length,0);
 assert.match(render(r),/Consolidated 2 directory records/);
});
test('unknown, overlapping and mismatched directory reconciliation is rejected',()=>{
 for(const decision of [{...duplicateDecision,canonical_id:3},{...duplicateDecision,company_ids:[1,3]},{...duplicateDecision,source_url:'https://other.test/company'}])assert.throws(()=>reconcileAccounts(duplicateInput(),[decision]));
 assert.throws(()=>reconcileAccounts(duplicateInput(),[duplicateDecision,duplicateDecision]));
 const i=duplicateInput();i.companies[1].name='Separate subsidiary';assert.throws(()=>reconcileAccounts(i,[duplicateDecision]),/identical names/);
});
test('suppression of a merged alias continues to exclude the entire account',()=>{
 for(const suppression of [{company_id:2,exclude_from_campaign:true},{company_domain:'alias.test',exclude_from_campaign:true}]){
  const i=duplicateInput();i.companies[1].website='https://alias.test';i.suppressed=[suppression];
  const r=buildCampaign(reconcileAccounts(i,[duplicateDecision]),now);assert.equal(r.counts.roles,0);assert.deepEqual(r.accounts,[]);
 }
 const i=duplicateInput();i.suppressed=[{company_id:2}];assert.equal(buildCampaign(reconcileAccounts(i,[duplicateDecision]),now).accounts[0].next_action,'suppressed');
});
test('distinct accounts sharing a contact route are flagged without exposing addresses in handoff',()=>{
 const i=duplicateInput();i.companies[1].name='Separate entity';i.companies[1].website='https://separate.test';const r=buildCampaign(i,now);
 assert.equal(r.shared_contact_routes.length,1);assert.ok(r.accounts.every(a=>a.blockers.includes('shared-contact-review')));
 assert.doesNotMatch(JSON.stringify(engramHandoff(r)),/hello@example/);
});

test('merged contact purposes retain sponsorship and hiring evidence in either order',()=>{
 for(const reversed of [false,true]){
  const i=duplicateInput();i.contacts[0].purpose='sponsorship';i.contacts[1].purpose='recruiting';i.contacts[1].url='https://example.test/careers';
  if(reversed)i.contacts.reverse();
  const a=buildCampaign(reconcileAccounts(i,[duplicateDecision]),now).accounts[0];
  assert.equal(a.sponsorship.routes.length,1);assert.equal(a.hiring.routes.length,1);
  assert.equal(a.sponsorship.routes[0].reviewed_purposes[0].purpose,'sponsorship');
  assert.equal(a.hiring.routes[0].reviewed_purposes[0].source_url,'https://example.test/careers');
 }
});

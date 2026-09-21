import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOfficialContactRoute} from '../partner-routes.mjs';
import {buildCampaign} from '../core.mjs';

const resolver = async () => [{address:'8.8.8.8'}];
const fetcher = async () => new Response('<footer><a href="mailto:hello@example.test">Contact us</a></footer>',{status:200});
const source = {company_id:'company-1',company_name:'Example',source_url:'https://example.test/',kind:'email',value:'hello@example.test',purpose:'general',name:'Example business contact',title_or_function:'Business contact',evidence_excerpt:'Contact us'};

test('collects an explicit public email only when the email appears in the saved source',async()=>{
  const result=await collectOfficialContactRoute(source,{fetcher,resolver,now:0});
  assert.equal(result.contact.kind,'email');
  assert.equal(result.contact.value,'hello@example.test');
  assert.equal(result.contact.verification,'published-route-needs-review');
  assert.equal(result.contact.recipient_approved,false);
  assert.equal(result.contact.outreach_authorized,false);
  assert.match(result.source_sha256,/^[a-f0-9]{64}$/);
});

test('rejects an email route that the official receipt does not actually publish',async()=>{
  await assert.rejects(collectOfficialContactRoute({...source,value:'other@example.test'},{fetcher,resolver}),/email was not found/);
});

test('provisional official contact routes never appear as campaign recipients',async()=>{
  const {contact}=await collectOfficialContactRoute(source,{fetcher,resolver,now:0});
  const campaign=buildCampaign({campaign:{id:'test',event_series:'Organized AI',sender_name:'Jordaaan',sponsor_url:'https://sponsor.organizedai.vip/',job_board_url:'https://jobs.organizedai.vip/',assessment_url:'https://assessment.organizedai.vip/'},companies:[{id:'company-1',name:'Example'}],roles:[],contacts:[contact]});
  assert.deepEqual(campaign.accounts[0].sponsorship.routes,[]);
  assert.match(campaign.accounts[0].blockers.join(' '),/sponsorship-contact-needed/);
});

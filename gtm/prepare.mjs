import fs from 'node:fs';
import path from 'node:path';
import {buildCampaign,engramHandoff} from './core.mjs';
import {render} from './render.mjs';
import {mergeRoleSources,reconcileRoleAliases} from './merge-sources.mjs';
import {reconcileAccounts} from './reconcile-accounts.mjs';
import {assertSafeReceipt,receiptSha256} from './receipts.mjs';
import {assertNoSecrets,assertNoLocalEvidenceLeaks,validateRawProfileV9,sanitizeProfile,validateProfileV9} from '../leaderboard/src/validate.js';

const argv=process.argv.slice(2);
if(argv.length%2)throw new Error('Expected --option value pairs');
const args=Object.fromEntries(argv.reduce((pairs,v,i,a)=>i%2?pairs:[...pairs,[v.replace(/^--/,''),a[i+1]]],[]));
for(const required of ['config','out'])if(!args[required])throw new Error('Usage: node --experimental-strip-types gtm/prepare.mjs --config campaign.json --out private-output');
const base=fs.realpathSync(path.dirname(path.resolve(args.config)));
const read=file=>JSON.parse(fs.readFileSync(path.resolve(base,file),'utf8'));
const receiptRoot=fs.realpathSync(path.resolve(base,'..'));
function validateContactReceipts(contacts){
  for(const contact of contacts){
    const hasReceipt='source_receipt' in contact,hasHash='source_sha256' in contact;
    if(!hasReceipt&&!hasHash)continue;
    if(!hasReceipt||!hasHash||typeof contact.source_receipt!=='string'||!contact.source_receipt.trim()||
      path.isAbsolute(contact.source_receipt)||!/^[a-f0-9]{64}$/i.test(contact.source_sha256??''))throw new Error('Invalid contact source receipt');
    const candidate=path.resolve(base,contact.source_receipt),candidateRelative=path.relative(receiptRoot,candidate);
    if(candidateRelative.startsWith('..'+path.sep)||path.isAbsolute(candidateRelative))throw new Error('Contact source receipt escapes campaign root');
    let receipt,body;try{receipt=fs.realpathSync(candidate);const relative=path.relative(receiptRoot,receipt);if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Contact source receipt escapes campaign root');body=fs.readFileSync(receipt);}catch(error){if(error instanceof Error&&error.message==='Contact source receipt escapes campaign root')throw error;throw new Error('Contact source receipt is unavailable');}
    assertSafeReceipt(body);
    const digest=receiptSha256(body);
    if(digest!==contact.source_sha256.toLowerCase())throw new Error('Contact source receipt hash mismatch');
  }
}
const config=read(path.basename(args.config));
const contactFiles=[];
if(config.contacts!==undefined)contactFiles.push(config.contacts);
if(config.contact_sources!==undefined){
  if(!Array.isArray(config.contact_sources)||config.contact_sources.some(file=>typeof file!=='string'||!file.trim()))throw new Error('contact_sources must be an array of non-empty JSON paths');
  contactFiles.push(...config.contact_sources);
}
const contactPaths=[...new Set(contactFiles.map(file=>{
  if(typeof file!=='string'||!file.trim())throw new Error('contacts must be a non-empty JSON path');
  return path.resolve(base,file);
}))];
const contacts=contactPaths.flatMap(file=>{
  const rows=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Array.isArray(rows))throw new Error('Each contact source must contain an array');
  return rows;
});
validateContactReceipts(contacts);
let input={campaign:config.campaign,companies:read(config.companies),roles:read(config.roles),
  contacts,findings:config.findings?read(config.findings):[],
  suppressed:config.suppressed?read(config.suppressed):[],employer_permissions:config.employer_permissions?read(config.employer_permissions):[],candidates:[]};
if(config.employer_roles)input.roles=mergeRoleSources(input.roles,read(config.employer_roles));
if(config.role_reconciliation)input.roles=reconcileRoleAliases(input.roles,read(config.role_reconciliation));
if(config.account_reconciliation)input=reconcileAccounts(input,read(config.account_reconciliation));
for(const c of config.candidates??[]){
  const profile=read(c.profile);
  assertNoSecrets(JSON.stringify(profile));assertNoLocalEvidenceLeaks(JSON.stringify(profile));
  validateRawProfileV9(profile);sanitizeProfile(profile);validateProfileV9(profile);
  if(c.target_role_ids && (!Array.isArray(c.target_role_ids)||c.target_role_ids.some(id=>typeof id!=='string')))throw new Error('target_role_ids must be strings');
  input.candidates.push({profile,consent:read(c.consent),target_role_ids:c.target_role_ids??[]});
}
const report=buildCampaign(input);
const out=path.resolve(args.out);
fs.mkdirSync(out,{recursive:true,mode:0o700});
for(const [name,value] of Object.entries({'campaign-review.json':JSON.stringify(report,null,2)+'\n','campaign-review.html':render(report),
  'engram-handoff.json':JSON.stringify(engramHandoff(report),null,2)+'\n'})){
  const file=path.join(out,name);fs.writeFileSync(file,value,{mode:0o600});fs.chmodSync(file,0o600);
}
console.log(JSON.stringify({output:out,...report.counts,outreach:report.outreach_status},null,2));

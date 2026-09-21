import fs from 'node:fs';
import path from 'node:path';
import {collectOfficialContactRoute} from './partner-routes.mjs';

const argv = process.argv.slice(2);
if (argv.length % 2) throw new Error('Expected --option value pairs');
const args = Object.fromEntries(argv.reduce((pairs,value,index,all) => index % 2 ? pairs : [...pairs,[value.replace(/^--/,''),all[index+1]]],[]));
for (const required of ['config','campaign-config','out']) if (!args[required]) throw new Error('Usage: node gtm/collect-official-contact-routes.mjs --config sources.json --campaign-config campaign.json --out private-route-output');
const sources = JSON.parse(fs.readFileSync(args.config,'utf8'));
if (!Array.isArray(sources.sources)) throw new Error('Expected sources array');
const campaignBase = fs.realpathSync(path.dirname(path.resolve(args['campaign-config'])));
const campaignWorkspace = path.resolve(campaignBase,'..');
const out = path.resolve(args.out);
const outputRelative = path.relative(campaignWorkspace,out);
if (outputRelative === '..' || outputRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelative)) throw new Error('Contact-route output must be inside campaign workspace');
fs.mkdirSync(path.join(out,'raw'),{recursive:true,mode:0o700});
const contacts = [], receipts = [];
for (const source of sources.sources) {
  const collected = await collectOfficialContactRoute(source);
  const receiptName = `${collected.source_sha256}.html`;
  const receiptPath = path.join(out,'raw',receiptName);
  fs.writeFileSync(receiptPath,collected.receipt,{mode:0o600});
  const relative = path.relative(campaignBase,receiptPath);
  if (!relative || path.isAbsolute(relative)) throw new Error('Contact receipt must be inside campaign workspace');
  contacts.push({...collected.contact,source_receipt:relative,source_sha256:collected.source_sha256});
  receipts.push({company_id:source.company_id,source_url:collected.contact.url,route:collected.contact.value,kind:collected.contact.kind,source_sha256:collected.source_sha256,checked_at:collected.contact.checked_at});
}
fs.writeFileSync(path.join(out,'provisional-contact-routes.json'),JSON.stringify(contacts,null,2)+'\n',{mode:0o600});
fs.writeFileSync(path.join(out,'receipt-manifest.json'),JSON.stringify(receipts,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({output:out,provisional_routes:contacts.length,status:'needs-human-review'},null,2));

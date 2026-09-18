import fs from 'node:fs';
import path from 'node:path';
import {greenhouse,lever,careerJobPostings,importedRoles} from './sources.mjs';
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,v,i,a)=>i%2?pairs:[...pairs,[v.replace(/^--/,''),a[i+1]]],[]));
if(!args.config||!args.out)throw new Error('Usage: node --experimental-strip-types gtm/collect-jobs.mjs --config sources.json --out jobs.json');
const config=JSON.parse(fs.readFileSync(args.config,'utf8'));
if(!Array.isArray(config.sources))throw new Error('Expected sources array');
const jobs=[],receipts=[];
for(const source of config.sources){
  let roles;
  if(source.kind==='greenhouse')roles=await greenhouse(source);
  else if(source.kind==='lever')roles=await lever(source);
  else if(source.kind==='career-jsonld')roles=careerJobPostings({...source,html:fs.readFileSync(path.resolve(path.dirname(args.config),source.file),'utf8')});
  else if(source.kind==='import')roles=importedRoles(JSON.parse(fs.readFileSync(path.resolve(path.dirname(args.config),source.file),'utf8')),source.provider);
  else throw new Error('Unsupported source kind');
  jobs.push(...roles);receipts.push({kind:source.kind,company_id:source.company_id??null,board:source.board??null,count:roles.length,checked_at:new Date().toISOString()});
}
fs.mkdirSync(path.dirname(path.resolve(args.out)),{recursive:true});
fs.writeFileSync(args.out,JSON.stringify(jobs,null,2)+'\n',{mode:0o600});
fs.writeFileSync(args.out+'.receipts.json',JSON.stringify(receipts,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({jobs:jobs.length,output:args.out}));

import fs from 'node:fs';
import path from 'node:path';
import {niceboardInventory} from './niceboard.mjs';

const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,v,i,a)=>i%2?pairs:[...pairs,[v.replace(/^--/,''),a[i+1]]],[]));
if(!args.out)throw new Error('Usage: node --experimental-strip-types gtm/collect-niceboard.mjs --out /absolute/output/directory');
const out=path.resolve(args.out),result=await niceboardInventory();
fs.mkdirSync(path.join(out,'raw'),{recursive:true,mode:0o700});
for(const page of result.pages)fs.writeFileSync(path.join(out,'raw',`${page.kind}-${String(page.index).padStart(3,'0')}.json`),page.body,{mode:0o600});
const sources=result.pages.map(({kind,index,url,count,rows,sha256})=>({kind,page:index,url,total:count,count:rows.length,sha256}));
const report={collected_at:result.collected_at,source:result.source,directory_companies:result.employers.length,
  live_jobs:result.roles.length,employers:result.employers.length,employers_with_live_jobs:result.employers.filter(e=>e.live_job_count).length,
  excluded_anonymous_jobs:result.excluded_anonymous_jobs,sources};
for(const [name,data] of [['employers.json',result.employers],['roles.json',result.roles],['inventory-report.json',report]])
  fs.writeFileSync(path.join(out,name),JSON.stringify(data,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({output:out,employers:result.employers.length,roles:result.roles.length,pages:result.pages.length}));

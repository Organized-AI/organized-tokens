import test from 'node:test';
import assert from 'node:assert/strict';
import {niceboardInventory} from '../niceboard.mjs';

const company=i=>({id:i,name:`Company ${i}`,slug:`company-${i}`,site_url:`https://company-${i}.test`,jobs_count:i===1?'1':'0'});
const job=(id=9,companyId=1)=>({id,title:'AI Engineer',slug:'ai-engineer',company_id:companyId,company_name:`Company ${companyId}`,company_slug:`company-${companyId}`,
  apply_url:'https://company-1.test/apply',location_name:'Austin',is_remote:true,published_at:'2026-09-17T00:00:00Z',expires_on:'2026-10-17T00:00:00Z',description_html:'<p>Build &amp; verify AI systems.</p>'});
function fetcher({companies=[company(1)],jobs=[job()],companyCount=companies.length,jobCount=jobs.length}={}){
  return async url=>{const u=new URL(url),kind=u.pathname.endsWith('/companies')?'companies':'jobs',page=Number(u.searchParams.get('page'));
    const rows=kind==='companies'?companies:jobs,count=kind==='companies'?companyCount:jobCount,start=(page-1)*30;
    return Response.json({[kind]:rows.slice(start,start+30),count});};
}
test('collects complete Niceboard inventory with provenance and normalized roles',async()=>{
  const r=await niceboardInventory(fetcher(),Date.parse('2026-09-18T00:00:00Z'));
  assert.equal(r.employers.length,1);assert.equal(r.roles.length,1);assert.equal(r.pages.length,2);
  assert.equal(r.pages[0].sha256.length,64);assert.equal(r.employers[0].live_job_count,1);
  assert.equal(r.roles[0].description,'Build & verify AI systems.');assert.match(r.roles[0].source_url,/jobs\.organizedai\.vip\/job\/9-ai-engineer-company-1/);
});
test('rejects unstable totals, incomplete pages, duplicates and unknown companies',async()=>{
  const thirty=Array.from({length:30},(_,i)=>company(i+1));
  await assert.rejects(niceboardInventory(fetcher({companies:thirty,companyCount:31})),/Incomplete/);
  await assert.rejects(niceboardInventory(fetcher({companies:[company(1),company(1)]})),/duplicate/);
  await assert.rejects(niceboardInventory(fetcher({jobs:[job(9,2)]})),/absent companies/);
  let companyCalls=0;const changing=async url=>{const kind=new URL(url).pathname.endsWith('/companies')?'companies':'jobs';
    if(kind==='companies'){companyCalls++;return Response.json({companies:thirty.slice((companyCalls-1)*30,companyCalls*30),count:companyCalls===1?31:30});}
    return Response.json({jobs:[job()],count:1});};
  await assert.rejects(niceboardInventory(changing),/total changed/);
});
test('rejects provider failures and oversized responses',async()=>{
  await assert.rejects(niceboardInventory(async()=>new Response('',{status:503})),/503/);
  const huge='x'.repeat(8*1024*1024+1);
  await assert.rejects(niceboardInventory(async()=>new Response(huge)),/exceeds 8 MB/);
});

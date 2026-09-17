import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {proofRoutes} from '../src/proof.ts';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/profile-v9.sample.json',import.meta.url)));
function setup(){
 const writes=[];
 const env = {
  DB: {
   prepare(sql) {
    return {
     bind(...args) {
      return {
       async first() { return { n: 1 }; },
       async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
      };
     },
    };
   },
  },
 };
 const auth=async()=>({token_hash:'synthetic-only',handle:'test-person',workshop_id:'test',open:1});
 return {env,auth,writes};
}
function request(body,visibility='private'){
 return new Request('https://assessment.example/api/assessment?visibility='+visibility,{method:'POST',body:JSON.stringify(body)});
}
test('canonical schema v9 profile passes server intake; private by default',async()=>{
 const {env,auth,writes}=setup();
 const response=await proofRoutes(request(fixture),env,auth);
 assert.equal(response?.status,201);
 assert.equal((await response.json()).visibility,'private');
 assert.equal(writes.length,1);
 assert.equal(writes[0].args[5],'private');
});
test('explicit public submission preserves selected visibility',async()=>{
 const {env,auth,writes}=setup();
 const response=await proofRoutes(request(fixture,'public'),env,auth);
 assert.equal(response?.status,201);
 assert.equal(writes[0].args[5],'public');
});
test('unauthenticated and closed-workshop submissions never write',async()=>{
 for(const identity of [null,{open:0}]){
  const {env,writes}=setup();
  const response=await proofRoutes(request(fixture),env,async()=>identity);
  assert.equal(response?.status,identity?403:401);assert.equal(writes.length,0);
 }
});
test('credentials and raw private data are rejected before storage',async()=>{
 for(const change of [{name:'sk-proj-'+ 'x'.repeat(30)},{raw_transcript:'confidential'},{name:'/Users/private-person/repo'}]){
  const {env,auth,writes}=setup();
  const response=await proofRoutes(request({...fixture,...change}),env,auth);
  assert.equal(response?.status,422);assert.equal(writes.length,0);
 }
});
test('actual body size is bounded even without content-length',async()=>{
 const {env,auth,writes}=setup();
 const response=await proofRoutes(request({...fixture,name:'x'.repeat(600*1024)}),env,auth);
 assert.equal(response?.status,413);assert.equal(writes.length,0);
});
test('JSON escaping cannot bypass secret detection',async()=>{
 const {env,auth,writes}=setup();
 const raw=JSON.stringify({...fixture,name:'sk-proj-'+'X'.repeat(30)}).replace('sk-proj-','\\u0073k-proj-');
 const response=await proofRoutes(new Request('https://assessment.example/api/assessment',{method:'POST',body:raw}),env,auth);
 assert.equal(response?.status,422);assert.equal(writes.length,0);
});

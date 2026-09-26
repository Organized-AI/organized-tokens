import test from 'node:test';
import assert from 'node:assert/strict';
import {publicSharing} from '../public/public-sharing.js';
function setup(transport){
 const ids=['publish-assessment','public-consent','public-status','public-result','public-url','public-url-text','public-management','public-new-link'];
 const element=()=>({children:[],hidden:true,checked:true,listeners:{},addEventListener(n,f){this.listeners[n]=f;},append(node){this.children.push(node);}});
 const controls=Object.fromEntries(ids.map(id=>[id,element()]));const doc={querySelector:s=>controls[s.slice(1)],createElement:element};
 const memory=new Map(),storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};
 let profile={name:'Fictional candidate',value:1};const sharing=publicSharing(doc,transport,storage,()=>profile,()=>true);
 return {controls,memory,sharing,setProfile(p){profile=p;sharing.reset();}};
}
test('private recovery download exists before dispatch and survives a lost response',async()=>{
 let s;
 s=setup(async()=>{assert.equal(s.controls['public-management'].children.length,1);throw new Error('Connection lost');});
 assert.equal(await s.sharing.publish(),null);
 assert.match(s.controls['public-status'].textContent,/may already be public/);assert.equal(s.controls['public-management'].children.length,1);
 assert.match(s.controls['public-management'].children[0].children[0].href,/^blob:/);
});
test('confirmed tombstone permits an explicit new link but does not republish silently',async()=>{
 const ids=[];let calls=0;
 const s=setup(async(_url,options)=>{const body=JSON.parse(options.body);ids.push(body.id);calls++;return calls===1?Response.json({error:'Removed'},{status:410}):Response.json({url:'https://assessment.organizedai.vip/p/'+body.id},{status:201});});
 await s.sharing.publish();assert.equal(calls,1);assert.equal(s.controls['public-new-link'].hidden,false);
 await s.controls['public-new-link'].listeners.click();assert.equal(calls,2);assert.notEqual(ids[0],ids[1]);assert.equal(s.controls['public-management'].children.length,2);
});
test('late response cannot label an earlier report as the newly selected assessment',async()=>{
 let finish,started;
 const dispatched=new Promise(resolve=>{started=resolve;});
 const s=setup(async(_url,options)=>{const body=JSON.parse(options.body);started();return new Promise(resolve=>{finish=()=>resolve(Response.json({url:'https://assessment.organizedai.vip/p/'+body.id}));});});
 const pending=s.sharing.publish();await dispatched;s.setProfile({name:'Second fictional candidate',value:2});finish();assert.equal(await pending,null);
 assert.equal(s.sharing.current(),null);assert.equal(s.controls['public-result'].hidden,true);assert.match(s.controls['public-status'].textContent,/earlier report was published/);assert.equal(s.controls['public-management'].children.length,1);
});

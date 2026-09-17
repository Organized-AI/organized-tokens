import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeFlow} from '../public/assessment-flow.js';

test('account submission requires current valid report, review and both consents; password is cleared',async()=>{
 const ids=['report-file','report-reviewed','report-result','candidate-form','candidate-retry','create-candidate','candidate-status','candidate-first','candidate-last','candidate-email','candidate-password','candidate-consent','candidate-terms','candidate-login','candidate-matches'];
 const controls=Object.fromEntries(ids.map(id=>[id,{checked:false,disabled:true,value:'',files:[],listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},reportValidity(){return true;},querySelectorAll(){return [];},replaceChildren(){},append(){}}]));
 const doc={querySelector:s=>controls[s.slice(1)],createElement:()=>({append(){}})};
 const memory=new Map();const storage={getItem:key=>memory.get(key),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
 const calls=[];const transport=async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('setup')?{enabled:true,consent_version:'version'}:{status:'created',matches:[],matching_status:'ready',notice:'Created'});};
 await initializeFlow(doc,transport,storage).ready;
 const file=controls['report-file'],review=controls['report-reviewed'],submit=controls['create-candidate'],form=controls['candidate-form'];
 review.checked=true;review.listeners.change();assert.equal(submit.disabled,true);
 const good=readFileSync(new URL('../public/example.html',import.meta.url),'utf8');file.files=[{size:good.length,text:async()=>good}];
 await file.listeners.change();assert.equal(review.checked,false);assert.equal(submit.disabled,true);assert.equal(calls.length,1);
 review.checked=true;review.listeners.change();assert.equal(submit.disabled,false);
 const event={preventDefault(){}};await form.listeners.submit(event);assert.equal(calls.length,1);
 controls['candidate-consent'].checked=true;controls['candidate-terms'].checked=true;controls['candidate-password'].value='synthetic-only';
 await form.listeners.submit(event);assert.equal(calls.length,2);assert.equal(controls['candidate-password'].value,'');assert.equal(submit.disabled,true);assert.equal(memory.size,0);
 await form.listeners.submit(event);assert.equal(calls.length,2);
});
test('slow prior file validation cannot replace a newer invalid file',async()=>{
 const controls=Object.fromEntries(['report-file','report-reviewed','report-result','candidate-form','candidate-retry','create-candidate','candidate-status','candidate-first','candidate-last'].map(id=>[id,{checked:false,files:[],listeners:{},addEventListener(n,f){this.listeners[n]=f;}}]));
 const memory=new Map();const doc={querySelector:s=>controls[s.slice(1)]};
 await initializeFlow(doc,async()=>Response.json({enabled:true}),{getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)}).ready;
 const file=controls['report-file'];let finish;
 file.files=[{size:100,text:()=>new Promise(resolve=>{finish=resolve;})}];const slow=file.listeners.change();
 file.files=[{size:4,text:async()=>'oops'}];await file.listeners.change();
 finish(readFileSync(new URL('../public/example.html',import.meta.url),'utf8'));await slow;
 controls['report-reviewed'].checked=true;controls['report-reviewed'].listeners.change();assert.equal(controls['create-candidate'].disabled,true);
 assert.match(controls['report-result'].textContent,/Report not ready/);
});
test('a confirmed rejection allows corrected details with a fresh ID; unknown results do not',async()=>{
 const ids=['report-file','report-reviewed','report-result','candidate-form','candidate-retry','create-candidate','candidate-status','candidate-first','candidate-last','candidate-email','candidate-password','candidate-consent','candidate-terms','candidate-login','candidate-matches'];
 const controls=Object.fromEntries(ids.map(id=>[id,{checked:false,disabled:true,value:'',files:[],listeners:{},addEventListener(n,f){this.listeners[n]=f;},reportValidity(){return true;},querySelectorAll(){return [];},replaceChildren(){},append(){}}]));
 const doc={querySelector:s=>controls[s.slice(1)],createElement:()=>({append(){}})};const memory=new Map();const storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
 const posts=[];let next='rejected';
 const transport=async(url,opts)=>{if(url.endsWith('setup'))return Response.json({enabled:true,consent_version:'version'});posts.push(JSON.parse(opts.body));return Response.json({status:next,error:'Synthetic rejection'},{status:next==='rejected'?409:202});};
 await initializeFlow(doc,transport,storage).ready;
 const good=readFileSync(new URL('../public/example.html',import.meta.url),'utf8');controls['report-file'].files=[{size:good.length,text:async()=>good}];await controls['report-file'].listeners.change();
 for(const id of ['report-reviewed','candidate-consent','candidate-terms'])controls[id].checked=true;
 controls['report-reviewed'].listeners.change();controls['candidate-password'].value='synthetic-only';await controls['candidate-form'].listeners.submit({preventDefault(){}});
 const first=memory.get('assessment-registration-request');assert.equal(controls['candidate-retry'].hidden,false);
 controls['candidate-retry'].listeners.click();assert.notEqual(memory.get('assessment-registration-request'),first);assert.equal(controls['create-candidate'].disabled,false);
 next='outcome_unknown';controls['candidate-email'].value='corrected@example.test';controls['candidate-password'].value='synthetic-only';await controls['candidate-form'].listeners.submit({preventDefault(){}});
 const second=memory.get('assessment-registration-request');controls['candidate-retry'].listeners.click();assert.equal(memory.get('assessment-registration-request'),second);assert.equal(controls['create-candidate'].disabled,true);assert.equal(posts.length,2);
});

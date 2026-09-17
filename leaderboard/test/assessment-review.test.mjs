import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Exercise the production event handlers with browser-shaped file controls.
// No network or real candidate data is involved.
test('resume continuation requires a valid current file and explicit review',async()=>{
 const controls=Object.fromEntries(['report-file','report-reviewed','report-result','continue-resume'].map(id=>[id,{checked:false,disabled:id==='continue-resume',files:[],listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}}]));
 let destination;
 globalThis.document={querySelector:s=>controls[s.slice(1)]};
 globalThis.window={location:{assign:value=>{destination=value;}}};
 try {
  await import('../public/assessment-flow.js?review-test');
  const file=controls['report-file'],review=controls['report-reviewed'],next=controls['continue-resume'];
  review.checked=true;review.listeners.change();assert.equal(next.disabled,true);
  const good=readFileSync(new URL('../public/example.html',import.meta.url),'utf8');
  file.files=[{size:Buffer.byteLength(good),text:async()=>good}];
  await file.listeners.change();assert.equal(review.checked,false);assert.equal(next.disabled,true);
  assert.match(controls['report-result'].textContent,/Nothing was uploaded/);
  review.checked=true;review.listeners.change();assert.equal(next.disabled,false);
  next.listeners.click();assert.equal(destination,'https://jobs.organizedai.vip/seeker/signup');
  destination=undefined;
  let finish;
  file.files=[{size:good.length,text:()=>new Promise(resolve=>{finish=resolve;})}];
  const slow=file.listeners.change();
  file.files=[{size:4,text:async()=>'oops'}];await file.listeners.change();
  finish(good);await slow;
  review.checked=true;review.listeners.change();next.listeners.click();
  assert.equal(next.disabled,true);assert.equal(destination,undefined);
  assert.match(controls['report-result'].textContent,/Report not ready/);
 } finally {delete globalThis.document;delete globalThis.window;}
});

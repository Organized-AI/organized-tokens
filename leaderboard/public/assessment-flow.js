import {publicSharing} from './public-sharing.js';
import {parseProfileData,assertNoSecrets,assertNoLocalEvidenceLeaks,validateRawProfileV9,sanitizeProfile,validateProfileV9} from './validate-profile.js';
export function validateReport(text) {
 if(new TextEncoder().encode(text).length>2*1024*1024)throw new Error('The report is larger than 2 MB.');
 const profile=parseProfileData(text),serialized=JSON.stringify(profile);
 assertNoSecrets(serialized);assertNoLocalEvidenceLeaks(serialized);
 if(profile?.schema_version!==9||profile?.prompt_version!==8)throw new Error('Use the current Assessment v8 prompt to create a schema v9 report.');
 validateRawProfileV9(profile);sanitizeProfile(profile);validateProfileV9(profile);return profile;
}
export function initializeFlow(doc,transport=fetch,storage=sessionStorage){
 const el=id=>doc.querySelector('#'+id),file=el('report-file'),reviewed=el('report-reviewed'),result=el('report-result'),form=el('candidate-form'),submit=el('create-candidate'),status=el('candidate-status');
 let profile=null,selection=0,available=false,consentVersion='',attempted=false;
 const sharing=el('publish-assessment')?publicSharing(doc,transport,storage,()=>profile,()=>reviewed.checked):null;
 let mayCorrect=false;
 const newId=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
 let requestId=storage.getItem('assessment-registration-request');
 if(!/^[a-f0-9]{64}$/.test(requestId||'')){
  requestId=newId();
  storage.setItem('assessment-registration-request',requestId);
 }
 const update=()=>{submit.disabled=!(profile&&reviewed.checked&&available&&!attempted);sharing?.update();};
 reviewed.addEventListener('change',update);
 el('candidate-retry').addEventListener('click',()=>{
  if(!mayCorrect)return;
  requestId=newId();storage.setItem('assessment-registration-request',requestId);
  mayCorrect=false;attempted=false;el('candidate-retry').hidden=true;status.textContent='Correct your details and enter your password again. Existing accounts are never modified.';update();
 });
 file.addEventListener('change',async()=>{
  const version=++selection;profile=null;reviewed.checked=false;sharing?.reset();update();result.textContent='';
  const report=file.files?.[0];if(!report)return;
  try{
   if(report.size>2*1024*1024)throw new Error('The report is larger than 2 MB.');
   const text=await report.text();if(version!==selection)return;
   profile=validateReport(text);
   const names=(profile.name||'').trim().split(/\s+/);
   if(!el('candidate-first').value&&!el('candidate-last').value&&names.length>1){el('candidate-last').value=names.pop();el('candidate-first').value=names.join(' ');}
   result.textContent='The report passes structure and privacy-pattern checks. Its claims are not independently certified. Nothing has been uploaded yet.';result.className='msg ok';
  }catch(error){if(version!==selection)return;result.textContent='Report not ready: '+error.message;result.className='msg err';}
  update();
 });
 const ready=transport('/api/candidate-setup').then(r=>r.json()).then(setup=>{available=setup.enabled===true;consentVersion=setup.consent_version;if(!available)status.textContent='Automatic profile creation is being prepared. You can still create and review your assessment.';update();}).catch(()=>{status.textContent='Account setup is unavailable. Your report remains local.';});
 form.addEventListener('submit',async(event)=>{
  event.preventDefault();if(!profile||!reviewed.checked||!available||attempted||!form.reportValidity())return;
  if(!el('candidate-consent').checked||!el('candidate-terms').checked)return;
  attempted=true;update();
  const shared=el('public-consent')?.checked?await sharing?.publish():null;
  if(el('public-consent')?.checked&&!shared){attempted=false;update();return;}
  const body={request_id:requestId,profile,first_name:el('candidate-first').value,last_name:el('candidate-last').value,email:el('candidate-email').value,password:el('candidate-password').value,reviewed:true,employer_consent:el('candidate-consent').checked,terms_consent:el('candidate-terms').checked,consent_version:consentVersion,...(shared?{public_share_id:shared.id,public_share_token:shared.token}:{})};
  if(!body.employer_consent||!body.terms_consent)return;
  attempted=true;update();status.textContent='Creating your profile and finding opportunities…';status.className='msg';
  let response,data;
  try{response=await transport('/api/candidates/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});data=await response.json();}
  catch{data={status:'outcome_unknown',error:'The connection was interrupted. Your account may have been created. Sign in or recover your account before starting another signup.'};}
  finally{el('candidate-password').value='';body.password='';}
  result.textContent=shared?'You published the assessment and submitted your structured evidence for account creation and matching.':'You submitted the structured assessment for account creation and matching. The original HTML report was not attached to your profile.';
  status.textContent=data.notice||data.error||'Account creation could not be confirmed. Check the job board before trying again.';
  status.className=data.status==='created'?'msg ok':'msg err';
  // These responses are guaranteed to precede account creation. Keep the same request ID.
  if(response && [403,413,422,429,503].includes(response.status)){attempted=false;update();}
  el('candidate-login').hidden=false;
  if(data.status==='rejected'){mayCorrect=true;el('candidate-retry').hidden=false;}
  if(data.status==='created'){
   storage.removeItem('assessment-registration-request');
   for(const input of form.querySelectorAll('input,button'))input.disabled=true;
   renderMatches(doc,data.matches||[],data.matching_status);
  }
 });
 return {ready};
}
export function renderMatches(doc,matches,matchingStatus){
 const root=doc.querySelector('#candidate-matches');root.replaceChildren();root.hidden=false;
 const add=(parent,tag,text)=>{const node=doc.createElement(tag);node.textContent=text;parent.append(node);return node;};
 add(root,'h2','Opportunities supported by your work');
 add(root,'p',matchingStatus==='unavailable'?'Job matching is temporarily unavailable. Your account is ready.':matchingStatus==='already_created'?'Your account was already created. Sign in or browse current jobs; this check did not run matching again.':matches.length?'These are potential fits based on overlapping work evidence. Confirm the full requirements with each employer.':'No sufficiently supported overlap was found in the current roles. This is a limit of the available evidence and matching rules, not a judgment of your abilities.');
 for(const match of matches){
  const card=add(root,'article','');card.className='match-card';
  const title=add(card,'h3',`${match.title} · ${match.company}`);void title;
  add(card,'p',match.location||'Location not specified');
  for(const reason of match.reasons){add(card,'p',`${reason.capability} — evidence ${reason.evidence_ids.join(', ')}${reason.delivery_states?.length?' ('+reason.delivery_states.join(', ')+')':''}. Role text mentions: “${reason.job_excerpt}”`);}
  for(const limit of match.limits)add(card,'p',limit);
  const link=add(card,'a','Read the role →');link.href=match.url;link.target='_blank';link.rel='noopener noreferrer';
 }
}
if(typeof document!=='undefined')initializeFlow(document);

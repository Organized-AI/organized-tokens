const bytes=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');
const digest=async(text)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export function publicSharing(doc,transport,storage,getProfile,getReviewed){
 const el=id=>doc.querySelector('#'+id);let busy=false,current=null,generation=0,mayReplace=null;const recoveries=new Set();
 const update=()=>{el('publish-assessment').disabled=busy||!getProfile()||!getReviewed()||!el('public-consent').checked;};
 el('public-consent').addEventListener('change',update);
 function recovery(state,profile){
  if(recoveries.has(state.id))return;
  const url='https://assessment.organizedai.vip/p/'+state.id;
  const manage='https://assessment.organizedai.vip/manage-assessment.html#id='+state.id+'&token='+state.token;
  const download=URL.createObjectURL(new Blob(['PUBLIC ASSESSMENT\n'+url+'\n\nPRIVATE MANAGEMENT LINK — keep this private\n'+manage+'\n\nThe publication request may still be pending. Keep this link even if the connection fails. It removes public access; saved copies cannot be recalled.\n'],{type:'text/plain'}));
  const item=doc.createElement('li'),link=doc.createElement('a');link.textContent='Save private management link: '+(profile.name||'assessment')+' ('+state.id.slice(0,8)+')';link.href=download;link.download='assessment-management-'+state.id.slice(0,8)+'.txt';item.append(link);el('public-management').append(item);recoveries.add(state.id);
 }
 async function publish(){
  const profile=getProfile();if(!profile||!getReviewed()||!el('public-consent').checked||busy)return null;
  const selectedGeneration=generation;let sent=false,uncertain=false;
  busy=true;update();el('public-status').textContent='Publishing your reviewed assessment…';
  try{
   const fingerprint=await digest(JSON.stringify(profile)),key='assessment-share:'+fingerprint;
   if(selectedGeneration!==generation)return null;
   let state;try{state=JSON.parse(storage.getItem(key)||'null');}catch{}
   if(!state||!/^[a-f0-9]{32}$/.test(state.id)||!/^[a-f0-9]{64}$/.test(state.token)){state={id:bytes(16),token:bytes(32)};storage.setItem(key,JSON.stringify(state));}
   // Recovery is available before dispatch, including if publication succeeds
   // but the response is lost. Keep prior reports' management links visible.
   recovery(state,profile);
   sent=true;uncertain=true;
   const response=await transport('/api/public-assessments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:state.id,manage_token:state.token,profile,reviewed:true,publish_consent:true,consent_version:'public-assessment-2026-09-17'})});
   const data=await response.json();uncertain=response.status>=500;
   if(!response.ok){
    if(response.status===410&&selectedGeneration===generation){mayReplace={key,generation};el('public-new-link').hidden=false;}
    throw new Error(data.error||'Publication could not be confirmed.');
   }
   const expected='https://assessment.organizedai.vip/p/'+state.id;
   if(data.url!==expected){uncertain=true;throw new Error('Unexpected public link.');}
   if(selectedGeneration!==generation){el('public-status').textContent='The earlier report was published. Its private management link remains below. Review the current report before publishing it.';return null;}
   current={...state,url:data.url,fingerprint};el('public-url').href=data.url;el('public-url-text').value=data.url;el('public-result').hidden=false;
   el('public-status').textContent='Your public assessment link is ready. Save its private management link before closing this tab.';
   return current;
  }catch(error){el('public-status').textContent=(error.message||'Connection interrupted.')+(sent&&uncertain?' The earlier request may already be public. Save its private management link below; retrying uses the same URL.':'');return null;}
  finally{busy=false;update();}
 }
 el('publish-assessment').addEventListener('click',publish);
 el('public-new-link').addEventListener('click',()=>{
  if(!mayReplace||mayReplace.generation!==generation||busy)return;
  storage.setItem(mayReplace.key,JSON.stringify({id:bytes(16),token:bytes(32)}));mayReplace=null;el('public-new-link').hidden=true;return publish();
 });
 return {update,publish,reset(){generation++;current=null;mayReplace=null;el('public-new-link').hidden=true;el('public-result').hidden=true;el('public-status').textContent='';update();},current:()=>current};
}

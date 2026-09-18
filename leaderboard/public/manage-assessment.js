const params=new URLSearchParams(location.hash.slice(1)),id=params.get('id'),token=params.get('token');
history.replaceState(null,'',location.pathname);
const button=document.querySelector('#remove'),status=document.querySelector('#status');
const valid=/^[a-f0-9]{32}$/.test(id||'')&&/^[a-f0-9]{64}$/.test(token||'');
button.disabled=!valid;if(!valid)status.textContent='Open the complete private management link you saved when publishing.';
button.addEventListener('click',async()=>{
 if(!valid)return;button.disabled=true;status.textContent='Removing public access…';
 try{const response=await fetch('/api/public-assessments/'+id,{method:'DELETE',headers:{authorization:'Bearer '+token}});const data=await response.json();if(!response.ok)throw new Error(data.error);status.textContent='Public access has been removed. The assessment URL no longer serves your report.';}
 catch(error){status.textContent=error.message||'Removal could not be confirmed. Try again.';button.disabled=false;}
});

import {httpsUrl,text} from './core.mjs';

/** Apply reviewed duplicate-directory decisions; never infer parent/subsidiary merges. */
export function reconcileAccounts(input, decisions) {
  if(!Array.isArray(decisions))throw new Error('Account reconciliation must be an array');
  const companies=new Map(input.companies.map(c=>[String(c.id),c]));
  if(companies.size!==input.companies.length)throw new Error('Duplicate company ID');
  const canonical=new Map(),groups=new Map();
  for(const d of decisions){
    const ids=d.company_ids?.map(String),target=String(d.canonical_id);
    if(d.status!=='reviewed-same-directory-company'||!text(d.reason)||!httpsUrl(d.source_url)||
      !Array.isArray(ids)||ids.length<2||new Set(ids).size!==ids.length||!ids.includes(target))throw new Error('Invalid account reconciliation');
    const records=ids.map(id=>companies.get(id));
    if(records.some(c=>!c)||ids.some(id=>canonical.has(id)))throw new Error('Unknown or overlapping reconciliation IDs');
    if(records.some(c=>text(c.name).toLowerCase()!==text(records[0].name).toLowerCase()||httpsUrl(c.source_url)!==httpsUrl(d.source_url)))throw new Error('Reconciliation needs identical names and directory source');
    for(const id of ids)canonical.set(id,target);
    groups.set(target,records);
  }
  const remap=row=>({...row,original_company_id:row.original_company_id??String(row.company_id),company_id:canonical.get(String(row.company_id))??String(row.company_id)});
  return {...input,
    companies:input.companies.filter(c=>!canonical.has(String(c.id))||canonical.get(String(c.id))===String(c.id)).map(c=>{
      const group=groups.get(String(c.id))??[c];
      return {...c,source_company_ids:group.map(c=>String(c.id)),company_sources:group.map(c=>({id:String(c.id),name:c.name,website:c.website,source_url:c.source_url}))};
    }),
    roles:input.roles.map(remap),contacts:(input.contacts??[]).map(remap),
    suppressed:(input.suppressed??[]).map(s=>s.company_id==null?s:{...s,company_id:canonical.get(String(s.company_id))??String(s.company_id)}),
  };
}

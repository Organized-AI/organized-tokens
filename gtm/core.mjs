import {createHash} from 'node:crypto';
import {matchJobs} from '../leaderboard/src/job-matching.ts';
import {sanitizeProfile} from '../leaderboard/src/validate.js';
import {plainText} from './text.mjs';

export const VERSION = 'organized-ai-sponsor-hiring/v1';
export const DAY = 86400000;
/** Consent uses the same normalized assessment representation as the importer. */
export function digest(value) {
  const normalized=structuredClone(value);sanitizeProfile(normalized);
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  return createHash('sha256').update(JSON.stringify(stable(normalized))).digest('hex');
}
export const text = plainText;
export function httpsUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}
export function fresh(at, now, days = 7) {
  const t = Date.parse(at);
  return Number.isFinite(t) && t <= now && now - t <= days * DAY;
}

/** Keep collection state separate from independent employer availability checks. */
export function normalizeRole(role) {
  const url = httpsUrl(role.source_url);
  if (!role.id || !role.company_id || !text(role.title) || !url) throw new Error('Role needs id, company_id, title and HTTPS source_url');
  const state = role.availability ?? 'board-listed';
  if (!['board-listed', 'employer-confirmed', 'closed', 'unknown'].includes(state)) throw new Error('Invalid role availability');
  return {
    id: String(role.id), company_id: String(role.company_id), company_name: text(role.company_name),
    original_company_id: String(role.original_company_id??role.company_id),
    title: text(role.title), description_html: text(role.description ?? role.description_html),
    location_name: text(role.location ?? role.location_name), expires_on: role.expires_on ?? '',
    apply_url: httpsUrl(role.apply_url), source_url: url, source_kind: role.source_kind ?? 'import',
    collected_at: role.collected_at, availability: state,
    availability_checked_at: role.availability_checked_at ?? null,
    availability_source_url: httpsUrl(role.availability_source_url),
    source_sha256: role.source_sha256 ?? null,
    alternate_sources: Array.isArray(role.alternate_sources) ? role.alternate_sources : [],
  };
}

function roleState(role, now) {
  if (role.availability === 'closed' || (role.expires_on && Date.parse(role.expires_on) <= now)) return 'closed';
  if (!fresh(role.collected_at, now)) return 'stale';
  return role.availability === 'employer-confirmed' && fresh(role.availability_checked_at, now) && role.availability_source_url
    ? 'employer-confirmed' : 'needs-employer-check';
}

function contactRoute(contact, now) {
  const source = httpsUrl(contact.url);
  const kind = contact.kind;
  const profile = kind === 'professional-profile' ? httpsUrl(contact.value) : null;
  const publicProfileReviewed = contact.verification === 'public-professional-profile-and-role-reviewed' && profile &&
    /(^|\.)linkedin\.com$/i.test(new URL(profile).hostname) && /^\/in\/[^/]+\/?$/i.test(new URL(profile).pathname) &&
    /^[a-f0-9]{64}$/i.test(contact.sha256 ?? '') && text(contact.evidence_excerpt);
  if (!source || !contact.value || (contact.verification !== 'employer-published-role-and-route-reviewed' && !publicProfileReviewed)) return null;
  if (!fresh(contact.checked_at, now, 30)) return null;
  const value = kind === 'email' ? String(contact.value).trim().toLowerCase() : httpsUrl(contact.value);
  if (!value || (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return null;
  if (!['email', 'professional-profile', 'web-route'].includes(kind)) return null;
  const purpose = text(contact.purpose);
  const role = text(contact.title_or_function);
  const sponsor = ['partnerships', 'sponsorship', 'general'].includes(purpose) ||
    (purpose === 'person' && /founder|chief executive|\bCEO\b|partnership|marketing/i.test(role));
  const hiring = ['recruiting', 'general'].includes(purpose) ||
    (purpose === 'person' && /founder|\bCTO\b|technology|engineering|people|talent|recruit/i.test(role));
  return {kind, value, name: text(contact.name), function: role, purpose, sponsorship_suitable: sponsor,
    hiring_suitable: hiring, source_url: source, checked_at: contact.checked_at,
    evidence_excerpt: text(contact.evidence_excerpt), deliverability: 'not-tested', recipient_approved: false};
}

function candidateConsent(candidate, now) {
  if (!candidate) return false;
  const {profile, consent} = candidate;
  return !!(profile && consent && consent.matching === true && consent.public_link_in_drafts === true &&
    consent.revoked !== true && consent.profile_sha256 === digest(profile) &&
    /^https:\/\/assessment\.organizedai\.vip\/p\/[a-f0-9]{32}$/.test(consent.public_url ?? '') &&
    text(consent.source) && Number.isFinite(Date.parse(consent.recorded_at)) && Date.parse(consent.recorded_at) <= now);
}

function validateEmployerPermission(record,companyIds,now) {
  if(!record||typeof record!=='object'||!companyIds.has(String(record.company_id)))throw new Error('Employer permission has unknown company_id');
  if(record.scope!=='candidate-introductions')throw new Error('Invalid employer permission scope');
  const recorded=Date.parse(record.recorded_at),expires=record.expires_at?Date.parse(record.expires_at):null;
  if(!['approved','declined','revoked'].includes(record.status)||!text(record.source)||!text(record.route_value)||
    !Number.isFinite(recorded)||recorded>now||(record.expires_at&&(!Number.isFinite(expires)||expires<=recorded)))throw new Error('Invalid employer permission record');
}

function candidateIntroductionPermission(records,companyIds,routes,now) {
  const values=new Set(routes.map(route=>route.value.toLowerCase()));
  const scoped=records.filter(record=>companyIds.has(String(record.company_id)))
    .sort((a,b)=>Date.parse(b.recorded_at)-Date.parse(a.recorded_at));
  if(!scoped.length)return {status:'not-recorded'};
  if(scoped.length>1&&Date.parse(scoped[0].recorded_at)===Date.parse(scoped[1].recorded_at))throw new Error('Employer permission records need distinct recorded_at values');
  const latest=scoped[0],recorded=Date.parse(latest.recorded_at),expires=latest.expires_at?Date.parse(latest.expires_at):recorded+90*DAY;
  const route=text(latest.route_value).toLowerCase();
  const approved=latest.status==='approved'&&recorded<=now&&expires>now&&now-recorded<=90*DAY&&values.has(route);
  return {status:approved?'approved':latest.status==='approved'?'expired-or-route-unverified':latest.status,
    scope:latest.scope,route_value:latest.route_value,source:text(latest.source),recorded_at:latest.recorded_at,
    expires_at:latest.expires_at??new Date(recorded+90*DAY).toISOString()};
}

function limits(profile) {
  return [...new Set([
    'Work-topic overlap is not proof of every job requirement, eligibility, or a hiring decision.',
    'Confirm required technologies, seniority, location, work authorization, availability and compensation.',
    text(profile.profile_view?.matching?.not_shown?.summary),
    ...(profile.matching_index?.risk_gaps ?? []).map(g => text(g.implication)),
  ].filter(Boolean))];
}

function matchCandidate(candidate, roles, now) {
  if (!candidateConsent(candidate, now)) return [];
  const {profile, consent} = candidate;
  const arcs = new Map((profile.work_arcs ?? []).map(a => [a.id, a]));
  const eligible=roles.filter(role=>!['closed','stale'].includes(roleState(role,now)));
  const preferred=new Set(candidate.target_role_ids??[]);
  const byId=new Map(eligible.map(r=>[r.id,r]));
  const ranked=[];
  // Preserve shared matcher's role-title ranking. Explicit candidate interests
  // reorder supported matches; they never bypass evidence or source checks.
  for(const confirmed of [true,false])for(const targeted of [true,false]){
    const group=eligible.filter(r=>(roleState(r,now)==='employer-confirmed')===confirmed&&preferred.has(r.id)===targeted);
    ranked.push(...matchJobs(profile,group,now));
  }
  const matches = ranked.map(match => {
    const role=byId.get(match.id),state=roleState(role,now);
    return {candidate: text(profile.name), public_url: consent.public_url, profile_sha256: consent.profile_sha256,
      role_id: role.id, role_title: role.title, role_url: role.source_url, apply_url: role.apply_url,
      source_kind: role.source_kind, collected_at: role.collected_at, availability: state,
      alternate_sources: role.alternate_sources,
      availability_checked_at: role.availability_checked_at, availability_source_url: role.availability_source_url,
      reasons: match.reasons.map(r => ({...r, work: r.arc_ids.map(id => arcs.get(id)).filter(Boolean).map(a => ({
        id: a.id, label: text(a.label), delivery_state: a.delivery_state,
        authorship: a.authorship, verification_mode: a.verification_mode,
        summary: text(a.evidence?.[0]),
      }))})), limits: limits(profile), review_status: 'needs-human-fit-review'};
  });
  const seen = new Set();
  return matches.filter(m => {const k = `${m.role_title.toLowerCase()}|${m.apply_url ?? m.role_url}`; if (seen.has(k)) return false; seen.add(k); return true;}).slice(0,3);
}

function validateCampaign(campaign) {
  if (!/^[a-z0-9][a-z0-9_-]{2,80}$/.test(campaign.id ?? '')) throw new Error('Campaign needs a stable id');
  for (const key of ['sponsor_url', 'job_board_url', 'assessment_url']) {
    if (!httpsUrl(campaign[key])) throw new Error(`Invalid campaign ${key}`);
  }
  if (!text(campaign.event_series) || !text(campaign.sender_name)) throw new Error('Campaign needs event_series and sender_name');
  if (campaign.event_url && !httpsUrl(campaign.event_url)) throw new Error('Invalid event URL');
  if(campaign.hiring_mode && !['candidate-specific','permission-first'].includes(campaign.hiring_mode))throw new Error('Invalid hiring mode');
}

/** Pure draft preparation. No connector calls, sends, imports, signups or scheduling. */
export function buildCampaign({campaign, companies, roles, contacts = [], candidates = [], findings = [], suppressed = [], employer_permissions = []}, now = Date.now()) {
  validateCampaign(campaign);
  if (![companies, roles, contacts, candidates, findings, suppressed, employer_permissions].every(Array.isArray)) throw new Error('Inputs must be arrays');
  const allCompanyIds=new Set(companies.flatMap(c=>[String(c.id),...(c.source_company_ids??[]).map(String)]));
  for(const record of employer_permissions)validateEmployerPermission(record,allCompanyIds,now);
  const excludedCompanies=new Set(companies.filter(c=>suppressed.some(s=>s.exclude_from_campaign===true&&(
    (s.company_id!=null&&[String(c.id),...(c.source_company_ids??[]).map(String)].includes(String(s.company_id)))||
    (s.company_name&&text(s.company_name).toLowerCase()===text(c.name).toLowerCase())||
    (s.company_domain&&[c,...(c.company_sources??[])].some(source=>httpsUrl(source.website)&&new URL(source.website).hostname.replace(/^www\./,'').toLowerCase()===text(s.company_domain).toLowerCase()))
  ))).map(c=>String(c.id)));
  companies=companies.filter(c=>!excludedCompanies.has(String(c.id)));
  roles=roles.filter(r=>!excludedCompanies.has(String(r.company_id)));
  const closures=new Map();
  for(const f of findings.filter(f=>f.finding?.status==='no-current-openings-at-source')){
    const checked=Date.parse(f.finding.checked_at);
    for(const role of f.roles??[]){
      const id=String(role.id),previous=closures.get(id);
      // An undated closure cannot establish a subsequent reopening. Otherwise
      // retain the latest closure, regardless of the input's ordering.
      if(!closures.has(id)||!Number.isFinite(checked)||(Number.isFinite(previous)&&checked>previous))closures.set(id,Number.isFinite(checked)?checked:null);
    }
  }
  const normalized = roles.map(normalizeRole).map(r => {
    const closed=[r.id,...r.alternate_sources.map(s=>String(s.id))].filter(id=>closures.has(id));
    const newerReopening=closed.length&&r.availability==='employer-confirmed'&&closed.every(id=>Number.isFinite(closures.get(id))&&Date.parse(r.availability_checked_at)>closures.get(id));
    return closed.length&&!newerReopening?{...r,availability:'closed'}:r;
  });
  const suppressedCompanies = new Set(suppressed.filter(s => s.company_id).map(s => String(s.company_id)));
  const suppressedRoutes = new Set(suppressed.filter(s => s.value).map(s => String(s.value).trim().toLowerCase()));
  const knownCompanies = new Set(companies.map(c => String(c.id)));
  if (normalized.some(r => !knownCompanies.has(r.company_id))) throw new Error('Role has unknown company_id');
  const identities = new Map();
  for (const c of companies) {
    const domain = httpsUrl(c.website) ? new URL(c.website).hostname.replace(/^www\./, '') : '';
    const key = text(c.name).toLowerCase() + '|' + domain;
    identities.set(key, [...(identities.get(key) ?? []), String(c.id)]);
  }
  const duplicates = [...identities.values()].filter(ids => ids.length > 1);
  const accounts = companies.map(company => {
    if (!company.id || !text(company.name)) throw new Error('Company needs id and name');
    const id = String(company.id), name = text(company.name);
    const isSuppressed = suppressedCompanies.has(id);
    const routes = contacts.filter(c => String(c.company_id) === id).map(c => contactRoute(c, now))
      .filter(c => c && !suppressedRoutes.has(c.value.toLowerCase()));
    // Filter by reviewed purpose before combining shared addresses. Keep every
    // source observation so merged directory records do not erase route evidence.
    const routeGroup=eligible=>{
      const byValue=new Map();
      for(const route of eligible){
        const key=route.value.toLowerCase(),existing=byValue.get(key);
        const evidence={purpose:route.purpose,function:route.function,source_url:route.source_url,checked_at:route.checked_at,evidence_excerpt:route.evidence_excerpt};
        if(existing)existing.reviewed_purposes.push(evidence);
        else byValue.set(key,{...route,reviewed_purposes:[evidence]});
      }
      return [...byValue.values()];
    };
    const sponsorRoutes = routeGroup(routes.filter(c => c.sponsorship_suitable));
    const hiringRoutes = routeGroup(routes.filter(c => c.hiring_suitable));
    const introductionPermission=candidateIntroductionPermission(employer_permissions,new Set([id,...(company.source_company_ids??[]).map(String)]),[...sponsorRoutes,...hiringRoutes],now);
    const companyRoles = normalized.filter(r => r.company_id === id);
    const active = companyRoles.filter(r => roleState(r, now) === 'employer-confirmed');
    const matches = isSuppressed ? [] : candidates.flatMap(c => matchCandidate(c, companyRoles, now));
    const best = matches.find(m => m.availability === 'employer-confirmed');
    const draftMatch=campaign.hiring_mode==='permission-first'?(introductionPermission.status==='approved'?best:null):best;
    const permissionRefused=['declined','revoked'].includes(introductionPermission.status);
    const opener = `Hi ${name} team,`;
    const permissionAsk=campaign.hiring_mode==='permission-first'&&introductionPermission.status!=='approved'&&!permissionRefused?`\n\nIf you're hiring, may we also send you relevant candidates from our pool of proven talent? Their assessments show coding-session work and the systems they've put to work. Candidate introductions are available independently of sponsorship. Explore the job board: ${campaign.job_board_url}`:'';
    const sponsorBody = `${opener}\n\nWould ${name} be interested in sponsoring ${text(campaign.event_series)}? We bring builders together for hands-on AI workshops and hackathons.\n\nSponsorship options, including product or credit contributions, are here: ${campaign.sponsor_url}${permissionAsk}\n\nWould you be the right person to discuss sponsorship, or could you point me to your partnerships team?\n\n${text(campaign.sender_name)}\nOrganized AI`;
    const hiringBody = draftMatch ? `${opener}\n\nYour ${best.role_title} listing describes work in ${best.reasons.map(r => r.topic).join(', ')}.\n\n${best.candidate} has assessment evidence of related work: ${best.reasons[0].work.map(w => `${w.label} (${w.delivery_state})`).join('; ')}. Their report includes coding-session evidence and the systems they put to work: ${best.public_url}\n\nThis is a potential fit to review, not a claim that every requirement is met. Would reviewing this profile or discussing an introduction be useful?\n\nYou can also find candidates through our job board: ${campaign.job_board_url}\n\n${text(campaign.sender_name)}\nOrganized AI`
      : introductionPermission.status==='approved' ? `${opener}\n\nThank you for confirming that Organized AI may send relevant candidates from our pool of proven talent. We do not yet have a current evidence-supported match to share.\n\nIf you send a current role and the work you need someone to demonstrate, we can check for a match. You can also find candidates through our job board: ${campaign.job_board_url}\n\n${text(campaign.sender_name)}\nOrganized AI`
      : `${opener}\n\nFollowing up on my sponsorship note: if you're also hiring AI practitioners, Organized AI connects companies with candidates whose assessments describe coding-session work and the systems they've put to work.\n\nExplore the job board: ${campaign.job_board_url}\nSee how the assessment works: ${campaign.assessment_url}\n\nMay we send you relevant candidates from our pool of proven talent? Share a current role and the work you need someone to demonstrate so we can check for a match.\n\n${text(campaign.sender_name)}\nOrganized AI`;
    const blockers = ['outreach-paused', 'recipient-and-copy-approval-required', 'delivery-channel-not-connected'];
    if (!sponsorRoutes.length) blockers.push('sponsorship-contact-needed');
    if (duplicates.some(ids => ids.includes(id))) blockers.push('duplicate-company-review');
    if (isSuppressed) blockers.push('company-suppressed');
    if(permissionRefused)blockers.push(`candidate-introductions-${introductionPermission.status}`);
    const action = isSuppressed ? 'suppressed' : draftMatch&&introductionPermission.status==='approved' ? 'review-permitted-candidate-introduction' : !sponsorRoutes.length ? 'research-sponsorship-contact'
      : permissionRefused ? 'review-sponsorship-copy'
      : matches.some(m => m.availability !== 'employer-confirmed') && !best ? 'verify-employer-opening'
      : best ? 'review-candidate-fit-and-copy' : 'review-sponsorship-copy';
    return {company_id: id, source_company_ids:company.source_company_ids??[id], company_sources:company.company_sources??[], company: name, website: httpsUrl(company.website), directory_url: httpsUrl(company.source_url),
      sponsorship: {status: isSuppressed ? 'suppressed' : 'uncontacted', routes: sponsorRoutes, intent: 'unknown'},
      hiring: {status: 'uncontacted', candidate_introduction_permission:introductionPermission, routes: hiringRoutes, confirmed_openings: active.length,
        listed_openings: companyRoles.filter(r => !['closed','stale'].includes(roleState(r, now))).length,
        unavailable_or_stale: companyRoles.filter(r => ['closed','stale'].includes(roleState(r, now))).map(r => ({id:r.id, status:roleState(r,now)})),
        candidate_matches: matches},
      drafts: isSuppressed ? [] : [
        {id:`${campaign.id}:${id}:sponsor`, stage:'sponsor-introduction', status:'draft', subject:`Sponsoring ${text(campaign.event_series)}`, body:sponsorBody},
        ...(!permissionRefused?[{id:`${campaign.id}:${id}:hiring`, stage:'hiring-follow-up', status:'draft', subject:draftMatch ? `Work evidence relevant to ${best.role_title}` : 'Hiring AI practitioners through Organized AI', body:hiringBody,
          prerequisites:draftMatch&&introductionPermission.status==='approved'?['employer-permission-current','candidate-consent-current','employer-opening-current','review-recipient-and-final-copy']
            :introductionPermission.status==='approved'?['employer-permission-current','review-current-opening','review-recipient-and-final-copy']
            :['sponsor-introduction-recorded-as-sent','no-opt-out-or-negative-response','review-recipient-and-current-role','approve-final-copy'],
          kind:draftMatch ? 'candidate-specific' : 'general-job-board-invitation'}]:[]),
      ], blockers, next_action:action};
  });
  const routeAccounts=new Map();
  for(const a of accounts.filter(a=>a.next_action!=='suppressed'))for(const r of a.sponsorship.routes){
    const key=r.value.toLowerCase();routeAccounts.set(key,[...(routeAccounts.get(key)??[]),a.company_id]);
  }
  const sharedRoutes=[...routeAccounts].filter(([,ids])=>new Set(ids).size>1).map(([value,ids])=>({value,company_ids:[...new Set(ids)]}));
  for(const a of accounts)if(sharedRoutes.some(r=>r.company_ids.includes(a.company_id)))a.blockers.push('shared-contact-review');
  return {schema:VERSION, campaign:{...campaign}, generated_at:new Date(now).toISOString(), outreach_status:'paused',
    counts:{companies:accounts.length, roles:normalized.length, reviewed_routes:accounts.reduce((n,a)=>n+a.sponsorship.routes.length,0),
      companies_with_matches:accounts.filter(a=>a.hiring.candidate_matches.length).length,
      specific_followups:accounts.filter(a=>a.drafts.some(d=>d.kind==='candidate-specific')).length},
    duplicate_company_groups:duplicates, shared_contact_routes:sharedRoutes, accounts};
}

export function engramHandoff(report) {
  const priority = account => {
    const confirmed = Number(account.hiring.confirmed_openings) || 0;
    const listed = Number(account.hiring.listed_openings) || 0;
    const missingRoute = account.sponsorship.routes.length === 0;
    const reasons = [];
    if (confirmed) reasons.push('employer-confirmed-openings');
    else if (listed) reasons.push('directory-listings-need-source-verification');
    if (missingRoute) reasons.push('sponsorship-route-missing');
    return {
      tier: confirmed && missingRoute ? 'high' : confirmed || missingRoute ? 'standard' : 'low',
      reasons,
      confirmed,
      listed,
      missingRoute,
    };
  };
  const accounts = report.accounts.filter(account => account.next_action !== 'suppressed').map(account => ({account, priority:priority(account)}))
    .sort((left,right) => right.priority.confirmed - left.priority.confirmed || Number(right.priority.missingRoute) - Number(left.priority.missingRoute) || right.priority.listed - left.priority.listed || left.account.company.localeCompare(right.account.company));
  return {schema:'organized-ai-engram-handoff/v1', generated_at:report.generated_at, mode:'review-only',
    campaign_id:report.campaign.id, required_capabilities:['account-research','contact-enrichment','crm-context'],
    connector:{status:'not-connected', transport:'streamable-http', discovery:'Use workspace Connectors → MCP Access and discover tools; do not assume tool names.'},
    constraints:['Do not send messages, import contacts, schedule sequences or create accounts.',
      'Keep sponsorship and hiring interest separate; suppress both on opt-out.',
      'Do not upload raw sessions or private assessment files.',
      'Verify current employer openings before candidate-specific follow-up.',
      'A reviewed contact source is not approval to contact that person.'],
    // Deliberately omit candidate identities/evidence and message bodies from third-party handoff.
    accounts:accounts.map(({account:a,priority})=>({company_id:a.company_id, company:a.company,
      website:a.website, next_action:a.next_action, research_priority:priority.tier, priority_reasons:priority.reasons,
      confirmed_opening_count:priority.confirmed, known_route_count:a.sponsorship.routes.length,
      listing_count:a.hiring.listed_openings, blockers:a.blockers}))};
}

/**
 * Organized Proof — additive routes for the leaderboard Worker.
 *
 * Serves both board.organizedai.vip and assessment.organizedai.vip from the
 * same Worker. Nothing here touches /api/join, /api/push, the Room DO, or
 * the projector board. Every route returns null for paths it does not own.
 *
 * Privacy: every signal is derived from columns already in `stats` and
 * already displayed publicly on the board. This is a rearrangement of counts,
 * not new collection. The board's notice holds verbatim.
 *
 * Talent directory: assessment profiles appear on /talent and on /@handle
 * only when the owner submitted them with visibility=public (typed `share`
 * in tokens.py). Submissions are validated in-Worker with the same checks
 * the published CLI runs (vendored ./validate.js) before anything is stored.
 */

// Vendored from Organized-AI/ai-work-assessment (src/validate.js); types in
// validate.d.ts. Pure ESM, no Node APIs; the exact checks the published CLI runs.
import {
  ProfileError,
  assertNoSecrets,
  assertNoLocalEvidenceLeaks,
  sanitizeProfile,
  validateProfileV9,
  validateRawProfileV9,
} from "./validate.js";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

type Who = { token_hash: string; workshop_id: string; handle: string; open: number } | null;
type AuthFn = (req: Request, env: Env) => Promise<Who>;

const SCHEMA_VERSION = 9;
const MAX_ASSESSMENT = 512 * 1024;

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const html = (b: string, status = 200) =>
  new Response(b, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

type Row = {
  handle: string; workshop_id: string; code: string;
  input: number | null; cache_read: number | null; turns: number | null;
  prompts: number | null; tool_calls: number | null; by_model: string; updated_at: number;
};

type Signal =
  | { id: string; label: string; absent: true }
  | { id: string; label: string; numerator: number; denominator: number; statement: string };

/** Same top-tier definition the tier-discipline tab uses (src/index.ts). */
const TOP_TIER = /opus|fable|gpt-5(?!-mini)/i;
function nonTopTurns(byModel: string): number | null {
  try {
    const m = JSON.parse(byModel || "{}") as Record<string, { turns?: number }>;
    const entries = Object.entries(m);
    if (!entries.length) return null;
    return entries.reduce((n, [name, v]) =>
      TOP_TIER.test(name) ? n : n + (v?.turns || 0), 0);
  } catch { return null; }
}

const pct = (n: number, d: number) => Math.round((n / d) * 100);

/** A signal with no denominator is ABSENT — never rendered as 0%. */
function buildSignals(r: Row): Signal[] {
  const out: Signal[] = [];
  const add = (id: string, label: string, num: number | null, den: number | null,
               fn: (n: number, d: number) => string) =>
    out.push(!den || num == null
      ? { id, label, absent: true }
      : { id, label, numerator: num, denominator: den, statement: fn(num, den) });

  add("cache_discipline", "CACHE DISCIPLINE", r.cache_read, r.input,
      (n, d) => `Cache reads were ${pct(n, d)}% of all input tokens.`);
  add("tier_discipline", "TIER DISCIPLINE", nonTopTurns(r.by_model), r.turns,
      (n, d) => `${pct(n, d)}% of turns ran on a model below the top tier.`);
  add("delegation_density", "DELEGATION DENSITY", r.tool_calls, r.turns,
      (n, d) => `${(n / d).toFixed(1)} tool calls per turn.`);
  add("direction_density", "DIRECTION DENSITY", r.prompts, r.turns,
      (n, d) => `${(n / d).toFixed(2)} prompts per turn.`);
  return out;
}

const GAPS: [string, string][] = [
  ["Subject matter", "No prompts, file paths, or project names reach this board. It cannot say what any of this work was about."],
  ["Outcome", "Nothing here indicates whether a tool call succeeded, a branch merged, or anything reached real use."],
  ["Industry", "Requires career context or work content. Neither is present in counts."],
  ["Quality or seniority", "Volume describes retained history. It is not a measure of skill and is never presented as one."],
  ["Intent", "A high cache share may be deliberate practice or one long unattended run. Counts cannot distinguish them."],
  ["Completeness", "Only the window the collector was running. Work on machines that never joined is invisible."],
];

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

/** NULLIF before COALESCE: a stored 0 is not null, and a bare COALESCE makes
 *  every fallback unreachable — "never recorded" renders as "recorded zero". */
async function loadRow(env: Env, handle: string): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT a.handle, a.workshop_id, w.code,
            NULLIF(s.input + s.cache_write + s.cache_read, 0) AS input,
            NULLIF(s.cache_read, 0)                           AS cache_read,
            NULLIF(s.turns, 0)      AS turns,
            NULLIF(s.prompts, 0)    AS prompts,
            NULLIF(s.tool_calls, 0) AS tool_calls,
            s.by_model, s.updated_at
       FROM attendees a
       JOIN stats s     ON s.token_hash = a.token_hash
       JOIN workshops w ON w.id = a.workshop_id
      WHERE a.handle = ?1
      ORDER BY s.updated_at DESC
      LIMIT 1`
  ).bind(handle).first<Row>();
}

async function hasAssessment(env: Env, handle: string): Promise<{ n: number; last: number } | null> {
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM assessments WHERE handle = ?1`
    ).bind(handle).first<{ n: number; last: number }>();
    return r && r.n ? r : null;
  } catch { return null; }   // table may not exist yet
}

/** Latest snapshot + totals for one handle. Visibility of the LATEST
 *  snapshot wins, so re-submitting privately unlists a public profile. */
async function loadLatestAssessment(env: Env, handle: string): Promise<
  { n: number; last: number; visibility: string; profile: any } | null
> {
  try {
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM assessments WHERE handle = ?1`
    ).bind(handle).first<{ n: number; last: number }>();
    if (!count || !count.n) return null;
    const row = await env.DB.prepare(
      `SELECT payload, visibility FROM assessments WHERE handle = ?1
       ORDER BY snapshot_seq DESC LIMIT 1`
    ).bind(handle).first<{ payload: string; visibility: string }>();
    let profile: any = null;
    try { profile = row ? JSON.parse(row.payload) : null; } catch { profile = null; }
    return { n: count.n, last: count.last, visibility: row?.visibility || "private", profile };
  } catch { return null; }   // table may not exist yet
}

type TalentEntry = {
  handle: string; name: string; headline: string; fit: string; fit_summary: string;
  specialist: string; industries: string[]; subjects: string[]; capabilities: string[];
  shared_at: number; last_session: string;
};

/** Display fields only - never the raw payload, never evidence ids. */
function entryFromPayload(handle: string, raw: string, created_at: number): TalentEntry | null {
  try {
    const p = JSON.parse(raw);
    const pv = p?.profile_view || {};
    const mi = p?.matching_index || {};
    const labels = (list: any) =>
      (Array.isArray(list) ? list : []).map((x: any) => String(x?.label || "")).filter(Boolean);
    return {
      handle,
      name: String(p?.name || handle),
      headline: String(p?.headline || p?.focus || ""),
      fit: String(pv?.matching?.strongest_fit?.label || ""),
      fit_summary: String(pv?.matching?.strongest_fit?.summary || ""),
      specialist: String(pv?.matching?.add_specialist?.label || ""),
      industries: labels(pv?.industries),
      subjects: labels(pv?.subject_matter),
      capabilities: labels(mi?.capabilities),
      shared_at: created_at,
      last_session: String(p?.cadence?.last_session || p?.generated_at || ""),
    };
  } catch { return null; }
}

/** Latest public snapshot per handle. A bad row is skipped, never fatal. */
async function listPublicTalent(env: Env): Promise<TalentEntry[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT a.handle, a.payload, a.created_at
         FROM assessments a
         JOIN (SELECT handle, MAX(snapshot_seq) AS maxseq FROM assessments GROUP BY handle) latest
           ON latest.handle = a.handle AND latest.maxseq = a.snapshot_seq
        WHERE a.visibility = 'public'
        ORDER BY a.created_at DESC LIMIT 200`
    ).all<{ handle: string; payload: string; created_at: number }>();
    return (r.results || [])
      .map((row) => entryFromPayload(row.handle, row.payload, row.created_at))
      .filter((e): e is TalentEntry => !!e);
  } catch { return []; }   // table may not exist yet
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

const CSS = `
:root{--bg:#0e0d09;--s1:#1a1914;--s2:#111009;--bd:#2e2d28;--y:#f2c000;--teal:#1d9e75;
--coral:#d85a30;--tx:#d4d2c8;--mu:#888780;--dm:#5a5852;--m:'Space Mono',monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:15px/1.6 system-ui,-apple-system,sans-serif;
-webkit-font-smoothing:antialiased}
.w{max-width:720px;margin:0 auto;padding:40px 22px 80px}
.back{font-family:var(--m);font-size:11px;color:var(--dm);text-decoration:none}
h1{font-family:var(--m);font-size:28px;color:var(--y);margin:14px 0 0}
.sub{font-family:var(--m);font-size:10.5px;color:var(--dm);margin-top:8px;letter-spacing:1px}
h2{font-size:19px;color:var(--y);margin:38px 0 6px}
.lead{color:var(--mu);margin-bottom:16px;font-size:14px}
.sig{background:var(--s1);border:1px solid var(--bd);border-radius:6px;padding:14px 16px;margin-bottom:9px}
.sig .r{display:flex;align-items:baseline;gap:10px}
.sig .n{font-family:var(--m);font-size:11px;color:var(--teal);letter-spacing:1px}
.sig .f{margin-left:auto;font-family:var(--m);font-size:10px;color:var(--dm)}
.sig .s{margin-top:7px;font-size:14px;color:var(--tx)}
.bar{height:4px;background:#232219;border-radius:2px;margin-top:10px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--y)}
.abs{border-left:2px solid #444441;opacity:.7}
.abs .n{color:var(--dm)} .abs .s{color:var(--mu);font-style:italic}
.gaps{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.gap{background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:13px 14px}
.gap h4{font-family:var(--m);font-size:11px;color:var(--coral);margin:0 0 5px}
.gap p{font-size:12.5px;color:var(--mu);margin:0}
.esc{border:1px solid #0f6e56;background:rgba(29,158,117,.05);border-radius:6px;padding:18px 20px;margin-top:16px}
.esc h3{font-family:var(--m);font-size:12px;color:var(--teal);margin:0 0 8px;letter-spacing:1px}
.esc p{font-size:13.5px;color:var(--mu);margin:0 0 12px}
.esc pre{background:var(--s2);border:1px solid var(--bd);border-radius:5px;padding:12px 14px;
overflow-x:auto;font-family:var(--m);font-size:12px;color:var(--tx);margin:0}
.esc .fine{font-family:var(--m);font-size:10.5px;color:var(--dm);margin-top:10px}
.esc a{color:var(--y)}
.badge{display:inline-block;font-family:var(--m);font-size:9.5px;padding:2px 8px;border-radius:3px;
border:1px solid var(--bd);color:var(--dm);margin-left:8px}
.badge.on{color:var(--teal);border-color:#0f6e56}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.tag{font-family:var(--m);font-size:10px;letter-spacing:.06em;padding:3px 8px;border-radius:3px;
border:1px solid var(--bd);color:var(--mu)}
.tag.gold{color:var(--y);border-color:rgba(242,192,0,.4)}
.fit{background:var(--s1);border:1px solid var(--bd);border-left:3px solid var(--y);border-radius:6px;
padding:14px 16px;margin-bottom:9px}
.fit .k{font-family:var(--m);font-size:10.5px;color:var(--y);letter-spacing:1px}
.fit h5{font-size:15px;color:var(--tx);margin:5px 0 4px;font-weight:600}
.fit p{font-size:13px;color:var(--mu);margin:0}
.hero-q{font-size:15px;color:var(--tx);line-height:1.6;border-left:2px solid var(--y);
padding:2px 0 2px 14px;margin:10px 0 18px}
.lims{margin:6px 0 0;padding-left:18px}
.lims li{font-size:13px;color:var(--mu);margin-bottom:6px}
.shared{font-family:var(--m);font-size:10px;color:var(--dm);letter-spacing:1px;margin-top:14px}
@media(max-width:680px){.gaps{grid-template-columns:1fr}}
`;

function profilePage(r: Row, signals: Signal[], assessed: { n: number; last: number } | null, shared: any | null): string {
  const shown = signals.filter((s) => !("absent" in s)).length;
  const sig = signals.map((s) => {
    if ("absent" in s) return `<div class="sig abs">
      <div class="r"><span class="n">${esc(s.label)}</span><span class="f">no denominator</span></div>
      <div class="s">Not reported — this signal is absent rather than zero.</div></div>`;
    const w = Math.min(100, (s.numerator / s.denominator) * 100);
    return `<div class="sig">
      <div class="r"><span class="n">${esc(s.label)}</span>
        <span class="f">${s.numerator.toLocaleString()} / ${s.denominator.toLocaleString()}</span></div>
      <div class="s">${esc(s.statement)}</div>
      <div class="bar"><i style="width:${w}%"></i></div></div>`;
  }).join("");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${esc(r.handle)} — Organized AI</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="w">
  <a class="back" href="/">← leaderboard</a>
  <h1>@${esc(r.handle)}</h1>
  <div class="sub">${esc(r.code)}
    ${assessed
      ? `<span class="badge on">ASSESSMENT SHARED · ${assessed.n}</span>`
      : `<span class="badge">SESSION COUNTS</span>`}
  </div>

  ${shared ? assessmentSection(shared, assessed) : ""}

  <h2>How the agent gets operated</h2>
  <p class="lead">${shown} of ${signals.length} reported. Each carries its numerator and
     denominator so the arithmetic is checkable. No percentile, ranking, or comparison
     against anyone else appears on this page.</p>
  ${sig}

  <h2>What this cannot tell you</h2>
  <p class="lead">Shown at the same weight as the signals, because it is the honest half
     of the picture and the reason the deeper run exists.</p>
  <div class="gaps">${GAPS.map(([h, b]) =>
    `<div class="gap"><h4>${esc(h)}</h4><p>${esc(b)}</p></div>`).join("")}</div>

  <div class="esc">
    <h3>// GO DEEPER</h3>
    <p>Work arcs need a model reading raw session history — a counter cannot do it.
       This runs locally, uploads nothing, and writes a report you keep.</p>
    <pre>npx github:Organized-AI/ai-work-assessment#v8.0.0-organized.1</pre>
    <div class="fine">See what it produces:
      <a href="https://assessment.organizedai.vip/example">an example profile</a></div>
  </div>
</div></body></html>`;
}

/** The shared assessment, rendered from the stored payload's visible contract
 *  (profile_view). Only called when the owner's latest snapshot is public. */
function assessmentSection(p: any, assessed: { n: number; last: number } | null): string {
  const pv = p?.profile_view || {};
  const m = pv?.matching || {};
  const industries = (Array.isArray(pv?.industries) ? pv.industries : [])
    .map((i: any) => String(i?.label || "")).filter(Boolean);
  const subjects = (Array.isArray(pv?.subject_matter) ? pv.subject_matter : [])
    .map((s: any) => String(s?.label || "")).filter(Boolean);
  const limits = (Array.isArray(pv?.limits) ? pv.limits : [])
    .map((l: any) => String(l?.summary || "")).filter(Boolean);
  const when = assessed?.last
    ? new Date(assessed.last * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";

  const fit = (k: string, label: string, body: string) => body ? `<div class="fit">
      <div class="k">${esc(k)}</div><h5>${esc(label)}</h5><p>${esc(body)}</p></div>` : "";

  return `
  <h2>AI Work Assessment</h2>
  ${p?.name ? `<p class="lead" style="color:var(--tx);font-size:16px;margin-bottom:2px"><b>${esc(p.name)}</b></p>` : ""}
  ${p?.headline ? `<p class="lead">${esc(p.headline)}</p>` : ""}
  ${pv?.hero?.thesis ? `<div class="hero-q">${esc(pv.hero.thesis)}</div>` : ""}
  ${fit("STRONGEST FIT", String(m?.strongest_fit?.label || ""), String(m?.strongest_fit?.summary || ""))}
  ${fit("ADD A SPECIALIST WHEN", String(m?.add_specialist?.label || ""), String(m?.add_specialist?.summary || ""))}
  ${fit("NOT SHOWN BY THE EVIDENCE", String(m?.not_shown?.label || ""), String(m?.not_shown?.summary || ""))}
  ${industries.length ? `<div class="tags">${industries.map((i: string) => `<span class="tag gold">${esc(i)}</span>`).join("")}</div>` : ""}
  ${subjects.length ? `<div class="tags">${subjects.map((s: string) => `<span class="tag">${esc(s)}</span>`).join("")}</div>` : ""}
  ${limits.length ? `<h2>Limits, stated by the assessment</h2><ul class="lims">${limits.map((l: string) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
  <div class="shared">SHARED BY THE OWNER · ${esc(when)} · VALIDATED AGAINST PROFILE SCHEMA 9 ON INTAKE</div>`;
}

function joinPage(code: string, name: string): string {
  const cmd = `curl -sL https://tokens.organizedai.vip/tokens.py -o tokens.py &amp;&amp; python3 tokens.py --join ${esc(code)} --as "Your Name"`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join — ${esc(name)}</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}
.w{max-width:460px;padding-top:28px}
.ini{background:var(--y);color:#0e0d09;font-family:var(--m);font-weight:700;padding:3px 8px;border-radius:3px;font-size:12px}
.step{background:var(--s1);border:1px solid var(--bd);border-left:2px solid var(--bd);border-radius:8px;padding:18px;margin-top:16px}
.step.a{border-left-color:var(--y)} .step.c{border-left-color:var(--dm)}
.n{font-family:var(--m);font-size:10.5px;letter-spacing:1.5px;color:var(--dm)} .step.a .n{color:var(--y)}
.step h2{font-size:17px;color:var(--tx);margin:7px 0 6px}
.step p{font-size:14px;color:var(--mu);margin-bottom:12px}
pre{background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:13px;overflow-x:auto;
font-family:var(--m);font-size:11.5px;line-height:1.55;color:var(--tx);margin-bottom:10px}
button{background:var(--y);color:#0e0d09;border:0;border-radius:6px;font-family:var(--m);font-size:14px;
font-weight:700;padding:14px;width:100%}
button.ghost{background:transparent;border:1px solid var(--bd);color:var(--mu)}
.msg{font-family:var(--m);font-size:12.5px;margin-top:10px;min-height:18px;color:var(--teal)}
.note{border-top:1px solid var(--bd);margin-top:28px;padding-top:16px;font-size:13px;color:var(--dm)}
.note b{color:var(--mu);font-weight:400}
</style></head><body><div class="w">
  <span class="ini">OP</span>
  <h1 style="font-size:25px">Get on the board</h1>
  <div class="sub">${esc(code)} · ${esc(name)}</div>

  <div class="step a">
    <div class="n">// 01 · REQUIRED</div>
    <h2>Join from your laptop</h2>
    <p>Your sessions live on your machine, so this has to run there. It prints the
       exact payload first and waits for you to type <code>join</code>.</p>
    <pre id="cmd">${cmd}</pre>
    <button id="copy">Copy command</button>
    <div class="msg" id="cm"></div>
  </div>

  <div class="step c">
    <div class="n">// 02 · THE DEEP ONE</div>
    <h2>Run the assessment</h2>
    <p>Counts show how you operate an agent. They cannot say what you built. That
       needs a model reading your session history — it runs locally and uploads
       nothing until you separately choose to share it.</p>
    <pre>npx github:Organized-AI/ai-work-assessment#v8.0.0-organized.1</pre>
    <button class="ghost" id="copy2">Copy command</button>
    <div class="msg" id="cm2"></div>
    <p style="margin-top:12px;font-size:13px;color:var(--dm)">See what it produces:
      <a style="color:var(--y)" href="https://assessment.organizedai.vip/example">an example profile</a></p>
  </div>

  <div class="note"><b>What leaves your machine:</b> counts and model names only. No
    prompts, file paths, or project names. Remove yourself any time with
    <code>python3 tokens.py --leave</code>.</div>
</div>
<script>
function cp(text,msgId){const m=document.getElementById(msgId);
  const done=()=>{m.textContent="Copied — paste it in your terminal.";setTimeout(()=>m.textContent="",2600);};
  if(navigator.clipboard)navigator.clipboard.writeText(text).then(done).catch(()=>{m.textContent="Select and copy manually.";});
  else m.textContent="Select and copy manually.";}
document.getElementById("copy").onclick=()=>cp(document.getElementById("cmd").textContent,"cm");
document.getElementById("copy2").onclick=()=>cp("npx github:Organized-AI/ai-work-assessment#v8.0.0-organized.1","cm2");
</script></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Assessment intake                                                   */
/* ------------------------------------------------------------------ */

/* Secret-pattern and local-evidence scanning now lives in the vendored
   validator (assertNoSecrets / assertNoLocalEvidenceLeaks), called on every
   intake above. A scrub that misses one pattern ships it — so the whole
   submission is rejected instead. */

/* ------------------------------------------------------------------ */
/* Talent directory                                                    */
/* ------------------------------------------------------------------ */

const TALENT_CSS = `
:root{--bg:#0c0b09;--panel:#1a1814;--card:#141210;--card2:#211e18;--line:#2a2520;
--text:#f0ece4;--muted:#a09888;--gold:#FFE94A;--gold2:#F5D623;--amber:#C4943D;
--mono:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;
--sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh}
a{color:inherit}
.topnav{position:sticky;top:0;z-index:10;background:rgba(12,11,9,.92);backdrop-filter:blur(6px);
border-bottom:1px solid var(--line)}
.nav-inner{max-width:1040px;margin:0 auto;padding:16px 20px;display:flex;align-items:center;
justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:13px;
font-weight:800;letter-spacing:.16em;text-transform:uppercase;text-decoration:none}
.brand img{width:30px;height:30px;border-radius:8px}
.brand .ai{color:var(--gold2)}
.nav-links{display:flex;gap:18px;font-family:var(--mono);font-size:11px;letter-spacing:.1em;
text-transform:uppercase}
.nav-links a{color:var(--muted);text-decoration:none}
.nav-links a.on{color:var(--gold2)}
.shell{max-width:1040px;margin:0 auto;padding:34px 20px 70px}
.eyebrow{color:var(--muted);font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase}
h1{font-size:clamp(28px,4vw,44px);font-weight:800;letter-spacing:-.01em;margin:6px 0 10px;text-wrap:balance}
.sub{color:var(--muted);font-size:14px;line-height:1.65;max-width:66ch;margin:0 0 18px}
.sub b{color:var(--text);font-weight:600}
.note{display:grid;grid-template-columns:auto 1fr;gap:12px 16px;align-items:start;
background:linear-gradient(135deg,rgba(245,214,35,.09),rgba(20,18,16,.8));
border:1px solid rgba(245,214,35,.25);border-left:3px solid var(--gold2);border-radius:6px;
padding:13px 16px;margin:0 0 26px;max-width:900px}
.note .k{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
color:var(--gold2);white-space:nowrap;padding-top:2px}
.note p{color:var(--muted);font-size:12.5px;line-height:1.55;margin:0}
.note b{color:var(--text);font-weight:600}
.searchrow{display:flex;align-items:center;gap:14px;margin-bottom:22px;flex-wrap:wrap}
#q{flex:1;min-width:240px;background:var(--card);border:1px solid var(--line);border-radius:6px;
padding:12px 14px;color:var(--text);font-family:var(--mono);font-size:13px;outline:none}
#q:focus{border-color:var(--gold2)}
#q::placeholder{color:var(--muted)}
.count{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:20px 22px;margin-bottom:14px}
.card:hover{border-color:#3a352d}
.card-top{display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap}
.name{font-size:17px;font-weight:700}
.name a{text-decoration:none}
.name a:hover{color:var(--gold)}
.handle{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.when{font-family:var(--mono);font-size:10.5px;color:var(--muted);letter-spacing:.05em;white-space:nowrap}
.headline{color:var(--muted);font-size:13.5px;line-height:1.6;margin:6px 0 14px}
.fit{background:var(--card2);border-left:3px solid var(--gold2);border-radius:5px;padding:11px 14px;margin-bottom:12px}
.fit .k{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;color:var(--gold2);text-transform:uppercase}
.fit .v{font-size:14px;font-weight:600;margin:3px 0 2px}
.fit .s{font-size:12.5px;color:var(--muted);line-height:1.55}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-family:var(--mono);font-size:10px;letter-spacing:.05em;padding:3px 9px;border-radius:3px;
border:1px solid var(--line);color:var(--muted)}
.tag.gold{color:var(--gold);border-color:rgba(245,214,35,.35)}
.card-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:14px;
padding-top:12px;border-top:1px solid var(--line);flex-wrap:wrap}
.caps{font-family:var(--mono);font-size:10.5px;color:var(--muted);letter-spacing:.03em}
.proflink{font-family:var(--mono);font-size:11px;color:var(--gold2);text-decoration:none;
letter-spacing:.08em;text-transform:uppercase}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:8px;padding:34px 26px;text-align:center}
.empty h3{font-size:16px;margin-bottom:8px}
.empty p{color:var(--muted);font-size:13px;line-height:1.6;max-width:52ch;margin:0 auto 14px}
.empty pre{display:inline-block;background:var(--bg);border:1px solid var(--line);border-radius:5px;
padding:10px 14px;font-family:var(--mono);font-size:12px;color:var(--gold2);text-align:left}
footer{max-width:1040px;margin:0 auto;padding:0 20px 40px;color:var(--muted);
font-family:var(--mono);font-size:10.5px;letter-spacing:.06em}
footer a{color:var(--muted)}
`;

function talentPage(entries: TalentEntry[]): string {
  const escAttr = esc;
  const cards = entries.map((e) => {
    const when = new Date(e.shared_at * 1000)
      .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const profileUrl = `https://assessment.organizedai.vip/@${encodeURIComponent(e.handle)}`;
    return `<div class="card">
  <div class="card-top">
    <div><span class="name"><a href="${escAttr(profileUrl)}">${esc(e.name)}</a></span>
      <span class="handle">@${esc(e.handle)}</span></div>
    <span class="when">shared ${esc(when)}</span>
  </div>
  ${e.headline ? `<div class="headline">${esc(e.headline)}</div>` : ""}
  ${e.fit ? `<div class="fit"><div class="k">Strongest fit</div><div class="v">${esc(e.fit)}</div>
    ${e.fit_summary ? `<div class="s">${esc(e.fit_summary)}</div>` : ""}</div>` : ""}
  ${e.industries.length ? `<div class="tags">${e.industries.map((i) => `<span class="tag gold">${esc(i)}</span>`).join("")}</div>` : ""}
  ${e.subjects.length ? `<div class="tags" style="margin-top:6px">${e.subjects.map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div>` : ""}
  <div class="card-foot">
    <span class="caps">${e.capabilities.length ? esc(e.capabilities.join(" · ")) : ""}</span>
    <a class="proflink" href="${escAttr(profileUrl)}">Full profile →</a>
  </div>
</div>`;
  }).join("\n");

  const empty = `<div class="empty">
  <h3>No shared profiles yet</h3>
  <p>Profiles appear here when someone runs the AI Work Assessment on their own
     machine and chooses <b>share</b> at submission. Nothing is listed any other way.</p>
  <pre>npx github:Organized-AI/ai-work-assessment#v8.0.0-organized.1</pre>
</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Talent — evidence-based AI work profiles | Organized AI</title>
<meta name="description" content="Public, owner-shared AI Work Assessment profiles: what people build with agents, how they verify it, and where they fit.">
<link rel="icon" href="https://organizedai.vip/IMG_1110.PNG">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${TALENT_CSS}</style></head><body>
<nav class="topnav"><div class="nav-inner">
  <a class="brand" href="/"><img src="https://organizedai.vip/IMG_1110.PNG" alt="Organized AI logo">ORGANIZED <span class="ai">AI</span></a>
  <div class="nav-links"><a href="/">Board</a><a class="on" href="/talent">Talent</a>
    <a href="https://assessment.organizedai.vip/">Assessment</a>
    <a href="https://jobs.organizedai.vip/">Jobs</a></div>
</div></nav>
<div class="shell">
  <div class="eyebrow">board.organizedai.vip/talent</div>
  <h1>Hire for evidence, not claims.</h1>
  <p class="sub">Every profile here ran <b>locally on its owner's machine</b> — their own agent
     history, GitHub activity, and optional career context — and was shared by explicit typed
     consent. No scores, no ranks, no percentiles: what they build, how they direct and verify
     agent work, the industries their work supports, and what the evidence does not show.</p>
  <div class="note"><span class="k">Consent</span>
    <p>A profile is listed only while its owner's <b>latest</b> submission is public. Re-submitting
       privately unlists it, and <b>python3 tokens.py --leave</b> removes everything. Cohort
       placement unlocks only at eight or more shared profiles — below that, publishing a
       distribution would re-identify people.</p></div>
  <div class="searchrow">
    <input id="q" type="search" placeholder="Search fit, industry, subject, capability…" autocomplete="off">
    <span class="count" id="count"></span>
  </div>
  <div id="cards">${entries.length ? cards : empty}</div>
</div>
<footer>ORGANIZED AI · PROFILES ARE OWNER-REVIEWED AND SELF-SHARED ·
  <a href="https://assessment.organizedai.vip/">RUN THE ASSESSMENT</a>
</footer>
<script>
var q = document.getElementById("q"), cards = document.getElementById("cards"),
    count = document.getElementById("count");
var all = Array.prototype.slice.call(cards.querySelectorAll(".card"));
function apply() {
  var needle = (q.value || "").toLowerCase(), shown = 0;
  all.forEach(function (c) {
    var hit = !needle || c.textContent.toLowerCase().indexOf(needle) !== -1;
    c.style.display = hit ? "" : "none";
    if (hit) shown++;
  });
  count.textContent = all.length ? shown + " / " + all.length + " profiles" : "";
}
if (q) q.addEventListener("input", apply);
apply();
</script>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * Returns a Response for routes this module owns, or null so the existing
 * router runs. Never throws — the board renders as normal if this fails.
 */
export async function proofRoutes(req: Request, env: Env, auth: AuthFn): Promise<Response | null> {
  try {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- assessment.organizedai.vip root -> the configurator ---------
    // The board root is untouched: this only fires on the assessment host.
    if (path === "/" || path === "/index.html") {
      // html_handling is "none", so "/" must be mapped explicitly on every host.
      const page = url.hostname.startsWith("assessment.") ? "/assess.html" : "/index.html";
      return env.ASSETS.fetch(new Request(new URL(page, url), req));
    }

    // --- base prompt, proxied from the pinned distribution tag --------
    // Served from here so the page can fetch it same-origin, and so the
    // text is always the contract at v8.0.0 rather than a vendored copy
    // that drifts. Nothing is modified server-side; the page prepends the
    // "Source choices for this run" block the prompt itself defines.
    if (path === "/apply/prompt.md" && req.method === "GET") {
      const up = await fetch(
        "https://raw.githubusercontent.com/Organized-AI/ai-work-assessment/v8.0.0-organized.1/prompt.md",
        { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit
      );
      if (!up.ok) return new Response("upstream prompt unavailable", { status: 502 });
      return new Response(await up.text(), {
        headers: { "content-type": "text/markdown; charset=utf-8",
                   "cache-control": "public, max-age=3600" },
      });
    }

    // --- branding seam for a self-hosted render (src/config.js upstream)
    if (path === "/apply/config.json") {
      return json({ siteName: "Organized AI",
                    siteUrl: "https://assessment.organizedai.vip/",
                    accentColor: "#F2C000" });
    }

    // --- the full sample profile ------------------------------------
    if (path === "/example" || path === "/example/") {
      return env.ASSETS.fetch(new Request(new URL("/example.html", url), req));
    }

    // --- QR landing: /j/<CODE> ---------------------------------------
    const j = path.match(/^\/j\/([A-Za-z0-9-]{1,32})\/?$/);
    if (j && req.method === "GET") {
      const w = await env.DB.prepare(`SELECT code, name FROM workshops WHERE code = ?1`)
        .bind(j[1].toUpperCase()).first<{ code: string; name: string }>();
      if (!w) return html("<p style='font-family:monospace;padding:40px'>no workshop for that code</p>", 404);
      return html(joinPage(w.code, w.name));
    }

    // --- one participant: /@handle -----------------------------------
    const h = path.match(/^\/@([^/]{1,64})$/);
    if (h && req.method === "GET") {
      const handle = decodeURIComponent(h[1]);
      const row = await loadRow(env, handle);
      if (!row) return html("<p style='font-family:monospace;padding:40px'>not found</p>", 404);
      const latest = await loadLatestAssessment(env, handle);
      const shared = latest && latest.visibility === "public" ? latest.profile : null;
      return html(profilePage(row, buildSignals(row),
        latest ? { n: latest.n, last: latest.last } : null, shared));
    }

    // --- talent directory: the hiring surface --------------------------
    if ((path === "/talent" || path === "/talent/") && req.method === "GET") {
      if (url.hostname.startsWith("assessment.")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://board.organizedai.vip/talent" },
        });
      }
      return html(talentPage(await listPublicTalent(env)));
    }
    if (path === "/api/talent" && req.method === "GET") {
      const profiles = await listPublicTalent(env);
      return json({ count: profiles.length, profiles });
    }

    // --- assessment intake: bearer-authenticated, consent via ?visibility=
    // ?visibility=public lists the profile on /talent and /@handle; anything
    // else stores privately (cohort-only). Validated with the vendored
    // schema-v9 checks before anything is stored.
    if (path === "/api/assessment" && req.method === "POST") {
      const who = await auth(req, env);
      if (!who) return json({ error: "unknown token" }, 401);
      if (!who.open) return json({ error: "workshop closed" }, 403);

      const len = Number(req.headers.get("content-length") || 0);
      if (len > MAX_ASSESSMENT) return json({ error: "too large" }, 413);

      const raw = await req.text();
      const visibility = url.searchParams.get("visibility") === "public" ? "public" : "private";

      let body: any;
      try {
        assertNoSecrets(raw);
        assertNoLocalEvidenceLeaks(raw);
        body = JSON.parse(raw);
        // The same sequence the published CLI runs: raw contract, sanitize,
        // then the full schema-v9 validator.
        validateRawProfileV9(body);
        sanitizeProfile(body);
        if (Number(body?.schema_version) !== SCHEMA_VERSION) {
          return json({ error: "schema_version_mismatch", expected: SCHEMA_VERSION }, 422);
        }
        const arcs = body.work_arcs || body.arcs;
        if (!Array.isArray(arcs) || !arcs.length) return json({ error: "no_work_arcs" }, 422);
        validateProfileV9(body);
      } catch (e: any) {
        if (e instanceof ProfileError) {
          return json({ error: e.error || e.message, code: e.code }, e.status || 422);
        }
        if (e instanceof SyntaxError) return json({ error: "bad json" }, 400);
        throw e;
      }

      // Strip anything the collector attached for its own use; keep the contract.
      delete body._cohort; delete body._handle;

      const seq = await env.DB.prepare(
        `SELECT COALESCE(MAX(snapshot_seq), 0) + 1 AS n FROM assessments WHERE handle = ?1`
      ).bind(who.handle).first<{ n: number }>();

      const created = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO assessments (id, handle, workshop_id, snapshot_seq, payload, visibility, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(crypto.randomUUID(), who.handle, who.workshop_id, seq?.n || 1,
             JSON.stringify(body), visibility, created).run();

      return json({ ok: true, handle: who.handle, snapshot_seq: seq?.n || 1, visibility,
                    url: `https://assessment.organizedai.vip/@${encodeURIComponent(who.handle)}` }, 201);
    }

    if (path === "/api/assessment" && req.method === "DELETE") {
      const who = await auth(req, env);
      if (!who) return json({ error: "unknown token" }, 401);
      const r = await env.DB.prepare(`DELETE FROM assessments WHERE handle = ?1 AND workshop_id = ?2`)
        .bind(who.handle, who.workshop_id).run();
      return json({ ok: true, removed: r.meta?.changes ?? 0 });
    }

    return null;
  } catch {
    return null;
  }
}

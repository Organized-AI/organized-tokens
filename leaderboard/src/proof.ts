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
 */

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
@media(max-width:680px){.gaps{grid-template-columns:1fr}}
`;

function profilePage(r: Row, signals: Signal[], assessed: { n: number; last: number } | null): string {
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
    <pre>npx github:Runpoint-Partners/ai-work-assessment#v8.0.0</pre>
    <div class="fine">See what it produces:
      <a href="https://assessment.organizedai.vip/example">an example profile</a></div>
  </div>
</div></body></html>`;
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
    <pre>npx github:Runpoint-Partners/ai-work-assessment#v8.0.0</pre>
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
document.getElementById("copy2").onclick=()=>cp("npx github:Runpoint-Partners/ai-work-assessment#v8.0.0","cm2");
</script></body></html>`;
}

/* ------------------------------------------------------------------ */
/* Assessment intake                                                   */
/* ------------------------------------------------------------------ */

const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/** Reject the whole submission. A scrub that misses one pattern ships it. */
const hasSecret = (raw: string) => SECRETS.some((re) => re.test(raw));

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
      return html(profilePage(row, buildSignals(row), await hasAssessment(env, handle)));
    }

    // --- assessment intake: bearer-authenticated, typed-word gated client-side
    if (path === "/api/assessment" && req.method === "POST") {
      const who = await auth(req, env);
      if (!who) return json({ error: "unknown token" }, 401);
      if (!who.open) return json({ error: "workshop closed" }, 403);

      const len = Number(req.headers.get("content-length") || 0);
      if (len > MAX_ASSESSMENT) return json({ error: "too large" }, 413);

      const raw = await req.text();
      if (hasSecret(raw)) return json({ error: "secret_detected", stored: false }, 422);

      let body: any;
      try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
      if (Number(body?.schema_version) !== SCHEMA_VERSION) {
        return json({ error: "schema_version_mismatch", expected: SCHEMA_VERSION }, 422);
      }
      const arcs = body.work_arcs || body.arcs;
      if (!Array.isArray(arcs) || !arcs.length) return json({ error: "no_work_arcs" }, 422);

      // Strip anything the collector attached for its own use; keep the contract.
      delete body._cohort; delete body._handle;

      const seq = await env.DB.prepare(
        `SELECT COALESCE(MAX(snapshot_seq), 0) + 1 AS n FROM assessments WHERE handle = ?1`
      ).bind(who.handle).first<{ n: number }>();

      const created = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO assessments (id, handle, workshop_id, snapshot_seq, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(crypto.randomUUID(), who.handle, who.workshop_id, seq?.n || 1,
             JSON.stringify(body), created).run();

      return json({ ok: true, handle: who.handle, snapshot_seq: seq?.n || 1,
                    url: `${url.origin}/@${encodeURIComponent(who.handle)}` }, 201);
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

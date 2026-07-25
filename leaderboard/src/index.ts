/**
 * Organized Tokens — workshop leaderboard
 *
 * Accepts aggregate token counts from attendees who explicitly opted in,
 * ranks them, and pushes live updates to the projector.
 *
 * What this Worker will accept: token counts, turn counts, model names,
 * a handle, and a cost figure. That is the whole schema.
 *
 * What it rejects: anything else. Unknown fields on /api/push are dropped
 * before the row is written, not stored "just in case". If a future version
 * of the client sends prompt text by accident, it does not land here.
 */

export { Room } from "./room";

interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_SECRET: string;
}

const PUSH_MIN_INTERVAL = 20; // seconds between accepted pushes per attendee
const MAX_BODY = 16 * 1024;

const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(), ...extra },
  });

const cors = () => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
});

const now = () => Math.floor(Date.now() / 1000);

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Handles are shown on a projector. Keep them printable and short. */
function cleanHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 24);
  return h.length >= 2 ? h : null;
}

function int(v: unknown, max = 5_000_000_000): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

/**
 * Strip the by_model blob down to exactly the shape we store. Model names are
 * capped and sanitised because they end up rendered on a screen.
 */
function cleanByModel(raw: unknown): Record<string, { turns: number; cost_micros: number }> {
  const out: Record<string, { turns: number; cost_micros: number }> = {};
  if (!raw || typeof raw !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n++ >= 24) break;
    const name = String(k).replace(/[^\w.\-]/g, "").slice(0, 48);
    if (!name || !v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    out[name] = { turns: int(o.turns, 1_000_000), cost_micros: int(o.cost_micros) };
  }
  return out;
}

async function auth(req: Request, env: Env) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT a.token_hash, a.workshop_id, a.handle, w.open, w.started_at, w.ends_at
       FROM attendees a JOIN workshops w ON w.id = a.workshop_id
      WHERE a.token_hash = ?`
  ).bind(hash).first();
  return row as null | {
    token_hash: string; workshop_id: string; handle: string;
    open: number; started_at: number; ends_at: number | null;
  };
}

// ---------------------------------------------------------------------------
// Board computation
//
// Three boards, because ranking a tokenomics workshop by raw spend teaches
// exactly the wrong lesson. "Cache discipline" is the one that rewards the
// behaviour the workshop is about; volume is there because people enjoy it.
// ---------------------------------------------------------------------------

interface Row {
  handle: string; input: number; output: number; cache_write: number;
  cache_read: number; turns: number; cost_micros: number; by_model: string;
  updated_at: number;
}

function boards(rows: Row[]) {
  const enriched = rows.map((r) => {
    const readable = r.cache_read + r.input + r.cache_write;
    const cacheRate = readable > 0 ? r.cache_read / readable : 0;

    let byModel: Record<string, { turns: number; cost_micros: number }> = {};
    try { byModel = JSON.parse(r.by_model || "{}"); } catch { /* keep empty */ }

    const totalTurns = Object.values(byModel).reduce((a, m) => a + (m.turns || 0), 0) || r.turns;
    const topTierTurns = Object.entries(byModel)
      .filter(([m]) => /opus|fable|gpt-5(?!-mini)/i.test(m))
      .reduce((a, [, m]) => a + (m.turns || 0), 0);
    const tierRate = totalTurns > 0 ? 1 - topTierTurns / totalTurns : 0;

    const tokens = r.input + r.output + r.cache_write + r.cache_read;
    const costPerTurn = r.turns > 0 ? r.cost_micros / r.turns : 0;

    return {
      handle: r.handle,
      tokens,
      turns: r.turns,
      cost_usd: r.cost_micros / 1e6,
      cache_rate: cacheRate,
      tier_rate: tierRate,
      cost_per_turn_usd: costPerTurn / 1e6,
      updated_at: r.updated_at,
    };
  });

  const rank = <T extends { handle: string }>(list: T[], key: (x: T) => number, dir = -1) =>
    [...list].sort((a, b) => (key(a) - key(b)) * dir).slice(0, 20);

  return {
    // The board that teaches the lesson: reusing a session beats restarting it.
    cache_discipline: rank(enriched.filter((e) => e.turns >= 5), (e) => e.cache_rate),
    // Getting work done without reaching for the top tier every time.
    tier_discipline: rank(enriched.filter((e) => e.turns >= 5), (e) => e.tier_rate),
    // Pure volume. Fun, not virtuous — labelled that way on the board.
    volume: rank(enriched, (e) => e.tokens),
    room: {
      attendees: enriched.length,
      total_tokens: enriched.reduce((a, e) => a + e.tokens, 0),
      total_cost_usd: enriched.reduce((a, e) => a + e.cost_usd, 0),
      total_turns: enriched.reduce((a, e) => a + e.turns, 0),
    },
  };
}

async function loadBoard(env: Env, workshopId: string) {
  const { results } = await env.DB.prepare(
    `SELECT a.handle, s.input, s.output, s.cache_write, s.cache_read,
            s.turns, s.cost_micros, s.by_model, s.updated_at
       FROM stats s JOIN attendees a ON a.token_hash = s.token_hash
      WHERE s.workshop_id = ?`
  ).bind(workshopId).all<Row>();
  return boards(results || []);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });

    // --- live socket: hand straight to the room's Durable Object ----------
    if (path === "/live") {
      const ws = url.searchParams.get("w") || "";
      if (!ws) return json({ error: "missing workshop" }, 400);
      const id = env.ROOM.idFromName(ws);
      return env.ROOM.get(id).fetch(req);
    }

    // --- join -------------------------------------------------------------
    if (path === "/api/join" && req.method === "POST") {
      const body = await readJson(req);
      if (!body) return json({ error: "bad body" }, 400);

      const code = String(body.code || "").trim().toUpperCase().slice(0, 32);
      const handle = cleanHandle(body.handle);
      if (!code) return json({ error: "missing code" }, 400);
      if (!handle) return json({ error: "handle must be 2-24 printable characters" }, 400);

      const w = await env.DB.prepare(
        `SELECT id, name, started_at, ends_at, open FROM workshops WHERE code = ?`
      ).bind(code).first<{ id: string; name: string; started_at: number; ends_at: number | null; open: number }>();

      if (!w) return json({ error: "no workshop with that code" }, 404);
      if (!w.open) return json({ error: "that workshop is closed" }, 403);

      const token = newToken();
      const hash = await sha256(token);
      const t = now();

      try {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO attendees (token_hash, workshop_id, handle, joined_at) VALUES (?,?,?,?)`
          ).bind(hash, w.id, handle, t),
          env.DB.prepare(
            `INSERT INTO stats (token_hash, workshop_id, updated_at) VALUES (?,?,?)`
          ).bind(hash, w.id, t),
        ]);
      } catch {
        return json({ error: "that handle is already taken in this workshop" }, 409);
      }

      // Nothing before the workshop started counts, and nothing before this
      // attendee actually joined counts either. Whichever is later wins.
      const since = Math.max(w.started_at, t);

      return json({
        token,
        workshop: w.id,
        workshop_name: w.name,
        handle,
        since,
        ends_at: w.ends_at,
        board_url: `${url.origin}/?w=${encodeURIComponent(w.id)}`,
      });
    }

    // --- push -------------------------------------------------------------
    if (path === "/api/push" && req.method === "POST") {
      const who = await auth(req, env);
      if (!who) return json({ error: "unknown token" }, 401);
      if (!who.open) return json({ error: "workshop closed" }, 403);
      if (who.ends_at && now() > who.ends_at) return json({ error: "workshop has ended" }, 403);

      const body = await readJson(req);
      if (!body) return json({ error: "bad body" }, 400);

      const prev = await env.DB.prepare(
        `SELECT updated_at, pushes FROM stats WHERE token_hash = ?`
      ).bind(who.token_hash).first<{ updated_at: number; pushes: number }>();

      const t = now();
      if (prev && t - prev.updated_at < PUSH_MIN_INTERVAL) {
        return json(
          { error: "too fast", retry_after: PUSH_MIN_INTERVAL - (t - prev.updated_at) },
          429,
          { "retry-after": String(PUSH_MIN_INTERVAL) }
        );
      }

      // Explicit allow-list. Anything not named here never reaches D1.
      const totals = (body.totals || {}) as Record<string, unknown>;
      const row = {
        input: int(totals.input),
        output: int(totals.output),
        cache_write: int(totals.cache_write),
        cache_read: int(totals.cache_read),
        turns: int(body.turns, 1_000_000),
        cost_micros: int(Math.round(Number(body.cost_usd || 0) * 1e6)),
        by_model: JSON.stringify(cleanByModel(body.by_model)),
      };

      await env.DB.prepare(
        `UPDATE stats SET input=?, output=?, cache_write=?, cache_read=?,
                turns=?, cost_micros=?, by_model=?, pushes=pushes+1, updated_at=?
          WHERE token_hash=?`
      ).bind(
        row.input, row.output, row.cache_write, row.cache_read,
        row.turns, row.cost_micros, row.by_model, t, who.token_hash
      ).run();

      // Tell the room to re-broadcast. Failure here must not fail the push —
      // the projector reconnecting is not worth losing an attendee's data.
      try {
        const id = env.ROOM.idFromName(who.workshop_id);
        await env.ROOM.get(id).fetch(
          new Request("https://room/broadcast", {
            method: "POST",
            body: JSON.stringify(await loadBoard(env, who.workshop_id)),
            headers: { "content-type": "application/json" },
          })
        );
      } catch { /* projector will pick it up on its next poll */ }

      return json({ ok: true, next_push_after: PUSH_MIN_INTERVAL });
    }

    // --- board (polling fallback for the live socket) ----------------------
    if (path === "/api/board" && req.method === "GET") {
      const ws = url.searchParams.get("w") || "";
      if (!ws) return json({ error: "missing workshop" }, 400);
      return json(await loadBoard(env, ws), 200, { "cache-control": "no-store" });
    }

    // --- leave: an attendee removing themselves --------------------------
    if (path === "/api/me" && req.method === "DELETE") {
      const who = await auth(req, env);
      if (!who) return json({ error: "unknown token" }, 401);
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM stats WHERE token_hash = ?`).bind(who.token_hash),
        env.DB.prepare(`DELETE FROM attendees WHERE token_hash = ?`).bind(who.token_hash),
      ]);
      return json({ ok: true, removed: who.handle });
    }

    // --- admin: create / close a workshop --------------------------------
    if (path === "/api/workshop" && req.method === "POST") {
      if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
        return json({ error: "nope" }, 401);
      }
      const body = await readJson(req);
      if (!body) return json({ error: "bad body" }, 400);

      const id = String(body.id || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48);
      const code = String(body.code || "").trim().toUpperCase().slice(0, 32);
      const name = String(body.name || id).slice(0, 80);
      if (!id || !code) return json({ error: "id and code are required" }, 400);

      await env.DB.prepare(
        `INSERT INTO workshops (id, code, name, started_at, ends_at, open)
         VALUES (?,?,?,?,?,1)
         ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name,
              started_at=excluded.started_at, ends_at=excluded.ends_at, open=1`
      ).bind(id, code, name, int(body.started_at) || now(), body.ends_at ? int(body.ends_at) : null).run();

      return json({ ok: true, id, code, join: `python3 tokens.py --join ${code} --as "Your Name"` });
    }

    if (path === "/api/workshop/close" && req.method === "POST") {
      if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) return json({ error: "nope" }, 401);
      const body = await readJson(req);
      const id = String(body?.id || "");
      await env.DB.prepare(`UPDATE workshops SET open = 0 WHERE id = ?`).bind(id).run();
      return json({ ok: true, closed: id });
    }

    // --- static: the projector board -------------------------------------
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

async function readJson(req: Request): Promise<Record<string, any> | null> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return null;
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, any>) : null;
  } catch {
    return null;
  }
}

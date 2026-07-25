# Organized Tokens — Build & Ship Plan

**What this is:** an Organized AI original that does the same job as
`ovae.ai/workshop/start` — one command, local-only token audit, HTML report —
written from scratch so the code, the copy, and the rate table are yours.

**Not a fork.** Nothing was copied from the source page or its script. The
overlap is functional (read local transcripts, price tokens, open a report),
which is the part that isn't anyone's property.

**Two surfaces, one repo:**

| Surface | Where it lives | What it does |
|---|---|---|
| `tokens.organizedai.vip` | Cloudflare Worker Assets | landing page + the script itself |
| `organized-tokens` plugin | `Organized-AI/Organized-aiic-marketplace` | same audit as a skill, inside Claude |

---

## // ASCII ARCHITECTURE

```
                      ORGANIZED AI — ORGANIZED TOKENS
                   ─────────────────────────────────────

  ATTENDEE'S LAPTOP                          CLOUDFLARE
  ────────────────                           ──────────

  ┌────────────────────┐
  │ ~/.claude/projects │  ◄── never uploaded, never opened remotely
  │ ~/.codex/sessions  │
  └─────────┬──────────┘
            │  read locally by
            ▼
  ┌────────────────────┐   curl -sL   ┌───────────────────────────────┐
  │    tokens.py       │ ◄─────────── │  WORKER (assets-only)          │
  │  ───────────────   │              │  organized-tokens              │
  │  parse  ─ dedupe   │              │  ────────────────────────────  │
  │  bucket ─ price    │              │   /            → index.html    │
  │  render ─ open     │              │   /tokens.py   → the script    │
  └─────────┬──────────┘              │                                │
            │                          │  route: tokens.organizedai.vip │
            ▼                          └──────────────┬────────────────┘
  ┌────────────────────┐                              │
  │  /tmp/…tokens.html │                              │ page loads
  │  ────────────────  │                              ▼
  │  headline $ total  │              ┌───────────────────────────────┐
  │  by model          │              │  LANDING PAGE                  │
  │  by day (bars)     │              │  ────────────────────────────  │
  │  by project        │              │  GSAP terminal types the       │
  │  sources read      │              │  command + counts the total up │
  └────────────────────┘              │  3 steps · trust panel         │
            │                          │  Copy button → dataLayer push  │
            │                          └──────────────┬────────────────┘
            │  --json                                 │ copy_command
            ▼                                          ▼
  ┌────────────────────┐              ┌───────────────────────────────┐
  │  ORGANIZED-TOKENS  │              │  GTM  GTM-T3SL8JPK             │
  │  SKILL             │              │   └─► GA4  G-5CTH745T50        │
  │  ───────────────   │              │        event: copy_command     │
  │  Path A: has shell │              └───────────────────────────────┘
  │    → runs it       │
  │  Path B: chat only │
  │    → asks for JSON │              ┌───────────────────────────────┐
  │  → 3 findings +    │ ◄─────────── │  Organized-aiic-marketplace    │
  │    1 recommendation│   installed  │  ────────────────────────────  │
  └────────────────────┘   from       │   aiic-masterclass             │
                                       │   conversion-tracking-starter  │
                                       │   organized-tokens  ◄── NEW    │
                                       └───────────────────────────────┘
```

---

## // PHASED PLAN

Order only. No dates — earlier phases gate later ones, that's the whole
constraint.

### Phase 0 — Bootstrap
Apply the Organized Codebase template and agent templates to the new project
directory before writing anything else. Everything downstream assumes
`.claude/` and the planning dirs exist.

### Phase 1 — Verify the script against real transcripts
The script is already tested against synthetic Claude Code and Codex fixtures:
dedupe on replayed messages, cache-token pricing, cumulative-vs-delta handling
for Codex, unknown-model flagging, and the no-transcripts path all behave.
What it has *not* seen is your actual `~/.claude` tree. Run it on supabowl
first. This is the phase that finds the parser gap, if there is one.

Gate: `python3 public/tokens.py --days 30 --json` returns totals that look
right against what you know you've been spending.

### Phase 2 — Deploy the Worker
Assets-only Worker, custom domain `tokens.organizedai.vip`. No D1, no KV, no
Durable Objects — there is no state to keep, and adding a binding here would
only create something to leak.

Gate: `curl -sL tokens.organizedai.vip/tokens.py | head -5` returns the
shebang and docstring, and the page renders with the terminal animation.

### Phase 3 — Confirm the tracking fires
GTM container is already embedded. Confirm the `copy_command` dataLayer push
reaches GA4 as a real event before the workshop, not during it. Use the
existing `tracking-health-check` skill from `conversion-tracking-starter`
rather than doing it by hand.

Gate: `copy_command` visible in GA4 DebugView from a real click.

### Phase 4 — Add the plugin to the marketplace
Copy `plugin/organized-tokens/` into `Organized-aiic-marketplace/organized-tokens/`
and register it in `.claude-plugin/marketplace.json` as a relative-path
source, matching the two plugins already there.

Gate: the marketplace manifest still parses, all three plugins resolve, and
`organized-tokens` shows up after a marketplace refresh.

### Phase 5 — Self-invocation test
The lesson from the last marketplace push: a skill that exists is not a skill
that fires. Test it in attendee voice, not in developer voice — "how much is
Claude Code costing me" should trigger it, cold, in a fresh session.

Gate: three out of three attendee-phrased prompts invoke the skill without
being named.

### Phase 6 — Rate table review, then ship
The `PRICING_AS_OF` constant is `2026-07-24`. Confirm the rates against
Anthropic's live pricing page before the workshop; Sonnet 5's introductory
rate expires August 31, 2026, which will change the numbers everyone sees.

### Phase 7 — Optional, after the workshop
An `og.png` for the page, and a `--compare` flag that diffs two runs so
attendees can see whether a routing change actually moved the number.

---

## // SHIPPING IT

`ship.sh` does the local placement and both pushes:

```bash
cd ~/Downloads/organized-tokens     # wherever you unzipped it
bash ship.sh              # everything
bash ship.sh local        # just copy to /Users/supabowl/organized-tokens
bash ship.sh repo         # create + push Organized-AI/organized-tokens
bash ship.sh plugin       # register the plugin in Organized-aiic-marketplace
```

It refuses to run from `$HOME`. That is deliberate — `/Users/supabowl` is
itself a git working tree with four remotes, and `gh repo create --source=.`
from there stages credential files. The guard is a hard exit, not a warning.

The marketplace step is idempotent: run it twice and you get one entry, not
two. It validates every plugin path and every `SKILL.md` frontmatter before
it will push, and aborts on any failure.

Deploy is deliberately not in the script — `wrangler deploy` should be a
thing you type on purpose:

```bash
cd /Users/supabowl/organized-tokens && npx wrangler deploy
```

---

## // CLAUDE CODE PROMPT

Copy-paste directly:

```
claude --dangerously-skip-permissions
```

Then paste:

---

Work in `/Users/supabowl/organized-tokens`. I have the files already —
they're in the zip I'm about to unpack there. Do not rewrite them from
scratch; extend what's there.

**Step 1 — Bootstrap.** Apply the Organized Codebase template and agent
templates to this directory first (`.claude/`, PLANNING, ARCHITECTURE,
DOCUMENTATION). Do this before touching any project file.

**Step 2 — Verify the parser against my real data.** Run:

    python3 public/tokens.py --days 30 --json

If it finds nothing, or the numbers look wrong, inspect the actual shape of a
few lines from my `~/.claude/projects/**/*.jsonl` and fix `read_claude()` to
match. Same for `~/.codex/sessions` and `read_codex()`. Report what you
changed and why. Do not silently adjust the PRICES table to make totals look
better — pricing and parsing are separate problems.

**Step 3 — Deploy.** Assets-only Worker per `wrangler.jsonc`:

    npx wrangler deploy

Then bind the custom domain `tokens.organizedai.vip` on zone
`446a0461f84d37aba20abc5834480783`. Confirm both routes serve:
`/` returns the page, `/tokens.py` returns the script as readable text.

**Step 4 — End-to-end check.** From a clean shell:

    curl -sL tokens.organizedai.vip/tokens.py | python3 --

Confirm the report opens and the totals match what step 2 printed.

**Step 5 — Marketplace.** Clone
`https://github.com/Organized-AI/Organized-aiic-marketplace`, copy
`plugin/organized-tokens/` in as `organized-tokens/`, and add this entry to
`.claude-plugin/marketplace.json` alongside the two existing plugins:

    {
      "name": "organized-tokens",
      "source": "./organized-tokens",
      "description": "Audit your own AI token spend from local session files and get a concrete plan for what to move to a cheaper model",
      "category": "productivity"
    }

Validate before pushing: the manifest parses, all three `source` paths
resolve to a real `.claude-plugin/plugin.json`, and every `SKILL.md` has
`name` and `description` frontmatter. Then commit and push.

**Step 6 — Push this repo.** Create
`Organized-AI/organized-tokens` as a public repo and push. Run
`gh repo create` from inside the project directory, never from `~` — my home
directory is itself a git working tree with four remotes and running it from
there stages credential files.

Constraints:
- Do not add any Cloudflare binding (D1/KV/DO/R2). This Worker is stateless
  on purpose.
- Do not add a build step or any npm dependency to the page. It loads GSAP
  from cdnjs and nothing else.
- `tokens.py` must stay stdlib-only and make zero network calls. If you find
  yourself importing `requests` or `urllib`, stop and tell me why.

---

## // ENV VARS — Claude Code Web

Nothing here is secret to the Worker itself (an assets-only Worker has no
runtime config), so these are for the *deploy and push* steps only:

```bash
# Cloudflare — deploying the Worker
CLOUDFLARE_ACCOUNT_ID=691fe25d377abac03627d6a88d3eeac9
CLOUDFLARE_ZONE_ID=446a0461f84d37aba20abc5834480783
CLOUDFLARE_API_TOKEN=<token with Workers Scripts:Edit + Workers Routes:Edit>

# GitHub — pushing the repo and the marketplace update
GITHUB_TOKEN=<PAT with repo scope on the Organized-AI org>
GH_ORG=Organized-AI

# Analytics — already hardcoded in index.html, listed so they're swappable
GTM_CONTAINER_ID=GTM-T3SL8JPK
GA4_MEASUREMENT_ID=G-5CTH745T50

# Where things land
PROJECT_DIR=/Users/supabowl/organized-tokens
CUSTOM_DOMAIN=tokens.organizedai.vip
```

Set these in Claude Code Web's environment panel. The Cloudflare API token
needs `Workers Scripts:Edit` and `Workers Routes:Edit` on the account, plus
`Zone:Read` on the `organizedai.vip` zone to attach the custom domain.

---

## // ONE THING TO DECIDE

`tokens.organizedai.vip` is a new vanity subdomain, which means a new custom
domain binding and a fifth surface to keep alive alongside guide/wiki/arch/
source.

The alternative is hanging it off the existing workshop surface as a path —
`guide.organizedai.vip/tokens` — which needs no new DNS, no new Worker, and
no new thing to remember to renew. The cost is that the install command gets
longer and less quotable, and a command people have to type accurately at a
workshop is exactly the wrong place to add characters.

Worth picking before Phase 2, since it's the one decision that's annoying to
reverse after attendees have the URL.

---
---

# Part 2 — Workshop Leaderboard

**The tension, stated first:** the page's whole trust argument is "nothing
leaves the machine." A leaderboard breaks that. So it is opt-in, it prints
the exact payload and waits for a typed `join`, it sends counts and model
names and nothing else, and the landing page copy now says *"by default
nothing is uploaded"* with a dedicated panel explaining the exception.

If that qualifier is unacceptable, the alternative is a separate binary and a
separate page — but two scripts at a workshop is a support problem, and a
quiet asterisk on the trust claim is worse than an honest one.

## // ASCII — LEADERBOARD

```
  ATTENDEE LAPTOP
  ───────────────

  tokens.py --join AIIC-2026 --as "Ana"
       │  prints the full payload, waits for a typed "join"
       ▼
  ┌────────────────────────────────────────────┐
  │  ~/.organized-tokens/workshop.json         │
  │  token + since   ·   mode 600              │
  └─────────────────────┬──────────────────────┘
                       │
  tokens.py --watch    │  POST /api/push
                       │  {totals, by_model, turns}
                       ▼
  CLOUDFLARE
  ──────────
  ┌────────────────────────────────────────────┐
  │  WORKER   organized-tokens-leaderboard     │
  │  ────────────────────────────────────────  │
  │  allow-list on every field                 │
  │  20s minimum between pushes                │
  │  stores the SHA-256, never the token       │
  └───────────┬─────────────────┬──────────────┘
              │                 │
              ▼                 ▼
  ┌────────────────────┐  ┌────────────────────┐
  │  D1                │  │  DURABLE OBJECT    │
  │  workshops         │  │  "Room"            │
  │  attendees         │  │  ────────────────  │
  │  stats             │  │  websocket         │
  └──────────┬─────────┘  │  hibernation       │
             │            └──────────┬─────────┘
             └────────────┬──────────┘
                          ▼
  ┌────────────────────────────────────────────┐
  │  PROJECTOR   board.organizedai.vip/?w=aiic │
  │  ────────────────────────────────────────  │
  │  rotates every 14s:                        │
  │    1  Cache discipline                     │
  │    2  Tier discipline                      │
  │    3  Raw volume ("vanity")                │
  │                                            │
  │  live socket; polls at 8s if the venue     │
  │  blocks websockets                         │
  └────────────────────────────────────────────┘
```

## // WHY THESE THREE BOARDS

Ranking a tokenomics workshop by who spent the most rewards exactly the
behaviour the workshop exists to correct — and the person who wins is the
person whose agent looped on a broken build for an hour.

So: **cache discipline** leads (cache reads as a share of all input — the
number that actually moves a bill, and it rewards not restarting sessions).
**Tier discipline** second (share of turns not on a top-tier model).
**Raw volume** last, and labelled on screen as fun rather than virtuous.

Boards are computed in the Worker from stored counts, so changing the
ranking is a deploy, not a migration.

## // PHASED PLAN — LEADERBOARD

Runs after Part 1 Phase 2. The board is useless until `tokens.py` is live at
a URL attendees can curl.

**Phase L0 — D1 + schema.** Create the database, apply `schema.sql` locally
first, then remote. Gate: `wrangler d1 execute --remote --command "SELECT
name FROM sqlite_master"` lists three tables.

**Phase L1 — Worker without the Durable Object.** Deploy join/push/board
against D1 only; the projector runs on 8-second polling. This is the version
that must work, because it is the one that survives hostile venue wifi.
Gate: two laptops join, push, and appear on the board.

**Phase L2 — Add the Room DO.** Live fan-out on top of the polling that
already works. Gate: kill the socket mid-session and confirm the board keeps
updating on the polling path without a reload.

**Phase L3 — Create the workshop row.** `POST /api/workshop` with the admin
secret, setting `started_at` to the actual session start so nobody's
overnight coding lands on the board. Gate: a push containing pre-workshop
turns contributes zero.

**Phase L4 — Adversarial pass.** Before 20 people have the endpoint: try a
duplicate handle, a 5MB body, a handle containing `<script>`, a push every
second, a push with a `prompt` field attached, and a forged bearer token.
Expected: 409, rejected, rendered as text, 429, field silently dropped, 401.

**Phase L5 — Dry run on supabowl.** Join, watch, leave, re-join. Confirm
`--leave` actually removes the row and that re-joining with the same handle
works afterwards.

**Phase L6 — Room script.** Decide the moment you put the board on screen.
Suggestion: not at the start. Let people work for 20 minutes, then reveal it
— a board with three zeroes on it at minute one kills the energy it is
supposed to create.

## // CLAUDE CODE PROMPT — LEADERBOARD

```
claude --dangerously-skip-permissions
```

Then paste:

---

Work in `/Users/supabowl/organized-tokens/leaderboard`. The Worker, Durable
Object, schema, and projector page already exist and typecheck. Do not
rewrite them.

1. `npm install`, then `npx tsc --noEmit` — confirm it is still clean.
2. `npx wrangler d1 create organized-tokens-leaderboard` and paste the
   returned `database_id` into `wrangler.jsonc`.
3. `npm run db:local` then `npm run db:remote` to apply `schema.sql`.
4. `npx wrangler secret put ADMIN_SECRET` — generate a 32-char random value
   and tell me what it is, once.
5. `npx wrangler deploy`, then bind `board.organizedai.vip` on zone
   `446a0461f84d37aba20abc5834480783`.
6. Create the workshop row:
   POST /api/workshop with header `x-admin-secret`, body
   `{"id":"aiic","code":"AIIC-2026","name":"AIIC Sales & Marketing Masterclass","started_at":<unix seconds for session start>}`
7. Run Phase L4 above as actual requests with curl and show me each response
   code. Do not tell me it "should" return 429 — show me that it did.

Constraints:
- Do not widen the allow-list in `/api/push`. If a field is not already
  named there, it does not get stored.
- Do not store the bearer token. Only the SHA-256 hash, as it does now.
- Do not remove the polling fallback in `public/index.html` in favour of
  websockets. The venue is the reason it exists.
```

## // ENV VARS — Claude Code Web (leaderboard)

```bash
CLOUDFLARE_ACCOUNT_ID=691fe25d377abac03627d6a88d3eeac9
CLOUDFLARE_ZONE_ID=446a0461f84d37aba20abc5834480783
CLOUDFLARE_API_TOKEN=<Workers Scripts:Edit, Workers Routes:Edit, D1:Edit, Zone:Read>

D1_DATABASE_NAME=organized-tokens-leaderboard
D1_DATABASE_ID=<from: wrangler d1 create>
ADMIN_SECRET=<32 random chars; set via `wrangler secret put`, not as a var>

BOARD_DOMAIN=board.organizedai.vip
WORKSHOP_ID=aiic
WORKSHOP_CODE=AIIC-2026

# Client-side override, useful for testing against a local wrangler dev:
ORGANIZED_TOKENS_BOARD=http://127.0.0.1:8787
```

## // WHAT IS DELIBERATELY NOT BUILT

- **Anti-cheat.** A determined attendee can POST invented numbers. For 20
  people in a room with a projector, social pressure is the enforcement
  mechanism. Building real attestation here would cost more than the board
  is worth.
- **Historical charts.** `stats` holds current totals, not a time series. If
  you want a race replay, that is an append-only `samples` table and a
  different plan — say so before L0, because it changes the schema.
- **Auto-join from the marketplace skill.** The skill deliberately cannot put
  someone on a leaderboard. Joining is a thing a person types.

---
---

# Part 3 — Claude Desktop capture (READ BEFORE TOMORROW)

## // THE FINDING

**Claude Desktop chat does not write token counts to disk.** Standard Desktop
keeps conversation history server-side, and the consumer chat product has no
per-message usage accounting exposed client-side at all. This is not a parser
that needs writing — the numbers do not exist locally.

If 20 people use Desktop chat tomorrow and run `--watch`, every one of them
pushes zeros to the board, live, in the room.

What Desktop *does* write locally:

| Path (under `~/Library/Application Support/Claude/`) | Contents |
|---|---|
| `claude-code-sessions/` | Code tab conversation history, per session |
| `local-agent-mode-sessions/` | Cowork history, one JSON + working dir per session |
| `local-agent-mode-sessions/.../<id>/audit.jsonl` | append-only tool invocations, permission decisions, file ops — HMAC-chained |
| `~/Library/Logs/Claude/mcp-server-<name>.log` | MCP connection and tool-call events |

So there is capturable **activity**. There is no capturable **cost**.

## // TONIGHT, BEFORE ANYTHING ELSE

```bash
python3 tools/desktop-probe.py --deep --out ~/probe.txt
```

It walks every Claude directory, reports structure only — key paths and value
*shapes*, never values — and tells you outright whether any token-accounting
key exists anywhere. Verified against synthetic trees: prompts, filenames, and
paths embedded in JSON do not appear in the output, so the whole thing is safe
to paste back.

Run it on supabowl after using Desktop the way attendees will. Then the parser
gets written against real data instead of a guess.

## // THREE OPTIONS FOR TOMORROW

**A — Attendees use the Code tab or Claude Code CLI.**
Real token data, works with everything already built, zero new code. Costs you
a change to the workshop instruction, not the tooling. If any part of tomorrow
involves building rather than chatting, this is the answer.

**B — Board measures activity instead of cost.**
Rank on tool invocations, sessions, artifacts produced — things `audit.jsonl`
and the MCP logs actually contain. Arguably a *better* workshop board: it
rewards using the plugins they just installed, which is the learning
objective. But it needs a parser written against probe output, and that is a
tomorrow-morning job at best.

**C — Manual check-in board.**
A form on the leaderboard Worker where attendees post a number or a milestone.
No parsing, no dependency, works for every surface including mobile. The
honest fallback.

**Recommendation:** A as the primary, C staged as the fallback, B only if the
probe comes back with something clean and there is time. Do not debug a
transcript parser in front of 20 people — that is the failure mode this whole
section exists to avoid.

## // THE PART THAT DOES NOT CHANGE

`tokens.py` still works perfectly for anyone using Claude Code, CLI or Code
tab. The report, the pricing, the model breakdown — all unaffected. What Part
3 changes is only who can appear on a *token* leaderboard, which is: Claude
Code users, not Desktop chat users.

Say that out loud in the room rather than letting people discover it by
pushing zeros.

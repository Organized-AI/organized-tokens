# Organized Tokens

**See what your AI habit actually costs.**

One command. About ten seconds. It reads the AI session files already sitting
on your machine, prices every token at published API rates, and opens a local
HTML report covering your last 30 days.

Nothing is uploaded. No network calls, no API keys, no telemetry.

(The one exception is the opt-in workshop leaderboard, below. It is off unless
you pass `--join`, and it asks before it sends anything.)

```bash
curl -sL tokens.organizedai.vip/tokens.py | python3
```

macOS and Linux, using the Python that ships with your system. No pip install,
no virtualenv, stdlib only.

---

## What it reads

| Source | Path |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Claude Code (alt) | `~/.config/claude/projects/**/*.jsonl` |
| Codex | `~/.codex/sessions/**/*.jsonl` |

Token counts and model names only. Every file it touched is listed at the
bottom of the report so you can check it yourself.

## What the report shows

- Total cost of the window at published API rates
- Breakdown by model, split into input / output / cache write / cache read
- Cost per day as a bar chart
- Which project burned it
- Which models had no rate on file — counted, flagged, never silently zeroed

## Options

```bash
python3 tokens.py                 # last 30 days
python3 tokens.py --days 7        # last 7 days
python3 tokens.py --days 0        # everything on disk
python3 tokens.py --plan 200      # compare against a $200/mo plan
python3 tokens.py --json          # raw totals, no report
python3 tokens.py --no-open       # write the report, don't open a browser
python3 tokens.py --out ~/r.html  # choose where it lands
```

## A note on what the total means

If you are on a flat-rate subscription, the number is **not a bill you
received**. It is what the same work would have cost at API rates — a measure
of what your plan absorbed. Reading it any other way makes the report look
like a scare tactic, which it isn't.

## Rates

The `PRICES` table at the top of `tokens.py` is stamped with `PRICING_AS_OF`.
Rates move; edit the table rather than trusting it. The report prints that
date so a stale number is visible rather than silent.

## Workshop leaderboard (opt-in)

At a live workshop, attendees can put their counts on a shared board:

```bash
python3 tokens.py --join AIIC-2026 --as "Your Name"   # once, asks first
python3 tokens.py --watch                             # push every 60s
python3 tokens.py --leave                             # remove yourself
```

`--join` prints the complete payload and refuses to continue until you type
`join`. What goes up:

| Sent | Not sent |
|---|---|
| token counts (input / output / cache write / cache read) | prompts or completions |
| turn counts per model | file paths |
| model names | project or repo names |
| a cost figure | anything read out of a transcript besides numbers |
| the handle you typed after `--as` | your machine, user, or directory names |

Credentials live in `~/.organized-tokens/workshop.json`, mode 600. `--leave`
deletes the server row and the local token.

The board itself is in `leaderboard/` — a Worker on D1 with a Durable Object
for live updates. It ranks on cache discipline and tier discipline first, and
raw volume last and labelled as vanity, because ranking a tokenomics workshop
by who burned the most would teach the opposite of the point.

## Claude Desktop chat

Desktop chat does not write token counts to disk — conversation history is
server-side and consumer chat has no client-side usage accounting. `tokens.py`
therefore reads nothing for Desktop-chat-only users.

It works fully for **Claude Code**, CLI or the Desktop Code tab. Before
assuming otherwise on a given machine, run:

```bash
python3 tools/desktop-probe.py --deep
```

That reports structure only — no conversation content — and states plainly
whether token accounting exists anywhere on that machine.

## Use it inside Claude

The same audit is available as a skill via the Organized AI marketplace:

```
/plugin marketplace add Organized-AI/Organized-aiic-marketplace
/plugin install organized-tokens
```

Then ask *"how much is Claude Code costing me"* in Claude Code or Cowork and
it will run the audit and hand back three findings and one recommendation. In
the browser or mobile app it will give you the one-liner and analyse what you
paste back, since it can't reach your filesystem from there.

## Deploying your own

Assets-only Cloudflare Worker — no bindings, no state, nothing to leak.

```bash
npm install
npx wrangler deploy
```

Set your own custom domain in `wrangler.jsonc`, and swap the GTM container ID
in `public/index.html` if you want the `copy_command` event going somewhere
other than ours.

## Layout

```
public/index.html     landing page (GSAP, no build step)
public/tokens.py      the script, ~750 lines, stdlib only
plugin/               the marketplace plugin
wrangler.jsonc        assets-only Worker config
PLAN.md               phased build plan + architecture
ship.sh               place locally, push repo, register plugin
```

---

MIT · Organized AI · [organizedai.vip](https://organizedai.vip)

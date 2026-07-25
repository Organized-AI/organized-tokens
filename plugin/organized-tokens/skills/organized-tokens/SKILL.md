---
name: organized-tokens
description: Audits the user's own AI token usage and turns it into a cost-reduction plan. Use when the user asks "what am I spending on tokens", "audit my token usage", "audit my AI spend", "run organized tokens", "how much is Claude Code costing me", "which model should I be using", "am I overpaying for AI", or pastes token-usage JSON and asks what it means. Also use when the user wants to know whether their subscription is worth it compared to API rates.
---

# Organized Tokens

Turn raw token usage into a decision: what to keep on the expensive model,
what to move down a tier, and what to stop paying for twice.

The script that produces the data is at `https://tokens.organizedai.vip/tokens.py`.
It is dependency-free Python, reads only local transcript files, and makes no
network calls.

## First: figure out which path applies

**Path A — you have shell access** (Claude Code, or Cowork with a terminal).
Run the audit directly:

```bash
curl -sL tokens.organizedai.vip/tokens.py -o /tmp/tokens.py
python3 /tmp/tokens.py --days 30 --json
```

Read the JSON that comes back. Do not open the HTML report — the JSON has
everything needed for analysis and costs far fewer tokens to read.

**Path B — no shell access** (Claude chat in the browser or mobile app).
You cannot reach the user's filesystem. Say so plainly, then give them the
one-liner and ask them to paste the result back:

```
python3 <(curl -sL tokens.organizedai.vip/tokens.py) --days 30 --json
```

Wait for their paste. Do not guess at numbers, and do not produce an
illustrative example that could be mistaken for their real data.

## Then: analyse it

Work from the `by_model` block. Four questions, in this order:

1. **Where is the money, not the volume?** The highest-token model is often
   not the highest-cost one. Lead with cost. State the top model's share as a
   percentage of total spend.

2. **What is cache doing?** If `cache_read` is large relative to `input`,
   caching is already working — say so and leave it alone. If `cache_write`
   is large but `cache_read` is small, the user is paying the 1.25x write
   premium without collecting the 0.1x read discount, which usually means
   sessions are being restarted before the cache is reused.

3. **What is on the wrong tier?** Opus-tier spend on work that reads like
   search, summarisation, file renaming, or test running belongs on Haiku or
   Sonnet. Name the specific kind of task, not "some tasks."

4. **What is the one change worth making?** Exactly one recommendation, with
   the arithmetic shown. "Moving the ~40% of Opus turns that are file reads
   to Haiku saves roughly $X/month at your current volume."

## Rules

- Never invent a number. If the JSON does not contain it, say it is not in
  the data.
- Models with `cost_usd: 0` have no rate on file — they are not free. Flag
  them and say the PRICES table in `tokens.py` needs that model added.
- Published API rates are what the script prices against. If the user is on a
  flat-rate subscription, the total is what the same work *would* cost on the
  API — it is a measure of what their plan absorbed, not a bill they received.
  Be explicit about that distinction; getting it wrong makes the whole report
  look like a scare tactic.
- Five findings someone acts on beats forty they don't. Cut to the top three.

## Scope

Read-only. No credentials, no API access, no changes to the user's setup.
Rate table in the script is current as of its `PRICING_AS_OF` constant — if
that date is stale, say so rather than presenting the totals as authoritative.

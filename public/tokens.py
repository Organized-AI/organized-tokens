#!/usr/bin/env python3
"""
Organized Tokens
===========================

Reads AI coding-agent transcripts that already exist on this machine, totals
the tokens by model and by day, prices them at published API rates, and opens
a local HTML report.

Nothing is uploaded. No network calls are made. No credentials are read.
Every file this touches is listed in the report under "Sources read".

Usage
-----
    curl -sL tokens.organizedai.vip/tokens.py | python3

    # or, once saved locally:
    python3 tokens.py                 # last 30 days
    python3 tokens.py --days 7        # last 7 days
    python3 tokens.py --days 0        # everything on disk
    python3 tokens.py --plan 200      # also show cost vs a $200/mo plan
    python3 tokens.py --json          # print raw totals, skip the report
    python3 tokens.py --no-open       # write the report, don't open a browser

Workshop leaderboard (opt-in, off by default)
---------------------------------------------
    python3 tokens.py --join CODE --as "Your Name"   # register, once
    python3 tokens.py --watch                        # push every 60s
    python3 tokens.py --push                         # push once
    python3 tokens.py --leave                        # delete your row, forget the token

--join is the ONLY thing in this script that touches the network, and it asks
before it does. It sends counts and model names. It does not send prompts,
completions, file paths, project names, or anything read out of a transcript
other than the numbers. The exact payload is printed for you to read before
the first upload.

Requires only the Python 3 that ships with macOS and most Linux distros.
Stdlib only — no pip install, no venv.

MIT licensed. Organized AI — https://organizedai.vip
"""

import argparse
import glob
import json
import os
import sys
import tempfile
import webbrowser
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from html import escape

# --------------------------------------------------------------------------
# PRICING — USD per 1,000,000 tokens.
#
# Verified against published Anthropic and OpenAI rates as of July 2026.
# Rates move. Edit this table rather than trusting it blindly; the report
# prints the date this table was last touched so a stale number is visible
# rather than silent.
#
# Matching is longest-prefix-wins against the model string in the transcript,
# so "claude-opus-4-5-20251101" matches the "claude-opus-4-5" entry before it
# ever reaches the looser "claude-opus" fallback.
# --------------------------------------------------------------------------

PRICING_AS_OF = "2026-07-25"

# model-id fragment -> (input, output, cache_write, cache_read)
PRICES = {
    # --- Anthropic, current generation -----------------------------------
    "claude-fable-5":     (10.00, 50.00, 12.50, 1.00),
    "claude-opus-5":      (5.00,  25.00,  6.25, 0.50),
    "claude-opus-4-8":    (5.00,  25.00,  6.25, 0.50),
    "claude-opus-4-7":    (5.00,  25.00,  6.25, 0.50),
    "claude-opus-4-6":    (5.00,  25.00,  6.25, 0.50),
    "claude-opus-4-5":    (5.00,  25.00,  6.25, 0.50),
    # Introductory pricing through 2026-08-31; standard $3/$15/$3.75/$0.30
    # takes over 2026-09-01 — flip this back after that date.
    "claude-sonnet-5":    (2.00,  10.00,  2.50, 0.20),
    "claude-sonnet-4-6":  (3.00,  15.00,  3.75, 0.30),
    "claude-sonnet-4-5":  (3.00,  15.00,  3.75, 0.30),
    "claude-haiku-4-5":   (1.00,   5.00,  1.25, 0.10),
    # --- Anthropic, legacy -----------------------------------------------
    "claude-opus-4-1":    (15.00, 75.00, 18.75, 1.50),
    "claude-opus-4":      (15.00, 75.00, 18.75, 1.50),
    "claude-3-7-sonnet":  (3.00,  15.00,  3.75, 0.30),
    "claude-3-5-sonnet":  (3.00,  15.00,  3.75, 0.30),
    "claude-3-5-haiku":   (0.80,   4.00,  1.00, 0.08),
    "claude-3-haiku":     (0.25,   1.25,  0.30, 0.03),
    # --- Loose fallbacks, used only if nothing above matches -------------
    "claude-opus":        (5.00,  25.00,  6.25, 0.50),
    "claude-sonnet":      (3.00,  15.00,  3.75, 0.30),
    "claude-haiku":       (1.00,   5.00,  1.25, 0.10),
    # --- OpenAI / Codex ---------------------------------------------------
    "gpt-5-codex":        (1.25,  10.00,  1.25, 0.125),
    "gpt-5-mini":         (0.25,   2.00,  0.25, 0.025),
    "gpt-5":              (1.25,  10.00,  1.25, 0.125),
    "o4-mini":            (1.10,   4.40,  1.10, 0.275),
    "gpt-4o":             (2.50,  10.00,  2.50, 1.25),
}

UNKNOWN_MODEL_PRICE = (0.0, 0.0, 0.0, 0.0)


def price_for(model):
    """Longest matching fragment wins. Returns (rates, matched_key_or_None)."""
    if not model:
        return UNKNOWN_MODEL_PRICE, None
    m = model.lower()
    best = None
    for frag in PRICES:
        if frag in m and (best is None or len(frag) > len(best)):
            best = frag
    if best is None:
        return UNKNOWN_MODEL_PRICE, None
    return PRICES[best], best


# --------------------------------------------------------------------------
# TRANSCRIPT DISCOVERY
# --------------------------------------------------------------------------

def home(*parts):
    return os.path.join(os.path.expanduser("~"), *parts)


SOURCES = [
    # (label, glob pattern)
    ("Claude Code", home(".claude", "projects", "**", "*.jsonl")),
    ("Claude Code", home(".config", "claude", "projects", "**", "*.jsonl")),
    ("Codex",       home(".codex", "sessions", "**", "*.jsonl")),
    # Desktop's Cowork mode (local-agent-mode-sessions) runs Claude Code in a
    # remote VM; audit.jsonl is the only local record and carries the same
    # message.usage shape as a CLI transcript, just under `_audit_timestamp`
    # instead of `timestamp`. Standard Desktop chat has no local equivalent.
    ("Claude Code", home("Library", "Application Support", "Claude",
                         "local-agent-mode-sessions", "**", "audit.jsonl")),
]


def discover():
    found = []
    seen = set()
    for label, pattern in SOURCES:
        for path in glob.iglob(pattern, recursive=True):
            real = os.path.realpath(path)
            if real in seen or not os.path.isfile(real):
                continue
            seen.add(real)
            found.append((label, real))
    return found


# --------------------------------------------------------------------------
# PARSING
#
# Two transcript shapes, handled separately because they count differently:
#
#   Claude Code — one JSON object per line. Assistant turns carry
#   message.usage with per-request token counts. These are DELTAS: sum them.
#   The same message can be replayed into a resumed session, so dedupe on
#   message id.
#
#   Codex — one JSON object per line, token accounting arrives as events.
#   `last_token_usage` is a per-turn delta (sum it). `total_token_usage` is
#   cumulative for the session (take the max, never sum, or you count the
#   whole session once per turn).
# --------------------------------------------------------------------------

def parse_ts(value):
    """Best-effort ISO-8601 -> aware datetime. Returns None on failure."""
    if not value:
        return None
    if isinstance(value, (int, float)):
        try:
            v = float(value)
            if v > 1e11:  # milliseconds
                v /= 1000.0
            return datetime.fromtimestamp(v, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None
    if not isinstance(value, str):
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


class Totals(object):
    __slots__ = ("input", "output", "cache_write", "cache_read", "calls")

    def __init__(self):
        self.input = 0
        self.output = 0
        self.cache_write = 0
        self.cache_read = 0
        self.calls = 0

    def add(self, i=0, o=0, cw=0, cr=0, calls=1):
        self.input += i
        self.output += o
        self.cache_write += cw
        self.cache_read += cr
        self.calls += calls

    @property
    def tokens(self):
        return self.input + self.output + self.cache_write + self.cache_read

    def cost(self, rates):
        pin, pout, pcw, pcr = rates
        return (
            self.input * pin
            + self.output * pout
            + self.cache_write * pcw
            + self.cache_read * pcr
        ) / 1_000_000.0


class Tally(object):
    def __init__(self):
        self.by_model = defaultdict(Totals)
        self.by_day = defaultdict(Totals)
        self.by_model_day = defaultdict(Totals)
        self.by_project = defaultdict(Totals)
        self.files_read = []
        self.files_skipped = []
        self.dedup_hits = 0
        self.unknown_models = set()
        self.earliest = None
        self.latest = None
        # Activity counts, not token counts: how many prompts the human typed
        # and how many tool calls the agent made. Counts only — the text of
        # a prompt or a tool call never leaves the parser.
        self.prompts = 0
        self.tool_calls = 0

    def record(self, model, when, project, i, o, cw, cr):
        if (i + o + cw + cr) <= 0:
            return
        day = when.astimezone().strftime("%Y-%m-%d") if when else "undated"
        self.by_model[model].add(i, o, cw, cr)
        self.by_day[day].add(i, o, cw, cr)
        self.by_model_day[(model, day)].add(i, o, cw, cr)
        if project:
            self.by_project[project].add(i, o, cw, cr)
        _, matched = price_for(model)
        if matched is None:
            self.unknown_models.add(model or "(unlabelled)")
        if when:
            if self.earliest is None or when < self.earliest:
                self.earliest = when
            if self.latest is None or when > self.latest:
                self.latest = when


def project_name(path):
    """Human-readable project label from a Claude Code transcript path."""
    parent = os.path.basename(os.path.dirname(path))
    if not parent or parent in ("projects", "sessions"):
        return ""
    # Claude Code encodes the cwd by replacing separators with dashes.
    return parent.lstrip("-").replace("-", "/") if parent.startswith("-") else parent


def _is_human_prompt(msg):
    """A user line the human actually typed, as opposed to the tool_result
    feedback lines the harness writes back with role=user."""
    content = msg.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                return True
    return False


def read_claude(path, tally, cutoff, seen_ids):
    rows = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line[0] != "{":
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            msg = obj.get("message")
            if not isinstance(msg, dict):
                continue

            when = parse_ts(obj.get("timestamp") or obj.get("_audit_timestamp"))
            if cutoff and when and when < cutoff:
                continue

            if obj.get("type") == "user" and _is_human_prompt(msg):
                # uuid dedupes replayed lines (Cowork audit files repeat them)
                key = obj.get("uuid")
                if not key or key not in seen_ids:
                    if key:
                        seen_ids.add(key)
                    tally.prompts += 1
                continue

            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue

            key = msg.get("id") or obj.get("requestId")
            if key:
                if key in seen_ids:
                    tally.dedup_hits += 1
                    continue
                seen_ids.add(key)

            content = msg.get("content")
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        tally.tool_calls += 1

            tally.record(
                msg.get("model") or obj.get("model") or "(unlabelled)",
                when,
                project_name(path),
                int(usage.get("input_tokens") or 0),
                int(usage.get("output_tokens") or 0),
                int(usage.get("cache_creation_input_tokens") or 0),
                int(usage.get("cache_read_input_tokens") or 0),
            )
            rows += 1
    return rows


def _find_usage_dicts(node, out, depth=0):
    """Codex nests its counters. Walk until we find dicts with token keys."""
    if depth > 6:
        return
    if isinstance(node, dict):
        if "input_tokens" in node or "output_tokens" in node:
            out.append(node)
        for value in node.values():
            _find_usage_dicts(value, out, depth + 1)
    elif isinstance(node, list):
        for value in node[:50]:
            _find_usage_dicts(value, out, depth + 1)


def read_codex(path, tally, cutoff):
    """Codex: prefer per-turn deltas; fall back to session cumulative max."""
    model = ""
    when = None
    deltas = []
    cumulative = None
    prompts = 0
    tool_calls = 0

    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line[0] != "{":
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue

            ts = parse_ts(obj.get("timestamp") or obj.get("ts"))
            if ts:
                when = ts

            blob = json.dumps(obj)
            if '"model"' in blob:
                found = _first_model(obj)
                if found:
                    model = found

            payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else obj

            ptype = payload.get("type")
            if ptype == "user_message":
                prompts += 1
            elif ptype in ("function_call", "custom_tool_call"):
                tool_calls += 1
            info = payload.get("info") if isinstance(payload.get("info"), dict) else None
            if isinstance(info, dict):
                last = info.get("last_token_usage")
                total = info.get("total_token_usage")
                if isinstance(last, dict):
                    deltas.append(last)
                    continue
                if isinstance(total, dict):
                    cumulative = total
                    continue

            if payload.get("type") == "token_count":
                found = []
                _find_usage_dicts(payload, found)
                if found:
                    deltas.append(found[0])

    if cutoff and when and when < cutoff:
        return 0

    tally.prompts += prompts
    tally.tool_calls += tool_calls

    def emit(u):
        cached = int(u.get("cached_input_tokens") or u.get("cache_read_input_tokens") or 0)
        raw_in = int(u.get("input_tokens") or 0)
        # Codex reports cached tokens inside input_tokens on some versions.
        billed_in = max(raw_in - cached, 0) if cached and cached <= raw_in else raw_in
        tally.record(
            model or "gpt-5-codex",
            when,
            "",
            billed_in,
            int(u.get("output_tokens") or 0),
            0,
            cached,
        )

    if deltas:
        for u in deltas:
            emit(u)
        return len(deltas)
    if cumulative:
        emit(cumulative)
        return 1
    return 0


def _first_model(node, depth=0):
    if depth > 5:
        return ""
    if isinstance(node, dict):
        value = node.get("model")
        if isinstance(value, str) and value:
            return value
        for v in node.values():
            found = _first_model(v, depth + 1)
            if found:
                return found
    elif isinstance(node, list):
        for v in node[:20]:
            found = _first_model(v, depth + 1)
            if found:
                return found
    return ""


# --------------------------------------------------------------------------
# WORKSHOP LEADERBOARD — opt-in, and the only networked code path here
#
# Everything above this line runs offline. Nothing below runs unless the user
# passes --join/--push/--watch/--leave, and --join refuses to proceed without
# a typed confirmation after printing the exact payload.
# --------------------------------------------------------------------------

LEADERBOARD = os.environ.get("ORGANIZED_TOKENS_BOARD", "https://board.organizedai.vip")
CRED_PATH = home(".organized-tokens", "workshop.json")


def load_creds():
    try:
        with open(CRED_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def save_creds(data):
    d = os.path.dirname(CRED_PATH)
    if not os.path.isdir(d):
        os.makedirs(d, mode=0o700)
    with open(CRED_PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    try:
        os.chmod(CRED_PATH, 0o600)
    except OSError:
        pass


def http(method, path, body=None, token=None, timeout=12):
    """The only outbound request in this file. Imported locally so that a
    read-only run never even loads the networking stack."""
    import urllib.request
    import urllib.error

    url = LEADERBOARD.rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("user-agent", "organized-tokens/0.1")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except ValueError:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def build_payload(tally, since):
    """Exactly what gets uploaded. Built here, in one place, so it can be
    printed verbatim and audited. No project names, no paths, no text."""
    grand = Totals()
    by_model = {}
    for model, t in tally.by_model.items():
        grand.add(t.input, t.output, t.cache_write, t.cache_read, t.calls)
        by_model[model] = {
            "turns": t.calls,
            "cost_micros": int(round(t.cost(price_for(model)[0]) * 1_000_000)),
        }
    return {
        "since": since,
        "turns": grand.calls,
        "cost_usd": round(sum(t.cost(price_for(m)[0]) for m, t in tally.by_model.items()), 6),
        "prompts": tally.prompts,
        "tool_calls": tally.tool_calls,
        "totals": {
            "input": grand.input,
            "output": grand.output,
            "cache_write": grand.cache_write,
            "cache_read": grand.cache_read,
        },
        "by_model": by_model,
    }


def collect(since):
    """Re-read transcripts, counting only turns after the workshop began."""
    cutoff = datetime.fromtimestamp(since, tz=timezone.utc)
    tally = Tally()
    seen = set()
    for label, path in discover():
        try:
            if label == "Claude Code":
                read_claude(path, tally, cutoff, seen)
            else:
                read_codex(path, tally, cutoff)
        except (OSError, UnicodeError, ValueError):
            continue
    return tally


def cmd_join(code, handle, watch_after=True, interval=60):
    if not handle:
        # No --as given: ask, rather than making novices retype a quoted flag.
        try:
            handle = input("\n  What name should show on the board? ").strip()
        except EOFError:
            handle = ""
        if not handle:
            print("\n  A name is required: --join %s --as \"Your Name\"\n" % code)
            return 1

    since = int(datetime.now(timezone.utc).timestamp())
    sample = build_payload(collect(since - 3600), since)

    print("\n  Joining the workshop leaderboard means uploading numbers.")
    print("  This is the entire payload — nothing else is sent, ever:\n")
    for line in json.dumps(sample, indent=2).split("\n"):
        print("    " + line)
    print("\n  Not included: prompts, completions, file paths, project names,")
    print("  repo names, or any text from a transcript. Counts and model")
    print("  names only. Your handle is the name you just gave.")
    print("\n  You can remove yourself at any time with:  tokens.py --leave")

    try:
        answer = input("\n  Type 'join' to continue, anything else to cancel: ").strip().lower()
    except EOFError:
        answer = ""
    if answer != "join":
        print("\n  Cancelled. Nothing was uploaded.\n")
        return 1

    status, res = http("POST", "/api/join", {"code": code, "handle": handle})
    if status != 200:
        print("\n  Could not join: %s\n" % res.get("error", "status %s" % status))
        return 1

    save_creds({
        "token": res["token"],
        "workshop": res["workshop"],
        "handle": res["handle"],
        "since": res["since"],
        "board_url": res.get("board_url", ""),
    })
    print("\n  Joined %s as %s" % (res.get("workshop_name") or res["workshop"], res["handle"]))
    print("  Board: %s" % res.get("board_url", LEADERBOARD))
    print("  Credentials: %s (chmod 600)" % CRED_PATH)
    if not watch_after:
        print("\n  Now run:  python3 tokens.py --watch\n")
        return 0
    # Joining without watching is never what anyone wants at a workshop, so
    # flow straight into it. Ctrl-C stops pushing; --leave removes you.
    return cmd_watch(interval)


def cmd_push(quiet=False):
    creds = load_creds()
    if not creds:
        print("\n  Not in a workshop. Run --join CODE --as \"Your Name\" first.\n")
        return 1
    payload = build_payload(collect(creds["since"]), creds["since"])
    status, res = http("POST", "/api/push", payload, token=creds["token"])
    if status == 200:
        if not quiet:
            print("  pushed — %d turns, %s" % (payload["turns"], fmt_usd(payload["cost_usd"])))
        return 0
    if status == 429:
        if not quiet:
            print("  too fast, retrying in %ss" % res.get("retry_after", 20))
        return 0
    print("  push failed: %s" % res.get("error", "status %s" % status))
    return 1


def cmd_watch(interval):
    creds = load_creds()
    if not creds:
        print("\n  Not in a workshop. Run --join CODE --as \"Your Name\" first.\n")
        return 1
    print("\n  Organized Tokens — watching for %s" % creds["handle"])
    print("  Board: %s" % creds.get("board_url", LEADERBOARD))
    print("  Pushing counts every %ds. Ctrl-C to stop.\n" % interval)
    import time
    while True:
        try:
            cmd_push()
            time.sleep(interval)
        except KeyboardInterrupt:
            print("\n  Stopped watching. You are still on the board.")
            print("  Run --leave to remove yourself entirely.\n")
            return 0


def cmd_leave():
    creds = load_creds()
    if not creds:
        print("\n  Not in a workshop — nothing to leave.\n")
        return 0
    status, res = http("DELETE", "/api/me", token=creds["token"])
    try:
        os.remove(CRED_PATH)
    except OSError:
        pass
    if status == 200:
        print("\n  Removed %s from the board. Local token deleted.\n" % res.get("removed", creds["handle"]))
    else:
        print("\n  Local token deleted. Server said: %s\n" % res.get("error", "status %s" % status))
    return 0


# --------------------------------------------------------------------------
# REPORT
# --------------------------------------------------------------------------

CSS = """
:root{
  --ink:#0a0a0a; --panel:#0f140f; --rule:#1d2b1d;
  --phos:#00ff41; --phos-dim:#0f8a2e; --paper:#dff5e2;
  --amber:#ffb000; --muted:#6f8a72;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--paper);
  font:15px/1.6 "IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  padding:40px 20px 100px}
.wrap{max-width:920px;margin:0 auto}
.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.eyebrow{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;
  letter-spacing:.22em;text-transform:uppercase;color:var(--phos-dim);margin:0 0 14px}
h1{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:clamp(28px,5vw,44px);
  font-weight:700;letter-spacing:-.02em;margin:0 0 6px;color:var(--phos)}
.sub{color:var(--muted);margin:0 0 40px;font-size:14px}
.headline{border:1px solid var(--rule);background:var(--panel);padding:32px;margin:0 0 32px}
.big{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;
  font-size:clamp(40px,9vw,76px);font-weight:700;color:var(--amber);
  letter-spacing:-.03em;line-height:1;margin:0}
.big-label{color:var(--muted);font-size:13px;margin:12px 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);margin:0 0 40px}
.cell{background:var(--panel);padding:18px}
.cell .k{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:22px;
  color:var(--phos);font-weight:600}
.cell .v{color:var(--muted);font-size:12px;margin-top:5px;
  letter-spacing:.06em;text-transform:uppercase}
h2{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:13px;
  letter-spacing:.18em;text-transform:uppercase;color:var(--phos-dim);
  border-bottom:1px solid var(--rule);padding-bottom:10px;margin:44px 0 18px;font-weight:500}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;
  letter-spacing:.1em;text-transform:uppercase;color:var(--muted);
  text-align:right;padding:8px 10px;border-bottom:1px solid var(--rule);font-weight:500}
th:first-child,td:first-child{text-align:left}
td{padding:11px 10px;border-bottom:1px solid rgba(29,43,29,.55);text-align:right;
  font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:13px}
td:first-child{font-family:"IBM Plex Sans",sans-serif}
tr:last-child td{border-bottom:none}
tfoot td{border-top:1px solid var(--rule);color:var(--phos);font-weight:600}
.cost{color:var(--amber)}
.bars{display:flex;align-items:flex-end;gap:3px;height:150px;
  border-bottom:1px solid var(--rule);padding-top:10px}
.bar{flex:1;background:var(--phos-dim);min-height:2px;position:relative;transition:background .15s}
.bar:hover{background:var(--phos)}
.bar span{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);
  white-space:nowrap;font-family:"JetBrains Mono",monospace;font-size:10px;
  color:var(--paper);background:var(--ink);border:1px solid var(--rule);
  padding:3px 6px;opacity:0;pointer-events:none;margin-bottom:5px}
.bar:hover span{opacity:1}
.axis{display:flex;justify-content:space-between;font-family:"JetBrains Mono",monospace;
  font-size:10px;color:var(--muted);margin-top:8px}
.note{border-left:2px solid var(--phos-dim);padding:2px 0 2px 16px;color:var(--muted);
  font-size:13px;margin:18px 0}
.files{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--muted);
  max-height:180px;overflow:auto;border:1px solid var(--rule);padding:14px;
  background:var(--panel);line-height:1.8}
footer{margin-top:60px;padding-top:20px;border-top:1px solid var(--rule);
  color:var(--muted);font-size:12px;display:flex;justify-content:space-between;
  flex-wrap:wrap;gap:10px}
a{color:var(--phos-dim)}
@media (max-width:600px){body{padding:24px 14px 60px}.headline{padding:20px}}
"""


def fmt_tokens(n):
    if n >= 1_000_000_000:
        return "%.2fB" % (n / 1e9)
    if n >= 1_000_000:
        return "%.1fM" % (n / 1e6)
    if n >= 1_000:
        return "%.1fK" % (n / 1e3)
    return str(n)


def fmt_usd(v):
    if v == 0:
        return "$0.00"
    if v < 0.01:
        return "<$0.01"
    return "$%s" % format(round(v, 2), ",.2f")


def build_report(tally, args, total_cost):
    models = sorted(
        tally.by_model.items(),
        key=lambda kv: kv[1].cost(price_for(kv[0])[0]),
        reverse=True,
    )

    rows = []
    for model, t in models:
        rates, matched = price_for(model)
        cost = t.cost(rates)
        label = escape(model)
        if matched is None:
            label += ' <span style="color:var(--muted)">· no rate on file</span>'
        rows.append(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td>"
            "<td class='cost'>%s</td></tr>"
            % (label, fmt_tokens(t.input), fmt_tokens(t.output),
               fmt_tokens(t.cache_write), fmt_tokens(t.cache_read), fmt_usd(cost))
        )

    grand = Totals()
    for _, t in tally.by_model.items():
        grand.add(t.input, t.output, t.cache_write, t.cache_read, t.calls)

    days = sorted(k for k in tally.by_day if k != "undated")
    day_costs = []
    for d in days:
        c = 0.0
        for (model, dd), t in tally.by_model_day.items():
            if dd == d:
                c += t.cost(price_for(model)[0])
        day_costs.append((d, c))
    peak = max([c for _, c in day_costs] or [0]) or 1

    bars = "".join(
        "<div class='bar' style='height:%.1f%%'><span>%s · %s</span></div>"
        % (max(c / peak * 100, 1.2), d, fmt_usd(c))
        for d, c in day_costs
    )

    projects = sorted(
        tally.by_project.items(), key=lambda kv: kv[1].tokens, reverse=True
    )[:12]
    proj_rows = "".join(
        "<tr><td>%s</td><td>%s</td><td>%s</td></tr>"
        % (escape(p or "—"), fmt_tokens(t.tokens), "{:,}".format(t.calls))
        for p, t in projects
    )

    plan_block = ""
    if args.plan:
        multiple = total_cost / args.plan if args.plan else 0
        verdict = (
            "Your plan absorbed the difference."
            if multiple > 1
            else "You are under what the same work would cost on the API."
        )
        plan_block = (
            "<h2>Against a %s/month plan</h2>"
            "<div class='note'>Same work billed at API rates: <strong class='cost'>%s</strong>. "
            "That is <strong>%.2fx</strong> the plan price. %s</div>"
            % (fmt_usd(args.plan), fmt_usd(total_cost), multiple, verdict)
        )

    unknown_block = ""
    if tally.unknown_models:
        unknown_block = (
            "<div class='note'>No published rate on file for: %s. "
            "Their tokens are counted but priced at zero — edit the PRICES table "
            "in tokens.py to include them.</div>"
            % escape(", ".join(sorted(tally.unknown_models)))
        )

    window = "everything on disk"
    if args.days:
        window = "last %d days" % args.days
    span = ""
    if tally.earliest and tally.latest:
        span = "%s → %s" % (
            tally.earliest.astimezone().strftime("%b %-d"),
            tally.latest.astimezone().strftime("%b %-d, %Y"),
        )

    files_list = "<br>".join(escape(p) for _, p in tally.files_read[:400])
    if len(tally.files_read) > 400:
        files_list += "<br>… and %d more" % (len(tally.files_read) - 400)

    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Organized Tokens — Organized AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>%s</style></head><body><div class="wrap">

<p class="eyebrow">Organized Tokens</p>
<h1>What you actually spent.</h1>
<p class="sub">%s%s · generated %s · read entirely on this machine</p>

<div class="headline">
  <p class="big">%s</p>
  <p class="big-label">what these tokens would cost at published API rates</p>
</div>

<div class="grid">
  <div class="cell"><div class="k">%s</div><div class="v">Total tokens</div></div>
  <div class="cell"><div class="k">%s</div><div class="v">Sent to models</div></div>
  <div class="cell"><div class="k">%s</div><div class="v">Written back</div></div>
  <div class="cell"><div class="k">%s</div><div class="v">Read from cache</div></div>
  <div class="cell"><div class="k">%d</div><div class="v">Models used</div></div>
  <div class="cell"><div class="k">%d</div><div class="v">Sessions read</div></div>
</div>

%s

<h2>By model</h2>
<table>
<thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache write</th>
<th>Cache read</th><th>Cost</th></tr></thead>
<tbody>%s</tbody>
<tfoot><tr><td>Total</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td>
<td class="cost">%s</td></tr></tfoot>
</table>
%s

<h2>By day</h2>
<div class="bars">%s</div>
<div class="axis"><span>%s</span><span>%s</span></div>

<h2>By project</h2>
<table><thead><tr><th>Project</th><th>Tokens</th><th>Turns</th></tr></thead>
<tbody>%s</tbody></table>

<h2>Sources read</h2>
<div class="note">Nothing left this machine. These are the transcript files on
disk that were parsed. %d duplicate turns were skipped (the same message
replayed into a resumed session).</div>
<div class="files">%s</div>

<footer>
  <span>Organized AI · <a href="https://organizedai.vip">organizedai.vip</a></span>
  <span>Rate table current as of %s</span>
</footer>
</div></body></html>""" % (
        CSS,
        window,
        (" · " + span) if span else "",
        datetime.now().strftime("%b %-d, %Y at %-I:%M %p"),
        fmt_usd(total_cost),
        fmt_tokens(grand.tokens),
        fmt_tokens(grand.input),
        fmt_tokens(grand.output),
        fmt_tokens(grand.cache_read),
        len(tally.by_model),
        len(tally.files_read),
        plan_block,
        "".join(rows) or "<tr><td colspan=6>No usage found in this window.</td></tr>",
        fmt_tokens(grand.input), fmt_tokens(grand.output),
        fmt_tokens(grand.cache_write), fmt_tokens(grand.cache_read),
        fmt_usd(total_cost),
        unknown_block,
        bars or "<div style='color:var(--muted);font-size:13px'>No dated activity.</div>",
        days[0] if days else "",
        days[-1] if days else "",
        proj_rows or "<tr><td colspan=3>—</td></tr>",
        tally.dedup_hits,
        files_list or "none",
        PRICING_AS_OF,
    )


# --------------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        prog="tokens.py", description="Organized AI — local token audit"
    )
    ap.add_argument("--days", type=int, default=30,
                    help="lookback window; 0 reads everything on disk")
    ap.add_argument("--plan", type=float, default=0,
                    help="monthly plan price in USD, to compare against")
    ap.add_argument("--json", action="store_true", help="print totals, skip the report")
    ap.add_argument("--no-open", action="store_true", help="write the report, don't open it")
    ap.add_argument("--out", default="", help="where to write the report")

    w = ap.add_argument_group("workshop leaderboard (opt-in, sends counts only)")
    w.add_argument("--join", metavar="CODE", help="join a workshop leaderboard and start watching")
    w.add_argument("--as", dest="handle", metavar="NAME",
                   help="the name shown on the board (asked interactively if omitted)")
    w.add_argument("--no-watch", action="store_true", help="join only; don't start watching")
    w.add_argument("--push", action="store_true", help="push your counts once")
    w.add_argument("--watch", action="store_true", help="push your counts on a loop")
    w.add_argument("--interval", type=int, default=60, help="seconds between pushes (min 20)")
    w.add_argument("--leave", action="store_true", help="remove yourself from the board")

    args = ap.parse_args()

    if args.join:
        return cmd_join(args.join.strip().upper(), (args.handle or "").strip(),
                        watch_after=not args.no_watch, interval=max(args.interval, 20))
    if args.leave:
        return cmd_leave()
    if args.push:
        return cmd_push()
    if args.watch:
        return cmd_watch(max(args.interval, 20))

    cutoff = None
    if args.days and args.days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)

    files = discover()
    if not files:
        print("\n  No agent transcripts found on this machine.\n")
        print("  Looked in:")
        for _, pattern in SOURCES:
            print("    " + pattern)
        print("\n  If you use Claude Code or Codex under a different home directory,")
        print("  run the script from there. Nothing was uploaded either way.\n")
        return 1

    if not args.json:
        print("\n  Organized Tokens")
        print("  reading %d transcript files locally…\n" % len(files))

    tally = Tally()
    seen_ids = set()
    for label, path in files:
        try:
            rows = read_claude(path, tally, cutoff, seen_ids) if label == "Claude Code" \
                else read_codex(path, tally, cutoff)
            if rows:
                tally.files_read.append((label, path))
        except (OSError, UnicodeError, ValueError) as exc:
            tally.files_skipped.append((path, str(exc)))

    total_cost = sum(t.cost(price_for(m)[0]) for m, t in tally.by_model.items())

    if args.json:
        print(json.dumps({
            "window_days": args.days,
            "total_cost_usd": round(total_cost, 4),
            "files_read": len(tally.files_read),
            "prompts": tally.prompts,
            "tool_calls": tally.tool_calls,
            "by_model": {
                m: {
                    "input": t.input, "output": t.output,
                    "cache_write": t.cache_write, "cache_read": t.cache_read,
                    "cost_usd": round(t.cost(price_for(m)[0]), 4),
                }
                for m, t in tally.by_model.items()
            },
        }, indent=2))
        return 0

    html = build_report(tally, args, total_cost)

    out = args.out or os.path.join(
        tempfile.gettempdir(),
        "organized-tokens-%s.html" % datetime.now().strftime("%Y%m%d-%H%M%S"),
    )
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)

    for model, t in sorted(tally.by_model.items(),
                           key=lambda kv: kv[1].cost(price_for(kv[0])[0]),
                           reverse=True)[:6]:
        print("    %-34s %10s   %s"
              % (model[:34], fmt_tokens(t.tokens), fmt_usd(t.cost(price_for(model)[0]))))

    print("\n    %-34s %10s   %s" % ("TOTAL", "", fmt_usd(total_cost)))
    print("\n  Report: %s\n" % out)

    if not args.no_open:
        try:
            webbrowser.open("file://" + os.path.abspath(out))
        except Exception:
            print("  Open that file in a browser to see the full report.\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n  Stopped. Nothing was written.\n")
        sys.exit(130)

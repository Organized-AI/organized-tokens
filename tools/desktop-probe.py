#!/usr/bin/env python3
"""
Claude Desktop probe — what is actually on this machine?

Run this BEFORE writing a Desktop parser. It inventories the directories
Claude Desktop writes, reports the *shape* of what it finds, and tells you
whether token accounting exists there at all.

It prints structure only. Keys, types, counts, file sizes. It never prints a
string value, so conversation content cannot leak into the output you paste
back. Values are shown as <str:142> meaning "a string of 142 characters".

    python3 desktop-probe.py              # summary
    python3 desktop-probe.py --deep       # per-file key inventory
    python3 desktop-probe.py --out p.txt  # write to a file

Organized AI — MIT
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

HOME = os.path.expanduser("~")

# Every place Claude Desktop, Cowork, the Code tab, or Claude Code CLI is
# documented or observed to write. Missing directories are reported, not fatal.
ROOTS = [
    ("Desktop app data",      os.path.join(HOME, "Library/Application Support/Claude")),
    ("Desktop app data (3P)", os.path.join(HOME, "Library/Application Support/Claude-3p")),
    ("Desktop app data (win)", os.path.join(HOME, "AppData/Local/Claude")),
    ("Desktop logs",          os.path.join(HOME, "Library/Logs/Claude")),
    ("Desktop outputs",       os.path.join(HOME, "Claude")),
    ("Claude Code CLI",       os.path.join(HOME, ".claude")),
    ("Codex CLI",             os.path.join(HOME, ".codex")),
]

# If any of these appear as JSON keys, per-turn token accounting exists there
# and the leaderboard can price it. If none appear, it does not, and no amount
# of parsing will conjure it.
TOKEN_KEYS = {
    "input_tokens", "output_tokens", "cache_read_input_tokens",
    "cache_creation_input_tokens", "cached_input_tokens", "usage",
    "total_token_usage", "last_token_usage", "token_count", "cost_usd", "costUSD",
}

# Never print the value of anything whose key looks like content.
SENSITIVE = {"content", "text", "message", "prompt", "completion", "input",
             "output", "body", "summary", "title", "name", "path", "cwd", "file"}


def shape(value, depth=0):
    """Describe a value without revealing it."""
    if depth > 3:
        return "…"
    if isinstance(value, dict):
        return "{%d keys}" % len(value)
    if isinstance(value, list):
        return "[%d]" % len(value)
    if isinstance(value, str):
        return "<str:%d>" % len(value)
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "num(%s)" % value   # numbers are the thing we are looking for
    if value is None:
        return "null"
    return type(value).__name__


def walk_keys(obj, prefix="", out=None, depth=0):
    out = {} if out is None else out
    if depth > 5:
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = (prefix + "." + str(k)) if prefix else str(k)
            if isinstance(v, (dict, list)):
                out[path] = shape(v)
                walk_keys(v, path, out, depth + 1)
            else:
                # Numbers are safe and are exactly what we are hunting for.
                # Everything else is described, never shown.
                safe = str(k).lower() not in SENSITIVE and isinstance(v, (int, float, bool))
                out[path] = shape(v) if safe else shape(v)
    elif isinstance(obj, list) and obj:
        walk_keys(obj[0], prefix + "[0]", out, depth + 1)
    return out


def sniff_json_file(path, max_lines=40):
    """Return (kind, key_paths, token_keys_found, records_seen)."""
    keys, tokens, records = {}, set(), 0
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    if size > 60 * 1024 * 1024:
        return ("too-large", {}, set(), 0)

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(4096)
            fh.seek(0)
            looks_jsonl = "\n{" in head or (head.lstrip()[:1] == "{" and "}\n{" in head)

            if looks_jsonl:
                for i, line in enumerate(fh):
                    if i >= max_lines:
                        break
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    records += 1
                    keys.update(walk_keys(obj))
                kind = "jsonl"
            else:
                fh.seek(0)
                obj = json.load(fh)
                records = 1
                keys.update(walk_keys(obj))
                kind = "json"
    except (OSError, ValueError, UnicodeError):
        return ("unreadable", {}, set(), 0)

    for k in keys:
        leaf = k.split(".")[-1].split("[")[0]
        if leaf in TOKEN_KEYS:
            tokens.add(k)
    return (kind, keys, tokens, records)


def main():
    ap = argparse.ArgumentParser(prog="desktop-probe.py")
    ap.add_argument("--deep", action="store_true", help="list key paths per file family")
    ap.add_argument("--out", default="", help="write the report to a file")
    args = ap.parse_args()

    lines = []
    def say(s=""):
        lines.append(s)
        print(s)

    say("")
    say("  Claude Desktop probe — structure only, no content")
    say("  " + "-" * 56)
    say("  python %s on %s" % (sys.version.split()[0], sys.platform))
    say("")

    any_tokens = False
    family_keys = defaultdict(dict)
    family_tokens = defaultdict(set)

    for label, root in ROOTS:
        if not os.path.isdir(root):
            say("  [ ] %-24s not present" % label)
            continue

        files = 0
        total_bytes = 0
        by_ext = Counter()
        json_files = []

        for dirpath, dirnames, filenames in os.walk(root):
            # Big regenerable caches tell us nothing and take forever.
            dirnames[:] = [d for d in dirnames if d not in (
                "Cache", "Code Cache", "GPUCache", "DawnCache", "node_modules",
                "vm_bundles", "Crashpad", "blob_storage", "Service Worker")]
            for fn in filenames:
                p = os.path.join(dirpath, fn)
                try:
                    total_bytes += os.path.getsize(p)
                except OSError:
                    continue
                files += 1
                ext = os.path.splitext(fn)[1].lower() or "(none)"
                by_ext[ext] += 1
                if ext in (".json", ".jsonl", ".log"):
                    json_files.append(p)

        say("  [x] %-24s %5d files  %6.1f MB" % (label, files, total_bytes / 1e6))
        say("      %s" % root)
        top = ", ".join("%s×%d" % (e, n) for e, n in by_ext.most_common(6))
        say("      %s" % (top or "empty"))

        # Group by the directory family so 200 session files report once.
        for p in json_files[:600]:
            rel = os.path.relpath(p, root)
            parts = rel.split(os.sep)
            family = os.sep.join(parts[:2]) if len(parts) > 1 else parts[0]
            fam = "%s :: %s/*%s" % (label, family, os.path.splitext(p)[1])
            res = sniff_json_file(p)
            if not res:
                continue
            kind, keys, tokens, records = res
            if kind in ("unreadable", "too-large") or not keys:
                continue
            family_keys[fam].update(keys)
            if tokens:
                family_tokens[fam] |= tokens
                any_tokens = True
        say("")

    say("  " + "=" * 56)
    say("  TOKEN ACCOUNTING")
    say("  " + "=" * 56)
    if any_tokens:
        for fam, toks in sorted(family_tokens.items()):
            say("")
            say("  FOUND in %s" % fam)
            for t in sorted(toks)[:20]:
                say("      %s" % t)
        say("")
        say("  → These files can be priced. Point the parser at them.")
    else:
        say("")
        say("  None found in any Claude Desktop directory.")
        say("")
        say("  This is the expected result for Desktop chat: token usage is")
        say("  not written client-side, so it cannot be read client-side.")
        say("  The leaderboard needs a different metric for Desktop users —")
        say("  see PLAN.md Part 3.")
    say("")

    if args.deep:
        say("  " + "=" * 56)
        say("  KEY INVENTORY (structure only)")
        say("  " + "=" * 56)
        for fam in sorted(family_keys):
            say("")
            say("  %s" % fam)
            for k in sorted(family_keys[fam])[:60]:
                say("      %-52s %s" % (k[:52], family_keys[fam][k]))
        say("")

    say("  Paste this whole output back. It contains no conversation content.")
    say("")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
        print("  written to %s\n" % args.out)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)

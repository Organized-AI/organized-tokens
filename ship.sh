#!/usr/bin/env bash
#
# Organized Tokens — put this repo on disk and push it, plus register the
# plugin in the AIIC marketplace.
#
#   bash ship.sh            # do everything
#   bash ship.sh repo       # just the repo
#   bash ship.sh plugin     # just the marketplace registration
#
# Requires: git, gh (authenticated against the Organized-AI org), python3.

set -euo pipefail

ORG="Organized-AI"
REPO="organized-tokens"
MARKET="Organized-aiic-marketplace"
DEST="/Users/supabowl/${REPO}"

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
die()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# GUARD — the failure that actually happened last time.
#
# /Users/supabowl is itself a git working tree with four remotes (origin ->
# BHT-Google-Hub, plus blade, clawdbot, rabbit-hole). Running `gh repo create
# --source=.` from there stages the entire home directory, including Claude
# auth tokens and MCP credential files. Refuse rather than warn.
# ---------------------------------------------------------------------------
guard_cwd() {
  local here; here="$(pwd -P)"
  local home; home="$(cd "$HOME" && pwd -P)"
  [ "$here" = "$home" ] && die "Refusing to run from \$HOME — it is a git working tree with 4 remotes. cd into the project first."
  [ "$here" = "/" ] && die "Refusing to run from /."
  return 0
}

need() { command -v "$1" >/dev/null 2>&1 || die "Missing: $1"; }
need git; need python3
[ "${1:-all}" = "local" ] || need gh

# ---------------------------------------------------------------------------
# 1. LOCAL — copy this directory to its permanent home
# ---------------------------------------------------------------------------
do_local() {
  guard_cwd
  local src; src="$(pwd -P)"
  [ -f "$src/public/tokens.py" ] || die "Run this from inside the unzipped organized-tokens directory."

  if [ "$src" = "$DEST" ]; then
    green "Already at $DEST"
  else
    mkdir -p "$(dirname "$DEST")"
    [ -e "$DEST" ] && die "$DEST already exists. Move or remove it first."
    cp -R "$src" "$DEST"
    green "Copied to $DEST"
  fi

  cd "$DEST"
  python3 -m py_compile public/tokens.py || die "tokens.py does not compile"
  green "tokens.py compiles"
}

# ---------------------------------------------------------------------------
# 2. REMOTE — create and push Organized-AI/organized-tokens
# ---------------------------------------------------------------------------
do_repo() {
  cd "$DEST"
  guard_cwd

  if [ ! -d .git ]; then
    git init -q
    git add .
    git commit -qm "Organized Tokens: local-only AI token audit, page + script + plugin"
    green "Initialised git"
  fi

  if gh repo view "${ORG}/${REPO}" >/dev/null 2>&1; then
    warn "${ORG}/${REPO} already exists — pushing to it"
    git remote get-url origin >/dev/null 2>&1 || \
      git remote add origin "https://github.com/${ORG}/${REPO}.git"
    git push -u origin HEAD
  else
    gh repo create "${ORG}/${REPO}" --public --source=. --remote=origin --push \
      --description "Local-only AI token audit. One command, nothing uploaded."
  fi
  green "Pushed → https://github.com/${ORG}/${REPO}"
}

# ---------------------------------------------------------------------------
# 3. MARKETPLACE — register the plugin in Organized-aiic-marketplace
# ---------------------------------------------------------------------------
do_plugin() {
  local work; work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  git clone --quiet "https://github.com/${ORG}/${MARKET}.git" "$work/m"
  cd "$work/m"

  rm -rf "./${REPO}"
  cp -R "${DEST}/plugin/organized-tokens" "./${REPO}"
  green "Copied plugin into ${MARKET}/${REPO}"

  python3 - <<'PY'
import json, os, sys

path = ".claude-plugin/marketplace.json"
mp = json.load(open(path))
entry = {
    "name": "organized-tokens",
    "source": "./organized-tokens",
    "description": "Audit your own AI token spend from local session files and get a concrete plan for what to move to a cheaper model",
    "category": "productivity",
}

names = [p.get("name") for p in mp["plugins"]]
if entry["name"] in names:
    mp["plugins"][names.index(entry["name"])] = entry
    print("  updated existing entry")
else:
    mp["plugins"].append(entry)
    print("  appended new entry")

json.dump(mp, open(path, "w"), indent=2)
open(path, "a").write("\n")

# Validate every plugin still resolves before we let this be pushed.
bad = 0
for p in mp["plugins"]:
    src = p["source"].lstrip("./")
    manifest = os.path.join(src, ".claude-plugin", "plugin.json")
    ok = os.path.isfile(manifest)
    if ok:
        json.load(open(manifest))
    print(("  OK   " if ok else "  FAIL ") + p["name"] + " -> " + p["source"])
    bad += 0 if ok else 1

    skills = os.path.join(src, "skills")
    if os.path.isdir(skills):
        for s in sorted(os.listdir(skills)):
            sp = os.path.join(skills, s, "SKILL.md")
            if os.path.isfile(sp):
                t = open(sp).read()
                fm = t.split("---")[1] if t.startswith("---") else ""
                good = "name:" in fm and "description:" in fm
                print(("       ok  " if good else "       BAD ") + s)
                bad += 0 if good else 1

if bad:
    sys.exit("  %d FAILURES — not pushing" % bad)
print("  ALL CHECKS PASSED")
PY

  git add .
  git commit -qm "Add organized-tokens plugin: local token audit skill"
  git push -q
  green "Pushed → https://github.com/${ORG}/${MARKET}"
}

case "${1:-all}" in
  local)  do_local ;;
  repo)   do_local; do_repo ;;
  plugin) do_plugin ;;
  all)    do_local; do_repo; do_plugin ;;
  *)      die "Usage: bash ship.sh [all|local|repo|plugin]" ;;
esac

echo
green "Done."
echo "  Local:       ${DEST}"
echo "  Repo:        https://github.com/${ORG}/${REPO}"
echo "  Marketplace: https://github.com/${ORG}/${MARKET}"
echo
echo "Next: deploy the Worker —"
echo "  cd ${DEST} && npx wrangler deploy"
echo
echo "Leaderboard is a separate Worker with its own D1 and Durable Object:"
echo "  cd ${DEST}/leaderboard && npm install"
echo "  npx wrangler d1 create organized-tokens-leaderboard   # paste id into wrangler.jsonc"
echo "  npm run db:remote && npx wrangler secret put ADMIN_SECRET && npx wrangler deploy"
echo "  See PLAN.md Part 2 for the workshop row and the adversarial pass."

#!/bin/bash
# ─── AR Portal enforced deploy ────────────────────────────────────────────────
# Usage:  ./deploy.sh file1 [file2 ...]
#   Files are taken from ./staging/ (same relative layout as the repo:
#   app.js, db.js, public/index.html, ...) and promoted into place ONLY after
#   every gate passes. This encodes the manual discipline so it cannot be
#   skipped: backup → syntax → transmit-quiet → promote → restart → verify.
set -euo pipefail
cd /home/ecf-admin/ar-portal
STAGING=/home/ecf-admin/ar-portal/staging
TS=$(date +%Y%m%d-%H%M%S)

[ $# -ge 1 ] || { echo "usage: deploy.sh <file> [file...]  (files staged under $STAGING)"; exit 2; }

echo "── [1/6] validate staged files"
for f in "$@"; do
  [ -f "$STAGING/$f" ] || { echo "✗ missing in staging: $f"; exit 2; }
  case "$f" in
    *.js)   node -c "$STAGING/$f" || { echo "✗ syntax: $f"; exit 2; } ;;
    *.html) node -e '
      const fs=require("fs");
      const h=fs.readFileSync(process.argv[1],"utf8");
      const re=/<script[^>]*>([\s\S]*?)<\/script>/g; let m,bad=0;
      while((m=re.exec(h))){ if(!m[1].trim())continue; try{new Function(m[1]);}catch(e){bad++;console.log(e.message);} }
      process.exit(bad?1:0);' "$STAGING/$f" || { echo "✗ inline JS: $f"; exit 2; } ;;
  esac
  echo "  ✓ $f"
done

echo "── [2/6] transmit-quiet gate (waits up to 15 min)"
for i in $(seq 1 60); do
  ST=$(sqlite3 ar-portal.db "SELECT CASE WHEN datetime(MAX(created_at), '+3 minutes') < datetime('now') THEN 'CLEAR' ELSE 'ACTIVE' END FROM audit_log WHERE action='edi_transmit';")
  [ "$ST" = "CLEAR" ] && break
  sleep 15
done
[ "$ST" = "CLEAR" ] || { echo "✗ EDI transmission active — aborting deploy"; exit 3; }
echo "  ✓ no active transmission"

echo "── [3/6] backup (git snapshot + .bak)"
git add -A >/dev/null 2>&1 || true
git commit -qm "pre-deploy snapshot $TS" >/dev/null 2>&1 || true
for f in "$@"; do [ -f "$f" ] && cp "$f" "$f.$TS.bak"; done
echo "  ✓ committed pre-deploy snapshot"

echo "── [4/6] promote"
for f in "$@"; do
  mkdir -p "$(dirname "$f")"
  cp "$STAGING/$f" "$f"
  echo "  ✓ $f"
done

echo "── [5/6] restart"
sudo systemctl restart ar-portal.service
sleep 4
systemctl is-active --quiet ar-portal.service || { echo "✗ service failed to start — check journal; git checkout to roll back"; exit 4; }
echo "  ✓ ar-portal active"

echo "── [6/6] smoke test"
if node smoke-test.js; then
  git add -A >/dev/null 2>&1 || true
  git commit -qm "deploy $TS: $*" >/dev/null 2>&1 || true
  echo "✅ DEPLOY OK ($TS) — committed"
else
  echo "⚠️  SMOKE FAILED — service is running the new code; investigate now or roll back:"
  echo "    git log --oneline -3   &&   git checkout HEAD~1 -- <file> && sudo systemctl restart ar-portal"
  exit 5
fi

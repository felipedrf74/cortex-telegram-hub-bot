#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# smoke-evidence-prune.sh — Age out old smoke-evidence JSON files.
#
# release-pipeline-risk-based-optimization (2026-05-03) — Round 3.
#
# Without this, docs/release/smoke-evidence/ grows unboundedly. The
# evidence files are useful for ~60 days (verifying production decisions,
# auditing drift); past that they're noise.
#
# Usage:
#   scripts/smoke-evidence-prune.sh                  # dry-run (default)
#   scripts/smoke-evidence-prune.sh --apply          # actually delete
#   scripts/smoke-evidence-prune.sh --max-age-days N # default 60
#   scripts/smoke-evidence-prune.sh --keep-latest M  # keep at least M most-
#                                                       recent files per
#                                                       smokeName regardless
#                                                       of age (default 5)
#
# Safety:
#   - default mode is dry-run (lists what WOULD be deleted)
#   - never deletes the most-recent N records per smokeName
#   - never deletes files newer than max-age-days
#
# Disable scheduled invocation with NEXUS_SMOKE_PRUNE_ENABLED=0 (used by
# any future cron wiring, not by this script directly).
# ─────────────────────────────────────────────────────
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="$LOCAL_DIR/docs/release/smoke-evidence"

APPLY=false
MAX_AGE_DAYS=60
KEEP_LATEST=5

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=true; shift;;
    --max-age-days) MAX_AGE_DAYS="$2"; shift 2;;
    --keep-latest) KEEP_LATEST="$2"; shift 2;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \?//'
      exit 0;;
    *) shift;;
  esac
done

if [ ! -d "$EVIDENCE_DIR" ]; then
  echo "(no evidence directory at $EVIDENCE_DIR)"
  exit 0
fi

export NX_EVIDENCE_DIR="$EVIDENCE_DIR"
export NX_APPLY="$APPLY"
export NX_MAX_AGE_DAYS="$MAX_AGE_DAYS"
export NX_KEEP_LATEST="$KEEP_LATEST"

NODE_NO_WARNINGS=1 node -e '
(() => {
  const fs = require("fs");
  const path = require("path");
  const evidenceDir = process.env.NX_EVIDENCE_DIR;
  const apply = process.env.NX_APPLY === "true";
  const maxAgeDays = Number(process.env.NX_MAX_AGE_DAYS) || 60;
  const keepLatest = Number(process.env.NX_KEEP_LATEST) || 5;
  const cutoffEpoch = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const entries = fs.readdirSync(evidenceDir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      const full = path.join(evidenceDir, n);
      let mtime = 0;
      let smokeName = "?";
      let sha = "?";
      try {
        const st = fs.statSync(full);
        mtime = st.mtimeMs;
      } catch (_) {}
      try {
        const j = JSON.parse(fs.readFileSync(full, "utf8"));
        smokeName = j.smokeName || smokeName;
        sha = j.sha || sha;
      } catch (_) {}
      return { name: n, full, mtime, smokeName, sha };
    });

  // Group by smokeName, sort newest-first, mark protected (top keepLatest).
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.smokeName)) groups.set(e.smokeName, []);
    groups.get(e.smokeName).push(e);
  }
  const toPrune = [];
  const protectedSet = new Set();
  for (const [name, list] of groups) {
    list.sort((a, b) => b.mtime - a.mtime);
    for (let i = 0; i < list.length; i++) {
      if (i < keepLatest) {
        protectedSet.add(list[i].full);
        continue;
      }
      if (list[i].mtime < cutoffEpoch) {
        toPrune.push(list[i]);
      }
    }
  }

  console.log("# Smoke evidence prune");
  console.log();
  console.log(`Evidence dir: ${evidenceDir}`);
  console.log(`Total records: ${entries.length}`);
  console.log(`Smoke names: ${groups.size}`);
  console.log(`Protected (most-recent ${keepLatest} per smoke): ${protectedSet.size}`);
  console.log(`Older than ${maxAgeDays}d AND outside protected window: ${toPrune.length}`);
  console.log();
  if (toPrune.length === 0) {
    console.log("✅ Nothing to prune.");
    return;
  }
  console.log(`## Records ${apply ? "deleted" : "that would be deleted (dry-run)"}`);
  console.log();
  for (const e of toPrune) {
    const ageDays = ((Date.now() - e.mtime) / (24 * 60 * 60 * 1000)).toFixed(1);
    const status = apply ? "[deleted]" : "[would-delete]";
    console.log(`- ${status} ${e.name} (smoke=${e.smokeName} sha=${e.sha} age=${ageDays}d)`);
    if (apply) {
      try {
        fs.unlinkSync(e.full);
      } catch (err) {
        console.log(`    ⚠️ delete failed: ${err.message}`);
      }
    }
  }
  console.log();
  if (!apply) {
    console.log(`Re-run with --apply to actually delete ${toPrune.length} files.`);
  }
})();
'

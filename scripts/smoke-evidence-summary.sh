#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# smoke-evidence-summary.sh — Render a human-readable summary of
# all smoke-evidence JSON files under .local/release/smoke-evidence/.
#
# release-pipeline-risk-based-optimization (2026-05-03) — Round 3.
#
# Usage:
#   scripts/smoke-evidence-summary.sh                 # markdown table (default)
#   scripts/smoke-evidence-summary.sh --json          # JSON aggregate
#   scripts/smoke-evidence-summary.sh --sha <short>   # filter by SHA
#   scripts/smoke-evidence-summary.sh --since <iso>   # filter by run start
#   scripts/smoke-evidence-summary.sh --latest        # one row per smokeName
#                                                       (newest run only)
#
# Reads:
#   engine/.local/release/smoke-evidence/<smoke-name>-<sha>-<utc>.json
#
# Output (markdown):
#   | Smoke | SHA | Branch | Verdict | Duration | Run completed | File |
#
# Why: today every audit pass rerun smokes to "prove" something. With this
# tool, the audit reads the existing evidence and renders a single table
# in <1 s. Combined with promote-to-prod.sh's smoke-evidence reuse, the
# old "rerun-to-verify" pattern is gone.
# ─────────────────────────────────────────────────────
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="$LOCAL_DIR/.local/release/smoke-evidence"

FORMAT="markdown"
FILTER_SHA=""
FILTER_SINCE=""
LATEST_ONLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --json|json) FORMAT="json"; shift;;
    --markdown|markdown|md) FORMAT="markdown"; shift;;
    --sha) FILTER_SHA="$2"; shift 2;;
    --since) FILTER_SINCE="$2"; shift 2;;
    --latest) LATEST_ONLY=true; shift;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \?//'
      exit 0;;
    *) shift;;
  esac
done

if [ ! -d "$EVIDENCE_DIR" ]; then
  echo "(no evidence directory at $EVIDENCE_DIR — has any smoke run yet?)"
  exit 0
fi

# Collect every JSON file. We use a small node helper to parse + filter +
# render so we don't rely on jq being installed everywhere.
export NX_FORMAT="$FORMAT"
export NX_FILTER_SHA="$FILTER_SHA"
export NX_FILTER_SINCE="$FILTER_SINCE"
export NX_LATEST_ONLY="$LATEST_ONLY"
export NX_LOCAL_DIR="$LOCAL_DIR"
export NX_EVIDENCE_DIR="$EVIDENCE_DIR"

ls "$EVIDENCE_DIR"/*.json 2>/dev/null \
  | NODE_NO_WARNINGS=1 node -e '
  (() => {
    const fs = require("fs");
    const path = require("path");
    const files = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    const filterSha = process.env.NX_FILTER_SHA || "";
    const filterSince = process.env.NX_FILTER_SINCE || "";
    const latestOnly = process.env.NX_LATEST_ONLY === "true";
    const format = process.env.NX_FORMAT;

    const records = [];
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        if (!j.smokeName) continue;
        if (filterSha && j.sha !== filterSha) continue;
        if (filterSince && j.runStartedAt < filterSince) continue;
        records.push({
          smokeName: j.smokeName,
          sha: j.sha || "?",
          branch: j.branch || "?",
          verdict: j.verdict || "?",
          durationS: j.durationS ?? null,
          runCompletedAt: j.runCompletedAt || j.runStartedAt || "?",
          totals: j.totals || null,
          file: path.relative(process.env.NX_LOCAL_DIR, f),
        });
      } catch (_) {
        // skip malformed
      }
    }

    // Sort newest first
    records.sort((a, b) => (b.runCompletedAt || "").localeCompare(a.runCompletedAt || ""));

    let out = records;
    if (latestOnly) {
      const seen = new Set();
      out = [];
      for (const r of records) {
        if (seen.has(r.smokeName)) continue;
        seen.add(r.smokeName);
        out.push(r);
      }
    }

    if (format === "json") {
      console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        evidenceDir: process.env.NX_EVIDENCE_DIR,
        filters: { sha: filterSha, since: filterSince, latestOnly },
        count: out.length,
        records: out,
      }, null, 2));
      return;
    }

    // markdown
    if (out.length === 0) {
      console.log(`# Smoke evidence summary`);
      console.log();
      console.log(`(no records match the current filter)`);
      return;
    }
    const counts = { passed: 0, failed: 0, blocked: 0, other: 0 };
    for (const r of out) {
      if (r.verdict === "passed") counts.passed++;
      else if (r.verdict === "failed") counts.failed++;
      else if (r.verdict === "blocked") counts.blocked++;
      else counts.other++;
    }
    console.log(`# Smoke evidence summary`);
    console.log();
    console.log(`Records: ${out.length} (passed: ${counts.passed}, failed: ${counts.failed}, blocked: ${counts.blocked}, other: ${counts.other})`);
    console.log();
    console.log(`| Smoke | SHA | Branch | Verdict | Duration | Run completed | Detail |`);
    console.log(`| --- | --- | --- | --- | --- | --- | --- |`);
    const verdictGlyph = { passed: "✅", failed: "❌", blocked: "⚠️" };
    for (const r of out) {
      const totals = r.totals
        ? `${r.totals.passed}/${r.totals.total}`
        : (r.durationS != null ? `${r.durationS}s` : "—");
      const dur = r.durationS != null ? `${r.durationS}s` : "—";
      console.log(`| \`${r.smokeName}\` | \`${r.sha}\` | \`${r.branch}\` | ${verdictGlyph[r.verdict] || ""} ${r.verdict} | ${dur} | \`${r.runCompletedAt}\` | ${totals} |`);
    }
  })();
  '

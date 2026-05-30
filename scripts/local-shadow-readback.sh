#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# local-shadow-readback.sh — read back + privacy-check the LOCAL shadow corpus.
#
# Wave-1 Rank 3 (chat-core-v2 production-activation). Companion to
# scripts/local-shadow-traffic.sh. Reads the LOCAL SQLite DB and:
#
#   1. Counts chat_v2_replay_bundles (shadow) + chat_v2_trace_spans rows.
#   2. ASSERTS zero raw message strings: every persisted contextPack carries a
#      64-hex HMAC `messageHash`, exposes NO `message` / `messagePreview`
#      field, and the redacted trace summaries are `name:status` only. If any
#      non-hashed/raw text is found, the script FAILS.
#   3. ASSERTS identifiers are HMAC/hex (messageHash + userMessageHash match
#      ^[a-f0-9]{64}$; trace ids match ^chatv2-shadow:[a-f0-9]{16}$).
#   4. Invokes evaluateChatCoreV2ShadowGateReadiness over the same DB and prints
#      the HONEST gate-readiness verdict (rows / schema / safe-shape /
#      gateMet=false until recall@8 on a labeled corpus).
#
# Privacy posture: this script reads ONLY redacted, HMAC-only rows; it never
# prints raw bundle bodies. A raw-text leak is a HARD FAILURE, not a warning.
#
# Usage:
#   ./scripts/local-shadow-readback.sh
#   DATABASE_PATH=./data/bot.db ./scripts/local-shadow-readback.sh
#   ./scripts/local-shadow-readback.sh --db ./data/local.db
#
# Options:
#   --db PATH    Path to the local SQLite DB (default: $DATABASE_PATH or
#                ./data/bot.db).
#   --help       Show this help
# ─────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DB_PATH="${DATABASE_PATH:-./data/bot.db}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/local-shadow-readback.sh [--db PATH]

Reads the local chat-core-v2 shadow corpus, asserts it carries ONLY redacted
HMAC/hex identifiers (no raw message text), and prints the honest shadow-gate
readiness verdict. Fails hard on any raw-text leak.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

# Resolve relative DB paths against the repo root (matches config.app.databasePath
# default of ./data/bot.db).
case "$DB_PATH" in
  /*) : ;;
  *) DB_PATH="$ROOT_DIR/$DB_PATH" ;;
esac

if [[ ! -f "$DB_PATH" ]]; then
  echo "❌ Local SQLite DB not found at: $DB_PATH" >&2
  echo "   Boot the local sandbox and run scripts/local-shadow-traffic.sh first," >&2
  echo "   or pass --db <path> / DATABASE_PATH=<path>." >&2
  exit 1
fi

echo "═══════════════════════════════════════════════"
echo "  🔎 Local shadow-corpus readback + gate check"
echo "═══════════════════════════════════════════════"
echo "DB: $DB_PATH"
echo ""

# Everything else runs inside one node process so the raw-text scan, the
# HMAC/hex assertions, and the gate-readiness call all share one DB handle.
# The gate verdict prefers the REAL compiled exported function
# (dist/services/chat-core-v2/shadow-gate-readiness.js) and falls back to an
# inline byte-equivalent of evaluateChatCoreV2ShadowGateReadiness when dist/ is
# not built — the fallback keeps the SAME thresholds and the SAME honest
# gateMet=false invariant.
DB_PATH="$DB_PATH" ROOT_DIR="$ROOT_DIR" node -e '
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH;
const rootDir = process.env.ROOT_DIR;
const HMAC_HEX_64 = /^[a-f0-9]{64}$/;
const SHADOW_LIKE = "chatv2-shadow-replay:%";

const db = new Database(dbPath, { readonly: true });

function tableExists(name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", name),
  );
}

if (!tableExists("chat_v2_replay_bundles")) {
  console.error("❌ chat_v2_replay_bundles table is missing — run migrations + traffic first.");
  process.exit(1);
}

const bundles = db
  .prepare("SELECT replay_bundle_id, redacted_bundle_json FROM chat_v2_replay_bundles WHERE replay_bundle_id LIKE ?")
  .all(SHADOW_LIKE);

const traceCount = tableExists("chat_v2_trace_spans")
  ? db.prepare("SELECT COUNT(*) AS c FROM chat_v2_trace_spans").get().c
  : 0;

console.log("Shadow replay bundles : " + bundles.length);
console.log("Trace spans (all)     : " + traceCount);
console.log("");

// ── Privacy assertion: zero raw strings; identifiers are HMAC/hex ──
const violations = [];
for (const row of bundles) {
  let bundle;
  try {
    bundle = JSON.parse(row.redacted_bundle_json);
  } catch {
    violations.push(row.replay_bundle_id + ": bundle JSON failed to parse");
    continue;
  }
  const ctx = bundle && bundle.contextPack;
  if (!ctx || typeof ctx !== "object") {
    violations.push(row.replay_bundle_id + ": missing contextPack");
    continue;
  }
  if (typeof ctx.message === "string" || typeof ctx.messagePreview === "string") {
    violations.push(row.replay_bundle_id + ": RAW message/messagePreview present");
  }
  if (typeof ctx.messageHash !== "string" || !HMAC_HEX_64.test(ctx.messageHash)) {
    violations.push(row.replay_bundle_id + ": messageHash is not a 64-hex HMAC");
  }
  if (ctx.userMessageHash !== undefined && !HMAC_HEX_64.test(String(ctx.userMessageHash))) {
    violations.push(row.replay_bundle_id + ": userMessageHash is not a 64-hex HMAC");
  }
}

// Trace ids + redacted summaries must be hex-derived / name:status only.
if (tableExists("chat_v2_trace_spans")) {
  const spans = db
    .prepare("SELECT trace_span_id, redacted_summary FROM chat_v2_trace_spans WHERE trace_span_id LIKE ?")
    .all("chatv2-shadow:%");
  const idRe = /^chatv2-shadow:[a-f0-9]{16}$/;
  const summaryRe = /^[a-z_]+:[a-z_]+$/;
  for (const span of spans) {
    if (!idRe.test(span.trace_span_id)) {
      violations.push(span.trace_span_id + ": trace id is not a sha256-derived shadow id");
    }
    if (!summaryRe.test(span.redacted_summary)) {
      violations.push(span.trace_span_id + ": redacted_summary is not name:status");
    }
  }
}

if (violations.length > 0) {
  console.error("❌ PRIVACY ASSERTION FAILED — raw/non-hashed content detected:");
  for (const v of violations.slice(0, 20)) console.error("   - " + v);
  if (violations.length > 20) console.error("   ... and " + (violations.length - 20) + " more");
  process.exit(1);
}
console.log("✅ Privacy assertion passed: every identifier is HMAC/hex; no raw message text.");
console.log("");

// ── Gate-readiness verdict ─────────────────────────────────────────
function inlineReadiness() {
  // Byte-equivalent of evaluateChatCoreV2ShadowGateReadiness (used only when
  // dist/ is not built). SAME thresholds, SAME safe-shape check, SAME honest
  // gateMet=false invariant.
  const thresholds = { minRows: 50, minSchemaValidPct: 0.99, maxSafeShapeViolations: 0 };
  let schemaValid = 0;
  let safeShapeViolations = 0;
  for (const row of bundles) {
    let b;
    try { b = JSON.parse(row.redacted_bundle_json); } catch { b = null; }
    const resp = b && b.response;
    const ctx = b && b.contextPack;
    const schemaOk = Boolean(
      resp && typeof resp === "object" && resp.type === "chat_core_v2_shadow_plan"
        && resp.wouldExecute === false && typeof resp.routeMethod === "string"
        && resp.routeMethod.length > 0 && ctx && typeof ctx === "object"
        && typeof ctx.hashVersion === "string",
    );
    if (schemaOk) schemaValid += 1;
    const shapeOk = Boolean(
      ctx && typeof ctx === "object" && typeof ctx.messageHash === "string"
        && HMAC_HEX_64.test(ctx.messageHash) && typeof ctx.message !== "string"
        && typeof ctx.messagePreview !== "string",
    );
    if (!shapeOk) safeShapeViolations += 1;
  }
  const rowCount = bundles.length;
  const schemaValidPct = rowCount === 0 ? 0 : schemaValid / rowCount;
  return {
    source: "inline-fallback",
    rowCount,
    schemaValidCount: schemaValid,
    schemaValidPct,
    safeShapeViolationCount: safeShapeViolations,
    meetsMinRows: rowCount >= thresholds.minRows,
    meetsSchemaValidity: rowCount > 0 && schemaValidPct >= thresholds.minSchemaValidPct,
    meetsSafeShape: safeShapeViolations <= thresholds.maxSafeShapeViolations,
    recallAt8: "requires_labeled_corpus",
    gateMet: false,
  };
}

let readiness;
try {
  const mod = require(path.join(rootDir, "dist", "services", "chat-core-v2", "shadow-gate-readiness.js"));
  const r = mod.evaluateChatCoreV2ShadowGateReadiness(db);
  readiness = { source: "dist", ...r };
} catch (err) {
  readiness = inlineReadiness();
}

console.log("── Shadow-gate readiness (" + readiness.source + ") ──");
console.log("  rowCount             : " + readiness.rowCount);
console.log("  schemaValidCount     : " + readiness.schemaValidCount);
console.log("  schemaValidPct       : " + (readiness.schemaValidPct * 100).toFixed(1) + "%");
console.log("  safeShapeViolations  : " + readiness.safeShapeViolationCount);
console.log("  meetsMinRows (>=50)  : " + readiness.meetsMinRows);
console.log("  meetsSchemaValidity  : " + readiness.meetsSchemaValidity);
console.log("  meetsSafeShape       : " + readiness.meetsSafeShape);
console.log("  recallAt8            : " + readiness.recallAt8);
console.log("  gateMet              : " + readiness.gateMet + "  (honest: false until recall@8 on a labeled corpus)");
console.log("");

if (readiness.gateMet !== false) {
  console.error("❌ gateMet must be false (recall@8 over a labeled corpus is required). Refusing to claim the gate.");
  process.exit(1);
}

const structuralReady =
  readiness.meetsMinRows && readiness.meetsSchemaValidity && readiness.meetsSafeShape;
if (structuralReady) {
  console.log("✅ Structural thresholds met (rows/schema/shape). Gate still BLOCKED on recall@8 — expected + honest.");
} else {
  console.log("ℹ️  Structural thresholds NOT yet met — generate more shadow traffic (need >=50 clean rows).");
}
db.close();
'
echo ""
echo "═══════════════════════════════════════════════"
echo "  Readback complete."
echo "═══════════════════════════════════════════════"

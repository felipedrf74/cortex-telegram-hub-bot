#!/usr/bin/env bash
# chat-eval-local.sh — run the chat evaluation suite in local_engine mode
# against the local Docker sandbox and persist the run for the promote gate.
#
# Flow:
#   1. Boot the sandbox via scripts/local-up.sh (idempotent).
#   2. Seed local ChatV2 evidence via scripts/chatv2-seed-local-evidence.ts.
#   3. Mint a local dev session via scripts/local-ios-debug-auth.mjs — the
#      same loopback-only path the Cockpit "Mint nexushubbot iOS auth"
#      button uses. The access token is exported into an env var and never
#      appears in argv or logs.
#   4. Replay the suite through the real /api/v1/chat/message pipeline via
#      scripts/run-chat-eval-live.ts --mode local_engine, persisting into
#      the history DB that scripts/promote-exact-release.sh gates on.
#
# Usage:
#   ./scripts/chat-eval-local.sh              # run; sandbox stays up (default)
#   ./scripts/chat-eval-local.sh --teardown   # run, then scripts/local-down.sh
#   ./scripts/chat-eval-local.sh --dry-run    # print the plan and exit 0
#
# Kill switch: NEXUS_CHAT_EVAL_LOCAL_DISABLED=1 refuses to run.
# Ports come from .env.local (NEXUS_LOCAL_PORT_TS), matching local-smoke.sh —
# never hardcode them here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
TEARDOWN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --teardown) TEARDOWN=1; shift ;;
    -h|--help)
      echo "Usage: ./scripts/chat-eval-local.sh [--dry-run] [--teardown]"
      echo "  --dry-run    print the execution plan without touching Docker; exit 0"
      echo "  --teardown   run scripts/local-down.sh after the eval (default: leave sandbox up)"
      exit 0
      ;;
    *) echo "chat-eval-local: unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ "${NEXUS_CHAT_EVAL_LOCAL_DISABLED:-0}" = "1" ]; then
  echo "chat-eval-local: NEXUS_CHAT_EVAL_LOCAL_DISABLED=1 — kill switch engaged; refusing to run" >&2
  exit 1
fi

# Same .env.local sourcing convention as local-smoke.sh: sandbox ports and
# DATABASE_PATH come from there when present.
if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  set -a; source .env.local; set +a
fi

# Re-check the kill switch AFTER sourcing .env.local so the switch works from
# either placement: exported in the ambient environment (checked above) or set
# in .env.local (only visible once sourced).
if [ "${NEXUS_CHAT_EVAL_LOCAL_DISABLED:-0}" = "1" ]; then
  echo "chat-eval-local: NEXUS_CHAT_EVAL_LOCAL_DISABLED=1 (.env.local) — kill switch engaged; refusing to run" >&2
  exit 1
fi

# The local_engine promotion proof is zero-cloud by contract. These switches
# select docker-compose.chat-eval-local.yml and force every live Node routing
# surface through the host Ollama daemon with no fallback. The overlay also
# blanks any .env.local cloud-provider keys. Deliberately overwrite ambient/
# .env.local values after sourcing it: this script has no paid-provider mode.
export NEXUS_LOCAL_ALLOW_MODEL_CALLS=1
export NEXUS_MODEL_FIXTURE_MODE=0
export NEXUS_CHAT_EVAL_ZERO_CLOUD_PROFILE=1

NEXUS_PORT="${NEXUS_LOCAL_PORT_TS:-8200}"
BASE_URL="http://127.0.0.1:${NEXUS_PORT}"
AUTH_TOKEN_ENV="${NEXUS_CHAT_EVAL_AUTH_TOKEN_ENV:-CHAT_EVAL_AUTH_TOKEN}"
OUT_DIR="${CHAT_EVAL_OUT_DIR:-reports/chat-eval}"
HISTORY_DB="${CHAT_EVAL_DB_PATH:-reports/chat-eval/chat-eval-history.sqlite}"
AUTH_FILE="${NEXUS_CHAT_EVAL_AUTH_FILE:-$ROOT/.local/chat-eval/local-auth.json}"
SEED_ROWS="${NEXUS_CHAT_EVAL_SEED_ROWS:-64}"

# Resolve the host-side sandbox DB path the same way local-ios-debug-auth.mjs
# does: the container path /app/data/* maps to ./data/* on the host.
CONTAINER_DB="${DATABASE_PATH:-/app/data/local.db}"
case "$CONTAINER_DB" in
  /app/data/*) HOST_DB="$ROOT/data/${CONTAINER_DB#/app/data/}" ;;
  *) HOST_DB="$CONTAINER_DB" ;;
esac

if [ "$DRY_RUN" = "1" ]; then
  if [ "$TEARDOWN" = "1" ]; then TEARDOWN_PLAN="./scripts/local-down.sh"; else TEARDOWN_PLAN="none (sandbox stays up)"; fi
  echo "chat-eval-local plan (dry run — nothing executed):"
  echo "  base URL:     $BASE_URL"
  echo "  sandbox DB:   $HOST_DB"
  echo "  history DB:   $HISTORY_DB"
  echo "  reports dir:  $OUT_DIR"
  echo "  token env:    $AUTH_TOKEN_ENV (value never printed)"
  echo "  provider:     Ollama-only zero-cloud profile (NEXUS_LOCAL_ALLOW_MODEL_CALLS=1, NEXUS_MODEL_FIXTURE_MODE=0)"
  echo "  1. ./scripts/local-up.sh"
  echo "  2. attest Ollama-only zero-cloud runtime profile in both Docker services"
  echo "  3. npx tsx scripts/chatv2-seed-local-evidence.ts --write --replace --rows=$SEED_ROWS --db <sandbox DB>"
  echo "  4. node scripts/local-ios-debug-auth.mjs   # mint local dev session -> $AUTH_FILE"
  echo "  5. npx tsx scripts/run-chat-eval-live.ts --mode local_engine --base-url $BASE_URL --auth-token-env $AUTH_TOKEN_ENV --out-dir $OUT_DIR --persist-db <history DB>"
  echo "  6. teardown: $TEARDOWN_PLAN"
  exit 0
fi

require_clean_evidence_checkout() {
  if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]; then
    echo "chat-eval-local: release evidence requires a git worktree" >&2
    return 1
  fi
  if git rev-parse --verify --quiet MERGE_HEAD >/dev/null 2>&1; then
    echo "chat-eval-local: release evidence refuses an in-progress merge" >&2
    return 1
  fi
  local checkout_status
  checkout_status="$(git status --porcelain=v1 --untracked-files=all 2>/dev/null)" || {
    echo "chat-eval-local: unable to inspect checkout status" >&2
    return 1
  }
  if [ -n "$checkout_status" ]; then
    echo "chat-eval-local: release evidence requires a clean checkout with no staged, unstaged, or untracked files" >&2
    return 1
  fi
  local checkout_sha
  checkout_sha="$(git rev-parse HEAD 2>/dev/null)" || {
    echo "chat-eval-local: unable to resolve checkout SHA" >&2
    return 1
  }
  [[ "$checkout_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "chat-eval-local: release evidence requires a full 40-character git SHA" >&2
    return 1
  }
}

attest_zero_cloud_profile() {
  local compose_args=(-f docker-compose.local.yml -f docker-compose.chat-eval-local.yml)
  docker compose "${compose_args[@]}" exec -T content-engine sh -eu -c '
    [ "${NEXUS_LOCAL_ALLOW_MODEL_CALLS:-}" = "1" ]
    [ "${CONTENT_ENGINE_FIXTURE_MODE:-}" != "1" ]
    [ "${CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED:-}" = "1" ]
    [ -z "${ANTHROPIC_API_KEY:-}" ]
    [ -z "${GEMINI_API_KEY:-}" ]
    [ -z "${GOOGLE_API_KEY:-}" ]
    [ -z "${OPENAI_API_KEY:-}" ]
    [ -z "${SERPAPI_API_KEY:-}" ]
    [ -z "${YOUTUBE_API_KEY:-}" ]
    [ -z "${NEWSAPI_API_KEY:-}" ]
  ' || {
    echo "chat-eval-local: content-engine did not attest the live zero-cloud profile; refusing evidence" >&2
    return 1
  }
  docker compose "${compose_args[@]}" exec -T nexus-hub sh -eu -c '
    [ "${NEXUS_LOCAL_ALLOW_MODEL_CALLS:-}" = "1" ]
    [ "${NEXUS_MODEL_FIXTURE_MODE:-}" != "1" ]
    [ "${OLLAMA_ENABLED:-}" = "true" ]
    [ "${AI_CLASSIFY_PRIMARY:-}" = "ollama" ]
    [ "${AI_CLASSIFY_FALLBACK:-}" = "none" ]
    [ "${AI_CHAT_PRIMARY:-}" = "ollama" ]
    [ "${AI_CHAT_FALLBACK:-}" = "none" ]
    [ "${AI_TOOL_USE_PRIMARY:-}" = "ollama" ]
    [ "${AI_TOOL_USE_FALLBACK:-}" = "none" ]
    [ "${ANTHROPIC_ENABLED:-}" != "true" ]
    [ -z "${ANTHROPIC_API_KEY:-}" ]
    [ -z "${GEMINI_API_KEY:-}" ]
    [ -z "${GOOGLE_API_KEY:-}" ]
    [ -z "${OPENAI_API_KEY:-}" ]
  ' || {
    echo "chat-eval-local: nexus-hub did not attest the Ollama-only zero-cloud profile; refusing evidence" >&2
    return 1
  }
  docker compose "${compose_args[@]}" exec -T nexus-hub sh -eu -c '
    curl -fsS "${OLLAMA_BASE_URL%/}/api/tags" >/dev/null
  ' || {
    echo "chat-eval-local: nexus-hub cannot reach its configured Ollama daemon; refusing evidence" >&2
    return 1
  }
  echo "chat-eval-local: Ollama-only zero-cloud runtime profile attested in content-engine and nexus-hub"
}

require_clean_evidence_checkout

echo "chat-eval-local: [1/5] booting Ollama-only zero-cloud local sandbox (idempotent)"
./scripts/local-up.sh || {
  echo "chat-eval-local: sandbox boot failed (scripts/local-up.sh). Is Docker running and .env.local present?" >&2
  exit 1
}

echo "chat-eval-local: [2/5] attesting Ollama-only zero-cloud runtime profile"
attest_zero_cloud_profile

echo "chat-eval-local: [3/5] seeding local ChatV2 evidence ($SEED_ROWS rows)"
npx tsx scripts/chatv2-seed-local-evidence.ts --write --replace --rows="$SEED_ROWS" --db "$HOST_DB" || {
  echo "chat-eval-local: evidence seeding failed (scripts/chatv2-seed-local-evidence.ts against $HOST_DB)" >&2
  exit 1
}

echo "chat-eval-local: [4/5] minting local dev session"
NEXUS_LOCAL_BASE_URL="$BASE_URL" \
NEXUS_LOCAL_DB_PATH="$HOST_DB" \
NEXUS_LOCAL_AUTH_IMPORT_PATH="$AUTH_FILE" \
  node scripts/local-ios-debug-auth.mjs || {
  echo "chat-eval-local: local dev auth mint failed (scripts/local-ios-debug-auth.mjs against $BASE_URL)" >&2
  exit 1
}

ACCESS_TOKEN="$(node -e '
  const auth = require(process.argv[1]);
  if (!auth || typeof auth.accessToken !== "string" || !auth.accessToken) process.exit(1);
  process.stdout.write(auth.accessToken);
' "$AUTH_FILE")" || {
  echo "chat-eval-local: could not read accessToken from $AUTH_FILE" >&2
  exit 1
}
export "$AUTH_TOKEN_ENV=$ACCESS_TOKEN"
unset ACCESS_TOKEN

echo "chat-eval-local: [5/5] running local_engine chat evaluation against $BASE_URL"
set +e
npx tsx scripts/run-chat-eval-live.ts \
  --mode local_engine \
  --base-url "$BASE_URL" \
  --auth-token-env "$AUTH_TOKEN_ENV" \
  --out-dir "$OUT_DIR" \
  --persist-db "$HISTORY_DB"
EVAL_STATUS=$?
set -e

if [ "$TEARDOWN" = "1" ]; then
  echo "chat-eval-local: tearing down sandbox (--teardown)"
  ./scripts/local-down.sh || echo "chat-eval-local: WARN: sandbox teardown failed; run scripts/local-down.sh manually" >&2
fi

if [ "$EVAL_STATUS" -ne 0 ]; then
  echo "chat-eval-local: FAIL — local_engine eval did not pass (exit $EVAL_STATUS). The promote gate will refuse until a passing run is recorded in $HISTORY_DB" >&2
else
  echo "chat-eval-local: PASS — local_engine run recorded in $HISTORY_DB"
fi
exit "$EVAL_STATUS"

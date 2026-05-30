#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# local-shadow-traffic.sh — generate LOCAL shadow-recording traffic.
#
# Wave-1 Rank 3 (chat-core-v2 production-activation). This is the operator's
# evidence-generation step for the Phase-2 shadow gate: it registers a JWT
# test user against the LOCAL backend, then POSTs 50+ VARIED natural-language
# turns (read + non-write phrasings, multiple locales) to
# /api/v1/chat/message so the default-OFF shadow route hook can record
# redacted, HMAC-only plan/route metadata into chat_v2_replay_bundles /
# chat_v2_trace_spans.
#
# It NEVER writes user data destructively: every phrasing is a read/lookup or
# a benign question. Shadow recording itself is observe-only (wouldExecute
# is always false) and only runs when CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED
# is set on the server — this script just produces the inbound traffic.
#
# SAFETY: this script REFUSES to run unless the target host is local
# (127.0.0.1 / localhost / ::1). It must never be pointed at staging or prod.
#
# After traffic is generated, read it back + check the gate with the sibling
# script: scripts/local-shadow-readback.sh
#
# Usage:
#   ./scripts/local-shadow-traffic.sh
#   ./scripts/local-shadow-traffic.sh --base-url http://127.0.0.1:8200 --count 60
#   IOS_INVITE_CODE=LOCAL-BETA-2026 ./scripts/local-shadow-traffic.sh
#
# Options:
#   --base-url URL    Local base URL (default: http://127.0.0.1:8200)
#   --count N         Number of turns to send (default: 55; min enforced: 50)
#   --invite CODE     Invite code for /auth/register (default: $IOS_INVITE_CODE
#                     or LOCAL-BETA-2026)
#   --device-id ID    Device id for registration (default: a random local id)
#   --help            Show this help
# ─────────────────────────────────────────────────────
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8200}"
COUNT="${COUNT:-55}"
INVITE_CODE="${INVITE_CODE:-${IOS_INVITE_CODE:-LOCAL-BETA-2026}}"
DEVICE_ID="${DEVICE_ID:-}"
USER_AGENT="${USER_AGENT:-NexusHubiOS/1 CFNetwork Darwin}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/local-shadow-traffic.sh [--base-url URL] [--count N] [--invite CODE] [--device-id ID]

Generates 50+ varied, read-only natural-language chat turns against a LOCAL
backend so the chat-core-v2 shadow route hook can record redacted, HMAC-only
evidence. Refuses any non-local target host.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --invite) INVITE_CODE="$2"; shift 2 ;;
    --device-id) DEVICE_ID="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

# ── Local-only guard ────────────────────────────────────────────────
# Extract the host from the base URL and refuse anything that is not a
# loopback address. This is the hard safety boundary: shadow traffic must
# NEVER be generated against staging or production.
HOST="$(printf '%s' "$BASE_URL" | sed -E 's#^[a-zA-Z]+://##; s#[:/].*$##')"
case "$HOST" in
  127.0.0.1|localhost|::1|0.0.0.0)
    : # allowed loopback targets
    ;;
  *)
    echo "❌ REFUSING to run: target host '$HOST' (from $BASE_URL) is not local." >&2
    echo "   This script only generates traffic against 127.0.0.1 / localhost / ::1." >&2
    echo "   Never point shadow-traffic generation at staging or production." >&2
    exit 2
    ;;
esac

if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  echo "❌ --count must be an integer (got: $COUNT)" >&2
  exit 1
fi
if [[ "$COUNT" -lt 50 ]]; then
  echo "ℹ️  Bumping --count from $COUNT to the Phase-2 minimum of 50." >&2
  COUNT=50
fi

if [[ -z "$DEVICE_ID" ]]; then
  DEVICE_ID="local-shadow-traffic-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi

echo "═══════════════════════════════════════════════"
echo "  🛰  Local shadow-traffic generator"
echo "═══════════════════════════════════════════════"
echo "Base URL : $BASE_URL"
echo "Turns    : $COUNT"
echo "Device   : $DEVICE_ID"
echo ""

# ── Register a JWT test user ────────────────────────────────────────
REGISTER_BODY="$(
  curl -sS \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -H "User-Agent: $USER_AGENT" \
    -d "{\"deviceId\":\"$DEVICE_ID\",\"deviceName\":\"local-shadow-traffic\",\"inviteCode\":\"$INVITE_CODE\"}" \
    "$BASE_URL/api/v1/auth/register" || true
)"

TOKEN="$(printf '%s' "$REGISTER_BODY" | node -e '
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  try {
    const json = JSON.parse(raw);
    // sendSuccess wraps the payload as { ok: true, data: { accessToken, ... } }.
    const token = json?.data?.accessToken || json?.accessToken;
    if (typeof token === "string" && token.trim()) {
      process.stdout.write(token.trim());
    }
  } catch {}
});
')"

if [[ -z "$TOKEN" ]]; then
  echo "❌ Failed to obtain an access token from /api/v1/auth/register." >&2
  echo "   Response (first 300 chars): $(printf '%s' "$REGISTER_BODY" | head -c 300)" >&2
  echo "   Is the local backend running on $BASE_URL with a valid IOS_INVITE_CODE?" >&2
  exit 1
fi

echo "✅ Registered local test user; got access token."
echo ""

# ── Varied, read-only / non-write natural-language turns ────────────
# Mix of English / Portuguese / Spanish / French; all are lookups or benign
# questions (NO destructive writes). The locale is conveyed via X-Language so
# the shadow path observes multi-locale traffic.
declare -a PHRASES=(
  "en|What is my next training session today?"
  "en|Show me my tasks for this week"
  "en|How much did I spend on groceries last month?"
  "en|List my upcoming calendar events"
  "en|How is my readiness score trending?"
  "en|What's on my plan for tomorrow morning?"
  "en|Summarize my running mileage this week"
  "en|Do I have any meetings this afternoon?"
  "en|What did I eat yesterday?"
  "en|Show my finance summary for this month"
  "pt-BR|Qual é o meu treino de hoje?"
  "pt-BR|Quais são as minhas tarefas para amanhã?"
  "pt-BR|Quanto gastei em supermercado este mês?"
  "pt-BR|Como está a minha prontidão para treinar?"
  "pt-BR|Resume da minha semana de corrida"
  "pt-BR|Tenho alguma reunião hoje à tarde?"
  "es-ES|¿Cuál es mi plan de comidas para hoy?"
  "es-ES|Muéstrame mis tareas pendientes"
  "es-ES|¿Cuánto he gastado este mes?"
  "es-ES|¿Cuál es mi próximo entrenamiento?"
  "fr-FR|Quel est mon prochain entraînement de cyclisme?"
  "fr-FR|Affiche mes événements de calendrier à venir"
)

SENT=0
FAILED=0

for ((i = 0; i < COUNT; i++)); do
  entry="${PHRASES[$((i % ${#PHRASES[@]}))]}"
  lang="${entry%%|*}"
  text="${entry#*|} (#$i)"
  client_msg_id="local-shadow-$DEVICE_ID-$i"

  status="$(
    curl -sS \
      -o /dev/null \
      -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      -H "X-Language: $lang" \
      -H "User-Agent: $USER_AGENT" \
      -d "$(node -e '
        const [text, clientMessageId] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({ text, clientMessageId }));
      ' "$text" "$client_msg_id")" \
      "$BASE_URL/api/v1/chat/message" || true
  )"

  if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    SENT=$((SENT + 1))
  else
    FAILED=$((FAILED + 1))
    echo "  ⚠️  turn #$i ($lang) -> HTTP $status"
  fi
done

echo ""
echo "═══════════════════════════════════════════════"
echo "  📤 Sent OK : $SENT"
echo "  ⚠️  Failed  : $FAILED"
echo "  📊 Total   : $COUNT turns to $BASE_URL/api/v1/chat/message"
echo "═══════════════════════════════════════════════"
echo ""
echo "Next: ./scripts/local-shadow-readback.sh   (read back + check the gate)"

if [[ "$SENT" -lt 50 ]]; then
  echo "❌ Fewer than 50 turns landed; shadow corpus may be below the Phase-2 floor." >&2
  exit 1
fi
exit 0

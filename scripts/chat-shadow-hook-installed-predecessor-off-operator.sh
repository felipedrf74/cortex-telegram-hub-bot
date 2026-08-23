#!/usr/bin/env bash
# One-time protected-main wrapper for the exact installed predecessor recorder OFF.
set -euo pipefail
umask 077

readonly SERVER="${DEPLOY_SERVER:?DEPLOY_SERVER must be set (SSH host for the release server)}"
readonly BASE_DIR='$HOME/telegram-hub-bot-staging'
readonly RUNTIME_SHA='39965e357d19a1a44ecb167d213c6ffcf361a21b'
readonly ARTIFACT_DIGEST='e368f1e15c3b2a84cfb798ad12621932a61fd766db6161259a7bd364cbac1535'
readonly PLAN_SCHEMA='nexus.chat-shadow-route-hook-plan.v1'
readonly RECEIPT_SCHEMA='nexus.chat-shadow-route-hook-transaction.v1'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/scripts/lib/chat-capability-flag-transaction.mjs"
COMMAND="${1:-}"
ACK_PLAN=''
shift $(( $# > 0 ? 1 : 0 ))

die() {
  printf 'installed predecessor shadow-hook OFF operator: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ack-plan) ACK_PLAN="${2:?--ack-plan requires a value}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$COMMAND" in inspect|apply) ;; *) die 'command must be inspect or apply' ;; esac
if [ "$COMMAND" = apply ]; then
  [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
    || die 'apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
  [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'apply requires exact --ack-plan'
else
  [ -z "$ACK_PLAN" ] || die 'inspect does not accept --ack-plan'
fi

git -C "$ROOT" fetch --quiet --no-tags origin main
[ -z "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=normal)" ] \
  || die 'operator requires a clean protected-main checkout'
LOCAL_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
REMOTE_MAIN="$(git -C "$ROOT" rev-parse origin/main)"
[ "$LOCAL_HEAD" = "$REMOTE_MAIN" ] \
  || die 'operator requires the exact protected origin/main checkout'
[ -f "$HELPER" ] && [ ! -L "$HELPER" ] || die 'local receipt validator is unavailable'

LOCAL_ROOT="$ROOT/.local/release/chat-shadow-hook-installed-predecessor-off/$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"
PLAN_ROOT="$LOCAL_ROOT/plans"
RECEIPT_ROOT="$LOCAL_ROOT/receipts"
install -d -m 700 "$ROOT/.local" "$ROOT/.local/release" \
  "$ROOT/.local/release/chat-shadow-hook-installed-predecessor-off" \
  "$LOCAL_ROOT" "$PLAN_ROOT" "$RECEIPT_ROOT"

verify_installed_predecessor() {
  ssh "$SERVER" /bin/bash -s -- "$BASE_DIR" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'REMOTE'
set -euo pipefail
base="$1"
sha="$2"
digest="$3"
release="$base/releases/$sha-${digest:0:12}"
[ "$(readlink -f "$base/current")" = "$release" ]
[ -d "$release" ] && [ ! -L "$release" ]
[ -x "$release/scripts/remote-chat-capability-flag-transaction.sh" ]
/usr/bin/node "$release/scripts/release-artifact-manifest.mjs" \
  --verify-installed-source "$release" \
  --expected-runtime-sha "$sha" \
  --expected-digest "$digest" \
  --require-declared-file scripts/remote-chat-capability-flag-transaction.sh >/dev/null
REMOTE
}

validate_plan() {
  local file="$1"
  node --input-type=module - "$HELPER" "$file" "$RUNTIME_SHA" \
    "$ARTIFACT_DIGEST" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,file,runtimeSha,artifactDigest] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const stat = fs.lstatSync(file);
const plan = helper.validateShadowRouteHookPlan(JSON.parse(fs.readFileSync(file, 'utf8')));
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || plan.schema !== 'nexus.chat-shadow-route-hook-plan.v1'
    || plan.role !== 'staging' || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest || plan.desiredValue !== false
    || plan.action !== 'disable' || plan.transitionReason !== 'operator_rollback') process.exit(1);
process.stdout.write(plan.planDigest.slice(7));
NODE
}

verify_installed_predecessor \
  || die 'installed staging predecessor source or identity verification failed'
REMOTE_SCRIPT="$BASE_DIR/current/scripts/remote-chat-capability-flag-transaction.sh"

if [ "$COMMAND" = inspect ]; then
  TEMP_PLAN="$(mktemp "$PLAN_ROOT/.inspect.XXXXXX")"
  trap 'rm -f -- "${TEMP_PLAN:-}"' EXIT
  ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" inspect-shadow-hook staging "$BASE_DIR" \
    "$RUNTIME_SHA" "$ARTIFACT_DIGEST" false operator_rollback < /dev/null > "$TEMP_PLAN"
  PLAN_DIGEST="$(validate_plan "$TEMP_PLAN")" \
    || die 'installed operator returned an invalid recorder-OFF plan'
  install -m 600 "$TEMP_PLAN" "$PLAN_ROOT/$PLAN_DIGEST.json.next-$$"
  mv "$PLAN_ROOT/$PLAN_DIGEST.json.next-$$" "$PLAN_ROOT/$PLAN_DIGEST.json"
  cat "$TEMP_PLAN"
  exit 0
fi

LOCAL_PLAN="$PLAN_ROOT/${ACK_PLAN#sha256:}.json"
[ -f "$LOCAL_PLAN" ] && [ ! -L "$LOCAL_PLAN" ] \
  || die 'apply requires the locally retained exact inspected recorder-OFF plan'
[ "$(validate_plan "$LOCAL_PLAN")" = "${ACK_PLAN#sha256:}" ] \
  || die 'local recorder-OFF plan is invalid or changed'
TRANSACTION_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 6)"
UNIT="nexus-chat-shadow-hook-${RUNTIME_SHA:0:12}-${TRANSACTION_ID##*-}"
ssh "$SERVER" systemd-run --user --quiet --collect --remain-after-exit \
  --unit "$UNIT" \
  --property Type=oneshot \
  --property TimeoutStartSec=4min \
  --setenv=NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  /bin/bash "$REMOTE_SCRIPT" apply-shadow-hook staging "$BASE_DIR" \
  "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$ACK_PLAN"

REMOTE_RECEIPT="\$HOME/.local/state/nexus-release/chat-capability-flags/claims/staging-$TRANSACTION_ID.shadow-hook-receipt.json"
TEMP_RECEIPT="$(mktemp "$RECEIPT_ROOT/.apply.XXXXXX")"
trap 'rm -f -- "${TEMP_RECEIPT:-}"' EXIT
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
  UNIT_STATE="$(ssh "$SERVER" systemctl --user show "$UNIT" \
    --property ActiveState --property SubState --property Result \
    --property ExecMainStatus 2>/dev/null)" \
    || die 'cannot inspect detached recorder-OFF transaction'
  ACTIVE_STATE="$(printf '%s\n' "$UNIT_STATE" | sed -n 's/^ActiveState=//p')"
  SUB_STATE="$(printf '%s\n' "$UNIT_STATE" | sed -n 's/^SubState=//p')"
  RESULT="$(printf '%s\n' "$UNIT_STATE" | sed -n 's/^Result=//p')"
  EXEC_STATUS="$(printf '%s\n' "$UNIT_STATE" | sed -n 's/^ExecMainStatus=//p')"
  if { [ "$ACTIVE_STATE" = active ] && [ "$SUB_STATE" = exited ]; } \
      || [ "$ACTIVE_STATE" = failed ]; then
    ssh "$SERVER" test -f "$REMOTE_RECEIPT" \
      || die 'detached recorder-OFF transaction ended without a receipt'
    ssh "$SERVER" cat "$REMOTE_RECEIPT" > "$TEMP_RECEIPT"
    node --input-type=module - "$HELPER" "$TEMP_RECEIPT" "$RUNTIME_SHA" \
      "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$ACK_PLAN" <<'NODE' \
      || die 'detached recorder-OFF transaction returned an invalid receipt'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,file,runtimeSha,artifactDigest,transactionId,planDigest]
  = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const stat = fs.lstatSync(file);
const receipt = helper.validateShadowRouteHookReceipt(JSON.parse(fs.readFileSync(file, 'utf8')));
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || receipt.schema !== 'nexus.chat-shadow-route-hook-transaction.v1'
    || receipt.status !== 'passed' || receipt.action !== 'disable'
    || receipt.role !== 'staging' || receipt.runtimeSha !== runtimeSha
    || receipt.artifactDigest !== artifactDigest || receipt.transactionId !== transactionId
    || receipt.planDigest !== planDigest || receipt.desiredValue !== false) process.exit(1);
NODE
    if [ "$ACTIVE_STATE" != active ] || [ "$SUB_STATE" != exited ] \
        || [ "$RESULT" != success ] || [ "$EXEC_STATUS" != 0 ]; then
      printf '%s\n' "$UNIT_STATE" >&2
      die 'detached recorder-OFF transaction did not pass'
    fi
    install -m 600 "$TEMP_RECEIPT" "$RECEIPT_ROOT/$TRANSACTION_ID.json.next-$$"
    mv "$RECEIPT_ROOT/$TRANSACTION_ID.json.next-$$" \
      "$RECEIPT_ROOT/$TRANSACTION_ID.json"
    ssh "$SERVER" systemctl --user stop "$UNIT" >/dev/null
    cat "$TEMP_RECEIPT"
    exit 0
  fi
  sleep 2
done
die 'detached recorder-OFF transaction did not finish within five minutes'

#!/usr/bin/env bash
# Exact-artifact operator for one governed chat capability flag transaction.
set -euo pipefail
umask 077

readonly PLAN_SCHEMA='nexus.chat-capability-flag-plan.v1'
readonly EVIDENCE_SCHEMA='nexus.chat-capability-flag-evidence.v1'
readonly RECEIPT_SCHEMA='nexus.chat-capability-flag-transaction.v1'
readonly SECRET_PLAN_SCHEMA='nexus.chat-capability-secret-plan.v1'
readonly SECRET_RECEIPT_SCHEMA='nexus.chat-capability-secret-transaction.v1'
readonly OBSERVATION_PLAN_SCHEMA='nexus.chat-capability-observation-plan.v1'
readonly OBSERVATION_RECEIPT_SCHEMA='nexus.chat-capability-observation-receipt.v1'
readonly SHADOW_HOOK_PLAN_SCHEMA='nexus.chat-shadow-route-hook-plan.v1'
readonly SHADOW_HOOK_RECEIPT_SCHEMA='nexus.chat-shadow-route-hook-transaction.v1'
readonly SERVER='ServerDominguez'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="${1:---help}"
[ $# -eq 0 ] || shift

ROLE=''
RUNTIME_SHA=''
ARTIFACT_DIGEST=''
FLAG=''
DESIRED_VALUE=''
TRANSITION_REASON=''
SINCE=''
UNTIL=''
ACK_PLAN=''

usage() {
  cat <<'USAGE'
Usage:
  scripts/chat-capability-flag-operator.sh inspect \
    --role <staging|production> --runtime-sha <40-hex> \
    --artifact-digest <64-hex> --flag <governed-flag> \
    --value <true|false> --transition-reason <reason> \
    [--since <canonical-UTC>] [--until <canonical-UTC>]

  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  scripts/chat-capability-flag-operator.sh apply \
    --role <staging|production> --runtime-sha <40-hex> \
    --artifact-digest <64-hex> --ack-plan sha256:<64-hex>

  scripts/chat-capability-flag-operator.sh inspect-secrets \
    --role <staging|production> --runtime-sha <40-hex> \
    --artifact-digest <64-hex>

  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  scripts/chat-capability-flag-operator.sh apply-secrets \
    --role <staging|production> --runtime-sha <40-hex> \
    --artifact-digest <64-hex> --ack-plan sha256:<64-hex>

  scripts/chat-capability-flag-operator.sh inspect-observation \
    --role staging --runtime-sha <40-hex> --artifact-digest <64-hex> \
    --flag <governed-capability-flag>

  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  scripts/chat-capability-flag-operator.sh apply-observation \
    --role staging --runtime-sha <40-hex> --artifact-digest <64-hex> \
    --flag <governed-capability-flag> --ack-plan sha256:<64-hex>

  scripts/chat-capability-flag-operator.sh inspect-shadow-hook \
    --role staging --runtime-sha <40-hex> --artifact-digest <64-hex> \
    --value <true|false> --transition-reason <reason>

  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  scripts/chat-capability-flag-operator.sh apply-shadow-hook \
    --role staging --runtime-sha <40-hex> --artifact-digest <64-hex> \
    --ack-plan sha256:<64-hex>

Inspect creates one exact-release-bound pending plan. Apply accepts only that
plan digest, consumes it once, runs detached through systemd-run --user
--collect, and polls the strict durable receipt. Secret values are generated
only inside the server transaction and are never accepted as arguments.
Observation inspection binds the exact mature staging enable and zero-spend
canonical smoke contract. Observation apply consumes that exact plan once in a
detached transaction and publishes immutable raw smoke plus a strict receipt.
Shadow-hook inspection targets only the configured dedicated synthetic evaluation
identity and proves both HMACs present, every capability and planner flag OFF,
and exact staging isolation before offering an owner-bound plan.
For a staging enable of one of the four manifest-routing surfaces, --since and
--until are both required and bind the server-collected divergence window.
USAGE
}

die() {
  printf 'chat capability flag operator: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:?--role requires a value}"; shift 2 ;;
    --runtime-sha) RUNTIME_SHA="${2:?--runtime-sha requires a value}"; shift 2 ;;
    --artifact-digest) ARTIFACT_DIGEST="${2:?--artifact-digest requires a value}"; shift 2 ;;
    --flag) FLAG="${2:?--flag requires a value}"; shift 2 ;;
    --value) DESIRED_VALUE="${2:?--value requires a value}"; shift 2 ;;
    --transition-reason) TRANSITION_REASON="${2:?--transition-reason requires a value}"; shift 2 ;;
    --since) SINCE="${2:?--since requires a timestamp}"; shift 2 ;;
    --until) UNTIL="${2:?--until requires a timestamp}"; shift 2 ;;
    --ack-plan) ACK_PLAN="${2:?--ack-plan requires a digest}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$COMMAND" in
  inspect|apply|inspect-secrets|apply-secrets|inspect-observation|apply-observation|inspect-shadow-hook|apply-shadow-hook) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 64 ;;
esac

case "$ROLE" in
  staging) BASE_DIR='/home/dominguez/telegram-hub-bot-staging' ;;
  production) BASE_DIR='/home/dominguez/telegram-hub-bot' ;;
  *) die '--role must be staging or production' ;;
esac
[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]] || die '--runtime-sha must be full lowercase 40-hex'
[[ "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || die '--artifact-digest must be full lowercase 64-hex'
if [ "$COMMAND" = inspect-observation ] || [ "$COMMAND" = apply-observation ] \
    || [ "$COMMAND" = inspect-shadow-hook ] || [ "$COMMAND" = apply-shadow-hook ]; then
  [ "$ROLE" = staging ] || die 'capability observation and shadow route hook are staging-only'
fi

ROUTING_FLAG=false
case "$FLAG" in
  AI_ROUTING_MANIFEST_CLASSIFIER|AI_ROUTING_MANIFEST_ORCHESTRATOR|AI_ROUTING_MANIFEST_SHADOW|AI_ROUTING_MANIFEST_REGISTRY)
    ROUTING_FLAG=true
    ;;
esac
if [ "$COMMAND" = inspect ] && [ "$ROLE" = staging ] \
    && [ "$DESIRED_VALUE" = true ] && [ "$ROUTING_FLAG" = true ]; then
  [ -n "$SINCE" ] && [ -n "$UNTIL" ] \
    || die 'staging routing enable inspect requires both --since and --until'
  node - "$SINCE" "$UNTIL" <<'NODE' \
    || die '--since and --until must be one ordered immutable canonical UTC window'
const [since, until] = process.argv.slice(2);
const canonical = (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
if (!canonical(since) || !canonical(until) || Date.parse(until) < Date.parse(since)) {
  process.exit(1);
}
NODE
elif [ -n "$SINCE" ] || [ -n "$UNTIL" ]; then
  die '--since and --until are accepted only for a staging manifest-routing enable inspect'
fi

RELEASE_NAME="$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"
REMOTE_SCRIPT="$BASE_DIR/releases/$RELEASE_NAME/scripts/remote-chat-capability-flag-transaction.sh"
LOCAL_STATE_ROOT="$ROOT/.local/release/chat-capability-flags/$RUNTIME_SHA-${ARTIFACT_DIGEST:0:12}"
PLAN_ROOT="$LOCAL_STATE_ROOT/plans"
RECEIPT_ROOT="$LOCAL_STATE_ROOT/receipts"
install -d -m 700 "$ROOT/.local" "$ROOT/.local/release" \
  "$ROOT/.local/release/chat-capability-flags" "$LOCAL_STATE_ROOT" \
  "$PLAN_ROOT" "$RECEIPT_ROOT"

require_exact_checkout() {
  [ -z "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=normal)" ] \
    || die 'operator requires a clean exact protected-main checkout'
  [ "$(git -C "$ROOT" rev-parse HEAD)" = "$RUNTIME_SHA" ] \
    || die 'checkout does not match --runtime-sha'
}

require_current_protected_main() {
  git -C "$ROOT" fetch --quiet --no-tags origin main
  git -C "$ROOT" merge-base --is-ancestor "$RUNTIME_SHA" origin/main \
    || die 'runtime is not contained in protected origin/main history'
}

save_json() {
  local source="$1"
  local destination="$2"
  local temporary="$destination.next-$$"
  [ ! -e "$temporary" ] && [ ! -L "$temporary" ] || die 'local receipt temporary path exists'
  install -m 600 "$source" "$temporary"
  mv -f "$temporary" "$destination"
}

transaction_id() {
  printf '%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" \
    "$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
}

validate_and_save_plan() {
  local source="$1"
  local expected_schema="$2"
  local digest
  digest="$(node - "$source" "$expected_schema" "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" <<'NODE'
const fs = require('node:fs');
const [file, schema, role, runtimeSha, artifactDigest] = process.argv.slice(2);
const stat = fs.lstatSync(file);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!stat.isFile() || stat.isSymbolicLink()
    || value?.schema !== schema || value.role !== role
    || value.runtimeSha !== runtimeSha || value.artifactDigest !== artifactDigest
    || !/^sha256:[0-9a-f]{64}$/u.test(value.planDigest ?? '')) process.exit(1);
process.stdout.write(value.planDigest.slice(7));
NODE
  )" || die 'remote inspect returned an invalid plan'
  save_json "$source" "$PLAN_ROOT/$digest.json"
}

poll_receipt() {
  local transaction_id="$1"
  local unit="$2"
  local expected_schema="$3"
  local remote_state="/home/dominguez/.local/state/nexus-release/chat-capability-flags/$ROLE.json"
  local next="$RECEIPT_ROOT/$transaction_id.json.next"
  local final="$RECEIPT_ROOT/$transaction_id.json"
  local deadline=$((SECONDS + 300))
  local validation_status

  while [ "$SECONDS" -lt "$deadline" ]; do
    local unit_state active_state='' sub_state='' result='' exec_status=''
    unit_state="$(ssh "$SERVER" systemctl --user show "$unit" \
      --property LoadState --property ActiveState --property SubState \
      --property Result --property ExecMainStatus 2>/dev/null)" \
      || die 'cannot inspect detached flag unit'
    while IFS='=' read -r key value; do
      case "$key" in
        ActiveState) active_state="$value" ;;
        SubState) sub_state="$value" ;;
        Result) result="$value" ;;
        ExecMainStatus) exec_status="$value" ;;
      esac
    done <<< "$unit_state"

    if { [ "$active_state" = active ] && [ "$sub_state" = exited ]; } \
        || [ "$active_state" = failed ]; then
      if ! ssh "$SERVER" test -f "$remote_state"; then
        printf '%s\n' "$unit_state" >&2
        die 'detached flag unit reached terminal state without a receipt'
      fi
      ssh "$SERVER" cat "$remote_state" > "$next"
      set +e
      node --input-type=module - "$ROOT/scripts/lib/chat-capability-flag-transaction.mjs" \
        "$next" "$expected_schema" "$ROLE" "$RUNTIME_SHA" \
        "$ARTIFACT_DIGEST" "$transaction_id" "$ACK_PLAN" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,file,schema,role,sha,digest,id,ack] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const stat = fs.lstatSync(file);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const knownSchemas = new Set([
  'nexus.chat-capability-flag-transaction.v1',
  'nexus.chat-capability-secret-transaction.v1',
  'nexus.chat-shadow-route-hook-transaction.v1',
  'nexus.chat-capability-flag-attempt.v1',
  'nexus.chat-capability-secret-attempt.v1',
  'nexus.chat-shadow-route-hook-attempt.v1',
]);
if (!stat.isFile() || stat.isSymbolicLink() || !knownSchemas.has(value?.schema)
    || !['staging', 'production'].includes(value.role)
    || !/^[0-9a-f]{40}$/u.test(value.runtimeSha ?? '')
    || !/^[0-9a-f]{64}$/u.test(value.artifactDigest ?? '')
    || !/^\d{8}T\d{6}Z-[0-9a-f]{12}$/u.test(value.transactionId ?? '')
    || !/^sha256:[0-9a-f]{64}$/u.test(value.planDigest ?? '')) process.exit(1);
const attemptSchema = schema === 'nexus.chat-capability-flag-transaction.v1'
  ? 'nexus.chat-capability-flag-attempt.v1'
  : schema === 'nexus.chat-capability-secret-transaction.v1'
    ? 'nexus.chat-capability-secret-attempt.v1'
    : 'nexus.chat-shadow-route-hook-attempt.v1';
const exactAttempt = value.schema === attemptSchema && value.role === role
  && value.runtimeSha === sha && value.artifactDigest === digest
  && value.transactionId === id && value.planDigest === ack;
if (exactAttempt) process.exit(2);
if (value.schema !== schema || value.role !== role || value.runtimeSha !== sha
    || value.artifactDigest !== digest || value.transactionId !== id
    || value.planDigest !== ack) process.exit(3);
try {
  if (schema === 'nexus.chat-capability-flag-transaction.v1') {
    helper.validateCapabilityFlagReceipt(value);
  } else if (schema === 'nexus.chat-capability-secret-transaction.v1') {
    helper.validateCapabilitySecretReceipt(value);
  } else {
    helper.validateShadowRouteHookReceipt(value);
  }
} catch {
  process.exit(1);
}
if (value.status === 'passed') process.exit(0);
if (['failed', 'rolled_back', 'rollback_failed'].includes(value.status)) process.exit(2);
process.exit(3);
NODE
      validation_status=$?
      set -e
      if [ "$active_state" = active ] && [ "$sub_state" = exited ] \
          && [ "$result" = success ] && [ "$exec_status" = 0 ]; then
        if [ "$validation_status" -eq 0 ]; then
          mv "$next" "$final"
          chmod 600 "$final"
          ssh "$SERVER" systemctl --user stop "$unit" >/dev/null
          cat "$final"
          return 0
        fi
        rm -f "$next"
        printf '%s\n' "$unit_state" >&2
        die 'successful detached unit did not produce its exact passed receipt'
      fi
      if [ "$validation_status" -eq 2 ]; then
          mv "$next" "$final"
          chmod 600 "$final"
          cat "$final" >&2
      else
        rm -f "$next"
      fi
      printf '%s\n' "$unit_state" >&2
      ssh "$SERVER" systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
      return 1
    fi
    sleep 2
  done
  die 'remote flag transaction did not finish within five minutes'
}

poll_observation_receipt() {
  local transaction_id="$1"
  local unit="$2"
  local remote_state="/home/dominguez/.local/state/nexus-release/chat-capability-flags/observations/staging-$transaction_id.observation-receipt.json"
  local next="$RECEIPT_ROOT/observation-$transaction_id.json.next"
  local final="$RECEIPT_ROOT/observation-$transaction_id.json"
  local deadline=$((SECONDS + 900))
  [ ! -e "$next" ] && [ ! -L "$next" ] || die 'local observation receipt temporary path exists'

  while [ "$SECONDS" -lt "$deadline" ]; do
    local unit_state active_state='' sub_state='' result='' exec_status=''
    unit_state="$(ssh "$SERVER" systemctl --user show "$unit" \
      --property LoadState --property ActiveState --property SubState \
      --property Result --property ExecMainStatus 2>/dev/null)" \
      || die 'cannot inspect detached observation unit'
    while IFS='=' read -r key value; do
      case "$key" in
        ActiveState) active_state="$value" ;;
        SubState) sub_state="$value" ;;
        Result) result="$value" ;;
        ExecMainStatus) exec_status="$value" ;;
      esac
    done <<< "$unit_state"

    if { [ "$active_state" = active ] && [ "$sub_state" = exited ]; } \
        || [ "$active_state" = failed ]; then
      if ! ssh "$SERVER" test -f "$remote_state"; then
        printf '%s\n' "$unit_state" >&2
        die 'detached observation unit reached terminal state without a receipt'
      fi
      ssh "$SERVER" cat "$remote_state" > "$next"
      if node --input-type=module - \
          "$ROOT/scripts/lib/chat-capability-flag-transaction.mjs" "$next" \
          "$ROLE" "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$FLAG" \
          "$transaction_id" "$ACK_PLAN" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,file,role,runtimeSha,artifactDigest,flag,transactionId,planDigest]
  = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const stat = fs.lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) process.exit(1);
const receipt = helper.validateCapabilityObservationReceipt(
  JSON.parse(fs.readFileSync(file, 'utf8')),
);
if (receipt.schema !== 'nexus.chat-capability-observation-receipt.v1'
    || receipt.status !== 'passed' || receipt.role !== role
    || receipt.runtimeSha !== runtimeSha || receipt.artifactDigest !== artifactDigest
    || receipt.flag !== flag || receipt.transactionId !== transactionId
    || receipt.planDigest !== planDigest) process.exit(1);
NODE
      then
        if [ "$active_state" = active ] && [ "$sub_state" = exited ] \
            && [ "$result" = success ] && [ "$exec_status" = 0 ]; then
          mv "$next" "$final"
          chmod 600 "$final"
          ssh "$SERVER" systemctl --user stop "$unit" >/dev/null
          cat "$final"
          return 0
        fi
      fi
      rm -f -- "$next"
      printf '%s\n' "$unit_state" >&2
      ssh "$SERVER" systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
      return 1
    fi
    sleep 2
  done
  die 'remote observation transaction did not finish within fifteen minutes'
}

require_exact_checkout

case "$COMMAND" in
  inspect)
    if [ "$DESIRED_VALUE" = true ] && [ "$FLAG" != AI_ROUTING_MANIFEST_KILL ]; then
      require_current_protected_main
    fi
    ;;
  inspect-secrets|apply-secrets|inspect-observation|apply-observation|inspect-shadow-hook|apply-shadow-hook)
    require_current_protected_main
    ;;
  apply)
    LOCAL_ACK_PLAN="$PLAN_ROOT/${ACK_PLAN#sha256:}.json"
    [ -f "$LOCAL_ACK_PLAN" ] && [ ! -L "$LOCAL_ACK_PLAN" ] \
      || die 'apply requires the locally retained exact inspected plan'
    if node - "$LOCAL_ACK_PLAN" <<'NODE'
const fs = require('node:fs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.exit(plan.desiredValue === false || plan.flag === 'AI_ROUTING_MANIFEST_KILL' ? 0 : 1);
NODE
    then
      :
    else
      require_current_protected_main
    fi
    ;;
esac

case "$COMMAND" in
  inspect)
    [ -n "$FLAG" ] || die 'inspect requires --flag'
    case "$FLAG" in
      AI_ROUTING_MANIFEST_CLASSIFIER|AI_ROUTING_MANIFEST_ORCHESTRATOR|AI_ROUTING_MANIFEST_SHADOW|AI_ROUTING_MANIFEST_REGISTRY|AI_ROUTING_CLARIFY|AI_CLASSIFY_MANIFEST_PROMPT|AI_CROSS_SKILL_EXECUTION|AI_ROUTING_MANIFEST_KILL) ;;
      *) die 'inspect flag is outside the governed allowlist' ;;
    esac
    case "$DESIRED_VALUE" in true|false) ;; *) die 'inspect requires --value true or false' ;; esac
    [ -n "$TRANSITION_REASON" ] || die 'inspect requires --transition-reason'
    case "$TRANSITION_REASON" in
      gate_pass|operator_rollback|quality_regression|health_regression|emergency_kill) ;;
      *) die 'inspect transition reason is outside the governed allowlist' ;;
    esac
    PLAN_TEMP="$(mktemp "$PLAN_ROOT/.inspect.XXXXXX")"
    trap 'rm -f -- "${PLAN_TEMP:-}"' EXIT
    if [ "$ROLE" = staging ] && [ "$DESIRED_VALUE" = true ] \
        && [ "$ROUTING_FLAG" = true ]; then
      ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" inspect "$ROLE" "$BASE_DIR" \
        "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$FLAG" "$DESIRED_VALUE" \
        "$TRANSITION_REASON" "$SINCE" "$UNTIL" < /dev/null > "$PLAN_TEMP"
    else
      ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" inspect "$ROLE" "$BASE_DIR" \
        "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$FLAG" "$DESIRED_VALUE" \
        "$TRANSITION_REASON" < /dev/null > "$PLAN_TEMP"
    fi
    validate_and_save_plan "$PLAN_TEMP" "$PLAN_SCHEMA"
    cat "$PLAN_TEMP"
    ;;

  inspect-secrets)
    PLAN_TEMP="$(mktemp "$PLAN_ROOT/.inspect-secrets.XXXXXX")"
    trap 'rm -f -- "${PLAN_TEMP:-}"' EXIT
    ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" inspect-secrets "$ROLE" "$BASE_DIR" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" > "$PLAN_TEMP"
    validate_and_save_plan "$PLAN_TEMP" "$SECRET_PLAN_SCHEMA"
    cat "$PLAN_TEMP"
    ;;

  inspect-shadow-hook)
    case "$DESIRED_VALUE" in true|false) ;; *) die 'inspect-shadow-hook requires --value true or false' ;; esac
    case "$TRANSITION_REASON" in
      dedicated_eval_evidence_collection|operator_rollback|quality_regression|health_regression) ;;
      *) die 'inspect-shadow-hook transition reason is outside the governed allowlist' ;;
    esac
    [ -z "$FLAG$ACK_PLAN$SINCE$UNTIL" ] \
      || die 'inspect-shadow-hook accepts only exact release identity, value, and reason'
    PLAN_TEMP="$(mktemp "$PLAN_ROOT/.inspect-shadow-hook.XXXXXX")"
    trap 'rm -f -- "${PLAN_TEMP:-}"' EXIT
    ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" inspect-shadow-hook staging "$BASE_DIR" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$DESIRED_VALUE" \
      "$TRANSITION_REASON" < /dev/null > "$PLAN_TEMP"
    validate_and_save_plan "$PLAN_TEMP" "$SHADOW_HOOK_PLAN_SCHEMA"
    cat "$PLAN_TEMP"
    ;;

  apply-shadow-hook)
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
      || die 'apply-shadow-hook requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
    [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] \
      || die 'apply-shadow-hook requires exact --ack-plan'
    [ -z "$FLAG$DESIRED_VALUE$TRANSITION_REASON$SINCE$UNTIL" ] \
      || die 'apply-shadow-hook accepts only exact release identity and plan digest'
    LOCAL_ACK_PLAN="$PLAN_ROOT/${ACK_PLAN#sha256:}.json"
    [ -f "$LOCAL_ACK_PLAN" ] && [ ! -L "$LOCAL_ACK_PLAN" ] \
      || die 'apply-shadow-hook requires the locally retained exact inspected plan'
    node --input-type=module - \
      "$ROOT/scripts/lib/chat-capability-flag-transaction.mjs" "$LOCAL_ACK_PLAN" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$ACK_PLAN" <<'NODE' \
      || die 'local shadow-hook plan does not match the requested apply'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,file,runtimeSha,artifactDigest,planDigest] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const stat = fs.lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) process.exit(1);
const plan = helper.validateShadowRouteHookPlan(JSON.parse(fs.readFileSync(file, 'utf8')));
if (plan.role !== 'staging' || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest || plan.planDigest !== planDigest) process.exit(1);
NODE
    TRANSACTION_ID="$(transaction_id)"
    UNIT="nexus-chat-shadow-hook-${RUNTIME_SHA:0:12}-${TRANSACTION_ID##*-}"
    ssh "$SERVER" systemd-run --user --quiet --collect --remain-after-exit \
      --unit "$UNIT" \
      --property Type=oneshot \
      --property TimeoutStartSec=4min \
      --setenv=NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
      /bin/bash "$REMOTE_SCRIPT" apply-shadow-hook staging "$BASE_DIR" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$ACK_PLAN"
    poll_receipt "$TRANSACTION_ID" "$UNIT" "$SHADOW_HOOK_RECEIPT_SCHEMA"
    ;;

  inspect-observation)
    [ -n "$FLAG" ] || die 'inspect-observation requires --flag'
    case "$FLAG" in
      AI_ROUTING_MANIFEST_CLASSIFIER|AI_ROUTING_MANIFEST_ORCHESTRATOR|AI_ROUTING_MANIFEST_SHADOW|AI_ROUTING_MANIFEST_REGISTRY|AI_ROUTING_CLARIFY|AI_CLASSIFY_MANIFEST_PROMPT|AI_CROSS_SKILL_EXECUTION) ;;
      *) die 'observation flag is outside the governed capability allowlist' ;;
    esac
    [ -z "$ACK_PLAN" ] || die 'inspect-observation does not accept --ack-plan'
    [ -z "$DESIRED_VALUE$TRANSITION_REASON$SINCE$UNTIL" ] \
      || die 'inspect-observation accepts only exact release identity and flag'
    PLAN_TEMP="$(mktemp "$PLAN_ROOT/.inspect-observation.XXXXXX")"
    trap 'rm -f -- "${PLAN_TEMP:-}"' EXIT
    ssh "$SERVER" /bin/bash "$REMOTE_SCRIPT" inspect-observation staging "$BASE_DIR" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$FLAG" < /dev/null > "$PLAN_TEMP"
    validate_and_save_plan "$PLAN_TEMP" "$OBSERVATION_PLAN_SCHEMA"
    cat "$PLAN_TEMP"
    ;;

  apply-observation)
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
      || die 'apply-observation requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
    [ -n "$FLAG" ] || die 'apply-observation requires --flag'
    [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] \
      || die 'apply-observation requires exact --ack-plan'
    [ -z "$DESIRED_VALUE$TRANSITION_REASON$SINCE$UNTIL" ] \
      || die 'apply-observation accepts only exact release identity, flag, and plan digest'
    LOCAL_ACK_PLAN="$PLAN_ROOT/${ACK_PLAN#sha256:}.json"
    [ -f "$LOCAL_ACK_PLAN" ] && [ ! -L "$LOCAL_ACK_PLAN" ] \
      || die 'apply-observation requires the locally retained exact inspected plan'
    node --input-type=module - \
      "$ROOT/scripts/lib/chat-capability-flag-transaction.mjs" "$LOCAL_ACK_PLAN" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$FLAG" "$ACK_PLAN" <<'NODE' \
      || die 'local observation plan does not match the requested apply'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath,file,runtimeSha,artifactDigest,flag,planDigest] = process.argv.slice(2);
const helper = await import(pathToFileURL(helperPath).href);
const stat = fs.lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) process.exit(1);
const plan = helper.validateCapabilityObservationPlan(JSON.parse(fs.readFileSync(file, 'utf8')));
if (plan.role !== 'staging' || plan.runtimeSha !== runtimeSha
    || plan.artifactDigest !== artifactDigest || plan.flag !== flag
    || plan.planDigest !== planDigest) process.exit(1);
NODE
    TRANSACTION_ID="$(transaction_id)"
    UNIT="nexus-chat-capability-observation-${RUNTIME_SHA:0:12}-${TRANSACTION_ID##*-}"
    ssh "$SERVER" systemd-run --user --quiet --collect --remain-after-exit \
      --unit "$UNIT" \
      --property Type=oneshot \
      --property TimeoutStartSec=12min \
      --setenv=NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
      /bin/bash "$REMOTE_SCRIPT" apply-observation staging "$BASE_DIR" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$FLAG" "$TRANSACTION_ID" "$ACK_PLAN"
    poll_observation_receipt "$TRANSACTION_ID" "$UNIT"
    ;;

  apply|apply-secrets)
    [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-0}" = 1 ] \
      || die 'apply requires NEXUS_RELEASE_OWNER_AUTHORIZED=1'
    [[ "$ACK_PLAN" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'apply requires exact --ack-plan'
    TRANSACTION_ID="$(transaction_id)"
    UNIT="nexus-chat-capability-$ROLE-${RUNTIME_SHA:0:12}-${TRANSACTION_ID##*-}"
    ssh "$SERVER" systemd-run --user --quiet --collect --remain-after-exit \
      --unit "$UNIT" \
      --property Type=oneshot \
      --property TimeoutStartSec=4min \
      --setenv=NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
      /bin/bash "$REMOTE_SCRIPT" "$COMMAND" "$ROLE" "$BASE_DIR" \
      "$RUNTIME_SHA" "$ARTIFACT_DIGEST" "$TRANSACTION_ID" "$ACK_PLAN"
    if [ "$COMMAND" = apply ]; then
      poll_receipt "$TRANSACTION_ID" "$UNIT" "$RECEIPT_SCHEMA"
    else
      poll_receipt "$TRANSACTION_ID" "$UNIT" "$SECRET_RECEIPT_SCHEMA"
    fi
    ;;
esac

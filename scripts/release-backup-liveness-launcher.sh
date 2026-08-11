#!/bin/bash -p
set -euo pipefail

if [[ "$#" -ne 1 || ( "$1" != '--weekly' && "$1" != '--failure-only' \
  && "$1" != '--failure-only-force' ) ]]; then
  exit 64
fi
readonly requested_mode="$1"

readonly captured_telegram_bot_token="${NEXUS_RELEASE_TELEGRAM_BOT_TOKEN-}"
readonly captured_telegram_chat_id="${NEXUS_RELEASE_TELEGRAM_CHAT_ID-}"

inherited_environment_names=()
while IFS= read -r inherited_name; do
  inherited_environment_names+=("$inherited_name")
done < <(compgen -e || true)
for inherited_name in "${inherited_environment_names[@]}"; do
  unset "$inherited_name" || exit 70
done
unset inherited_environment_names inherited_name

residual_environment_names="$(compgen -e || true)"
if [[ -n "$residual_environment_names" ]]; then
  exit 70
fi
unset residual_environment_names

export PATH=/usr/bin:/bin
export HOME=/var/lib/nexus-release/home

readonly lock_runner=/opt/nexus-release/checkout/scripts/release-bound-lock-runner.py

if [[ "$requested_mode" == '--weekly' ]]; then
  NEXUS_RELEASE_TELEGRAM_BOT_TOKEN="$captured_telegram_bot_token" \
  NEXUS_RELEASE_TELEGRAM_CHAT_ID="$captured_telegram_chat_id" \
    exec /usr/bin/python3 "$lock_runner" --weekly
fi

prepare_mode=--alert-prepare
if [[ "$requested_mode" == '--failure-only-force' ]]; then
  prepare_mode=--alert-force-prepare
fi
readonly prepare_mode

set +e
NEXUS_RELEASE_TELEGRAM_BOT_TOKEN="$captured_telegram_bot_token" \
NEXUS_RELEASE_TELEGRAM_CHAT_ID="$captured_telegram_chat_id" \
NEXUS_RELEASE_BACKUP_ALERT_LOCK_HELD=1 \
  /usr/bin/python3 "$lock_runner" "$prepare_mode"
prepare_status="$?"
set -e
case "$prepare_status" in
  0) exit 0 ;;
  10) ;;
  *) exit "$prepare_status" ;;
esac

set +e
/usr/bin/python3 "$lock_runner" --failure-only-inspect
inspection_status="$?"
set -e
case "$inspection_status" in
  74)
    if [[ "$requested_mode" == '--failure-only-force' ]]; then
      exit 74
    fi
    exit 0
    ;;
  20) verdict=healthy ;;
  21) verdict=backup_policy_invalid ;;
  22) verdict=backup_evidence_invalid ;;
  23) verdict=backup_receipt_stale ;;
  24) verdict=restore_verification_stale ;;
  *) verdict=backup_evidence_invalid ;;
esac
readonly verdict

NEXUS_RELEASE_TELEGRAM_BOT_TOKEN="$captured_telegram_bot_token" \
NEXUS_RELEASE_TELEGRAM_CHAT_ID="$captured_telegram_chat_id" \
NEXUS_RELEASE_BACKUP_ALERT_LOCK_HELD=1 \
  exec /usr/bin/python3 "$lock_runner" "--alert-commit=$verdict"

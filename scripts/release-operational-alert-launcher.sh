#!/bin/bash -p
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  exit 64
fi

case "$1" in
  --unit=nexus-local-backup.service|--unit=nexus-local-backup-restore-verify.service)
    readonly alert_unit_argument="$1"
    ;;
  *)
    exit 64
    ;;
esac

# Capture only the native systemd verdict and the dedicated notification pair.
# These locals are deliberately not exported while the inherited environment is
# erased, so no credential is ever materialized in argv.
readonly captured_service_result="${SERVICE_RESULT-}"
readonly captured_exit_code="${EXIT_CODE-}"
readonly captured_exit_status="${EXIT_STATUS-}"
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
export HOME=/var/lib/nexus-release
export SERVICE_RESULT="$captured_service_result"
export EXIT_CODE="$captured_exit_code"
export EXIT_STATUS="$captured_exit_status"
export NEXUS_RELEASE_TELEGRAM_BOT_TOKEN="$captured_telegram_bot_token"
export NEXUS_RELEASE_TELEGRAM_CHAT_ID="$captured_telegram_chat_id"
export NEXUS_RELEASE_BACKUP_ALERT_LOCK_HELD=1

readonly alert_unit="${alert_unit_argument#--unit=}"
exec /usr/bin/python3 \
  /opt/nexus-release/checkout/scripts/release-bound-lock-runner.py \
  "--operational=$alert_unit"

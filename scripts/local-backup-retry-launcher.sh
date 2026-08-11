#!/bin/bash -p
set -euo pipefail
umask 077

readonly producer=/usr/local/libexec/nexus-local-backup/local-backup.py
readonly timeout_bin=/usr/bin/timeout
readonly sleep_bin=/usr/bin/sleep

case "${1-}" in
  backup)
    readonly operation=backup
    readonly work_timeout=18m
    ;;
  restore-verify)
    readonly operation=restore-verify
    readonly work_timeout=36m
    ;;
  *)
    exit 64
    ;;
esac
test "$#" -eq 1 || exit 64

while :; do
  set +e
  "$timeout_bin" --signal=TERM --kill-after=3m \
    "$work_timeout" "$producer" "$operation"
  status=$?
  set -e
  if test "$status" -ne 75; then
    exit "$status"
  fi
  "$sleep_bin" 60
done

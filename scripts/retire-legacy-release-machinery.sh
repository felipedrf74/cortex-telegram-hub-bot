#!/usr/bin/env bash
# Retire only the audited legacy release machinery after the first lean
# production proof. The default is a read-only plan; apply requires the exact
# production SHA/digest and the normal production-owner authorization flag.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

MODE=dry-run
CONFIRMATION=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      MODE=apply
      shift
      ;;
    --confirm)
      [ "$#" -ge 2 ] || {
        echo "retire legacy release machinery: --confirm requires SHA:DIGEST" >&2
        exit 64
      }
      CONFIRMATION="$2"
      shift 2
      ;;
    *)
      echo "usage: sudo scripts/retire-legacy-release-machinery.sh [--apply --confirm <sha>:<digest>]" >&2
      exit 64
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || {
  echo "retire legacy release machinery: root is required" >&2
  exit 77
}
if [ "$MODE" = apply ]; then
  [ "${NEXUS_RELEASE_OWNER_AUTHORIZED:-}" = 1 ] || {
    echo "retire legacy release machinery: NEXUS_RELEASE_OWNER_AUTHORIZED=1 is required" >&2
    exit 77
  }
  [[ "$CONFIRMATION" =~ ^[0-9a-f]{40}:[0-9a-f]{64}$ ]] || {
    echo "retire legacy release machinery: apply requires exact SHA:DIGEST confirmation" >&2
    exit 64
  }
elif [ -n "$CONFIRMATION" ] && [[ ! "$CONFIRMATION" =~ ^[0-9a-f]{40}:[0-9a-f]{64}$ ]]; then
  echo "retire legacy release machinery: confirmation is malformed" >&2
  exit 64
fi

PRODUCTION_BASE=/home/dominguez/telegram-hub-bot
CURRENT_LINK="$PRODUCTION_BASE/current"
STATE_FILE=/home/dominguez/.local/state/nexus-release/production.json
PM2_BIN=/usr/local/bin/pm2
NODE_BIN=/usr/bin/node

LEGACY_DROP_INS=(
  /etc/systemd/system/pm2-dominguez.service.d/00-nexus-release-layout-install-recovery.conf
  /etc/systemd/system/pm2-dominguez.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf
  /etc/systemd/system/pm2-dominguez.service.d/15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf
  /etc/systemd/system/pm2-dominguez.service.d/nexus-release-recovery.conf
  /etc/systemd/system/pm2-root.service.d/10-nexus-rollback-drill-legacy-staging-recovery.conf
  /etc/systemd/system/pm2-root.service.d/15-nexus-rollback-drill-v4-prelayout-staging-recovery.conf
  /etc/systemd/system/pm2-root.service.d/nexus-release-recovery.conf
  /etc/systemd/system/nexus-release-promotion-recovery.service.d/15-nexus-rollback-drill-v4-prelayout-promotion-recovery.conf
  /etc/systemd/system/nexus-cloudflared.service.d/nexus-release-ready.conf
)

LEGACY_DEPENDENCY_LINKS=(
  /etc/systemd/system/pm2-dominguez.service.requires/nexus-rollback-drill-legacy-staging-install-recovery.service
  /etc/systemd/system/pm2-dominguez.service.requires/nexus-rollback-drill-legacy-staging-recovery.service
  /etc/systemd/system/pm2-dominguez.service.requires/nexus-rollback-drill-v4-prelayout-staging-install-recovery.service
  /etc/systemd/system/pm2-dominguez.service.requires/nexus-rollback-drill-v4-prelayout-staging-recovery.service
  /etc/systemd/system/pm2-root.service.requires/nexus-rollback-drill-legacy-staging-install-recovery.service
  /etc/systemd/system/pm2-root.service.requires/nexus-rollback-drill-legacy-staging-recovery.service
  /etc/systemd/system/pm2-root.service.requires/nexus-rollback-drill-v4-prelayout-staging-install-recovery.service
  /etc/systemd/system/pm2-root.service.requires/nexus-rollback-drill-v4-prelayout-staging-recovery.service
)

LEGACY_UNITS=(
  nexus-release-layout-activation@.service
  nexus-release-layout-fault-drill-recovery.service
  nexus-release-layout-fault-drill@.service
  nexus-release-layout-install-recovery.service
  nexus-release-layout-recovery.service
  nexus-release-pm2-recovery-daemon.service
  nexus-release-promotion-recovery.service
  nexus-release-promotion@.service
  nexus-rollback-drill-v4-prelayout-staging-install-recovery.service
  nexus-rollback-drill-v4-prelayout-staging-recovery.service
  nexus-rollback-drill-v4-prelayout-staging@.service
  nexus-rollback-drill-vm@.service
)

LEGACY_HELPERS=(
  /usr/local/sbin/nexus-release-boot-health
  /usr/local/sbin/nexus-release-layout-activation-control
  /usr/local/sbin/nexus-release-layout-activation-install
  /usr/local/sbin/nexus-release-layout-migrate
  /usr/local/sbin/nexus-release-promotion-control
  /usr/local/sbin/nexus-release-promotion-worker-control
  /usr/local/sbin/nexus-rollback-drill-v4-prelayout-staging-broker
  /usr/local/sbin/nexus-rollback-drill-v4-prelayout-staging-install
  /usr/local/libexec/nexus-capture-pm2-dump-authority.mjs
  /usr/local/libexec/nexus-pm2-dump-authority.py
  /usr/local/libexec/nexus-promotion-authorization.mjs
  /usr/local/libexec/nexus-release-layout-authorization.mjs
  /usr/local/libexec/nexus-release-layout-fault-drill.mjs
  /usr/local/libexec/nexus-release-layout-preflight.sh
  /usr/local/libexec/nexus-release-layout-sqlite.py
  /usr/local/libexec/nexus-release-promotion-transaction
  /usr/local/libexec/nexus-release-selector-switch.py
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-installed-tree-attestation.mjs
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-recovery-runtime-identity.mjs
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-runtime-dependencies.mjs
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-staging-adapter.mjs
  /usr/local/libexec/nexus-rollback-drill-v4-prelayout-staging-fs.py
  /usr/local/libexec/nexus-staging-attestation-broker.sh
  /usr/local/libexec/nexus-trusted-release-filesystem-identity.mjs
  /usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs
  /etc/sudoers.d/nexus-release-promotion
  /etc/sudoers.d/nexus-release-layout-activation
  /etc/sudoers.d/nexus-rollback-drill-legacy-staging
  /etc/sudoers.d/nexus-rollback-drill-v4-prelayout-staging
)

LEGACY_STATE=(
  /etc/nexus-release
  /srv/nexus-release
  /var/lib/nexus-release-bootstrap
  /var/lib/nexus-release-promotion
  /var/lib/nexus-rollback-drill-legacy-staging
  /var/lib/nexus-rollback-drill-v4-prelayout-staging
  /var/lib/nexus-rollback-drill-vm
)

die() {
  echo "retire legacy release machinery: $*" >&2
  exit 1
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

assert_allowlisted_path() {
  local candidate="$1"
  local allowed
  for allowed in \
    "${LEGACY_DROP_INS[@]}" \
    "${LEGACY_DEPENDENCY_LINKS[@]}" \
    "${LEGACY_HELPERS[@]}" \
    "${LEGACY_STATE[@]}"; do
    [ "$candidate" != "$allowed" ] || return 0
  done
  for allowed in "${LEGACY_UNITS[@]}"; do
    [ "$candidate" != "/etc/systemd/system/$allowed" ] || return 0
  done
  die "refusing non-allowlisted removal path: $candidate"
}

remove_allowlisted_path() {
  local candidate="$1"
  assert_allowlisted_path "$candidate"
  if [ -L "$candidate" ] || [ -f "$candidate" ]; then
    rm -f -- "$candidate"
  elif [ -d "$candidate" ]; then
    rm -rf -- "$candidate"
  elif [ -e "$candidate" ]; then
    die "allowlisted path has an unsupported file type: $candidate"
  fi
}

validate_production_gate() {
  local current_target identity
  [ -f "$STATE_FILE" ] && [ ! -L "$STATE_FILE" ] || die "lean production transaction state is unavailable"
  [ -L "$CURRENT_LINK" ] || die "production current selector is not a symlink"
  current_target="$(realpath -e -- "$CURRENT_LINK")"
  case "$current_target" in
    "$PRODUCTION_BASE"/releases/*) ;;
    *) die "production current selector escapes the lean release set" ;;
  esac
  [ -f "$current_target/.complete.json" ] && [ ! -L "$current_target/.complete.json" ] \
    || die "current completion marker is unavailable"

  identity="$(
    "$NODE_BIN" - "$STATE_FILE" "$current_target/.complete.json" \
      "$current_target" "$CONFIRMATION" <<'NODE'
const fs=require('node:fs');
const [statePath,markerPath,currentTarget,confirmation]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
const checks={
  artifactParity:'passed',
  migrationStartup:'passed',
  authenticatedSmoke:'passed',
  databaseIntegrity:'passed',
  prePromotionBackup:'passed',
  rollbackReadiness:'passed',
};
const exactChecks=state?.checks
  && JSON.stringify(Object.keys(state.checks).sort())
    ===JSON.stringify(Object.keys(checks).sort())
  && Object.entries(checks).every(([name,status])=>state.checks[name]===status);
const transactionStarted=Date.parse(state?.startedAt??'');
const soakStarted=Date.parse(state?.soakStartedAt??'');
const soakCompleted=Date.parse(state?.soakCompletedAt??'');
const transactionCompleted=Date.parse(state?.completedAt??'');
const updated=Date.parse(state?.updatedAt??'');
if(state?.schema!=='nexus.lean-release-transaction.v1'
  ||state.role!=='production'
  ||state.phase!=='completed'
  ||state.status!=='passed'
  ||state.healthResult!=='passed'
  ||state.rollbackResult!=='not_required'
  ||state.rollbackDurationMs!==null
  ||state.faultInjection!==null
  ||state.candidateRemoved!==false
  ||state.releaseDir!==currentTarget
  ||typeof state.predecessor!=='string'
  ||!state.predecessor.startsWith('/home/dominguez/telegram-hub-bot/releases/')
  ||state.predecessor===currentTarget
  ||!/^[0-9a-f]{40}$/.test(state.runtimeSha??'')
  ||!/^[0-9a-f]{64}$/.test(state.artifactDigest??'')
  ||!Number.isSafeInteger(state.stabilitySeconds)
  ||state.stabilitySeconds<60
  ||state.candidateHealthBudgetSeconds!==45
  ||state.rollbackHealthBudgetSeconds!==45
  ||state.rollbackObjectiveSeconds!==120
  ||![transactionStarted,soakStarted,soakCompleted,transactionCompleted,updated]
    .every(Number.isFinite)
  ||transactionStarted>soakStarted
  ||soakCompleted>transactionCompleted
  ||transactionCompleted>updated
  ||soakCompleted-soakStarted<state.stabilitySeconds*1000
  ||!exactChecks
  ||marker?.schema!=='nexus.release-bundle.v1'
  ||marker.runtimeSha!==state.runtimeSha
  ||marker.artifactDigest!==state.artifactDigest
  ||typeof marker.packageVersion!=='string'
  ||marker.packageVersion.length===0
  ||currentTarget
    !==`/home/dominguez/telegram-hub-bot/releases/${state.runtimeSha}-${state.artifactDigest.slice(0,12)}`
  ||(confirmation&&confirmation!==`${state.runtimeSha}:${state.artifactDigest}`)){
  process.exit(1);
}
process.stdout.write(`${state.runtimeSha}\t${state.artifactDigest}\t${currentTarget}`);
NODE
  )" || die "production transaction/current/completion-marker proof is invalid"
  IFS=$'\t' read -r PRODUCTION_SHA PRODUCTION_DIGEST PRODUCTION_RELEASE <<<"$identity"
}

assert_runtime_health() {
  local snapshot current_target
  systemctl is-active --quiet pm2-dominguez.service \
    || die "pm2-dominguez.service is not active"
  current_target="$(realpath -e -- "$CURRENT_LINK")"
  [ "$current_target" = "$PRODUCTION_RELEASE" ] \
    || die "production current selector changed during retirement"
  curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:8200/health >/dev/null \
    || die "production backend health failed"
  curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:8100/health >/dev/null \
    || die "production content-engine health failed"
  snapshot="$(mktemp)"
  chmod 0600 "$snapshot"
  if ! /usr/bin/timeout --foreground 15s runuser -u dominguez -- env \
      HOME=/home/dominguez \
      USER=dominguez \
      LOGNAME=dominguez \
      PATH=/usr/local/bin:/usr/bin:/bin \
      PM2_HOME=/home/dominguez/.pm2 \
      "$PM2_BIN" jlist >"$snapshot"; then
    rm -f -- "$snapshot"
    die "PM2 process snapshot failed"
  fi
  if ! "$NODE_BIN" - "$snapshot" "$PRODUCTION_RELEASE" "$PRODUCTION_SHA" <<'NODE'
const fs=require('node:fs');
const [snapshotPath,releaseDir,sha]=process.argv.slice(2);
const rows=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
for(const name of ['nexus-hub','content-engine']){
  const row=rows.find((entry)=>entry?.name===name);
  const cwd=row?.pm2_env?.pm_cwd;
  if(row?.pm2_env?.status!=='online'
    ||(row.pm2_env.NEXUS_RELEASE_SHA??row.pm2_env.GIT_COMMIT)!==sha
    ||!(cwd===releaseDir||cwd===`${releaseDir}/content-engine`)){
    process.exit(1);
  }
}
NODE
  then
    rm -f -- "$snapshot"
    die "PM2 does not bind both production processes to the exact lean release"
  fi
  rm -f -- "$snapshot"
  [ "$(realpath -e -- "$CURRENT_LINK")" = "$PRODUCTION_RELEASE" ] \
    || die "production current selector changed during health verification"
}

assert_no_active_legacy_transaction() {
  local unit _load _active _sub _description
  while read -r unit _load _active _sub _description; do
    case "$unit" in
      nexus-release-layout-activation@*.service|\
      nexus-release-layout-fault-drill@*.service|\
      nexus-release-promotion@*.service|\
      nexus-rollback-drill-v4-prelayout-staging@*.service|\
      nexus-rollback-drill-vm@*.service)
        die "legacy transaction is still active: $unit"
        ;;
    esac
  done < <(
    systemctl list-units --type=service \
      --state=activating,active,reloading,deactivating \
      --no-legend --no-pager
  )
}

disable_legacy_unit() {
  local unit="$1"
  local load_state
  load_state="$(systemctl show --property=LoadState --value "$unit" 2>/dev/null || true)"
  if [ -n "$load_state" ] && [ "$load_state" != not-found ]; then
    case "$unit" in
      *@.service)
        # Active instances were rejected above. Never pass a template to
        # `disable --now`, whose instance semantics vary by systemd version.
        systemctl disable "$unit" >/dev/null
        ;;
      *)
        systemctl disable --now "$unit" >/dev/null
        ;;
    esac
  fi
}

validate_production_gate
assert_runtime_health
assert_no_active_legacy_transaction

planned=0
for path in \
  "${LEGACY_DROP_INS[@]}" \
  "${LEGACY_DEPENDENCY_LINKS[@]}" \
  "${LEGACY_HELPERS[@]}" \
  "${LEGACY_STATE[@]}"; do
  if path_exists "$path"; then
    planned=$((planned + 1))
    [ "$MODE" != dry-run ] || printf 'would remove %s\n' "$path"
  fi
done
for unit in "${LEGACY_UNITS[@]}"; do
  load_state="$(systemctl show --property=LoadState --value "$unit" 2>/dev/null || true)"
  if [ -n "$load_state" ] && [ "$load_state" != not-found ]; then
    planned=$((planned + 1))
    [ "$MODE" != dry-run ] || printf 'would disable and remove %s\n' "$unit"
  fi
done

if [ "$MODE" = dry-run ]; then
  printf '{"ok":true,"mode":"dry-run","runtimeSha":"%s","artifactDigest":"%s","planned":%d}\n' \
    "$PRODUCTION_SHA" "$PRODUCTION_DIGEST" "$planned"
  exit 0
fi

# Remove PM2/ingress dependency declarations before stopping their providers.
for path in "${LEGACY_DROP_INS[@]}" "${LEGACY_DEPENDENCY_LINKS[@]}"; do
  remove_allowlisted_path "$path"
done
systemctl daemon-reload
assert_runtime_health

for unit in "${LEGACY_UNITS[@]}"; do
  disable_legacy_unit "$unit"
done
assert_runtime_health

for unit in "${LEGACY_UNITS[@]}"; do
  remove_allowlisted_path "/etc/systemd/system/$unit"
done
for path in "${LEGACY_HELPERS[@]}" "${LEGACY_STATE[@]}"; do
  remove_allowlisted_path "$path"
done

rmdir --ignore-fail-on-non-empty \
  /etc/systemd/system/pm2-dominguez.service.d \
  /etc/systemd/system/pm2-dominguez.service.requires \
  /etc/systemd/system/pm2-root.service.d \
  /etc/systemd/system/pm2-root.service.requires \
  /etc/systemd/system/nexus-release-promotion-recovery.service.d \
  /etc/systemd/system/nexus-cloudflared.service.d 2>/dev/null || true
systemctl daemon-reload
assert_runtime_health

printf '{"ok":true,"mode":"apply","runtimeSha":"%s","artifactDigest":"%s","retired":%d}\n' \
  "$PRODUCTION_SHA" "$PRODUCTION_DIGEST" "$planned"

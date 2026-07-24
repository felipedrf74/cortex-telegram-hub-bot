#!/usr/bin/env bash
# Root broker for the persistent promotion worker. Application operations run
# as dominguez, while authority, recovery intent, terminal status, and escrow
# confirmation remain root-owned and cannot be forged by that account.
set -euo pipefail
umask 077

ACTION="${1:-}"
TRANSACTION_ID="${2:-}"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
AUTH_BIN="${NEXUS_PROMOTION_AUTH_BIN:-/usr/local/libexec/nexus-promotion-authorization.mjs}"
OWNER_PUBLIC_KEY="${NEXUS_PROMOTION_OWNER_PUBLIC_KEY:-/etc/nexus-release/owner-promotion-public-key.pem}"
TRANSACTION_SCRIPT="${NEXUS_PROMOTION_TRANSACTION_SCRIPT:-/usr/local/libexec/nexus-release-promotion-transaction}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
RUNUSER_BIN="${NEXUS_PROMOTION_RUNUSER_BIN:-/usr/sbin/runuser}"
SETPRIV_BIN="${NEXUS_PROMOTION_SETPRIV_BIN:-/usr/bin/setpriv}"
UNSHARE_BIN="${NEXUS_PROMOTION_UNSHARE_BIN:-/usr/bin/unshare}"
BASH_BIN="${NEXUS_PROMOTION_BASH_BIN:-/usr/bin/bash}"
TIMEOUT_BIN="${NEXUS_PROMOTION_TIMEOUT_BIN:-/usr/bin/timeout}"
FLOCK_BIN="${NEXUS_PROMOTION_FLOCK_BIN:-/usr/bin/flock}"
RELEASE_SONAR_LOCK="${NEXUS_PROMOTION_RELEASE_SONAR_LOCK:-/run/lock/nexus-release-sonar.lock}"
DR_BACKUP_BIN="${NEXUS_PROMOTION_DR_BACKUP_BIN:-/usr/local/libexec/nexus-application-dr/application-dr-backup.sh}"
DR_CONFIG="${NEXUS_PROMOTION_DR_CONFIG:-/etc/nexus-application-dr/backup.env}"
TRUSTED_ATTESTOR="${NEXUS_PROMOTION_TRUSTED_ATTESTOR:-/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs}"
RECOVERY_RUNTIME_BIN="${NEXUS_PROMOTION_RECOVERY_RUNTIME_BIN:-/usr/local/libexec/nexus-application-dr/application-dr-recovery-runtime.mjs}"
RECOVERY_IDENTITY_BIN="${NEXUS_PROMOTION_RECOVERY_IDENTITY_BIN:-/usr/local/libexec/nexus-application-dr/release-recovery-runtime-identity.mjs}"
RELEASE_EVIDENCE_PUBLIC_KEY="${NEXUS_PROMOTION_RELEASE_EVIDENCE_PUBLIC_KEY:-/etc/nexus-application-dr/release-evidence-public-key.pem}"
OUTAGE_BUDGET_SECONDS=120
PRE_RECOVERY_BUDGET_SECONDS=60
SYSTEM_NODE_BIN="${NEXUS_PROMOTION_NODE_BIN:-/usr/bin/node}"
PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-/usr/bin/python3}"
SELECTOR_SWITCH="${NEXUS_PROMOTION_SELECTOR_SWITCH:-/usr/local/libexec/nexus-release-selector-switch.py}"
BOOT_HEALTH_BIN="${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-/usr/local/sbin/nexus-release-boot-health}"
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
  PYTHON_BIN="${NEXUS_PROMOTION_PYTHON_BIN:-$(command -v python3)}"
  if [ -z "${NEXUS_PROMOTION_SELECTOR_SWITCH:-}" ]; then
    SELECTOR_SWITCH="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/remote-release-selector-switch.py"
  fi
fi

if [ "$EUID" -ne 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  echo "promotion worker broker must run as root" >&2
  exit 77
fi
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then SYSTEM_NODE_BIN="$(command -v node)"; fi
case "$ACTION" in run|recover) ;; *) echo "Usage: nexus-release-promotion-worker-control <run|recover> <transaction-id>" >&2; exit 64 ;; esac
[[ "$TRANSACTION_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$ ]] || {
  echo "invalid promotion transaction id" >&2
  exit 64
}
[ -x "$FLOCK_BIN" ] || { echo "flock is required by the promotion broker" >&2; exit 1; }
case "$RELEASE_SONAR_LOCK" in
  /run/lock/nexus-release-sonar.lock) ;;
  *) [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ] || { echo "unsafe release/Sonar lock path" >&2; exit 64; } ;;
esac
[ -f "$RELEASE_SONAR_LOCK" ] && [ ! -L "$RELEASE_SONAR_LOCK" ] || {
  echo "precreated shared release/Sonar mutex is unavailable" >&2
  exit 1
}
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  [ "$(stat -c '%U:%G:%a' "$RELEASE_SONAR_LOCK")" = "root:$WORKER_USER:660" ] || {
    echo "shared release/Sonar mutex ownership or mode is unsafe" >&2
    exit 1
  }
fi
# Read/write open requires the existing inode and does not truncate it. The
# tmpfiles.d contract, not either contender, creates this cross-service lock.
exec 8<>"$RELEASE_SONAR_LOCK"
"$FLOCK_BIN" -n 8 || { echo "shared release/Sonar mutex is unavailable" >&2; exit 75; }

REQUEST_ENVELOPE="$STATE_ROOT/requests/$TRANSACTION_ID.envelope.json"
REQUEST="$STATE_ROOT/requests/$TRANSACTION_ID.json"
TRANSACTION_DIR="$STATE_ROOT/transactions/$TRANSACTION_ID"
AUTHORITY="$TRANSACTION_DIR/authority.json"
ACTIVE="$STATE_ROOT/active.json"
WORKER_DIR="$TRANSACTION_DIR/worker"
CONTROL_DIR="$TRANSACTION_DIR/control"
AUTHORITATIVE_DIR="$TRANSACTION_DIR/state"
JOURNAL="$AUTHORITATIVE_DIR/journal.json"
RECOVERY_INTENT="$AUTHORITATIVE_DIR/recovery-armed"
RECOVERY_RESULT="$AUTHORITATIVE_DIR/recovery-result.json"
RECOVERY_ATTEMPT_TIMING="$AUTHORITATIVE_DIR/recovery-attempt-timing.json"
ESCROW_CONFIRMATION="$AUTHORITATIVE_DIR/escrow-confirmation.json"
SEALED_RESULT="$AUTHORITATIVE_DIR/result.env"
CUTOVER_TIMING="$AUTHORITATIVE_DIR/cutover-timing.json"
WORKER_RECOVERY_ARMED="$WORKER_DIR/recovery-armed"
WORKER_BACKUP_ENV="$WORKER_DIR/backup.env"
RESULT_ENV="$WORKER_DIR/result.env"
EVIDENCE_DIR="$TRANSACTION_DIR/evidence"
RELEASE_MANIFEST="$EVIDENCE_DIR/release-manifest.json"
STAGING_ATTESTATION="$EVIDENCE_DIR/staging-attestation.json"
RECOVERY_DESCRIPTOR="$AUTHORITATIVE_DIR/recovery-runtime-descriptor.json"
PREFLIGHT_RECOVERY_CONFIRMATION="$AUTHORITATIVE_DIR/preflight-current-recovery.json"

root_own() {
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then chown root:root "$@"; fi
}

durable_staging_file() {
  local destination="$1" parent temporary identity
  [[ "$destination" == "$STATE_ROOT/"* ]] || {
    echo "unsafe durable promotion state path" >&2
    return 1
  }
  parent="$(dirname -- "$destination")"
  [ -d "$parent" ] && [ ! -L "$parent" ] || {
    echo "durable promotion state parent is unsafe" >&2
    return 1
  }
  temporary="$(mktemp "${destination}.next.XXXXXXXX")"
  [[ "$temporary" == "${destination}.next."* ]] \
    && [ -f "$temporary" ] && [ ! -L "$temporary" ] \
    && [ "$(stat -c '%h' "$temporary")" = 1 ] || {
    echo "durable promotion state staging file is unsafe" >&2
    return 1
  }
  chmod 600 "$temporary"
  root_own "$temporary"
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    identity="$(stat -c '%U:%G' "$temporary")"
    [ "$identity" = root:root ] || {
      rm -f -- "$temporary"
      echo "durable promotion state staging owner is unsafe" >&2
      return 1
    }
  fi
  printf '%s\n' "$temporary"
}

durable_publish() {
  local temporary="$1" destination="$2" identity
  [[ "$destination" == "$STATE_ROOT/"* \
      && "$temporary" == "${destination}.next."* ]] \
    && [ "$(dirname -- "$temporary")" = "$(dirname -- "$destination")" ] \
    && [ -f "$temporary" ] && [ ! -L "$temporary" ] \
    && [ "$(stat -c '%h' "$temporary")" = 1 ] \
    && [ "$(stat -c '%a' "$temporary")" = 600 ] || {
    echo "durable promotion state staging identity is unsafe" >&2
    return 1
  }
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ -f "$destination" ] && [ ! -L "$destination" ] \
      && [ "$(stat -c '%h' "$destination")" = 1 ] || {
      echo "durable promotion state destination is unsafe" >&2
      return 1
    }
  fi
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    identity="$(stat -c '%U:%G' "$temporary")"
    [ "$identity" = root:root ] || {
      echo "durable promotion state staging owner is unsafe" >&2
      return 1
    }
    if [ -e "$destination" ]; then
      identity="$(stat -c '%U:%G' "$destination")"
      [ "$identity" = root:root ] || {
        echo "durable promotion state destination owner is unsafe" >&2
        return 1
      }
    fi
  fi
  if ! "$SYSTEM_NODE_BIN" - "$temporary" "$destination" <<'NODE'
const fs = require('fs');
const path = require('path');
const [temporary, destination] = process.argv.slice(2);
const staged = fs.lstatSync(temporary);
if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1
    || path.dirname(temporary) !== path.dirname(destination)) process.exit(1);
if (fs.existsSync(destination)) {
  const current = fs.lstatSync(destination);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) process.exit(1);
}
let descriptor = fs.openSync(temporary, 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
fs.renameSync(temporary, destination);
descriptor = fs.openSync(path.dirname(destination), 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
  then
    rm -f -- "$temporary"
    echo "durable promotion state publication failed" >&2
    return 1
  fi
}

durable_remove() {
  local destination="$1" identity
  [ -e "$destination" ] || [ -L "$destination" ] || return 0
  [[ "$destination" == "$STATE_ROOT/"* ]] \
    && [ -f "$destination" ] && [ ! -L "$destination" ] \
    && [ "$(stat -c '%h' "$destination")" = 1 ] \
    && [ "$(stat -c '%a' "$destination")" = 600 ] || {
    echo "durable promotion state removal target is unsafe" >&2
    return 1
  }
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    identity="$(stat -c '%U:%G' "$destination")"
    [ "$identity" = root:root ] || {
      echo "durable promotion state removal owner is unsafe" >&2
      return 1
    }
  fi
  "$SYSTEM_NODE_BIN" - "$destination" <<'NODE'
const fs = require('fs');
const path = require('path');
const destination = process.argv[2];
const current = fs.lstatSync(destination);
if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) process.exit(1);
fs.unlinkSync(destination);
const descriptor = fs.openSync(path.dirname(destination), 'r');
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE
}

fsync_directory() {
  local directory="$1"
  [ -d "$directory" ] && [ ! -L "$directory" ] || {
    echo "promotion directory durability target is unsafe" >&2
    return 1
  }
  "$SYSTEM_NODE_BIN" - "$directory" <<'NODE'
const fs=require('fs');const directory=process.argv[2];
const stat=fs.lstatSync(directory);
if(!stat.isDirectory()||stat.isSymbolicLink())process.exit(1);
const descriptor=fs.openSync(directory,'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

for required in "$REQUEST_ENVELOPE" "$REQUEST" "$AUTHORITY" "$ACTIVE" "$TRANSACTION_SCRIPT" "$AUTH_BIN" "$OWNER_PUBLIC_KEY"; do
  [ -f "$required" ] && [ ! -L "$required" ] || { echo "promotion worker authority is incomplete" >&2; exit 1; }
done
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  [ -f "$TRUSTED_ATTESTOR" ] && [ ! -L "$TRUSTED_ATTESTOR" ] || {
    echo "root-installed trusted release attestor is unavailable" >&2
    exit 1
  }
fi
[ -d "$WORKER_DIR" ] && [ -d "$CONTROL_DIR" ] && [ -d "$AUTHORITATIVE_DIR" ] || {
  echo "promotion worker state is incomplete" >&2
  exit 1
}
chmod 700 "$AUTHORITATIVE_DIR"
root_own "$AUTHORITATIVE_DIR"

verification="$("$AUTH_BIN" verify-request --input "$REQUEST_ENVELOPE" --public-key "$OWNER_PUBLIC_KEY" --allow-expired)" || {
  echo "promotion worker rejected invalid owner authority" >&2
  exit 77
}
IFS=$'\t' read -r verified_id request_sha envelope_sha < <(printf '%s' "$verification" | node -e '
  let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{
    const x=JSON.parse(b);process.stdout.write(`${x.transactionId}\t${x.payloadSha256}\t${x.envelopeSha256}\n`);
  });')
[ "$verified_id" = "$TRANSACTION_ID" ] || { echo "promotion worker transaction authority mismatch" >&2; exit 77; }
node - "$ACTIVE" "$AUTHORITY" "$REQUEST_ENVELOPE" "$REQUEST" \
  "$TRANSACTION_ID" "$request_sha" "$envelope_sha" <<'NODE'
const crypto=require('crypto');const fs = require('fs');
const [activePath, authorityPath, envelopePath,requestPath,
 transactionId, requestSha256, envelopeSha256] = process.argv.slice(2);
const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
for (const value of [active, authority]) {
  if (value.transactionId !== transactionId || value.requestSha256 !== requestSha256
      || value.envelopeSha256 !== envelopeSha256) process.exit(1);
}
const envelope=JSON.parse(fs.readFileSync(envelopePath,'utf8'));
const request=JSON.parse(fs.readFileSync(requestPath,'utf8'));
const canonical=(input)=>{
 if(input===null||typeof input!=='object')return JSON.stringify(input);
 if(Array.isArray(input))return `[${input.map(canonical).join(',')}]`;
 return `{${Object.keys(input).sort().map((key)=>`${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
};
const requestCanonical=canonical(request);
if(canonical(envelope?.payload)!==requestCanonical
 ||crypto.createHash('sha256').update(requestCanonical).digest('hex')!==requestSha256)process.exit(1);
NODE

IFS=$'\t' read -r PROD_BASE PREDECESSOR_RUNTIME PREDECESSOR_SHA PREDECESSOR_ARTIFACT_DIGEST \
  PREDECESSOR_INSTALLED_RUNTIME_DIGEST TARGET_RUNTIME TARGET_SHA TARGET_VERSION \
  SENTRY_RELEASE ARTIFACT_DIGEST \
  INSTALLED_RUNTIME_DIGEST RECOVERY_RUNTIME_DIGEST BACKUP_DIR PM2_BIN < <(node - "$REQUEST" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const values=[x.productionBase,x.predecessor.runtime,x.predecessor.sha,x.predecessor.artifactDigest,
  x.predecessor.installedRuntimeDigest,x.target.runtime,x.target.sha,x.target.version,x.target.sentryRelease,
  x.target.artifactDigest,x.target.installedRuntimeDigest,x.target.recoveryRuntimeDigest,x.backupDir,x.pm2Bin];
if(values.some((v)=>typeof v!=='string'||v.includes('\t')||v.includes('\n')))process.exit(1);
process.stdout.write(`${values.join('\t')}\n`);
NODE
)

materialize_release_evidence() {
  install -d -m 700 "$EVIDENCE_DIR"
  root_own "$EVIDENCE_DIR"
  fsync_directory "$TRANSACTION_DIR"
  node - "$REQUEST" "$RELEASE_MANIFEST" "$STAGING_ATTESTATION" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [requestPath,manifestPath,stagingPath]=process.argv.slice(2);
const request=JSON.parse(fs.readFileSync(requestPath,'utf8')),e=request.releaseEvidence;
const write=(output,encoded,expected)=>{
 const body=Buffer.from(encoded,'base64');
 if(body.length===0||body.length>16*1024*1024||body.toString('base64')!==encoded
   ||crypto.createHash('sha256').update(body).digest('hex')!==expected)process.exit(1);
 if(fs.existsSync(output)){
   const stat=fs.lstatSync(output);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==body.length)process.exit(1);
   const current=fs.readFileSync(output);
   if(!current.equals(body))process.exit(1);
   return;
 }
 const temporary=`${output}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
 try{
  fs.writeFileSync(temporary,body,{mode:0o600,flag:'wx'});
  const descriptor=fs.openSync(temporary,'r');
  try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
  fs.renameSync(temporary,output);
 }finally{fs.rmSync(temporary,{force:true});}
};
write(manifestPath,e.releaseManifestBase64,e.releaseManifestSha256);
write(stagingPath,e.stagingAttestationBase64,e.stagingAttestationSha256);
NODE
  chmod 600 "$RELEASE_MANIFEST" "$STAGING_ATTESTATION"
  root_own "$RELEASE_MANIFEST" "$STAGING_ATTESTATION"
  fsync_directory "$EVIDENCE_DIR"
}
materialize_release_evidence
if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ] && [ -n "${NEXUS_PROMOTION_TEST_ROOT:-}" ]; then
  PROD_BASE="$NEXUS_PROMOTION_TEST_ROOT/production"
  PREDECESSOR_RUNTIME="$PROD_BASE/releases/previous-runtime"
  TARGET_RUNTIME="$PROD_BASE/releases/target-runtime"
  BACKUP_DIR="$NEXUS_PROMOTION_TEST_ROOT/backups"
  PM2_BIN="$NEXUS_PROMOTION_TEST_ROOT/bin/pm2"
fi

monotonic_seconds() {
  local uptime
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ] \
      && [[ "${NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS:-}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS"
    return 0
  fi
  if [ -r /proc/uptime ]; then
    IFS=' ' read -r uptime _ < /proc/uptime
    printf '%s\n' "${uptime%%.*}"
    return 0
  fi
  # The production contract is Linux/systemd, where /proc/uptime is the
  # kernel monotonic clock. This fallback exists only for the macOS fixture.
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    date +%s
    return 0
  fi
  echo "kernel monotonic clock is unavailable" >&2
  return 1
}

trusted_attest() {
  local mode="$1" runtime="$2" sha="$3" artifact="$4" installed="$5" args group_id
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then return 0; fi
  group_id="$(id -g "$WORKER_USER")"
  args=("$mode" --root "$runtime" --base "$PROD_BASE" --runtime-sha "$sha" \
    --artifact-digest "$artifact" --installed-runtime-digest "$installed" --group-id "$group_id")
  "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 30s \
    "$SYSTEM_NODE_BIN" "$TRUSTED_ATTESTOR" "${args[@]}" >/dev/null
}

root_switch_selector() {
  local target="$1" runtime_sha artifact_digest installed_digest expected
  local worker_uid worker_gid args
  if [ "$target" = "$TARGET_RUNTIME" ]; then
    runtime_sha="$TARGET_SHA"; artifact_digest="$ARTIFACT_DIGEST"
    installed_digest="$INSTALLED_RUNTIME_DIGEST"
    expected="$PREDECESSOR_RUNTIME"
  elif [ "$target" = "$PREDECESSOR_RUNTIME" ]; then
    runtime_sha="$PREDECESSOR_SHA"; artifact_digest="$PREDECESSOR_ARTIFACT_DIGEST"
    installed_digest="$PREDECESSOR_INSTALLED_RUNTIME_DIGEST"
    expected="$TARGET_RUNTIME"
  else
    echo "root selector target is outside the exact transaction authority" >&2
    return 1
  fi
  [ "$target" != "$PROD_BASE/releases" ] && [[ "$target" == "$PROD_BASE"/releases/* ]] || {
    echo "root selector target is outside production releases" >&2
    return 1
  }
  trusted_attest verify "$target" "$runtime_sha" "$artifact_digest" "$installed_digest" || return 1
  [ -x "$PYTHON_BIN" ] && [ -f "$SELECTOR_SWITCH" ] && [ ! -L "$SELECTOR_SWITCH" ] || {
    echo "root selector switch helper is unavailable" >&2
    return 1
  }
  worker_uid="$(id -u "$WORKER_USER")"
  worker_gid="$(id -g "$WORKER_USER")"
  args=(
    switch --role production --release-root "$(dirname -- "$PROD_BASE")"
    --worker-uid "$worker_uid" --worker-gid "$worker_gid"
    --expected "$expected" --target "$target"
  )
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ]; then args+=(--allow-test-owner); fi
  "$PYTHON_BIN" "$SELECTOR_SWITCH" "${args[@]}" >/dev/null
  verify_root_selector "$target"
}

prepare_recovery_descriptor_unprivileged() (
  set -euo pipefail
  local worker_uid worker_gid preflight_root descriptor_next="" descriptor_fd
  worker_uid="$(id -u "$WORKER_USER")"
  worker_gid="$(id -g "$WORKER_USER")"
  [[ "$worker_uid" =~ ^[0-9]+$ && "$worker_gid" =~ ^[0-9]+$ \
      && "$worker_uid" -gt 0 ]] || {
    echo "promotion worker identity is invalid for recovery verification" >&2
    return 1
  }
  for executable in "$SETPRIV_BIN" "$UNSHARE_BIN" "$BASH_BIN" "$SYSTEM_NODE_BIN"; do
    [ -x "$executable" ] && [ ! -d "$executable" ] || {
      echo "recovery verification isolation executable is unavailable: $executable" >&2
      return 1
    }
  done
  preflight_root="$(mktemp -d "/run/nexus-release-recovery-${TRANSACTION_ID}.XXXXXX")"
  [[ "$preflight_root" == /run/nexus-release-recovery-"$TRANSACTION_ID".* \
      && -d "$preflight_root" && ! -L "$preflight_root" ]] || {
    echo "recovery verification preflight directory is unsafe" >&2
    return 1
  }
  cleanup_recovery_preflight() {
    if [ -n "$descriptor_next" ] \
        && [[ "$descriptor_next" == "$RECOVERY_DESCRIPTOR".next.* ]] \
        && [ -e "$descriptor_next" ] && [ ! -L "$descriptor_next" ]; then
      rm -f -- "$descriptor_next"
    fi
    rm -rf -- "$preflight_root"
  }
  trap cleanup_recovery_preflight EXIT
  chown root:"$worker_gid" "$preflight_root"
  chmod 0710 "$preflight_root"
  install -o root -g root -m 0644 -- \
    "$RELEASE_MANIFEST" "$preflight_root/release-manifest.json"
  install -o root -g root -m 0644 -- \
    "$STAGING_ATTESTATION" "$preflight_root/staging-attestation.json"
  install -o root -g root -m 0644 -- \
    "$RELEASE_EVIDENCE_PUBLIC_KEY" "$preflight_root/release-evidence-public-key.pem"

  descriptor_next="$(mktemp "$RECOVERY_DESCRIPTOR.next.XXXXXXXX")"
  [[ "$descriptor_next" == "$RECOVERY_DESCRIPTOR".next.* ]] \
    && [ -f "$descriptor_next" ] && [ ! -L "$descriptor_next" ] || {
    echo "recovery descriptor staging path is unsafe" >&2
    return 1
  }
  chmod 0600 "$descriptor_next"
  root_own "$descriptor_next"
  exec {descriptor_fd}<>"$descriptor_next"
  "$UNSHARE_BIN" --mount --net --fork \
    "$BASH_BIN" -c '
      set -euo pipefail
      run_uid="$1"
      run_gid="$2"
      setpriv_bin="$3"
      shift 3
      mount --make-rprivate /
      mount -t tmpfs -o mode=1777,nosuid,nodev,size=128m tmpfs /tmp
      mount -o remount,ro /
      exec "$setpriv_bin" \
        --reuid "$run_uid" \
        --regid "$run_gid" \
        --clear-groups \
        --bounding-set=-all \
        --inh-caps=-all \
        --ambient-caps=-all \
        --no-new-privs \
        env -i \
          PATH=/usr/local/bin:/usr/bin:/bin \
          HOME=/nonexistent \
          TMPDIR=/tmp \
          "$@"
    ' nexus-release-recovery-verifier \
      "$worker_uid" "$worker_gid" "$SETPRIV_BIN" \
      "$SYSTEM_NODE_BIN" "$RECOVERY_RUNTIME_BIN" prepare \
      --root "$TARGET_RUNTIME" \
      --manifest "$preflight_root/release-manifest.json" \
      --staging-attestation "$preflight_root/staging-attestation.json" \
      --public-key "$preflight_root/release-evidence-public-key.pem" \
      --recovery-identity-helper "$RECOVERY_IDENTITY_BIN" \
      --runtime-sha "$TARGET_SHA" \
      --artifact-digest "$ARTIFACT_DIGEST" \
      --installed-runtime-digest "$INSTALLED_RUNTIME_DIGEST" \
      --recovery-runtime-digest "$RECOVERY_RUNTIME_DIGEST" \
      --output-fd "$descriptor_fd" >/dev/null
  exec {descriptor_fd}>&-
  [ -f "$descriptor_next" ] && [ ! -L "$descriptor_next" ] \
    && [ "$(stat -c '%U:%G:%a' "$descriptor_next")" = root:root:600 ] \
    && [ "$(stat -c '%s' "$descriptor_next")" -gt 0 ] \
    || {
      echo "unprivileged recovery descriptor output is invalid" >&2
      return 1
    }
  durable_publish "$descriptor_next" "$RECOVERY_DESCRIPTOR"
)

prepare_exact_runtimes() {
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then return 0; fi
  # Seal first, then attest again from root-owned code. Candidate code cannot
  # change between this boundary and the sequential worker execution.
  trusted_attest seal "$PREDECESSOR_RUNTIME" "$PREDECESSOR_SHA" \
    "$PREDECESSOR_ARTIFACT_DIGEST" "$PREDECESSOR_INSTALLED_RUNTIME_DIGEST" || return 1
  trusted_attest seal "$TARGET_RUNTIME" "$TARGET_SHA" "$ARTIFACT_DIGEST" \
    "$INSTALLED_RUNTIME_DIGEST" || return 1
  for helper in "$RECOVERY_RUNTIME_BIN" "$RECOVERY_IDENTITY_BIN" "$RELEASE_EVIDENCE_PUBLIC_KEY"; do
    [ -f "$helper" ] && [ ! -L "$helper" ] || {
      echo "root-installed recovery identity tooling is unavailable: $helper" >&2
      return 1
    }
  done
  if [ -e "$RECOVERY_DESCRIPTOR" ] || [ -L "$RECOVERY_DESCRIPTOR" ]; then
    # A systemd restart before RECOVERY_INTENT is armed is still strictly
    # pre-mutation. Recreate only the exact root-owned transaction descriptor;
    # every other path shape fails closed.
    [ ! -L "$RECOVERY_DESCRIPTOR" ] \
      && [ -f "$RECOVERY_DESCRIPTOR" ] \
      && [ "$(stat -c '%U:%G:%a:%h' "$RECOVERY_DESCRIPTOR")" = root:root:600:1 ] \
      && [ "$(stat -c '%s' "$RECOVERY_DESCRIPTOR")" -gt 0 ] \
      && [ "$(stat -c '%s' "$RECOVERY_DESCRIPTOR")" -le 33554432 ] || {
      echo "existing recovery descriptor is unsafe for pre-mutation resume" >&2
      return 1
    }
    durable_remove "$RECOVERY_DESCRIPTOR"
  fi
  prepare_recovery_descriptor_unprivileged || return 1
  "$RUNUSER_BIN" -u "$WORKER_USER" -- /bin/bash "$TARGET_RUNTIME/scripts/remote-release-capacity.sh" \
    --role production --base-dir "$PROD_BASE" --pm2-bin "$PM2_BIN" || return 1
  "$RUNUSER_BIN" -u "$WORKER_USER" -- /bin/bash "$TARGET_RUNTIME/scripts/remote-release-preflight.sh" \
    --role production --base-dir "$PROD_BASE" --release-dir "$TARGET_RUNTIME" \
    --node-bin /usr/bin/node || return 1
}

preflight_application_dr() {
  local verification
  [ -f "$DR_BACKUP_BIN" ] && [ -x "$DR_BACKUP_BIN" ] && [ ! -L "$DR_BACKUP_BIN" ] || {
    echo "application DR backup tooling is unavailable" >&2
    return 1
  }
  [ -f "$DR_CONFIG" ] && [ ! -L "$DR_CONFIG" ] || {
    echo "application DR configuration is unavailable" >&2
    return 1
  }
  verification="$("$TIMEOUT_BIN" --signal=TERM --kill-after=5s 60s \
    "$DR_BACKUP_BIN" --config "$DR_CONFIG" --verify-config)" || {
    echo "application DR provisioning/config preflight failed" >&2
    return 1
  }
  case "$verification" in
    'application_dr_backup_config_ok encryption=age transport=s3-compatible storageProvider=aws-s3 storageControlMode=versioned-s3 releasePrefixLock=verified databaseRetention=24-hourly,7-daily,4-weekly,6-monthly releaseRetention=90-days') ;;
    'application_dr_backup_config_ok encryption=age transport=s3-compatible storageProvider=cloudflare-r2 storageControlMode=r2-approved-variance releasePrefixLock=verified databaseRetention=24-hourly,7-daily,4-weekly,6-monthly releaseRetention=90-days') ;;
    *)
      echo "application DR provisioning/config preflight returned invalid evidence" >&2
      return 1
      ;;
  esac
}

write_cutover_timing() {
  local started_monotonic started_at boot_id output
  started_monotonic="$(monotonic_seconds)"
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf test-boot)"
  output="$(durable_staging_file "$CUTOVER_TIMING")"
  node - "$output" "$started_at" "$started_monotonic" "$boot_id" \
    "$PRE_RECOVERY_BUDGET_SECONDS" "$OUTAGE_BUDGET_SECONDS" <<'NODE'
const fs=require('fs');const [output,startedAt,startedRaw,bootId,phaseRaw,budgetRaw]=process.argv.slice(2);
const started=Number(startedRaw),phase=Number(phaseRaw),budget=Number(budgetRaw);
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.promotion-cutover-timing.v1',startedAt,
 startedMonotonicSeconds:started,preRecoveryDeadlineMonotonicSeconds:started+phase,
 outageDeadlineMonotonicSeconds:started+budget,bootId},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"; root_own "$output"
  durable_publish "$output" "$CUTOVER_TIMING"
}

read_cutover_timing() {
  node - "$CUTOVER_TIMING" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(x.schema!=='nexus.promotion-cutover-timing.v1'||!Number.isSafeInteger(x.startedMonotonicSeconds)
 ||!Number.isSafeInteger(x.preRecoveryDeadlineMonotonicSeconds)||!Number.isSafeInteger(x.outageDeadlineMonotonicSeconds)
 ||x.preRecoveryDeadlineMonotonicSeconds-x.startedMonotonicSeconds!==60
 ||x.outageDeadlineMonotonicSeconds-x.startedMonotonicSeconds!==120)process.exit(1);
process.stdout.write(`${x.startedAt}\t${x.startedMonotonicSeconds}\t${x.preRecoveryDeadlineMonotonicSeconds}\t${x.outageDeadlineMonotonicSeconds}\t${x.bootId}\n`);
NODE
}

write_recovery_intent_pre_candidate() {
  local output
  output="$(durable_staging_file "$RECOVERY_INTENT")"
  node - "$output" "$TRANSACTION_ID" "$request_sha" <<'NODE'
const fs=require('fs');const [output,transactionId,requestSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.promotion-root-recovery-intent.v2',transactionId,requestSha256,
 phase:'pre_candidate',armedAt:new Date().toISOString(),backup:null,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"; root_own "$output"
  durable_publish "$output" "$RECOVERY_INTENT"
}

read_recovery_intent() {
  [ -f "$RECOVERY_INTENT" ] && [ ! -L "$RECOVERY_INTENT" ] || {
    echo "root recovery intent is missing or unsafe" >&2
    return 1
  }
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    [ "$(stat -c '%U:%G:%a:%h' "$RECOVERY_INTENT")" = root:root:600:1 ] || {
      echo "root recovery intent ownership or mode is unsafe" >&2
      return 1
    }
  fi
  node - "$RECOVERY_INTENT" "$TRANSACTION_ID" "$request_sha" "$BACKUP_DIR" <<'NODE'
const fs=require('fs');const path=require('path');
const [file,transactionId,requestSha256,backupDir]=process.argv.slice(2);
const stat=fs.lstatSync(file),x=JSON.parse(fs.readFileSync(file,'utf8'));
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
 ||x.schema!=='nexus.promotion-root-recovery-intent.v2'
 ||x.transactionId!==transactionId||x.requestSha256!==requestSha256
 ||!['pre_candidate','candidate_authorized'].includes(x.phase)
 ||typeof x.armedAt!=='string'||!Number.isFinite(Date.parse(x.armedAt)))process.exit(1);
if(x.phase==='pre_candidate'){
 if(x.backup!==null)process.exit(1);
 process.stdout.write('pre_candidate\t\t\t\t\n');
 process.exit(0);
}
const b=x.backup;
if(!b||typeof b.file!=='string'||path.dirname(b.file)!==backupDir
 ||!path.basename(b.file).startsWith('v')||!b.file.endsWith('.tar.gz')
 ||!/^[a-f0-9]{64}$/u.test(b.sha256||'')||!/^[a-f0-9]{64}$/u.test(b.databaseSha256||'')
 ||!Number.isSafeInteger(b.sizeBytes)||b.sizeBytes<1
 ||typeof x.candidateAuthorizedAt!=='string'
 ||!Number.isFinite(Date.parse(x.candidateAuthorizedAt)))process.exit(1);
process.stdout.write(`candidate_authorized\t${b.file}\t${b.sha256}\t${b.sizeBytes}\t${b.databaseSha256}\n`);
NODE
}

authorize_candidate_from_worker_backup() {
  local fields backup_file backup_sha backup_size archived_version target_version
  local created_at database_sha observed_size output
  [ -f "$WORKER_BACKUP_ENV" ] && [ ! -L "$WORKER_BACKUP_ENV" ] || {
    echo "worker backup evidence is missing before root candidate authorization" >&2
    return 1
  }
  fields="$(node - "$WORKER_BACKUP_ENV" <<'NODE'
const fs=require('fs');const file=process.argv[2],stat=fs.lstatSync(file),m=new Map();
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)process.exit(1);
for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/u)){
 if(line==='')continue;const match=line.match(/^([A-Z0-9_]+)=(.*)$/u);
 if(!match||m.has(match[1])||match[2].includes('\t'))process.exit(1);m.set(match[1],match[2]);
}
const keys=['NEXUS_BACKUP_FILE','NEXUS_BACKUP_SHA256','NEXUS_BACKUP_SIZE_BYTES',
 'NEXUS_BACKUP_ARCHIVED_VERSION','NEXUS_BACKUP_TARGET_VERSION',
 'NEXUS_BACKUP_CREATED_AT','NEXUS_BACKUP_DATABASE_SHA256'];
if(m.size!==keys.length||keys.some((key)=>!m.has(key)))process.exit(1);
process.stdout.write(`${keys.map((key)=>m.get(key)).join('\t')}\n`);
NODE
)" || {
    echo "worker backup evidence is invalid before root candidate authorization" >&2
    return 1
  }
  IFS=$'\t' read -r backup_file backup_sha backup_size archived_version target_version \
    created_at database_sha <<<"$fields"
  case "$backup_file" in "$BACKUP_DIR"/v*.tar.gz) ;; *) return 1 ;; esac
  [[ "$backup_sha" =~ ^[a-f0-9]{64}$ && "$database_sha" =~ ^[a-f0-9]{64}$ \
      && "$backup_size" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$target_version" = "$TARGET_VERSION" ] \
    && [[ "$archived_version" =~ ^[0-9A-Za-z.+-]+$ ]] \
    && [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || return 1
  [ -f "$backup_file" ] && [ ! -L "$backup_file" ] \
    && [ "$(readlink -f "$backup_file")" = "$backup_file" ] || return 1
  observed_size="$(stat -c '%s' "$backup_file" 2>/dev/null || stat -f '%z' "$backup_file")"
  [ "$observed_size" = "$backup_size" ] \
    && [ "$(sha256sum "$backup_file" | awk '{print $1}')" = "$backup_sha" ] || return 1
  output="$(durable_staging_file "$RECOVERY_INTENT")"
  node - "$output" "$TRANSACTION_ID" "$request_sha" "$RECOVERY_INTENT" \
    "$backup_file" "$backup_sha" "$backup_size" "$database_sha" <<'NODE'
const fs=require('fs');
const [output,transactionId,requestSha256,currentPath,file,sha256,sizeRaw,databaseSha256]=process.argv.slice(2);
const current=JSON.parse(fs.readFileSync(currentPath,'utf8'));
if(current.schema!=='nexus.promotion-root-recovery-intent.v2'
 ||current.transactionId!==transactionId||current.requestSha256!==requestSha256
 ||current.phase!=='pre_candidate'||current.backup!==null)process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 ...current,phase:'candidate_authorized',candidateAuthorizedAt:new Date().toISOString(),
 backup:{file,sha256,sizeBytes:Number(sizeRaw),databaseSha256},
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"; root_own "$output"
  durable_publish "$output" "$RECOVERY_INTENT"
}

ensure_recovery_attempt_timing() {
  local scope="${1:-original_cutover}" timing started_at started_mono _phase_deadline
  local _outage_deadline boot_id now_at now_mono output
  if [ -f "$RECOVERY_ATTEMPT_TIMING" ] && [ ! -L "$RECOVERY_ATTEMPT_TIMING" ]; then
    return 0
  fi
  [ ! -e "$RECOVERY_ATTEMPT_TIMING" ] && [ ! -L "$RECOVERY_ATTEMPT_TIMING" ] || {
    echo "recovery attempt timing evidence is unsafe" >&2
    return 1
  }
  timing="$(read_cutover_timing)" || return 1
  IFS=$'\t' read -r started_at started_mono _phase_deadline _outage_deadline boot_id <<<"$timing"
  case "$scope" in
    original_cutover) now_at="$started_at"; now_mono="$started_mono" ;;
    post_availability_detection)
      now_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      now_mono="$(monotonic_seconds)"
      boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf test-boot)"
      ;;
    *) echo "invalid recovery timing scope" >&2; return 1 ;;
  esac
  output="$(durable_staging_file "$RECOVERY_ATTEMPT_TIMING")"
  node - "$output" "$scope" "$started_at" "$now_at" "$now_mono" "$boot_id" <<'NODE'
const fs=require('fs');
const [output,scope,originalCutoverStartedAt,measurementStartedAt,startedRaw,bootId]=process.argv.slice(2);
const started=Number(startedRaw);
if(!Number.isSafeInteger(started)||started<0)process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.promotion-recovery-attempt-timing.v1',scope,originalCutoverStartedAt,
 measurementStartedAt,startedMonotonicSeconds:started,
 deadlineMonotonicSeconds:started+120,bootId,
 },null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"; root_own "$output"
  durable_publish "$output" "$RECOVERY_ATTEMPT_TIMING"
}

read_recovery_attempt_timing() {
  node - "$RECOVERY_ATTEMPT_TIMING" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(x.schema!=='nexus.promotion-recovery-attempt-timing.v1'
 ||!['original_cutover','post_availability_detection'].includes(x.scope)
 ||!Number.isSafeInteger(x.startedMonotonicSeconds)
 ||!Number.isSafeInteger(x.deadlineMonotonicSeconds)
 ||x.deadlineMonotonicSeconds-x.startedMonotonicSeconds!==120
 ||typeof x.measurementStartedAt!=='string'||typeof x.originalCutoverStartedAt!=='string'
 ||typeof x.bootId!=='string')process.exit(1);
process.stdout.write(`${x.scope}\t${x.originalCutoverStartedAt}\t${x.measurementStartedAt}\t${x.startedMonotonicSeconds}\t${x.deadlineMonotonicSeconds}\t${x.bootId}\n`);
NODE
}

journal_status() {
  [ -f "$JOURNAL" ] || return 1
  node - "$JOURNAL" "$TRANSACTION_ID" "$request_sha" <<'NODE'
const fs=require('fs');const [file,id,digest]=process.argv.slice(2);const x=JSON.parse(fs.readFileSync(file,'utf8'));
const statuses=new Set(['running','recovery_required','escrow_pending','completed',
 'recovered','failed_before_stop','recovery_failed']);
if(x.schema!=='nexus.promotion-transaction-journal.v1'||x.transactionId!==id
 ||x.requestSha256!==digest||!statuses.has(x.status))process.exit(1);
process.stdout.write(String(x.status||''));
NODE
}

write_journal() {
  local phase="$1" status="$2" message="$3" previous_started="" output
  case "$status" in
    completed|recovered|failed_before_stop)
      publish_terminal_pm2_authority
      ;;
  esac
  if [ -f "$JOURNAL" ]; then
    previous_started="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.startedAt||"")' "$JOURNAL")"
  fi
  output="$(durable_staging_file "$JOURNAL")"
  node - "$output" "$REQUEST" "$request_sha" "$phase" "$status" "$message" "$previous_started" \
    "$RECOVERY_INTENT" "$ESCROW_CONFIRMATION" "$RECOVERY_RESULT" <<'NODE'
const fs=require('fs');
const [output,requestPath,requestSha256,phase,status,message,previousStarted,recoveryPath,escrowPath,recoveryResultPath]=process.argv.slice(2);
const request=JSON.parse(fs.readFileSync(requestPath,'utf8'));const now=new Date().toISOString();
const terminal=['completed','recovered','failed_before_stop','recovery_failed'].includes(status);
let recovery=null;try{recovery=JSON.parse(fs.readFileSync(recoveryResultPath,'utf8'));}catch{}
fs.writeFileSync(output,`${JSON.stringify({
  schema:'nexus.promotion-transaction-journal.v1',transactionId:request.transactionId,requestSha256,
  phase,status,message,startedAt:previousStarted||now,updatedAt:now,completedAt:terminal?now:null,
  predecessor:request.predecessor,target:request.target,sentryRelease:request.target.sentryRelease,
  recoveryArmed:fs.existsSync(recoveryPath),escrowConfirmed:fs.existsSync(escrowPath),recovery,
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"
  root_own "$output"
  durable_publish "$output" "$JOURNAL"
}

publish_terminal_pm2_authority() {
  local result
  # During boot, staging and production journals reconcile sequentially under
  # one root-owned temporary PM2 cgroup. The final boot prepare publishes one
  # canonical four-row authority only after both roles are exact.
  [ ! -f "$STATE_ROOT/boot-recovery-in-progress.v1.json" ] || return 0
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = 1 ] \
      && [ -z "${NEXUS_PROMOTION_BOOT_HEALTH_BIN:-}" ]; then
    return 0
  fi
  [ -x "$BOOT_HEALTH_BIN" ] || {
    echo "root PM2 authority publisher is unavailable" >&2
    return 1
  }
  result="$("$BOOT_HEALTH_BIN" publish-current)"
  "$SYSTEM_NODE_BIN" -e '
const x=JSON.parse(process.argv[1]);
if(x.schema!=="nexus.pm2-resurrection-authority.v2"
 ||!/^[a-f0-9]{64}$/u.test(x.dumpSha256||""))process.exit(1);
' "$result"
}

invoke_worker() {
  local mode="$1"
  local timing started_at started_mono phase_deadline outage_deadline boot_id
  local recovery_fields recovery_phase="" backup_file="" backup_sha="" backup_size=""
  local backup_database_sha="" pm2_state_dir
  if [ "$mode" = worker-verify-candidate ]; then
    if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
      "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 55s \
        env NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" \
          NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
          bash "$TRANSACTION_SCRIPT" "$mode" "$TRANSACTION_ID"
    else
      "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 55s \
        "$RUNUSER_BIN" -u "$WORKER_USER" -- /usr/bin/env \
          NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" \
          NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
          /bin/bash -s -- "$mode" "$TRANSACTION_ID" < "$TRANSACTION_SCRIPT"
    fi
    return
  fi
  timing="$(read_cutover_timing)" || { echo "authoritative cutover timing is invalid" >&2; return 1; }
  IFS=$'\t' read -r started_at started_mono phase_deadline outage_deadline boot_id <<<"$timing"
  if [ "$mode" = worker-promote ]; then
    recovery_fields="$(read_recovery_intent)" || return 1
    IFS=$'\t' read -r recovery_phase backup_file backup_sha backup_size \
      backup_database_sha <<<"$recovery_fields"
    [ "$recovery_phase" = candidate_authorized ] || {
      echo "root candidate authorization phase is invalid" >&2
      return 1
    }
  fi
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    pm2_state_dir="${NEXUS_PROMOTION_TEST_ROOT:-$STATE_ROOT}/pm2-state"
    NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
      NEXUS_PROMOTION_CUTOVER_STARTED_AT="$started_at" \
      NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC="$started_mono" \
      NEXUS_PROMOTION_PRE_RECOVERY_DEADLINE_MONOTONIC="$phase_deadline" \
      NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC="$outage_deadline" \
      NEXUS_PROMOTION_RECOVERY_PHASE="$recovery_phase" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_FILE="$backup_file" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_SHA256="$backup_sha" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_SIZE_BYTES="$backup_size" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_DATABASE_SHA256="$backup_database_sha" \
      NEXUS_PROMOTION_PM2_STATE_DIR="$pm2_state_dir" \
      bash "$TRANSACTION_SCRIPT" "$mode" "$TRANSACTION_ID"
  else
    pm2_state_dir="$(getent passwd "$WORKER_USER" | awk -F: 'NR==1{print $6}')"
    [ -n "$pm2_state_dir" ] && [[ "$pm2_state_dir" == /* ]] || {
      echo "promotion worker home is unavailable for PM2 durability" >&2
      return 1
    }
    pm2_state_dir="$pm2_state_dir/.pm2"
    "$RUNUSER_BIN" -u "$WORKER_USER" -- /usr/bin/env \
      NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" \
      NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
      NEXUS_PROMOTION_CUTOVER_STARTED_AT="$started_at" \
      NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC="$started_mono" \
      NEXUS_PROMOTION_PRE_RECOVERY_DEADLINE_MONOTONIC="$phase_deadline" \
      NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC="$outage_deadline" \
      NEXUS_PROMOTION_RECOVERY_PHASE="$recovery_phase" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_FILE="$backup_file" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_SHA256="$backup_sha" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_SIZE_BYTES="$backup_size" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_DATABASE_SHA256="$backup_database_sha" \
      NEXUS_PROMOTION_PM2_STATE_DIR="$pm2_state_dir" \
      /bin/bash -s -- "$mode" "$TRANSACTION_ID" < "$TRANSACTION_SCRIPT"
  fi
}

CANDIDATE_READINESS_JSON=""
PRE_ESCROW_READINESS_JSON=""
POST_ESCROW_READINESS_JSON=""
ESCROW_CANDIDATE_DEGRADED=false
refresh_candidate_readiness() {
  local raw
  raw="$(invoke_worker worker-verify-candidate)" || {
    echo "candidate refreshed readiness failed" >&2
    return 1
  }
  node - "$raw" "$TRANSACTION_ID" "$TARGET_SHA" "$TARGET_VERSION" "$SEALED_RESULT" <<'NODE'
const fs=require('fs');
const [raw,id,sha,version,resultPath]=process.argv.slice(2);
const x=JSON.parse(raw),m=new Map();
for(const line of fs.readFileSync(resultPath,'utf8').split(/\r?\n/u)){
 if(line==='')continue;const match=line.match(/^([A-Z0-9_]+)=(.*)$/u);
 if(!match||m.has(match[1]))process.exit(1);m.set(match[1],match[2]);
}
const verified=Date.parse(x.verifiedAt||''),soak=Date.parse(m.get('NEXUS_SOAK_COMPLETED_AT')||'');
if(x.schema!=='nexus.candidate-readiness-refresh.v1'||x.status!=='passed'
 ||x.transactionId!==id||x.runtimeSha!==sha||x.packageVersion!==version
 ||!Number.isFinite(verified)||!Number.isFinite(soak)||verified<soak
 ||verified>Date.now()+5*60*1000
 ||!x.checks||Object.values(x.checks).length!==5
 ||Object.values(x.checks).some((value)=>value!==true))process.exit(1);
NODE
  CANDIDATE_READINESS_JSON="$raw"
}

RECOVERY_TARGET_FORCED_MISSED=false
invoke_recovery() {
  local timing scope original_started_at started_at started_mono outage_deadline
  local boot_id current_boot current_mono remaining timeout_seconds recovery_fields
  local recovery_phase backup_file backup_sha backup_size backup_database_sha pm2_state_dir
  timing="$(read_recovery_attempt_timing)" || {
    echo "authoritative recovery attempt timing is invalid" >&2
    return 1
  }
  IFS=$'\t' read -r scope original_started_at started_at started_mono \
    outage_deadline boot_id <<<"$timing"
  recovery_fields="$(read_recovery_intent)" || {
    echo "root-owned recovery phase/backup identity is unavailable" >&2
    return 1
  }
  IFS=$'\t' read -r recovery_phase backup_file backup_sha backup_size \
    backup_database_sha <<<"$recovery_fields"
  case "$recovery_phase" in
    pre_candidate) ;;
    candidate_authorized)
      [ -n "$backup_file" ] && [ -n "$backup_sha" ] \
        && [ -n "$backup_size" ] && [ -n "$backup_database_sha" ] || return 1
      ;;
    *) return 1 ;;
  esac
  trusted_attest verify "$PREDECESSOR_RUNTIME" "$PREDECESSOR_SHA" \
    "$PREDECESSOR_ARTIFACT_DIGEST" "$PREDECESSOR_INSTALLED_RUNTIME_DIGEST" || return 1
  # Recompute only after attestation. A stale pre-attestation remainder could
  # otherwise allow the recovery process to run beyond the 120-second target.
  current_boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf test-boot)"
  current_mono="$(monotonic_seconds)"
  if [ "$current_boot" = "$boot_id" ] && [ "$current_mono" -lt "$outage_deadline" ]; then
    remaining=$((outage_deadline - current_mono))
    timeout_seconds="$remaining"
    RECOVERY_TARGET_FORCED_MISSED=false
  else
    # A reboot resets the monotonic clock, and an already-breached deadline must
    # never suppress recovery. The journal remains non-compliant until a drill
    # proves observed outage-to-healthy time.
    timeout_seconds=120
    RECOVERY_TARGET_FORCED_MISSED=true
  fi
  [ "$timeout_seconds" -ge 1 ] || timeout_seconds=1
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    pm2_state_dir="${NEXUS_PROMOTION_TEST_ROOT:-$STATE_ROOT}/pm2-state"
    "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${timeout_seconds}s" \
      env NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
      NEXUS_PROMOTION_CUTOVER_STARTED_AT="$started_at" \
      NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC="$started_mono" \
      NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC="$outage_deadline" \
      NEXUS_PROMOTION_RECOVERY_PHASE="$recovery_phase" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_FILE="$backup_file" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_SHA256="$backup_sha" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_SIZE_BYTES="$backup_size" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_DATABASE_SHA256="$backup_database_sha" \
      NEXUS_PROMOTION_PM2_STATE_DIR="$pm2_state_dir" \
      bash "$TRANSACTION_SCRIPT" worker-recover "$TRANSACTION_ID"
  else
    pm2_state_dir="$(getent passwd "$WORKER_USER" | awk -F: 'NR==1{print $6}')"
    [ -n "$pm2_state_dir" ] && [[ "$pm2_state_dir" == /* ]] || return 1
    pm2_state_dir="$pm2_state_dir/.pm2"
    "$TIMEOUT_BIN" --signal=TERM --kill-after=5s "${timeout_seconds}s" \
      "$RUNUSER_BIN" -u "$WORKER_USER" -- /usr/bin/env \
      NEXUS_PROMOTION_STATE_ROOT="$STATE_ROOT" \
      NEXUS_PROMOTION_REQUEST_SHA256="$request_sha" \
      NEXUS_PROMOTION_CUTOVER_STARTED_AT="$started_at" \
      NEXUS_PROMOTION_CUTOVER_STARTED_MONOTONIC="$started_mono" \
      NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC="$outage_deadline" \
      NEXUS_PROMOTION_RECOVERY_PHASE="$recovery_phase" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_FILE="$backup_file" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_SHA256="$backup_sha" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_SIZE_BYTES="$backup_size" \
      NEXUS_PROMOTION_AUTHORIZED_BACKUP_DATABASE_SHA256="$backup_database_sha" \
      NEXUS_PROMOTION_PM2_STATE_DIR="$pm2_state_dir" \
      /bin/bash -s -- worker-recover "$TRANSACTION_ID" < "$TRANSACTION_SCRIPT"
  fi
}

capture_pm2_jlist() {
  local output="$1"
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    "$TIMEOUT_BIN" 5s "$PM2_BIN" jlist >"$output"
  else
    "$TIMEOUT_BIN" 5s "$RUNUSER_BIN" -u "$WORKER_USER" -- "$PM2_BIN" jlist >"$output"
  fi
}

verify_exact_pm2_stable() {
  local runtime="$1" sha="$2" baseline final
  baseline="$(mktemp "$AUTHORITATIVE_DIR/.pm2-baseline.XXXXXXXX")"
  final="$(mktemp "$AUTHORITATIVE_DIR/.pm2-final.XXXXXXXX")"
  capture_pm2_jlist "$baseline"
  sleep 1
  capture_pm2_jlist "$final"
  "$SYSTEM_NODE_BIN" - "$baseline" "$final" "$runtime" "$sha" <<'NODE'
const fs=require('fs');const [baselineFile,finalFile,runtime,sha]=process.argv.slice(2);
const expected=[
 ['nexus-hub',runtime,`${runtime}/dist/index.js`,'node'],
 ['content-engine',`${runtime}/content-engine`,
  `${runtime}/content-engine/.venv/bin/python3.12`,'none'],
];
const validate=(file)=>{
 const rows=JSON.parse(fs.readFileSync(file,'utf8')),identities=[];
 for(const [name,cwd,executable,interpreter] of expected){
  const matches=rows.filter((entry)=>entry?.name===name),row=matches[0],env=row?.pm2_env??{};
  const identity={name,pid:Number(row?.pid),restartTime:Number(env.restart_time??0),
   unstableRestarts:Number(env.unstable_restarts??0)};
  if(matches.length!==1||env.status!=='online'||env.pm_cwd!==cwd
   ||env.pm_exec_path!==executable||env.exec_interpreter!==interpreter
   ||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha||env.SENTRY_RELEASE!==sha
   ||!Number.isSafeInteger(identity.pid)||identity.pid<=0
   ||!Number.isSafeInteger(identity.restartTime)||identity.restartTime<0
   ||!Number.isSafeInteger(identity.unstableRestarts)||identity.unstableRestarts<0)process.exit(1);
  identities.push(identity);
 }
 return identities;
};
const before=validate(baselineFile),after=validate(finalFile);
if(JSON.stringify(before)!==JSON.stringify(after))process.exit(1);
NODE
  rm -f -- "$baseline" "$final"
}

verify_root_selector() {
  local target="$1"
  "$SYSTEM_NODE_BIN" - "$PROD_BASE/current" "$target" "${NEXUS_RELEASE_TEST_MODE:-0}" <<'NODE'
const fs=require('fs');const [selector,target,testMode]=process.argv.slice(2);
const stat=fs.lstatSync(selector);
const uid=testMode==='1'?process.getuid():0,gid=testMode==='1'?process.getgid():0;
if(!stat.isSymbolicLink()||stat.uid!==uid||stat.gid!==gid
 ||fs.readlinkSync(selector)!==target||fs.realpathSync.native(selector)!==target)process.exit(1);
NODE
}

verify_predecessor_live() {
  local health
  if [ "$PREDECESSOR_RUNTIME" = "$PROD_BASE" ]; then
    [ ! -e "$PROD_BASE/current" ] && [ ! -L "$PROD_BASE/current" ] || {
      echo "legacy predecessor selector is not restored" >&2
      return 1
    }
  else
    verify_root_selector "$PREDECESSOR_RUNTIME" || {
      echo "predecessor current selector is not restored" >&2
      return 1
    }
  fi
  verify_exact_pm2_stable "$PREDECESSOR_RUNTIME" "$PREDECESSOR_SHA" || {
    echo "predecessor PM2 identity is not restored" >&2
    return 1
  }
  health="$(mktemp)"
  if ! curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
      http://127.0.0.1:8200/health >"$health" \
      || ! "$SYSTEM_NODE_BIN" -e '
const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(x.status!=="healthy"||x.server?.status!=="online"||x.database!=="connected")process.exit(1);
' "$health" \
      || ! curl --fail --silent --show-error --connect-timeout 1 --max-time 5 \
        http://127.0.0.1:8100/health >/dev/null; then
    rm -f "$health"
    echo "predecessor loopback health is not restored" >&2
    return 1
  fi
  rm -f "$health"
}

seal_recovery_result() {
  local timing scope original_started_at started_at started_mono outage_deadline
  local boot_id current_boot current_mono healthy_at elapsed source output
  timing="$(read_recovery_attempt_timing)" || return 1
  IFS=$'\t' read -r scope original_started_at started_at started_mono \
    outage_deadline boot_id <<<"$timing"
  current_boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf test-boot)"
  current_mono="$(monotonic_seconds)"
  healthy_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$current_boot" = "$boot_id" ] && [ "$current_mono" -ge "$started_mono" ]; then
    elapsed=$((current_mono - started_mono)); source=monotonic
  else
    elapsed="$(node -e 'const a=Date.parse(process.argv[1]),b=Date.parse(process.argv[2]);process.stdout.write(String(Math.max(0,Math.floor((b-a)/1000))))' "$started_at" "$healthy_at")"
    source=wall_clock_after_reboot
  fi
  output="$(durable_staging_file "$RECOVERY_RESULT")"
  node - "$output" "$scope" "$original_started_at" "$started_at" \
    "$healthy_at" "$elapsed" "$source" "$RECOVERY_TARGET_FORCED_MISSED" <<'NODE'
const fs=require('fs');const [output,timingScope,originalCutoverStartedAt,
 outageStartedAt,predecessorHealthyAt,elapsedRaw,timingSource,forcedMissedRaw]=process.argv.slice(2);
const elapsed=Number(elapsedRaw);fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.promotion-recovery-result.v1',timingScope,originalCutoverStartedAt,
 outageStartedAt,predecessorHealthyAt,
 outageToHealthySeconds:elapsed,targetSeconds:120,
 targetMet:forcedMissedRaw!=='true'&&elapsed<=120,timingSource,
 },null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"; root_own "$output"
  durable_publish "$output" "$RECOVERY_RESULT"
}

recover_and_record() {
  ensure_recovery_attempt_timing "${1:-original_cutover}" || return 1
  root_switch_selector "$PREDECESSOR_RUNTIME" || return 1
  invoke_recovery || return 1
  verify_predecessor_live || return 1
  seal_recovery_result
}

read_and_validate_result() {
  local result_path="${1:-$SEALED_RESULT}"
  [ -f "$result_path" ] && [ ! -L "$result_path" ] || { echo "promotion worker result is missing" >&2; return 1; }
  node - "$result_path" "$TRANSACTION_ID" "$TARGET_SHA" "$SENTRY_RELEASE" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" "$BACKUP_DIR" <<'NODE'
const fs=require('fs');const [file,id,sha,sentry,artifact,installedDigest,backupDir]=process.argv.slice(2);const m=new Map();
for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/u)){
 if(line==='')continue;const x=line.match(/^([A-Z0-9_]+)=(.*)$/u);
 if(!x||m.has(x[1]))process.exit(1);m.set(x[1],x[2]);
}
const integer=(key)=>/^(0|[1-9][0-9]*)$/u.test(m.get(key)||'');
const timestamp=(key)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(m.get(key)||'')
  && Number.isFinite(Date.parse(m.get(key)));
if(m.get('NEXUS_TRANSACTION_ID')!==id||m.get('NEXUS_RUNTIME_SHA')!==sha
  ||m.get('NEXUS_SENTRY_RELEASE')!==sentry||m.get('NEXUS_ARTIFACT_DIGEST')!==artifact
  ||m.get('NEXUS_INSTALLED_RUNTIME_DIGEST')!==installedDigest
  ||m.get('NEXUS_VERIFICATION_SOAK_SECONDS')!=='60'
  ||!['NEXUS_CUTOVER_SECONDS','NEXUS_BACKUP_WINDOW_SECONDS','NEXUS_FINAL_UNAVAILABILITY_SECONDS','NEXUS_TOTAL_UNAVAILABILITY_SECONDS','NEXUS_SOAK_OBSERVED_SECONDS'].every(integer)
  ||m.get('NEXUS_BACKUP_OUTAGE_SECONDS')!==m.get('NEXUS_BACKUP_WINDOW_SECONDS')
  ||m.get('NEXUS_FINAL_UNAVAILABILITY_SECONDS')!==m.get('NEXUS_TOTAL_UNAVAILABILITY_SECONDS')
  ||Number(m.get('NEXUS_SOAK_OBSERVED_SECONDS'))<60
  ||Number(m.get('NEXUS_SOAK_OBSERVED_SECONDS'))>180
  ||Number(m.get('NEXUS_TOTAL_UNAVAILABILITY_SECONDS'))>60
  ||!['NEXUS_CUTOVER_STARTED_AT','NEXUS_SERVICE_UNAVAILABLE_STARTED_AT','NEXUS_CANDIDATE_AVAILABLE_AT','NEXUS_SOAK_STARTED_AT','NEXUS_SOAK_COMPLETED_AT'].every(timestamp)
  ||Date.parse(m.get('NEXUS_SOAK_COMPLETED_AT'))<Date.parse(m.get('NEXUS_SOAK_STARTED_AT')))process.exit(1);
const backup=m.get('NEXUS_BACKUP_FILE')||'',digest=m.get('NEXUS_BACKUP_SHA256')||'';
if(!backup.startsWith(`${backupDir}/v`)||!backup.endsWith('.tar.gz')||!/^[a-f0-9]{64}$/u.test(digest))process.exit(1);
process.stdout.write(`${backup}\t${digest}\n`);
NODE
}

seal_worker_result() {
  local output
  [ -f "$RESULT_ENV" ] && [ ! -L "$RESULT_ENV" ] || { echo "promotion worker result is missing" >&2; return 1; }
  output="$(durable_staging_file "$SEALED_RESULT")"
  install -m 600 "$RESULT_ENV" "$output"
  root_own "$output"
  read_and_validate_result "$output" >/dev/null || { rm -f "$output"; return 1; }
  durable_publish "$output" "$SEALED_RESULT"
}

verify_candidate_live() {
  verify_root_selector "$TARGET_RUNTIME" \
    || { echo "candidate current identity changed before escrow" >&2; return 1; }
  verify_exact_pm2_stable "$TARGET_RUNTIME" "$TARGET_SHA" \
    || { echo "candidate PM2 exact identity or restart stability failed" >&2; return 1; }
  trusted_attest verify "$TARGET_RUNTIME" "$TARGET_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST"
}

prune_local_backups_as_application_user() {
  local script
  script='const fs=require("fs"),path=require("path");const root=path.resolve(process.argv[1]);
const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(root)!==root)process.exit(1);
const files=fs.readdirSync(root).filter((name)=>/^v[A-Za-z0-9._+-]+\.tar\.gz$/u.test(name)).map((name)=>{
 const file=path.join(root,name),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())process.exit(1);
 return {file,mtime:s.mtimeMs};}).sort((a,b)=>b.mtime-a.mtime||a.file.localeCompare(b.file));
for(const entry of files.slice(10))fs.unlinkSync(entry.file);'
  if [ "${NEXUS_RELEASE_TEST_MODE:-0}" = "1" ]; then
    node -e "$script" "$BACKUP_DIR"
  else
    "$RUNUSER_BIN" -u "$WORKER_USER" -- "$SYSTEM_NODE_BIN" -e "$script" "$BACKUP_DIR"
  fi
}

escrow_candidate_recovery_preflight() {
  local dr_output confirmation_json output
  [ -x "$DR_BACKUP_BIN" ] || { echo "application DR backup tooling is unavailable" >&2; return 1; }
  dr_output="$("$TIMEOUT_BIN" --signal=TERM --kill-after=5s 300s \
    "$DR_BACKUP_BIN" --config "$DR_CONFIG" \
    --require-recovery-runtime "$TARGET_RUNTIME" \
    --recovery-escrow-id "$TRANSACTION_ID" \
    --recovery-escrow-phase pre-mutation \
    --recovery-descriptor "$RECOVERY_DESCRIPTOR" \
    --recovery-release-manifest "$RELEASE_MANIFEST" \
    --recovery-staging-attestation "$STAGING_ATTESTATION" \
    --recovery-runtime-sha "$TARGET_SHA" \
    --recovery-artifact-digest "$ARTIFACT_DIGEST" \
    --recovery-installed-runtime-digest "$INSTALLED_RUNTIME_DIGEST" \
    --recovery-runtime-digest "$RECOVERY_RUNTIME_DIGEST" \
    --json)" || {
    echo "pre-mutation current recovery runtime escrow failed" >&2
    return 1
  }
  confirmation_json="$(printf '%s\n' "$dr_output" | tail -n 1)"
  if ! node - "$confirmation_json" "$TRANSACTION_ID" "$TARGET_RUNTIME" \
    "$TARGET_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" \
    "$RECOVERY_RUNTIME_DIGEST" "$RELEASE_MANIFEST" "$STAGING_ATTESTATION" <<'NODE'
const crypto=require('crypto'),fs=require('fs');
const [raw,id,path,sha,artifact,installed,recovery,manifestPath,stagingPath]=process.argv.slice(2);
const x=JSON.parse(raw),c=x.requiredRecoveryRuntime;
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pair=(x.storageProvider==='aws-s3'&&x.storageControlMode==='versioned-s3')
 ||(x.storageProvider==='cloudflare-r2'&&x.storageControlMode==='r2-approved-variance');
const confirmed=Date.parse(c?.confirmedAt||'');
const databaseConfirmed=Date.parse(x.databaseConfirmedAt||'');
const providerProof=x.storageProvider==='aws-s3'
 ? /^[A-Za-z0-9._~+=:/-]{1,1024}$/u.test(c?.objectVersionId||'')
   && Number.isFinite(Date.parse(c?.retainUntil||''))
   && Date.parse(c.retainUntil)>=confirmed+90*86400*1000
   && c.retentionVariance===null&&c.approvedUnversionedVariance===false
 : x.storageProvider==='cloudflare-r2'&&c?.objectVersionId===null&&c?.retainUntil===null
   && c?.retentionVariance==='r2-approved-variance'&&c?.approvedUnversionedVariance===true;
const databaseProviderProof=x.storageProvider==='aws-s3'
 ? /^[A-Za-z0-9._~+=:/-]{1,1024}$/u.test(x.databaseObjectVersionId||'')
   &&x.databaseRetentionVariance===null&&x.databaseApprovedUnversionedVariance===false
 : x.storageProvider==='cloudflare-r2'&&x.databaseObjectVersionId===null
   &&x.databaseRetentionVariance==='r2-approved-variance'
   &&x.databaseApprovedUnversionedVariance===true;
if(x.schema!=='nexus.application-dr-backup-result.v1'||x.status!=='passed'||x.encrypted!==true
 ||!pair||x.releasePrefixLockVerified!==true||c?.confirmed!==true||c?.path!==path
 ||c?.escrowId!==id||c?.escrowPhase!=='pre-mutation'
 ||!Number.isFinite(confirmed)||!providerProof
 ||!Number.isFinite(databaseConfirmed)||!databaseProviderProof
 ||typeof x.databaseKey!=='string'||x.databaseKey.includes('..')
 ||!/^[a-f0-9]{64}$/u.test(x.databaseSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(x.databaseEncryptedSha256||'')
 ||!Number.isSafeInteger(x.databaseEncryptedSizeBytes)||x.databaseEncryptedSizeBytes<=0
 ||c?.runtimeSha!==sha||c?.artifactDigest!==artifact||c?.installedRuntimeDigest!==installed
 ||c?.recoveryRuntimeDigest!==recovery||!/^[a-f0-9]{64}$/u.test(c?.plaintextSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(c?.encryptedSha256||'')
 ||!Number.isSafeInteger(c?.encryptedSizeBytes)||c.encryptedSizeBytes<=0
 ||typeof c?.objectKey!=='string'
 ||!c.objectKey.endsWith(`+escrow-${id}+phase-pre-mutation.tar.gz.${c.plaintextSha256}.age`)
 ||c.objectKey.includes('..')||!/^[a-f0-9]{64}$/u.test(c.releaseManifestSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(c.stagingAttestationSha256||'')
 ||c.releaseManifestSha256!==digest(manifestPath)
 ||c.stagingAttestationSha256!==digest(stagingPath))process.exit(1);
NODE
  then
    echo "pre-mutation current recovery runtime escrow evidence is invalid" >&2
    return 1
  fi
  output="$(durable_staging_file "$PREFLIGHT_RECOVERY_CONFIRMATION")"
  node - "$output" "$TRANSACTION_ID" "$request_sha" "$confirmation_json" <<'NODE'
const fs=require('fs');const [output,transactionId,requestSha256,raw]=process.argv.slice(2);
const dr=JSON.parse(raw);fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.pre-mutation-current-recovery-escrow.v2',status:'passed',transactionId,
 requestSha256,capturedAt:new Date().toISOString(),
 storageControls:{provider:dr.storageProvider,controlMode:dr.storageControlMode,
  releasePrefixLockVerified:dr.releasePrefixLockVerified},
 currentRecoveryRuntime:dr.requiredRecoveryRuntime,
 databaseRecoveryPoint:{objectKey:dr.databaseKey,plaintextSha256:dr.databaseSha256,
  encryptedSha256:dr.databaseEncryptedSha256,
  encryptedSizeBytes:dr.databaseEncryptedSizeBytes,
  objectVersionId:dr.databaseObjectVersionId,confirmedAt:dr.databaseConfirmedAt,
  retentionVariance:dr.databaseRetentionVariance,
  approvedUnversionedVariance:dr.databaseApprovedUnversionedVariance},
},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$output"
  root_own "$output"
  durable_publish "$output" "$PREFLIGHT_RECOVERY_CONFIRMATION"
}

escrow_exact_backup() {
  local backup_file="$1" backup_sha="$2" observed_sha dr_output confirmation_json output
  ESCROW_CANDIDATE_DEGRADED=false
  PRE_ESCROW_READINESS_JSON="$CANDIDATE_READINESS_JSON"
  POST_ESCROW_READINESS_JSON=""
  [ -f "$backup_file" ] && [ ! -L "$backup_file" ] || { echo "promotion backup file is unavailable" >&2; return 1; }
  observed_sha="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$backup_file")" || {
    echo "promotion backup digest could not be computed before escrow" >&2
    return 1
  }
  [ "$observed_sha" = "$backup_sha" ] || { echo "promotion backup digest changed before escrow" >&2; return 1; }
  [ -x "$DR_BACKUP_BIN" ] || { echo "application DR backup tooling is unavailable" >&2; return 1; }
  [ -f "$DR_CONFIG" ] && [ ! -L "$DR_CONFIG" ] || { echo "application DR configuration is unavailable" >&2; return 1; }
  dr_output="$("$TIMEOUT_BIN" --signal=TERM --kill-after=5s 300s \
    "$DR_BACKUP_BIN" --config "$DR_CONFIG" --require-release "$backup_file" \
    --require-recovery-runtime "$TARGET_RUNTIME" \
    --recovery-escrow-id "$TRANSACTION_ID" \
    --recovery-escrow-phase post-soak \
    --recovery-descriptor "$RECOVERY_DESCRIPTOR" \
    --recovery-release-manifest "$RELEASE_MANIFEST" \
    --recovery-staging-attestation "$STAGING_ATTESTATION" \
    --recovery-runtime-sha "$TARGET_SHA" \
    --recovery-artifact-digest "$ARTIFACT_DIGEST" \
    --recovery-installed-runtime-digest "$INSTALLED_RUNTIME_DIGEST" \
    --recovery-runtime-digest "$RECOVERY_RUNTIME_DIGEST" \
    --json)" || {
    echo "encrypted off-host rollback escrow failed" >&2
    return 1
  }
  confirmation_json="$(printf '%s\n' "$dr_output" | tail -n 1)"
  # Off-host escrow can consume most of its five-minute bound. Re-prove the
  # exact candidate after the upload/retention confirmations, before a
  # completed journal can be written. A degraded candidate is a recovery
  # event, not an escrow retry.
  if ! verify_candidate_live || ! refresh_candidate_readiness; then
    ESCROW_CANDIDATE_DEGRADED=true
    echo "candidate degraded while encrypted off-host escrow was running" >&2
    return 1
  fi
  POST_ESCROW_READINESS_JSON="$CANDIDATE_READINESS_JSON"
  if ! node - "$confirmation_json" "$backup_file" "$backup_sha" "$TARGET_RUNTIME" \
    "$TARGET_SHA" "$ARTIFACT_DIGEST" "$INSTALLED_RUNTIME_DIGEST" \
    "$RECOVERY_RUNTIME_DIGEST" "$TRANSACTION_ID" "$PREFLIGHT_RECOVERY_CONFIRMATION" \
    "$request_sha" "$RELEASE_MANIFEST" "$STAGING_ATTESTATION" "$SEALED_RESULT" \
    "$PRE_ESCROW_READINESS_JSON" "$POST_ESCROW_READINESS_JSON" <<'NODE'
const crypto=require('crypto'),fs=require('fs');
const [raw,path,sha,runtime,runtimeSha,artifact,installed,recoveryDigest,id,preflightPath,
 requestSha,manifestPath,stagingPath,resultPath,beforeReadinessRaw,
 afterReadinessRaw]=process.argv.slice(2);
const x=JSON.parse(raw),r=x.requiredRelease,c=x.requiredRecoveryRuntime;
const pre=JSON.parse(fs.readFileSync(preflightPath,'utf8'));
const beforeReadiness=JSON.parse(beforeReadinessRaw);
const afterReadiness=JSON.parse(afterReadinessRaw);
const result=new Map();
for(const line of fs.readFileSync(resultPath,'utf8').split(/\r?\n/u)){
 if(line==='')continue;
 const match=line.match(/^([A-Z0-9_]+)=(.*)$/u);
 if(!match||result.has(match[1]))process.exit(1);
 result.set(match[1],match[2]);
}
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pair=(x.storageProvider==='aws-s3'&&x.storageControlMode==='versioned-s3')
 ||(x.storageProvider==='cloudflare-r2'&&x.storageControlMode==='r2-approved-variance');
const providerProof=(value)=>{
 const confirmed=Date.parse(value?.confirmedAt||'');
 if(!Number.isFinite(confirmed))return false;
 if(x.storageProvider==='aws-s3')return /^[A-Za-z0-9._~+=:/-]{1,1024}$/u.test(value?.objectVersionId||'')
  &&Number.isFinite(Date.parse(value?.retainUntil||''))
  &&Date.parse(value.retainUntil)>=confirmed+90*86400*1000
  &&value.retentionVariance===null&&value.approvedUnversionedVariance===false;
 return x.storageProvider==='cloudflare-r2'&&value?.objectVersionId===null
  &&value?.retainUntil===null&&value?.retentionVariance==='r2-approved-variance'
  &&value?.approvedUnversionedVariance===true;
};
const preCurrent=pre.currentRecoveryRuntime;
const preDatabase=pre.databaseRecoveryPoint;
const currentDatabase={objectKey:x.databaseKey,plaintextSha256:x.databaseSha256,
 encryptedSha256:x.databaseEncryptedSha256,encryptedSizeBytes:x.databaseEncryptedSizeBytes,
 objectVersionId:x.databaseObjectVersionId,confirmedAt:x.databaseConfirmedAt,
 retentionVariance:x.databaseRetentionVariance,
 approvedUnversionedVariance:x.databaseApprovedUnversionedVariance};
const databaseProviderProof=(value)=>{
 if(typeof value?.objectKey!=='string'||value.objectKey.includes('..')
  ||!/^[a-f0-9]{64}$/u.test(value?.plaintextSha256||'')
  ||!/^[a-f0-9]{64}$/u.test(value?.encryptedSha256||'')
  ||!Number.isSafeInteger(value?.encryptedSizeBytes)||value.encryptedSizeBytes<=0
  ||!Number.isFinite(Date.parse(value?.confirmedAt||'')))return false;
 if(x.storageProvider==='aws-s3')return /^[A-Za-z0-9._~+=:/-]{1,1024}$/u.test(value?.objectVersionId||'')
  &&value.retentionVariance===null&&value.approvedUnversionedVariance===false;
 return x.storageProvider==='cloudflare-r2'&&value?.objectVersionId===null
  &&value?.retentionVariance==='r2-approved-variance'
  &&value?.approvedUnversionedVariance===true;
};
const preDatabaseConfirmed=Date.parse(preDatabase?.confirmedAt||'');
const currentDatabaseConfirmed=Date.parse(currentDatabase?.confirmedAt||'');
const preRecoveryConfirmed=Date.parse(preCurrent?.confirmedAt||'');
const currentRecoveryConfirmed=Date.parse(c?.confirmedAt||'');
const releaseConfirmed=Date.parse(r?.confirmedAt||'');
const cutoverStarted=Date.parse(result.get('NEXUS_CUTOVER_STARTED_AT')||'');
const serviceUnavailable=Date.parse(result.get('NEXUS_SERVICE_UNAVAILABLE_STARTED_AT')||'');
const soakCompleted=Date.parse(result.get('NEXUS_SOAK_COMPLETED_AT')||'');
const beforeReadinessVerified=Date.parse(beforeReadiness?.verifiedAt||'');
const afterReadinessVerified=Date.parse(afterReadiness?.verifiedAt||'');
const readinessValid=(readiness)=>readiness?.schema==='nexus.candidate-readiness-refresh.v1'
 &&readiness?.status==='passed'&&readiness?.transactionId===id
 &&readiness?.runtimeSha===runtimeSha&&readiness?.packageVersion===result.get('NEXUS_TARGET_VERSION')
 &&Object.keys(readiness?.checks||{}).sort().join(',')==='authenticatedSnapshot,contentEngine,loopbackBackend,pm2Identity,publicHealth'
 &&Object.values(readiness.checks).every((value)=>value===true);
const stableCurrentFields=['path','plaintextSha256','runtimeSha','artifactDigest',
 'installedRuntimeDigest','recoveryRuntimeDigest','releaseManifestSha256',
 'stagingAttestationSha256','escrowId'];
if(x.schema!=='nexus.application-dr-backup-result.v1'||x.status!=='passed'||x.encrypted!==true
 ||!pair||x.releasePrefixLockVerified!==true
 ||pre.schema!=='nexus.pre-mutation-current-recovery-escrow.v2'||pre.status!=='passed'
 ||pre.transactionId!==id||pre.requestSha256!==requestSha
 ||pre.storageControls?.provider!==x.storageProvider
 ||pre.storageControls?.controlMode!==x.storageControlMode
 ||pre.storageControls?.releasePrefixLockVerified!==true
 ||!databaseProviderProof(preDatabase)||!databaseProviderProof(currentDatabase)
 ||![preDatabaseConfirmed,currentDatabaseConfirmed,preRecoveryConfirmed,
   currentRecoveryConfirmed,releaseConfirmed,cutoverStarted,serviceUnavailable,soakCompleted,
   beforeReadinessVerified,afterReadinessVerified]
   .every(Number.isFinite)
 ||preDatabaseConfirmed>cutoverStarted||preDatabaseConfirmed>serviceUnavailable
 ||currentDatabaseConfirmed<soakCompleted||currentDatabaseConfirmed<preDatabaseConfirmed
 ||preRecoveryConfirmed>cutoverStarted||preRecoveryConfirmed>serviceUnavailable
 ||currentRecoveryConfirmed<soakCompleted||currentRecoveryConfirmed<preRecoveryConfirmed
 ||!readinessValid(beforeReadiness)||!readinessValid(afterReadiness)
 ||beforeReadinessVerified<soakCompleted
 ||releaseConfirmed<beforeReadinessVerified
 ||currentRecoveryConfirmed<beforeReadinessVerified
 ||currentDatabaseConfirmed<beforeReadinessVerified
 ||afterReadinessVerified<beforeReadinessVerified
 ||afterReadinessVerified<releaseConfirmed
 ||afterReadinessVerified<currentRecoveryConfirmed
 ||afterReadinessVerified<currentDatabaseConfirmed
 ||r?.confirmed!==true||r?.path!==path||r?.plaintextSha256!==sha||!providerProof(r)
 ||!/^[a-f0-9]{64}$/u.test(r?.encryptedSha256||'')
 ||!Number.isSafeInteger(r?.encryptedSizeBytes)||r.encryptedSizeBytes<=0
 ||typeof r?.objectKey!=='string'||!r.objectKey.endsWith(`.${sha}.age`)||r.objectKey.includes('..')
 ||c?.confirmed!==true||c?.escrowId!==id||c?.escrowPhase!=='post-soak'
 ||preCurrent?.escrowPhase!=='pre-mutation'
 ||c?.path!==runtime||c?.runtimeSha!==runtimeSha
 ||c?.artifactDigest!==artifact||c?.installedRuntimeDigest!==installed
 ||c?.recoveryRuntimeDigest!==recoveryDigest
 ||typeof c?.plaintextSha256!=='string'||!/^[a-f0-9]{64}$/u.test(c.plaintextSha256)
 ||!/^[a-f0-9]{64}$/u.test(c?.encryptedSha256||'')
 ||!Number.isSafeInteger(c?.encryptedSizeBytes)||c.encryptedSizeBytes<=0
 ||typeof c?.objectKey!=='string'
 ||!c.objectKey.endsWith(`+escrow-${id}+phase-post-soak.tar.gz.${c.plaintextSha256}.age`)
 ||typeof preCurrent?.objectKey!=='string'
 ||!preCurrent.objectKey.endsWith(`+escrow-${id}+phase-pre-mutation.tar.gz.${preCurrent.plaintextSha256}.age`)
 ||c.objectKey.includes('..')||!/^[a-f0-9]{64}$/u.test(c.releaseManifestSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(c.stagingAttestationSha256||'')||!providerProof(c)
 ||!/^[a-f0-9]{64}$/u.test(preCurrent?.encryptedSha256||'')
 ||!Number.isSafeInteger(preCurrent?.encryptedSizeBytes)||preCurrent.encryptedSizeBytes<=0
 ||!providerProof(preCurrent)
 ||c.releaseManifestSha256!==digest(manifestPath)
 ||c.stagingAttestationSha256!==digest(stagingPath)
 ||stableCurrentFields.some((field)=>c[field]!==preCurrent?.[field]))process.exit(1);
NODE
  then
    echo "encrypted off-host rollback escrow returned invalid storage-control evidence" >&2
    return 1
  fi
  output="$(durable_staging_file "$ESCROW_CONFIRMATION")" || return 1
  if ! node - "$output" "$TRANSACTION_ID" "$request_sha" "$confirmation_json" \
    "$PREFLIGHT_RECOVERY_CONFIRMATION" "$SEALED_RESULT" \
    "$PRE_ESCROW_READINESS_JSON" "$POST_ESCROW_READINESS_JSON" <<'NODE'
const fs=require('fs');
const [output,transactionId,requestSha256,raw,preflightPath,resultPath,
 beforeReadinessRaw,afterReadinessRaw]=process.argv.slice(2);
const dr=JSON.parse(raw),preflight=JSON.parse(fs.readFileSync(preflightPath,'utf8'));
const beforeReadiness=JSON.parse(beforeReadinessRaw);
const afterReadiness=JSON.parse(afterReadinessRaw);
const result=new Map();
for(const line of fs.readFileSync(resultPath,'utf8').split(/\r?\n/u)){
 if(line==='')continue;
 const match=line.match(/^([A-Z0-9_]+)=(.*)$/u);
 if(!match||result.has(match[1]))process.exit(1);
 result.set(match[1],match[2]);
}
const confirmations=[dr.requiredRelease.confirmedAt,dr.requiredRecoveryRuntime.confirmedAt,
 dr.databaseConfirmedAt]
 .sort((left,right)=>Date.parse(right)-Date.parse(left));
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.promotion-dr-escrow.v3',status:'passed',
 transactionId,requestSha256,confirmedAt:confirmations[0],
 storageControls:{provider:dr.storageProvider,controlMode:dr.storageControlMode,
  releasePrefixLockVerified:dr.releasePrefixLockVerified},requiredRelease:dr.requiredRelease,
 preMutationCurrentRecovery:preflight.currentRecoveryRuntime,
 currentRecoveryRuntime:dr.requiredRecoveryRuntime,
 preMutationDatabaseRecoveryPoint:preflight.databaseRecoveryPoint,
 currentDatabaseRecoveryPoint:{objectKey:dr.databaseKey,plaintextSha256:dr.databaseSha256,
  encryptedSha256:dr.databaseEncryptedSha256,
  encryptedSizeBytes:dr.databaseEncryptedSizeBytes,
  objectVersionId:dr.databaseObjectVersionId,confirmedAt:dr.databaseConfirmedAt,
  retentionVariance:dr.databaseRetentionVariance,
  approvedUnversionedVariance:dr.databaseApprovedUnversionedVariance},
 promotionTimeline:{cutoverStartedAt:result.get('NEXUS_CUTOVER_STARTED_AT'),
  serviceUnavailableStartedAt:result.get('NEXUS_SERVICE_UNAVAILABLE_STARTED_AT'),
  soakCompletedAt:result.get('NEXUS_SOAK_COMPLETED_AT')},
 candidateReadinessRefresh:{
  beforeEscrow:beforeReadiness,
  afterEscrow:afterReadiness,
 }},null,2)}\n`,
 {mode:0o600,flag:'w'});
NODE
  then
    echo "encrypted off-host release recovery escrow evidence could not be persisted" >&2
    return 1
  fi
  chmod 600 "$output" || return 1
  root_own "$output" || return 1
  durable_publish "$output" "$ESCROW_CONFIRMATION" || return 1
  # Count retention is legal only after the predecessor and current candidate
  # recovery plaintext identities are proved in encrypted off-host storage.
  prune_local_backups_as_application_user || return 1
}

finish_escrow() {
  local result backup_file backup_sha
  result="$(read_and_validate_result "$SEALED_RESULT")" || return 1
  IFS=$'\t' read -r backup_file backup_sha <<<"$result"
  verify_candidate_live || return 1
  if ! escrow_exact_backup "$backup_file" "$backup_sha"; then
    if [ "$ESCROW_CANDIDATE_DEGRADED" = true ]; then
      write_journal recovering running candidate_degraded_during_escrow
      if recover_and_record post_availability_detection; then
        write_journal recovery_complete recovered escrow_candidate_degradation_recovered
        durable_remove "$RECOVERY_INTENT"
        return 0
      fi
      write_journal recovery_failed recovery_failed escrow_candidate_degradation_recovery_failed
      return 76
    fi
    write_journal awaiting_dr_escrow escrow_pending candidate_available_escrow_retry_required
    return 75
  fi
  write_journal completed completed exact_candidate_and_recovery_runtime_escrowed
  durable_remove "$RECOVERY_INTENT"
}

existing_status=""
if [ -e "$JOURNAL" ] || [ -L "$JOURNAL" ]; then
  [ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || {
    echo "authoritative promotion journal is unsafe" >&2
    exit 1
  }
  existing_status="$(journal_status)" || {
    echo "authoritative promotion journal is invalid" >&2
    exit 1
  }
fi
case "$existing_status" in
  completed|recovered|failed_before_stop)
    durable_remove "$RECOVERY_INTENT"
    exit 0
    ;;
  recovery_failed)
    if [ "$ACTION" != recover ] && [ ! -f "$CONTROL_DIR/recover" ]; then
      echo "promotion recovery previously failed; explicit owner recovery is required" >&2
      exit 76
    fi
    ;;
  escrow_pending)
    recovery_fields="$(read_recovery_intent)" || {
      echo "escrow-pending transaction is missing root candidate recovery authority" >&2
      exit 76
    }
    [ "${recovery_fields%%$'\t'*}" = candidate_authorized ] || {
      echo "escrow-pending recovery authority is not candidate-authorized" >&2
      exit 76
    }
    if [ "$ACTION" = recover ] || [ -f "$CONTROL_DIR/recover" ]; then
      write_journal recovering running explicit_recovery_from_escrow_pending
      if recover_and_record post_availability_detection; then
        write_journal recovery_complete recovered escrow_pending_candidate_recovered
        durable_remove "$RECOVERY_INTENT"
        exit 0
      fi
      write_journal recovery_failed recovery_failed escrow_pending_candidate_recovery_failed
      exit 76
    fi
    # The journal transition is persisted before RECOVERY_INTENT is removed.
    # A crash in that tiny interval can safely resume escrow only after the
    # exact candidate is proved live again.
    if ! verify_candidate_live || ! refresh_candidate_readiness; then
      write_journal recovering running escrow_pending_candidate_invalid
      if recover_and_record post_availability_detection; then
        write_journal recovery_complete recovered escrow_pending_candidate_recovered
        durable_remove "$RECOVERY_INTENT"
        exit 0
      fi
      write_journal recovery_failed recovery_failed escrow_pending_candidate_recovery_failed
      exit 76
    fi
    finish_escrow
    exit $?
    ;;
esac

if [ -f "$RECOVERY_INTENT" ] \
    || [ "$existing_status" = running ] \
    || [ "$existing_status" = recovery_required ] \
    || [ "$ACTION" = recover ] \
    || [ -f "$CONTROL_DIR/recover" ]; then
  if [ ! -f "$CUTOVER_TIMING" ] && [ ! -f "$RECOVERY_INTENT" ]; then
    write_journal failed_before_stop failed_before_stop recovery_requested_before_cutover_was_armed
    exit 0
  fi
  write_journal recovering running explicit_or_boot_recovery_started
  if recover_and_record; then
    write_journal recovery_complete recovered explicit_or_boot_recovery_completed
    durable_remove "$RECOVERY_INTENT"
    exit 0
  fi
  write_journal recovery_failed recovery_failed explicit_or_boot_recovery_failed
  exit 76
fi

# Static DR readiness must fail before sealing or any cutover-side mutation.
if ! preflight_application_dr; then
  write_journal preflight failed_before_stop application_dr_provisioning_or_config_invalid
  exit 0
fi
if ! prepare_exact_runtimes; then
  write_journal preflight failed_before_stop exact_runtime_preparation_or_preflight_failed
  exit 0
fi
if ! escrow_candidate_recovery_preflight; then
  write_journal preflight failed_before_stop current_recovery_runtime_not_escrowed_before_mutation
  exit 0
fi
write_cutover_timing
# Persist root-owned recovery intent before the unprivileged worker can reach
# its first PM2 stop. Every non-zero worker exit therefore takes recovery.
write_recovery_intent_pre_candidate
write_journal executing running durable_worker_preparation_started

set +e
invoke_worker worker-prepare
worker_status=$?
set -e
if [ "$worker_status" -ne 0 ]; then
  echo "promotion worker failed; restoring predecessor" >&2
  write_journal recovery_required recovery_required broker_restoring_predecessor
  if recover_and_record; then
    write_journal recovery_complete recovered automatic_recovery_completed
    durable_remove "$RECOVERY_INTENT"
    exit 0
  fi
  write_journal recovery_failed recovery_failed automatic_recovery_failed
  exit 76
fi

if ! authorize_candidate_from_worker_backup; then
  echo "worker backup could not be sealed into root candidate authority; restoring predecessor" >&2
  write_journal recovery_required recovery_required backup_authorization_failed
  if recover_and_record; then
    write_journal recovery_complete recovered invalid_backup_authorization_recovered
    durable_remove "$RECOVERY_INTENT"
    exit 0
  fi
  write_journal recovery_failed recovery_failed invalid_backup_authorization_recovery_failed
  exit 76
fi
write_journal executing running root_candidate_authorization_durable

if ! root_switch_selector "$TARGET_RUNTIME"; then
  echo "root broker could not atomically select the exact candidate" >&2
  write_journal recovery_required recovery_required candidate_selector_switch_failed
  if recover_and_record; then
    write_journal recovery_complete recovered candidate_selector_switch_failed_recovered
    durable_remove "$RECOVERY_INTENT"
    exit 0
  fi
  write_journal recovery_failed recovery_failed candidate_selector_switch_recovery_failed
  exit 76
fi

set +e
invoke_worker worker-promote
worker_status=$?
set -e
if [ "$worker_status" -ne 0 ]; then
  echo "promotion worker failed; restoring exact authorized predecessor state" >&2
  write_journal recovery_required recovery_required broker_restoring_predecessor
  if recover_and_record; then
    write_journal recovery_complete recovered automatic_recovery_completed
    durable_remove "$RECOVERY_INTENT"
    exit 0
  fi
  write_journal recovery_failed recovery_failed automatic_recovery_failed
  exit 76
fi

if ! seal_worker_result || ! verify_candidate_live || ! refresh_candidate_readiness; then
  echo "promotion worker returned without authoritative candidate proof; restoring predecessor" >&2
  write_journal recovery_required recovery_required invalid_worker_completion
  if recover_and_record; then
    write_journal recovery_complete recovered invalid_completion_recovered
    durable_remove "$RECOVERY_INTENT"
    exit 0
  fi
  write_journal recovery_failed recovery_failed invalid_completion_recovery_failed
  exit 76
fi

# Customer availability and the exact 60-second post-candidate soak are now
# proved. Persist the escrow-only state before disarming rollback, closing the
# restart gap between candidate proof and the durable state transition.
write_journal awaiting_dr_escrow escrow_pending candidate_available_before_network_escrow
finish_escrow

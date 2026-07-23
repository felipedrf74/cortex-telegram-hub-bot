#!/usr/bin/env bash
# Root-owned authorization and reconciliation boundary for persistent release
# promotion. The deploy user may submit owner-signed authority, query status,
# or request recovery; it cannot mutate authoritative transaction state.
set -euo pipefail
umask 077

VERSION="nexus-release-promotion-control.v2"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
SYSTEMCTL_BIN="${NEXUS_PROMOTION_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
AUTH_BIN="${NEXUS_PROMOTION_AUTH_BIN:-/usr/local/libexec/nexus-promotion-authorization.mjs}"
OWNER_PUBLIC_KEY="${NEXUS_PROMOTION_OWNER_PUBLIC_KEY:-/etc/nexus-release/owner-promotion-public-key.pem}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
TRUSTED_ATTESTOR="${NEXUS_PROMOTION_TRUSTED_ATTESTOR:-/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs}"
PRODUCTION_BASE="${NEXUS_PROMOTION_PRODUCTION_BASE:-/home/dominguez/telegram-hub-bot}"
COMMAND="${1:-}"
shift || true

if [ "$EUID" -ne 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
  echo "promotion control must run as root" >&2
  exit 77
fi

validate_id() {
  [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$ ]] || {
    echo "invalid promotion transaction id" >&2
    exit 64
  }
}
transaction_dir() { printf '%s/transactions/%s' "$STATE_ROOT" "$1"; }
worker_dir() { printf '%s/worker' "$(transaction_dir "$1")"; }
control_dir() { printf '%s/control' "$(transaction_dir "$1")"; }
state_dir() { printf '%s/state' "$(transaction_dir "$1")"; }
journal_path() { printf '%s/journal.json' "$(state_dir "$1")"; }
authority_path() { printf '%s/authority.json' "$(transaction_dir "$1")"; }
unit_name() { printf 'nexus-release-promotion@%s.service' "$1"; }

root_own() {
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then chown root:root "$@"; fi
}

ensure_state_root() {
  install -d -m 755 "$STATE_ROOT" "$STATE_ROOT/requests" "$STATE_ROOT/transactions"
  root_own "$STATE_ROOT" "$STATE_ROOT/requests" "$STATE_ROOT/transactions"
}

ensure_transaction_dirs() {
  local id="$1" dir
  dir="$(transaction_dir "$id")"
  # 0711 permits traversal for the known transaction ID but prevents the
  # deploy account from enumerating other owner-authorized transactions.
  install -d -m 711 "$dir" "$(control_dir "$id")"
  install -d -m 700 "$(state_dir "$id")"
  root_own "$dir" "$(control_dir "$id")" "$(state_dir "$id")"
  if [ ! -d "$(worker_dir "$id")" ]; then install -d -m 700 "$(worker_dir "$id")"; fi
  chmod 700 "$(worker_dir "$id")"
  if [ "$EUID" -eq 0 ] && [ "${NEXUS_RELEASE_TEST_MODE:-0}" != "1" ]; then
    chown "$WORKER_USER:$WORKER_USER" "$(worker_dir "$id")"
  fi
}

acquire_control_lock() {
  command -v flock >/dev/null 2>&1 || { echo "flock is required for promotion serialization" >&2; exit 1; }
  exec 9>"$STATE_ROOT/.control.lock"
  chmod 600 "$STATE_ROOT/.control.lock"; root_own "$STATE_ROOT/.control.lock"
  flock -x 9
}

validate_authorization_input() {
  local input="$1" mode uid
  [ -n "$input" ] && [ -f "$input" ] && [ ! -L "$input" ] || {
    echo "signed promotion authorization must be a non-symlink regular file" >&2
    exit 64
  }
  mode="$(stat -c '%a' "$input" 2>/dev/null || stat -f '%Lp' "$input")"
  case "$mode" in 400|600) ;; *) echo "signed promotion authorization mode must be 400 or 600" >&2; exit 64 ;; esac
  if [ "$EUID" -eq 0 ] && [ -n "${SUDO_UID:-}" ]; then
    uid="$(stat -c '%u' "$input" 2>/dev/null || stat -f '%u' "$input")"
    [ "$uid" = "$SUDO_UID" ] || { echo "signed promotion authorization owner mismatch" >&2; exit 77; }
  fi
}

read_active_fields() {
  node - "$STATE_ROOT/active.json" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(x.schema!=='nexus.promotion-active.v1'
 ||!/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u.test(x.transactionId||'')
 ||!/^[a-f0-9]{64}$/u.test(x.requestSha256||'')||!/^[a-f0-9]{64}$/u.test(x.envelopeSha256||''))process.exit(1);
process.stdout.write(`${x.transactionId}\t${x.requestSha256}\n`);
NODE
}

journal_status() {
  local id="$1" request_sha="$2" journal
  journal="$(journal_path "$id")"
  [ -f "$journal" ] && [ ! -L "$journal" ] || return 1
  node - "$journal" "$id" "$request_sha" <<'NODE'
const fs=require('fs');const [file,id,digest]=process.argv.slice(2);const x=JSON.parse(fs.readFileSync(file,'utf8'));
if(x.schema!=='nexus.promotion-transaction-journal.v1'||x.transactionId!==id||x.requestSha256!==digest)process.exit(1);
process.stdout.write(String(x.status||''));
NODE
}

journal_terminal() {
  local status
  status="$(journal_status "$1" "$2")" || return 1
  case "$status" in completed|recovered|failed_before_stop) return 0 ;; *) return 1 ;; esac
}

clear_terminal_active() {
  local id request_sha
  [ -f "$STATE_ROOT/active.json" ] || return 0
  IFS=$'\t' read -r id request_sha < <(read_active_fields) || {
    echo "authoritative active promotion state is invalid" >&2
    exit 1
  }
  validate_id "$id"
  if journal_terminal "$id" "$request_sha"; then rm -f "$STATE_ROOT/active.json"; fi
}

write_active() {
  local id="$1" request_sha="$2" envelope_sha="$3" output="$STATE_ROOT/active.json.next"
  rm -f "$output"
  node - "$output" "$id" "$request_sha" "$envelope_sha" <<'NODE'
const fs=require('fs');const [output,transactionId,requestSha256,envelopeSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.promotion-active.v1',transactionId,requestSha256,
 envelopeSha256,activatedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600,flag:'wx'});
NODE
  chmod 600 "$output"; root_own "$output"; mv -f "$output" "$STATE_ROOT/active.json"
}

active_matches() {
  local actual_id actual_sha
  [ -f "$STATE_ROOT/active.json" ] || return 1
  IFS=$'\t' read -r actual_id actual_sha < <(read_active_fields) || return 1
  [ "$actual_id" = "$1" ] && [ "$actual_sha" = "$2" ]
}

write_recovery_control() {
  local id="$1" output
  ensure_transaction_dirs "$id"
  output="$(control_dir "$id")/recover"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$output.next"
  chmod 644 "$output.next"; root_own "$output.next"; mv -f "$output.next" "$output"
}

validate_runtime_target() {
  local runtime="$1" base="$2"
  [ "$base" = "$PRODUCTION_BASE" ] \
    && [[ "$runtime" =~ ^/home/dominguez/[A-Za-z0-9._-]+/releases/[A-Za-z0-9._-]+$ ]] \
    && [ "$runtime" != "$base/releases" ] \
    && [[ "$runtime" == "$base"/releases/* ]] || {
    echo "unsafe production runtime target" >&2
    exit 64
  }
}

harden_release_anchors() {
  local base="$1" worker_uid worker_gid worker_group current_target
  [ -d "$base" ] && [ ! -L "$base" ] && [ "$(readlink -f "$base")" = "$base" ] || {
    echo "production base is not a canonical directory" >&2
    exit 1
  }
  [ -d "$base/releases" ] && [ ! -L "$base/releases" ] \
    && [ "$(readlink -f "$base/releases")" = "$base/releases" ] || {
    echo "production releases directory is not canonical" >&2
    exit 1
  }
  worker_uid="$(id -u "$WORKER_USER")"; worker_gid="$(id -g "$WORKER_USER")"; worker_group="$(id -gn "$WORKER_USER")"
  chown root:"$worker_group" "$base" "$base/releases"
  chmod 1770 "$base"
  chmod 0750 "$base/releases"
  if [ -e "$base/current" ] || [ -L "$base/current" ]; then
    [ -L "$base/current" ] || { echo "production current entry is not a symlink" >&2; exit 1; }
    current_target="$(readlink -f "$base/current")"
    [[ "$current_target" == "$base"/releases/* ]] || { echo "production current target is unsafe" >&2; exit 1; }
    chown -h "$worker_uid:$worker_gid" "$base/current"
  fi
}

case "$COMMAND" in
  version)
    printf '%s\n' "$VERSION"
    ;;
  assert-idle)
    ensure_state_root; acquire_control_lock; clear_terminal_active
    if [ -f "$STATE_ROOT/active.json" ]; then
      read -r active_id _ < <(read_active_fields)
      printf 'promotion transaction active: %s\n' "$active_id" >&2
      exit 73
    fi
    ;;
  prepare-runtime-target)
    runtime="${1:-}"; base="${2:-}"; validate_runtime_target "$runtime" "$base"
    ensure_state_root; acquire_control_lock; clear_terminal_active
    [ ! -f "$STATE_ROOT/active.json" ] || { echo "cannot prepare a runtime while promotion is active" >&2; exit 73; }
    harden_release_anchors "$base"
    worker_uid="$(id -u "$WORKER_USER")"; worker_gid="$(id -g "$WORKER_USER")"
    if [ -e "$runtime" ] || [ -L "$runtime" ]; then
      [ -d "$runtime" ] && [ ! -L "$runtime" ] && [ "$(readlink -f "$runtime")" = "$runtime" ] || {
        echo "existing production runtime target is unsafe" >&2
        exit 1
      }
      identity="$(stat -c '%u:%g:%a' "$runtime")"
      if [ "$identity" = "$worker_uid:$worker_gid:700" ]; then writable=true
      elif [ "$identity" = "0:$worker_gid:550" ]; then writable=false
      else echo "existing production runtime target has an unsafe ownership state" >&2; exit 1
      fi
    else
      install -d -o "$WORKER_USER" -g "$(id -gn "$WORKER_USER")" -m 700 "$runtime"
      writable=true
    fi
    printf '{"ok":true,"runtime":"%s","writable":%s}\n' "$runtime" "$writable"
    ;;
  seal-runtime)
    runtime="${1:-}"; base="${2:-}"; runtime_sha="${3:-}"; artifact_digest="${4:-}"; installed_digest="${5:-}"
    validate_runtime_target "$runtime" "$base"
    [[ "$runtime_sha" =~ ^[a-f0-9]{40}$ \
        && "$artifact_digest" =~ ^[a-f0-9]{64}$ \
        && "$installed_digest" =~ ^[a-f0-9]{64}$ ]] || { echo "unsafe runtime sealing request" >&2; exit 64; }
    [ -f "$TRUSTED_ATTESTOR" ] && [ ! -L "$TRUSTED_ATTESTOR" ] || { echo "trusted runtime attestor is unavailable" >&2; exit 1; }
    ensure_state_root; acquire_control_lock; clear_terminal_active
    [ ! -f "$STATE_ROOT/active.json" ] || { echo "cannot seal a runtime while promotion is active" >&2; exit 73; }
    harden_release_anchors "$base"
    group_id="$(id -g "$WORKER_USER")"
    /usr/bin/node "$TRUSTED_ATTESTOR" seal --root "$runtime" --base "$base" \
      --runtime-sha "$runtime_sha" --artifact-digest "$artifact_digest" \
      --installed-runtime-digest "$installed_digest" --group-id "$group_id"
    ;;
  launch)
    envelope_input="${1:-}"; validate_authorization_input "$envelope_input"
    [ -x "$AUTH_BIN" ] || { echo "promotion authorization verifier is unavailable" >&2; exit 1; }
    [ -f "$OWNER_PUBLIC_KEY" ] && [ ! -L "$OWNER_PUBLIC_KEY" ] || { echo "owner promotion public key is unavailable" >&2; exit 1; }
    verification="$("$AUTH_BIN" verify-request --input "$envelope_input" --public-key "$OWNER_PUBLIC_KEY")" || {
      echo "owner-signed promotion request verification failed" >&2
      exit 77
    }
    IFS=$'\t' read -r transaction_id request_sha envelope_sha < <(printf '%s' "$verification" | node -e '
      let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const x=JSON.parse(b);
      process.stdout.write(`${x.transactionId}\t${x.payloadSha256}\t${x.envelopeSha256}\n`)})')
    validate_id "$transaction_id"; ensure_state_root; acquire_control_lock; clear_terminal_active
    ensure_transaction_dirs "$transaction_id"
    request_envelope="$STATE_ROOT/requests/$transaction_id.envelope.json"
    request_payload="$STATE_ROOT/requests/$transaction_id.json"
    authority="$(authority_path "$transaction_id")"
    if [ -f "$authority" ]; then
      stored="$(node -e 'const x=require(process.argv[1]);process.stdout.write(`${x.requestSha256}\t${x.envelopeSha256}`)' "$authority")"
      [ "$stored" = "$request_sha"$'\t'"$envelope_sha" ] || { echo "promotion transaction authority is immutable" >&2; exit 73; }
    else
      install -m 600 "$envelope_input" "$request_envelope.next"; root_own "$request_envelope.next"
      node - "$envelope_input" "$request_payload.next" <<'NODE'
const fs=require('fs');const e=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
fs.writeFileSync(process.argv[3],`${JSON.stringify(e.payload,null,2)}\n`,{mode:0o644,flag:'wx'});
NODE
      chmod 644 "$request_payload.next"; root_own "$request_payload.next"
      node - "$authority.next" "$transaction_id" "$request_sha" "$envelope_sha" <<'NODE'
const fs=require('fs');const [output,transactionId,requestSha256,envelopeSha256]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({schema:'nexus.promotion-authority.v1',transactionId,requestSha256,envelopeSha256},null,2)}\n`,{mode:0o600,flag:'wx'});
NODE
      chmod 600 "$authority.next"; root_own "$authority.next"
      mv -f "$request_envelope.next" "$request_envelope"; mv -f "$request_payload.next" "$request_payload"; mv -f "$authority.next" "$authority"
    fi
    if journal_terminal "$transaction_id" "$request_sha"; then
      printf '{"ok":true,"transactionId":"%s","state":"terminal","requestSha256":"%s"}\n' "$transaction_id" "$request_sha"
      exit 0
    fi
    if [ -f "$STATE_ROOT/active.json" ]; then
      active_matches "$transaction_id" "$request_sha" || { read -r active_id _ < <(read_active_fields); echo "another promotion transaction is active: $active_id" >&2; exit 73; }
    else
      write_active "$transaction_id" "$request_sha" "$envelope_sha"
    fi
    if ! "$SYSTEMCTL_BIN" is-active --quiet "$(unit_name "$transaction_id")"; then
      "$SYSTEMCTL_BIN" start --no-block "$(unit_name "$transaction_id")"
    fi
    printf '{"ok":true,"transactionId":"%s","state":"launched","requestSha256":"%s"}\n' "$transaction_id" "$request_sha"
    ;;
  status)
    transaction_id="${1:-}"; validate_id "$transaction_id"; ensure_state_root
    authority="$(authority_path "$transaction_id")"
    [ -f "$authority" ] || { echo "promotion transaction is unknown" >&2; exit 1; }
    request_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.requestSha256||"")' "$authority")"
    journal="$(journal_path "$transaction_id")"
    if [ -f "$journal" ]; then cat "$journal"; else
      printf '{"schema":"nexus.promotion-transaction-journal.v1","transactionId":"%s","requestSha256":"%s","phase":"submitted","status":"pending"}\n' "$transaction_id" "$request_sha"
    fi
    ;;
  recover)
    transaction_id="${1:-}"; validate_id "$transaction_id"; ensure_state_root; acquire_control_lock; clear_terminal_active
    [ -f "$STATE_ROOT/active.json" ] || { echo "no promotion transaction is active" >&2; exit 75; }
    IFS=$'\t' read -r active_id request_sha < <(read_active_fields)
    [ "$active_id" = "$transaction_id" ] || { echo "recovery target is not authoritative active transaction" >&2; exit 73; }
    write_recovery_control "$transaction_id"
    if ! "$SYSTEMCTL_BIN" is-active --quiet "$(unit_name "$transaction_id")"; then "$SYSTEMCTL_BIN" start --no-block "$(unit_name "$transaction_id")"; fi
    printf '{"ok":true,"transactionId":"%s","decision":"recover"}\n' "$transaction_id"
    ;;
  recover-all)
    ensure_state_root; acquire_control_lock; clear_terminal_active
    [ -f "$STATE_ROOT/active.json" ] || exit 0
    IFS=$'\t' read -r transaction_id request_sha < <(read_active_fields); validate_id "$transaction_id"
    active_matches "$transaction_id" "$request_sha" || { echo "active promotion identity changed during recovery" >&2; exit 1; }
    status="$(journal_status "$transaction_id" "$request_sha" 2>/dev/null || true)"
    # Candidate availability outranks network escrow at boot. The pending
    # exact escrow remains active and blocks another release until retried.
    [ "$status" != escrow_pending ] || exit 0
    write_recovery_control "$transaction_id"
    "$SYSTEMCTL_BIN" reset-failed "$(unit_name "$transaction_id")" >/dev/null 2>&1 || true
    "$SYSTEMCTL_BIN" start "$(unit_name "$transaction_id")"
    journal_terminal "$transaction_id" "$request_sha" || { echo "boot promotion recovery did not reach a terminal state" >&2; exit 1; }
    clear_terminal_active
    ;;
  fetch)
    transaction_id="${1:-}"; artifact="${2:-}"; validate_id "$transaction_id"; ensure_state_root
    authority="$(authority_path "$transaction_id")"; [ -f "$authority" ] || { echo "promotion transaction is unknown" >&2; exit 1; }
    request_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.requestSha256||"")' "$authority")"
    [ "$(journal_status "$transaction_id" "$request_sha" 2>/dev/null || true)" = completed ] || {
      echo "promotion artifacts are unavailable before authoritative completion" >&2
      exit 75
    }
    case "$artifact" in
      result) file="$(state_dir "$transaction_id")/result.env" ;;
      escrow) file="$(state_dir "$transaction_id")/escrow-confirmation.json" ;;
      *) echo "unknown promotion transaction artifact" >&2; exit 64 ;;
    esac
    [ -f "$file" ] && [ ! -L "$file" ] || { echo "promotion transaction artifact is unavailable" >&2; exit 75; }
    cat "$file"
    ;;
  *)
    echo "Usage: nexus-release-promotion-control <version|assert-idle|prepare-runtime-target|seal-runtime|launch|status|recover|recover-all|fetch>" >&2
    exit 64
    ;;
esac

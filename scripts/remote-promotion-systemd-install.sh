#!/usr/bin/env bash
# One-time, owner-reviewed server bootstrap. A release candidate cannot replace
# this root-owned control plane. The owner public key authorizes requests while
# its private counterpart remains off the server.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[ "$EUID" -eq 0 ] || { echo "promotion systemd bootstrap must run as root" >&2; exit 77; }
SOURCE_ROOT="${1:?checked-out source root is required}"
OWNER_PUBLIC_KEY_SOURCE="${2:-${NEXUS_PROMOTION_OWNER_PUBLIC_KEY_SOURCE:-}}"
SERVICE_USER="${NEXUS_PROMOTION_SERVICE_USER:-nexus-release}"
SERVICE_GROUP="${NEXUS_PROMOTION_SERVICE_GROUP:-nexus-release}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
SERVER_PROVENANCE_PRIVATE_KEY="${NEXUS_SERVER_PROVENANCE_PRIVATE_KEY:-/etc/nexus-release/serverdominguez-provenance-private-key.pem}"
SERVER_PROVENANCE_PUBLIC_KEY="${NEXUS_SERVER_PROVENANCE_PUBLIC_KEY:-/etc/nexus-release/serverdominguez-provenance-public-key.pem}"

for command in cat chmod chown cut dirname flock getent groupadd id install mktemp mv \
  node openssl realpath rm runuser sha256sum stat systemctl systemd-tmpfiles \
  timeout useradd visudo; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required for promotion bootstrap" >&2; exit 1; }
done

fsync_path() {
  node - "$1" <<'NODE'
const fs=require('fs');
const descriptor=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

durable_remove() {
  local target="$1"
  rm -f -- "$target"
  fsync_path "$(dirname -- "$target")"
}

install_file_atomically() {
  local source="$1" target="$2" owner="$3" group="$4" mode="$5"
  local parent temporary
  parent="$(dirname -- "$target")"
  [ -d "$parent" ] && [ ! -L "$parent" ] || {
    echo "promotion bootstrap target parent is unsafe: $parent" >&2
    return 1
  }
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    echo "promotion bootstrap target is unsafe: $target" >&2
    return 1
  fi
  temporary="$(mktemp -p "$parent" ".nexus-release-bootstrap.XXXXXX")"
  install -o "$owner" -g "$group" -m "$mode" -- "$source" "$temporary"
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$target"
  fsync_path "$parent"
}

publish_text_atomically() {
  local target="$1" mode="$2" parent temporary
  parent="$(dirname -- "$target")"
  temporary="$(mktemp -p "$parent" ".nexus-release-bootstrap.XXXXXX")"
  cat >"$temporary"
  chown root:root "$temporary"
  chmod "$mode" "$temporary"
  fsync_path "$temporary"
  mv -fT -- "$temporary" "$target"
  fsync_path "$parent"
}

validate_root_trusted_path() {
  local candidate="$1" label="$2" expected_type="$3" current owner mode
  [[ "$candidate" == /* && "$candidate" != / && ! -L "$candidate" ]] || {
    echo "$label must be an absolute non-symlink path" >&2
    exit 77
  }
  case "$expected_type" in
    directory) [ -d "$candidate" ] || { echo "$label must be a directory" >&2; exit 77; } ;;
    file) [ -f "$candidate" ] || { echo "$label must be a regular file" >&2; exit 77; } ;;
    *) echo "promotion bootstrap path validator misuse" >&2; exit 70 ;;
  esac
  current="$(realpath -e -- "$candidate")"
  [ "$current" = "$candidate" ] || {
    echo "$label must not traverse symlinks" >&2
    exit 77
  }
  while :; do
    owner="$(stat -c '%U:%G' -- "$current")"
    mode="$(stat -c '%a' -- "$current")"
    [ "$owner" = root:root ] || {
      echo "$label path component is not root-owned: $current" >&2
      exit 77
    }
    (( (8#$mode & 0022) == 0 )) || {
      echo "$label path component is group/world writable: $current" >&2
      exit 77
    }
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

[ -n "$OWNER_PUBLIC_KEY_SOURCE" ] || { echo "owner promotion public key path is required" >&2; exit 64; }
validate_root_trusted_path "$SOURCE_ROOT" "promotion bootstrap source root" directory
validate_root_trusted_path "$OWNER_PUBLIC_KEY_SOURCE" "owner promotion public key" file
id "$WORKER_USER" >/dev/null 2>&1 || { echo "promotion worker user is missing" >&2; exit 1; }
[ "$WORKER_USER" = dominguez ] || { echo "promotion worker must be the dominguez application identity" >&2; exit 1; }

for required in \
  scripts/application-dr-systemd-install.sh \
  scripts/promotion-authorization.mjs \
  scripts/trusted-release-runtime-attestation.mjs \
  scripts/remote-promotion-control.sh \
  scripts/remote-promotion-worker-control.sh \
  scripts/remote-promotion-transaction.sh \
  ops/sonarqube/nexus-release-sonar-lock.conf \
  scripts/systemd/nexus-release-promotion@.service \
  scripts/systemd/nexus-release-promotion-recovery.service; do
  validate_root_trusted_path \
    "$SOURCE_ROOT/$required" \
    "promotion bootstrap source ($required)" \
    file
done

node -e 'const {createPublicKey}=require("crypto");const fs=require("fs");createPublicKey(fs.readFileSync(process.argv[1]));' \
  "$OWNER_PUBLIC_KEY_SOURCE"

BOOTSTRAP_JOURNAL="/var/lib/nexus-release-promotion/bootstrap-in-progress.v1"
SUDOERS_TARGET="/etc/sudoers.d/nexus-release-promotion"
install -d -o root -g root -m 755 \
  /usr/local/libexec /usr/local/sbin /etc/nexus-release /etc/sudoers.d \
  /var/lib/nexus-release-promotion
fsync_path /usr/local/libexec
fsync_path /usr/local/sbin
fsync_path /etc/nexus-release
fsync_path /etc/sudoers.d
fsync_path /var/lib/nexus-release-promotion
fsync_path /var/lib
if [ -L "$BOOTSTRAP_JOURNAL" ]; then
  echo "promotion bootstrap journal is a symlink" >&2
  exit 1
elif [ -e "$BOOTSTRAP_JOURNAL" ]; then
  [ -f "$BOOTSTRAP_JOURNAL" ] \
    && [ "$(stat -c '%U:%G:%a' "$BOOTSTRAP_JOURNAL")" = root:root:600 ] || {
    echo "promotion bootstrap journal is unsafe" >&2
    exit 1
  }
fi
if [ ! -e "$BOOTSTRAP_JOURNAL" ] \
    && [ -x /usr/local/sbin/nexus-release-promotion-control ]; then
  /usr/local/sbin/nexus-release-promotion-control assert-idle
fi
exec 8>"/var/lib/nexus-release-promotion/.control.lock"
chmod 0600 /var/lib/nexus-release-promotion/.control.lock
flock -x 8
if [ -f /var/lib/nexus-release-promotion/active.json ]; then
  echo "promotion bootstrap requires an idle control plane" >&2
  exit 73
fi
if [ ! -e "$BOOTSTRAP_JOURNAL" ]; then
  printf '%s\n' \
    '{"schema":"nexus.release-promotion-bootstrap-journal.v1","status":"in_progress"}' \
    | publish_text_atomically "$BOOTSTRAP_JOURNAL" 600
fi
# Commit the journal-aware broker before DR or any other compatibility peer.
# New release invocations now fail closed even if SSH disappears during the
# remaining root-owned replacements.
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-promotion-control.sh" \
  /usr/local/sbin/nexus-release-promotion-control root root 755
if [ -L "$SUDOERS_TARGET" ]; then
  echo "promotion sudoers target is a symlink" >&2
  exit 1
elif [ -e "$SUDOERS_TARGET" ]; then
  [ -f "$SUDOERS_TARGET" ] || {
    echo "promotion sudoers target is unsafe" >&2
    exit 1
  }
  durable_remove "$SUDOERS_TARGET"
fi

# Promotion and recovery are one compatibility boundary. Install the exact
# application-DR implementation from this same reviewed source before the
# promotion broker so an older root-owned backup interface cannot strand a
# newly installed worker at failed_before_stop. This deliberately leaves the
# root-only provider configuration and timer activation for the documented
# owner-approved provisioning step.
APPLICATION_DR_INSTALL_RESULT="$(
  NEXUS_DR_INSTALL_DRILL_USER=nexus-drill \
    "$SOURCE_ROOT/scripts/application-dr-systemd-install.sh" "$SOURCE_ROOT"
)"
node -e '
const value=JSON.parse(process.argv[1]);
const keys=Object.keys(value).sort().join(",");
if(keys!=="configurationWritten,drillUser,installedAssets,ok,schema,timerEnabled"
 ||value.ok!==true||value.schema!=="nexus.application-dr-install.v1"
 ||!Number.isSafeInteger(value.installedAssets)||value.installedAssets<1
 ||value.drillUser!=="nexus-drill"||typeof value.timerEnabled!=="boolean"
 ||value.configurationWritten!==false)process.exit(1);' \
  "$APPLICATION_DR_INSTALL_RESULT"

[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || {
  echo "promotion service user name is invalid" >&2
  exit 1
}
[[ "$SERVICE_GROUP" =~ ^[a-z_][a-z0-9_-]*$ ]] || {
  echo "promotion service group name is invalid" >&2
  exit 1
}

service_user_exists=false
if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  service_user_exists=true
fi
service_group_exists=false
if getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  service_group_exists=true
fi
if [ "$service_user_exists" = true ] && [ "$service_group_exists" = false ]; then
  echo "promotion service group is missing for the existing service identity" >&2
  exit 1
fi
if [ "$service_group_exists" = false ]; then
  groupadd --system "$SERVICE_GROUP"
fi

service_group_record="$(getent group "$SERVICE_GROUP")"
[[ -n "$service_group_record" && "$service_group_record" != *$'\n'* ]] || {
  echo "promotion service group lookup is ambiguous" >&2
  exit 1
}
IFS=: read -r service_group_name _ service_group_gid service_group_members service_group_extra \
  <<< "$service_group_record"
[ "$service_group_name" = "$SERVICE_GROUP" ] \
  && [[ "$service_group_gid" =~ ^[0-9]+$ ]] \
  && [ "$service_group_gid" -gt 0 ] \
  && [ -z "$service_group_extra" ] || {
  echo "promotion service group identity is invalid" >&2
  exit 1
}

IFS=',' read -r -a service_group_member_list <<< "$service_group_members"
for service_group_member in "${service_group_member_list[@]}"; do
  [ -z "$service_group_member" ] && continue
  [ "$service_group_member" = "$SERVICE_USER" ] || {
    echo "promotion service group is shared by $service_group_member" >&2
    exit 1
  }
done
while IFS=: read -r candidate_account _ _ candidate_gid _; do
  if [ "$candidate_account" != "$SERVICE_USER" ] \
    && [ "$candidate_gid" = "$service_group_gid" ]; then
    echo "promotion service group is shared by $candidate_account" >&2
    exit 1
  fi
done < <(getent passwd)

if [ "$service_user_exists" = false ]; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

service_passwd_record="$(getent passwd "$SERVICE_USER")"
[[ -n "$service_passwd_record" && "$service_passwd_record" != *$'\n'* ]] || {
  echo "promotion service account lookup is ambiguous" >&2
  exit 1
}
IFS=: read -r service_account _ service_uid service_gid _ service_home service_shell service_passwd_extra \
  <<< "$service_passwd_record"
[ "$service_account" = "$SERVICE_USER" ] \
  && [[ "$service_uid" =~ ^[0-9]+$ ]] \
  && [ "$service_uid" -gt 0 ] \
  && [ "$(id -u "$SERVICE_USER")" = "$service_uid" ] \
  && [ -z "$service_passwd_extra" ] || {
  echo "promotion service UID must be nonzero and unambiguous" >&2
  exit 1
}
[ "$service_gid" = "$service_group_gid" ] \
  && [ "$(id -g "$SERVICE_USER")" = "$service_group_gid" ] \
  && [ "$(id -gn "$SERVICE_USER")" = "$SERVICE_GROUP" ] || {
  echo "promotion service identity must use the exact primary service group" >&2
  exit 1
}
[ "$service_home" = /nonexistent ] || {
  echo "promotion service identity home must be /nonexistent" >&2
  exit 1
}
case "$service_shell" in
  /usr/sbin/nologin|/sbin/nologin) ;;
  *) echo "promotion service identity must use nologin" >&2; exit 1 ;;
esac
[ "$(id -G "$SERVICE_USER")" = "$service_group_gid" ] \
  && [ "$(id -nG "$SERVICE_USER")" = "$SERVICE_GROUP" ] || {
  echo "promotion service identity must not belong to supplementary groups" >&2
  exit 1
}

install -d -o root -g root -m 755 /usr/local/libexec /usr/local/sbin /etc/nexus-release
install -d -o root -g root -m 755 /etc/tmpfiles.d
install_file_atomically \
  "$SOURCE_ROOT/ops/sonarqube/nexus-release-sonar-lock.conf" \
  /etc/tmpfiles.d/nexus-release-sonar-lock.conf root root 644
systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf
[ -f /run/lock/nexus-release-sonar.lock ] && [ ! -L /run/lock/nexus-release-sonar.lock ] || {
  echo "shared release/Sonar mutex was not materialized as a regular file" >&2
  exit 1
}
[ "$(stat -c '%U:%G:%a' /run/lock/nexus-release-sonar.lock)" = root:dominguez:660 ] || {
  echo "shared release/Sonar mutex ownership or mode is invalid" >&2
  exit 1
}
install_file_atomically \
  "$SOURCE_ROOT/scripts/promotion-authorization.mjs" \
  /usr/local/libexec/nexus-promotion-authorization.mjs root root 755
install_file_atomically \
  "$SOURCE_ROOT/scripts/trusted-release-runtime-attestation.mjs" \
  /usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-promotion-transaction.sh" \
  /usr/local/libexec/nexus-release-promotion-transaction root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-promotion-worker-control.sh" \
  /usr/local/sbin/nexus-release-promotion-worker-control root root 755
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-promotion-control.sh" \
  /usr/local/sbin/nexus-release-promotion-control root root 755
install_file_atomically "$OWNER_PUBLIC_KEY_SOURCE" \
  /etc/nexus-release/owner-promotion-public-key.pem root root 644
if [ ! -e "$SERVER_PROVENANCE_PRIVATE_KEY" ]; then
  provenance_tmp="$(mktemp)"
  openssl genpkey -algorithm ED25519 -out "$provenance_tmp"
  install_file_atomically "$provenance_tmp" \
    "$SERVER_PROVENANCE_PRIVATE_KEY" root root 600
  rm -f "$provenance_tmp"
fi
[ -f "$SERVER_PROVENANCE_PRIVATE_KEY" ] && [ ! -L "$SERVER_PROVENANCE_PRIVATE_KEY" ] \
  && [ "$(stat -c '%U:%G:%a' "$SERVER_PROVENANCE_PRIVATE_KEY")" = root:root:600 ] || {
  echo "ServerDominguez provenance private key ownership or mode is unsafe" >&2
  exit 1
}
provenance_public_tmp="$(mktemp)"
openssl pkey -in "$SERVER_PROVENANCE_PRIVATE_KEY" -pubout -out "$provenance_public_tmp"
install_file_atomically "$provenance_public_tmp" \
  "$SERVER_PROVENANCE_PUBLIC_KEY" root root 644
rm -f "$provenance_public_tmp"
node -e 'const {createPublicKey}=require("crypto");const fs=require("fs");createPublicKey(fs.readFileSync(process.argv[1]));' \
  "$SERVER_PROVENANCE_PUBLIC_KEY"
install_file_atomically \
  "$SOURCE_ROOT/scripts/systemd/nexus-release-promotion@.service" \
  /etc/systemd/system/nexus-release-promotion@.service root root 644
install_file_atomically \
  "$SOURCE_ROOT/scripts/systemd/nexus-release-promotion-recovery.service" \
  /etc/systemd/system/nexus-release-promotion-recovery.service root root 644
for pm2_unit in pm2-dominguez.service pm2-root.service; do
  pm2_dropin="/etc/systemd/system/${pm2_unit}.d"
  install -d -o root -g root -m 755 "$pm2_dropin"
  publish_text_atomically "$pm2_dropin/nexus-release-recovery.conf" 644 <<'EOF'
[Unit]
Requires=nexus-release-promotion-recovery.service
After=nexus-release-promotion-recovery.service
EOF
done
install -d -o root -g "$SERVICE_GROUP" -m 755 \
  /var/lib/nexus-release-promotion \
  /var/lib/nexus-release-promotion/requests \
  /var/lib/nexus-release-promotion/transactions

sudoers_tmp="$(mktemp)"
cleanup() { rm -f "$sudoers_tmp"; }
trap cleanup EXIT
{
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control version\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control assert-idle\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control prepare-runtime-target *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control seal-runtime *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control launch *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control status *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control ensure-started *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control recover *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control retry-escrow *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control fetch *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-worker-control run *\n' "$SERVICE_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-worker-control recover *\n' "$SERVICE_USER"
} > "$sudoers_tmp"
chmod 440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null
install_file_atomically "$sudoers_tmp" "$SUDOERS_TARGET" root root 440

systemctl daemon-reload
systemctl enable nexus-release-promotion-recovery.service
durable_remove "$BOOTSTRAP_JOURNAL"
provenance_public_sha256="$(sha256sum "$SERVER_PROVENANCE_PUBLIC_KEY" | cut -d' ' -f1)"
printf '{"ok":true,"controlVersion":"nexus-release-promotion-control.v2","applicationDrAssetsInstalled":true,"applicationDrConfigurationWritten":false,"serviceUser":"%s","workerUser":"%s","serverProvenancePublicKey":"%s","serverProvenancePublicKeySha256":"%s"}\n' \
  "$SERVICE_USER" "$WORKER_USER" "$SERVER_PROVENANCE_PUBLIC_KEY" "$provenance_public_sha256"

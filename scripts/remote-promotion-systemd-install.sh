#!/usr/bin/env bash
# One-time, owner-reviewed server bootstrap. A release candidate cannot replace
# this root-owned control plane. The owner public key authorizes requests while
# its private counterpart remains off the server.
set -euo pipefail
umask 077

[ "$EUID" -eq 0 ] || { echo "promotion systemd bootstrap must run as root" >&2; exit 77; }
SOURCE_ROOT="${1:?checked-out source root is required}"
OWNER_PUBLIC_KEY_SOURCE="${2:-${NEXUS_PROMOTION_OWNER_PUBLIC_KEY_SOURCE:-}}"
SERVICE_USER="${NEXUS_PROMOTION_SERVICE_USER:-nexus-release}"
SERVICE_GROUP="${NEXUS_PROMOTION_SERVICE_GROUP:-nexus-release}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
SERVER_PROVENANCE_PRIVATE_KEY="${NEXUS_SERVER_PROVENANCE_PRIVATE_KEY:-/etc/nexus-release/serverdominguez-provenance-private-key.pem}"
SERVER_PROVENANCE_PUBLIC_KEY="${NEXUS_SERVER_PROVENANCE_PUBLIC_KEY:-/etc/nexus-release/serverdominguez-provenance-public-key.pem}"

[ -n "$OWNER_PUBLIC_KEY_SOURCE" ] || { echo "owner promotion public key path is required" >&2; exit 64; }
[ -f "$OWNER_PUBLIC_KEY_SOURCE" ] && [ ! -L "$OWNER_PUBLIC_KEY_SOURCE" ] || {
  echo "owner promotion public key must be a non-symlink regular file" >&2
  exit 64
}
id "$WORKER_USER" >/dev/null 2>&1 || { echo "promotion worker user is missing" >&2; exit 1; }
[ "$WORKER_USER" = dominguez ] || { echo "promotion worker must be the dominguez application identity" >&2; exit 1; }
for command in flock timeout runuser useradd groupadd getent visudo node openssl sha256sum systemd-tmpfiles stat; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required for promotion bootstrap" >&2; exit 1; }
done

for required in \
  scripts/promotion-authorization.mjs \
  scripts/trusted-release-runtime-attestation.mjs \
  scripts/remote-promotion-control.sh \
  scripts/remote-promotion-worker-control.sh \
  scripts/remote-promotion-transaction.sh \
  ops/sonarqube/nexus-release-sonar-lock.conf \
  scripts/systemd/nexus-release-promotion@.service \
  scripts/systemd/nexus-release-promotion-recovery.service; do
  [ -f "$SOURCE_ROOT/$required" ] && [ ! -L "$SOURCE_ROOT/$required" ] || {
    echo "promotion bootstrap source is missing: $required" >&2
    exit 1
  }
done

node -e 'const {createPublicKey}=require("crypto");const fs=require("fs");createPublicKey(fs.readFileSync(process.argv[1]));' \
  "$OWNER_PUBLIC_KEY_SOURCE"

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
service_shell="$(getent passwd "$SERVICE_USER" | awk -F: '{print $7}')"
case "$service_shell" in /usr/sbin/nologin|/sbin/nologin|/bin/false) ;; *) echo "promotion service identity must be noninteractive" >&2; exit 1 ;; esac

install -d -o root -g root -m 755 /usr/local/libexec /usr/local/sbin /etc/nexus-release
install -d -o root -g root -m 755 /etc/tmpfiles.d
install -o root -g root -m 644 \
  "$SOURCE_ROOT/ops/sonarqube/nexus-release-sonar-lock.conf" \
  /etc/tmpfiles.d/nexus-release-sonar-lock.conf
systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf
[ -f /run/lock/nexus-release-sonar.lock ] && [ ! -L /run/lock/nexus-release-sonar.lock ] || {
  echo "shared release/Sonar mutex was not materialized as a regular file" >&2
  exit 1
}
[ "$(stat -c '%U:%G:%a' /run/lock/nexus-release-sonar.lock)" = root:dominguez:660 ] || {
  echo "shared release/Sonar mutex ownership or mode is invalid" >&2
  exit 1
}
install -o root -g root -m 755 \
  "$SOURCE_ROOT/scripts/promotion-authorization.mjs" \
  /usr/local/libexec/nexus-promotion-authorization.mjs
install -o root -g root -m 700 \
  "$SOURCE_ROOT/scripts/trusted-release-runtime-attestation.mjs" \
  /usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs
install -o root -g root -m 700 \
  "$SOURCE_ROOT/scripts/remote-promotion-transaction.sh" \
  /usr/local/libexec/nexus-release-promotion-transaction
install -o root -g root -m 755 \
  "$SOURCE_ROOT/scripts/remote-promotion-worker-control.sh" \
  /usr/local/sbin/nexus-release-promotion-worker-control
install -o root -g root -m 755 \
  "$SOURCE_ROOT/scripts/remote-promotion-control.sh" \
  /usr/local/sbin/nexus-release-promotion-control
install -o root -g root -m 644 "$OWNER_PUBLIC_KEY_SOURCE" /etc/nexus-release/owner-promotion-public-key.pem
if [ ! -e "$SERVER_PROVENANCE_PRIVATE_KEY" ]; then
  provenance_tmp="$(mktemp)"
  openssl genpkey -algorithm ED25519 -out "$provenance_tmp"
  install -o root -g root -m 600 "$provenance_tmp" "$SERVER_PROVENANCE_PRIVATE_KEY"
  rm -f "$provenance_tmp"
fi
[ -f "$SERVER_PROVENANCE_PRIVATE_KEY" ] && [ ! -L "$SERVER_PROVENANCE_PRIVATE_KEY" ] \
  && [ "$(stat -c '%U:%G:%a' "$SERVER_PROVENANCE_PRIVATE_KEY")" = root:root:600 ] || {
  echo "ServerDominguez provenance private key ownership or mode is unsafe" >&2
  exit 1
}
provenance_public_tmp="$(mktemp)"
openssl pkey -in "$SERVER_PROVENANCE_PRIVATE_KEY" -pubout -out "$provenance_public_tmp"
install -o root -g root -m 644 "$provenance_public_tmp" "$SERVER_PROVENANCE_PUBLIC_KEY"
rm -f "$provenance_public_tmp"
node -e 'const {createPublicKey}=require("crypto");const fs=require("fs");createPublicKey(fs.readFileSync(process.argv[1]));' \
  "$SERVER_PROVENANCE_PUBLIC_KEY"
install -o root -g root -m 644 \
  "$SOURCE_ROOT/scripts/systemd/nexus-release-promotion@.service" \
  /etc/systemd/system/nexus-release-promotion@.service
install -o root -g root -m 644 \
  "$SOURCE_ROOT/scripts/systemd/nexus-release-promotion-recovery.service" \
  /etc/systemd/system/nexus-release-promotion-recovery.service
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
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control recover *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control retry-escrow *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control fetch *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-worker-control run *\n' "$SERVICE_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-worker-control recover *\n' "$SERVICE_USER"
} > "$sudoers_tmp"
chmod 440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null
install -o root -g root -m 440 "$sudoers_tmp" /etc/sudoers.d/nexus-release-promotion

systemctl daemon-reload
systemctl enable nexus-release-promotion-recovery.service
provenance_public_sha256="$(sha256sum "$SERVER_PROVENANCE_PUBLIC_KEY" | cut -d' ' -f1)"
printf '{"ok":true,"controlVersion":"nexus-release-promotion-control.v2","serviceUser":"%s","workerUser":"%s","serverProvenancePublicKey":"%s","serverProvenancePublicKeySha256":"%s"}\n' \
  "$SERVICE_USER" "$WORKER_USER" "$SERVER_PROVENANCE_PUBLIC_KEY" "$provenance_public_sha256"

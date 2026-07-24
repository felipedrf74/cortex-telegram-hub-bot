#!/usr/bin/env bash
# Install and measure one offline runtime inside an isolated rollback-drill VM.
# The guest never downloads dependencies. The provision receipt remains
# immutable; a separate host-side sealer publishes final drill readiness.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

VERSION="nexus-rollback-drill-vm-runtime-control.v1"
STATE_ROOT="/var/lib/nexus-rollback-drill-vm/runtime"
PROVISION_PARENT="/var/lib/nexus-rollback-drill-vm/provision-receipts"
BUNDLE_PARENT="/var/lib/nexus-rollback-drill-vm/toolchain-bundles"
NODE_PARENT="/opt/nexus-rollback-drill-vm/runtime"
NODE_TARGET="$NODE_PARENT/node-v22.23.1-linux-x64"
PM2_TARGET="$NODE_PARENT/pm2-6.0.14"
PM2_HEALTH_PARENT="/run/nexus-rollback-drill-vm-pm2-health"
MANIFEST_HELPER="/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest"
CONTROL_BIN="/usr/local/sbin/nexus-release-promotion-control"
RUNTIME_RECOVERY_UNIT="/etc/systemd/system/nexus-rollback-drill-vm-runtime-recovery.service"
SSH_HOST_PRIVATE="/etc/ssh/ssh_host_ed25519_key"
SSH_HOST_PUBLIC="/etc/ssh/ssh_host_ed25519_key.pub"
MEASUREMENT_NAMESPACE="nexus-rollback-drill-vm-runtime-measurement"
COMMAND="${1:-}"
shift || true

die() {
  echo "rollback drill VM runtime control: $*" >&2
  exit 1
}

fsync_path() {
  python3 - "$1" <<'PY'
import os,sys
descriptor=os.open(sys.argv[1],os.O_RDONLY)
try:os.fsync(descriptor)
finally:os.close(descriptor)
PY
}

durable_remove() {
  local target="$1"
  rm -f -- "$target"
  fsync_path "$(dirname -- "$target")"
}

evidence_pair_state() {
  local expected_group="${3:-dominguez}" expected_uid="${4:-0}"
  python3 - "$1" "$2" "$expected_group" "$expected_uid" <<'PY'
import grp,os,stat,sys
data_path,signature_path,expected_group,expected_uid_text=sys.argv[1:]
expected_identity=(int(expected_uid_text),grp.getgrnam(expected_group).gr_gid)
limits={data_path:524288,signature_path:65536}
observed={}
for path in (data_path,signature_path):
 try:value=os.lstat(path)
 except FileNotFoundError:continue
 if (
  not stat.S_ISREG(value.st_mode) or value.st_nlink!=1
  or value.st_size<=0 or value.st_size>limits[path]
 ):
  raise SystemExit("runtime evidence partial is not one bounded regular file")
 owner=(value.st_uid,value.st_gid)
 mode=stat.S_IMODE(value.st_mode)
 observed[path]=(owner,mode)
if not observed:
 print("absent")
elif len(observed)==2 and all(
 owner==expected_identity and mode==0o640
 for owner,mode in observed.values()
):
 print("complete")
else:
 for owner,mode in observed.values():
  if owner[0]!=expected_identity[0] or mode not in {0o600,0o640}:
   raise SystemExit("runtime evidence partial has an unsafe intermediate identity")
 print("clear")
PY
}

usage() {
  cat >&2 <<'EOF'
Usage:
  nexus-rollback-drill-vm-runtime-control version
  nexus-rollback-drill-vm-runtime-control recover-install
  nexus-rollback-drill-vm-runtime-control stage-provision \
    <untrusted-provision-receipt> <provision-sha256>
  nexus-rollback-drill-vm-runtime-control stage-bundle \
    <untrusted-bundle-root> <manifest-sha256> <owner-public-key-sha256>
  nexus-rollback-drill-vm-runtime-control inspect-python \
    <provision-receipt> <provision-sha256> <guest-1|guest-2|guest-3>
  nexus-rollback-drill-vm-runtime-control install \
    <bundle-root> <provision-receipt> <provision-sha256> \
    <guest-1|guest-2|guest-3> <manifest-sha256> <owner-public-key-sha256>
  nexus-rollback-drill-vm-runtime-control measure \
    <bundle-root> <provision-receipt> <provision-sha256> \
    <guest-1|guest-2|guest-3> <manifest-sha256> <owner-public-key-sha256> \
    <64-hex-host-challenge>
EOF
  exit 64
}

if [ "$COMMAND" = version ]; then
  [ "$#" -eq 0 ] || usage
  printf '%s\n' "$VERSION"
  exit 0
fi
case "$COMMAND" in
  recover-install)
    [ "$#" -eq 0 ] || usage
    ;;
  stage-provision)
    [ "$#" -eq 2 ] || usage
    UNTRUSTED_PROVISION_RECEIPT="$1"
    EXPECTED_PROVISION_SHA256="$2"
    ;;
  stage-bundle)
    [ "$#" -eq 3 ] || usage
    UNTRUSTED_BUNDLE_ROOT="$1"
    EXPECTED_MANIFEST_SHA256="$2"
    EXPECTED_OWNER_PUBLIC_KEY_SHA256="$3"
    ;;
  inspect-python)
    [ "$#" -eq 3 ] || usage
    BUNDLE_ROOT=""
    PROVISION_RECEIPT="$1"
    EXPECTED_PROVISION_SHA256="$2"
    GUEST="$3"
    EXPECTED_MANIFEST_SHA256=""
    EXPECTED_OWNER_PUBLIC_KEY_SHA256=""
    ;;
  install)
    [ "$#" -eq 6 ] || usage
    BUNDLE_ROOT="$1"
    PROVISION_RECEIPT="$2"
    EXPECTED_PROVISION_SHA256="$3"
    GUEST="$4"
    EXPECTED_MANIFEST_SHA256="$5"
    EXPECTED_OWNER_PUBLIC_KEY_SHA256="$6"
    ;;
  measure)
    [ "$#" -eq 7 ] || usage
    BUNDLE_ROOT="$1"
    PROVISION_RECEIPT="$2"
    EXPECTED_PROVISION_SHA256="$3"
    GUEST="$4"
    EXPECTED_MANIFEST_SHA256="$5"
    EXPECTED_OWNER_PUBLIC_KEY_SHA256="$6"
    MEASUREMENT_CHALLENGE="$7"
    [[ "$MEASUREMENT_CHALLENGE" =~ ^[0-9a-f]{64}$ ]] \
      || die "measurement challenge must be exactly 64 lowercase hexadecimal characters"
    ;;
  *) usage ;;
esac

[ "$EUID" -eq 0 ] || die "must run as root inside the isolated guest"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] \
  || die "guest runtime requires Linux x86-64"

for command in awk bash chmod chown cp cut date dirname dpkg-query env find flock id \
  install ln mktemp mv openssl python3 readlink realpath rm rmdir runuser \
  sha256sum ssh-keygen stat systemctl timeout tr uname; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
[ -f /etc/os-release ] && [ ! -L /etc/os-release ] \
  || die "guest OS identity is missing or unsafe"
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] \
  || die "guest OS must be Ubuntu 24.04"
[ -f "$MANIFEST_HELPER" ] && [ ! -L "$MANIFEST_HELPER" ] \
  && [ "$(stat -c '%U:%G:%a:%h' "$MANIFEST_HELPER")" = root:root:755:1 ] \
  || die "runtime manifest helper is not the root-owned installed asset"

case "$COMMAND" in
  stage-provision)
    [[ "$EXPECTED_PROVISION_SHA256" =~ ^[0-9a-f]{64}$ ]] \
      || die "expected provision receipt digest is invalid"
    install -d -o root -g root -m 0700 "$PROVISION_PARENT"
    install -d -o root -g root -m 0700 /run/nexus-rollback-drill-vm
    exec 8>/run/nexus-rollback-drill-vm/runtime-stage.lock
    chmod 0600 /run/nexus-rollback-drill-vm/runtime-stage.lock
    flock -x 8
    python3 "$MANIFEST_HELPER" stage-provision \
      --source "$UNTRUSTED_PROVISION_RECEIPT" \
      --target-parent "$PROVISION_PARENT" \
      --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256"
    exit 0
    ;;
  stage-bundle)
    [[ "$EXPECTED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] \
      || die "expected manifest digest is invalid"
    [[ "$EXPECTED_OWNER_PUBLIC_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]] \
      || die "expected owner public-key digest is invalid"
    install -d -o root -g root -m 0700 "$BUNDLE_PARENT"
    install -d -o root -g root -m 0700 /run/nexus-rollback-drill-vm
    exec 8>/run/nexus-rollback-drill-vm/runtime-stage.lock
    chmod 0600 /run/nexus-rollback-drill-vm/runtime-stage.lock
    flock -x 8
    python3 "$MANIFEST_HELPER" stage-bundle \
      --source-root "$UNTRUSTED_BUNDLE_ROOT" \
      --target-parent "$BUNDLE_PARENT" \
      --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
      --expected-public-key-sha256 "$EXPECTED_OWNER_PUBLIC_KEY_SHA256"
    exit 0
    ;;
esac

validate_root_owned_chain() {
  local candidate="$1" label="$2" expected_kind="$3" current mode resolved
  case "$candidate" in /*) ;; *) die "$label must use an absolute path" ;; esac
  [ ! -L "$candidate" ] || die "$label may not be a symlink"
  resolved="$(realpath -e -- "$candidate")" || die "$label cannot be resolved"
  [ "$resolved" = "$candidate" ] \
    || die "$label path must be canonical and may not traverse symlinks"
  case "$expected_kind" in
    file) [ -f "$candidate" ] && [ ! -L "$candidate" ] || die "$label must be a regular file" ;;
    directory) [ -d "$candidate" ] && [ ! -L "$candidate" ] || die "$label must be a real directory" ;;
    *) die "internal path-kind error" ;;
  esac
  current="$resolved"
  while :; do
    [ "$(stat -c '%U' -- "$current")" = root ] \
      || die "$label path component is not root-owned: $current"
    mode="$(stat -c '%a' -- "$current")"
    (( (8#$mode & 0022) == 0 )) \
      || die "$label path component is group/world writable: $current"
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
}

if [ "$COMMAND" = recover-install ]; then
  install -d -o root -g root -m 0700 "$STATE_ROOT"
  exec 9>"$STATE_ROOT/install.lock"
  chmod 0600 "$STATE_ROOT/install.lock"
  flock -x 9
  JOURNAL="$STATE_ROOT/install-in-progress.v1"
  if [ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ]; then
    printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-recovery-result.v1","recovered":false,"journalPresent":false}\n'
    exit 0
  fi
  [ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] \
    && [ "$(stat -c '%U:%G:%a:%h' "$JOURNAL")" = root:root:600:1 ] \
    && [ "$(stat -c '%s' "$JOURNAL")" -le 65536 ] \
    || die "runtime install recovery journal is unsafe"
  mapfile -t recovery < <(
    python3 - "$JOURNAL" "$NODE_TARGET" "$PM2_TARGET" "$NODE_PARENT" <<'PY'
import json,re,sys
from pathlib import Path
journal_path,node_target,pm2_target,node_parent=sys.argv[1:]
value=json.loads(Path(journal_path).read_text(encoding="utf-8"))
if set(value)!={"schema","status","transactionId","setId","guest","provisionReceiptSha256","bundleManifestSha256","paths","predecessors"}:
 raise SystemExit("runtime recovery journal schema is invalid")
transaction=value["transactionId"]
if (
 value["schema"]!="nexus.rollback-drill-vm-runtime-install-journal.v1"
 or value["status"]!="in_progress"
 or not re.fullmatch(r"\d{8}T\d{6}Z-\d+-\d+",transaction)
 or not re.fullmatch(r"[0-9a-f]{64}",value["setId"])
 or value["guest"] not in {"guest-1","guest-2","guest-3"}
 or not re.fullmatch(r"[0-9a-f]{64}",value["provisionReceiptSha256"])
 or not re.fullmatch(r"[0-9a-f]{64}",value["bundleManifestSha256"])
):
 raise SystemExit("runtime recovery journal identity is invalid")
paths=value["paths"]
if set(paths)!={"node","pm2","links"}:
 raise SystemExit("runtime recovery journal paths are invalid")
expected_node={"target":node_target,"stage":f"{node_parent}/.node-stage-{transaction}","backup":f"{node_parent}/.node-backup-{transaction}"}
expected_pm2={"target":pm2_target,"stage":f"{node_parent}/.pm2-stage-{transaction}","backup":f"{node_parent}/.pm2-backup-{transaction}"}
if paths["node"]!=expected_node or paths["pm2"]!=expected_pm2:
 raise SystemExit("runtime recovery journal tree paths are invalid")
predecessors=value["predecessors"]
if predecessors!={"nodePresent":False,"pm2Present":False}:
 raise SystemExit("runtime recovery predecessor state is invalid")
expected_links=[]
for name in ("corepack","node","npm","npx"):
 expected_links.append({
  "name":name,
  "target":f"/usr/bin/{name}",
  "backup":f"/usr/bin/.nexus-runtime-{transaction}-{name}",
  "previousPresent":None,
 })
links=paths["links"]
if not isinstance(links,list) or len(links)!=4:
 raise SystemExit("runtime recovery link inventory is invalid")
for observed,expected in zip(links,expected_links,strict=True):
 if set(observed)!={"name","target","backup","previousPresent"}:
  raise SystemExit("runtime recovery link schema is invalid")
 previous=observed["previousPresent"]
 if previous is not False:
  raise SystemExit("runtime recovery link predecessor is invalid")
 expected["previousPresent"]=previous
 if observed!=expected:
  raise SystemExit("runtime recovery link path is invalid")
for output in (
 transaction,
 value["setId"],
 value["guest"],
):
 print(output)
PY
  )
  [ "${#recovery[@]}" -eq 3 ] \
    || die "cannot decode runtime install recovery journal"
  transaction_id="${recovery[0]}"
  recovery_set_id="${recovery[1]}"
  recovery_guest="${recovery[2]}"
  node_stage="$NODE_PARENT/.node-stage-$transaction_id"
  node_backup="$NODE_PARENT/.node-backup-$transaction_id"
  pm2_stage="$NODE_PARENT/.pm2-stage-$transaction_id"
  pm2_backup="$NODE_PARENT/.pm2-backup-$transaction_id"
  recovery_install_receipt_dir="$STATE_ROOT/install-receipts/$recovery_set_id"
  recovery_install_receipt="$recovery_install_receipt_dir/$recovery_guest.json"

  for candidate in "$node_stage" "$node_backup" "$pm2_stage" "$pm2_backup"; do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      [ -d "$candidate" ] && [ ! -L "$candidate" ] \
        || die "runtime recovery tree path is unsafe: $candidate"
    fi
  done
  [ ! -e "$node_backup" ] && [ ! -L "$node_backup" ] \
    || die "runtime recovery found an impossible Node predecessor"
  [ ! -e "$pm2_backup" ] && [ ! -L "$pm2_backup" ] \
    || die "runtime recovery found an impossible PM2 predecessor"
  if [ -e "$NODE_TARGET" ] || [ -L "$NODE_TARGET" ]; then
    validate_root_owned_chain "$NODE_TARGET" "recoverable Node candidate" directory
  fi
  if [ -e "$PM2_TARGET" ] || [ -L "$PM2_TARGET" ]; then
    validate_root_owned_chain "$PM2_TARGET" "recoverable PM2 candidate" directory
  fi
  for binary in corepack node npm npx; do
    link="/usr/bin/$binary"
    backup="/usr/bin/.nexus-runtime-$transaction_id-$binary"
    next="/usr/bin/.nexus-runtime-$transaction_id-$binary.next"
    [ ! -e "$backup" ] && [ ! -L "$backup" ] \
      || die "runtime recovery found an impossible entrypoint predecessor"
    if [ -e "$link" ] || [ -L "$link" ]; then
      [ -L "$link" ] \
        && [ "$(readlink "$link")" = "$NODE_TARGET/bin/$binary" ] \
        || die "runtime recovery Node entrypoint is ambiguous"
    fi
    if [ -e "$next" ] || [ -L "$next" ]; then
      [ -L "$next" ] \
        && [ "$(readlink "$next")" = "$NODE_TARGET/bin/$binary" ] \
        || die "runtime recovery next entrypoint is ambiguous"
    fi
  done

  recovery_failed=false
  set +e
  for binary in corepack node npm npx; do
    link="/usr/bin/$binary"
    next="/usr/bin/.nexus-runtime-$transaction_id-$binary.next"
    rm -f -- "$link" "$next" || recovery_failed=true
  done
  rm -rf -- "$PM2_TARGET" || recovery_failed=true
  rm -rf -- "$NODE_TARGET" || recovery_failed=true
  rm -rf -- "$node_stage" "$pm2_stage" || recovery_failed=true
  rm -f -- "$recovery_install_receipt" || recovery_failed=true
  for binary in corepack node npm npx; do
    backup="/usr/bin/.nexus-runtime-$transaction_id-$binary"
    next="/usr/bin/.nexus-runtime-$transaction_id-$binary.next"
    if [ -e "$backup" ] || [ -L "$backup" ]; then recovery_failed=true; fi
    if [ -e "$next" ] || [ -L "$next" ]; then recovery_failed=true; fi
    if [ -e "/usr/bin/$binary" ] || [ -L "/usr/bin/$binary" ]; then
      recovery_failed=true
    fi
  done
  if [ -e "$node_backup" ] || [ -e "$pm2_backup" ]; then recovery_failed=true; fi
  if [ -e "$NODE_TARGET" ] || [ -L "$NODE_TARGET" ]; then
    recovery_failed=true
  fi
  if [ -e "$PM2_TARGET" ] || [ -L "$PM2_TARGET" ]; then
    recovery_failed=true
  fi
  if ! $recovery_failed; then
    fsync_path /usr/bin || recovery_failed=true
    fsync_path "$NODE_PARENT" || recovery_failed=true
    if [ -d "$recovery_install_receipt_dir" ]; then
      fsync_path "$recovery_install_receipt_dir" || recovery_failed=true
    fi
  fi
  if ! $recovery_failed; then durable_remove "$JOURNAL" || recovery_failed=true; fi
  set -e
  $recovery_failed && die "runtime crash recovery was incomplete; journal remains"
  printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-recovery-result.v1","recovered":true,"transactionId":"%s","journalPresent":false}\n' \
    "$transaction_id"
  exit 0
fi

case "$GUEST" in guest-1|guest-2|guest-3) ;; *) die "guest is outside the fixed allowlist" ;; esac
[[ "$EXPECTED_PROVISION_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || die "expected provision receipt digest is invalid"
if [ "$COMMAND" != inspect-python ]; then
  [[ "$EXPECTED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || die "expected manifest digest is invalid"
  [[ "$EXPECTED_OWNER_PUBLIC_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || die "expected owner public-key digest is invalid"
fi

PROVISION_RECEIPT="$(realpath -e -- "$PROVISION_RECEIPT")"
validate_root_owned_chain "$PROVISION_RECEIPT" "provision receipt copy" file
case "$PROVISION_RECEIPT" in
  "$PROVISION_PARENT/$EXPECTED_PROVISION_SHA256.json") ;;
  *) die "provision receipt path is not content-addressed by its digest" ;;
esac
[ "$(stat -c '%h' "$PROVISION_RECEIPT")" = 1 ] \
  || die "provision receipt copy has unexpected hard links"
[ "$(stat -c '%s' "$PROVISION_RECEIPT")" -le 524288 ] \
  || die "provision receipt copy exceeds the accepted bound"
observed_provision_sha256="$(sha256sum "$PROVISION_RECEIPT" | cut -d' ' -f1)"
[ "$observed_provision_sha256" = "$EXPECTED_PROVISION_SHA256" ] \
  || die "provision receipt digest mismatch"

if [ "$COMMAND" = inspect-python ]; then
  provision_json="$(python3 "$MANIFEST_HELPER" provision \
    --provision-receipt "$PROVISION_RECEIPT" \
    --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
    --guest "$GUEST")"
  mapfile -t provision_context < <(
    printf '%s' "$provision_json" | python3 -c '
import json,sys
v=json.load(sys.stdin)
for k in ("setId","baseImageSha256","uuid","instanceId","hostKeyFingerprint","hostPublicKey","hostPublicKeySha256"):
 print(v[k])
'
  )
  [ "${#provision_context[@]}" -eq 7 ] \
    || die "cannot select the exact provisioned Python context"
  SET_ID="${provision_context[0]}"
  BASE_IMAGE_SHA256="${provision_context[1]}"
  EXPECTED_UUID="${provision_context[2]}"
  EXPECTED_INSTANCE_ID="${provision_context[3]}"
  EXPECTED_HOST_KEY_FINGERPRINT="${provision_context[4]}"
  EXPECTED_HOST_PUBLIC_KEY="${provision_context[5]}"
  EXPECTED_HOST_PUBLIC_KEY_SHA256="${provision_context[6]}"
  observed_uuid="$(tr '[:upper:]' '[:lower:]' </sys/class/dmi/id/product_uuid)"
  [ "$observed_uuid" = "$EXPECTED_UUID" ] \
    || die "guest DMI UUID differs from the provision receipt"
  [ -f /var/lib/cloud/data/instance-id ] \
    && [ ! -L /var/lib/cloud/data/instance-id ] \
    && [ "$(< /var/lib/cloud/data/instance-id)" = "$EXPECTED_INSTANCE_ID" ] \
    || die "guest cloud-init instance identity differs from provision"
  [ -f "$SSH_HOST_PUBLIC" ] && [ ! -L "$SSH_HOST_PUBLIC" ] \
    || die "guest SSH host public key is missing or unsafe"
  [ "$(ssh-keygen -lf "$SSH_HOST_PUBLIC" -E sha256 | awk '{print $2}')" \
      = "$EXPECTED_HOST_KEY_FINGERPRINT" ] \
    || die "guest SSH host key differs from provision"
  [ -f "$SSH_HOST_PRIVATE" ] && [ ! -L "$SSH_HOST_PRIVATE" ] \
    && [ "$(stat -c '%U:%G:%a:%h' "$SSH_HOST_PRIVATE")" = root:root:600:1 ] \
    || die "guest SSH host signing key is missing or unsafe"
  [ -x /usr/bin/python3.12 ] && [ ! -L /usr/bin/python3.12 ] \
    || die "Noble Python 3.12 binary is missing or unsafe"
  python_version="$(/usr/bin/python3.12 --version 2>&1)"
  [[ "$python_version" =~ ^Python\ 3\.12\.[0-9]+$ ]] \
    || die "Noble Python is outside the 3.12 policy"
  python_sha256="$(sha256sum /usr/bin/python3.12 | cut -d' ' -f1)"
  python_package="$(dpkg-query -S /usr/bin/python3.12 | cut -d: -f1)"
  python_package_version="$(dpkg-query -W -f='${Version}' "$python_package")"
  python_package_architecture="$(dpkg-query -W -f='${Architecture}' "$python_package")"
  [ "$python_package_architecture" = amd64 ] \
    || die "Noble Python package architecture is not amd64"

  provenance_dir="$STATE_ROOT/python-provenance/$SET_ID"
  provenance="$provenance_dir/$GUEST.json"
  provenance_signature="$provenance.sig"
  install -d -o root -g dominguez -m 0750 "$provenance_dir"
  provenance_pair_state="$(evidence_pair_state "$provenance" "$provenance_signature")" \
    || die "guest Python provenance retry state is unsafe"
  if [ "$provenance_pair_state" = clear ]; then
    rm -f -- "$provenance" "$provenance_signature"
    fsync_path "$provenance_dir"
  elif [ "$provenance_pair_state" = complete ]; then
    [ -f "$provenance" ] && [ ! -L "$provenance" ] \
      && [ "$(stat -c '%U:%G:%a:%h' "$provenance")" = root:dominguez:640:1 ] \
      && [ -f "$provenance_signature" ] && [ ! -L "$provenance_signature" ] \
      && [ "$(stat -c '%U:%G:%a:%h' "$provenance_signature")" = root:dominguez:640:1 ] \
      || die "existing guest Python provenance is incomplete or unsafe"
    python3 "$MANIFEST_HELPER" validate-python-provenance \
      --provision-receipt "$PROVISION_RECEIPT" \
      --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
      --guest "$GUEST" \
      --provenance "$provenance" >/dev/null
    python3 - "$provenance" "$python_version" "$python_sha256" \
      "$python_package" "$python_package_version" "$python_package_architecture" <<'PY'
import json,sys
path,version,digest,package,package_version,architecture=sys.argv[1:]
observed=json.load(open(path,encoding="utf-8"))["python"]
expected={
 "version":version,
 "binaryPath":"/usr/bin/python3.12",
 "binarySha256":digest,
 "packageName":package,
 "packageVersion":package_version,
 "packageArchitecture":architecture,
 "dpkgVerified":True,
}
if observed!=expected:
 raise SystemExit("existing guest Python provenance differs from the live runtime")
PY
    allowed_signers="$(mktemp "$STATE_ROOT/.python-resume-signers.XXXXXXXX")"
    printf '%s %s\n' "$GUEST" "$EXPECTED_HOST_PUBLIC_KEY" >"$allowed_signers"
    chmod 0600 "$allowed_signers"
    if ! ssh-keygen -Y verify \
      -f "$allowed_signers" \
      -I "$GUEST" \
      -n nexus-rollback-drill-vm-python-provenance \
      -s "$provenance_signature" \
      <"$provenance" >/dev/null; then
      rm -f -- "$allowed_signers"
      die "existing guest Python provenance signature is invalid"
    fi
    rm -f -- "$allowed_signers"
    python3 - "$provenance" "$provenance_signature" "$SET_ID" "$GUEST" true <<'PY'
import base64,json,pathlib,sys
provenance,signature,set_id,guest,already_present=sys.argv[1:]
print(json.dumps({
 "ok":True,
 "schema":"nexus.rollback-drill-vm-python-provenance-result.v1",
 "setId":set_id,
 "guest":guest,
 "provenanceBase64":base64.b64encode(pathlib.Path(provenance).read_bytes()).decode("ascii"),
 "signatureBase64":base64.b64encode(pathlib.Path(signature).read_bytes()).decode("ascii"),
 "alreadyPresent":already_present=="true",
 "networkUsed":False,
},separators=(",",":"),sort_keys=True))
PY
    exit 0
  fi
  python3 - "$provenance" "$SET_ID" "$GUEST" "$EXPECTED_PROVISION_SHA256" \
    "$BASE_IMAGE_SHA256" "$EXPECTED_UUID" "$EXPECTED_INSTANCE_ID" \
    "$EXPECTED_HOST_KEY_FINGERPRINT" "$EXPECTED_HOST_PUBLIC_KEY_SHA256" \
    "$python_version" "$python_sha256" \
    "$python_package" "$python_package_version" "$python_package_architecture" <<'PY'
import datetime,json,os,sys
(
 output,set_id,guest,provision,base_image,uuid,instance_id,host_fingerprint,
 host_public_key_sha,
 python_version,python_sha,package,package_version,package_architecture,
)=sys.argv[1:]
value={
 "schema":"nexus.rollback-drill-vm-python-provenance.v1",
 "status":"observed_from_provisioned_base_image",
 "setId":set_id,
 "guest":guest,
 "capturedAt":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
 "provisionReceiptSha256":provision,
 "baseImageSha256":base_image,
 "machine":{"uuid":uuid,"instanceId":instance_id,"sshHostKeyFingerprint":host_fingerprint,"sshHostPublicKeySha256":host_public_key_sha},
 "os":{"id":"ubuntu","versionId":"24.04","architecture":"x86_64"},
 "python":{
  "version":python_version,
  "binaryPath":"/usr/bin/python3.12",
  "binarySha256":python_sha,
  "packageName":package,
  "packageVersion":package_version,
  "packageArchitecture":package_architecture,
  "dpkgVerified":True,
 },
 "networkInstallAttempted":False,
}
descriptor=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
try:
 body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
 os.write(descriptor,body);os.fsync(descriptor)
finally: os.close(descriptor)
PY
  chown root:dominguez "$provenance"
  chmod 0640 "$provenance"
  ssh-keygen -Y sign \
    -f "$SSH_HOST_PRIVATE" \
    -n nexus-rollback-drill-vm-python-provenance \
    "$provenance" >/dev/null
  [ -f "$provenance_signature" ] && [ ! -L "$provenance_signature" ] \
    || die "guest Python provenance signature was not created"
  chown root:dominguez "$provenance_signature"
  chmod 0640 "$provenance_signature"
  fsync_path "$provenance"
  fsync_path "$provenance_signature"
  fsync_path "$provenance_dir"
  python3 "$MANIFEST_HELPER" validate-python-provenance \
    --provision-receipt "$PROVISION_RECEIPT" \
    --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
    --guest "$GUEST" \
    --provenance "$provenance" >/dev/null
  python3 - "$provenance" "$provenance_signature" "$SET_ID" "$GUEST" false <<'PY'
import base64,json,pathlib,sys
provenance,signature,set_id,guest,already_present=sys.argv[1:]
print(json.dumps({
 "ok":True,
 "schema":"nexus.rollback-drill-vm-python-provenance-result.v1",
 "setId":set_id,
 "guest":guest,
 "provenanceBase64":base64.b64encode(pathlib.Path(provenance).read_bytes()).decode("ascii"),
 "signatureBase64":base64.b64encode(pathlib.Path(signature).read_bytes()).decode("ascii"),
 "alreadyPresent":already_present=="true",
 "networkUsed":False,
},separators=(",",":"),sort_keys=True))
PY
  exit 0
fi

BUNDLE_ROOT="$(realpath -e -- "$BUNDLE_ROOT")"
validate_root_owned_chain "$BUNDLE_ROOT" "runtime bundle" directory
case "$BUNDLE_ROOT" in
  /var/lib/nexus-rollback-drill-vm/toolchain-bundles/"$EXPECTED_MANIFEST_SHA256") ;;
  *) die "runtime bundle path is not content-addressed by its manifest" ;;
esac
while IFS= read -r -d '' input; do
  [ "$(stat -c '%U' -- "$input")" = root ] \
    || die "staged runtime bundle contains a non-root-owned path"
  if [ -L "$input" ]; then
    continue
  elif [ -f "$input" ]; then
    [ "$(stat -c '%h' -- "$input")" = 1 ] \
      || die "staged runtime bundle contains a hard-linked file"
  elif [ ! -d "$input" ]; then
    die "staged runtime bundle contains an unsupported file type"
  fi
  input_mode="$(stat -c '%a' -- "$input")"
  (( (8#$input_mode & 0022) == 0 )) \
    || die "staged runtime bundle contains a group/world-writable path"
done < <(find "$BUNDLE_ROOT" -xdev -print0)
MANIFEST="$BUNDLE_ROOT/manifest.json"
SIGNATURE="$BUNDLE_ROOT/manifest.sig"
OWNER_PUBLIC_KEY="$BUNDLE_ROOT/manifest-owner-public-key.pem"
for input in "$MANIFEST" "$SIGNATURE" "$OWNER_PUBLIC_KEY"; do
  validate_root_owned_chain "$input" "signed runtime bundle input" file
  [ "$(stat -c '%h' "$input")" = 1 ] \
    || die "signed runtime bundle input has unexpected hard links"
done
[ "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" = "$EXPECTED_MANIFEST_SHA256" ] \
  || die "runtime bundle manifest digest mismatch"
[ "$(sha256sum "$OWNER_PUBLIC_KEY" | cut -d' ' -f1)" = "$EXPECTED_OWNER_PUBLIC_KEY_SHA256" ] \
  || die "runtime bundle owner public-key digest mismatch"
openssl pkey -pubin -in "$OWNER_PUBLIC_KEY" -noout >/dev/null \
  || die "runtime bundle owner public key is invalid"
openssl pkeyutl -verify \
  -pubin \
  -inkey "$OWNER_PUBLIC_KEY" \
  -rawin \
  -in "$MANIFEST" \
  -sigfile "$SIGNATURE" >/dev/null \
  || die "runtime bundle owner signature is invalid"
python3 "$MANIFEST_HELPER" verify \
  --bundle-root "$BUNDLE_ROOT" \
  --manifest "$MANIFEST" \
  --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" >/dev/null
mapfile -t expected_bootstrap < <(
  python3 - "$MANIFEST" <<'PY'
import json,sys
for entry in json.load(open(sys.argv[1],encoding="utf-8"))["target"]["control"]["bootstrapFiles"]:
 print("\t".join((entry["destination"],str(entry["size"]),entry["sha256"])))
PY
)
[ "${#expected_bootstrap[@]}" -eq 2 ] \
  || die "runtime bootstrap inventory is invalid"
for record in "${expected_bootstrap[@]}"; do
  IFS=$'\t' read -r path expected_size expected_sha256 <<<"$record"
  [ -f "$path" ] && [ ! -L "$path" ] \
    && [ "$(stat -c '%U:%G:%a:%h' "$path")" = root:root:755:1 ] \
    || die "runtime bootstrap asset is missing or unsafe: $path"
  [ "$(stat -c '%s' "$path")" = "$expected_size" ] \
    && [ "$(sha256sum "$path" | cut -d' ' -f1)" = "$expected_sha256" ] \
    || die "runtime bootstrap asset differs from the signed source commit: $path"
done

context_json="$(python3 "$MANIFEST_HELPER" context \
  --provision-receipt "$PROVISION_RECEIPT" \
  --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
  --guest "$GUEST" \
  --manifest "$MANIFEST" \
  --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256")"
mapfile -t context < <(
  printf '%s' "$context_json" | python3 -c '
import json,sys
v=json.load(sys.stdin)
for k in ("setId","uuid","instanceId","hostKeyFingerprint","hostPublicKey","hostPublicKeySha256","overlayInitialSha256","nodeBinarySha256","nodeContentTreeSha256","pm2BinarySha256","pm2ContentTreeSha256","runtimeRecoveryUnitSha256"):
 print(v[k])
'
)
[ "${#context[@]}" -eq 12 ] || die "cannot select the exact guest context"
SET_ID="${context[0]}"
EXPECTED_UUID="${context[1]}"
EXPECTED_INSTANCE_ID="${context[2]}"
EXPECTED_HOST_KEY_FINGERPRINT="${context[3]}"
EXPECTED_HOST_PUBLIC_KEY="${context[4]}"
EXPECTED_HOST_PUBLIC_KEY_SHA256="${context[5]}"
OVERLAY_INITIAL_SHA256="${context[6]}"
EXPECTED_NODE_BINARY_SHA256="${context[7]}"
EXPECTED_NODE_TREE_SHA256="${context[8]}"
EXPECTED_PM2_BINARY_SHA256="${context[9]}"
EXPECTED_PM2_TREE_SHA256="${context[10]}"
EXPECTED_RUNTIME_RECOVERY_UNIT_SHA256="${context[11]}"
[[ "$SET_ID" =~ ^[0-9a-f]{64}$ ]] || die "provision set identity is invalid"

observed_uuid="$(tr '[:upper:]' '[:lower:]' </sys/class/dmi/id/product_uuid)"
[ "$observed_uuid" = "$EXPECTED_UUID" ] \
  || die "guest DMI UUID differs from the provision receipt"
[ -f /var/lib/cloud/data/instance-id ] && [ ! -L /var/lib/cloud/data/instance-id ] \
  || die "guest cloud-init instance identity is missing or unsafe"
[ "$(< /var/lib/cloud/data/instance-id)" = "$EXPECTED_INSTANCE_ID" ] \
  || die "guest cloud-init instance identity differs from provision"
[ -f "$SSH_HOST_PUBLIC" ] && [ ! -L "$SSH_HOST_PUBLIC" ] \
  || die "guest SSH host public key is missing or unsafe"
observed_host_fingerprint="$(ssh-keygen -lf "$SSH_HOST_PUBLIC" -E sha256 | awk '{print $2}')"
[ "$observed_host_fingerprint" = "$EXPECTED_HOST_KEY_FINGERPRINT" ] \
  || die "guest SSH host key differs from provision"
install -d -o root -g root -m 0700 "$STATE_ROOT"
python_allowed_signers="$(mktemp "$STATE_ROOT/.python-provenance-signers.XXXXXXXX")"
printf '%s %s\n' "$GUEST" "$EXPECTED_HOST_PUBLIC_KEY" >"$python_allowed_signers"
chmod 0600 "$python_allowed_signers"
ssh-keygen -Y verify \
  -f "$python_allowed_signers" \
  -I "$GUEST" \
  -n nexus-rollback-drill-vm-python-provenance \
  -s "$BUNDLE_ROOT/provenance/python/base-image-python.json.sig" \
  <"$BUNDLE_ROOT/provenance/python/base-image-python.json" >/dev/null \
  || die "bundle Python provenance host-key signature is invalid"
rm -f -- "$python_allowed_signers"

mapfile -t target < <(
  python3 - "$MANIFEST" <<'PY'
import json,sys
v=json.load(open(sys.argv[1],encoding="utf-8"))["target"]
for value in (
    v["node"]["npmVersion"],
    v["python"]["version"],
    v["python"]["binarySha256"],
    v["python"]["packageName"],
    v["python"]["packageVersion"],
    v["python"]["packageArchitecture"],
    v["control"]["sourceCommit"],
):
    print(value)
PY
)
[ "${#target[@]}" -eq 7 ] || die "cannot select the exact runtime target"
EXPECTED_NPM_VERSION="${target[0]}"
EXPECTED_PYTHON_VERSION="${target[1]}"
EXPECTED_PYTHON_SHA256="${target[2]}"
EXPECTED_PYTHON_PACKAGE="${target[3]}"
EXPECTED_PYTHON_PACKAGE_VERSION="${target[4]}"
EXPECTED_PYTHON_ARCH="${target[5]}"
CONTROL_SOURCE_COMMIT="${target[6]}"

verify_python() {
  local observed_owner observed_version observed_arch
  [ -x /usr/bin/python3.12 ] && [ ! -L /usr/bin/python3.12 ] \
    || die "Noble Python 3.12 binary is missing or unsafe"
  [ "$(/usr/bin/python3.12 --version 2>&1)" = "$EXPECTED_PYTHON_VERSION" ] \
    || die "Noble Python version differs from the bundle target"
  [ "$(sha256sum /usr/bin/python3.12 | cut -d' ' -f1)" = "$EXPECTED_PYTHON_SHA256" ] \
    || die "Noble Python binary digest differs from the bundle target"
  observed_owner="$(dpkg-query -S /usr/bin/python3.12 | cut -d: -f1)"
  [ "$observed_owner" = "$EXPECTED_PYTHON_PACKAGE" ] \
    || die "Python binary is not owned by the expected Noble package"
  observed_version="$(dpkg-query -W -f='${Version}' "$EXPECTED_PYTHON_PACKAGE")"
  observed_arch="$(dpkg-query -W -f='${Architecture}' "$EXPECTED_PYTHON_PACKAGE")"
  [ "$observed_version" = "$EXPECTED_PYTHON_PACKAGE_VERSION" ] \
    && [ "$observed_arch" = "$EXPECTED_PYTHON_ARCH" ] \
    || die "Noble Python package identity differs from the bundle target"
}
verify_python

verify_runtime_recovery() {
  local observed_exec_start expected_exec_start
  [ -f "$RUNTIME_RECOVERY_UNIT" ] && [ ! -L "$RUNTIME_RECOVERY_UNIT" ] \
    && [ "$(stat -c '%U:%G:%a:%h' "$RUNTIME_RECOVERY_UNIT")" = root:root:644:1 ] \
    || die "guest runtime recovery unit is missing or unsafe"
  [ "$(sha256sum "$RUNTIME_RECOVERY_UNIT" | cut -d' ' -f1)" \
      = "$EXPECTED_RUNTIME_RECOVERY_UNIT_SHA256" ] \
    || die "guest runtime recovery unit differs from the provision receipt"
  RUNTIME_RECOVERY_LOAD_STATE="$(
    systemctl show --property=LoadState --value \
      nexus-rollback-drill-vm-runtime-recovery.service 2>/dev/null
  )"
  RUNTIME_RECOVERY_UNIT_FILE_STATE="$(
    systemctl is-enabled nexus-rollback-drill-vm-runtime-recovery.service 2>/dev/null
  )"
  RUNTIME_RECOVERY_ACTIVE_STATE="$(
    systemctl is-active nexus-rollback-drill-vm-runtime-recovery.service 2>/dev/null
  )"
  RUNTIME_RECOVERY_FRAGMENT_PATH="$(
    systemctl show --property=FragmentPath --value \
      nexus-rollback-drill-vm-runtime-recovery.service 2>/dev/null
  )"
  RUNTIME_RECOVERY_DROP_IN_PATHS="$(
    systemctl show --property=DropInPaths --value \
      nexus-rollback-drill-vm-runtime-recovery.service 2>/dev/null
  )"
  RUNTIME_RECOVERY_NEED_DAEMON_RELOAD="$(
    systemctl show --property=NeedDaemonReload --value \
      nexus-rollback-drill-vm-runtime-recovery.service 2>/dev/null
  )"
  observed_exec_start="$(
    systemctl show --property=ExecStart --value \
      nexus-rollback-drill-vm-runtime-recovery.service 2>/dev/null
  )"
  expected_exec_start="/usr/local/sbin/nexus-rollback-drill-vm-runtime-control recover-install"
  [ "$RUNTIME_RECOVERY_LOAD_STATE" = loaded ] \
    || die "guest runtime recovery unit is not loaded"
  [ "$RUNTIME_RECOVERY_UNIT_FILE_STATE" = enabled ] \
    || die "guest runtime recovery unit is not enabled"
  [ "$RUNTIME_RECOVERY_ACTIVE_STATE" = active ] \
    || die "guest runtime recovery unit is not active"
  [ "$RUNTIME_RECOVERY_FRAGMENT_PATH" = "$RUNTIME_RECOVERY_UNIT" ] \
    || die "guest runtime recovery effective fragment path drifted"
  [ -z "$RUNTIME_RECOVERY_DROP_IN_PATHS" ] \
    || die "guest runtime recovery unit has unreviewed drop-ins"
  [ "$RUNTIME_RECOVERY_NEED_DAEMON_RELOAD" = no ] \
    || die "guest runtime recovery manager state is stale"
  python3 - "$observed_exec_start" "$expected_exec_start" <<'PY' \
    || die "guest runtime recovery effective ExecStart drifted"
import re,sys
observed,expected=sys.argv[1:]
match=re.fullmatch(
 r"\{ path=([^ ;]+) ; argv\[\]=([^;]+?) ; ignore_errors=no ;"
 r" start_time=.* ; stop_time=.* ; pid=[0-9]+ ; code=.* ; status=.* \}",
 observed,
)
if match is None or match.group(1)!=expected.split()[0] or match.group(2)!=expected:
 raise SystemExit(1)
PY
}
verify_runtime_recovery

install -d -o root -g root -m 0700 "$STATE_ROOT"
exec 9>"$STATE_ROOT/install.lock"
chmod 0600 "$STATE_ROOT/install.lock"
flock -x 9
JOURNAL="$STATE_ROOT/install-in-progress.v1"
[ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ] \
  || die "a prior runtime installation journal requires operator review"

INSTALL_RECEIPT_DIR="$STATE_ROOT/install-receipts/$SET_ID"
INSTALL_RECEIPT="$INSTALL_RECEIPT_DIR/$GUEST.json"

verify_node() {
  local binary resolved_binary
  python3 "$MANIFEST_HELPER" validate-node-entrypoints \
    --node-target "$NODE_TARGET" \
    --link-root /usr/bin >/dev/null
  [ -x "$NODE_TARGET/bin/node" ] && [ ! -L "$NODE_TARGET/bin/node" ] \
    || die "installed Node binary is missing or unsafe"
  [ "$("$NODE_TARGET/bin/node" --version)" = v22.23.1 ] \
    || die "installed Node version differs from policy"
  [ "$(sha256sum "$NODE_TARGET/bin/node" | cut -d' ' -f1)" \
      = "$EXPECTED_NODE_BINARY_SHA256" ] \
    || die "installed Node binary differs from the signed target"
  [ "$("$NODE_TARGET/bin/npm" --version)" = "$EXPECTED_NPM_VERSION" ] \
    || die "installed npm version differs from the bundle target"
  for binary in node npm npx corepack; do
    [ -L "/usr/bin/$binary" ] \
      && [ "$(readlink "/usr/bin/$binary")" = "$NODE_TARGET/bin/$binary" ] \
      || die "installed Node link does not name its exact runtime entrypoint"
    [ "$(stat -c '%U:%G' "/usr/bin/$binary")" = root:root ] \
      || die "installed Node link is not root-owned"
    resolved_binary="$(readlink -f "$NODE_TARGET/bin/$binary")"
    case "$resolved_binary" in
      "$NODE_TARGET"/*) ;;
      *) die "installed Node entrypoint escapes its exact runtime" ;;
    esac
    [ -f "$resolved_binary" ] && [ -x "$resolved_binary" ] \
      && [ "$(stat -c '%U:%G' "$resolved_binary")" = root:root ] \
      || die "installed Node entrypoint target is missing or unsafe"
  done
  [ "$(stat -c '%U:%G' "$NODE_TARGET/bin/node")" = root:root ] \
    || die "installed Node binary is not root-owned"
  python3 "$MANIFEST_HELPER" validate-content-tree \
    --root "$NODE_TARGET" \
    --expected-sha256 "$EXPECTED_NODE_TREE_SHA256" >/dev/null
}

verify_pm2() {
  [ -L "$PM2_TARGET/bin/pm2" ] \
    || die "installed PM2 binary must be the reviewed relative symlink"
  resolved_pm2="$(readlink -f "$PM2_TARGET/bin/pm2")"
  case "$resolved_pm2" in "$PM2_TARGET"/*) ;; *) die "installed PM2 binary escapes its prefix" ;; esac
  [ -x "$resolved_pm2" ] && [ ! -L "$resolved_pm2" ] \
    || die "installed PM2 binary target is missing or unsafe"
  [ "$(sha256sum "$resolved_pm2" | cut -d' ' -f1)" \
      = "$EXPECTED_PM2_BINARY_SHA256" ] \
    || die "installed PM2 binary differs from the signed target"
  python3 "$MANIFEST_HELPER" validate-pm2 \
    --prefix "$PM2_TARGET" \
    --lock "$BUNDLE_ROOT/provenance/pm2/package-lock.json" >/dev/null
  while IFS= read -r entry; do
    [ "$(stat -c '%U:%G' "$entry")" = root:root ] \
      || die "installed PM2 prefix contains an unexpected owner"
  done < <(find "$PM2_TARGET" -xdev -print)
  python3 "$MANIFEST_HELPER" validate-content-tree \
    --root "$PM2_TARGET" \
    --expected-sha256 "$EXPECTED_PM2_TREE_SHA256" >/dev/null
}

pm2_dry_health() {
  local pm2_health_home result="" failure=""
  install -d -o root -g dominguez -m 0710 "$PM2_HEALTH_PARENT"
  pm2_health_home="$(mktemp -d "$PM2_HEALTH_PARENT/$GUEST.XXXXXXXX")"
  chown dominguez:dominguez "$pm2_health_home"
  chmod 0700 "$pm2_health_home"
  if ! timeout 15s runuser -u dominguez -- env \
    PM2_HOME="$pm2_health_home" \
    PATH="$PM2_TARGET/bin:/usr/bin:/bin" \
    "$PM2_TARGET/bin/pm2" ping >/dev/null; then
    failure="PM2 isolated dry-health ping failed"
  elif ! result="$(timeout 15s runuser -u dominguez -- env \
    PM2_HOME="$pm2_health_home" \
    PATH="$PM2_TARGET/bin:/usr/bin:/bin" \
    "$PM2_TARGET/bin/pm2" jlist)"; then
    failure="PM2 isolated dry-health inventory failed"
  elif ! printf '%s' "$result" | /usr/bin/node -e '
let body="";process.stdin.on("data",c=>body+=c);process.stdin.on("end",()=>{
 const value=JSON.parse(body);if(!Array.isArray(value)||value.length!==0)process.exit(1);
});'; then
    failure="PM2 isolated dry-health process inventory is not empty"
  fi
  timeout 15s runuser -u dominguez -- env \
      PM2_HOME="$pm2_health_home" \
      PATH="$PM2_TARGET/bin:/usr/bin:/bin" \
      "$PM2_TARGET/bin/pm2" kill >/dev/null 2>&1 || true
  rm -rf -- "$pm2_health_home"
  [ -z "$failure" ] || die "$failure"
}

if [ "$COMMAND" = install ]; then
  if [ -e "$INSTALL_RECEIPT" ] || [ -L "$INSTALL_RECEIPT" ]; then
    [ -f "$INSTALL_RECEIPT" ] && [ ! -L "$INSTALL_RECEIPT" ] \
      && [ "$(stat -c '%U:%G:%a:%h' "$INSTALL_RECEIPT")" = root:root:600:1 ] \
      || die "existing runtime installation receipt is unsafe"
    verify_node
    verify_pm2
    verify_python
    pm2_dry_health
    python3 "$MANIFEST_HELPER" validate-install-receipt \
      --receipt "$INSTALL_RECEIPT" \
      --provision-receipt "$PROVISION_RECEIPT" \
      --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
      --guest "$GUEST" \
      --manifest "$MANIFEST" \
      --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" >/dev/null
    printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-install-result.v1","setId":"%s","guest":"%s","installReceipt":"%s","alreadyPresent":true,"drillReady":false,"pendingLiveMeasurement":true}\n' \
      "$SET_ID" "$GUEST" "$INSTALL_RECEIPT"
    exit 0
  fi

  transaction_id="$(date -u +'%Y%m%dT%H%M%SZ')-$$-$RANDOM"
  node_stage="$NODE_PARENT/.node-stage-$transaction_id"
  node_backup="$NODE_PARENT/.node-backup-$transaction_id"
  pm2_stage="$NODE_PARENT/.pm2-stage-$transaction_id"
  pm2_backup="$NODE_PARENT/.pm2-backup-$transaction_id"
  install -d -o root -g root -m 0755 "$NODE_PARENT"
  [ "$(dirname -- "$PM2_TARGET")" = "$NODE_PARENT" ] \
    || die "Node and PM2 targets must share the protected runtime parent"
  [ ! -e "$node_stage" ] && [ ! -L "$node_stage" ] \
    && [ ! -e "$node_backup" ] && [ ! -L "$node_backup" ] \
    && [ ! -e "$pm2_stage" ] && [ ! -L "$pm2_stage" ] \
    && [ ! -e "$pm2_backup" ] && [ ! -L "$pm2_backup" ] \
    || die "transaction staging or backup path already exists"

  node_extract_parent=""
  journal_armed=false
  transaction_succeeded=false
  node_had_previous=false
  pm2_had_previous=false
  node_target_touched=false
  pm2_target_touched=false
  touched_links=()
  declare -A link_had_previous_map=()
  cleanup_install() {
    if $journal_armed && ! $transaction_succeeded; then
      rollback_install
    elif ! $journal_armed; then
      if [ -n "$node_extract_parent" ]; then rm -rf -- "$node_extract_parent"; fi
      rm -rf -- "$node_stage" "$pm2_stage"
    fi
  }
  trap cleanup_install EXIT

  node_extract_parent="$(mktemp -d "$NODE_PARENT/.extract.XXXXXXXX")"
  python3 - "$BUNDLE_ROOT/payload/node-v22.23.1-linux-x64.tar.xz" \
    "$node_extract_parent" <<'PY'
import pathlib,posixpath,sys,tarfile
archive,destination=sys.argv[1:]
root="node-v22.23.1-linux-x64"
with tarfile.open(archive,mode="r:xz") as handle:
    members=handle.getmembers()
    if not members:
        raise SystemExit("Node archive is empty")
    for member in members:
        name=pathlib.PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] != root:
            raise SystemExit("Node archive member escapes its exact root")
        if member.isdev() or member.isfifo():
            raise SystemExit("Node archive contains a special file")
        if member.issym() or member.islnk():
            target=pathlib.PurePosixPath(member.linkname)
            if target.is_absolute():
                raise SystemExit("Node archive contains an absolute link")
            base=name.parent if member.issym() else pathlib.PurePosixPath()
            resolved=pathlib.PurePosixPath(posixpath.normpath(str(base/target)))
            if ".." in resolved.parts or not resolved.parts or resolved.parts[0] != root:
                raise SystemExit("Node archive link escapes its exact root")
    handle.extractall(destination,filter="data")
PY
  [ -d "$node_extract_parent/node-v22.23.1-linux-x64" ] \
    && [ ! -L "$node_extract_parent/node-v22.23.1-linux-x64" ] \
    || die "Node archive did not produce the exact runtime root"
  mv -T "$node_extract_parent/node-v22.23.1-linux-x64" "$node_stage"
  rmdir "$node_extract_parent"
  node_extract_parent=""
  chown -R root:root "$node_stage"
  chmod -R go-w "$node_stage"

  cp -a -- "$BUNDLE_ROOT/payload/pm2-prefix" "$pm2_stage"
  [ -d "$pm2_stage" ] && [ ! -L "$pm2_stage" ] \
    || die "PM2 bundle did not produce the exact prefix"
  chown -R root:root "$pm2_stage"
  while IFS= read -r -d '' directory; do chmod 0755 "$directory"; done \
    < <(find "$pm2_stage" -xdev -type d -print0)
  while IFS= read -r -d '' file; do
    runtime_mode=0644
    [ -x "$file" ] && runtime_mode=0755
    chmod "$runtime_mode" "$file"
  done < <(find "$pm2_stage" -xdev -type f -print0)
  python3 "$MANIFEST_HELPER" fsync-tree --root "$node_stage" >/dev/null
  python3 "$MANIFEST_HELPER" fsync-tree --root "$pm2_stage" >/dev/null

  if [ -e "$NODE_TARGET" ] || [ -L "$NODE_TARGET" ]; then
    die "canonical Noble guest unexpectedly contains the Node target"
  fi
  if [ -e "$PM2_TARGET" ] || [ -L "$PM2_TARGET" ]; then
    die "canonical Noble guest unexpectedly contains the PM2 target"
  fi
  for binary in corepack node npm npx; do
    link="/usr/bin/$binary"
    backup="/usr/bin/.nexus-runtime-$transaction_id-$binary"
    next="/usr/bin/.nexus-runtime-$transaction_id-$binary.next"
    [ ! -e "$backup" ] && [ ! -L "$backup" ] \
      && [ ! -e "$next" ] && [ ! -L "$next" ] \
      || die "Node link transaction path already exists"
    if [ -e "$link" ] || [ -L "$link" ]; then
      die "canonical Noble guest unexpectedly contains /usr/bin/$binary"
    else
      link_had_previous_map["$binary"]=false
    fi
  done

  # The journal is durable before the first live-path mutation. Backups stay on
  # the same filesystem as their target so every rename and rollback is atomic.
  python3 - "$JOURNAL" "$transaction_id" "$SET_ID" "$GUEST" \
    "$EXPECTED_PROVISION_SHA256" "$EXPECTED_MANIFEST_SHA256" \
    "$NODE_TARGET" "$node_stage" "$node_backup" \
    "$PM2_TARGET" "$pm2_stage" "$pm2_backup" \
    "$node_had_previous" "$pm2_had_previous" \
    "${link_had_previous_map[corepack]}" \
    "${link_had_previous_map[node]}" \
    "${link_had_previous_map[npm]}" \
    "${link_had_previous_map[npx]}" <<'PY'
import json,os,sys
(
 output,transaction,set_id,guest,provision,manifest,node_target,node_stage,
 node_backup,pm2_target,pm2_stage,pm2_backup,node_previous,pm2_previous,
 corepack_previous,node_link_previous,npm_previous,npx_previous,
)=sys.argv[1:]
value={
 "schema":"nexus.rollback-drill-vm-runtime-install-journal.v1",
 "status":"in_progress",
 "transactionId":transaction,
 "setId":set_id,
 "guest":guest,
 "provisionReceiptSha256":provision,
 "bundleManifestSha256":manifest,
 "paths":{
  "node":{"target":node_target,"stage":node_stage,"backup":node_backup},
  "pm2":{"target":pm2_target,"stage":pm2_stage,"backup":pm2_backup},
  "links":[
   {"name":"corepack","target":"/usr/bin/corepack","backup":f"/usr/bin/.nexus-runtime-{transaction}-corepack","previousPresent":corepack_previous=="true"},
   {"name":"node","target":"/usr/bin/node","backup":f"/usr/bin/.nexus-runtime-{transaction}-node","previousPresent":node_link_previous=="true"},
   {"name":"npm","target":"/usr/bin/npm","backup":f"/usr/bin/.nexus-runtime-{transaction}-npm","previousPresent":npm_previous=="true"},
   {"name":"npx","target":"/usr/bin/npx","backup":f"/usr/bin/.nexus-runtime-{transaction}-npx","previousPresent":npx_previous=="true"},
  ],
 },
 "predecessors":{"nodePresent":node_previous=="true","pm2Present":pm2_previous=="true"},
}
descriptor=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
 body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
 os.write(descriptor,body);os.fsync(descriptor)
finally: os.close(descriptor)
PY
  chown root:root "$JOURNAL"
  fsync_path "$JOURNAL"
  fsync_path "$STATE_ROOT"
  journal_armed=true

  rollback_install() {
    local rollback_failed=false binary backup link_had_previous
    set +e
    for binary in "${touched_links[@]}"; do
      rm -f -- "/usr/bin/$binary" || rollback_failed=true
      rm -f -- "/usr/bin/.nexus-runtime-$transaction_id-$binary.next" \
        || rollback_failed=true
      backup="/usr/bin/.nexus-runtime-$transaction_id-$binary"
      link_had_previous=false
      if [ -e "$backup" ] || [ -L "$backup" ]; then
        link_had_previous=true
        mv -T -- "$backup" "/usr/bin/$binary" || rollback_failed=true
      fi
      if [ -e "$backup" ] || [ -L "$backup" ]; then rollback_failed=true; fi
      if $link_had_previous; then
        { [ -e "/usr/bin/$binary" ] || [ -L "/usr/bin/$binary" ]; } \
          || rollback_failed=true
      elif [ -e "/usr/bin/$binary" ] || [ -L "/usr/bin/$binary" ]; then
        rollback_failed=true
      fi
    done
    if $node_target_touched; then
      rm -rf -- "$NODE_TARGET" || rollback_failed=true
      if $node_had_previous; then
        mv -T -- "$node_backup" "$NODE_TARGET" || rollback_failed=true
        [ -e "$NODE_TARGET" ] && [ ! -L "$NODE_TARGET" ] || rollback_failed=true
      elif [ -e "$NODE_TARGET" ] || [ -L "$NODE_TARGET" ]; then
        rollback_failed=true
      fi
    fi
    if $pm2_target_touched; then
      rm -rf -- "$PM2_TARGET" || rollback_failed=true
      if $pm2_had_previous; then
        mv -T -- "$pm2_backup" "$PM2_TARGET" || rollback_failed=true
        [ -e "$PM2_TARGET" ] && [ ! -L "$PM2_TARGET" ] || rollback_failed=true
      elif [ -e "$PM2_TARGET" ] || [ -L "$PM2_TARGET" ]; then
        rollback_failed=true
      fi
    fi
    if [ -n "$node_extract_parent" ]; then
      rm -rf -- "$node_extract_parent" || rollback_failed=true
    fi
    rm -rf -- "$node_stage" "$pm2_stage" || rollback_failed=true
    rm -f -- "$INSTALL_RECEIPT" || rollback_failed=true
    if ! $rollback_failed; then
      fsync_path /usr/bin || rollback_failed=true
      fsync_path "$NODE_PARENT" || rollback_failed=true
      if [ -d "$INSTALL_RECEIPT_DIR" ]; then
        fsync_path "$INSTALL_RECEIPT_DIR" || rollback_failed=true
      fi
    fi
    if ! $rollback_failed; then durable_remove "$JOURNAL" || rollback_failed=true; fi
    set -e
    $rollback_failed && die "runtime rollback was incomplete; install journal remains"
  }
  if $node_had_previous; then
    [ -d "$NODE_TARGET" ] && [ ! -L "$NODE_TARGET" ] \
      || die "existing Node target changed before publication"
    mv -T -- "$NODE_TARGET" "$node_backup"
  elif [ -e "$NODE_TARGET" ] || [ -L "$NODE_TARGET" ]; then
    die "Node target appeared after transaction preflight"
  fi
  node_target_touched=true
  mv -T -- "$node_stage" "$NODE_TARGET"
  if $pm2_had_previous; then
    [ -d "$PM2_TARGET" ] && [ ! -L "$PM2_TARGET" ] \
      || die "existing PM2 target changed before publication"
    mv -T -- "$PM2_TARGET" "$pm2_backup"
  elif [ -e "$PM2_TARGET" ] || [ -L "$PM2_TARGET" ]; then
    die "PM2 target appeared after transaction preflight"
  fi
  pm2_target_touched=true
  mv -T -- "$pm2_stage" "$PM2_TARGET"
  fsync_path "$NODE_PARENT"
  for binary in corepack node npm npx; do
    link="/usr/bin/$binary"
    backup="/usr/bin/.nexus-runtime-$transaction_id-$binary"
    next="/usr/bin/.nexus-runtime-$transaction_id-$binary.next"
    [ ! -e "$backup" ] && [ ! -L "$backup" ] \
      && [ ! -e "$next" ] && [ ! -L "$next" ] \
      || die "Node link transaction path appeared after preflight"
    if [ "${link_had_previous_map[$binary]}" = true ]; then
      { [ -f "$link" ] || [ -L "$link" ]; } \
        || die "Node entrypoint changed before publication"
      [ ! -e "$backup" ] && [ ! -L "$backup" ] \
        || die "Node link backup path already exists"
      mv -T -- "$link" "$backup"
    elif [ -e "$link" ] || [ -L "$link" ]; then
      die "Node entrypoint appeared after transaction preflight"
    fi
    touched_links+=("$binary")
    ln -s "$NODE_TARGET/bin/$binary" "$next"
    chown -h root:root "$next"
    mv -T -- "$next" "$link"
  done
  fsync_path /usr/bin

  verify_node
  verify_pm2
  pm2_dry_health
  install -d -o root -g root -m 0700 "$INSTALL_RECEIPT_DIR"
  node_sha256="$(sha256sum "$NODE_TARGET/bin/node" | cut -d' ' -f1)"
  pm2_resolved="$(readlink -f "$PM2_TARGET/bin/pm2")"
  pm2_sha256="$(sha256sum "$pm2_resolved" | cut -d' ' -f1)"
  python3 - "$INSTALL_RECEIPT" "$transaction_id" "$SET_ID" "$GUEST" \
    "$EXPECTED_PROVISION_SHA256" "$EXPECTED_MANIFEST_SHA256" \
    "$OVERLAY_INITIAL_SHA256" "$node_sha256" "$EXPECTED_NODE_TREE_SHA256" \
    "$EXPECTED_PYTHON_SHA256" "$pm2_sha256" "$EXPECTED_PM2_TREE_SHA256" \
    "$node_had_previous" "$pm2_had_previous" <<'PY'
import datetime,json,os,sys
(
 output,transaction,set_id,guest,provision,manifest,overlay,node_sha,node_tree,
 python_sha,pm2_sha,pm2_tree,node_previous,pm2_previous,
)=sys.argv[1:]
value={
 "schema":"nexus.rollback-drill-vm-runtime-install.v1",
 "status":"installed",
 "drillReady":False,
 "transactionId":transaction,
 "setId":set_id,
 "guest":guest,
 "installedAt":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
 "provisionReceiptSha256":provision,
 "bundleManifestSha256":manifest,
 "overlayInitialSha256":overlay,
 "runtimeDigests":{"nodeBinary":node_sha,"nodeTree":node_tree,"python":python_sha,"pm2Binary":pm2_sha,"pm2Tree":pm2_tree},
 "rollback":{
  "nodePreviousRetained":node_previous=="true",
  "pm2PreviousRetained":pm2_previous=="true",
  "automaticOnInstallFailure":True,
 },
}
descriptor=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
 body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
 os.write(descriptor,body);os.fsync(descriptor)
finally: os.close(descriptor)
PY
  chown root:root "$INSTALL_RECEIPT"
  fsync_path "$INSTALL_RECEIPT_DIR"
  fsync_path "$(dirname -- "$INSTALL_RECEIPT_DIR")"
  durable_remove "$JOURNAL"
  journal_armed=false
  transaction_succeeded=true
  trap - EXIT
  printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-install-result.v1","setId":"%s","guest":"%s","installReceipt":"%s","alreadyPresent":false,"drillReady":false,"pendingLiveMeasurement":true}\n' \
    "$SET_ID" "$GUEST" "$INSTALL_RECEIPT"
  exit 0
fi

# The live challenge-bound measurement is separate because the exact promotion
# control is installed only after Node exists. It still cannot mark the drill
# ready: only the host collector can measure a stopped overlay while retaining
# the admission, active-guest, and release/Sonar locks.
[ -f "$INSTALL_RECEIPT" ] && [ ! -L "$INSTALL_RECEIPT" ] \
  && [ "$(stat -c '%U:%G:%a:%h' "$INSTALL_RECEIPT")" = root:root:600:1 ] \
  || die "runtime installation receipt is missing or unsafe"
verify_node
verify_pm2
verify_python
pm2_dry_health
python3 "$MANIFEST_HELPER" validate-install-receipt \
  --receipt "$INSTALL_RECEIPT" \
  --provision-receipt "$PROVISION_RECEIPT" \
  --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
  --guest "$GUEST" \
  --manifest "$MANIFEST" \
  --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" >/dev/null

# Materialize the exact protected-main control source from the owner-signed
# offline bundle. The existing promotion bootstrap owns its own rollback
# journal; no production key or data is copied into this guest.
CONTROL_SOURCE_ROOT="$STATE_ROOT/control-source/$CONTROL_SOURCE_COMMIT"
if [ ! -e "$CONTROL_SOURCE_ROOT" ] && [ ! -L "$CONTROL_SOURCE_ROOT" ]; then
  install -d -o root -g root -m 0700 "$STATE_ROOT/control-source"
  control_source_stage="$(mktemp -d "$STATE_ROOT/control-source/.stage.XXXXXXXX")"
  python3 - "$BUNDLE_ROOT/payload/control-source.tar.gz" \
    "$control_source_stage" "$CONTROL_SOURCE_COMMIT" <<'PY'
import pathlib,posixpath,sys,tarfile
archive,destination,expected_commit=sys.argv[1:]
with tarfile.open(archive,mode="r:gz") as handle:
    if handle.pax_headers.get("comment") != expected_commit:
        raise SystemExit("control source archive commit identity differs")
    members=handle.getmembers()
    if not members or len(members)>50000:
        raise SystemExit("control source archive member count is invalid")
    total=0
    for member in members:
        name=pathlib.PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts or not name.parts:
            raise SystemExit("control source archive member escapes its root")
        if member.isdev() or member.isfifo():
            raise SystemExit("control source archive contains a special file")
        total+=max(member.size,0)
        if total>1024*1024*1024:
            raise SystemExit("control source archive exceeds the accepted bound")
        if member.issym() or member.islnk():
            target=pathlib.PurePosixPath(member.linkname)
            if target.is_absolute():
                raise SystemExit("control source archive contains an absolute link")
            base=name.parent if member.issym() else pathlib.PurePosixPath()
            resolved=pathlib.PurePosixPath(posixpath.normpath(str(base/target)))
            if ".." in resolved.parts or not resolved.parts:
                raise SystemExit("control source archive link escapes its root")
    handle.extractall(destination,filter="data")
PY
  chown -R root:root "$control_source_stage"
  chmod -R go-w "$control_source_stage"
  python3 "$MANIFEST_HELPER" fsync-tree --root "$control_source_stage" >/dev/null
  mv -T -- "$control_source_stage" "$CONTROL_SOURCE_ROOT"
  fsync_path "$STATE_ROOT/control-source"
fi
[ -d "$CONTROL_SOURCE_ROOT" ] && [ ! -L "$CONTROL_SOURCE_ROOT" ] \
  && [ "$(realpath -e "$CONTROL_SOURCE_ROOT")" = "$CONTROL_SOURCE_ROOT" ] \
  || die "protected-main control source is missing or unsafe"
validate_root_owned_chain "$CONTROL_SOURCE_ROOT" "protected-main control source" directory
mapfile -t source_identities < <(
  python3 - "$MANIFEST" <<'PY'
import json,sys
control=json.load(open(sys.argv[1],encoding="utf-8"))["target"]["control"]
for entry in control["bootstrapFiles"]+control["files"]:
 print("\t".join((entry["source"],str(entry["size"]),entry["sha256"])))
PY
)
[ "${#source_identities[@]}" -eq 9 ] \
  || die "protected-main control source inventory is invalid"
for record in "${source_identities[@]}"; do
  IFS=$'\t' read -r relative expected_size expected_sha256 <<<"$record"
  source_path="$CONTROL_SOURCE_ROOT/$relative"
  [ -f "$source_path" ] && [ ! -L "$source_path" ] \
    && [ "$(stat -c '%U:%G:%h' "$source_path")" = root:root:1 ] \
    || die "protected-main control source asset is missing or unsafe: $relative"
  [ "$(stat -c '%s' "$source_path")" = "$expected_size" ] \
    && [ "$(sha256sum "$source_path" | cut -d' ' -f1)" = "$expected_sha256" ] \
    || die "protected-main control source asset digest differs: $relative"
done
env -i \
  PATH="$PATH" \
  NEXUS_PROMOTION_WORKER_USER=dominguez \
  NEXUS_PROMOTION_SERVICE_USER=nexus-release \
  NEXUS_PROMOTION_SERVICE_GROUP=nexus-release \
  bash "$CONTROL_SOURCE_ROOT/scripts/remote-promotion-systemd-install.sh" \
    "$CONTROL_SOURCE_ROOT" \
    "$OWNER_PUBLIC_KEY" >/dev/null \
  || die "offline promotion control installation failed"

mapfile -t expected_control < <(
  python3 - "$MANIFEST" <<'PY'
import json,sys
for entry in json.load(open(sys.argv[1],encoding="utf-8"))["target"]["control"]["files"]:
 print("\t".join((entry["destination"],str(entry["size"]),entry["sha256"])))
PY
)
[ "${#expected_control[@]}" -eq 7 ] \
  || die "promotion control manifest inventory is invalid"
control_observed="$(mktemp "$STATE_ROOT/.control-observed.XXXXXXXX")"
for record in "${expected_control[@]}"; do
  IFS=$'\t' read -r path expected_size expected_sha256 <<<"$record"
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c '%h' "$path")" = 1 ] \
    || die "promotion control asset is missing or unsafe: $path"
  [ "$(stat -c '%U:%G' "$path")" = root:root ] \
    || die "promotion control asset is not root-owned: $path"
  observed_mode="$(stat -c '%a' "$path")"
  (( (8#$observed_mode & 0022) == 0 )) \
    || die "promotion control asset is group/world writable: $path"
  [ "$(stat -c '%s' "$path")" = "$expected_size" ] \
    && [ "$(sha256sum "$path" | cut -d' ' -f1)" = "$expected_sha256" ] \
    || die "promotion control asset differs from the protected-main bundle: $path"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$path" "$expected_size" "$expected_sha256" \
    "$(stat -c '%U:%G' "$path")" "$observed_mode" >>"$control_observed"
done
[ "$("$CONTROL_BIN" version)" = nexus-release-promotion-control.v2 ] \
  || die "promotion control version differs from policy"
"$CONTROL_BIN" assert-idle >/dev/null \
  || die "promotion control is not idle before live runtime measurement"

[ -f "$SSH_HOST_PRIVATE" ] && [ ! -L "$SSH_HOST_PRIVATE" ] \
  && [ "$(stat -c '%U:%G:%a:%h' "$SSH_HOST_PRIVATE")" = root:root:600:1 ] \
  || die "guest SSH host signing key is missing or unsafe"
measurement_root="$(mktemp -d "$STATE_ROOT/.measurement.XXXXXXXX")"
cleanup_measurement() {
  if [ -n "$measurement_root" ]; then rm -rf -- "$measurement_root"; fi
}
trap cleanup_measurement EXIT
MEASUREMENT="$measurement_root/measurement.json"
MEASUREMENT_SIGNATURE="$MEASUREMENT.sig"
node_resolved="$NODE_TARGET/bin/node"
pm2_resolved="$(readlink -f "$PM2_TARGET/bin/pm2")"
python3 - "$MEASUREMENT" "$SET_ID" "$GUEST" \
  "$EXPECTED_PROVISION_SHA256" "$EXPECTED_MANIFEST_SHA256" \
  "$EXPECTED_UUID" "$EXPECTED_INSTANCE_ID" "$EXPECTED_HOST_KEY_FINGERPRINT" \
  "$EXPECTED_HOST_PUBLIC_KEY_SHA256" \
  "$node_resolved" "$(/usr/bin/node --version)" \
  "$(sha256sum "$node_resolved" | cut -d' ' -f1)" "$EXPECTED_NODE_TREE_SHA256" \
  "$EXPECTED_PYTHON_VERSION" "$EXPECTED_PYTHON_SHA256" \
  "$EXPECTED_PYTHON_PACKAGE" "$EXPECTED_PYTHON_PACKAGE_VERSION" "$EXPECTED_PYTHON_ARCH" \
  "$pm2_resolved" 6.0.14 \
  "$(sha256sum "$pm2_resolved" | cut -d' ' -f1)" "$EXPECTED_PM2_TREE_SHA256" \
  "$CONTROL_SOURCE_COMMIT" "$control_observed" "$RUNTIME_RECOVERY_UNIT" \
  "$EXPECTED_RUNTIME_RECOVERY_UNIT_SHA256" "$RUNTIME_RECOVERY_LOAD_STATE" \
  "$RUNTIME_RECOVERY_ACTIVE_STATE" "$RUNTIME_RECOVERY_UNIT_FILE_STATE" \
  "$RUNTIME_RECOVERY_FRAGMENT_PATH" "$RUNTIME_RECOVERY_DROP_IN_PATHS" \
  "$RUNTIME_RECOVERY_NEED_DAEMON_RELOAD" \
  "$MEASUREMENT_CHALLENGE" <<'PY'
import datetime,json,os,pathlib,sys
(
 output,set_id,guest,provision,manifest,uuid,instance_id,host_fingerprint,
 host_public_key_sha,
 node_path,node_version,node_sha,node_tree,python_version,python_sha,python_package,
 python_package_version,python_arch,pm2_path,pm2_version,pm2_sha,pm2_tree,
 control_commit,control_records,recovery_unit,recovery_sha,recovery_load,
 recovery_active,recovery_unit_file,recovery_fragment,recovery_drop_ins,
 recovery_need_reload,challenge,
)=sys.argv[1:]
files=[]
for line in pathlib.Path(control_records).read_text(encoding="utf-8").splitlines():
 path,size,digest,owner,mode=line.split("\t")
 files.append({"path":path,"size":int(size),"sha256":digest,"owner":owner,"mode":mode})
value={
 "schema":"nexus.rollback-drill-vm-runtime-measurement.v1",
 "status":"guest_checks_passed",
 "drillReady":False,
 "pendingHostOverlaySeal":True,
 "setId":set_id,
 "guest":guest,
 "capturedAt":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
 "provisionReceiptSha256":provision,
 "bundleManifestSha256":manifest,
 "machine":{"uuid":uuid,"instanceId":instance_id,"sshHostKeyFingerprint":host_fingerprint,"sshHostPublicKeySha256":host_public_key_sha},
 "runtime":{
  "node":{"version":node_version,"path":node_path,"sha256":node_sha,"treeSha256":node_tree,"owner":"root:root","mode":oct(os.stat(node_path).st_mode&0o777)[2:]},
  "python":{"version":python_version,"path":"/usr/bin/python3.12","sha256":python_sha,"packageName":python_package,"packageVersion":python_package_version,"packageArchitecture":python_arch},
  "pm2":{"version":pm2_version,"path":pm2_path,"sha256":pm2_sha,"treeSha256":pm2_tree,"owner":"root:root","mode":oct(os.stat(pm2_path).st_mode&0o777)[2:]},
 },
 "control":{
  "version":"nexus-release-promotion-control.v2",
  "sourceCommit":control_commit,
  "files":files,
  "assertIdle":True,
  "runtimeRecovery":{
   "unit":"nexus-rollback-drill-vm-runtime-recovery.service",
   "path":recovery_unit,
   "sha256":recovery_sha,
   "loadState":recovery_load,
   "activeState":recovery_active,
   "unitFileState":recovery_unit_file,
   "fragmentPath":recovery_fragment,
   "dropInPaths":[] if recovery_drop_ins=="" else [recovery_drop_ins],
   "needDaemonReload":recovery_need_reload=="yes",
   "execStart":{
    "path":"/usr/local/sbin/nexus-rollback-drill-vm-runtime-control",
    "argv":[
     "/usr/local/sbin/nexus-rollback-drill-vm-runtime-control",
     "recover-install",
    ],
   },
  },
 },
 "pm2DryHealth":{"status":"passed","isolatedHome":True,"daemonStopped":True,"processCount":0},
 "networkInstallAttempted":False,
 "challenge":challenge,
}
descriptor=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
try:
 body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
 os.write(descriptor,body);os.fsync(descriptor)
finally: os.close(descriptor)
PY
rm -f -- "$control_observed"
chown root:root "$MEASUREMENT"
chmod 0600 "$MEASUREMENT"
ssh-keygen -Y sign \
  -f "$SSH_HOST_PRIVATE" \
  -n "$MEASUREMENT_NAMESPACE" \
  "$MEASUREMENT" >/dev/null
[ -f "$MEASUREMENT_SIGNATURE" ] && [ ! -L "$MEASUREMENT_SIGNATURE" ] \
  || die "guest host-key signature was not created"
chown root:root "$MEASUREMENT_SIGNATURE"
chmod 0600 "$MEASUREMENT_SIGNATURE"
fsync_path "$MEASUREMENT"
fsync_path "$MEASUREMENT_SIGNATURE"
fsync_path "$measurement_root"
python3 "$MANIFEST_HELPER" validate-measurement \
  --provision-receipt "$PROVISION_RECEIPT" \
  --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
  --guest "$GUEST" \
  --measurement "$MEASUREMENT" \
  --manifest "$MANIFEST" \
  --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --challenge "$MEASUREMENT_CHALLENGE" >/dev/null
python3 - "$MEASUREMENT" "$MEASUREMENT_SIGNATURE" \
  "$SET_ID" "$GUEST" "$MEASUREMENT_CHALLENGE" <<'PY'
import base64,json,pathlib,sys
measurement,signature,set_id,guest,challenge=sys.argv[1:]
value={
 "ok":True,
 "schema":"nexus.rollback-drill-vm-runtime-measurement-result.v1",
 "setId":set_id,
 "guest":guest,
 "challenge":challenge,
 "measurementBase64":base64.b64encode(pathlib.Path(measurement).read_bytes()).decode("ascii"),
 "signatureBase64":base64.b64encode(pathlib.Path(signature).read_bytes()).decode("ascii"),
}
print(json.dumps(value,separators=(",",":"),sort_keys=True))
PY
rm -rf -- "$measurement_root"
measurement_root=""

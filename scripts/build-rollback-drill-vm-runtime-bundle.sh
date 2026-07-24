#!/usr/bin/env bash
# Build one content-addressed, owner-signed guest runtime bundle. This command
# is intentionally network-free: the Node release inputs and npm cache must be
# prepared before it starts, and npm is forced into offline/ignore-scripts mode.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

die() {
  echo "rollback drill VM runtime bundle: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: build-rollback-drill-vm-runtime-bundle.sh
  --input-root <prepared-inputs>
  --source-root <clean-protected-main-checkout>
  --source-commit <40-hex-sha>
  --output-parent <existing-private-directory>
  --provision-receipt <immutable-active.json-copy>
  --expected-provision-sha256 <64-hex-sha256>
  --guest <guest-1|guest-2|guest-3>
  --python-provenance <guest-host-key-signed-json>
  --python-provenance-signature <ssh-signature>
  --node-signer-fingerprint <40-uppercase-hex>
  --owner-private-key <lab-only-ed25519-pem>
EOF
  exit 64
}

INPUT_ROOT=""
SOURCE_ROOT=""
SOURCE_COMMIT=""
OUTPUT_PARENT=""
PROVISION_RECEIPT=""
EXPECTED_PROVISION_SHA256=""
GUEST=""
PYTHON_PROVENANCE=""
PYTHON_PROVENANCE_SIGNATURE=""
NODE_SIGNER_FINGERPRINT=""
OWNER_PRIVATE_KEY=""

while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || usage
  case "$1" in
    --input-root) INPUT_ROOT="$2" ;;
    --source-root) SOURCE_ROOT="$2" ;;
    --source-commit) SOURCE_COMMIT="$2" ;;
    --output-parent) OUTPUT_PARENT="$2" ;;
    --provision-receipt) PROVISION_RECEIPT="$2" ;;
    --expected-provision-sha256) EXPECTED_PROVISION_SHA256="$2" ;;
    --guest) GUEST="$2" ;;
    --python-provenance) PYTHON_PROVENANCE="$2" ;;
    --python-provenance-signature) PYTHON_PROVENANCE_SIGNATURE="$2" ;;
    --node-signer-fingerprint) NODE_SIGNER_FINGERPRINT="$2" ;;
    --owner-private-key) OWNER_PRIVATE_KEY="$2" ;;
    *) usage ;;
  esac
  shift 2
done

for command in awk cp cut dirname find git gpgv gzip id install ln mktemp mv node npm \
  openssl python3 readlink realpath rm sha256sum ssh-keygen stat uname; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] \
  || die "bundle construction requires Linux x86-64"
[ -f /etc/os-release ] && [ ! -L /etc/os-release ] \
  || die "bundle construction requires a trusted OS identity"
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] \
  || die "bundle construction requires Ubuntu 24.04"
[ "$(node --version)" = v22.23.1 ] \
  || die "bundle construction requires Node v22.23.1"
npm_version="$(npm --version)"
[ "$npm_version" = 10.9.8 ] \
  || die "bundle construction requires the npm 10.9.8 shipped by Node v22.23.1"

[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "source commit is invalid"
[[ "$EXPECTED_PROVISION_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || die "provision receipt digest is invalid"
case "$GUEST" in guest-1|guest-2|guest-3) ;; *) die "guest is outside the fixed allowlist" ;; esac
[[ "$NODE_SIGNER_FINGERPRINT" =~ ^[0-9A-F]{40}$ ]] \
  || die "Node signer fingerprint is invalid"

INPUT_ROOT="$(realpath -e -- "$INPUT_ROOT")"
SOURCE_ROOT="$(realpath -e -- "$SOURCE_ROOT")"
OUTPUT_PARENT="$(realpath -e -- "$OUTPUT_PARENT")"
OWNER_PRIVATE_KEY="$(realpath -e -- "$OWNER_PRIVATE_KEY")"
PROVISION_RECEIPT="$(realpath -e -- "$PROVISION_RECEIPT")"
PYTHON_PROVENANCE="$(realpath -e -- "$PYTHON_PROVENANCE")"
PYTHON_PROVENANCE_SIGNATURE="$(realpath -e -- "$PYTHON_PROVENANCE_SIGNATURE")"
for directory in "$INPUT_ROOT" "$SOURCE_ROOT" "$OUTPUT_PARENT"; do
  [ -d "$directory" ] && [ ! -L "$directory" ] \
    || die "required directory is missing or unsafe: $directory"
done
[ "$(stat -c '%u' "$OUTPUT_PARENT")" = "$(id -u)" ] \
  || die "output parent must be owned by the bundle-building identity"
output_parent_mode="$(stat -c '%a' "$OUTPUT_PARENT")"
(( (8#$output_parent_mode & 0077) == 0 )) \
  || die "output parent must not be accessible by group or world"
[ -f "$OWNER_PRIVATE_KEY" ] && [ ! -L "$OWNER_PRIVATE_KEY" ] \
  && [ "$(stat -c '%h' "$OWNER_PRIVATE_KEY")" = 1 ] \
  || die "owner private key must be one regular non-symlink file"
[ "$(stat -c '%u' "$OWNER_PRIVATE_KEY")" = "$(id -u)" ] \
  || die "owner private key must be owned by the bundle-building identity"
key_mode="$(stat -c '%a' "$OWNER_PRIVATE_KEY")"
(( (8#$key_mode & 0077) == 0 )) || die "owner private key mode must be 0600 or stricter"
owner_key_type="$(openssl pkey -in "$OWNER_PRIVATE_KEY" -pubout -text_pub -noout \
  | awk 'NR==1 { first=$0 } END { print first }')"
[ "$owner_key_type" = "ED25519 Public-Key:" ] \
  || die "owner private key must be an Ed25519 key"
for evidence in "$PROVISION_RECEIPT" "$PYTHON_PROVENANCE" "$PYTHON_PROVENANCE_SIGNATURE"; do
  [ -f "$evidence" ] && [ ! -L "$evidence" ] && [ "$(stat -c '%h' "$evidence")" = 1 ] \
    || die "guest provenance input must be one regular non-symlink file"
done
[ "$(sha256sum "$PROVISION_RECEIPT" | cut -d' ' -f1)" = "$EXPECTED_PROVISION_SHA256" ] \
  || die "provision receipt differs from the reviewed digest"

[ "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" = "$SOURCE_COMMIT" ] \
  || die "source checkout does not match the reviewed commit"
[ "$(git -C "$SOURCE_ROOT" rev-parse --verify refs/remotes/origin/main^{commit})" \
    = "$SOURCE_COMMIT" ] \
  || die "source commit must be the exact protected origin/main identity"
[ -z "$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ] \
  || die "source checkout must be clean, including untracked files"

NODE_INPUT="$INPUT_ROOT/node"
PM2_INPUT="$INPUT_ROOT/pm2"
for input in \
  "$NODE_INPUT/node-v22.23.1-linux-x64.tar.xz" \
  "$NODE_INPUT/SHASUMS256.txt" \
  "$NODE_INPUT/SHASUMS256.txt.sig" \
  "$NODE_INPUT/node-release-keyring.gpg" \
  "$PM2_INPUT/package.json" \
  "$PM2_INPUT/package-lock.json"; do
  [ -f "$input" ] && [ ! -L "$input" ] && [ "$(stat -c '%h' "$input")" = 1 ] \
    || die "prepared input must be one regular non-symlink file: $input"
done
[ -d "$PM2_INPUT/npm-cache" ] && [ ! -L "$PM2_INPUT/npm-cache" ] \
  || die "prepared offline npm cache is missing or unsafe"

python3 - "$PM2_INPUT/package.json" "$PM2_INPUT/package-lock.json" <<'PY'
import json
import pathlib
import sys

package_path, lock_path = map(pathlib.Path, sys.argv[1:])
package = json.loads(package_path.read_text(encoding="utf-8"))
lock = json.loads(lock_path.read_text(encoding="utf-8"))
if set(package) - {"name", "version", "private", "description", "dependencies"}:
    raise SystemExit("PM2 preparation package.json contains unsupported fields")
if package.get("private") is not True or package.get("dependencies") != {"pm2": "6.0.14"}:
    raise SystemExit("PM2 preparation package.json must bind only pm2 6.0.14")
if lock.get("lockfileVersion") not in {2, 3}:
    raise SystemExit("PM2 preparation lockfile version is unsupported")
entry = lock.get("packages", {}).get("node_modules/pm2", {})
if entry.get("version") != "6.0.14":
    raise SystemExit("PM2 preparation lock does not bind pm2 6.0.14")
expected = "sha512-wX1FiFkzuT2H/UUEA8QNXDAA9MMHDsK/3UHj6Dkd5U7kxyigKDA5gyDw78ycTQZAuGCLWyUX5FiXEuVQWafukA=="
if entry.get("integrity") != expected:
    raise SystemExit("PM2 6.0.14 registry integrity differs from the reviewed identity")
PY

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_HELPER="$SCRIPT_ROOT/rollback-drill-vm-runtime-manifest.py"
[ -f "$MANIFEST_HELPER" ] && [ ! -L "$MANIFEST_HELPER" ] \
  || die "runtime manifest helper is missing or unsafe"

stage="$(mktemp -d "$OUTPUT_PARENT/.runtime-bundle.XXXXXXXX")"
pm2_work="$(mktemp -d "$OUTPUT_PARENT/.runtime-pm2.XXXXXXXX")"
cleanup() {
  rm -rf -- "$stage" "$pm2_work"
}
trap cleanup EXIT

provision_json="$(python3 "$MANIFEST_HELPER" provision \
  --provision-receipt "$PROVISION_RECEIPT" \
  --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
  --guest "$GUEST")"
python_validation_json="$(python3 "$MANIFEST_HELPER" validate-python-provenance \
  --provision-receipt "$PROVISION_RECEIPT" \
  --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
  --guest "$GUEST" \
  --provenance "$PYTHON_PROVENANCE")"
mapfile -t python_context < <(
  python3 - "$provision_json" "$python_validation_json" <<'PY'
import json,sys
provision=json.loads(sys.argv[1])
validated=json.loads(sys.argv[2])
python=validated["python"]
for value in (
    provision["baseImageSha256"],
    provision["hostPublicKey"],
    provision["hostKeyFingerprint"],
    provision["hostPublicKeySha256"],
    python["version"],
    python["binarySha256"],
    python["packageName"],
    python["packageVersion"],
    python["packageArchitecture"],
):
    print(value)
PY
)
[ "${#python_context[@]}" -eq 9 ] \
  || die "cannot select the signed guest Python identity"
BASE_IMAGE_SHA256="${python_context[0]}"
GUEST_HOST_PUBLIC_KEY="${python_context[1]}"
GUEST_HOST_KEY_FINGERPRINT="${python_context[2]}"
GUEST_HOST_PUBLIC_KEY_SHA256="${python_context[3]}"
PYTHON_VERSION="${python_context[4]}"
PYTHON_BINARY_SHA256="${python_context[5]}"
PYTHON_PACKAGE_NAME="${python_context[6]}"
PYTHON_PACKAGE_VERSION="${python_context[7]}"
PYTHON_PACKAGE_ARCHITECTURE="${python_context[8]}"

allowed_signers="$pm2_work/python-provenance.allowed-signers"
printf '%s %s\n' "$GUEST" "$GUEST_HOST_PUBLIC_KEY" >"$allowed_signers"
chmod 0600 "$allowed_signers"
ssh-keygen -Y verify \
  -f "$allowed_signers" \
  -I "$GUEST" \
  -n nexus-rollback-drill-vm-python-provenance \
  -s "$PYTHON_PROVENANCE_SIGNATURE" \
  <"$PYTHON_PROVENANCE" >/dev/null \
  || die "guest Python provenance host-key signature is invalid"

install -d -m 0700 \
  "$stage/payload" \
  "$stage/provenance/node" \
  "$stage/provenance/python" \
  "$stage/provenance/pm2" \
  "$pm2_work/project"
install -m 0400 "$NODE_INPUT/node-v22.23.1-linux-x64.tar.xz" \
  "$stage/payload/node-v22.23.1-linux-x64.tar.xz"
install -m 0400 "$NODE_INPUT/SHASUMS256.txt" \
  "$stage/provenance/node/SHASUMS256.txt"
install -m 0400 "$NODE_INPUT/SHASUMS256.txt.sig" \
  "$stage/provenance/node/SHASUMS256.txt.sig"
install -m 0400 "$NODE_INPUT/node-release-keyring.gpg" \
  "$stage/provenance/node/node-release-keyring.gpg"
install -m 0400 "$PYTHON_PROVENANCE" \
  "$stage/provenance/python/base-image-python.json"
install -m 0400 "$PYTHON_PROVENANCE_SIGNATURE" \
  "$stage/provenance/python/base-image-python.json.sig"
git -C "$SOURCE_ROOT" archive --format=tar "$SOURCE_COMMIT" \
  | gzip -n -9 >"$stage/payload/control-source.tar.gz"
chmod 0400 "$stage/payload/control-source.tar.gz"
install -m 0400 "$PM2_INPUT/package.json" "$pm2_work/project/package.json"
install -m 0400 "$PM2_INPUT/package-lock.json" "$pm2_work/project/package-lock.json"

# This is the only npm invocation. --offline forbids registry access and
# --ignore-scripts prevents dependency lifecycle code from executing.
env -i \
  PATH="$PATH" \
  HOME="$pm2_work/home" \
  npm_config_cache="$PM2_INPUT/npm-cache" \
  npm_config_offline=true \
  npm_config_ignore_scripts=true \
  npm_config_audit=false \
  npm_config_fund=false \
  npm_config_update_notifier=false \
  npm ci \
    --prefix "$pm2_work/project" \
    --offline \
    --ignore-scripts \
    --omit=dev \
    --no-audit \
    --no-fund

install -d -m 0700 \
  "$stage/payload/pm2-prefix/bin" \
  "$stage/payload/pm2-prefix/lib"
mv -- "$pm2_work/project/node_modules" \
  "$stage/payload/pm2-prefix/lib/node_modules"
ln -s ../lib/node_modules/pm2/bin/pm2 "$stage/payload/pm2-prefix/bin/pm2"
install -m 0400 "$PM2_INPUT/package-lock.json" \
  "$stage/provenance/pm2/package-lock.json"

# Normalize the owner-built payload without following symlinks.
while IFS= read -r -d '' directory; do chmod 0700 "$directory"; done \
  < <(find "$stage" -type d -print0)
while IFS= read -r -d '' file; do
  mode=0400
  [ -x "$file" ] && mode=0500
  chmod "$mode" "$file"
done < <(find "$stage" -type f -print0)

openssl pkey -in "$OWNER_PRIVATE_KEY" -pubout \
  -out "$stage/manifest-owner-public-key.pem"
chmod 0400 "$stage/manifest-owner-public-key.pem"
openssl pkey -pubin -in "$stage/manifest-owner-public-key.pem" -noout >/dev/null

python3 "$MANIFEST_HELPER" build \
  --bundle-root "$stage" \
  --source-root "$SOURCE_ROOT" \
  --source-commit "$SOURCE_COMMIT" \
  --base-image-sha256 "$BASE_IMAGE_SHA256" \
  --node-signer-fingerprint "$NODE_SIGNER_FINGERPRINT" \
  --npm-version "$npm_version" \
  --python-version "$PYTHON_VERSION" \
  --python-binary-sha256 "$PYTHON_BINARY_SHA256" \
  --python-package-name "$PYTHON_PACKAGE_NAME" \
  --python-package-version "$PYTHON_PACKAGE_VERSION" \
  --python-package-architecture "$PYTHON_PACKAGE_ARCHITECTURE" \
  --provision-receipt-sha256 "$EXPECTED_PROVISION_SHA256" \
  --python-provenance-guest "$GUEST" \
  --python-host-key-fingerprint "$GUEST_HOST_KEY_FINGERPRINT" \
  --python-host-public-key-sha256 "$GUEST_HOST_PUBLIC_KEY_SHA256" \
  --output "$stage/manifest.json" >/dev/null
chmod 0400 "$stage/manifest.json"

openssl pkeyutl -sign \
  -inkey "$OWNER_PRIVATE_KEY" \
  -rawin \
  -in "$stage/manifest.json" \
  -out "$stage/manifest.sig"
chmod 0400 "$stage/manifest.sig"
openssl pkeyutl -verify \
  -pubin \
  -inkey "$stage/manifest-owner-public-key.pem" \
  -rawin \
  -in "$stage/manifest.json" \
  -sigfile "$stage/manifest.sig" >/dev/null \
  || die "owner signature self-verification failed"

manifest_sha256="$(sha256sum "$stage/manifest.json" | cut -d' ' -f1)"
[[ "$manifest_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || die "cannot derive manifest identity"
python3 "$MANIFEST_HELPER" verify \
  --bundle-root "$stage" \
  --manifest "$stage/manifest.json" \
  --expected-manifest-sha256 "$manifest_sha256" >/dev/null
target="$OUTPUT_PARENT/$manifest_sha256"
[ ! -e "$target" ] && [ ! -L "$target" ] \
  || die "content-addressed bundle already exists: $target"
python3 "$MANIFEST_HELPER" fsync-tree --root "$stage" >/dev/null
mv -T -- "$stage" "$target"
stage=""
python3 - "$OUTPUT_PARENT" <<'PY'
import os,sys
descriptor=os.open(sys.argv[1],os.O_RDONLY)
try:os.fsync(descriptor)
finally:os.close(descriptor)
PY
trap - EXIT
rm -rf -- "$pm2_work"

printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-bundle-result.v1","bundlePath":"%s","manifestSha256":"%s","networkUsed":false,"lifecycleScriptsExecuted":false}\n' \
  "$target" "$manifest_sha256"

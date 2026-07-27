#!/usr/bin/env bash
# Build one content-addressed, owner-signed provision-set runtime bundle. This command
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
  --witness-guest <guest-1>
  --python-provenance <witness-host-key-signed-json>
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
WITNESS_GUEST=""
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
    --witness-guest) WITNESS_GUEST="$2" ;;
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
OS_RELEASE=/usr/lib/os-release
[ -f "$OS_RELEASE" ] && [ ! -L "$OS_RELEASE" ] \
  && [ "$(stat -c '%U:%G:%h' "$OS_RELEASE")" = root:root:1 ] \
  || die "bundle construction requires a trusted OS identity"
os_release_mode="$(stat -c '%a' "$OS_RELEASE")"
(( (8#$os_release_mode & 0022) == 0 )) \
  || die "bundle construction OS identity must not be group/world writable"
unset ID VERSION_ID
. "$OS_RELEASE"
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
[ "$WITNESS_GUEST" = guest-1 ] \
  || die "provision-set Python provenance witness must be guest-1"
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
    || die "witness provenance input must be one regular non-symlink file"
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
for policy in package.json package-lock.json; do
  [ -f "$SOURCE_ROOT/ops/pm2/$policy" ] \
    && [ ! -L "$SOURCE_ROOT/ops/pm2/$policy" ] \
    && [ "$(sha256sum "$PM2_INPUT/$policy" | cut -d' ' -f1)" \
      = "$(sha256sum "$SOURCE_ROOT/ops/pm2/$policy" | cut -d' ' -f1)" ] \
    || die "prepared PM2 $policy differs from protected origin/main"
done

python3 - "$PM2_INPUT/package.json" "$PM2_INPUT/package-lock.json" <<'PY'
import json
import pathlib
import sys

package_path, lock_path = map(pathlib.Path, sys.argv[1:])
package = json.loads(package_path.read_text(encoding="utf-8"))
lock = json.loads(lock_path.read_text(encoding="utf-8"))
if set(package) - {
    "name",
    "version",
    "private",
    "description",
    "engines",
    "dependencies",
}:
    raise SystemExit("PM2 preparation package.json contains unsupported fields")
if package.get("private") is not True or package.get("dependencies") != {"pm2": "6.0.14"}:
    raise SystemExit("PM2 preparation package.json must bind only pm2 6.0.14")
if package.get("engines") != {"node": "22.23.1"}:
    raise SystemExit("PM2 preparation package.json must bind Node 22.23.1")
if lock.get("lockfileVersion") != 3:
    raise SystemExit("PM2 preparation lockfile must use npm lockfile version 3")
for package_path in lock.get("packages", {}):
    if not package_path:
        continue
    pure = pathlib.PurePosixPath(package_path)
    if (
        pure.is_absolute()
        or "\\" in package_path
        or any(part in {"", ".", ".."} for part in pure.parts)
        or pure.parts[0] != "node_modules"
    ):
        raise SystemExit("PM2 preparation lock contains an unsafe package path")
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
  --guest "$WITNESS_GUEST")"
python_validation_json="$(python3 "$MANIFEST_HELPER" validate-python-provenance \
  --provision-receipt "$PROVISION_RECEIPT" \
  --expected-provision-sha256 "$EXPECTED_PROVISION_SHA256" \
  --guest "$WITNESS_GUEST" \
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
WITNESS_HOST_PUBLIC_KEY="${python_context[1]}"
WITNESS_HOST_KEY_FINGERPRINT="${python_context[2]}"
WITNESS_HOST_PUBLIC_KEY_SHA256="${python_context[3]}"
PYTHON_VERSION="${python_context[4]}"
PYTHON_BINARY_SHA256="${python_context[5]}"
PYTHON_PACKAGE_NAME="${python_context[6]}"
PYTHON_PACKAGE_VERSION="${python_context[7]}"
PYTHON_PACKAGE_ARCHITECTURE="${python_context[8]}"

allowed_signers="$pm2_work/python-provenance.allowed-signers"
printf '%s %s\n' "$WITNESS_GUEST" "$WITNESS_HOST_PUBLIC_KEY" >"$allowed_signers"
chmod 0600 "$allowed_signers"
ssh-keygen -Y verify \
  -f "$allowed_signers" \
  -I "$WITNESS_GUEST" \
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
git -C "$SOURCE_ROOT" archive --format=tar --prefix=source/ "$SOURCE_COMMIT" \
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

install -m 0400 "$PM2_INPUT/package-lock.json" \
  "$stage/provenance/pm2/package-lock.json"

# Construct the same symlink-free closure schema consumed by release-control
# v3. npm's generated .bin links are deliberately omitted; /usr/local/bin/pm2
# is a separately attested regular launcher owned by root.
node - "$pm2_work/project" "$stage/payload/pm2-closure" "$npm_version" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [installRoot, closureRoot, npmVersion] = process.argv.slice(2);
const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const copyTree = (source, destination, filter = () => true) => {
  const observed = fs.lstatSync(source);
  if (observed.isSymbolicLink()) {
    throw new Error(`PM2 closure contains a symlink: ${source}`);
  }
  if (observed.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
    fs.chmodSync(destination, 0o755);
    for (const name of fs.readdirSync(source).sort()) {
      if (filter(source, name)) {
        copyTree(path.join(source, name), path.join(destination, name), filter);
      }
    }
    return;
  }
  if (!observed.isFile()) {
    throw new Error(`PM2 closure contains a special entry: ${source}`);
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, observed.mode & 0o111 ? 0o755 : 0o644);
};

const packageBody = fs.readFileSync(path.join(installRoot, "package.json"));
const lockBody = fs.readFileSync(path.join(installRoot, "package-lock.json"));
const project = JSON.parse(packageBody);
const lock = JSON.parse(lockBody);
if (project.dependencies?.pm2 !== "6.0.14" || lock.lockfileVersion !== 3) {
  throw new Error("PM2 closure project identity is invalid");
}
const lockPackages = [];
for (const [packagePath, identity] of Object.entries(lock.packages ?? {})) {
  if (!packagePath) continue;
  if (identity.resolved?.startsWith("https://")
      && (!identity.integrity || !identity.version)) {
    throw new Error(`PM2 closure lock lacks registry integrity: ${packagePath}`);
  }
  lockPackages.push({
    path: packagePath,
    version: identity.version ?? null,
    resolved: identity.resolved ?? null,
    integrity: identity.integrity ?? null,
  });
}
lockPackages.sort((left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

fs.mkdirSync(closureRoot, { mode: 0o755 });
fs.copyFileSync(
  path.join(installRoot, "package.json"),
  path.join(closureRoot, "package.json"),
  fs.constants.COPYFILE_EXCL,
);
fs.copyFileSync(
  path.join(installRoot, "package-lock.json"),
  path.join(closureRoot, "package-lock.json"),
  fs.constants.COPYFILE_EXCL,
);
fs.chmodSync(path.join(closureRoot, "package.json"), 0o644);
fs.chmodSync(path.join(closureRoot, "package-lock.json"), 0o644);
const dependenciesRoot = path.join(closureRoot, "node_modules");
fs.mkdirSync(dependenciesRoot, { mode: 0o755 });
for (const name of fs.readdirSync(path.join(installRoot, "node_modules")).sort()) {
  if (name === ".bin") continue;
  copyTree(
    path.join(installRoot, "node_modules", name),
    path.join(dependenciesRoot, name),
    (parent, child) =>
      !(path.basename(parent) === "node_modules" && child === ".bin"),
  );
}

const files = [];
const walk = (directory) => {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`PM2 closure directory is unsafe: ${directory}`);
  }
  fs.chmodSync(directory, 0o755);
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const observed = fs.lstatSync(absolute);
    if (observed.isSymbolicLink()) {
      throw new Error(`PM2 closure contains a symlink: ${absolute}`);
    }
    if (observed.isDirectory()) {
      walk(absolute);
    } else if (observed.isFile()) {
      const body = fs.readFileSync(absolute);
      files.push({
        path: path.relative(closureRoot, absolute).split(path.sep).join("/"),
        size: body.length,
        mode: observed.mode & 0o7777,
        sha256: sha256(body),
      });
    } else {
      throw new Error(`PM2 closure contains a special entry: ${absolute}`);
    }
  }
};
walk(closureRoot);
files.sort((left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const installedPackages = [];
for (const identity of lockPackages) {
  const packageRoot = path.join(closureRoot, identity.path);
  if (!fs.existsSync(packageRoot)) {
    if (lock.packages[identity.path]?.optional === true) continue;
    throw new Error(`PM2 npm ci omitted a required locked package: ${identity.path}`);
  }
  const installed = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (installed.version !== identity.version) {
    throw new Error(`PM2 installed package version differs from lock: ${identity.path}`);
  }
  installedPackages.push({ path: identity.path, version: identity.version });
}
const manifest = {
  schema: "nexus.pm2-root-closure-manifest.v1",
  pm2Version: "6.0.14",
  nodeVersion: process.version,
  npmVersion,
  packageLockSha256: sha256(lockBody),
  packageLockPackages: lockPackages,
  installedPackages,
  payloadDigest: sha256(canonical({
    schema: "nexus.pm2-root-closure-payload.v1",
    files,
  })),
  fileCount: files.length,
  files,
};
fs.writeFileSync(
  path.join(closureRoot, "closure-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644, flag: "wx" },
);
NODE

# Preserve the deterministic source archive that the guest extracts into the
# root PM2 installation. It contains directories and regular files only.
python3 - "$stage/payload/pm2-closure" \
  "$stage/payload/pm2-root-closure.tar.gz" <<'PY'
import gzip,pathlib,stat,sys,tarfile
source=pathlib.Path(sys.argv[1]);output=pathlib.Path(sys.argv[2])
with output.open("xb") as raw:
    with gzip.GzipFile(filename="",mode="wb",fileobj=raw,mtime=0) as compressed:
        with tarfile.open(fileobj=compressed,mode="w",format=tarfile.PAX_FORMAT) as archive:
            for item in [source,*sorted(source.rglob("*"))]:
                relative=(
                    pathlib.PurePosixPath("pm2-closure")
                    if item==source
                    else pathlib.PurePosixPath(
                        "pm2-closure",item.relative_to(source).as_posix()
                    )
                )
                info=archive.gettarinfo(str(item),arcname=str(relative))
                info.uid=0;info.gid=0;info.uname="root";info.gname="root";info.mtime=0
                if item.is_dir():
                    info.mode=0o755;archive.addfile(info)
                elif item.is_file() and not item.is_symlink():
                    info.mode=0o755 if item.stat().st_mode&0o111 else 0o644
                    with item.open("rb") as body:archive.addfile(info,body)
                else:
                    raise SystemExit("PM2 closure contains a link or special entry")
PY

# Normalize the owner-built payload without following symlinks.
while IFS= read -r -d '' directory; do chmod 0700 "$directory"; done \
  < <(find "$stage" -type d -print0)
while IFS= read -r -d '' file; do
  mode=0400
  [ -x "$file" ] && mode=0500
  chmod "$mode" "$file"
done < <(find "$stage" -type f -print0)
# The closure is itself a governed runtime payload. Restore the exact modes
# recorded in closure-manifest.json after the private outer bundle is sealed.
while IFS= read -r -d '' directory; do chmod 0755 "$directory"; done \
  < <(find "$stage/payload/pm2-closure" -type d -print0)
while IFS= read -r -d '' file; do
  mode=0644
  [ -x "$file" ] && mode=0755
  chmod "$mode" "$file"
done < <(find "$stage/payload/pm2-closure" -type f -print0)

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
  --python-provenance-witness-guest "$WITNESS_GUEST" \
  --python-host-key-fingerprint "$WITNESS_HOST_KEY_FINGERPRINT" \
  --python-host-public-key-sha256 "$WITNESS_HOST_PUBLIC_KEY_SHA256" \
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

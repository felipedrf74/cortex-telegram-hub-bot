#!/usr/bin/env bash
# One-time, owner-reviewed server bootstrap. A release candidate cannot replace
# this root-owned control plane. The owner public key authorizes requests while
# its private counterpart remains off the server.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SOURCE_ROOT="${1:-}"
SOURCE_SHA="${2:-}"
SOURCE_ARCHIVE="${3:-}"
EXPECTED_ARCHIVE_SHA256="${4:-}"
OWNER_PUBLIC_KEY_SOURCE="${5:-}"
BOOTSTRAP_BASE=/var/lib/nexus-release-bootstrap
SERVICE_USER="${NEXUS_PROMOTION_SERVICE_USER:-nexus-release}"
SERVICE_GROUP="${NEXUS_PROMOTION_SERVICE_GROUP:-nexus-release}"
WORKER_USER="${NEXUS_PROMOTION_WORKER_USER:-dominguez}"
WORKER_GROUP="$(id -gn "$WORKER_USER" 2>/dev/null || printf '%s' "$WORKER_USER")"
SERVER_PROVENANCE_PRIVATE_KEY="${NEXUS_SERVER_PROVENANCE_PRIVATE_KEY:-/etc/nexus-release/serverdominguez-provenance-private-key.pem}"
SERVER_PROVENANCE_PUBLIC_KEY="${NEXUS_SERVER_PROVENANCE_PUBLIC_KEY:-/etc/nexus-release/serverdominguez-provenance-public-key.pem}"
ROOT_PM2_VERSION=6.0.14
ROOT_PM2_CLOSURE="/opt/nexus-release/pm2/$ROOT_PM2_VERSION"
ROOT_PM2_LAUNCHER=/usr/local/bin/pm2
ROOT_PM2_ATTESTATION=/var/lib/nexus-release-promotion/pm2-root-install.v1.json
ROOT_PM2_INSTALL_JOURNAL=/var/lib/nexus-release-promotion/pm2-install-in-progress.v1.json
ROOT_PM2_TRUSTED_LOCK=/usr/local/share/nexus-release/pm2-package-lock.json

die() {
  echo "promotion systemd bootstrap: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: sudo /var/lib/nexus-release-bootstrap/<protected-main-sha>/source/scripts/remote-promotion-systemd-install.sh \
  /var/lib/nexus-release-bootstrap/<protected-main-sha>/source \
  <40-hex-protected-main-sha> \
  /var/lib/nexus-release-bootstrap/<protected-main-sha>/source.tar.gz \
  <64-hex-owner-approved-archive-sha256> \
  <root-owned-owner-promotion-public-key>
EOF
}

[ "$#" -eq 5 ] || {
  usage >&2
  exit 64
}
[ "$EUID" -eq 0 ] || { echo "promotion systemd bootstrap must run as root" >&2; exit 77; }
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die "protected-main source SHA must be exactly 40 lowercase hexadecimal characters"
[[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || die "archive SHA-256 must be exactly 64 lowercase hexadecimal characters"
EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"
[ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ] \
  || die "source root must be the exact SHA-bound bootstrap source path"
[ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ] \
  || die "source archive must be the exact SHA-bound sibling bootstrap archive path"

for command in cat chmod chown cut dirname flock getent groupadd id install mktemp mv \
  node openssl python3 realpath rm runuser sha256sum stat systemctl systemd-tmpfiles \
  setpriv timeout useradd visudo; do
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

install_compatible_operational_asset() {
  local source="$1" target="$2" mode="$3"
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    echo "operational asset target is unsafe: $target" >&2
    return 1
  elif [ -e "$target" ]; then
    [ "$(stat -c '%U:%G:%a' -- "$target")" = "root:root:${mode}" ] \
      && [ "$(sha256sum -- "$target" | cut -d' ' -f1)" \
        = "$(sha256sum -- "$source" | cut -d' ' -f1)" ] || {
      echo "existing operational asset is not the exact compatible source: $target" >&2
      return 1
    }
    return
  fi
  install_file_atomically "$source" "$target" root root "$mode"
}

ensure_compatible_operational_directory() {
  local target="$1" mode="$2" parent
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -d "$target" ]; }; then
    echo "operational directory target is unsafe: $target" >&2
    return 1
  elif [ -d "$target" ]; then
    [ "$(realpath -e -- "$target")" = "$target" ] \
      && [ "$(stat -c '%U:%G:%a' -- "$target")" = "root:root:${mode}" ] || {
      echo "existing operational directory is not exact: $target" >&2
      return 1
    }
    return
  fi
  parent="$(dirname -- "$target")"
  [ -d "$parent" ] && [ ! -L "$parent" ] \
    && [ "$(realpath -e -- "$parent")" = "$parent" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$parent")" = root:root:755 ] || {
    echo "operational directory parent is unsafe: $parent" >&2
    return 1
  }
  install -d -o root -g root -m "$mode" -- "$target"
  fsync_path "$target"
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

validate_root_trusted_path "$SOURCE_ROOT" "promotion bootstrap source root" directory
validate_root_trusted_path "$SOURCE_ARCHIVE" "promotion bootstrap source archive" file
validate_root_trusted_path "$OWNER_PUBLIC_KEY_SOURCE" "owner promotion public key" file

PROMOTION_REQUIRED_INPUTS=(
  scripts/application-dr-systemd-install.sh
  ops/application-dr/install-layout.tsv
  scripts/promotion-authorization.mjs
  scripts/trusted-release-runtime-attestation.mjs
  scripts/trusted-release-filesystem-identity.mjs
  scripts/remote-release-selector-switch.py
  scripts/remote-staging-attestation-broker.sh
  scripts/remote-pm2-root-install.sh
  scripts/capture-pm2-dump-authority.mjs
  scripts/remote-pm2-dump-authority.py
  scripts/remote-release-boot-health.sh
  scripts/release-layout-authorization.mjs
  scripts/remote-release-layout-migrate.sh
  ops/pm2/package-lock.json
  scripts/remote-promotion-control.sh
  scripts/remote-promotion-worker-control.sh
  scripts/remote-promotion-transaction.sh
  scripts/ollama-observation-collector.mjs
  scripts/ollama-soak-evidence.mjs
  scripts/ollama-observation-control.mjs
  scripts/ollama-systemd-dropin-transaction.mjs
  scripts/ollama-install-state-check.mjs
  ops/sonarqube/nexus-release-sonar-lock.conf
  scripts/systemd/00-nexus-ollama-install-guard.conf
  scripts/systemd/nexus-ollama-observation@.service
  scripts/systemd/nexus-release-promotion@.service
  scripts/systemd/nexus-release-pm2-recovery-daemon.service
  scripts/systemd/nexus-release-layout-recovery.service
  scripts/systemd/nexus-release-promotion-recovery.service
)
for required in "${PROMOTION_REQUIRED_INPUTS[@]}"; do
  validate_root_trusted_path \
    "$SOURCE_ROOT/$required" \
    "promotion bootstrap source ($required)" \
    file
done

INSTALLER_SOURCE="$SOURCE_ROOT/scripts/remote-promotion-systemd-install.sh"
validate_root_trusted_path \
  "$INSTALLER_SOURCE" \
  "promotion bootstrap installer" \
  file
[[ "${BASH_SOURCE[0]}" == /* && ! -L "${BASH_SOURCE[0]}" ]] \
  && [ "$(realpath -e -- "${BASH_SOURCE[0]}")" = "$INSTALLER_SOURCE" ] \
  || die "installer must execute from the exact reviewed bootstrap source path"

node -e 'const {createPublicKey}=require("crypto");const fs=require("fs");createPublicKey(fs.readFileSync(process.argv[1]));' \
  "$OWNER_PUBLIC_KEY_SOURCE"

archive_sha256="$(sha256sum -- "$SOURCE_ARCHIVE" | cut -d' ' -f1)"
[ "$archive_sha256" = "$EXPECTED_ARCHIVE_SHA256" ] \
  || die "bootstrap source archive digest does not match the owner-approved digest"

# This proof completes before the bootstrap journal, target directories, users,
# keys, sudoers, systemd, or any other privileged state can be written. It
# binds the running installer and every promotion/DR install input to unique,
# safe, regular members of the owner-approved Git archive.
python3 - \
  "$SOURCE_ARCHIVE" "$SOURCE_ROOT" "$SOURCE_SHA" "$EXPECTED_ARCHIVE_SHA256" \
  "$SOURCE_ROOT/ops/application-dr/install-layout.tsv" \
  "$INSTALLER_SOURCE" \
  "${PROMOTION_REQUIRED_INPUTS[@]}" <<'PY'
import hashlib
import pathlib
import sys
import tarfile

archive_path, source_root, source_sha, expected_archive_sha256, dr_layout_path, installer_path, *promotion_inputs = sys.argv[1:]
source_root_path = pathlib.Path(source_root)


def safe_relative(value: str) -> bool:
    path = pathlib.PurePosixPath(value)
    return (
        value != ""
        and not path.is_absolute()
        and all(part not in ("", ".", "..") for part in path.parts)
        and str(path) == value
    )


required = {
    "ops/application-dr/install-layout.tsv",
    "scripts/remote-promotion-systemd-install.sh",
    *promotion_inputs,
}
with open(dr_layout_path, "r", encoding="utf-8") as layout:
    for line_number, raw_line in enumerate(layout, start=1):
        line = raw_line.rstrip("\n")
        if line_number == 1 or not line:
            continue
        fields = line.split("\t")
        if len(fields) != 4:
            raise SystemExit(
                "promotion bootstrap archive verifier: malformed application DR install layout"
            )
        relative = fields[0]
        if not safe_relative(relative):
            raise SystemExit(
                "promotion bootstrap archive verifier: unsafe application DR source path"
            )
        required.add(relative)

for relative in required:
    if not safe_relative(relative):
        raise SystemExit(
            f"promotion bootstrap archive verifier: unsafe required source path {relative}"
        )

with open(archive_path, "rb") as archive_file:
    actual_archive_sha256 = hashlib.sha256(archive_file.read()).hexdigest()
if actual_archive_sha256 != expected_archive_sha256:
    raise SystemExit(
        "promotion bootstrap archive verifier: bootstrap source archive digest does not match the owner-approved digest"
    )

with tarfile.open(archive_path, mode="r:*") as archive:
    if archive.pax_headers.get("comment") != source_sha:
        raise SystemExit(
            "promotion bootstrap archive verifier: Git archive commit does not match protected-main source SHA"
        )

    seen_names = set()
    required_members = {}
    expected_names = {f"source/{relative}": relative for relative in required}
    for member in archive.getmembers():
        if (
            not safe_relative(member.name)
            or (member.name != "source" and not member.name.startswith("source/"))
        ):
            raise SystemExit(
                f"promotion bootstrap archive verifier: unsafe archive member {member.name}"
            )
        if member.name in seen_names:
            raise SystemExit(
                f"promotion bootstrap archive verifier: duplicate archive member {member.name}"
            )
        seen_names.add(member.name)
        relative = expected_names.get(member.name)
        if relative is None:
            continue
        if not member.isreg() or member.issym() or member.islnk():
            raise SystemExit(
                f"promotion bootstrap archive verifier: required member is not regular: {member.name}"
            )
        required_members[relative] = member

    missing = sorted(required - required_members.keys())
    if missing:
        raise SystemExit(
            f"promotion bootstrap archive verifier: missing required member source/{missing[0]}"
        )

    for relative in sorted(required):
        member = required_members[relative]
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit(
                f"promotion bootstrap archive verifier: cannot read {member.name}"
            )
        archive_digest = hashlib.sha256(extracted.read()).hexdigest()
        local_path = source_root_path / relative
        if not local_path.is_file() or local_path.is_symlink():
            raise SystemExit(
                f"promotion bootstrap archive verifier: unsafe source {relative}"
            )
        try:
            local_path.relative_to(source_root_path)
        except ValueError:
            raise SystemExit(
                f"promotion bootstrap archive verifier: source escapes bootstrap root: {relative}"
            )
        local_digest = hashlib.sha256(local_path.read_bytes()).hexdigest()
        if local_digest != archive_digest:
            raise SystemExit(
                f"promotion bootstrap archive verifier: source/archive byte drift for {relative}"
            )

if pathlib.Path(installer_path).is_symlink():
    raise SystemExit(
        "promotion bootstrap archive verifier: installer source is a symlink"
    )
PY

verify_exact_root_pm2_prerequisite() {
  [ ! -e "$ROOT_PM2_INSTALL_JOURNAL" ] \
    && [ ! -L "$ROOT_PM2_INSTALL_JOURNAL" ] || {
    echo "root PM2 closure installation is incomplete; rerun its reviewed installer" >&2
    return 1
  }
  [ -f "$ROOT_PM2_TRUSTED_LOCK" ] && [ ! -L "$ROOT_PM2_TRUSTED_LOCK" ] \
    && [ "$(stat -c '%U:%G:%a:%h' "$ROOT_PM2_TRUSTED_LOCK")" = root:root:644:1 ] \
    && [ "$(sha256sum -- "$ROOT_PM2_TRUSTED_LOCK" | cut -d' ' -f1)" \
      = "$(sha256sum -- "$SOURCE_ROOT/ops/pm2/package-lock.json" | cut -d' ' -f1)" ] || {
    echo "the separately installed root PM2 lock is not the exact reviewed source lock" >&2
    return 1
  }
  [ -f "$ROOT_PM2_ATTESTATION" ] && [ ! -L "$ROOT_PM2_ATTESTATION" ] \
    && [ "$(stat -c '%U:%G:%a:%h' "$ROOT_PM2_ATTESTATION")" = root:root:600:1 ] || {
    echo "the separately installed root PM2 attestation is unavailable or unsafe" >&2
    return 1
  }
  [ -f "$ROOT_PM2_LAUNCHER" ] && [ ! -L "$ROOT_PM2_LAUNCHER" ] \
    && [ "$(stat -c '%U:%G:%a:%h' "$ROOT_PM2_LAUNCHER")" = root:root:755:1 ] || {
    echo "the separately installed root PM2 launcher is unavailable or unsafe" >&2
    return 1
  }
  [ -x /usr/bin/node ] && [ ! -L /usr/bin/node ] \
    && [ "$(stat -c '%U:%G:%a:%h' /usr/bin/node)" = root:root:755:1 ] || {
    echo "the root PM2 Node runtime is unavailable or unsafe" >&2
    return 1
  }
  /usr/bin/node - \
    "$ROOT_PM2_ATTESTATION" "$ROOT_PM2_LAUNCHER" /usr/bin/node \
    "$ROOT_PM2_TRUSTED_LOCK" "$ROOT_PM2_CLOSURE" "$ROOT_PM2_VERSION" <<'NODE'
const crypto=require('crypto');const fs=require('fs');const path=require('path');
const [attestationPath,launcher,nodeBin,trustedLockPath,expectedClosureRoot,
 expectedVersion]=process.argv.slice(2);
const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value)
 :Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha256=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const readStable=(file)=>{
 const descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=fs.fstatSync(descriptor);const body=fs.readFileSync(descriptor);const after=fs.fstatSync(descriptor);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1
   ||before.uid!==0||before.gid!==0||before.dev!==after.dev||before.ino!==after.ino
   ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
  return body;
 }finally{fs.closeSync(descriptor);}
};
if(process.version!=='v22.23.1')process.exit(1);
const attestationBody=readStable(attestationPath);
const record=JSON.parse(attestationBody);
const trustedLockBody=readStable(trustedLockPath);
const trustedLock=JSON.parse(trustedLockBody);
const closureRoot=path.resolve(record.closureRoot??'');
const entrypoint=path.join(expectedClosureRoot,'node_modules','pm2','bin','pm2');
if(record.schema!=='nexus.pm2-root-install.v1'||record.version!==expectedVersion
 ||record.closureRoot!==expectedClosureRoot||closureRoot!==expectedClosureRoot
 ||record.launcher!==launcher||record.entrypoint!==entrypoint
 ||!/^[a-f0-9]{64}$/u.test(record.sourceArchiveSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(record.closureDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(record.payloadDigest||'')
 ||record.packageLockSha256!==sha256(trustedLockBody)
 ||!/^[a-f0-9]{64}$/u.test(record.launcherSha256||'')
 ||record.node?.path!==nodeBin||record.node?.version!=='v22.23.1'
 ||record.node?.sha256!==sha256(readStable(nodeBin))
 ||!Number.isSafeInteger(record.fileCount)||record.fileCount<2
 ||!Number.isFinite(Date.parse(record.installedAt||'')))process.exit(1);
const launcherBody=readStable(launcher);
const launcherIdentity=fs.lstatSync(launcher);
if((launcherIdentity.mode&0o7777)!==0o755
 ||sha256(launcherBody)!==record.launcherSha256
 ||launcherBody.toString('utf8')
   !==`#!/usr/bin/bash\nexec ${JSON.stringify(nodeBin)} ${JSON.stringify(entrypoint)} "$@"\n`)process.exit(1);
const files=[];
const walk=(directory)=>{
 const directoryIdentity=fs.lstatSync(directory);
 if(!directoryIdentity.isDirectory()||directoryIdentity.isSymbolicLink()
  ||directoryIdentity.uid!==0||directoryIdentity.gid!==0
  ||(directoryIdentity.mode&0o7777)!==0o755)process.exit(1);
 for(const name of fs.readdirSync(directory).sort()){
  const absolute=path.join(directory,name);const identity=fs.lstatSync(absolute);
  if(identity.isSymbolicLink()||identity.uid!==0||identity.gid!==0
   ||(identity.mode&0o022)!==0)process.exit(1);
  if(identity.isDirectory())walk(absolute);
  else if(identity.isFile()){
   const body=readStable(absolute);
   files.push({path:path.relative(closureRoot,absolute).split(path.sep).join('/'),
    size:body.length,mode:identity.mode&0o7777,sha256:sha256(body)});
  }else process.exit(1);
 }
};
walk(closureRoot);
files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
const closureDigest=sha256(canonical({schema:'nexus.pm2-root-closure.v1',files}));
if(files.length!==record.fileCount||closureDigest!==record.closureDigest)process.exit(1);
const packageIdentity=JSON.parse(readStable(
 path.join(closureRoot,'node_modules','pm2','package.json')));
if(packageIdentity.name!=='pm2'||packageIdentity.version!==expectedVersion)process.exit(1);
const manifest=JSON.parse(readStable(path.join(closureRoot,'closure-manifest.json')));
const lockPackages=Object.entries(trustedLock.packages??{}).filter(([packagePath])=>packagePath)
 .map(([packagePath,identity])=>({path:packagePath,version:identity.version??null,
  resolved:identity.resolved??null,integrity:identity.integrity??null}))
 .sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
if(lockPackages.some((identity)=>String(identity.resolved??'').startsWith('https://')
 &&(!identity.version||!identity.integrity)))process.exit(1);
const payloadFiles=files.filter((identity)=>identity.path!=='closure-manifest.json');
const payloadDigest=sha256(canonical({
 schema:'nexus.pm2-root-closure-payload.v1',files:payloadFiles,
}));
const installedPackages=[];
for(const identity of lockPackages){
 const packageFile=path.join(closureRoot,identity.path,'package.json');
 if(!fs.existsSync(packageFile)){
  if(trustedLock.packages[identity.path]?.optional===true)continue;
  process.exit(1);
 }
 const installed=JSON.parse(readStable(packageFile));
 if(installed.version!==identity.version)process.exit(1);
 installedPackages.push({path:identity.path,version:identity.version});
}
if(manifest.schema!=='nexus.pm2-root-closure-manifest.v1'
 ||manifest.pm2Version!==expectedVersion||manifest.nodeVersion!=='v22.23.1'
 ||manifest.npmVersion!=='10.9.8'
 ||manifest.packageLockSha256!==record.packageLockSha256
 ||canonical(manifest.packageLockPackages)!==canonical(lockPackages)
 ||canonical(manifest.installedPackages)!==canonical(installedPackages)
 ||canonical(manifest.files)!==canonical(payloadFiles)
 ||manifest.fileCount!==payloadFiles.length||manifest.payloadDigest!==payloadDigest
 ||record.payloadDigest!==payloadDigest)process.exit(1);
NODE
}

verify_effective_pm2_application_unit() {
  local expected_dropin="$1" fragment properties
  local expected_fragment=/etc/systemd/system/pm2-dominguez.service
  fragment="$(systemctl show pm2-dominguez.service -p FragmentPath --value)"
  [ "$fragment" = "$expected_fragment" ] || {
    echo "pm2-dominguez systemd fragment is not the exact reviewed local unit" >&2
    return 1
  }
  validate_root_trusted_path "$expected_fragment" "pm2-dominguez systemd fragment" file
  [ "$(stat -c '%U:%G:%h' "$expected_fragment")" = root:root:1 ] || {
    echo "pm2-dominguez systemd fragment identity is unsafe" >&2
    return 1
  }
  validate_root_trusted_path "$expected_dropin" "pm2-dominguez release drop-in" file
  [ "$(stat -c '%U:%G:%a:%h' "$expected_dropin")" = root:root:644:1 ] || {
    echo "pm2-dominguez release drop-in identity is unsafe" >&2
    return 1
  }
  properties="$(
    systemctl show pm2-dominguez.service --no-pager \
      -p FragmentPath -p DropInPaths -p Type -p User -p Group -p PIDFile \
      -p ExecCondition -p ExecStartPre -p ExecStart -p ExecStartPost \
      -p ExecReload -p ExecStop -p ExecStopPost \
      -p Environment -p EnvironmentFiles -p PassEnvironment -p UnsetEnvironment
  )"
  python3 - "$properties" "$fragment" "$expected_dropin" <<'PY'
import shlex
import sys

body, expected_fragment, expected_dropin = sys.argv[1:]
properties = {}
for line in body.splitlines():
    key, separator, value = line.partition("=")
    if not separator or key in properties:
        raise SystemExit("pm2-dominguez effective property output is invalid")
    properties[key] = value

expected_keys = {
    "DropInPaths",
    "Environment",
    "EnvironmentFiles",
    "ExecCondition",
    "ExecReload",
    "ExecStart",
    "ExecStartPost",
    "ExecStartPre",
    "ExecStop",
    "ExecStopPost",
    "FragmentPath",
    "Group",
    "PIDFile",
    "PassEnvironment",
    "Type",
    "UnsetEnvironment",
    "User",
}
if set(properties) != expected_keys:
    raise SystemExit("pm2-dominguez effective property set is incomplete")
if (
    properties["FragmentPath"] != expected_fragment
    or properties["DropInPaths"] != expected_dropin
    or properties["Type"] != "forking"
    or properties["User"] != "dominguez"
    or properties["Group"] != "dominguez"
    or properties["PIDFile"] != "/home/dominguez/.pm2/pm2.pid"
    or properties["ExecCondition"] != ""
    or properties["ExecStartPre"] != ""
    or properties["ExecStopPost"] != ""
    or properties["EnvironmentFiles"] != ""
    or properties["PassEnvironment"] != ""
):
    raise SystemExit("pm2-dominguez effective static authority differs")


def require_one_exec(property_name: str, executable: str, argv: str) -> None:
    value = properties[property_name]
    if (
        value.count("{") != 1
        or value.count("}") != 1
        or f"path={executable} ;" not in value
        or f"argv[]={argv} ;" not in value
    ):
        raise SystemExit(
            f"pm2-dominguez {property_name} is not the sole exact command"
        )


require_one_exec("ExecStart", "/usr/local/bin/pm2", "/usr/local/bin/pm2 resurrect")
require_one_exec(
    "ExecStartPost",
    "/usr/local/sbin/nexus-release-promotion-control",
    "/usr/local/sbin/nexus-release-promotion-control boot-postcheck",
)
require_one_exec("ExecReload", "/usr/local/bin/pm2", "/usr/local/bin/pm2 reload all")
require_one_exec("ExecStop", "/usr/local/bin/pm2", "/usr/local/bin/pm2 kill")

expected_environment = {
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "PM2_HOME=/home/dominguez/.pm2",
    "PM2_DUMP_FILE_PATH=/var/lib/nexus-release-promotion/pm2-authority/dump.pm2",
    "PM2_DUMP_BACKUP_FILE_PATH=/var/lib/nexus-release-promotion/pm2-authority/dump.pm2.backup-disabled",
    "PM2_DAEMON_TITLE=NexusPM2:/opt/nexus-release/pm2/6.0.14",
}
if set(shlex.split(properties["Environment"])) != expected_environment:
    raise SystemExit("pm2-dominguez effective environment differs")
expected_unset = {
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PM2_NODE_OPTIONS",
    "PYTHONBREAKPOINT",
    "PYTHONHOME",
    "PYTHONINSPECT",
    "PYTHONPATH",
    "PYTHONSTARTUP",
}
if set(shlex.split(properties["UnsetEnvironment"])) != expected_unset:
    raise SystemExit("pm2-dominguez effective unset-environment policy differs")
PY
}

# The PM2 closure is a separate, owner-approved maintenance artifact because
# the five-argument promotion bootstrap does not accept arbitrary package
# bytes. Prove it against this exact protected-main lock before writing the
# bootstrap journal or changing either PM2 boot authority.
verify_exact_root_pm2_prerequisite

id "$WORKER_USER" >/dev/null 2>&1 || { echo "promotion worker user is missing" >&2; exit 1; }
[ "$WORKER_USER" = dominguez ] || { echo "promotion worker must be the dominguez application identity" >&2; exit 1; }

BOOTSTRAP_JOURNAL="/var/lib/nexus-release-promotion/bootstrap-in-progress.v1"
SUDOERS_TARGET="/etc/sudoers.d/nexus-release-promotion"
install -d -o root -g root -m 755 \
  /usr/local/libexec /usr/local/sbin /etc/nexus-release /etc/sudoers.d \
  /var/lib/nexus-release-promotion /srv/nexus-release
install -d -o root -g root -m 755 /usr/local/share /usr/local/share/nexus-release
fsync_path /usr/local/libexec
fsync_path /usr/local/sbin
fsync_path /etc/nexus-release
fsync_path /etc/sudoers.d
fsync_path /var/lib/nexus-release-promotion
fsync_path /srv/nexus-release
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
install_compatible_operational_asset \
  "$SOURCE_ROOT/scripts/ollama-observation-collector.mjs" \
  /usr/local/sbin/nexus-ollama-observation-collector.mjs 700
install_compatible_operational_asset \
  "$SOURCE_ROOT/scripts/ollama-soak-evidence.mjs" \
  /usr/local/sbin/ollama-soak-evidence.mjs 700
install_compatible_operational_asset \
  "$SOURCE_ROOT/scripts/ollama-observation-control.mjs" \
  /usr/local/sbin/nexus-ollama-observation-control.mjs 700
install_compatible_operational_asset \
  "$SOURCE_ROOT/scripts/ollama-systemd-dropin-transaction.mjs" \
  /usr/local/sbin/nexus-ollama-systemd-dropin-transaction.mjs 700
install_compatible_operational_asset \
  "$SOURCE_ROOT/scripts/ollama-install-state-check.mjs" \
  /usr/local/sbin/nexus-ollama-install-state-check.mjs 700
ensure_compatible_operational_directory /etc/systemd/system/ollama.service.d 755
install_compatible_operational_asset \
  "$SOURCE_ROOT/scripts/systemd/00-nexus-ollama-install-guard.conf" \
  /etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf 644
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
[ -f /usr/local/libexec/nexus-application-dr/release-recovery-runtime-identity.mjs ] \
  && [ ! -L /usr/local/libexec/nexus-application-dr/release-recovery-runtime-identity.mjs ] \
  && [ "$(stat -c '%U:%G:%a' /usr/local/libexec/nexus-application-dr/release-recovery-runtime-identity.mjs)" = root:root:644 ] || {
  echo "root-installed recovery runtime attestor is unavailable or unsafe" >&2
  exit 1
}

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
  "$SOURCE_ROOT/scripts/trusted-release-filesystem-identity.mjs" \
  /usr/local/libexec/nexus-trusted-release-filesystem-identity.mjs root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-release-selector-switch.py" \
  /usr/local/libexec/nexus-release-selector-switch.py root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-staging-attestation-broker.sh" \
  /usr/local/libexec/nexus-staging-attestation-broker.sh root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-pm2-root-install.sh" \
  /usr/local/sbin/nexus-release-pm2-root-install root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/capture-pm2-dump-authority.mjs" \
  /usr/local/libexec/nexus-capture-pm2-dump-authority.mjs root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-pm2-dump-authority.py" \
  /usr/local/libexec/nexus-pm2-dump-authority.py root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-release-boot-health.sh" \
  /usr/local/sbin/nexus-release-boot-health root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/release-layout-authorization.mjs" \
  /usr/local/libexec/nexus-release-layout-authorization.mjs root root 700
install_file_atomically \
  "$SOURCE_ROOT/scripts/remote-release-layout-migrate.sh" \
  /usr/local/sbin/nexus-release-layout-migrate root root 700
install_file_atomically \
  "$SOURCE_ROOT/ops/pm2/package-lock.json" \
  /usr/local/share/nexus-release/pm2-package-lock.json root root 644
[ "$(stat -c '%U:%G:%a' /usr/local/share/nexus-release)" = root:root:755 ] \
  && [ "$(stat -c '%U:%G:%a' /usr/local/share/nexus-release/pm2-package-lock.json)" = root:root:644 ] || {
  echo "root PM2 trusted-lock installation identity is unsafe" >&2
  exit 1
}
fsync_path /usr/local/share/nexus-release
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
  "$SOURCE_ROOT/scripts/systemd/nexus-release-pm2-recovery-daemon.service" \
  /etc/systemd/system/nexus-release-pm2-recovery-daemon.service root root 644
install_file_atomically \
  "$SOURCE_ROOT/scripts/systemd/nexus-release-layout-recovery.service" \
  /etc/systemd/system/nexus-release-layout-recovery.service root root 644
install_file_atomically \
  "$SOURCE_ROOT/scripts/systemd/nexus-release-promotion-recovery.service" \
  /etc/systemd/system/nexus-release-promotion-recovery.service root root 644
install_compatible_operational_asset \
  "$SOURCE_ROOT/scripts/systemd/nexus-ollama-observation@.service" \
  /etc/systemd/system/nexus-ollama-observation@.service 644
pm2_dropin=/etc/systemd/system/pm2-dominguez.service.d
install -d -o root -g root -m 755 "$pm2_dropin"
publish_text_atomically "$pm2_dropin/nexus-release-recovery.conf" 644 <<'EOF'
[Unit]
Requires=nexus-release-promotion-recovery.service
After=nexus-release-promotion-recovery.service

[Service]
Type=forking
User=dominguez
Group=dominguez
PIDFile=
PIDFile=/home/dominguez/.pm2/pm2.pid
MemoryDenyWriteExecute=false
KillMode=control-group
SendSIGKILL=yes
TimeoutStartSec=135s
TimeoutStopSec=30s
Environment=
EnvironmentFile=
PassEnvironment=
UnsetEnvironment=
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="PM2_HOME=/home/dominguez/.pm2"
Environment="PM2_DUMP_FILE_PATH=/var/lib/nexus-release-promotion/pm2-authority/dump.pm2"
Environment="PM2_DUMP_BACKUP_FILE_PATH=/var/lib/nexus-release-promotion/pm2-authority/dump.pm2.backup-disabled"
Environment="PM2_DAEMON_TITLE=NexusPM2:/opt/nexus-release/pm2/6.0.14"
UnsetEnvironment=NODE_OPTIONS NODE_PATH PM2_NODE_OPTIONS PYTHONPATH PYTHONHOME PYTHONINSPECT PYTHONSTARTUP PYTHONBREAKPOINT LD_PRELOAD LD_LIBRARY_PATH
ExecCondition=
ExecStartPre=
ExecStart=
ExecStart=/usr/local/bin/pm2 resurrect
ExecStartPost=
ExecStartPost=+/usr/local/sbin/nexus-release-promotion-control boot-postcheck
ExecReload=
ExecReload=/usr/local/bin/pm2 reload all
ExecStop=
ExecStop=/usr/local/bin/pm2 kill
ExecStopPost=
EOF
# A root PM2 unit is a competing boot/restart authority. The application unit
# is the single allowed PM2 owner; an existing root unit is stopped, disabled,
# and masked during this owner-approved maintenance transaction.
pm2_root_load_state="$(
  systemctl show pm2-root.service -p LoadState --value 2>/dev/null || true
)"
pm2_root_enabled_state="$(
  systemctl is-enabled pm2-root.service 2>/dev/null || true
)"
case "$pm2_root_load_state" in
  loaded|masked|not-found) ;;
  *)
    echo "competing pm2-root service load state is unavailable or invalid" >&2
    exit 1
    ;;
esac
if [ "$pm2_root_enabled_state" = masked ]; then
  [ "$pm2_root_load_state" = masked ] || {
    echo "competing pm2-root mask state is internally inconsistent" >&2
    exit 1
  }
elif [ -n "$pm2_root_load_state" ] && [ "$pm2_root_load_state" != not-found ]; then
  pm2_root_fragment="$(
    systemctl show pm2-root.service -p FragmentPath --value
  )"
  case "$pm2_root_fragment" in
    /etc/systemd/system/pm2-root.service)
      validate_root_trusted_path "$pm2_root_fragment" "legacy pm2-root unit" file
      [ "$(stat -c '%U:%G:%h' "$pm2_root_fragment")" = root:root:1 ] || {
        echo "legacy pm2-root unit identity is unsafe" >&2
        exit 1
      }
      pm2_root_retired_dir=/var/lib/nexus-release-promotion/retired-systemd-units
      install -d -o root -g root -m 700 "$pm2_root_retired_dir"
      pm2_root_fragment_sha256="$(
        sha256sum -- "$pm2_root_fragment" | cut -d' ' -f1
      )"
      pm2_root_retired="$pm2_root_retired_dir/pm2-root.service.${pm2_root_fragment_sha256}.retired"
      if [ -e "$pm2_root_retired" ] || [ -L "$pm2_root_retired" ]; then
        [ -f "$pm2_root_retired" ] && [ ! -L "$pm2_root_retired" ] \
          && [ "$(stat -c '%U:%G:%a:%h' "$pm2_root_retired")" = root:root:600:1 ] \
          && [ "$(sha256sum -- "$pm2_root_retired" | cut -d' ' -f1)" \
            = "$pm2_root_fragment_sha256" ] || {
          echo "retired pm2-root unit evidence is unsafe" >&2
          exit 1
        }
      else
        install_file_atomically \
          "$pm2_root_fragment" "$pm2_root_retired" root root 600
      fi
      systemctl disable --now pm2-root.service
      durable_remove "$pm2_root_fragment"
      systemctl daemon-reload
      ;;
    /usr/lib/systemd/system/pm2-root.service|/lib/systemd/system/pm2-root.service)
      validate_root_trusted_path "$pm2_root_fragment" "legacy pm2-root vendor unit" file
      [ "$(stat -c '%U:%G:%h' "$pm2_root_fragment")" = root:root:1 ] || {
        echo "legacy pm2-root vendor unit identity is unsafe" >&2
        exit 1
      }
      systemctl disable --now pm2-root.service
      ;;
    *)
      echo "competing pm2-root service has an unreviewed fragment: $pm2_root_fragment" >&2
      exit 1
      ;;
  esac
fi
if [ -f /etc/systemd/system/pm2-root.service.d/nexus-release-recovery.conf ]; then
  validate_root_trusted_path \
    /etc/systemd/system/pm2-root.service.d/nexus-release-recovery.conf \
    "legacy pm2-root release drop-in" file
  durable_remove /etc/systemd/system/pm2-root.service.d/nexus-release-recovery.conf
  rmdir --ignore-fail-on-non-empty /etc/systemd/system/pm2-root.service.d
  fsync_path /etc/systemd/system
fi
systemctl mask pm2-root.service
fsync_path /etc/systemd/system
[ "$(systemctl is-enabled pm2-root.service 2>/dev/null || true)" = masked ] || {
  echo "competing pm2-root service could not be masked" >&2
  exit 1
}
cloudflared_dropin=/etc/systemd/system/nexus-cloudflared.service.d
install -d -o root -g root -m 755 "$cloudflared_dropin"
publish_text_atomically "$cloudflared_dropin/nexus-release-ready.conf" 644 <<'EOF'
[Unit]
Requires=pm2-dominguez.service
After=pm2-dominguez.service
EOF
install -d -o root -g "$SERVICE_GROUP" -m 755 \
  /var/lib/nexus-release-promotion \
  /var/lib/nexus-release-promotion/requests \
  /var/lib/nexus-release-promotion/transactions
install -d -o root -g root -m 700 /var/lib/nexus-release-promotion/staging
install -d -o root -g "$WORKER_GROUP" -m 750 \
  /var/lib/nexus-release-promotion/pm2-authority

# The signed ecosystem configuration reads operational policy from .env.
# Convert that owner-approved input into read-only root authority exactly once;
# a same-UID application process must not be able to rewrite resurrection
# semantics after this maintenance installation.
ENV_SEAL_JOURNAL=/var/lib/nexus-release-promotion/bootstrap-environment-seal.v1.json
ENV_SEAL_COMMITTED=false
sudoers_tmp=""
restore_environment_seal() {
  [ -e "$ENV_SEAL_JOURNAL" ] || return 0
  python3 - "$ENV_SEAL_JOURNAL" <<'PY'
import json, os, stat, sys
journal_path = sys.argv[1]
descriptor = os.open(
    journal_path,
    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
)
try:
    identity = os.fstat(descriptor)
    body = os.read(descriptor, min(identity.st_size + 1, 256 * 1024))
    if (
        not stat.S_ISREG(identity.st_mode)
        or identity.st_nlink != 1
        or identity.st_uid != 0
        or identity.st_gid != 0
        or stat.S_IMODE(identity.st_mode) != 0o600
        or len(body) != identity.st_size
    ):
        raise SystemExit("environment seal rollback journal is unsafe")
    journal = json.loads(body)
finally:
    os.close(descriptor)
if journal.get("schema") != "nexus.release-bootstrap-environment-seal.v1":
    raise SystemExit("environment seal rollback journal is invalid")
for item in journal.get("files", []):
    file = item.get("path")
    if not isinstance(file, str) or not os.path.isabs(file):
        raise SystemExit("environment seal rollback path is invalid")
    descriptor = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        identity = os.fstat(descriptor)
        if (
            not stat.S_ISREG(identity.st_mode)
            or identity.st_nlink != 1
            or str(identity.st_dev) != item.get("dev")
            or str(identity.st_ino) != item.get("ino")
            or identity.st_uid != 0
            or stat.S_IMODE(identity.st_mode) != 0o440
        ):
            raise SystemExit("sealed environment identity changed before rollback")
        os.fchown(descriptor, int(item["uid"]), int(item["gid"]))
        os.fchmod(descriptor, int(item["mode"]))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(os.path.dirname(file), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
os.unlink(journal_path)
directory = os.open(os.path.dirname(journal_path), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}
cleanup() {
  local status=$?
  [ -z "$sudoers_tmp" ] || rm -f -- "$sudoers_tmp"
  if [ "$ENV_SEAL_COMMITTED" != true ]; then
    restore_environment_seal
  fi
  return "$status"
}
trap cleanup EXIT

# A power loss may bypass EXIT. The next reviewed rerun first restores the
# inode-bound pre-seal identity before starting a new transaction.
restore_environment_seal
python3 - "$ENV_SEAL_JOURNAL" "$WORKER_USER" \
  /home/dominguez/telegram-hub-bot \
  /home/dominguez/telegram-hub-bot-staging \
  /srv/nexus-release/production \
  /srv/nexus-release/staging <<'PY'
import json, os, pwd, stat, sys
journal_path, worker_name, *candidates = sys.argv[1:]
worker = pwd.getpwnam(worker_name)
seen = set()
files = []
role_candidates = {
    "production": (candidates[0], candidates[2]),
    "staging": (candidates[1], candidates[3]),
}
for role, choices in role_candidates.items():
    existing = {os.path.realpath(candidate) for candidate in choices if os.path.exists(candidate)}
    if len(existing) != 1:
        raise SystemExit(f"exactly one canonical {role} environment base is required")
    base = existing.pop()
    if base in seen:
        raise SystemExit("production and staging environment bases must be distinct")
    seen.add(base)
    if not os.path.isabs(base) or not os.path.isdir(base):
        raise SystemExit("release environment base is unsafe")
    directory = os.open(
        base,
        os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        descriptor = os.open(
            ".env",
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory,
        )
        try:
            identity = os.fstat(descriptor)
            if (
                not stat.S_ISREG(identity.st_mode)
                or identity.st_nlink != 1
                or identity.st_size < 1
                or identity.st_size > 256 * 1024
                or identity.st_uid not in (0, worker.pw_uid)
                or identity.st_gid not in (0, worker.pw_gid)
                or stat.S_IMODE(identity.st_mode) not in (0o400, 0o440, 0o600, 0o640)
            ):
                raise SystemExit("release environment input identity is unsafe")
            files.append({
                "path": os.path.join(base, ".env"),
                "uid": identity.st_uid,
                "gid": identity.st_gid,
                "mode": stat.S_IMODE(identity.st_mode),
                "dev": str(identity.st_dev),
                "ino": str(identity.st_ino),
            })
        finally:
            os.close(descriptor)
    finally:
        os.close(directory)
if len(files) != 2 or len({(item["dev"], item["ino"]) for item in files}) != 2:
    raise SystemExit("exactly two distinct production/staging environment files are required")
temporary = f"{journal_path}.next.{os.getpid()}"
descriptor = os.open(
    temporary,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
    0o600,
)
try:
    body = (json.dumps({
        "schema": "nexus.release-bootstrap-environment-seal.v1",
        "files": files,
    }, indent=2) + "\n").encode()
    offset = 0
    while offset < len(body):
        offset += os.write(descriptor, body[offset:])
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
os.rename(temporary, journal_path)
directory = os.open(os.path.dirname(journal_path), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
for item in files:
    descriptor = os.open(
        item["path"],
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        identity = os.fstat(descriptor)
        if (
            str(identity.st_dev) != item["dev"]
            or str(identity.st_ino) != item["ino"]
            or identity.st_uid != item["uid"]
            or identity.st_gid != item["gid"]
            or stat.S_IMODE(identity.st_mode) != item["mode"]
        ):
            raise SystemExit("release environment changed before sealing")
        os.fchown(descriptor, 0, worker.pw_gid)
        os.fchmod(descriptor, 0o440)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(os.path.dirname(item["path"]), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
PY

sudoers_tmp="$(mktemp)"
{
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control version\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control assert-idle\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control assert-layout-ready\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control prepare-runtime-target *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control prepare-staging-runtime-target *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control seal-runtime *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control seal-staging-runtime *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control verify-staging-runtime *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control attest-staging-runtime *\n' "$WORKER_USER"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/nexus-release-promotion-control fetch-staging-evidence *\n' "$WORKER_USER"
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
[ "$(systemctl show pm2-dominguez.service -p LoadState --value)" = loaded ] \
  && [ "$(systemctl is-enabled pm2-dominguez.service)" = enabled ] || {
  echo "pm2-dominguez must be the one enabled PM2 boot authority" >&2
  exit 1
}
verify_effective_pm2_application_unit \
  "$pm2_dropin/nexus-release-recovery.conf"
[ "$(systemctl show pm2-root.service -p LoadState --value 2>/dev/null || printf not-found)" = not-found ] \
  || [ "$(systemctl is-enabled pm2-root.service 2>/dev/null || true)" = masked ] || {
  echo "pm2-root remains a competing PM2 boot authority" >&2
  exit 1
}
[ "$(systemctl show nexus-cloudflared.service -p LoadState --value)" = loaded ] \
  && [ "$(systemctl is-enabled nexus-cloudflared.service)" = enabled ] || {
  echo "the governed customer ingress service must be loaded and enabled" >&2
  exit 1
}
# No cron/manual connector may bypass the pm2-dominguez readiness edge.
python3 - <<'PY'
import pathlib
expected = "/system.slice/nexus-cloudflared.service"
unexpected = []
for comm in pathlib.Path("/proc").glob("[0-9]*/comm"):
    try:
        if comm.read_text().strip() != "cloudflared":
            continue
        cgroup = comm.with_name("cgroup").read_text().splitlines()
        if not any(line.endswith(expected) for line in cgroup):
            unexpected.append(comm.parent.name)
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
if unexpected:
    raise SystemExit("a cloudflared process bypasses the governed ingress unit")
PY
systemctl enable nexus-release-layout-recovery.service
systemctl enable nexus-release-promotion-recovery.service
# Re-attest the separately installed closure after every root-owned bootstrap
# mutation and before disarming the marker that blocks release commands.
verify_exact_root_pm2_prerequisite
rm -f -- "$ENV_SEAL_JOURNAL"
fsync_path /var/lib/nexus-release-promotion
ENV_SEAL_COMMITTED=true
durable_remove "$BOOTSTRAP_JOURNAL"
provenance_public_sha256="$(sha256sum "$SERVER_PROVENANCE_PUBLIC_KEY" | cut -d' ' -f1)"
printf '{"ok":true,"controlVersion":"nexus-release-promotion-control.v3","applicationDrAssetsInstalled":true,"applicationDrConfigurationWritten":false,"serviceUser":"%s","workerUser":"%s","serverProvenancePublicKey":"%s","serverProvenancePublicKeySha256":"%s"}\n' \
  "$SERVICE_USER" "$WORKER_USER" "$SERVER_PROVENANCE_PUBLIC_KEY" "$provenance_public_sha256"

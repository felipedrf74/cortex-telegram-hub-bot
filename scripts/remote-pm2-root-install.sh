#!/usr/bin/env bash
# Install an owner-approved, fully offline PM2 closure into a root-controlled
# prefix. Ordinary releases never invoke this one-time maintenance command.
set -euo pipefail
umask 077
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

ARCHIVE="${1:-}"
EXPECTED_SHA256="${2:-}"
EXPECTED_VERSION="${3:-}"
NODE_BIN=/usr/bin/node
TEST_MODE="${NEXUS_RELEASE_TEST_MODE:-0}"
TEST_ROOT="${NEXUS_PM2_TEST_ROOT:-}"

if [ "$EUID" -ne 0 ] && [ "$TEST_MODE" != 1 ]; then
  echo "root PM2 closure installation requires root" >&2
  exit 77
fi
[ "$#" -eq 3 ] || {
  echo "Usage: remote-pm2-root-install.sh <offline-closure.tar.gz> <approved-sha256> <pm2-version>" >&2
  exit 64
}
[[ "$EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ \
    && "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "root PM2 closure identity is invalid" >&2
  exit 64
}
[ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || {
  echo "root PM2 closure archive must be a regular non-symlink file" >&2
  exit 64
}

if [ "$TEST_MODE" = 1 ]; then
  NODE_BIN="${NEXUS_PM2_NODE_BIN:-$NODE_BIN}"
  [ -n "$TEST_ROOT" ] && [[ "$TEST_ROOT" == /* ]] || {
    echo "PM2 test root is required in test mode" >&2
    exit 64
  }
  PREFIX="$TEST_ROOT/opt/nexus-release/pm2"
  LINK="$TEST_ROOT/usr/local/bin/pm2"
  STATE_ROOT="$TEST_ROOT/var/lib/nexus-release-promotion"
  TRUSTED_LOCK="$TEST_ROOT/usr/local/share/nexus-release/pm2-package-lock.json"
else
  PREFIX=/opt/nexus-release/pm2
  LINK=/usr/local/bin/pm2
  STATE_ROOT=/var/lib/nexus-release-promotion
  TRUSTED_LOCK=/usr/local/share/nexus-release/pm2-package-lock.json
  archive_real="$(realpath -e -- "$ARCHIVE")"
  [ "$archive_real" = "$ARCHIVE" ] || {
    echo "root PM2 closure archive path must be canonical" >&2
    exit 77
  }
  current="$ARCHIVE"
  while :; do
    [ "$(stat -c '%U:%G' -- "$current")" = root:root ] \
      && (( (8#$(stat -c '%a' -- "$current") & 0022) == 0 )) || {
      echo "root PM2 closure archive chain is not root-trusted" >&2
      exit 77
    }
    [ "$current" = / ] && break
    current="$(dirname -- "$current")"
  done
fi
[ -f "$TRUSTED_LOCK" ] && [ ! -L "$TRUSTED_LOCK" ] || {
  echo "root PM2 exact package lock is unavailable" >&2
  exit 1
}
[ -x "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] || {
  echo "root PM2 Node runtime is unavailable" >&2
  exit 1
}
NODE_VERSION="$("$NODE_BIN" --version)"
[ "$NODE_VERSION" = v22.23.1 ] || {
  echo "root PM2 Node runtime must be v22.23.1" >&2
  exit 1
}
NODE_SHA256="$(sha256sum -- "$NODE_BIN" | cut -d' ' -f1)"
if [ "$TEST_MODE" != 1 ]; then
  [ "$(stat -c '%U:%G:%a' "$NODE_BIN")" = root:root:755 ] || {
    echo "root PM2 Node runtime identity is unsafe" >&2
    exit 1
  }
fi

observed_sha256="$(sha256sum -- "$ARCHIVE" | cut -d' ' -f1)"
[ "$observed_sha256" = "$EXPECTED_SHA256" ] || {
  echo "root PM2 closure archive digest mismatch" >&2
  exit 1
}

if [ "$TEST_MODE" = 1 ]; then
  install -d -m 755 "$PREFIX" "$(dirname -- "$LINK")"
  install -d -m 700 "$STATE_ROOT"
else
  install -d -o root -g root -m 755 "$PREFIX" "$(dirname -- "$LINK")"
  install -d -o root -g root -m 700 "$STATE_ROOT"
fi
TARGET="$PREFIX/$EXPECTED_VERSION"
JOURNAL="$STATE_ROOT/pm2-install-in-progress.v1.json"
ATTESTATION="$STATE_ROOT/pm2-root-install.v1.json"
fsync_directory() {
  "$NODE_BIN" - "$1" <<'NODE'
const fs=require('fs');const descriptor=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

atomic_rename() {
  local source="$1" destination="$2"
  "$NODE_BIN" - "$source" "$destination" <<'NODE'
const fs=require('fs');const path=require('path');const [source,destination]=process.argv.slice(2);
if(path.dirname(source)!==path.dirname(destination)
 ||fs.lstatSync(source).isSymbolicLink())process.exit(1);
fs.renameSync(source,destination);
const descriptor=fs.openSync(path.dirname(destination),'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

remove_incomplete_install() {
  if [ -f "$LINK" ] && [ ! -L "$LINK" ]; then
    rm -f -- "$LINK"
  elif [ -e "$LINK" ] || [ -L "$LINK" ]; then
    echo "incomplete PM2 install cannot remove an unrelated launcher" >&2
    return 1
  fi
  if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then rm -rf -- "$TARGET"; fi
  if [ -e "$ATTESTATION" ] || [ -L "$ATTESTATION" ]; then
    [ -f "$ATTESTATION" ] && [ ! -L "$ATTESTATION" ] || {
      echo "incomplete PM2 install attestation is unsafe" >&2
      return 1
    }
    rm -f -- "$ATTESTATION"
  fi
  fsync_directory "$PREFIX"
  fsync_directory "$(dirname -- "$LINK")"
  fsync_directory "$STATE_ROOT"
}

if [ -e "$JOURNAL" ] || [ -L "$JOURNAL" ]; then
  [ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || {
    echo "root PM2 install journal is unsafe" >&2
    exit 1
  }
  "$NODE_BIN" - "$JOURNAL" "$EXPECTED_VERSION" "$EXPECTED_SHA256" "$TARGET" "$LINK" <<'NODE'
const fs=require('fs');const [file,version,archiveSha256,target,launcher]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(file,'utf8'));
if(x.schema!=='nexus.pm2-root-install-journal.v1'||x.version!==version
 ||x.archiveSha256!==archiveSha256||x.target!==target||x.launcher!==launcher
 ||!['prepared','target_moved','launcher_moved'].includes(x.phase))process.exit(1);
NODE
  remove_incomplete_install
  rm -f -- "$JOURNAL"
fi
if [ -e "$TARGET" ] || [ -L "$TARGET" ] || [ -e "$LINK" ] || [ -L "$LINK" ] \
    || [ -e "$ATTESTATION" ] || [ -L "$ATTESTATION" ]; then
  echo "root PM2 closure state already exists; refusing an implicit replacement" >&2
  exit 73
fi

write_journal() {
  local phase="$1" temporary
  temporary="$(mktemp "$STATE_ROOT/.pm2-install-journal.next.XXXXXXXX")"
  "$NODE_BIN" - "$temporary" "$phase" "$EXPECTED_VERSION" "$EXPECTED_SHA256" "$TARGET" "$LINK" <<'NODE'
const fs=require('fs');const [output,phase,version,archiveSha256,target,launcher]=process.argv.slice(2);
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.pm2-root-install-journal.v1',phase,version,archiveSha256,target,launcher,
 updatedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
const descriptor=fs.openSync(output,'r');try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
  chmod 600 "$temporary"
  if [ "$TEST_MODE" != 1 ]; then chown root:root "$temporary"; fi
  atomic_rename "$temporary" "$JOURNAL"
}

write_journal prepared
TEMPORARY="$(mktemp -d "$PREFIX/.${EXPECTED_VERSION}.next.XXXXXXXX")"
TARGET_MOVED=false
LINK_MOVED=false
ATTESTATION_MOVED=false
cleanup() {
  status=$?
  rm -rf -- "$TEMPORARY"
  if [ "$status" -ne 0 ]; then
    if [ "$LINK_MOVED" = true ]; then rm -f -- "$LINK"; fi
    if [ "$TARGET_MOVED" = true ]; then rm -rf -- "$TARGET"; fi
    if [ "$ATTESTATION_MOVED" = true ]; then rm -f -- "$ATTESTATION"; fi
    rm -f -- "$JOURNAL"
  fi
}
trap cleanup EXIT
maybe_crash() {
  if [ "$TEST_MODE" = 1 ] && [ "${NEXUS_PM2_TEST_CRASH_PHASE:-}" = "$1" ]; then
    kill -KILL "$$"
  fi
}

EXTRACTION="$(
  python3 - "$ARCHIVE" "$TEMPORARY" "$EXPECTED_VERSION" "$EXPECTED_SHA256" "$TRUSTED_LOCK" <<'PY'
import hashlib
import json
import os
import pathlib
import stat
import sys
import tarfile

archive_path, output_path, expected_version, expected_archive_sha256, trusted_lock_path = sys.argv[1:]
prefix = "pm2-closure"
seen = set()
regular = {}
total = 0
with open(archive_path, "rb") as source:
    if hashlib.sha256(source.read()).hexdigest() != expected_archive_sha256:
        raise SystemExit("root PM2 closure archive changed while it was verified")
with tarfile.open(archive_path, "r:*") as archive:
    for member in archive.getmembers():
        pure = pathlib.PurePosixPath(member.name)
        if (
            member.name in seen
            or pure.is_absolute()
            or any(part in ("", ".", "..") for part in pure.parts)
            or pure.parts[0] != prefix
        ):
            raise SystemExit("root PM2 closure archive contains an unsafe or duplicate member")
        seen.add(member.name)
        if member.isdir():
            continue
        if not member.isreg() or member.issym() or member.islnk():
            raise SystemExit("root PM2 closure archive contains a link or special member")
        relative = pathlib.PurePosixPath(*pure.parts[1:])
        if not relative.parts:
            raise SystemExit("root PM2 closure archive member has no relative path")
        total += member.size
        if member.size < 0 or member.size > 64 * 1024 * 1024 or total > 512 * 1024 * 1024:
            raise SystemExit("root PM2 closure archive exceeds the bounded size")
        regular[str(relative)] = member
    if len(regular) == 0 or len(regular) > 100000:
        raise SystemExit("root PM2 closure archive file count is invalid")
    for required in (
        "package.json",
        "package-lock.json",
        "node_modules/pm2/package.json",
        "node_modules/pm2/bin/pm2",
        "closure-manifest.json",
    ):
        if required not in regular:
            raise SystemExit(f"root PM2 closure archive is missing {required}")
    package_file = archive.extractfile(regular["node_modules/pm2/package.json"])
    if package_file is None:
        raise SystemExit("root PM2 package identity is unreadable")
    package = json.load(package_file)
    if package.get("name") != "pm2" or package.get("version") != expected_version:
        raise SystemExit("root PM2 package version mismatch")
    manifest_file = archive.extractfile(regular["closure-manifest.json"])
    if manifest_file is None:
        raise SystemExit("root PM2 closure manifest is unreadable")
    manifest = json.load(manifest_file)
    trusted_lock_body = pathlib.Path(trusted_lock_path).read_bytes()
    trusted_lock = json.loads(trusted_lock_body)
    locked_packages = []
    for package_path, identity in trusted_lock.get("packages", {}).items():
        if not package_path:
            continue
        if str(identity.get("resolved", "")).startswith("https://") and (
            not identity.get("version") or not identity.get("integrity")
        ):
            raise SystemExit("root PM2 trusted lock lacks a registry integrity")
        locked_packages.append({
            "path": package_path,
            "version": identity.get("version"),
            "resolved": identity.get("resolved"),
            "integrity": identity.get("integrity"),
        })
    locked_packages.sort(key=lambda item: item["path"])
    declared_files = manifest.get("files")
    if (
        manifest.get("schema") != "nexus.pm2-root-closure-manifest.v1"
        or manifest.get("pm2Version") != expected_version
        or manifest.get("nodeVersion") != "v22.23.1"
        or manifest.get("npmVersion") != "10.9.8"
        or manifest.get("packageLockSha256") != hashlib.sha256(trusted_lock_body).hexdigest()
        or manifest.get("packageLockPackages") != locked_packages
        or not isinstance(manifest.get("installedPackages"), list)
        or not isinstance(declared_files, list)
    ):
        raise SystemExit("root PM2 closure manifest does not match the trusted exact lock")
    observed_payload = []
    for relative, member in sorted(regular.items()):
        if relative == "closure-manifest.json":
            continue
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit("root PM2 closure payload member is unreadable")
        body = extracted.read()
        observed_payload.append({
            "path": relative,
            "size": len(body),
            "mode": 0o755 if member.mode & 0o111 else 0o644,
            "sha256": hashlib.sha256(body).hexdigest(),
        })
    payload = {"schema": "nexus.pm2-root-closure-payload.v1", "files": observed_payload}
    payload_digest = hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()
    if (
        declared_files != observed_payload
        or manifest.get("fileCount") != len(observed_payload)
        or manifest.get("payloadDigest") != payload_digest
    ):
        raise SystemExit("root PM2 closure payload differs from its exact-lock manifest")
    installed_packages = []
    for identity in locked_packages:
        relative = f"{identity['path']}/package.json"
        member = regular.get(relative)
        if member is None:
            lock_identity = trusted_lock["packages"][identity["path"]]
            if lock_identity.get("optional") is True:
                continue
            raise SystemExit("root PM2 closure omits a required locked package")
        package_member = archive.extractfile(member)
        if package_member is None:
            raise SystemExit("root PM2 installed package identity is unreadable")
        installed_identity = json.load(package_member)
        if installed_identity.get("version") != identity["version"]:
            raise SystemExit("root PM2 installed package differs from exact lock")
        installed_packages.append({"path": identity["path"], "version": identity["version"]})
    if manifest.get("installedPackages") != installed_packages:
        raise SystemExit("root PM2 installed package set differs from its manifest")
    for relative, member in sorted(regular.items()):
        target = pathlib.Path(output_path, relative)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit("root PM2 closure member is unreadable")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(target, flags, 0o700 if member.mode & 0o111 else 0o600)
        try:
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = extracted.read(1024 * 1024)
                if not chunk:
                    break
                os.write(descriptor, chunk)
                digest.update(chunk)
                size += len(chunk)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if size != member.size:
            raise SystemExit("root PM2 closure member size changed")
        mode = 0o755 if member.mode & 0o111 else 0o644
        os.chmod(target, mode)

files = []
root = pathlib.Path(output_path)
for candidate in sorted(root.rglob("*")):
    observed = candidate.lstat()
    if stat.S_ISLNK(observed.st_mode):
        raise SystemExit("root PM2 closure extraction contains a symlink")
    if candidate.is_dir():
        candidate.chmod(0o755)
        continue
    if not candidate.is_file():
        raise SystemExit("root PM2 closure extraction contains a special file")
    body = candidate.read_bytes()
    files.append({
        "path": candidate.relative_to(root).as_posix(),
        "size": len(body),
        "mode": stat.S_IMODE(observed.st_mode),
        "sha256": hashlib.sha256(body).hexdigest(),
    })
payload = {"schema": "nexus.pm2-root-closure.v1", "files": files}
body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
print(json.dumps({
    "schema": "nexus.pm2-root-extraction.v1",
    "closureDigest": hashlib.sha256(body).hexdigest(),
    "payloadDigest": payload_digest,
    "packageLockSha256": hashlib.sha256(trusted_lock_body).hexdigest(),
    "fileCount": len(files),
}, separators=(",", ":")))
PY
)"

if [ "$TEST_MODE" != 1 ]; then chown -R root:root "$TEMPORARY"; fi
chmod 755 "$TEMPORARY"
atomic_rename "$TEMPORARY" "$TARGET"
TARGET_MOVED=true
write_journal target_moved
maybe_crash target_moved
LINK_NEXT="${LINK}.next.$$"
"$NODE_BIN" - "$LINK_NEXT" "$NODE_BIN" "$TARGET/node_modules/pm2/bin/pm2" <<'NODE'
const fs=require('fs');const [output,nodeBin,entrypoint]=process.argv.slice(2);
fs.writeFileSync(output,`#!/usr/bin/bash\nexec ${JSON.stringify(nodeBin)} ${JSON.stringify(entrypoint)} "$@"\n`,
 {mode:0o755,flag:'wx'});
const descriptor=fs.openSync(output,'r');try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
chmod 755 "$LINK_NEXT"
if [ "$TEST_MODE" != 1 ]; then chown root:root "$LINK_NEXT"; fi
atomic_rename "$LINK_NEXT" "$LINK"
LINK_MOVED=true
if [ "$TEST_MODE" != 1 ]; then chown -h root:root "$LINK"; fi
write_journal launcher_moved
maybe_crash launcher_moved

ATTESTATION_NEXT="$(mktemp "$STATE_ROOT/.pm2-root-install.next.XXXXXXXX")"
"$NODE_BIN" - "$ATTESTATION_NEXT" "$EXPECTED_VERSION" "$EXPECTED_SHA256" "$TARGET" "$LINK" \
  "$EXTRACTION" "$NODE_BIN" "$NODE_VERSION" "$NODE_SHA256" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [output,version,sourceArchiveSha256,closureRoot,launcher,extractionJson,
 nodeBin,nodeVersion,nodeSha256]=process.argv.slice(2);
const extraction=JSON.parse(extractionJson);
if(extraction.schema!=='nexus.pm2-root-extraction.v1'
 ||!/^[a-f0-9]{64}$/u.test(extraction.closureDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(extraction.payloadDigest||'')
 ||!/^[a-f0-9]{64}$/u.test(extraction.packageLockSha256||'')
 ||!Number.isSafeInteger(extraction.fileCount)||extraction.fileCount<2)process.exit(1);
fs.writeFileSync(output,`${JSON.stringify({
 schema:'nexus.pm2-root-install.v1',version,sourceArchiveSha256,
 closureDigest:extraction.closureDigest,payloadDigest:extraction.payloadDigest,
 packageLockSha256:extraction.packageLockSha256,fileCount:extraction.fileCount,
 closureRoot,launcher,launcherSha256:crypto.createHash('sha256').update(fs.readFileSync(launcher)).digest('hex'),
 entrypoint:`${closureRoot}/node_modules/pm2/bin/pm2`,
 node:{path:nodeBin,version:nodeVersion,sha256:nodeSha256},
 installedAt:new Date().toISOString(),
},null,2)}\n`,{mode:0o600,flag:'w'});
const descriptor=fs.openSync(output,'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
chmod 600 "$ATTESTATION_NEXT"
if [ "$TEST_MODE" != 1 ]; then chown root:root "$ATTESTATION_NEXT"; fi
atomic_rename "$ATTESTATION_NEXT" "$ATTESTATION"
ATTESTATION_MOVED=true
"$NODE_BIN" - "$STATE_ROOT" <<'NODE'
const fs=require('fs');const descriptor=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
rm -f -- "$JOURNAL"
fsync_directory "$STATE_ROOT"
TARGET_MOVED=false
LINK_MOVED=false
ATTESTATION_MOVED=false
trap - EXIT
printf '{"ok":true,"schema":"nexus.pm2-root-install.v1","version":"%s","archiveSha256":"%s"}\n' \
  "$EXPECTED_VERSION" "$EXPECTED_SHA256"

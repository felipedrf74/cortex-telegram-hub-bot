#!/usr/bin/env bash
# Register an independently pinned owner-signed runtime bundle and collect one
# nonce-bound live guest measurement. The collector is the sole readiness
# writer. It never accepts a caller-provided guest attestation.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

VERSION="nexus-rollback-drill-vm-runtime-readiness.v2"
STATE_ROOT="/var/lib/nexus-rollback-drill-vm"
ACTIVE_RECEIPT="$STATE_ROOT/active.json"
BUNDLE_PARENT="$STATE_ROOT/runtime-bundles"
READINESS_PARENT="$STATE_ROOT/runtime-readiness"
PENDING_PARENT="$STATE_ROOT/runtime-readiness-pending"
EVIDENCE_PARENT="$STATE_ROOT/runtime-evidence"
CONTROL_LOCK="$STATE_ROOT/runtime-readiness-control.lock"
ADMISSION_LOCK="/run/nexus-rollback-drill-vm/admission.lock"
ACTIVE_LOCK="/run/nexus-rollback-drill-vm/active.lock"
SHARED_MUTEX="/run/lock/nexus-release-sonar.lock"
HANDOFF_DIR="/run/nexus-rollback-drill-vm/handoff"
OWNER_ROOT="/etc/nexus-rollback-drill-vm"
OWNER_PUBLIC_KEY="$OWNER_ROOT/runtime-owner-public-key.pem"
OWNER_PUBLIC_KEY_DIGEST="$OWNER_ROOT/runtime-owner-public-key.sha256"
MANIFEST_HELPER="/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest"
GUEST_CONTROL="/usr/local/sbin/nexus-rollback-drill-vm-runtime-control"
MEASUREMENT_NAMESPACE="nexus-rollback-drill-vm-runtime-measurement"

die() {
  echo "rollback drill VM runtime readiness: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  runtime-readiness version
  runtime-readiness pin-owner-key <public-key.pem> <expected-sha256>
  runtime-readiness register-bundle <untrusted-bundle-root> <manifest-sha256>
  runtime-readiness collect \
    <guest-1|guest-2|guest-3> <provision-receipt-sha256> \
    <bundle-manifest-sha256> <lab-ssh-private-key> \
    <owner-authorization.json> <owner-authorization.sig> \
    <ssh-disconnect-after-pm2-stop|failed-health-check|host-reboot-during-promotion>
EOF
  exit 64
}

fsync_path() {
  python3 - "$1" <<'PY'
import os,sys
descriptor=os.open(sys.argv[1],os.O_RDONLY)
try: os.fsync(descriptor)
finally: os.close(descriptor)
PY
}

durable_remove() {
  local path="$1"
  rm -f -- "$path"
  fsync_path "$(dirname -- "$path")"
}

validate_root_chain() {
  local path="$1" label="$2" kind="$3" current mode
  [[ "$path" == /* && "$path" != / && ! -L "$path" ]] \
    || die "$label must be one absolute non-symlink path"
  [ "$(realpath -e -- "$path")" = "$path" ] \
    || die "$label must be canonical and may not traverse symlinks"
  case "$kind" in
    file) [ -f "$path" ] && [ ! -L "$path" ] || die "$label must be a regular file" ;;
    directory) [ -d "$path" ] && [ ! -L "$path" ] || die "$label must be a directory" ;;
    *) die "internal path-kind error" ;;
  esac
  current="$path"
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

copy_root_bounded() {
  local source="$1" destination="$2" minimum="$3" maximum="$4"
  python3 - "$source" "$destination" "$minimum" "$maximum" <<'PY'
import os,stat,sys
source,destination,minimum,maximum=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
flags=os.O_RDONLY|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0)
descriptor=os.open(source,flags)
try:
 before=os.fstat(descriptor)
 if (
  not stat.S_ISREG(before.st_mode) or before.st_nlink!=1
  or before.st_size<minimum or before.st_size>maximum
 ):
  raise SystemExit("source is not one bounded regular file")
 output=os.open(
  destination,
  os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),
  0o600,
 )
 try:
  copied=0
  while copied<before.st_size:
   chunk=os.read(descriptor,min(1024*1024,before.st_size-copied))
   if not chunk: break
   view=memoryview(chunk)
   while view:
    written=os.write(output,view)
    if written<=0: raise SystemExit("short write during root copy")
    view=view[written:]
   copied+=len(chunk)
  os.fsync(output)
 finally:
  os.close(output)
 after=os.fstat(descriptor)
 if (
  copied!=before.st_size
  or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)
    !=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)
 ):
  raise SystemExit("source changed during root copy")
finally:
 os.close(descriptor)
PY
}

load_pinned_owner_key() {
  validate_root_chain "$OWNER_ROOT" "owner-key directory" directory
  validate_root_chain "$OWNER_PUBLIC_KEY" "pinned owner public key" file
  validate_root_chain "$OWNER_PUBLIC_KEY_DIGEST" "pinned owner key digest" file
  [ "$(stat -c '%U:%G:%a:%h' -- "$OWNER_PUBLIC_KEY")" = root:root:400:1 ] \
    || die "pinned owner public key mode is unsafe"
  [ "$(stat -c '%U:%G:%a:%h' -- "$OWNER_PUBLIC_KEY_DIGEST")" = root:root:400:1 ] \
    || die "pinned owner public-key digest mode is unsafe"
  PINNED_OWNER_FILE_SHA256="$(tr -d '\n' <"$OWNER_PUBLIC_KEY_DIGEST")"
  [[ "$PINNED_OWNER_FILE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || die "pinned owner public-key digest is invalid"
  [ "$(sha256sum -- "$OWNER_PUBLIC_KEY" | cut -d' ' -f1)" = "$PINNED_OWNER_FILE_SHA256" ] \
    || die "pinned owner public key differs from its independent digest"
  [ "$(openssl pkey -pubin -in "$OWNER_PUBLIC_KEY" -text_pub -noout | head -n 1)" \
      = "ED25519 Public-Key:" ] \
    || die "pinned owner public key is not Ed25519"
  PINNED_OWNER_IDENTITY_SHA256="$(
    openssl pkey -pubin -in "$OWNER_PUBLIC_KEY" -outform DER \
      | sha256sum | cut -d' ' -f1
  )"
  [[ "$PINNED_OWNER_IDENTITY_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || die "pinned owner public-key identity is invalid"
}

pin_owner_key() {
  local source="$1" expected="$2" stage digest_stage observed
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] \
    || die "owner public-key digest is invalid"
  install -d -o root -g root -m 0700 "$OWNER_ROOT"
  if [ -e "$OWNER_PUBLIC_KEY" ] || [ -L "$OWNER_PUBLIC_KEY" ] \
      || [ -e "$OWNER_PUBLIC_KEY_DIGEST" ] || [ -L "$OWNER_PUBLIC_KEY_DIGEST" ]; then
    [ -f "$OWNER_PUBLIC_KEY" ] && [ ! -L "$OWNER_PUBLIC_KEY" ] \
      || die "partial pinned owner-key state requires owner inspection"
    observed="$(sha256sum -- "$OWNER_PUBLIC_KEY" | cut -d' ' -f1)"
    [ "$observed" = "$expected" ] \
      || die "owner public key is already pinned to a different identity"
    if [ ! -e "$OWNER_PUBLIC_KEY_DIGEST" ] && [ ! -L "$OWNER_PUBLIC_KEY_DIGEST" ]; then
      digest_stage="$(mktemp "$OWNER_ROOT/.owner-digest.XXXXXXXX")"
      printf '%s\n' "$expected" >"$digest_stage"
      chown root:root "$digest_stage"
      chmod 0400 "$digest_stage"
      fsync_path "$digest_stage"
      mv -T -- "$digest_stage" "$OWNER_PUBLIC_KEY_DIGEST"
      fsync_path "$OWNER_ROOT"
    fi
    load_pinned_owner_key
    [ "$PINNED_OWNER_FILE_SHA256" = "$expected" ] \
      || die "pinned owner public-key file digest differs"
    printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-owner-key.v1","sha256":"%s","alreadyPresent":true}\n' "$expected"
    return
  fi
  stage="$(mktemp "$OWNER_ROOT/.owner-key.XXXXXXXX")"
  rm -f -- "$stage"
  copy_root_bounded "$source" "$stage" 32 65536
  observed="$(sha256sum -- "$stage" | cut -d' ' -f1)"
  [ "$observed" = "$expected" ] \
    || die "owner public key differs from the approved digest"
  [ "$(openssl pkey -pubin -in "$stage" -text_pub -noout | head -n 1)" \
      = "ED25519 Public-Key:" ] \
    || die "owner public key is not Ed25519"
  chown root:root "$stage"
  chmod 0400 "$stage"
  fsync_path "$stage"
  mv -T -- "$stage" "$OWNER_PUBLIC_KEY"
  fsync_path "$OWNER_ROOT"
  digest_stage="$(mktemp "$OWNER_ROOT/.owner-digest.XXXXXXXX")"
  printf '%s\n' "$expected" >"$digest_stage"
  chown root:root "$digest_stage"
  chmod 0400 "$digest_stage"
  fsync_path "$digest_stage"
  mv -T -- "$digest_stage" "$OWNER_PUBLIC_KEY_DIGEST"
  fsync_path "$OWNER_ROOT"
  load_pinned_owner_key
  printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-owner-key.v1","sha256":"%s","alreadyPresent":false}\n' "$expected"
}

register_bundle() {
  local source="$1" manifest_sha="$2"
  [[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] \
    || die "bundle manifest digest is invalid"
  load_pinned_owner_key
  install -d -o root -g root -m 0700 "$BUNDLE_PARENT"
  python3 "$MANIFEST_HELPER" stage-bundle \
    --source-root "$source" \
    --target-parent "$BUNDLE_PARENT" \
    --expected-manifest-sha256 "$manifest_sha" \
    --expected-public-key-sha256 "$PINNED_OWNER_FILE_SHA256"
}

verify_registered_bundle() {
  local manifest_sha="$1"
  BUNDLE_ROOT="$BUNDLE_PARENT/$manifest_sha"
  validate_root_chain "$BUNDLE_PARENT" "runtime bundle registry" directory
  validate_root_chain "$BUNDLE_ROOT" "registered runtime bundle" directory
  [ "$(stat -c '%U:%G:%a' -- "$BUNDLE_PARENT")" = root:root:700 ] \
    || die "runtime bundle registry mode is unsafe"
  [ "$(sha256sum -- "$BUNDLE_ROOT/manifest.json" | cut -d' ' -f1)" = "$manifest_sha" ] \
    || die "registered runtime manifest identity drifted"
  [ "$(sha256sum -- "$BUNDLE_ROOT/manifest-owner-public-key.pem" | cut -d' ' -f1)" \
      = "$PINNED_OWNER_FILE_SHA256" ] \
    || die "registered bundle is not signed by the independently pinned owner"
  cmp -s -- "$OWNER_PUBLIC_KEY" "$BUNDLE_ROOT/manifest-owner-public-key.pem" \
    || die "registered bundle owner public key bytes differ from the pin"
  openssl pkeyutl -verify \
    -pubin \
    -inkey "$OWNER_PUBLIC_KEY" \
    -rawin \
    -in "$BUNDLE_ROOT/manifest.json" \
    -sigfile "$BUNDLE_ROOT/manifest.sig" >/dev/null \
    || die "registered runtime bundle owner signature is invalid"
  python3 "$MANIFEST_HELPER" verify \
    --bundle-root "$BUNDLE_ROOT" \
    --manifest "$BUNDLE_ROOT/manifest.json" \
    --expected-manifest-sha256 "$manifest_sha" >/dev/null
}

validate_lock_path() {
  local path="$1" owner="$2"
  [ -f "$path" ] && [ ! -L "$path" ] \
    && [ "$(realpath -e -- "$path")" = "$path" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$path")" = "$owner:660:1" ] \
    || die "orchestration lock is missing or unsafe: $path"
}

process_start_time() {
  python3 - "$1" <<'PY'
import pathlib,sys
body=pathlib.Path(f"/proc/{sys.argv[1]}/stat").read_text(encoding="ascii")
print(body[body.rfind(") ")+2:].split()[19])
PY
}

checkpoint_journal_status() {
  local journal="$1" status="$2"
  python3 - "$journal" "$status" <<'PY'
import json,os,pathlib,stat,sys
path=pathlib.Path(sys.argv[1]);status=sys.argv[2]
if status not in {"qemu_exited","readiness_published"}:
 raise SystemExit("journal checkpoint status is invalid")
value=json.loads(path.read_text(encoding="utf-8"))
if value.get("schema")!="nexus.rollback-drill-vm-runtime-collection-journal.v1":
 raise SystemExit("journal checkpoint schema is invalid")
value["status"]=status
stage=path.parent/f".{path.name}.checkpoint"
try:
 stale=stage.lstat()
except FileNotFoundError:
 pass
else:
 if (
  not stat.S_ISREG(stale.st_mode) or stale.st_nlink!=1
  or stale.st_uid!=os.geteuid() or stat.S_IMODE(stale.st_mode)!=0o600
  or stale.st_size>524288
 ):
  raise SystemExit("journal checkpoint partial is unsafe")
 stage.unlink()
 directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(directory)
 finally:os.close(directory)
descriptor=os.open(
 stage,
 os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),
 0o600,
)
try:
 try:
  body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
  os.write(descriptor,body);os.fsync(descriptor)
 finally:os.close(descriptor)
 os.rename(stage,path)
 directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(directory)
 finally:os.close(directory)
except BaseException:
 removed=False
 try:stage.unlink();removed=True
 except FileNotFoundError:pass
 if removed:
  directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(directory)
  finally:os.close(directory)
 raise
PY
}

snapshot_live_guest() {
  local supervisor_pid="$1" output="$2"
  python3 - \
    "$supervisor_pid" "$SET_ID" "$GUEST" "$PORT" "$MACHINE_UUID" "$MAC" \
    "$INSTANCE_ID" "$OVERLAY_PATH" "$SEED_PATH" "$QEMU_BINARY" \
    "$QEMU_SHA256" "$SHARED_MUTEX" "$ACTIVE_LOCK" "$output" <<'PY'
import hashlib,json,os,pathlib,socket,stat,sys
(
 supervisor_text,set_id,guest,port_text,uuid,mac,instance_id,overlay,seed,
 qemu_binary,qemu_sha,shared_lock,active_lock,output,
)=sys.argv[1:]
supervisor=int(supervisor_text);port=int(port_text)
def start_time(pid):
 body=pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
 return body[body.rfind(") ")+2:].split()[19]
supervisor_start=start_time(supervisor)
supervisor_cmd=pathlib.Path(f"/proc/{supervisor}/cmdline").read_bytes()
if (
 b"\0"+b"/usr/local/libexec/nexus-rollback-drill-vm/run"+b"\0" not in b"\0"+supervisor_cmd
 or not supervisor_cmd.endswith(guest.encode()+b"\0")
):
 raise SystemExit("systemd MainPID is not the reviewed guest runner")
children=pathlib.Path(f"/proc/{supervisor}/task/{supervisor}/children").read_text().split()
if len(children)!=1 or not children[0].isdigit():
 raise SystemExit("runner must own exactly one live QEMU child")
qemu=int(children[0]);qemu_start=start_time(qemu)
if os.path.realpath(f"/proc/{qemu}/exe")!=qemu_binary:
 raise SystemExit("runner child is not the reviewed QEMU executable")
digest=hashlib.sha256()
with open(qemu_binary,"rb") as handle:
 while chunk:=handle.read(1024*1024):digest.update(chunk)
if digest.hexdigest()!=qemu_sha:
 raise SystemExit("live QEMU executable digest drifted")
cmdline=pathlib.Path(f"/proc/{qemu}/cmdline").read_bytes().split(b"\0")
if cmdline and cmdline[-1]==b"":cmdline.pop()
expected=[
 qemu_binary,"-name",instance_id,"-enable-kvm","-machine","q35,accel=kvm",
 "-cpu","host","-smp","4","-m","14336","-uuid",uuid,"-nodefaults",
 "-no-user-config","-display","none","-serial","none","-parallel","none",
 "-monitor","none","-device","virtio-scsi-pci,id=scsi0","-drive",
 f"file={overlay},if=none,id=rootdisk,format=qcow2,cache=writeback",
 "-device","scsi-hd,drive=rootdisk,bootindex=1","-drive",
 f"file={seed},if=none,id=seed,format=raw,readonly=on","-device",
 "scsi-cd,drive=seed","-netdev",
 f"user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:{port}-:22",
 "-device",f"virtio-net-pci,netdev=net0,mac={mac}","-object",
 "rng-random,id=rng0,filename=/dev/urandom","-device",
 "virtio-rng-pci,rng=rng0",
]
observed=[part.decode("utf-8","strict") for part in cmdline]
if observed!=expected:
 raise SystemExit("live QEMU command line differs from the exact slot contract")
def fd_matches(fd,path):
 fd_path=f"/proc/{supervisor}/fd/{fd}"
 return (
  os.path.realpath(fd_path)==path
  and os.stat(fd_path).st_dev==os.stat(path).st_dev
  and os.stat(fd_path).st_ino==os.stat(path).st_ino
 )
if not fd_matches(3,shared_lock) or not fd_matches(4,active_lock):
 raise SystemExit("runner supervisor does not retain both orchestration locks")
target=f"{socket.htonl(0x7f000001):08X}:{port:04X}"
inodes=set()
for table in ("/proc/net/tcp","/proc/net/tcp6"):
 try: lines=pathlib.Path(table).read_text().splitlines()[1:]
 except FileNotFoundError: continue
 for line in lines:
  fields=line.split()
  if fields[1].upper()==target and fields[3]=="0A":
   inodes.add(fields[9])
owned=set()
for fd in pathlib.Path(f"/proc/{qemu}/fd").iterdir():
 try: link=os.readlink(fd)
 except (FileNotFoundError,PermissionError): continue
 if link.startswith("socket:[") and link[8:-1] in inodes:
  owned.add(link[8:-1])
if len(owned)!=1:
 raise SystemExit("live QEMU does not exclusively own the selected loopback listener")
value={
 "supervisorPid":supervisor,
 "supervisorStartTime":supervisor_start,
 "supervisorCmdlineSha256":hashlib.sha256(supervisor_cmd).hexdigest(),
 "qemuPid":qemu,
 "qemuStartTime":qemu_start,
 "qemuExecutable":qemu_binary,
 "qemuExecutableSha256":qemu_sha,
 "qemuCmdlineSha256":hashlib.sha256(b"\0".join(cmdline)+b"\0").hexdigest(),
 "loopbackPortSocketInode":next(iter(owned)),
}
body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
descriptor=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:os.write(descriptor,body);os.fsync(descriptor)
finally:os.close(descriptor)
PY
}

stable_overlay_measurement() {
  local output="$1" mode="$2" holder_pid="$3" holder_start="$4" qemu_pid="$5"
  local expected_user="${6:-nexus-drill-vm}"
  python3 - \
    "$OVERLAY_PATH" "$mode" "$holder_pid" "$holder_start" "$qemu_pid" \
    "$SHARED_MUTEX" "$ACTIVE_LOCK" "$ADMISSION_LOCK" "$expected_user" "$output" <<'PY'
import hashlib,json,os,pathlib,pwd,stat,sys
(
 overlay,mode,holder_text,expected_start,qemu_text,shared_lock,active_lock,
 admission_lock,expected_user,output,
)=sys.argv[1:]
holder=int(holder_text);qemu=int(qemu_text)
def start_time(pid):
 body=pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
 return body[body.rfind(") ")+2:].split()[19]
def prove_lock_holder():
 if start_time(holder)!=expected_start:
  raise SystemExit("orchestration lock-holder identity changed during overlay seal")
 expected=(
  ((3,shared_lock),(4,active_lock)) if mode=="supervisor"
  else ((6,shared_lock),(7,admission_lock),(8,active_lock))
 )
 for fd,path in expected:
  fd_path=f"/proc/{holder}/fd/{fd}"
  if (
   os.path.realpath(fd_path)!=path
   or os.stat(fd_path).st_dev!=os.stat(path).st_dev
   or os.stat(fd_path).st_ino!=os.stat(path).st_ino
  ):
   raise SystemExit("orchestration lock holder released a required lock")
 if mode=="supervisor":
  collector=os.getppid()
  fd_path=f"/proc/{collector}/fd/7"
  if (
   os.path.realpath(fd_path)!=admission_lock
   or os.stat(fd_path).st_dev!=os.stat(admission_lock).st_dev
   or os.stat(fd_path).st_ino!=os.stat(admission_lock).st_ino
  ):
   raise SystemExit("root collector released the guest admission lock")
def prove_qemu_absent():
 if pathlib.Path(f"/proc/{qemu}").exists():
  try:
   if start_time(qemu):
    raise SystemExit("selected QEMU process remains live")
  except FileNotFoundError:
   pass
 needle=overlay.encode()
 for entry in pathlib.Path("/proc").iterdir():
  if not entry.name.isdigit():continue
  if int(entry.name)==os.getpid():continue
  try: body=(entry/"cmdline").read_bytes()
  except (FileNotFoundError,PermissionError,ProcessLookupError):continue
  if needle in body:
   raise SystemExit("a process still references the selected overlay")
def prove_overlay_fd_absent(device,inode,own_descriptor):
 own_pid=os.getpid()
 expected_device=(os.major(device),os.minor(device))
 for process in pathlib.Path("/proc").iterdir():
  if not process.name.isdigit():continue
  fd_root=process/"fd"
  try:descriptors=list(fd_root.iterdir())
  except (FileNotFoundError,PermissionError,ProcessLookupError):continue
  for candidate in descriptors:
   if int(process.name)==own_pid and candidate.name==str(own_descriptor):
    continue
   try:identity=os.stat(candidate)
   except (FileNotFoundError,PermissionError,ProcessLookupError):continue
   if (identity.st_dev,identity.st_ino)==(device,inode):
    raise SystemExit(
     f"process {process.name} still holds the selected overlay inode"
    )
  try: mappings=(process/"maps").read_text(encoding="utf-8").splitlines()
  except (
   FileNotFoundError,PermissionError,ProcessLookupError,UnicodeDecodeError
  ):continue
  for mapping in mappings:
   fields=mapping.split(maxsplit=5)
   if len(fields)<5 or not fields[4].isdigit():continue
   try:
    major_text,minor_text=fields[3].split(":",1)
    mapped_device=(int(major_text,16),int(minor_text,16))
   except ValueError:continue
   if mapped_device==expected_device and int(fields[4])==inode:
    raise SystemExit(
     f"process {process.name} still maps the selected overlay inode"
    )
if mode not in {"supervisor","recovery"}:
 raise SystemExit("overlay seal mode is invalid")
prove_lock_holder();prove_qemu_absent()
descriptor=os.open(
 overlay,
 os.O_RDONLY|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0),
)
try:
 before=os.fstat(descriptor)
 if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size<=0:
  raise SystemExit("overlay is not one stable regular file")
 expected=pwd.getpwnam(expected_user)
 if (
  before.st_uid!=expected.pw_uid or before.st_gid!=expected.pw_gid
  or stat.S_IMODE(before.st_mode)!=0o600
 ):
  raise SystemExit("overlay ownership or mode is unsafe")
 path_before=os.stat(overlay,follow_symlinks=False)
 if (before.st_dev,before.st_ino)!=(path_before.st_dev,path_before.st_ino):
  raise SystemExit("overlay pathname differs from the opened descriptor")
 prove_overlay_fd_absent(before.st_dev,before.st_ino,descriptor)
 digest=hashlib.sha256()
 while True:
  chunk=os.read(descriptor,4*1024*1024)
  if not chunk:break
  digest.update(chunk)
 after=os.fstat(descriptor)
 path_after=os.stat(overlay,follow_symlinks=False)
 identity=lambda value:(
  value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns
 )
 if identity(before)!=identity(after) or identity(after)!=identity(path_after):
  raise SystemExit("overlay changed while hashing the held no-follow descriptor")
 prove_overlay_fd_absent(after.st_dev,after.st_ino,descriptor)
 prove_lock_holder();prove_qemu_absent()
 value={
  "sha256":digest.hexdigest(),"size":after.st_size,"device":after.st_dev,
  "inode":after.st_ino,"mtimeNs":after.st_mtime_ns,"ctimeNs":after.st_ctime_ns,
 }
 body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
 out=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 try:os.write(out,body);os.fsync(out)
 finally:os.close(out)
finally:
 os.close(descriptor)
PY
}

collect_readiness() {
  local guest="$1" provision_sha="$2" manifest_sha="$3" ssh_key_source="$4"
  local authorization_source="$5" authorization_signature_source="$6" drill="$7"
  local work authorization authorization_signature auth_json auth_id auth_sha auth_sig_sha
  local preliminary_auth_id resume_authorization retry_allowed_signers
  local recovery_allowed_signers pending_status
  local client_private known_hosts client_public client_sha provision_json manifest
  local unit_state supervisor_pid live_snapshot challenge measurement_result measurement signature
  local measurement_sha signature_sha pending journal nonce request request_stage
  local supervisor_start qemu_pid qemu_start overlay_result overlay_sha overlay_size
  local overlay_device overlay_inode overlay_mtime overlay_ctime readiness_dir readiness readiness_stage
  local evidence_dir evidence_target seal_mode lock_holder holder_pid holder_start
  local collector_pid collector_start

  case "$guest" in guest-1|guest-2|guest-3) ;; *) die "guest is outside the fixed allowlist" ;; esac
  [[ "$provision_sha" =~ ^[0-9a-f]{64}$ ]] \
    || die "provision receipt digest is invalid"
  [[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] \
    || die "bundle manifest digest is invalid"
  case "$drill" in
    ssh-disconnect-after-pm2-stop|failed-health-check|host-reboot-during-promotion) ;;
    *) die "drill is outside the fixed recovery-scenario allowlist" ;;
  esac
  GUEST="$guest"
  EXPECTED_PROVISION_SHA256="$provision_sha"
  EXPECTED_MANIFEST_SHA256="$manifest_sha"
  [ -f "$ACTIVE_RECEIPT" ] && [ ! -L "$ACTIVE_RECEIPT" ] \
    && [ "$(realpath -e -- "$ACTIVE_RECEIPT")" = "$ACTIVE_RECEIPT" ] \
    && [ "$(stat -c '%U:%G:%a:%h' -- "$ACTIVE_RECEIPT")" = root:nexus-drill-vm:640:1 ] \
    && [ "$(stat -c '%s' -- "$ACTIVE_RECEIPT")" -le 524288 ] \
    || die "active provision receipt is missing or unsafe"
  [ "$(sha256sum -- "$ACTIVE_RECEIPT" | cut -d' ' -f1)" = "$provision_sha" ] \
    || die "active provision receipt differs from the approved identity"
  load_pinned_owner_key
  verify_registered_bundle "$manifest_sha"
  manifest="$BUNDLE_ROOT/manifest.json"

  provision_json="$(
    python3 "$MANIFEST_HELPER" provision \
      --provision-receipt "$ACTIVE_RECEIPT" \
      --expected-provision-sha256 "$provision_sha" \
      --guest "$guest"
  )"
  mapfile -t selected < <(
    printf '%s' "$provision_json" | python3 -c '
import json,sys
v=json.load(sys.stdin)
for key in (
 "setId","sshClientPublicKeySha256","port","uuid","mac","instanceId",
 "hostPublicKey","hostPublicKeySha256","hostKeyFingerprint","overlayPath",
 "overlayInitialSha256","seedPath","seedSha256","unit","qemuBinary","qemuSha256",
):
 print(v[key])
'
  )
  [ "${#selected[@]}" -eq 16 ] || die "cannot select the exact provisioned guest"
  SET_ID="${selected[0]}"
  EXPECTED_CLIENT_PUBLIC_KEY_SHA256="${selected[1]}"
  PORT="${selected[2]}"
  MACHINE_UUID="${selected[3]}"
  MAC="${selected[4]}"
  INSTANCE_ID="${selected[5]}"
  HOST_PUBLIC_KEY="${selected[6]}"
  HOST_PUBLIC_KEY_SHA256="${selected[7]}"
  HOST_KEY_FINGERPRINT="${selected[8]}"
  OVERLAY_PATH="${selected[9]}"
  OVERLAY_INITIAL_SHA256="${selected[10]}"
  SEED_PATH="${selected[11]}"
  SEED_SHA256="${selected[12]}"
  UNIT="${selected[13]}"
  QEMU_BINARY="${selected[14]}"
  QEMU_SHA256="${selected[15]}"

  work="$(mktemp -d "$STATE_ROOT/.runtime-readiness.XXXXXXXX")"
  cleanup_collect() {
    rm -rf -- "$work"
  }
  trap cleanup_collect EXIT
  authorization="$work/authorization.json"
  authorization_signature="$work/authorization.sig"
  copy_root_bounded "$authorization_source" "$authorization" 2 65536
  copy_root_bounded "$authorization_signature_source" "$authorization_signature" 32 4096
  auth_sha="$(sha256sum -- "$authorization" | cut -d' ' -f1)"
  auth_sig_sha="$(sha256sum -- "$authorization_signature" | cut -d' ' -f1)"
  preliminary_auth_id="$(
    python3 - "$authorization" <<'PY'
import json,pathlib,re,sys
body=pathlib.Path(sys.argv[1]).read_bytes()
value=json.loads(body.decode("utf-8","strict"))
if body!=json.dumps(value,separators=(",",":"),sort_keys=True).encode():
 raise SystemExit("authorization is not canonical")
identity=value.get("authorizationId")
if not isinstance(identity,str) or re.fullmatch(r"[0-9a-f]{64}",identity) is None:
 raise SystemExit("authorization identity is invalid")
print(identity)
PY
  )" || die "cannot select the owner authorization identity"
  resume_authorization=false
  if [ -f "$PENDING_PARENT/$preliminary_auth_id/journal.json" ] \
      && [ ! -L "$PENDING_PARENT/$preliminary_auth_id/journal.json" ]; then
    resume_authorization=true
  elif [ -f "$EVIDENCE_PARENT/$SET_ID/$guest/$preliminary_auth_id/journal.json" ] \
      && [ ! -L "$EVIDENCE_PARENT/$SET_ID/$guest/$preliminary_auth_id/journal.json" ]; then
    resume_authorization=true
  fi
  auth_json="$(
    controller_boot_id_sha256="$(
      tr -d '\n' </proc/sys/kernel/random/boot_id | sha256sum | cut -d' ' -f1
    )"
    controller_uptime_seconds="$(
      awk '{print int($1)}' /proc/uptime
    )"
    python3 - "$authorization" "$PINNED_OWNER_IDENTITY_SHA256" "$SET_ID" "$guest" "$PORT" \
      "$provision_sha" "$manifest_sha" "$HOST_PUBLIC_KEY_SHA256" "$drill" \
      "$resume_authorization" "$controller_boot_id_sha256" \
      "$controller_uptime_seconds" <<'PY'
import datetime,hashlib,json,pathlib,re,sys
(
 path,owner_sha,set_id,guest,port,provision,manifest,host_key_sha,drill,resume,
 controller_boot_sha,controller_uptime,
)=sys.argv[1:]
body=pathlib.Path(path).read_bytes()
try:value=json.loads(body.decode("utf-8","strict"))
except Exception as error:raise SystemExit(f"authorization JSON is invalid: {error}")
canonical=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
if body!=canonical:
 raise SystemExit("authorization must use canonical sorted compact JSON")
if set(value)!={
 "schema","authorizationId","issuedAt","expiresAt","operation","drill","setId",
 "guest","port","provisionReceiptSha256","bundleManifestSha256",
 "guestSshHostPublicKeySha256","ownerPublicKeySha256",
 "controllerBootIdSha256","issuedMonotonicSeconds","expiresMonotonicSeconds",
}:
 raise SystemExit("authorization schema is invalid")
hex64=re.compile(r"^[0-9a-f]{64}$")
if (
 value["schema"]!="nexus.rollback-drill-vm-runtime-authorization.v1"
 or not hex64.fullmatch(value["authorizationId"])
 or value["operation"]!="collect-runtime-readiness"
 or value["drill"]!=drill or value["setId"]!=set_id or value["guest"]!=guest
 or value["port"]!=int(port)
 or value["provisionReceiptSha256"]!=provision
 or value["bundleManifestSha256"]!=manifest
 or value["guestSshHostPublicKeySha256"]!=host_key_sha
 or value["ownerPublicKeySha256"]!=owner_sha
 or value["controllerBootIdSha256"]!=controller_boot_sha
):
 raise SystemExit("authorization identity is outside the selected boundary")
def timestamp(name):
 text=value[name]
 if (
  not isinstance(text,str)
  or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",text) is None
 ):
  raise SystemExit(f"authorization {name} is invalid")
 try:return datetime.datetime.fromisoformat(text[:-1]+"+00:00")
 except ValueError:raise SystemExit(f"authorization {name} is invalid")
issued=timestamp("issuedAt");expires=timestamp("expiresAt")
now=datetime.datetime.now(datetime.timezone.utc)
if not controller_uptime.isdigit():
 raise SystemExit("controller monotonic clock is invalid")
uptime=int(controller_uptime)
issued_mono=value["issuedMonotonicSeconds"]
expires_mono=value["expiresMonotonicSeconds"]
if (
 issued>now or (expires<=now and resume!="true") or expires<=issued
 or expires-issued>datetime.timedelta(hours=24)
 or type(issued_mono) is not int or type(expires_mono) is not int
 or issued_mono<0 or expires_mono<=issued_mono
 or expires_mono-issued_mono!=int((expires-issued).total_seconds())
 or issued_mono>uptime or expires_mono<=uptime
):
 raise SystemExit("authorization validity window is outside policy")
print(json.dumps({
 "authorizationId":value["authorizationId"],"issuedAt":value["issuedAt"],
 "expiresAt":value["expiresAt"],
 "controllerBootIdSha256":value["controllerBootIdSha256"],
 "issuedMonotonicSeconds":issued_mono,
 "expiresMonotonicSeconds":expires_mono,
},separators=(",",":"),sort_keys=True))
PY
  )" || die "owner authorization validation failed"
  auth_id="$(printf '%s' "$auth_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorizationId"])')"
  openssl pkeyutl -verify \
    -pubin \
    -inkey "$OWNER_PUBLIC_KEY" \
    -rawin \
    -in "$authorization" \
    -sigfile "$authorization_signature" >/dev/null \
    || die "owner authorization signature is invalid"

  install -d -o root -g root -m 0700 "$PENDING_PARENT" "$EVIDENCE_PARENT"
  fsync_path "$PENDING_PARENT"
  fsync_path "$EVIDENCE_PARENT"
  fsync_path "$STATE_ROOT"
  pending="$PENDING_PARENT/$auth_id"
  journal="$pending/journal.json"
  readiness_dir="$READINESS_PARENT/$SET_ID"
  readiness="$readiness_dir/$guest.json"
  request="$HANDOFF_DIR/$guest.request"
  if [ -e "$readiness" ] || [ -L "$readiness" ]; then
    [ -f "$readiness" ] && [ ! -L "$readiness" ] \
      && [ "$(stat -c '%U:%G:%a:%h' -- "$readiness")" = root:nexus-drill-vm:640:1 ] \
      || die "existing runtime readiness receipt is unsafe"
    evidence_target="$EVIDENCE_PARENT/$SET_ID/$guest/$auth_id"
    if [ ! -e "$evidence_target" ] && [ ! -L "$evidence_target" ]; then
      validate_root_chain "$pending" "pending published readiness evidence" directory
      [ "$(stat -c '%U:%G:%a' -- "$pending")" = root:root:700 ] \
        || die "pending published readiness evidence directory mode is unsafe"
      for evidence_file in \
        authorization.json authorization.sig measurement.json measurement.sig \
        journal.json live-qemu.json; do
        validate_root_chain "$pending/$evidence_file" \
          "pending published readiness evidence file" file
        [ "$(stat -c '%U:%G:%a:%h' -- "$pending/$evidence_file")" = root:root:600:1 ] \
          || die "pending published readiness evidence file mode is unsafe"
        [ "$(stat -c '%s' -- "$pending/$evidence_file")" -le 524288 ] \
          || die "pending published readiness evidence file exceeds its accepted bound"
      done
      cmp -s -- "$authorization" "$pending/authorization.json" \
        && cmp -s -- "$authorization_signature" "$pending/authorization.sig" \
        || die "pending published readiness authorization differs"
      pending_status="$(
        python3 - "$pending/journal.json" "$auth_id" "$auth_sha" \
          "$auth_sig_sha" "$SET_ID" "$guest" "$provision_sha" "$manifest_sha" \
          "$pending/measurement.json" "$pending/measurement.sig" <<'PY'
import hashlib,json,pathlib,re,sys
(
 path,auth_id,auth_sha,auth_sig_sha,set_id,guest,provision,manifest,
 measurement_path,signature_path,
)=sys.argv[1:]
value=json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
if set(value)!={
 "schema","status","authorizationId","authorizationSha256",
 "authorizationSignatureSha256","setId","guest","provisionReceiptSha256",
 "bundleManifestSha256","challenge","nonce","measurementSha256",
 "measurementSignatureSha256","supervisorPid","supervisorStartTime","qemuPid",
 "qemuStartTime",
} or (
 value["schema"]!="nexus.rollback-drill-vm-runtime-collection-journal.v1"
 or value["status"] not in {"qemu_exited","readiness_published"}
 or value["authorizationId"]!=auth_id or value["authorizationSha256"]!=auth_sha
 or value["authorizationSignatureSha256"]!=auth_sig_sha
 or value["setId"]!=set_id or value["guest"]!=guest
 or value["provisionReceiptSha256"]!=provision
 or value["bundleManifestSha256"]!=manifest
):
 raise SystemExit("pending published readiness journal identity is invalid")
def digest(candidate):
 return hashlib.sha256(pathlib.Path(candidate).read_bytes()).hexdigest()
if (
 value["measurementSha256"]!=digest(measurement_path)
 or value["measurementSignatureSha256"]!=digest(signature_path)
 or any(
  re.fullmatch(r"[0-9a-f]{64}",value[name]) is None
  for name in ("challenge","nonce")
 )
):
 raise SystemExit("pending published readiness journal digest is invalid")
print(value["status"])
PY
      )" || die "pending published readiness journal is invalid"
      python3 "$MANIFEST_HELPER" validate-readiness \
        --provision-receipt "$ACTIVE_RECEIPT" \
        --expected-provision-sha256 "$provision_sha" \
        --guest "$guest" \
        --measurement "$pending/measurement.json" \
        --measurement-signature "$pending/measurement.sig" \
        --authorization "$pending/authorization.json" \
        --authorization-signature "$pending/authorization.sig" \
        --readiness "$readiness" \
        --manifest "$manifest" \
        --expected-manifest-sha256 "$manifest_sha" >/dev/null \
        || die "pending evidence does not bind the published readiness receipt"
      recovery_allowed_signers="$work/recovery-allowed-signers"
      printf '%s %s\n' "$guest" "$HOST_PUBLIC_KEY" >"$recovery_allowed_signers"
      chmod 0600 "$recovery_allowed_signers"
      ssh-keygen -Y verify \
        -f "$recovery_allowed_signers" \
        -I "$guest" \
        -n "$MEASUREMENT_NAMESPACE" \
        -s "$pending/measurement.sig" \
        <"$pending/measurement.json" >/dev/null \
        || die "pending published readiness guest signature is invalid"
      if [ "$pending_status" = qemu_exited ]; then
        checkpoint_journal_status "$journal" readiness_published
      fi
      install -d -o root -g root -m 0700 \
        "$EVIDENCE_PARENT/$SET_ID" "$EVIDENCE_PARENT/$SET_ID/$guest"
      fsync_path "$EVIDENCE_PARENT/$SET_ID/$guest"
      fsync_path "$EVIDENCE_PARENT/$SET_ID"
      fsync_path "$EVIDENCE_PARENT"
      fsync_path "$STATE_ROOT"
      mv -T -- "$pending" "$evidence_target"
      fsync_path "$EVIDENCE_PARENT/$SET_ID/$guest"
      fsync_path "$EVIDENCE_PARENT/$SET_ID"
      fsync_path "$EVIDENCE_PARENT"
      fsync_path "$PENDING_PARENT"
      fsync_path "$STATE_ROOT"
    elif [ -e "$pending" ] || [ -L "$pending" ]; then
      die "published readiness has both pending and final evidence"
    fi
    validate_root_chain "$evidence_target" "published runtime evidence" directory
    [ "$(stat -c '%U:%G:%a' -- "$evidence_target")" = root:root:700 ] \
      || die "published runtime evidence directory mode is unsafe"
    for evidence_file in \
      authorization.json authorization.sig measurement.json measurement.sig \
      journal.json live-qemu.json; do
      validate_root_chain "$evidence_target/$evidence_file" \
        "published runtime evidence file" file
      [ "$(stat -c '%U:%G:%a:%h' -- "$evidence_target/$evidence_file")" = root:root:600:1 ] \
        || die "published runtime evidence file mode is unsafe"
      [ "$(stat -c '%s' -- "$evidence_target/$evidence_file")" -le 524288 ] \
        || die "published runtime evidence file exceeds its accepted bound"
    done
    cmp -s -- "$authorization" "$evidence_target/authorization.json" \
      && cmp -s -- "$authorization_signature" "$evidence_target/authorization.sig" \
      || die "existing readiness authorization differs from its published evidence"
    python3 - "$evidence_target/journal.json" "$auth_id" "$auth_sha" \
      "$auth_sig_sha" "$SET_ID" "$guest" "$provision_sha" "$manifest_sha" \
      "$evidence_target/measurement.json" "$evidence_target/measurement.sig" <<'PY' \
      || die "published runtime evidence journal is invalid"
import hashlib,json,pathlib,re,sys
(
 path,auth_id,auth_sha,auth_sig_sha,set_id,guest,provision,manifest,
 measurement_path,signature_path,
)=sys.argv[1:]
value=json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
if set(value)!={
 "schema","status","authorizationId","authorizationSha256",
 "authorizationSignatureSha256","setId","guest","provisionReceiptSha256",
 "bundleManifestSha256","challenge","nonce","measurementSha256",
 "measurementSignatureSha256","supervisorPid","supervisorStartTime","qemuPid",
 "qemuStartTime",
} or (
 value["schema"]!="nexus.rollback-drill-vm-runtime-collection-journal.v1"
 or value["status"]!="readiness_published"
 or value["authorizationId"]!=auth_id or value["authorizationSha256"]!=auth_sha
 or value["authorizationSignatureSha256"]!=auth_sig_sha
 or value["setId"]!=set_id or value["guest"]!=guest
 or value["provisionReceiptSha256"]!=provision
 or value["bundleManifestSha256"]!=manifest
):
 raise SystemExit("published runtime evidence journal identity is invalid")
def digest(candidate):
 return hashlib.sha256(pathlib.Path(candidate).read_bytes()).hexdigest()
if (
 value["measurementSha256"]!=digest(measurement_path)
 or value["measurementSignatureSha256"]!=digest(signature_path)
 or any(
  re.fullmatch(r"[0-9a-f]{64}",value[name]) is None
  for name in ("challenge","nonce")
 )
):
 raise SystemExit("published runtime evidence journal digest is invalid")
PY
    python3 "$MANIFEST_HELPER" validate-readiness \
      --provision-receipt "$ACTIVE_RECEIPT" \
      --expected-provision-sha256 "$provision_sha" \
      --guest "$guest" \
      --measurement "$evidence_target/measurement.json" \
      --measurement-signature "$evidence_target/measurement.sig" \
      --authorization "$evidence_target/authorization.json" \
      --authorization-signature "$evidence_target/authorization.sig" \
      --readiness "$readiness" \
      --manifest "$manifest" \
      --expected-manifest-sha256 "$manifest_sha" >/dev/null \
      || die "existing runtime readiness receipt binds invalid evidence"
    retry_allowed_signers="$work/retry-allowed-signers"
    printf '%s %s\n' "$guest" "$HOST_PUBLIC_KEY" >"$retry_allowed_signers"
    chmod 0600 "$retry_allowed_signers"
    ssh-keygen -Y verify \
      -f "$retry_allowed_signers" \
      -I "$guest" \
      -n "$MEASUREMENT_NAMESPACE" \
      -s "$evidence_target/measurement.sig" \
      <"$evidence_target/measurement.json" >/dev/null \
      || die "existing runtime readiness guest measurement signature is invalid"
    if [ -e "$request" ] || [ -L "$request" ]; then
      [ -f "$request" ] && [ ! -L "$request" ] \
        && [ "$(stat -c '%U:%G:%a:%h' -- "$request")" = root:nexus-drill-vm:640:1 ] \
        || die "published readiness left an unsafe handoff request"
      durable_remove "$request"
    fi
    printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-readiness-result.v2","setId":"%s","guest":"%s","readiness":"%s","alreadyPresent":true}\n' \
      "$SET_ID" "$guest" "$readiness"
    return
  fi

  validate_lock_path "$ADMISSION_LOCK" root:nexus-drill-vm
  validate_lock_path "$ACTIVE_LOCK" root:nexus-drill-vm
  validate_lock_path "$SHARED_MUTEX" root:dominguez
  [ -d "$HANDOFF_DIR" ] && [ ! -L "$HANDOFF_DIR" ] \
    && [ "$(realpath -e -- "$HANDOFF_DIR")" = "$HANDOFF_DIR" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$HANDOFF_DIR")" = root:nexus-drill-vm:750 ] \
    || die "runtime handoff directory is missing or unsafe"
  exec 7<>"$ADMISSION_LOCK"
  flock -n 7 || die "another guest start or readiness collection holds admission"
  collector_pid="$$"
  collector_start="$(process_start_time "$collector_pid")" \
    || die "cannot derive the collector process identity"

  client_private="$work/lab-ssh-key"
  copy_root_bounded "$ssh_key_source" "$client_private" 32 65536
  chmod 0600 "$client_private"
  client_public="$(
    ssh-keygen -y -f "$client_private" \
      | awk 'NF >= 2 {print $1 " " $2; exit}'
  )" || die "cannot derive the lab SSH public key"
  [[ "$client_public" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] \
    || die "lab SSH private key is not Ed25519"
  client_sha="$(printf '%s' "$client_public" | sha256sum | cut -d' ' -f1)"
  [ "$client_sha" = "$EXPECTED_CLIENT_PUBLIC_KEY_SHA256" ] \
    || die "lab SSH private key differs from the provision receipt"
  known_hosts="$work/known_hosts"
  printf '[127.0.0.1]:%s %s\n' "$PORT" "$HOST_PUBLIC_KEY" >"$known_hosts"
  chmod 0600 "$known_hosts"
  ssh_options=(
    -F /dev/null
    -T
    -p "$PORT"
    -i "$client_private"
    -o BatchMode=yes
    -o CanonicalizeHostname=no
    -o ClearAllForwardings=yes
    -o ConnectionAttempts=1
    -o ConnectTimeout=5
    -o GlobalKnownHostsFile=/dev/null
    -o HostKeyAlgorithms=ssh-ed25519
    -o IdentitiesOnly=yes
    -o KbdInteractiveAuthentication=no
    -o LogLevel=ERROR
    -o NumberOfPasswordPrompts=0
    -o PasswordAuthentication=no
    -o PermitLocalCommand=no
    -o PreferredAuthentications=publickey
    -o ProxyCommand=none
    -o PubkeyAcceptedAlgorithms=ssh-ed25519
    -o RequestTTY=no
    -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile="$known_hosts"
  )

  if [ -e "$journal" ] || [ -L "$journal" ]; then
    validate_root_chain "$pending" "pending readiness transaction" directory
    [ -f "$journal" ] && [ ! -L "$journal" ] \
      && [ "$(stat -c '%U:%G:%a:%h' -- "$journal")" = root:root:600:1 ] \
      || die "pending readiness journal is unsafe"
    mapfile -t resume < <(
      python3 - "$journal" "$auth_id" "$auth_sha" "$auth_sig_sha" \
        "$SET_ID" "$guest" "$provision_sha" "$manifest_sha" <<'PY'
import json,re,sys
path,auth_id,auth_sha,auth_sig_sha,set_id,guest,provision,manifest=sys.argv[1:]
v=json.load(open(path,encoding="utf-8"))
if set(v)!={
 "schema","status","authorizationId","authorizationSha256",
 "authorizationSignatureSha256","setId","guest","provisionReceiptSha256",
 "bundleManifestSha256","challenge","nonce","measurementSha256",
 "measurementSignatureSha256","supervisorPid","supervisorStartTime","qemuPid",
 "qemuStartTime",
} or (
 v["schema"]!="nexus.rollback-drill-vm-runtime-collection-journal.v1"
 or v["status"] not in {"measured","qemu_exited","readiness_published"}
 or v["authorizationId"]!=auth_id or v["authorizationSha256"]!=auth_sha
 or v["authorizationSignatureSha256"]!=auth_sig_sha or v["setId"]!=set_id
 or v["guest"]!=guest or v["provisionReceiptSha256"]!=provision
 or v["bundleManifestSha256"]!=manifest
):
 raise SystemExit("pending readiness journal identity is invalid")
for name in ("challenge","nonce","measurementSha256","measurementSignatureSha256"):
 if re.fullmatch(r"[0-9a-f]{64}",v[name]) is None:
  raise SystemExit("pending readiness journal digest is invalid")
for name in (
 "status","challenge","nonce","measurementSha256","measurementSignatureSha256",
 "supervisorPid","supervisorStartTime","qemuPid","qemuStartTime",
):
 print(v[name])
PY
    )
    [ "${#resume[@]}" -eq 9 ] || die "cannot resume pending readiness transaction"
    journal_status="${resume[0]}"
    challenge="${resume[1]}"
    nonce="${resume[2]}"
    measurement_sha="${resume[3]}"
    signature_sha="${resume[4]}"
    supervisor_pid="${resume[5]}"
    supervisor_start="${resume[6]}"
    qemu_pid="${resume[7]}"
    qemu_start="${resume[8]}"
    measurement="$pending/measurement.json"
    signature="$pending/measurement.sig"
    [ "$(sha256sum -- "$measurement" | cut -d' ' -f1)" = "$measurement_sha" ] \
      && [ "$(sha256sum -- "$signature" | cut -d' ' -f1)" = "$signature_sha" ] \
      || die "pending guest measurement evidence drifted"
  else
    unit_state="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
    [ "$unit_state" = active ] || die "selected guest unit must be active"
    supervisor_pid="$(systemctl show --property=MainPID --value -- "$UNIT")"
    [[ "$supervisor_pid" =~ ^[1-9][0-9]*$ ]] \
      || die "selected guest unit has no live supervisor"
    live_snapshot="$work/live-qemu.json"
    snapshot_live_guest "$supervisor_pid" "$live_snapshot"
    mapfile -t live < <(
      python3 - "$live_snapshot" <<'PY'
import json,sys
v=json.load(open(sys.argv[1],encoding="utf-8"))
for name in ("supervisorStartTime","qemuPid","qemuStartTime"):print(v[name])
PY
    )
    [ "${#live[@]}" -eq 3 ] || die "cannot bind the live QEMU process"
    supervisor_start="${live[0]}"
    qemu_pid="${live[1]}"
    qemu_start="${live[2]}"

    ssh_ready=false
    for ((attempt=0; attempt<60; attempt+=1)); do
      if ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
          '/usr/bin/cloud-init status --wait >/dev/null && printf ready' \
          2>/dev/null | grep -qx ready; then
        ssh_ready=true
        break
      fi
      sleep 2
    done
    [ "$ssh_ready" = true ] || die "guest SSH/cloud-init readiness timed out"
    remote_root="$(
      ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
        'umask 077; mktemp -d /tmp/nexus-runtime-stage.XXXXXXXX'
    )" || die "cannot create the guest staging directory"
    [[ "$remote_root" =~ ^/tmp/nexus-runtime-stage\.[A-Za-z0-9]+$ ]] \
      || die "guest returned an unsafe staging path"
    ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
      "umask 077; tee '$remote_root/provision.json' >/dev/null" \
      <"$ACTIVE_RECEIPT" \
      || die "cannot copy the provision receipt into the guest"
    ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
      "umask 077; mkdir '$remote_root/bundle'; tar --no-same-owner --same-permissions -xf - -C '$remote_root/bundle'" \
      < <(tar -C "$BUNDLE_ROOT" -cf - .) \
      || die "cannot copy the verified offline bundle into the guest"
    ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
      "sudo -n '$GUEST_CONTROL' stage-provision '$remote_root/provision.json' '$provision_sha' >/dev/null" \
      || die "guest refused the provision receipt"
    ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
      "sudo -n '$GUEST_CONTROL' stage-bundle '$remote_root/bundle' '$manifest_sha' '$PINNED_OWNER_FILE_SHA256' >/dev/null" \
      || die "guest refused the owner-signed runtime bundle"
    ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
      "rm -rf -- '$remote_root'" \
      || die "cannot remove the untrusted guest staging directory"
    guest_provision="/var/lib/nexus-rollback-drill-vm/provision-receipts/$provision_sha.json"
    guest_bundle="/var/lib/nexus-rollback-drill-vm/toolchain-bundles/$manifest_sha"
    ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
      "sudo -n '$GUEST_CONTROL' install '$guest_bundle' '$guest_provision' '$provision_sha' '$guest' '$manifest_sha' '$PINNED_OWNER_FILE_SHA256' >/dev/null" \
      || die "offline guest runtime installation failed"
    challenge="$(openssl rand -hex 32)"
    [[ "$challenge" =~ ^[0-9a-f]{64}$ ]] || die "cannot create a measurement challenge"
    measurement_result="$(
      ssh "${ssh_options[@]}" dominguez@127.0.0.1 \
        "sudo -n '$GUEST_CONTROL' measure '$guest_bundle' '$guest_provision' '$provision_sha' '$guest' '$manifest_sha' '$PINNED_OWNER_FILE_SHA256' '$challenge'"
    )" || die "live guest runtime measurement failed"
    measurement="$work/measurement.json"
    signature="$work/measurement.sig"
    python3 - "$measurement_result" "$measurement" "$signature" "$SET_ID" \
      "$guest" "$challenge" <<'PY'
import base64,json,os,sys
raw,measurement,signature,set_id,guest,challenge=sys.argv[1:]
value=json.loads(raw)
if set(value)!={
 "ok","schema","setId","guest","challenge","measurementBase64","signatureBase64",
} or (
 value["ok"] is not True
 or value["schema"]!="nexus.rollback-drill-vm-runtime-measurement-result.v1"
 or value["setId"]!=set_id or value["guest"]!=guest
 or value["challenge"]!=challenge
):
 raise SystemExit("guest measurement response is invalid")
for destination,name,limit in (
 (measurement,"measurementBase64",524288),(signature,"signatureBase64",65536),
):
 try:body=base64.b64decode(value[name],validate=True)
 except Exception:raise SystemExit("guest measurement response base64 is invalid")
 if not body or len(body)>limit:raise SystemExit("guest measurement response is outside bounds")
 descriptor=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 try:os.write(descriptor,body);os.fsync(descriptor)
 finally:os.close(descriptor)
PY
    python3 "$MANIFEST_HELPER" validate-measurement \
      --provision-receipt "$ACTIVE_RECEIPT" \
      --expected-provision-sha256 "$provision_sha" \
      --guest "$guest" \
      --measurement "$measurement" \
      --manifest "$manifest" \
      --expected-manifest-sha256 "$manifest_sha" \
      --challenge "$challenge" >/dev/null
    allowed_signers="$work/allowed-signers"
    printf '%s %s\n' "$guest" "$HOST_PUBLIC_KEY" >"$allowed_signers"
    chmod 0600 "$allowed_signers"
    ssh-keygen -Y verify \
      -f "$allowed_signers" \
      -I "$guest" \
      -n "$MEASUREMENT_NAMESPACE" \
      -s "$signature" \
      <"$measurement" >/dev/null \
      || die "guest measurement host-key signature is invalid"
    measurement_sha="$(sha256sum -- "$measurement" | cut -d' ' -f1)"
    signature_sha="$(sha256sum -- "$signature" | cut -d' ' -f1)"
    nonce="$(openssl rand -hex 32)"
    [[ "$nonce" =~ ^[0-9a-f]{64}$ ]] || die "cannot create a handoff nonce"
    install -d -o root -g root -m 0700 "$pending"
    install -o root -g root -m 0600 -- "$authorization" "$pending/authorization.json"
    install -o root -g root -m 0600 -- "$authorization_signature" "$pending/authorization.sig"
    install -o root -g root -m 0600 -- "$measurement" "$pending/measurement.json"
    install -o root -g root -m 0600 -- "$signature" "$pending/measurement.sig"
    install -o root -g root -m 0600 -- "$live_snapshot" "$pending/live-qemu.json"
    journal_stage="$pending/.journal.XXXXXXXX"
    journal_stage="$(mktemp "$journal_stage")"
    python3 - "$journal_stage" "$auth_id" "$auth_sha" "$auth_sig_sha" "$SET_ID" \
      "$guest" "$provision_sha" "$manifest_sha" "$challenge" "$nonce" \
      "$measurement_sha" "$signature_sha" "$supervisor_pid" "$supervisor_start" \
      "$qemu_pid" "$qemu_start" <<'PY'
import json,os,sys
(
 output,auth_id,auth_sha,auth_sig_sha,set_id,guest,provision,manifest,challenge,
 nonce,measurement_sha,signature_sha,supervisor,supervisor_start,qemu,qemu_start,
)=sys.argv[1:]
value={
 "schema":"nexus.rollback-drill-vm-runtime-collection-journal.v1",
 "status":"measured","authorizationId":auth_id,"authorizationSha256":auth_sha,
 "authorizationSignatureSha256":auth_sig_sha,"setId":set_id,"guest":guest,
 "provisionReceiptSha256":provision,"bundleManifestSha256":manifest,
 "challenge":challenge,"nonce":nonce,"measurementSha256":measurement_sha,
 "measurementSignatureSha256":signature_sha,"supervisorPid":int(supervisor),
 "supervisorStartTime":supervisor_start,"qemuPid":int(qemu),
 "qemuStartTime":qemu_start,
}
descriptor=os.open(output,os.O_WRONLY|os.O_TRUNC)
try:
 body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
 os.write(descriptor,body);os.fsync(descriptor)
finally:os.close(descriptor)
PY
    chown root:root "$journal_stage"
    chmod 0600 "$journal_stage"
    python3 "$MANIFEST_HELPER" fsync-tree --root "$pending" >/dev/null
    mv -T -- "$journal_stage" "$journal"
    fsync_path "$pending"
    fsync_path "$PENDING_PARENT"
    journal_status=measured
  fi

  python3 "$MANIFEST_HELPER" validate-measurement \
    --provision-receipt "$ACTIVE_RECEIPT" \
    --expected-provision-sha256 "$provision_sha" \
    --guest "$guest" \
    --measurement "$measurement" \
    --manifest "$manifest" \
    --expected-manifest-sha256 "$manifest_sha" \
    --challenge "$challenge" >/dev/null
  allowed_signers="$work/resume-allowed-signers"
  printf '%s %s\n' "$guest" "$HOST_PUBLIC_KEY" >"$allowed_signers"
  chmod 0600 "$allowed_signers"
  ssh-keygen -Y verify -f "$allowed_signers" -I "$guest" \
    -n "$MEASUREMENT_NAMESPACE" -s "$signature" <"$measurement" >/dev/null \
    || die "persisted guest measurement signature is invalid"

  if [ "$journal_status" = measured ] \
      && [ -e "/proc/$qemu_pid" ]; then
    [ "$(process_start_time "$supervisor_pid")" = "$supervisor_start" ] \
      || die "runner supervisor changed before the readiness handoff"
    [ "$(process_start_time "$qemu_pid")" = "$qemu_start" ] \
      || die "QEMU process changed before the readiness handoff"
    if [ ! -e "$request" ] && [ ! -L "$request" ]; then
      request_stage="$(mktemp "$HANDOFF_DIR/.request.XXXXXXXX")"
      python3 - "$request_stage" "$SET_ID" "$guest" "$supervisor_pid" \
        "$supervisor_start" "$qemu_pid" "$qemu_start" "$nonce" <<'PY'
import json,os,sys
output,set_id,guest,supervisor,supervisor_start,qemu,qemu_start,nonce=sys.argv[1:]
value={
 "schema":"nexus.rollback-drill-vm-runtime-handoff.v1","setId":set_id,
 "guest":guest,"supervisorPid":int(supervisor),
 "supervisorStartTime":supervisor_start,"qemuPid":int(qemu),
 "qemuStartTime":qemu_start,"nonce":nonce,
}
descriptor=os.open(output,os.O_WRONLY|os.O_TRUNC)
try:
 body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
 os.write(descriptor,body);os.fsync(descriptor)
finally:os.close(descriptor)
PY
      chown root:nexus-drill-vm "$request_stage"
      chmod 0640 "$request_stage"
      mv -T -- "$request_stage" "$request"
      fsync_path "$HANDOFF_DIR"
    fi
    [ -f "$request" ] && [ ! -L "$request" ] \
      && [ "$(stat -c '%U:%G:%a:%h' -- "$request")" = root:nexus-drill-vm:640:1 ] \
      || die "runtime handoff request is unsafe"
    qemu_stopped=false
    for ((attempt=0; attempt<160; attempt+=1)); do
      if [ ! -e "/proc/$qemu_pid" ]; then
        qemu_stopped=true
        break
      fi
      [ "$(process_start_time "$supervisor_pid")" = "$supervisor_start" ] \
        || die "runner supervisor exited during the readiness handoff"
      kill -USR1 "$supervisor_pid"
      sleep 0.2
    done
    [ "$qemu_stopped" = true ] || die "QEMU did not exit during the bounded handoff"
    checkpoint_journal_status "$journal" qemu_exited
    journal_status=qemu_exited
  elif [ "$journal_status" = measured ]; then
    [ ! -e "/proc/$qemu_pid" ] \
      || die "journaled QEMU PID was reused after the readiness handoff"
    checkpoint_journal_status "$journal" qemu_exited
    journal_status=qemu_exited
  fi

  if [ -e "/proc/$supervisor_pid" ] \
      && [ "$(process_start_time "$supervisor_pid")" = "$supervisor_start" ]; then
    [ -f "$request" ] && [ ! -L "$request" ] \
      && [ "$(stat -c '%U:%G:%a:%h' -- "$request")" = root:nexus-drill-vm:640:1 ] \
      || die "live supervisor is missing its exact handoff request"
    [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = active ] \
      || die "guest unit left the active handoff state before overlay sealing"
    seal_mode=supervisor
    lock_holder=runner-supervisor
    holder_pid="$supervisor_pid"
    holder_start="$supervisor_start"
    proof_systemd_state=active-handoff-wait
  else
    [ ! -e "/proc/$qemu_pid" ] \
      || die "QEMU remains live without its journaled supervisor"
    unit_state="$(systemctl is-active "$UNIT" 2>/dev/null || true)"
    case "$unit_state" in inactive|failed) ;; *) die "guest unit is unsafe for journal recovery: $unit_state" ;; esac
    if [ "$unit_state" = failed ]; then
      systemctl reset-failed "$UNIT"
      [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = inactive ] \
        || die "guest unit could not return to inactive recovery state"
    fi
    exec 8<>"$ACTIVE_LOCK"
    flock -n 8 || die "another guest owns the active lock during journal recovery"
    exec 6<>"$SHARED_MUTEX"
    flock -n 6 \
      || die "a release or Sonar operation blocks readiness journal recovery"
    seal_mode=recovery
    lock_holder=root-collector
    holder_pid="$collector_pid"
    holder_start="$collector_start"
    proof_systemd_state=inactive-recovery
  fi
  overlay_result="$work/overlay.json"
  stable_overlay_measurement "$overlay_result" "$seal_mode" "$holder_pid" \
    "$holder_start" "$qemu_pid"
  mapfile -t overlay < <(
    python3 - "$overlay_result" <<'PY'
import json,sys
v=json.load(open(sys.argv[1],encoding="utf-8"))
for name in ("sha256","size","device","inode","mtimeNs","ctimeNs"):print(v[name])
PY
  )
  [ "${#overlay[@]}" -eq 6 ] || die "cannot read the stable overlay identity"
  overlay_sha="${overlay[0]}"
  overlay_size="${overlay[1]}"
  overlay_device="${overlay[2]}"
  overlay_inode="${overlay[3]}"
  overlay_mtime="${overlay[4]}"
  overlay_ctime="${overlay[5]}"

  auth_issued="$(printf '%s' "$auth_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["issuedAt"])')"
  auth_expires="$(printf '%s' "$auth_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["expiresAt"])')"
  auth_controller_boot="$(printf '%s' "$auth_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["controllerBootIdSha256"])')"
  auth_issued_monotonic="$(printf '%s' "$auth_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["issuedMonotonicSeconds"])')"
  auth_expires_monotonic="$(printf '%s' "$auth_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["expiresMonotonicSeconds"])')"
  readiness_dir="$READINESS_PARENT/$SET_ID"
  install -d -o root -g nexus-drill-vm -m 0750 "$READINESS_PARENT" "$readiness_dir"
  fsync_path "$readiness_dir"
  fsync_path "$READINESS_PARENT"
  fsync_path "$STATE_ROOT"
  [ ! -e "$readiness" ] && [ ! -L "$readiness" ] \
    || die "runtime readiness receipt is immutable and already exists"
  readiness_stage="$(mktemp "$readiness_dir/.readiness.XXXXXXXX")"
  python3 - "$readiness_stage" "$SET_ID" "$guest" "$PORT" "$provision_sha" \
    "$manifest_sha" "$auth_id" "$drill" "$auth_issued" "$auth_expires" \
    "$auth_controller_boot" "$auth_issued_monotonic" "$auth_expires_monotonic" \
    "$auth_sha" "$auth_sig_sha" "$PINNED_OWNER_IDENTITY_SHA256" "$measurement_sha" \
    "$signature_sha" "$challenge" "$MACHINE_UUID" "$INSTANCE_ID" "$MAC" \
    "$HOST_KEY_FINGERPRINT" "$HOST_PUBLIC_KEY_SHA256" "$UNIT" "$supervisor_pid" \
    "$supervisor_start" "$proof_systemd_state" "$lock_holder" "$holder_pid" \
    "$holder_start" "$nonce" "$OVERLAY_PATH" "$OVERLAY_INITIAL_SHA256" \
    "$overlay_sha" "$overlay_size" "$overlay_device" "$overlay_inode" \
    "$overlay_mtime" "$overlay_ctime" "$pending/live-qemu.json" "$measurement" <<'PY'
import datetime,json,os,sys
(
 output,set_id,guest,port,provision,manifest,auth_id,drill,issued,expires,
 controller_boot,issued_monotonic,expires_monotonic,
 auth_sha,auth_sig_sha,owner_sha,measurement_sha,measurement_sig_sha,challenge,
 uuid,instance_id,mac,host_fingerprint,host_public_sha,unit,supervisor,
 supervisor_start,proof_systemd_state,lock_holder,holder_pid,holder_start,nonce,
 overlay_path,overlay_initial,overlay_current,overlay_size,overlay_device,
 overlay_inode,overlay_mtime,overlay_ctime,live_path,measurement_path,
)=sys.argv[1:]
live=json.load(open(live_path,encoding="utf-8"))
measurement=json.load(open(measurement_path,encoding="utf-8"))
value={
 "schema":"nexus.rollback-drill-vm-runtime-readiness.v2",
 "status":"ready","drillReady":True,
 "sealedAt":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
 "setId":set_id,"guest":guest,"port":int(port),
 "provisionReceiptSha256":provision,"bundleManifestSha256":manifest,
 "ownerAuthorization":{
  "authorizationId":auth_id,"drill":drill,"issuedAt":issued,"expiresAt":expires,
  "controllerBootIdSha256":controller_boot,
  "issuedMonotonicSeconds":int(issued_monotonic),
  "expiresMonotonicSeconds":int(expires_monotonic),
  "sha256":auth_sha,"signatureSha256":auth_sig_sha,
  "ownerPublicKeySha256":owner_sha,
 },
 "guestMeasurement":{
  "sha256":measurement_sha,"signatureSha256":measurement_sig_sha,
  "challenge":challenge,"namespace":"nexus-rollback-drill-vm-runtime-measurement",
 },
 "machine":{
  "uuid":uuid,"instanceId":instance_id,"mac":mac,
  "sshHostKeyFingerprint":host_fingerprint,
  "sshHostPublicKeySha256":host_public_sha,
 },
 "qemu":{
  "unit":unit,"supervisorPid":int(supervisor),
  "supervisorStartTime":supervisor_start,
  "supervisorCmdlineSha256":live["supervisorCmdlineSha256"],
  "pid":live["qemuPid"],"startTime":live["qemuStartTime"],
  "executable":live["qemuExecutable"],
  "executableSha256":live["qemuExecutableSha256"],
  "cmdlineSha256":live["qemuCmdlineSha256"],
  "loopbackPortSocketInode":live["loopbackPortSocketInode"],
 },
 "stoppedGuestProof":{
  "unit":unit,"systemdState":proof_systemd_state,
  "admissionLockHeld":True,"activeLockHolder":lock_holder,
  "sharedReleaseSonarLockHolder":lock_holder,"holderPid":int(holder_pid),
  "holderStartTime":holder_start,"handoffNonce":nonce,
  "qemuExited":True,"overlayProcessAbsent":True,
 },
 "overlay":{
  "path":overlay_path,"initialSha256":overlay_initial,
  "currentSha256":overlay_current,"size":int(overlay_size),
  "device":int(overlay_device),"inode":int(overlay_inode),
  "mtimeNs":int(overlay_mtime),"ctimeNs":int(overlay_ctime),
  "stableDescriptor":True,
 },
 "runtime":measurement["runtime"],"control":measurement["control"],
 "pm2DryHealth":measurement["pm2DryHealth"],"networkInstallAttempted":False,
}
body=json.dumps(value,separators=(",",":"),sort_keys=True).encode()
descriptor=os.open(output,os.O_WRONLY|os.O_TRUNC)
try:os.write(descriptor,body);os.fsync(descriptor)
finally:os.close(descriptor)
PY
  python3 "$MANIFEST_HELPER" validate-readiness \
    --provision-receipt "$ACTIVE_RECEIPT" \
    --expected-provision-sha256 "$provision_sha" \
    --guest "$guest" \
    --measurement "$pending/measurement.json" \
    --measurement-signature "$pending/measurement.sig" \
    --authorization "$pending/authorization.json" \
    --authorization-signature "$pending/authorization.sig" \
    --readiness "$readiness_stage" \
    --manifest "$manifest" \
    --expected-manifest-sha256 "$manifest_sha" >/dev/null
  chown root:nexus-drill-vm "$readiness_stage"
  chmod 0640 "$readiness_stage"
  mv -T -- "$readiness_stage" "$readiness"
  fsync_path "$readiness_dir"
  fsync_path "$READINESS_PARENT"
  fsync_path "$STATE_ROOT"
  checkpoint_journal_status "$journal" readiness_published
  evidence_dir="$EVIDENCE_PARENT/$SET_ID/$guest"
  install -d -o root -g root -m 0700 \
    "$EVIDENCE_PARENT/$SET_ID" "$evidence_dir"
  fsync_path "$evidence_dir"
  fsync_path "$EVIDENCE_PARENT/$SET_ID"
  fsync_path "$EVIDENCE_PARENT"
  fsync_path "$STATE_ROOT"
  evidence_target="$evidence_dir/$auth_id"
  [ ! -e "$evidence_target" ] && [ ! -L "$evidence_target" ] \
    || die "runtime evidence target already exists"
  mv -T -- "$pending" "$evidence_target"
  fsync_path "$evidence_dir"
  fsync_path "$EVIDENCE_PARENT/$SET_ID"
  fsync_path "$EVIDENCE_PARENT"
  fsync_path "$PENDING_PARENT"
  fsync_path "$STATE_ROOT"
  durable_remove "$request"
  for ((attempt=0; attempt<100; attempt+=1)); do
    [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = inactive ] && break
    sleep 0.1
  done
  [ "$(systemctl is-active "$UNIT" 2>/dev/null || true)" = inactive ] \
    || die "runner supervisor did not exit after readiness publication"
  printf '{"ok":true,"schema":"nexus.rollback-drill-vm-runtime-readiness-result.v2","setId":"%s","guest":"%s","readiness":"%s","overlayCurrentSha256":"%s","alreadyPresent":false}\n' \
    "$SET_ID" "$guest" "$readiness" "$overlay_sha"
}

if [ "${1:-}" = version ]; then
  [ "$#" -eq 1 ] || usage
  printf '%s\n' "$VERSION"
  exit 0
fi

[ "$EUID" -eq 0 ] || die "must run as root on the rollback-drill host"
for command in awk bash chmod chown cmp cut dirname flock grep head install \
  mktemp mv openssl python3 realpath rm sha256sum sleep ssh ssh-keygen stat \
  systemctl tar tr; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done
[ -f "$MANIFEST_HELPER" ] && [ ! -L "$MANIFEST_HELPER" ] \
  && [ "$(stat -c '%U:%G:%a:%h' -- "$MANIFEST_HELPER")" = root:root:755:1 ] \
  || die "runtime manifest helper is not the installed root-owned asset"
install -d -o root -g nexus-drill-vm -m 0750 "$STATE_ROOT"
if [ -L "$CONTROL_LOCK" ]; then
  die "runtime readiness control lock is a symlink"
fi
exec 9>"$CONTROL_LOCK"
chown root:root "$CONTROL_LOCK"
chmod 0600 "$CONTROL_LOCK"
flock -n 9 || die "another runtime readiness transaction is active"

command_name="${1:-}"
shift || true
case "$command_name" in
  pin-owner-key)
    [ "$#" -eq 2 ] || usage
    pin_owner_key "$1" "$2"
    ;;
  register-bundle)
    [ "$#" -eq 2 ] || usage
    register_bundle "$1" "$2"
    ;;
  collect)
    [ "$#" -eq 7 ] || usage
    collect_readiness "$@"
    ;;
  *) usage ;;
esac

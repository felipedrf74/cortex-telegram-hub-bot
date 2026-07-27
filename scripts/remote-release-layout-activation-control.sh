#!/usr/bin/env bash
# Root broker for the single, owner-authorized release-layout activation.
# submit/status/fetch are the only operator-facing commands. run/recover-all
# remain root-only systemd interfaces so SSH or Mac loss cannot interrupt
# recovery and cannot create a second release lane.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

VERSION=nexus-release-layout-activation-control.v1
COMMAND="${1:-}"
[ "$#" -gt 0 ] && shift
TEST_MODE="${NEXUS_RELEASE_TEST_MODE:-0}"
STATE_ROOT="${NEXUS_PROMOTION_STATE_ROOT:-/var/lib/nexus-release-promotion}"
ACTIVATION_ROOT="${NEXUS_LAYOUT_ACTIVATION_ROOT:-$STATE_ROOT/layout-activation}"
TRANSACTIONS="$ACTIVATION_ROOT/transactions"
ACTIVE="$ACTIVATION_ROOT/active.v1.json"
PHASE_A_RECEIPT="${NEXUS_LAYOUT_PHASE_A_RECEIPT:-$ACTIVATION_ROOT/phase-a-receipt.v1.json}"
PHASE_A_TEST_ASSET_ROOT="${NEXUS_LAYOUT_PHASE_A_TEST_ASSET_ROOT:-}"
PROMOTION_ACTIVE="$STATE_ROOT/active.json"
LAYOUT_JOURNAL="$STATE_ROOT/layout-migration-in-progress.v1.json"
LAYOUT_ATTESTATION="$STATE_ROOT/layout-migration.v1.json"
AUTH_BIN="${NEXUS_LAYOUT_AUTH_BIN:-/usr/local/libexec/nexus-release-layout-authorization.mjs}"
DRILL_VERIFY_BIN="${NEXUS_LAYOUT_DRILL_VERIFY_BIN:-/usr/local/libexec/nexus-release-layout-fault-drill.mjs}"
KVM_TRUST_MANIFEST="${NEXUS_LAYOUT_KVM_TRUST_MANIFEST:-/var/lib/nexus-rollback-drill-vm/release-layout-evidence-trust.v1.json}"
KVM_PROVISION_RECEIPT="${NEXUS_LAYOUT_KVM_PROVISION_RECEIPT:-/var/lib/nexus-rollback-drill-vm/active.json}"
KVM_PROVISION_JOURNAL="${NEXUS_LAYOUT_KVM_PROVISION_JOURNAL:-/var/lib/nexus-rollback-drill-vm/provision-in-progress.v1}"
MIGRATE_BIN="${NEXUS_LAYOUT_MIGRATE_BIN:-/usr/local/sbin/nexus-release-layout-migrate}"
OWNER_PUBLIC_KEY="${NEXUS_LAYOUT_OWNER_PUBLIC_KEY:-/etc/nexus-release/owner-promotion-public-key.pem}"
SYSTEM_NODE="${NEXUS_LAYOUT_NODE_BIN:-/usr/bin/node}"
SYSTEMCTL_BIN="${NEXUS_LAYOUT_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
FLOCK_BIN="${NEXUS_LAYOUT_FLOCK_BIN:-/usr/bin/flock}"
HANDOVER_BIN="${NEXUS_LAYOUT_HANDOVER_BIN:-/usr/local/sbin/nexus-release-layout-activation-install}"
PROMOTION_CONTROL="${NEXUS_LAYOUT_PROMOTION_CONTROL:-/usr/local/sbin/nexus-release-promotion-control}"
PHASE_A_JOURNAL="$ACTIVATION_ROOT/phase-a-install-in-progress.v1.json"
PHASE_A_RECOVERY_FAILED="$ACTIVATION_ROOT/phase-a-recovery-failed.v1.json"
PHASE_B_JOURNAL="$ACTIVATION_ROOT/phase-b-handover-in-progress.v1.json"
UUID='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

die() {
  echo "release layout activation control: $*" >&2
  exit 1
}

[ "$EUID" -eq 0 ] || [ "$TEST_MODE" = 1 ] || {
  echo "release layout activation control must run as root" >&2
  exit 77
}
[ "$TEST_MODE" = 1 ] || [ -z "$PHASE_A_TEST_ASSET_ROOT" ] \
  || die "Phase A test asset root is prohibited outside test mode"
for executable in "$SYSTEM_NODE" "$AUTH_BIN" "$DRILL_VERIFY_BIN" "$MIGRATE_BIN" \
  "$PROMOTION_CONTROL" "$FLOCK_BIN"; do
  [ -x "$executable" ] || die "required root-controlled executable is unavailable"
done

fsync_path() {
  "$SYSTEM_NODE" - "$1" <<'NODE'
const fs=require('fs');const descriptor=fs.openSync(process.argv[2],'r');
try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
}

replace_file() {
  "$SYSTEM_NODE" - "$1" "$2" <<'NODE'
const fs=require('fs');const [source,target]=process.argv.slice(2);
const sourceStat=fs.lstatSync(source);
const targetStat=fs.lstatSync(target,{throwIfNoEntry:false});
if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.nlink!==1
 ||targetStat?.isDirectory())process.exit(1);
fs.renameSync(source,target);
NODE
}

root_own() {
  [ "$TEST_MODE" = 1 ] || chown root:root "$@"
}

ensure_roots() {
  if [ "$TEST_MODE" = 1 ]; then
    install -d -m 700 "$ACTIVATION_ROOT" "$TRANSACTIONS"
  else
    install -d -o root -g root -m 700 "$ACTIVATION_ROOT" "$TRANSACTIONS"
  fi
}

validate_id() {
  [[ "$1" =~ $UUID ]] || {
    echo "layout activation transaction id is invalid" >&2
    exit 64
  }
}

transaction_dir() {
  printf '%s/%s\n' "$TRANSACTIONS" "$1"
}

journal_path() {
  printf '%s/journal.v1.json\n' "$(transaction_dir "$1")"
}

safe_input() {
  local file="$1" label="$2"
  "$SYSTEM_NODE" - "$file" "$TEST_MODE" "${SUDO_UID:-}" <<'NODE' \
    || die "$label is not a bounded owner-controlled single-link regular file"
const fs=require('fs');const [file,testMode,sudoUidRaw]=process.argv.slice(2);
const stat=fs.lstatSync(file);const sudoUid=Number(sudoUidRaw);
if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
 ||stat.size<1||stat.size>1048576
 ||(testMode!=='1'&&((stat.mode&0o7777)!==0o600
   ||(stat.uid!==0&&(!Number.isSafeInteger(sudoUid)||stat.uid!==sudoUid)))))
 process.exit(1);
NODE
}

verify_phase_a_receipt() {
  "$SYSTEM_NODE" - "$PHASE_A_RECEIPT" "$TEST_MODE" \
    "$PHASE_A_TEST_ASSET_ROOT" \
    "$ACTIVATION_ROOT/phase-a-predecessor-receipt.v1.json" <<'NODE' \
    || die "exact Phase A receipt or installed asset identity is invalid"
const crypto=require('crypto');const fs=require('fs');
const [receiptFile,testMode,testRoot,predecessorReceipt]=process.argv.slice(2);
const receiptStat=fs.lstatSync(receiptFile);
if(!receiptStat.isFile()||receiptStat.isSymbolicLink()||receiptStat.nlink!==1
 ||(receiptStat.mode&0o7777)!==0o600
 ||(testMode!=='1'&&(receiptStat.uid!==0||receiptStat.gid!==0)))process.exit(1);
const receipt=JSON.parse(fs.readFileSync(receiptFile));
const fixed=[
 '/usr/local/sbin/nexus-release-layout-activation-install',
 '/usr/local/sbin/nexus-release-layout-activation-control',
 '/usr/local/sbin/nexus-release-layout-migrate',
 '/usr/local/libexec/nexus-release-layout-sqlite.py',
 '/usr/local/libexec/nexus-release-layout-authorization.mjs',
 '/usr/local/libexec/nexus-release-layout-fault-drill.mjs',
 '/usr/local/libexec/nexus-trusted-release-runtime-attestation.mjs',
 '/usr/local/libexec/nexus-release-selector-switch.py',
 '/usr/local/libexec/nexus-release-layout-preflight.sh',
 '/usr/local/sbin/nexus-release-promotion-control',
 '/usr/local/libexec/nexus-trusted-release-filesystem-identity.mjs',
 '/usr/local/libexec/nexus-staging-attestation-broker.sh',
 '/usr/local/libexec/nexus-capture-pm2-dump-authority.mjs',
 '/usr/local/libexec/nexus-pm2-dump-authority.py',
 '/usr/local/sbin/nexus-release-boot-health',
 '/usr/local/sbin/nexus-ollama-install-state-check.mjs',
 '/etc/systemd/system/ollama.service.d/00-nexus-ollama-install-guard.conf',
 '/etc/systemd/system/nexus-release-pm2-recovery-daemon.service',
 '/etc/systemd/system/nexus-release-promotion-recovery.service',
 '/etc/systemd/system/nexus-release-layout-activation@.service',
 '/etc/systemd/system/nexus-release-layout-recovery.service',
 '/etc/systemd/system/nexus-release-layout-install-recovery.service',
 '/etc/systemd/system/pm2-dominguez.service.d/00-nexus-release-layout-install-recovery.conf',
 '/etc/sudoers.d/nexus-release-layout-activation',
];
if(testMode==='1'&&testRoot&&!testRoot.startsWith('/'))process.exit(1);
const expected=new Set(fixed.map((asset)=>testMode==='1'&&testRoot
 ?`${testRoot}${asset}`:asset));
const upgrade=receipt.phaseAUpgrade;
if(receipt.schema!=='nexus.release-layout-phase-a-receipt.v1'
 ||receipt.status!=='completed'
 ||!/^[a-f0-9]{40}$/u.test(receipt.sourceSha??'')
 ||!/^[a-f0-9]{64}$/u.test(receipt.sourceArchiveSha256??'')
 ||receipt.existingServiceIdentity?.runtimeUnchanged!==true
 ||!/^[a-f0-9]{64}$/u.test(receipt.existingServiceIdentity?.beforeSha256??'')
 ||!/^[a-f0-9]{64}$/u.test(receipt.existingServiceIdentity?.afterSha256??'')
 ||!/^[a-f0-9]{64}$/u.test(receipt.existingServiceIdentity?.runtimeSha256??'')
 ||receipt.phaseARecoveryGuard!==true
 ||typeof receipt.legacyV2AdapterRetired!=='boolean'
 ||receipt.pm2Prerequisite?.verified!==true
 ||!/^[a-f0-9]{64}$/u.test(receipt.pm2Prerequisite?.evidenceSha256??'')
 ||!upgrade||typeof upgrade!=='object'||Array.isArray(upgrade)
 ||Object.keys(upgrade).sort().join(',')
  !==['performed','predecessorReceiptPath','predecessorReceiptSha256',
      'predecessorSourceSha'].sort().join(',')
 ||typeof upgrade.performed!=='boolean'
 ||!Array.isArray(receipt.installedAssets)
 ||receipt.installedAssets.length!==expected.size
 ||JSON.stringify(receipt.prohibitedCommands)!==JSON.stringify(['run','recover-all'])
 ||!Number.isFinite(Date.parse(receipt.completedAt??'')))process.exit(1);
if(upgrade.performed){
 if(upgrade.predecessorReceiptPath!==predecessorReceipt
  ||!/^[a-f0-9]{64}$/u.test(upgrade.predecessorReceiptSha256??'')
  ||!/^[a-f0-9]{40}$/u.test(upgrade.predecessorSourceSha??'')
  ||!Number.isFinite(Date.parse(receipt.upgradedAt??''))
  ||Date.parse(receipt.upgradedAt)<=Date.parse(receipt.completedAt))process.exit(1);
 const identity=fs.lstatSync(predecessorReceipt);
 if(!identity.isFile()||identity.isSymbolicLink()||identity.nlink!==1
  ||(identity.mode&0o7777)!==0o600
  ||(testMode!=='1'&&(identity.uid!==0||identity.gid!==0))
  ||crypto.createHash('sha256').update(fs.readFileSync(predecessorReceipt)).digest('hex')
    !==upgrade.predecessorReceiptSha256)process.exit(1);
}else if(upgrade.predecessorReceiptPath!==null
 ||upgrade.predecessorReceiptSha256!==null
 ||upgrade.predecessorSourceSha!==null
 ||receipt.upgradedAt!==null
 ||fs.existsSync(predecessorReceipt))process.exit(1);
for(const asset of receipt.installedAssets){
 if(!expected.delete(asset.path)||!/^[a-f0-9]{64}$/u.test(asset.sha256??''))process.exit(1);
 const identity=fs.lstatSync(asset.path);
 if(!identity.isFile()||identity.isSymbolicLink()||identity.nlink!==1
  ||crypto.createHash('sha256').update(fs.readFileSync(asset.path)).digest('hex')!==asset.sha256)
  process.exit(1);
}
if(expected.size)process.exit(1);
NODE
}

atomic_copy() {
  local source="$1" target="$2" temporary
  [ ! -e "$target" ] && [ ! -L "$target" ] || die "activation input target already exists"
  temporary="$(mktemp -p "$(dirname -- "$target")" .layout-activation-input.XXXXXXXX)"
  install -m 600 -- "$source" "$temporary"
  root_own "$temporary"
  fsync_path "$temporary"
  replace_file "$temporary" "$target"
  fsync_path "$(dirname -- "$target")"
}

atomic_json() {
  local target="$1" temporary
  temporary="$(mktemp -p "$(dirname -- "$target")" .layout-activation-state.XXXXXXXX)"
  "$SYSTEM_NODE" - "$temporary" "${@:2}" <<'NODE'
const fs=require('fs');const [output,...pairs]=process.argv.slice(2);const value={};
for(const pair of pairs){const separator=pair.indexOf('=');
 if(separator<1)process.exit(1);value[pair.slice(0,separator)]=pair.slice(separator+1);}
fs.writeFileSync(output,`${JSON.stringify(value,null,2)}\n`,{mode:0o600,flag:'w'});
const descriptor=fs.openSync(output,'r');try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
NODE
  chmod 600 "$temporary"; root_own "$temporary"
  replace_file "$temporary" "$target"
  fsync_path "$(dirname -- "$target")"
}

set_phase() {
  local id="$1" phase="$2" details="${3:-}" journal temporary
  journal="$(journal_path "$id")"
  [ -f "$journal" ] && [ ! -L "$journal" ] || die "activation journal is unavailable"
  temporary="$(mktemp -p "$(dirname -- "$journal")" .layout-activation-journal.XXXXXXXX)"
  "$SYSTEM_NODE" - "$journal" "$temporary" "$phase" "$details" <<'NODE'
const fs=require('fs');const [journalFile,output,phase,detailsFile]=process.argv.slice(2);
const current=JSON.parse(fs.readFileSync(journalFile));
const transitions={
 submitted:new Set(['running','recovered','recovery_failed']),
 running:new Set(['completed','recovered','recovery_failed']),
 completed:new Set(),recovered:new Set(),recovery_failed:new Set(['recovered']),
};
if(current.schema!=='nexus.release-layout-activation-transaction.v1'
 ||!transitions[current.phase]?.has(phase))process.exit(1);
const details=detailsFile?JSON.parse(fs.readFileSync(detailsFile)):{};
fs.writeFileSync(output,`${JSON.stringify({...current,...details,phase,
 updatedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
  chmod 600 "$temporary"; root_own "$temporary"; fsync_path "$temporary"
  replace_file "$temporary" "$journal"; fsync_path "$(dirname -- "$journal")"
}

read_phase() {
  "$SYSTEM_NODE" - "$(journal_path "$1")" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.schema!=='nexus.release-layout-activation-transaction.v1')process.exit(1);
process.stdout.write(x.phase);
NODE
}

nonterminal_transaction() {
  "$SYSTEM_NODE" - "$TRANSACTIONS" "$TEST_MODE" <<'NODE'
const fs=require('fs');const [root,testMode]=process.argv.slice(2);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const phases=new Set(['submitted','running','completed','recovered','recovery_failed']);
const nonterminal=new Set(['submitted','running','recovery_failed']);
const candidates=[];
for(const name of fs.readdirSync(root).sort()){
 if(!uuid.test(name))process.exit(1);
 const directory=`${root}/${name}`;const directoryStat=fs.lstatSync(directory);
 if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()
  ||(directoryStat.mode&0o7777)!==0o700
  ||(testMode!=='1'&&(directoryStat.uid!==0||directoryStat.gid!==0)))process.exit(1);
 const journalFile=`${directory}/journal.v1.json`;
 const journalStat=fs.lstatSync(journalFile,{throwIfNoEntry:false});
 if(!journalStat)continue;
 if(!journalStat.isFile()||journalStat.isSymbolicLink()||journalStat.nlink!==1
  ||(journalStat.mode&0o7777)!==0o600
  ||(testMode!=='1'&&(journalStat.uid!==0||journalStat.gid!==0)))process.exit(1);
 const journal=JSON.parse(fs.readFileSync(journalFile));
 if(journal.schema!=='nexus.release-layout-activation-transaction.v1'
  ||journal.transactionId!==name||!phases.has(journal.phase))process.exit(1);
 if(nonterminal.has(journal.phase))candidates.push([name,journal.phase]);
}
if(candidates.length>1)process.exit(1);
process.stdout.write(candidates.length
 ?`${candidates[0][0]} ${candidates[0][1]}\n`
 :'none none\n');
NODE
}

active_id() {
  "$SYSTEM_NODE" - "$ACTIVE" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.schema!=='nexus.release-layout-activation-active.v1'
 ||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
   .test(x.transactionId||''))process.exit(1);
process.stdout.write(x.transactionId);
NODE
}

clear_active() {
  local id="$1"
  [ -e "$ACTIVE" ] || [ -L "$ACTIVE" ] || return 0
  [ -f "$ACTIVE" ] && [ ! -L "$ACTIVE" ] && [ "$(active_id)" = "$id" ] \
    || die "activation authority changed before terminal publication"
  rm -f -- "$ACTIVE"; fsync_path "$ACTIVATION_ROOT"
}

terminal_details() {
  local status="$1" output="$2"
  "$SYSTEM_NODE" - "$status" "$output" \
    "$STATE_ROOT/layout-migration.v1.json" \
    "$STATE_ROOT/layout-migration-result.v1.json" \
    "$STATE_ROOT/layout-migration-recovered.v1.json" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const [status,output,attestation,result,recovered]=process.argv.slice(2);
const digest=(file)=>fs.existsSync(file)
 ?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
fs.writeFileSync(output,`${JSON.stringify({terminal:{
 status,attestationSha256:digest(attestation),resultSha256:digest(result),
 recoveredEvidenceSha256:digest(recovered),completedAt:new Date().toISOString(),
}},null,2)}\n`,{mode:0o600,flag:'w'});
NODE
}

sha256_file() {
  "$SYSTEM_NODE" - "$1" <<'NODE'
const crypto=require('crypto');const fs=require('fs');
const descriptor=fs.openSync(process.argv[2],fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
try{
 const before=fs.fstatSync(descriptor);const body=fs.readFileSync(descriptor);
 const after=fs.fstatSync(descriptor);
 if(!before.isFile()||before.nlink!==1||before.dev!==after.dev||before.ino!==after.ino
  ||before.size!==after.size||before.mtimeMs!==after.mtimeMs)process.exit(1);
 process.stdout.write(crypto.createHash('sha256').update(body).digest('hex'));
}finally{fs.closeSync(descriptor);}
NODE
}

capture_pm2_proof() {
  local output="$1"
  "$PROMOTION_CONTROL" assert-root-pm2-ready >"$output" \
    || die "exact root PM2 closure attestation is unavailable"
  chmod 600 "$output"; root_own "$output"; fsync_path "$output"
  "$SYSTEM_NODE" - "$output" <<'NODE' \
    || die "root PM2 closure proof summary is invalid"
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.ok!==true||x.schema!=='nexus.pm2-root-install.v1'
 ||!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(x.version??'')
 ||!/^[a-f0-9]{64}$/u.test(x.closureDigest??'')
 ||!/^[a-f0-9]{64}$/u.test(x.payloadDigest??'')
 ||!/^[a-f0-9]{64}$/u.test(x.packageLockSha256??'')
 ||!/^[a-f0-9]{64}$/u.test(x.launcherSha256??'')
 ||x.node?.version!=='v22.23.1'
 ||!/^[a-f0-9]{64}$/u.test(x.node?.sha256??''))process.exit(1);
NODE
}

verify_drill_proof() {
  local envelope="$1" output="$2"
  local recovery_journal="${3:-}" recovery_request="${4:-}"
  if [ -n "$recovery_journal" ] || [ -n "$recovery_request" ]; then
    [ -n "$recovery_journal" ] && [ -n "$recovery_request" ] \
      || die "accepted drill recovery requires its journal and exact request"
  fi
  [ ! -e "$KVM_PROVISION_JOURNAL" ] && [ ! -L "$KVM_PROVISION_JOURNAL" ] \
    || die "rollback-drill KVM provisioning is incomplete"
  if [ -n "$recovery_journal" ]; then
    "$SYSTEM_NODE" "$DRILL_VERIFY_BIN" verify-envelope --input "$envelope" \
      --trust-manifest "$KVM_TRUST_MANIFEST" \
      --provision-receipt "$KVM_PROVISION_RECEIPT" \
      --require-root-trust \
      --accepted-recovery-journal "$recovery_journal" \
      --accepted-request-envelope "$recovery_request" >"$output" \
      || die "trusted accepted fault-drill recovery proof is invalid"
  else
    "$SYSTEM_NODE" "$DRILL_VERIFY_BIN" verify-envelope --input "$envelope" \
      --trust-manifest "$KVM_TRUST_MANIFEST" \
      --provision-receipt "$KVM_PROVISION_RECEIPT" \
      --require-root-trust >"$output" \
      || die "trusted nonce-bound hypervisor and guest fault-drill proof is invalid"
  fi
  chmod 600 "$output"; root_own "$output"; fsync_path "$output"
  "$SYSTEM_NODE" - "$output" <<'NODE' \
    || die "trusted KVM proof summary is invalid"
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.ok!==true||x.schema!=='nexus.release-layout-kvm-proof.v1'
 ||!/^[0-9a-f-]{36}$/u.test(x.migrationId??'')
 ||!/^[a-f0-9]{64}$/u.test(x.planSha256??'')
 ||!/^[a-f0-9]{64}$/u.test(x.trustManifestSha256??'')
 ||!/^[a-f0-9]{64}$/u.test(x.provisionReceiptSha256??'')
 ||!/^[a-f0-9]{64}$/u.test(x.provisionSetId??'')
 ||!Number.isSafeInteger(x.maximumRecoverySeconds)
 ||x.maximumRecoverySeconds<0||x.maximumRecoverySeconds>120
 ||!/^[a-f0-9]{64}$/u.test(x.signerKeyDigests?.hypervisor??'')
 ||Object.keys(x.signerKeyDigests?.guests??{}).sort().join(',')
   !=='failed_health_check,host_reboot_during_migration,ssh_disconnect_after_pm2_stop'
 ||Object.values(x.signerKeyDigests.guests)
   .some((digest)=>!/^[a-f0-9]{64}$/u.test(digest)))process.exit(1);
NODE
}

verify_transaction_integrity() {
  local id="$1" directory journal request drill authority drill_proof pm2_proof
  directory="$(transaction_dir "$id")"; journal="$(journal_path "$id")"
  request="$directory/request-envelope.json"
  drill="$directory/fault-drill-envelope.json"
  authority="$directory/authority-verification.json"
  drill_proof="$directory/drill-proof-verification.json"
  pm2_proof="$directory/pm2-proof.json"
  "$SYSTEM_NODE" - "$journal" "$request" "$drill" "$authority" \
    "$drill_proof" "$pm2_proof" "$TEST_MODE" "$id" <<'NODE' \
    || die "activation transaction integrity is invalid"
const crypto=require('crypto');const fs=require('fs');
const [journalFile,request,drill,authority,drillProof,pm2Proof,testMode,id]
 =process.argv.slice(2);
for(const file of [journalFile,request,drill,authority,drillProof,pm2Proof]){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1
  ||(stat.mode&0o7777)!==0o600
  ||(testMode!=='1'&&(stat.uid!==0||stat.gid!==0)))process.exit(1);
}
const journal=JSON.parse(fs.readFileSync(journalFile));
const verifiedAuthority=JSON.parse(fs.readFileSync(authority));
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const submittedAt=Date.parse(journal.submittedAt??'');
const requestCreatedAt=Date.parse(verifiedAuthority.request?.createdAt??'');
const requestExpiresAt=Date.parse(verifiedAuthority.request?.expiresAt??'');
const planCreatedAt=Date.parse(verifiedAuthority.faultDrill?.plan?.createdAt??'');
const planExpiresAt=Date.parse(verifiedAuthority.faultDrill?.plan?.expiresAt??'');
if(journal.schema!=='nexus.release-layout-activation-transaction.v1'
 ||journal.transactionId!==id
 ||!new Set(['submitted','running','completed','recovered','recovery_failed'])
   .has(journal.phase)
 ||verifiedAuthority.schema!=='nexus.release-layout-authority-verification.v1'
 ||verifiedAuthority.request?.migrationId!==id
 ||verifiedAuthority.faultDrill?.migrationId!==id
 ||verifiedAuthority.requestEnvelopeSha256!==journal.requestEnvelopeSha256
 ||verifiedAuthority.faultDrillEnvelopeSha256!==journal.faultDrillEnvelopeSha256
 ||verifiedAuthority.request?.faultDrillEnvelopeSha256
   !==journal.faultDrillEnvelopeSha256
 ||!Number.isFinite(submittedAt)
 ||new Date(submittedAt).toISOString()!==journal.submittedAt
 ||!Number.isFinite(requestCreatedAt)
 ||!Number.isFinite(requestExpiresAt)
 ||!Number.isFinite(planCreatedAt)
 ||!Number.isFinite(planExpiresAt)
 ||submittedAt<requestCreatedAt
 ||submittedAt>requestExpiresAt
 ||submittedAt<planCreatedAt
 ||submittedAt>planExpiresAt
 ||journal.requestEnvelopeSha256!==digest(request)
 ||journal.faultDrillEnvelopeSha256!==digest(drill)
 ||journal.authorityVerificationSha256!==digest(authority)
 ||journal.drillProofVerificationSha256!==digest(drillProof)
 ||journal.pm2ProofSha256!==digest(pm2Proof)
 ||!/^[a-f0-9]{64}$/u.test(journal.phaseAReceiptSha256??''))process.exit(1);
NODE
}

verify_transaction_admission() {
  local id="$1" directory journal request drill authority drill_proof pm2_proof
  local current_authority current_drill current_pm2 phase_a_receipt_sha status=0
  directory="$(transaction_dir "$id")"; journal="$(journal_path "$id")"
  request="$directory/request-envelope.json"
  drill="$directory/fault-drill-envelope.json"
  authority="$directory/authority-verification.json"
  drill_proof="$directory/drill-proof-verification.json"
  pm2_proof="$directory/pm2-proof.json"
  verify_transaction_integrity "$id"
  verify_phase_a_receipt
  phase_a_receipt_sha="$(sha256_file "$PHASE_A_RECEIPT")" \
    || die "cannot digest the exact Phase A receipt"
  "$SYSTEM_NODE" - "$journal" "$phase_a_receipt_sha" <<'NODE' \
    || die "activation journal Phase A receipt binding is invalid"
const fs=require('fs');const [journalFile,receiptSha]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile));
if(journal.phaseAReceiptSha256!==receiptSha)process.exit(1);
NODE
  current_authority="$(mktemp -p "$directory" .layout-activation-authority-run.XXXXXXXX)"
  current_drill="$(mktemp -p "$directory" .layout-activation-drill-run.XXXXXXXX)"
  current_pm2="$(mktemp -p "$directory" .layout-activation-pm2-run.XXXXXXXX)"
  set +e
  (
    set -euo pipefail
    "$SYSTEM_NODE" "$AUTH_BIN" verify --request-envelope "$request" \
      --fault-drill-envelope "$drill" --public-key "$OWNER_PUBLIC_KEY" \
      --accepted-recovery-journal "$journal" >"$current_authority"
    chmod 600 "$current_authority"; root_own "$current_authority"
    fsync_path "$current_authority"
    verify_drill_proof "$drill" "$current_drill" "$journal" "$request"
    capture_pm2_proof "$current_pm2"
    verify_phase_a_receipt
    cmp -s -- "$authority" "$current_authority"
    cmp -s -- "$drill_proof" "$current_drill"
    cmp -s -- "$pm2_proof" "$current_pm2"
  )
  status=$?
  set -e
  rm -f -- "$current_authority" "$current_drill" "$current_pm2"
  [ "$status" -eq 0 ] \
    || die "activation admission identity changed before transaction execution"
}

reconcile_orphan_transaction() {
  local candidate id phase request_sha
  [ ! -e "$ACTIVE" ] && [ ! -L "$ACTIVE" ] \
    || die "activation authority already exists"
  candidate="$(nonterminal_transaction)" \
    || die "activation transaction directory contains unsafe or ambiguous state"
  read -r id phase <<<"$candidate"
  [ "$id" != none ] || return 1
  validate_id "$id"
  case "$phase" in
    submitted) verify_transaction_admission "$id" ;;
    running|recovery_failed) verify_transaction_integrity "$id" ;;
    *) die "orphan activation transaction phase is invalid" ;;
  esac
  request_sha="$("$SYSTEM_NODE" - "$(journal_path "$id")" <<'NODE'
const fs=require('fs');const journal=JSON.parse(fs.readFileSync(process.argv[2]));
if(!/^[a-f0-9]{64}$/u.test(journal.requestEnvelopeSha256??''))process.exit(1);
process.stdout.write(journal.requestEnvelopeSha256);
NODE
)"
  atomic_json "$ACTIVE" schema=nexus.release-layout-activation-active.v1 \
    transactionId="$id" requestEnvelopeSha256="$request_sha" \
    reconciledAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  return 0
}

assert_no_orphan_transaction() {
  local candidate id phase
  candidate="$(nonterminal_transaction)" \
    || die "activation transaction directory contains unsafe or ambiguous state"
  read -r id phase <<<"$candidate"
  [ "$id" = none ] \
    || die "orphan activation transaction $id ($phase) requires recovery"
}

recover_transaction() {
  local id="$1" details status=0
  set +e
  "$MIGRATE_BIN" recover >/dev/null
  status=$?
  set -e
  details="$(mktemp -p "$(transaction_dir "$id")" .layout-activation-terminal.XXXXXXXX)"
  if [ "$status" -eq 0 ]; then
    terminal_details recovered "$details"
    set_phase "$id" recovered "$details"
    clear_active "$id"
    rm -f -- "$details"
    return 0
  fi
  terminal_details recovery_failed "$details"
  set_phase "$id" recovery_failed "$details"
  rm -f -- "$details"
  return 76
}

run_transaction() {
  local id="$1" phase directory request drill details status=0
  validate_id "$id"; directory="$(transaction_dir "$id")"
  [ -d "$directory" ] && [ ! -L "$directory" ] || die "activation transaction is unavailable"
  [ -f "$ACTIVE" ] && [ "$(active_id)" = "$id" ] \
    || die "activation transaction is not authoritative"
  phase="$(read_phase "$id")"
  case "$phase" in
    completed|recovered) clear_active "$id"; return 0 ;;
    recovery_failed) recover_transaction "$id"; return ;;
    running) recover_transaction "$id"; return ;;
    submitted) ;;
    *) die "activation journal phase is invalid" ;;
  esac
  verify_transaction_admission "$id"
  set_phase "$id" running
  request="$directory/request-envelope.json"; drill="$directory/fault-drill-envelope.json"
  set +e
  "$MIGRATE_BIN" migrate "$request" "$drill"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    details="$(mktemp -p "$directory" .layout-activation-terminal.XXXXXXXX)"
    terminal_details completed "$details"
    set_phase "$id" completed "$details"
    clear_active "$id"
    rm -f -- "$details"
    return 0
  fi
  recover_transaction "$id"
}

submit() {
  [ "$#" -eq 2 ] || { echo "Usage: ... submit <signed-request> <signed-drill>" >&2; exit 64; }
  local request="$1" drill="$2" verification copied_verification
  local drill_proof copied_drill_proof pm2_proof copied_pm2_proof
  local id directory request_sha drill_sha journal copied_id copied_request_sha copied_drill_sha
  local verification_sha drill_proof_sha pm2_proof_sha phase_a_receipt_sha
  local submitted_at
  local directory_created=false durable_submission=false
  verification="$(mktemp -p "$ACTIVATION_ROOT" .layout-activation-authority.XXXXXXXX)"
  drill_proof="$(mktemp -p "$ACTIVATION_ROOT" .layout-activation-drill-proof.XXXXXXXX)"
  pm2_proof="$(mktemp -p "$ACTIVATION_ROOT" .layout-activation-pm2-proof.XXXXXXXX)"
  copied_verification=""; copied_drill_proof=""; copied_pm2_proof=""; directory=""
  cleanup_submit() {
    local status=$?
    rm -f -- "${verification:-}" "${copied_verification:-}" \
      "${drill_proof:-}" "${copied_drill_proof:-}" \
      "${pm2_proof:-}" "${copied_pm2_proof:-}" || true
    if [ "$directory_created" = true ] && [ "$durable_submission" != true ] \
        && { [ ! -e "$ACTIVE" ] && [ ! -L "$ACTIVE" ]; }; then
      rm -f -- "$directory/request-envelope.json" \
        "$directory/fault-drill-envelope.json" \
        "$directory/authority-verification.json" \
        "$directory/drill-proof-verification.json" \
        "$directory/pm2-proof.json" \
        "$directory/journal.v1.json" || true
      rmdir -- "$directory" 2>/dev/null || true
      fsync_path "$TRANSACTIONS" 2>/dev/null || true
    fi
    return "$status"
  }
  trap cleanup_submit EXIT
  capture_pm2_proof "$pm2_proof"
  safe_input "$request" "signed layout request"; safe_input "$drill" "signed layout drill"
  verify_phase_a_receipt
  [ ! -e "$PROMOTION_ACTIVE" ] && [ ! -L "$PROMOTION_ACTIVE" ] \
    || die "ordinary promotion is active"
  [ ! -e "$ACTIVE" ] && [ ! -L "$ACTIVE" ] || die "another layout activation is active"
  assert_no_orphan_transaction
  [ ! -e "$LAYOUT_JOURNAL" ] && [ ! -L "$LAYOUT_JOURNAL" ] \
    || die "layout migration recovery is already required"
  [ ! -e "$LAYOUT_ATTESTATION" ] && [ ! -L "$LAYOUT_ATTESTATION" ] \
    || die "layout activation is already complete"
  "$SYSTEM_NODE" "$AUTH_BIN" verify --request-envelope "$request" \
    --fault-drill-envelope "$drill" --public-key "$OWNER_PUBLIC_KEY" >"$verification"
  chmod 600 "$verification"; root_own "$verification"; fsync_path "$verification"
  verify_drill_proof "$drill" "$drill_proof"
  read -r id request_sha drill_sha < <(
    "$SYSTEM_NODE" - "$verification" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.schema!=='nexus.release-layout-authority-verification.v1'
 ||!/^[0-9a-f-]{36}$/u.test(x.request?.migrationId||'')
 ||!/^[a-f0-9]{64}$/u.test(x.requestEnvelopeSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(x.faultDrillEnvelopeSha256||''))process.exit(1);
process.stdout.write(`${[x.request.migrationId,x.requestEnvelopeSha256,
 x.faultDrillEnvelopeSha256].join(' ')}\n`);
NODE
  )
  validate_id "$id"; directory="$(transaction_dir "$id")"
  [ ! -e "$directory" ] && [ ! -L "$directory" ] \
    || die "activation transaction identity was already used"
  if [ "$TEST_MODE" = 1 ]; then install -d -m 700 "$directory"
  else install -d -o root -g root -m 700 "$directory"; fi
  directory_created=true
  fsync_path "$TRANSACTIONS"
  atomic_copy "$request" "$directory/request-envelope.json"
  atomic_copy "$drill" "$directory/fault-drill-envelope.json"
  copied_verification="$(mktemp -p "$directory" .layout-activation-authority-copy.XXXXXXXX)"
  copied_drill_proof="$(mktemp -p "$directory" .layout-activation-drill-proof-copy.XXXXXXXX)"
  copied_pm2_proof="$(mktemp -p "$directory" .layout-activation-pm2-proof-copy.XXXXXXXX)"
  "$SYSTEM_NODE" "$AUTH_BIN" verify \
    --request-envelope "$directory/request-envelope.json" \
    --fault-drill-envelope "$directory/fault-drill-envelope.json" \
    --public-key "$OWNER_PUBLIC_KEY" >"$copied_verification"
  chmod 600 "$copied_verification"; root_own "$copied_verification"
  fsync_path "$copied_verification"
  verify_drill_proof "$directory/fault-drill-envelope.json" "$copied_drill_proof"
  read -r copied_id copied_request_sha copied_drill_sha < <(
    "$SYSTEM_NODE" - "$copied_verification" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
if(x.schema!=='nexus.release-layout-authority-verification.v1'
 ||!/^[0-9a-f-]{36}$/u.test(x.request?.migrationId||'')
 ||!/^[a-f0-9]{64}$/u.test(x.requestEnvelopeSha256||'')
 ||!/^[a-f0-9]{64}$/u.test(x.faultDrillEnvelopeSha256||''))process.exit(1);
process.stdout.write(`${[x.request.migrationId,x.requestEnvelopeSha256,
 x.faultDrillEnvelopeSha256].join(' ')}\n`);
NODE
  )
  [ "$copied_id" = "$id" ] && [ "$copied_request_sha" = "$request_sha" ] \
    && [ "$copied_drill_sha" = "$drill_sha" ] \
    && cmp -s -- "$verification" "$copied_verification" \
    && cmp -s -- "$drill_proof" "$copied_drill_proof" \
    || die "copied activation authority differs from the verified submission"
  verify_phase_a_receipt
  capture_pm2_proof "$copied_pm2_proof"
  cmp -s -- "$pm2_proof" "$copied_pm2_proof" \
    || die "root PM2 closure identity changed during activation admission"
  atomic_copy "$copied_verification" "$directory/authority-verification.json"
  atomic_copy "$copied_drill_proof" "$directory/drill-proof-verification.json"
  atomic_copy "$copied_pm2_proof" "$directory/pm2-proof.json"
  verification_sha="$(sha256_file "$directory/authority-verification.json")"
  drill_proof_sha="$(sha256_file "$directory/drill-proof-verification.json")"
  pm2_proof_sha="$(sha256_file "$directory/pm2-proof.json")"
  phase_a_receipt_sha="$(sha256_file "$PHASE_A_RECEIPT")"
  submitted_at="$("$SYSTEM_NODE" -e 'process.stdout.write(new Date().toISOString())')"
  journal="$(journal_path "$id")"
  atomic_json "$journal" schema=nexus.release-layout-activation-transaction.v1 \
    phase=submitted transactionId="$id" requestEnvelopeSha256="$request_sha" \
    faultDrillEnvelopeSha256="$drill_sha" \
    authorityVerificationSha256="$verification_sha" \
    drillProofVerificationSha256="$drill_proof_sha" \
    pm2ProofSha256="$pm2_proof_sha" phaseAReceiptSha256="$phase_a_receipt_sha" \
    submittedAt="$submitted_at"
  # The owner envelope is verified fresh before publication. Bind that
  # acceptance instant to its signed validity window before ACTIVE can exist;
  # later boot recovery may then use the journal-scoped recovery mode for
  # these exact bytes without creating a new authorization decision.
  verify_transaction_admission "$id"
  atomic_json "$ACTIVE" schema=nexus.release-layout-activation-active.v1 \
    transactionId="$id" requestEnvelopeSha256="$request_sha" \
    activatedAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  durable_submission=true
  "$SYSTEMCTL_BIN" start --no-block "nexus-release-layout-activation@$id.service"
  trap - EXIT
  cleanup_submit
  printf '{"ok":true,"schema":"%s","transactionId":"%s","status":"submitted"}\n' \
    "$VERSION" "$id"
}

assert_boot_safe() {
  verify_phase_a_receipt
  for marker in "$PHASE_A_JOURNAL" "$PHASE_A_RECOVERY_FAILED" \
    "$PHASE_B_JOURNAL" "$ACTIVE" "$LAYOUT_JOURNAL"; do
    [ ! -e "$marker" ] && [ ! -L "$marker" ] \
      || die "release-layout activation or recovery remains incomplete"
  done
  assert_no_orphan_transaction
  if [ -e "$LAYOUT_ATTESTATION" ] || [ -L "$LAYOUT_ATTESTATION" ]; then
    [ -f "$LAYOUT_ATTESTATION" ] && [ ! -L "$LAYOUT_ATTESTATION" ] \
      || die "release-layout attestation is unsafe"
    "$PROMOTION_CONTROL" assert-layout-boot-ready >/dev/null
  fi
  printf '{"ok":true,"schema":"%s","status":"boot_safe"}\n' "$VERSION"
}

status() {
  local id="${1:-}" journal candidate orphaned=false orphan_phase
  if [ -z "$id" ]; then
    if [ ! -e "$ACTIVE" ] && [ ! -L "$ACTIVE" ]; then
      candidate="$(nonterminal_transaction)" \
        || die "activation transaction directory contains unsafe or ambiguous state"
      read -r id orphan_phase <<<"$candidate"
      if [ "$id" = none ]; then
        printf '{"ok":true,"schema":"%s","status":"idle"}\n' "$VERSION"
        return
      fi
      orphaned=true
    else
      id="$(active_id)"
    fi
  fi
  validate_id "$id"; journal="$(journal_path "$id")"
  [ -f "$journal" ] && [ ! -L "$journal" ] || die "activation transaction is unavailable"
  "$SYSTEM_NODE" - "$journal" "$orphaned" <<'NODE'
const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[2]));
const orphaned=process.argv[3]==='true';
process.stdout.write(`${JSON.stringify({ok:true,schema:'nexus-release-layout-activation-control.v1',
 transactionId:x.transactionId,status:x.phase,requestEnvelopeSha256:x.requestEnvelopeSha256,
 faultDrillEnvelopeSha256:x.faultDrillEnvelopeSha256,
 recoveryRequired:orphaned,terminal:x.terminal??null})}\n`);
NODE
}

fetch() {
  [ "$#" -eq 1 ] || { echo "fetch requires one transaction id" >&2; exit 64; }
  local id="$1" phase
  validate_id "$id"; phase="$(read_phase "$id")"
  case "$phase" in completed|recovered) ;; *) die "activation transaction is not terminal" ;; esac
  "$SYSTEM_NODE" - "$(journal_path "$id")" \
    "$STATE_ROOT/layout-migration.v1.json" \
    "$STATE_ROOT/layout-migration-result.v1.json" \
    "$STATE_ROOT/layout-migration-recovered.v1.json" <<'NODE'
const fs=require('fs');const [journalFile,attestationFile,resultFile,recoveredFile]=process.argv.slice(2);
const journal=JSON.parse(fs.readFileSync(journalFile));
const read=(file)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
const evidence={attestation:read(attestationFile),result:read(resultFile),recovered:read(recoveredFile)};
const serialized=JSON.stringify(evidence);
if(serialized.includes('recoveryPointPath')||serialized.includes('/var/lib/'))process.exit(1);
process.stdout.write(`${JSON.stringify({ok:true,schema:'nexus.release-layout-activation-evidence.v1',
 transactionId:journal.transactionId,status:journal.phase,...evidence})}\n`);
NODE
}

ensure_roots
case "$COMMAND" in
  version) printf '%s\n' "$VERSION" ;;
  submit)
    exec 9>"$ACTIVATION_ROOT/.activation.lock"; chmod 600 "$ACTIVATION_ROOT/.activation.lock"
    "$FLOCK_BIN" -x 9; submit "$@"
    ;;
  run)
    [ "$#" -eq 1 ] || exit 64
    exec 9>"$ACTIVATION_ROOT/.activation.lock"; chmod 600 "$ACTIVATION_ROOT/.activation.lock"
    "$FLOCK_BIN" -x 9; run_transaction "$1"
    ;;
  status)
    [ "$#" -le 1 ] || exit 64
    exec 9>"$ACTIVATION_ROOT/.activation.lock"; chmod 600 "$ACTIVATION_ROOT/.activation.lock"
    "$FLOCK_BIN" -s 9; status "${1:-}"
    ;;
  fetch)
    exec 9>"$ACTIVATION_ROOT/.activation.lock"; chmod 600 "$ACTIVATION_ROOT/.activation.lock"
    "$FLOCK_BIN" -s 9; fetch "$@"
    ;;
  recover-all)
    [ "$#" -eq 0 ] || exit 64
    exec 9>"$ACTIVATION_ROOT/.activation.lock"; chmod 600 "$ACTIVATION_ROOT/.activation.lock"
    "$FLOCK_BIN" -x 9
    if [ -e "$ACTIVE" ] || [ -L "$ACTIVE" ]; then
      [ -f "$ACTIVE" ] && [ ! -L "$ACTIVE" ] \
        || die "activation authority marker is unsafe"
      run_transaction "$(active_id)"
    elif reconcile_orphan_transaction; then
      run_transaction "$(active_id)"
    elif { [ -f "$LAYOUT_JOURNAL" ] && [ ! -L "$LAYOUT_JOURNAL" ]; } \
        || { [ -f "$LAYOUT_ATTESTATION" ] && [ ! -L "$LAYOUT_ATTESTATION" ]; }; then
      "$MIGRATE_BIN" recover
    fi
    if [ -x "$HANDOVER_BIN" ]; then
      NEXUS_LAYOUT_INHERITED_ACTIVATION_LOCK_FD=9 \
        "$HANDOVER_BIN" recover-handover
    fi
    ;;
  assert-boot-safe)
    [ "$#" -eq 0 ] || exit 64
    exec 9>"$ACTIVATION_ROOT/.activation.lock"; chmod 600 "$ACTIVATION_ROOT/.activation.lock"
    "$FLOCK_BIN" -s 9; assert_boot_safe
    ;;
  *) echo "Usage: nexus-release-layout-activation-control <version|submit|run|status|fetch|recover-all|assert-boot-safe>" >&2; exit 64 ;;
esac

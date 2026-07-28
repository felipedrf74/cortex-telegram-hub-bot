import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const coordinator = path.resolve('scripts/release-sequence.mjs');

describe('resumable exact-release sequence', () => {
  it('durably replaces the local checkpoint before advancing release phases', () => {
    const source = fs.readFileSync(coordinator, 'utf8');
    const start = source.indexOf('function writeCheckpoint(state) {');
    const end = source.indexOf('\n}\n\nfunction sha256File', start);
    const block = source.slice(start, end);
    const write = block.indexOf('fs.writeFileSync(temporary');
    const fileFsync = block.indexOf('fs.fsyncSync(descriptor)', write);
    const rename = block.indexOf('fs.renameSync(temporary, checkpointPath)', fileFsync);
    const directoryFsync = block.indexOf('fsyncDirectory(checkpointDirectory)', rename);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(write).toBeGreaterThan(-1);
    expect(fileFsync).toBeGreaterThan(write);
    expect(rename).toBeGreaterThan(fileFsync);
    expect(directoryFsync).toBeGreaterThan(rename);
  });

  it('uses a persistent OS-backed lock without stale delete/recreate takeover', () => {
    const source = fs.readFileSync(coordinator, 'utf8');

    expect(source).toContain("'/usr/bin/lockf'");
    expect(source).toContain("args: ['-s', '-t', '0', String(coordinatorLockFd)]");
    expect(source).toContain("['/usr/bin/flock', '/bin/flock']");
    expect(source).toContain("args: ['-n', String(coordinatorLockFd)]");
    expect(source).toContain('stdio: inheritedLockStdio');
    expect(source).toContain('detached: true');
    expect(source).toContain('killProcessGroup(activeChild, signal)');
    expect(source).toContain('current.dev !== inherited.dev');
    expect(source).toContain('current.ino !== inherited.ino');
    expect(source).not.toContain('fs.rmSync(lockPath');
    expect(source).not.toContain('fs.unlinkSync(lockPath');
  });
});

function fixtureTreeDigest(directory: string) {
  const digest = createHash('sha256');

  function visit(current: string, relative: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name);
      const relativePath = path.posix.join(relative, entry.name);
      const stat = fs.lstatSync(entryPath);
      digest.update(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}\0`);
      digest.update(`${relativePath}\0${stat.mode & 0o777}\0`);
      if (entry.isDirectory()) {
        visit(entryPath, relativePath);
      } else if (entry.isSymbolicLink()) {
        digest.update(fs.readlinkSync(entryPath));
      } else {
        digest.update(fs.readFileSync(entryPath));
      }
      digest.update('\0');
    }
  }

  visit(directory, '');
  return digest.digest('hex');
}

describe('resumable exact-release sequence', () => {
  let root: string;
  let fixtureRoot: string;
  let runtimeSha: string;
  let operations: string;
  let rcRunMarker: string;
  let manifestRunMarker: string;
  let stagingRunMarker: string;
  let stagingActiveMarker: string;
  let rcDispatchArgs: string;
  let rcWatchActiveMarker: string;
  let rcWatchReleaseMarker: string;
  let rcWatchTerminationReleaseMarker: string;
  let rcWatchTerminatedMarker: string;
  let rcWatchCoordinatorPidMarker: string;
  let rcWatchChildPidMarker: string;
  let ciViewCountMarker: string;
  let securityViewCountMarker: string;
  let ciViewInterruptMarker: string;
  let seedFixtureRoot: string;
  let seedRepo: string;
  let seedOrigin: string;
  let seedBin: string;
  let seedRuntimeSha: string;
  let seedDigest: string;

  beforeAll(() => {
    fixtureRoot = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-release-sequence-seed-'),
    ));
    root = path.join(fixtureRoot, 'repo');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"4.14.231"}\n');
    fs.writeFileSync(path.join(root, '.gitignore'), '.local/\noperations.log\n');
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI — Risk-based parallel matrix\n');
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'security.yml'), 'name: Security — supply chain and static analysis\n');
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'release-candidate-evidence.yml'), 'name: RC — Release Evidence\n');
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'sign-release-manifest.yml'), 'name: Release — Sign exact candidate\n');
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'sign-staging-attestation.yml'), 'name: Release — Sign staging attestation\n');
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Release Fixture'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'release@example.invalid'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const remote = path.join(fixtureRoot, 'origin.git');
    spawnSync('git', ['init', '--bare', remote], { cwd: root });
    spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: root });
    runtimeSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

    const bin = path.join(fixtureRoot, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
args="$*"
next_observation() {
  node -e 'const fs=require("node:fs");const values=process.argv[1].split(",");const file=process.argv[2];let count=0;try{count=Number(fs.readFileSync(file,"utf8"))||0}catch{};fs.writeFileSync(file,String(count+1));process.stdout.write(values[Math.min(count,values.length-1)])' "$1" "$2"
}
case "$args" in
  "repo view --json nameWithOwner")
    if [ -n "\${LOCK_HOLD_MARKER:-}" ]; then
      : > "$LOCK_HOLD_MARKER"
      while [ ! -f "$LOCK_RELEASE_MARKER" ]; do sleep 0.02; done
    fi
    printf '{"nameWithOwner":"fixture/repository"}\n'
    ;;
  "api repos/fixture/repository/branches/main")
    protected="\${GH_MAIN_PROTECTED:-true}"
    printf '{"name":"main","protected":%s}\n' "$protected"
    ;;
  "api repos/fixture/repository/actions/workflows/ci.yml")
    workflow_id="\${GH_CI_LOOKUP_WORKFLOW_ID:-7001}"
    printf '{"id":%s,"name":"CI — Risk-based parallel matrix","path":".github/workflows/ci.yml","state":"active"}\n' "$workflow_id"
    ;;
  "api repos/fixture/repository/actions/workflows/security.yml")
    workflow_id="\${GH_SECURITY_LOOKUP_WORKFLOW_ID:-7002}"
    printf '{"id":%s,"name":"Security — supply chain and static analysis","path":".github/workflows/security.yml","state":"active"}\n' "$workflow_id"
    ;;
  "run list --workflow ci.yml"*)
    if [ "\${GH_CI_MISSING:-0}" = 1 ]; then printf '[]\n'; else
      attempt="\${GH_CI_LIST_ATTEMPT:-1}"
      if [ "\${GH_CI_ATTEMPT_ADVANCES_AFTER_SECURITY:-0}" = 1 ] && [ -f "$SECURITY_VIEW_COUNT_MARKER" ]; then
        attempt=2
      fi
      workflow_id="\${GH_CI_LIST_WORKFLOW_ID:-7001}"
      printf '[{"attempt":%s,"databaseId":8001,"headSha":"%s","headBranch":"main","event":"push","status":"queued","conclusion":null,"createdAt":"2026-07-22T11:59:00Z","workflowDatabaseId":%s,"workflowName":"CI — Risk-based parallel matrix"}]\n' "$attempt" "$FIXTURE_SHA" "$workflow_id"
    fi
    ;;
  "run view 8001"*)
    case " $args " in *" --attempt 1 "*) ;; *) exit 65 ;; esac
    if [ "\${GH_INTERRUPT_CI_VIEW_ONCE:-0}" = 1 ] && [ ! -f "$CI_VIEW_INTERRUPT_MARKER" ]; then
      : > "$CI_VIEW_INTERRUPT_MARKER"
      exit 75
    fi
    observation="$(next_observation "\${GH_CI_SEQUENCE:-success}" "$CI_VIEW_COUNT_MARKER")"
    case "$observation" in
      pending) status=in_progress; conclusion=null ;;
      success) status=completed; conclusion='"success"' ;;
      failure|cancelled|timed_out) status=completed; conclusion="\\"$observation\\"" ;;
      *) exit 64 ;;
    esac
    attempt="\${GH_CI_VIEW_ATTEMPT:-1}"
    workflow_id="\${GH_CI_VIEW_WORKFLOW_ID:-7001}"
    printf '{"attempt":%s,"databaseId":8001,"headSha":"%s","headBranch":"main","event":"push","status":"%s","conclusion":%s,"workflowDatabaseId":%s,"workflowName":"CI — Risk-based parallel matrix","url":"https://example.invalid/runs/8001","jobs":[]}\n' "$attempt" "$FIXTURE_SHA" "$status" "$conclusion" "$workflow_id"
    ;;
  "run list --workflow security.yml"*)
    if [ "\${GH_SECURITY_MISSING:-0}" = 1 ]; then printf '[]\n'; else
      attempt="\${GH_SECURITY_LIST_ATTEMPT:-1}"
      workflow_id="\${GH_SECURITY_LIST_WORKFLOW_ID:-7002}"
      printf '[{"attempt":%s,"databaseId":9001,"headSha":"%s","headBranch":"main","event":"push","status":"queued","conclusion":null,"createdAt":"2026-07-22T12:00:00Z","workflowDatabaseId":%s,"workflowName":"Security — supply chain and static analysis"}]\n' "$attempt" "$FIXTURE_SHA" "$workflow_id"
    fi
    ;;
  "run view 9001"*)
    case " $args " in *" --attempt 1 "*) ;; *) exit 65 ;; esac
    observation="$(next_observation "\${GH_SECURITY_SEQUENCE:-\${GH_SECURITY_CONCLUSION:-success}}" "$SECURITY_VIEW_COUNT_MARKER")"
    case "$observation" in
      pending) status=in_progress; conclusion=null; job_status=in_progress; job_conclusion=null ;;
      success) status=completed; conclusion='"success"'; job_status=completed; job_conclusion='"success"' ;;
      failure|cancelled|timed_out) status=completed; conclusion="\\"$observation\\""; job_status=completed; job_conclusion="\\"$observation\\"" ;;
      *) exit 64 ;;
    esac
    attempt="\${GH_SECURITY_VIEW_ATTEMPT:-1}"
    workflow_id="\${GH_SECURITY_VIEW_WORKFLOW_ID:-7002}"
    printf '{"attempt":%s,"databaseId":9001,"headSha":"%s","headBranch":"main","event":"push","status":"%s","conclusion":%s,"workflowDatabaseId":%s,"workflowName":"Security — supply chain and static analysis","url":"https://example.invalid/runs/9001","jobs":[{"databaseId":9101,"name":"CodeQL JavaScript/TypeScript","status":"%s","conclusion":%s}]}\n' "$attempt" "$FIXTURE_SHA" "$status" "$conclusion" "$workflow_id" "$job_status" "$job_conclusion"
    ;;
  "workflow run release-candidate-evidence.yml"*)
    checkpoint=".local/release/checkpoints/$FIXTURE_SHA.json"
    node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.phase!=="rc_dispatch_started"||x.rcDispatch?.status!=="dispatch_started"||!x.sourceIntent||x.protectedMainChecks?.status!=="completed"||x.workflows?.protectedMainCi?.status!=="completed"||x.workflows?.security?.status!=="completed"||x.rcRunId!==null)process.exit(65)' "$checkpoint"
    printf '%s\n' "$args" > "$RC_DISPATCH_ARGS_FILE"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$RC_RUN_MARKER"
    printf 'rc-dispatch\n' >> "$OPERATIONS_LOG"
    if [ "\${GH_INTERRUPT_AFTER_RC_DISPATCH:-0}" = 1 ]; then
      exit 75
    fi
    ;;
  "run list --workflow release-candidate-evidence.yml"*)
    if [ -f "$RC_RUN_MARKER" ]; then
      nonce="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).rcDispatch.correlationNonce)' ".local/release/checkpoints/$FIXTURE_SHA.json")"
      title="RC evidence $FIXTURE_SHA request $nonce"
      if [ "\${GH_RC_DIFFERENT_TITLE:-0}" = 1 ]; then title="RC evidence $FIXTURE_SHA request 00000000-0000-4000-8000-000000000000"; fi
      printf '[{"databaseId":123456,"displayTitle":"%s","headSha":"%s","status":"completed","conclusion":"success","createdAt":"%s"}]\n' "$title" "$FIXTURE_SHA" "$(cat "$RC_RUN_MARKER")"
    else
      printf '[]\n'
    fi
    ;;
  "run watch 123456 --exit-status")
    if [ "\${GH_HOLD_RC_WATCH:-0}" = 1 ]; then
      printf '%s\n' "$PPID" > "$RC_WATCH_COORDINATOR_PID_MARKER"
      printf '%s\n' "$$" > "$RC_WATCH_CHILD_PID_MARKER"
      trap ': > "$RC_WATCH_TERMINATED_MARKER"; while [ ! -f "$RC_WATCH_TERMINATION_RELEASE_MARKER" ]; do /bin/sleep 0.02; done; exit 143' TERM INT
      : > "$RC_WATCH_ACTIVE_MARKER"
      while [ ! -f "$RC_WATCH_RELEASE_MARKER" ]; do /bin/sleep 0.02; done
    fi
    if [ "\${GH_INTERRUPT_RC_WATCH:-0}" = 1 ]; then
      printf 'rc-watch-interrupted\n' >> "$OPERATIONS_LOG"
      exit 75
    fi
    printf 'rc-watch\n' >> "$OPERATIONS_LOG"
    ;;
  "run view 123456"*)
    nonce="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).rcDispatch.correlationNonce)' ".local/release/checkpoints/$FIXTURE_SHA.json")"
    printf '{"databaseId":123456,"displayTitle":"RC evidence %s request %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","workflowName":"RC — Release Evidence","url":"https://example.invalid/runs/123456","jobs":[]}\n' "$FIXTURE_SHA" "$nonce" "$FIXTURE_SHA"
    ;;
  "workflow run sign-release-manifest.yml"*)
    checkpoint=".local/release/checkpoints/$FIXTURE_SHA.json"
    node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1]));if(x.manifestSigningDispatch?.status!=="dispatch_started"||!process.argv[2].includes("request_id="+x.manifestSigningDispatch.requestId))process.exit(65)' "$checkpoint" "$args"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$MANIFEST_RUN_MARKER"
    printf 'manifest-sign-dispatch\n' >> "$OPERATIONS_LOG"
    if [ "\${GH_INTERRUPT_AFTER_MANIFEST_DISPATCH:-0}" = 1 ]; then exit 75; fi
    ;;
  "run list --workflow sign-release-manifest.yml"*)
    if [ -f "$MANIFEST_RUN_MARKER" ]; then
      request_id="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).manifestSigningDispatch.requestId)' ".local/release/checkpoints/$FIXTURE_SHA.json")"
      created_at="$(cat "$MANIFEST_RUN_MARKER")"
      if [ "\${GH_MANIFEST_SIGNING_AMBIGUOUS:-0}" = 1 ]; then
        printf '[{"databaseId":223344,"displayTitle":"Sign release candidate %s run 123456 request %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","createdAt":"%s"},{"databaseId":223345,"displayTitle":"Sign release candidate %s run 123456 request %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","createdAt":"%s"}]\n' "$FIXTURE_SHA" "$request_id" "$FIXTURE_SHA" "$created_at" "$FIXTURE_SHA" "$request_id" "$FIXTURE_SHA" "$created_at"
      else
        printf '[{"databaseId":223344,"displayTitle":"Sign release candidate %s run 123456 request %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","createdAt":"%s"}]\n' "$FIXTURE_SHA" "$request_id" "$FIXTURE_SHA" "$created_at"
      fi
    else
      printf '[]\n'
    fi
    ;;
  "run view 223344"*)
    request_id="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).manifestSigningDispatch.requestId)' ".local/release/checkpoints/$FIXTURE_SHA.json")"
    printf '{"databaseId":223344,"displayTitle":"Sign release candidate %s run 123456 request %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","workflowName":"Release — Sign exact candidate","url":"https://example.invalid/runs/223344"}\n' "$FIXTURE_SHA" "$request_id" "$FIXTURE_SHA"
    ;;
  "workflow run sign-staging-attestation.yml"*)
    checkpoint=".local/release/checkpoints/$FIXTURE_SHA.json"
    node -e 'const fs=require("fs"),x=JSON.parse(fs.readFileSync(process.argv[1]));if(x.stagingSigningDispatch?.status!=="dispatch_started"||!process.argv[2].includes("request_id="+x.stagingSigningDispatch.requestId)||!process.argv[2].includes("request_sha256="+x.stagingSigningDispatch.requestSha256))process.exit(65)' "$checkpoint" "$args"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$STAGING_RUN_MARKER"
    printf 'staging-sign-dispatch\n' >> "$OPERATIONS_LOG"
    if [ "\${GH_INTERRUPT_AFTER_STAGING_DISPATCH:-0}" = 1 ]; then exit 75; fi
    ;;
  "run list --workflow sign-staging-attestation.yml"*)
    if [ -f "$STAGING_RUN_MARKER" ]; then
      request_id="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).stagingSigningDispatch.requestId)' ".local/release/checkpoints/$FIXTURE_SHA.json")"
      request_sha="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).stagingSigningDispatch.requestSha256)' ".local/release/checkpoints/$FIXTURE_SHA.json")"
      if [ "\${GH_STAGING_DIFFERENT_REQUEST_DIGEST:-0}" = 1 ]; then request_sha="$(printf 'e%.0s' {1..64})"; fi
      created_at="$(cat "$STAGING_RUN_MARKER")"
      if [ "\${GH_STAGING_SIGNING_AMBIGUOUS:-0}" = 1 ]; then
        printf '[{"databaseId":334455,"displayTitle":"Sign staging_attestation %s digest %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","createdAt":"%s"},{"databaseId":334456,"displayTitle":"Sign staging_attestation %s digest %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","createdAt":"%s"}]\n' "$request_id" "$request_sha" "$FIXTURE_SHA" "$created_at" "$request_id" "$request_sha" "$FIXTURE_SHA" "$created_at"
      else
        printf '[{"databaseId":334455,"displayTitle":"Sign staging_attestation %s digest %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","createdAt":"%s"}]\n' "$request_id" "$request_sha" "$FIXTURE_SHA" "$created_at"
      fi
    else
      printf '[]\n'
    fi
    ;;
  "run view 334455"*)
    request_id="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).stagingSigningDispatch.requestId)' ".local/release/checkpoints/$FIXTURE_SHA.json")"
    request_sha="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).stagingSigningDispatch.requestSha256)' ".local/release/checkpoints/$FIXTURE_SHA.json")"
    printf '{"databaseId":334455,"displayTitle":"Sign staging_attestation %s digest %s","headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","workflowName":"Release — Sign staging attestation","url":"https://example.invalid/runs/334455"}\n' "$request_id" "$request_sha" "$FIXTURE_SHA"
    ;;
  *) echo "unexpected gh invocation: $args" >&2; exit 64 ;;
esac
`, { mode: 0o755 });

    fs.writeFileSync(path.join(root, 'scripts', 'request-release-manifest-signature.sh'), `#!/usr/bin/env bash
set -euo pipefail
sha="$1"; install_root="$3"
run_id=""
while [ "$#" -gt 0 ]; do
  case "$1" in --run-id) run_id="$2"; shift 2 ;; *) shift ;; esac
done
[ "$run_id" = 223344 ] || exit 64
printf 'manifest-sign:%s\n' "$run_id" >> "$OPERATIONS_LOG"
if [ "\${MANIFEST_HELPER_INTERRUPT:-0}" = 1 ]; then exit 75; fi
mkdir -p "$install_root/.local/release/manifests"
printf '{"payload":{"runtimeSha":"%s","packageVersion":"4.14.231","artifact":{"digest":"%s"}}}\n' "$sha" "${'a'.repeat(64)}" > "$install_root/.local/release/manifests/$sha.json"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'scripts', 'release-operator.sh'), `#!/usr/bin/env bash
set -euo pipefail
umask 077
command="$1"; shift
manifest=""
staging_attestation=""
request_id=""
coordinator_checkpoint=""
no_sign=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) manifest="$2"; shift 2 ;;
    --staging-attestation) staging_attestation="$2"; shift 2 ;;
    --request-id) request_id="$2"; shift 2 ;;
    --coordinator-checkpoint) coordinator_checkpoint="$2"; shift 2 ;;
    --no-sign-request) no_sign=1; shift ;;
    *) shift ;;
  esac
done
sha="$(node -e 'process.stdout.write(require(process.argv[1]).payload.runtimeSha)' "$manifest")"
digest="$(node -e 'process.stdout.write(require(process.argv[1]).payload.artifact.digest)' "$manifest")"
if [ "$command" != staging ]; then printf '%s\n' "$command" >> "$OPERATIONS_LOG"; fi
case "$command" in
  status) ;;
  staging)
    [ "$no_sign" = 1 ] && [ -n "$request_id" ] && [ -n "$coordinator_checkpoint" ] || exit 64
    node -e 'const x=require(process.argv[1]);if(x.stagingAttempt?.status!=="deploy_started"||x.stagingAttempt?.requestId!==process.argv[2])process.exit(65)' "$coordinator_checkpoint" "$request_id"
    mkdir -p .local/release/staging
    manifest_sha="$(node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$manifest")"
    was_active=0
    [ ! -f "$STAGING_ACTIVE_MARKER" ] || was_active=1
    printf '%s\n' "$request_id" > "$STAGING_ACTIVE_MARKER"
    if [ "\${STAGING_INTERRUPT_AFTER_SWITCH:-0}" = 1 ] && [ "$was_active" = 0 ]; then
      printf 'staging-switch-interrupted\n' >> "$OPERATIONS_LOG"
      exit 75
    fi
    if [ "$was_active" = 1 ]; then
      printf 'staging-resume\n' >> "$OPERATIONS_LOG"
    else
      printf 'staging\n' >> "$OPERATIONS_LOG"
    fi
    node - ".local/release/staging/$sha-$digest.request.json" "$request_id" "$sha" "$digest" "$manifest_sha" <<'NODE'
const fs=require('node:fs');
const [file,requestId,runtimeSha,artifactDigest,releaseManifestSha256]=process.argv.slice(2);
const releaseDir='/home/dominguez/telegram-hub-bot-staging/releases/'+runtimeSha+'-'+artifactDigest.slice(0,12);
const services=[
 {name:'nexus-hub-staging',status:'online',cwd:releaseDir,releaseSha:runtimeSha},
 {name:'content-engine-staging',status:'online',cwd:releaseDir+'/content-engine',releaseSha:runtimeSha},
];
fs.writeFileSync(file,JSON.stringify({
 schema:'nexus.staging-attestation-request.v1',requestId,runtimeSha,artifactDigest,
 releaseManifestSha256,installedRuntimeDigest:'${'b'.repeat(64)}',
 recoveryRuntimeDigest:'${'c'.repeat(64)}',releaseDir,
 remoteIdentity:{schema:'nexus.pm2-release-identity.v1',services},
 remoteReadiness:{schema:'nexus.release-readiness.v1',role:'staging',runtimeSha,
  checks:{nativeBinding:true,sqliteIntegrity:true,sqliteForeignKeys:true,backendHealth:true,
   authenticatedContentEngine:true,pm2ExactIdentity:true,pm2RestartStable:true}},
 smoke:{status:'passed',command:'scripts/staging-smoke.sh',logSha256:'${'d'.repeat(64)}'},
 verifiedAt:'2026-07-24T12:00:00.000Z',expiresAt:'2027-07-24T12:00:00.000Z',
},null,2)+'\\n',{mode:0o600});
NODE
    ;;
  promote)
    mkdir -p .local/release/production
    installed_digest="$(node -e 'process.stdout.write(require(process.argv[1]).payload.installedRuntimeDigest)' "$staging_attestation")"
    installed_digest="\${PROMOTION_INSTALLED_DIGEST_OVERRIDE:-$installed_digest}"
    recovery_digest="$(node -e 'process.stdout.write(require(process.argv[1]).payload.recoveryRuntimeDigest)' "$staging_attestation")"
    manifest_sha="$(node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$manifest")"
    staging_sha="$(node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$staging_attestation")"
    node - ".local/release/production/$sha-$digest.json" "$sha" "$digest" "$installed_digest" \
      "$recovery_digest" "$manifest_sha" "$staging_sha" <<'NODE'
const fs=require('node:fs');
const [file,runtimeSha,artifactDigest,installedRuntimeDigest,recoveryRuntimeDigest,
 releaseManifestSha256,stagingAttestationSha256]=process.argv.slice(2);
const d=(character)=>character.repeat(64);
const transactionId='release-test-1234';
const checks={loopbackBackend:true,contentEngine:true,pm2Identity:true,
 publicHealth:true,authenticatedSnapshot:true};
const readiness=(verifiedAt)=>({schema:'nexus.candidate-readiness-refresh.v1',
 status:'passed',transactionId,runtimeSha,packageVersion:'4.14.231',verifiedAt,checks});
const evidenceSha256=d('f'),backupSha256=d('e'),recoveryPlaintext=d('d');
const provider='aws-s3';
const body={
 schema:'nexus.production-promotion-evidence.v1',status:'passed',runtimeSha,artifactDigest,
 installedRuntimeDigest,recoveryRuntimeDigest,releaseManifestSha256,stagingAttestationSha256,
 exactBackup:'/home/dominguez/telegram-hub-bot/backups/v4.14.230.tar.gz',
 startedAt:'2026-07-22T12:00:00Z',serviceUnavailableStartedAt:'2026-07-22T12:00:01Z',
 candidateAvailableAt:'2026-07-22T12:00:03Z',soakStartedAt:'2026-07-22T12:00:03Z',
 soakCompletedAt:'2026-07-22T12:01:03Z',completedAt:'2026-07-22T12:01:08Z',
 cutoverSeconds:63,backupSha256,drEscrowConfirmedAt:'2026-07-22T12:01:07Z',
 drStorageControls:{provider,controlMode:'versioned-s3',releasePrefixLockVerified:true},
 rollbackEscrow:{status:'passed',provider,
  objectKey:'nexus/releases/rollback.'+backupSha256+'.age',
  confirmedAt:'2026-07-22T12:01:05Z',objectVersionId:'release-version',
  retainUntil:'2027-01-01T00:00:00Z',encryptedSha256:d('a'),
  encryptedSizeBytes:100,evidenceSha256},
 preMutationCurrentRecoveryEscrow:{status:'passed',provider,transactionId,
  runtimeSha,artifactDigest,installedRuntimeDigest,recoveryRuntimeDigest,
  escrowId:transactionId,escrowPhase:'pre-mutation',plaintextSha256:recoveryPlaintext,
  objectKey:'nexus/releases/current+escrow-'+transactionId
   +'+phase-pre-mutation.tar.gz.'+recoveryPlaintext+'.age',
  confirmedAt:'2026-07-22T11:59:59Z',objectVersionId:'pre-recovery-version',
  retainUntil:'2027-01-01T00:00:00Z',encryptedSha256:d('1'),
  encryptedSizeBytes:101,evidenceSha256},
 currentRecoveryEscrow:{status:'passed',provider,transactionId,
  runtimeSha,artifactDigest,installedRuntimeDigest,recoveryRuntimeDigest,
  escrowId:transactionId,escrowPhase:'post-soak',plaintextSha256:recoveryPlaintext,
  objectKey:'nexus/releases/current+escrow-'+transactionId
   +'+phase-post-soak.tar.gz.'+recoveryPlaintext+'.age',
  confirmedAt:'2026-07-22T12:01:06Z',objectVersionId:'post-recovery-version',
  retainUntil:'2027-01-01T00:00:00Z',encryptedSha256:d('2'),
  encryptedSizeBytes:102,evidenceSha256},
 preMutationDatabaseRecoveryPoint:{status:'passed',provider,
  objectKey:'nexus/database/hourly/nexus-db-20260722T115958Z.sqlite.age',
  plaintextSha256:d('3'),encryptedSha256:d('4'),encryptedSizeBytes:103,
  confirmedAt:'2026-07-22T11:59:58Z',objectVersionId:'pre-database-version',
  retentionVariance:null,approvedUnversionedVariance:false,evidenceSha256},
 currentDatabaseRecoveryPoint:{status:'passed',provider,
  objectKey:'nexus/database/hourly/nexus-db-20260722T120107Z.sqlite.age',
  plaintextSha256:d('5'),encryptedSha256:d('6'),encryptedSizeBytes:104,
  confirmedAt:'2026-07-22T12:01:07Z',objectVersionId:'post-database-version',
  retentionVariance:null,approvedUnversionedVariance:false,evidenceSha256},
 backupWindowSeconds:2,backupOutageSeconds:2,finalUnavailabilitySeconds:3,
 totalUnavailabilitySeconds:3,verificationSoakSeconds:60,soakObservedSeconds:60,
 sentryRelease:runtimeSha,packageVersion:'4.14.231',transactionId,
 transactionMode:'systemd_oneshot',
 candidateReadinessRefresh:{beforeEscrow:readiness('2026-07-22T12:01:04Z'),
  afterEscrow:readiness('2026-07-22T12:01:08Z')},
 verification:{loopbackBackend:true,contentEngineHealth:true,
  authenticatedContentEngine:true,pm2AndCurrentIdentity:true,
  publicHealth:{baseUrl:'https://nexushub.chat',status:'healthy',database:'connected'},
  publicSnapshotVersion:'4.14.231'},
};
switch(process.env.PROMOTION_EVIDENCE_TAMPER){
 case 'readiness-before-dr':
  body.candidateReadinessRefresh.afterEscrow.verifiedAt='2026-07-22T12:01:06Z';
  body.completedAt='2026-07-22T12:01:06Z';
  break;
 case 'recovery-phase':
  body.currentRecoveryEscrow.escrowPhase='pre-mutation';
  break;
 case 'provider-semantics':
  body.drStorageControls={provider:'cloudflare-r2',
   controlMode:'r2-approved-variance',releasePrefixLockVerified:true};
  break;
}
fs.writeFileSync(file,JSON.stringify(body)+'\\n');
NODE
    ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'scripts', 'request-staging-attestation.sh'), `#!/usr/bin/env bash
set -euo pipefail
umask 077
request="$1"; output="$3"; shift 3
run_id=""
while [ "$#" -gt 0 ]; do
  case "$1" in --run-id) run_id="$2"; shift 2 ;; *) shift ;; esac
done
[ "$run_id" = 334455 ] || exit 64
printf 'staging-sign:%s\n' "$run_id" >> "$OPERATIONS_LOG"
if [ "\${STAGING_HELPER_INTERRUPT:-0}" = 1 ]; then exit 75; fi
mkdir -p "$(dirname "$output")"
node - "$request" "$output" <<'NODE'
const fs=require('node:fs');
const [request,output]=process.argv.slice(2);
const payload=JSON.parse(fs.readFileSync(request,'utf8'));
if(process.env.STAGING_HELPER_DIFFERENT_PAYLOAD==='1'){
 payload.installedRuntimeDigest='e'.repeat(64);
}
fs.writeFileSync(output,JSON.stringify({
 schema:'nexus.staging-attestation.v1',keyId:'fixture',signatureAlgorithm:'ed25519',
 payload,signature:'fixture',
})+'\\n',{mode:0o600});
NODE
`, { mode: 0o755 });

    // The coordinator intentionally rejects any checkout that differs from
    // origin/main, so the executable fixture scripts are part of the exact
    // protected-main revision under test rather than untracked test setup.
    spawnSync('git', ['add', 'scripts'], { cwd: root });
    spawnSync('git', ['commit', '-m', 'fixture release scripts'], { cwd: root });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: root });
    runtimeSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

    seedFixtureRoot = fixtureRoot;
    seedRepo = root;
    seedOrigin = path.join(fixtureRoot, 'origin.git');
    seedBin = path.join(fixtureRoot, 'bin');
    seedRuntimeSha = runtimeSha;
    seedDigest = fixtureTreeDigest(fixtureRoot);
    expect(seedRuntimeSha).toMatch(/^[a-f0-9]{40}$/u);
  });

  beforeEach(() => {
    expect(fixtureTreeDigest(seedFixtureRoot)).toBe(seedDigest);

    fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-sequence-')));
    root = path.join(fixtureRoot, 'repo');
    const remote = path.join(fixtureRoot, 'origin.git');
    const bin = path.join(fixtureRoot, 'bin');
    fs.cpSync(seedRepo, root, { recursive: true });
    fs.cpSync(seedOrigin, remote, { recursive: true });
    fs.cpSync(seedBin, bin, { recursive: true });
    expect(fixtureTreeDigest(fixtureRoot)).toBe(seedDigest);

    // The copied Git config still points to the immutable seed origin. Replace
    // that exact path without starting another Git process in every test.
    const gitConfigPath = path.join(root, '.git', 'config');
    const seedGitConfig = fs.readFileSync(gitConfigPath, 'utf8');
    expect(seedGitConfig.split(seedOrigin)).toHaveLength(2);
    fs.writeFileSync(gitConfigPath, seedGitConfig.replace(seedOrigin, remote));
    runtimeSha = seedRuntimeSha;
    operations = path.join(root, 'operations.log');
    rcRunMarker = path.join(fixtureRoot, 'rc-run-created-at.txt');
    manifestRunMarker = path.join(fixtureRoot, 'manifest-run-created-at.txt');
    stagingRunMarker = path.join(fixtureRoot, 'staging-run-created-at.txt');
    stagingActiveMarker = path.join(fixtureRoot, 'staging-active.txt');
    rcDispatchArgs = path.join(fixtureRoot, 'rc-dispatch-args.txt');
    rcWatchActiveMarker = path.join(fixtureRoot, 'rc-watch-active.txt');
    rcWatchReleaseMarker = path.join(fixtureRoot, 'rc-watch-release.txt');
    rcWatchTerminationReleaseMarker = path.join(fixtureRoot, 'rc-watch-termination-release.txt');
    rcWatchTerminatedMarker = path.join(fixtureRoot, 'rc-watch-terminated.txt');
    rcWatchCoordinatorPidMarker = path.join(fixtureRoot, 'rc-watch-coordinator-pid.txt');
    rcWatchChildPidMarker = path.join(fixtureRoot, 'rc-watch-child-pid.txt');
    ciViewCountMarker = path.join(fixtureRoot, 'ci-view-count.txt');
    securityViewCountMarker = path.join(fixtureRoot, 'security-view-count.txt');
    ciViewInterruptMarker = path.join(fixtureRoot, 'ci-view-interrupt.txt');
  });

  afterEach(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  afterAll(() => fs.rmSync(seedFixtureRoot, { recursive: true, force: true }));

  function coordinatorEnvironment(env: NodeJS.ProcessEnv = process.env) {
    return {
      ...env,
      NODE_ENV: 'test',
      NEXUS_RELEASE_TEST_ZERO_POLL_DELAY: '1',
      OPERATIONS_LOG: operations,
      FIXTURE_SHA: runtimeSha,
      RC_RUN_MARKER: rcRunMarker,
      MANIFEST_RUN_MARKER: manifestRunMarker,
      STAGING_RUN_MARKER: stagingRunMarker,
      STAGING_ACTIVE_MARKER: stagingActiveMarker,
      RC_DISPATCH_ARGS_FILE: rcDispatchArgs,
      RC_WATCH_ACTIVE_MARKER: rcWatchActiveMarker,
      RC_WATCH_RELEASE_MARKER: rcWatchReleaseMarker,
      RC_WATCH_TERMINATION_RELEASE_MARKER: rcWatchTerminationReleaseMarker,
      RC_WATCH_TERMINATED_MARKER: rcWatchTerminatedMarker,
      RC_WATCH_COORDINATOR_PID_MARKER: rcWatchCoordinatorPidMarker,
      RC_WATCH_CHILD_PID_MARKER: rcWatchChildPidMarker,
      CI_VIEW_COUNT_MARKER: ciViewCountMarker,
      SECURITY_VIEW_COUNT_MARKER: securityViewCountMarker,
      CI_VIEW_INTERRUPT_MARKER: ciViewInterruptMarker,
      PATH: `${path.join(fixtureRoot, 'bin')}:${env.PATH ?? process.env.PATH ?? ''}`,
    };
  }

  function run(extra: string[], env: NodeJS.ProcessEnv = process.env) {
    return spawnSync('node', [coordinator, '--root', root, ...extra], {
      cwd: root,
      encoding: 'utf8',
      env: coordinatorEnvironment(env),
    });
  }

  async function waitForFile(file: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(file), `timed out waiting for ${file}`).toBe(true);
  }

  async function waitForProcessExit(pid: number, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    let running = true;
    while (running && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error;
        running = false;
      }
    }
    expect(running, `timed out waiting for pid ${pid} to exit`).toBe(false);
  }

  it('serializes concurrent coordinators while preserving the lock inode', async () => {
    const holdMarker = path.join(fixtureRoot, 'lock-held');
    const releaseMarker = path.join(fixtureRoot, 'release-lock-holder');
    const first = spawn('node', [coordinator, '--root', root, '--backend-only'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: coordinatorEnvironment({
        ...process.env,
        LOCK_HOLD_MARKER: holdMarker,
        LOCK_RELEASE_MARKER: releaseMarker,
      }),
    });
    let firstStdout = '';
    let firstStderr = '';
    first.stdout.setEncoding('utf8');
    first.stderr.setEncoding('utf8');
    first.stdout.on('data', (chunk) => { firstStdout += chunk; });
    first.stderr.on('data', (chunk) => { firstStderr += chunk; });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(holdMarker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(holdMarker)).toBe(true);
    const lockPath = path.join(
      root,
      '.local',
      'release',
      'checkpoints',
      `${runtimeSha}.json.lock`,
    );
    const lockedInode = fs.statSync(lockPath).ino;

    const competing = run(['--backend-only']);
    expect(competing.status).toBe(73);
    expect(competing.stderr).toContain('another release resume process owns this checkpoint');
    expect(fs.statSync(lockPath).ino).toBe(lockedInode);

    fs.writeFileSync(releaseMarker, 'continue\n');
    const firstStatus = await new Promise<number | null>((resolve) => {
      first.once('exit', (code) => resolve(code));
    });
    expect(firstStatus, `${firstStderr}\n${firstStdout}`).toBe(3);
    expect(fs.statSync(lockPath).ino).toBe(lockedInode);

    const resumed = run([]);
    expect(resumed.status, resumed.stderr).toBe(3);
    expect(fs.statSync(lockPath).ino).toBe(lockedInode);
  });

  it('terminates an active release child before releasing the inherited OS lock', async () => {
    const first = spawn('node', [coordinator, '--root', root, '--backend-only'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: coordinatorEnvironment({
        ...process.env,
        GH_HOLD_RC_WATCH: '1',
      }),
    });
    let firstStderr = '';
    first.stderr.setEncoding('utf8');
    first.stderr.on('data', (chunk) => { firstStderr += chunk; });
    first.stdout.resume();
    await waitForFile(rcWatchActiveMarker);
    const innerPid = Number(fs.readFileSync(rcWatchCoordinatorPidMarker, 'utf8').trim());
    expect(Number.isSafeInteger(innerPid) && innerPid > 1).toBe(true);

    process.kill(innerPid, 'SIGTERM');
    await waitForFile(rcWatchTerminatedMarker);

    const competing = run(['--backend-only']);
    expect(competing.status).toBe(73);
    expect(competing.stderr).toContain('another release resume process owns this checkpoint');

    fs.writeFileSync(rcWatchTerminationReleaseMarker, 'terminate\n');
    const firstStatus = await new Promise<number | null>((resolve) => {
      first.once('exit', (code) => resolve(code));
    });
    expect(firstStatus, firstStderr).toBe(143);

    const resumed = run(['--backend-only']);
    expect(resumed.status, resumed.stderr).toBe(3);
  });

  it('keeps the OS lock in a live release child after coordinator SIGKILL', async () => {
    const first = spawn('node', [coordinator, '--root', root, '--backend-only'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: coordinatorEnvironment({
        ...process.env,
        GH_HOLD_RC_WATCH: '1',
      }),
    });
    first.stdout.resume();
    first.stderr.resume();
    await waitForFile(rcWatchActiveMarker);
    const innerPid = Number(fs.readFileSync(rcWatchCoordinatorPidMarker, 'utf8').trim());
    const releaseChildPid = Number(fs.readFileSync(rcWatchChildPidMarker, 'utf8').trim());
    expect(Number.isSafeInteger(innerPid) && innerPid > 1).toBe(true);
    expect(Number.isSafeInteger(releaseChildPid) && releaseChildPid > 1).toBe(true);

    process.kill(innerPid, 'SIGKILL');
    const firstStatus = await new Promise<number | null>((resolve) => {
      first.once('exit', (code) => resolve(code));
    });
    expect(firstStatus).toBe(137);

    const competing = run(['--backend-only']);
    expect(competing.status).toBe(73);
    expect(competing.stderr).toContain('another release resume process owns this checkpoint');

    fs.writeFileSync(rcWatchReleaseMarker, 'continue\n');
    await waitForProcessExit(releaseChildPid);

    const resumed = run(['--backend-only']);
    expect(resumed.status, resumed.stderr).toBe(3);
  });

  it('checkpoints signing and staging, then stops for current owner authorization', () => {
    const first = run(['--backend-only']);

    expect(first.status, first.stderr).toBe(3);
    const output = JSON.parse(first.stdout);
    expect(output.phase).toBe('owner_stop');
    expect(output.manualRequired).toBe(true);
    expect(output.reason).toBe('owner_stop_requires_new_invocation');
    expect(first.stderr).toContain(
      '"schema":"nexus.release-protected-workflow-notice.v1"',
    );
    expect(first.stderr).toContain('"url":"https://example.invalid/runs/223344"');
    expect(first.stderr).toContain('"url":"https://example.invalid/runs/334455"');
    expect(fs.readFileSync(operations, 'utf8').trim().split('\n')).toEqual([
      'rc-dispatch',
      'rc-watch',
      'manifest-sign-dispatch',
      'manifest-sign:223344',
      'status',
      'staging',
      'staging-sign-dispatch',
      'staging-sign:334455',
      'status',
    ]);

    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.phase).toBe('owner_stop');
    expect(checkpoint.rcRunId).toBe('123456');
    expect(checkpoint.contractScope).toBe('backend_only');
    expect(checkpoint.packageVersion).toBe('4.14.231');
    expect(checkpoint.originMainSha).toBe(runtimeSha);
    expect(checkpoint.workflows.security).toMatchObject({ runId: '9001', codeqlJobId: '9101' });
    expect(checkpoint.workflows.releaseCandidate).toMatchObject({ runId: '123456', headSha: runtimeSha });
    expect(checkpoint.workflows.security.workflowSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkpoint.rcDispatch).toMatchObject({
      status: 'completed',
      runId: '123456',
      correlationMode: 'unique_run_name_nonce_baseline_and_created_at',
    });
    expect(checkpoint.rcDispatch.correlationNonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(fs.readFileSync(rcDispatchArgs, 'utf8')).toContain(
      `correlation_nonce=${checkpoint.rcDispatch.correlationNonce}`,
    );
    expect(checkpoint.protectedReuseActivation).toMatchObject({
      status: 'fallback',
      reason: 'not_supplied',
    });
    expect(checkpoint.manifestSigningDispatch).toMatchObject({
      status: 'completed',
      runId: '223344',
      runUrl: 'https://example.invalid/runs/223344',
    });
    expect(checkpoint.stagingAttempt).toMatchObject({
      status: 'request_ready',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(checkpoint.stagingSigningDispatch).toMatchObject({
      status: 'completed',
      runId: '334455',
      runUrl: 'https://example.invalid/runs/334455',
    });
    expect(checkpoint.signedManifestIdentity).toMatchObject({
      path: path.join(root, '.local', 'release', 'manifests', `${runtimeSha}.json`),
      artifactDigest: 'a'.repeat(64),
    });
    expect(checkpoint.signedManifestIdentity.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkpoint.stagingAttestationIdentity).toMatchObject({
      path: path.join(root, '.local', 'release', 'staging', `${runtimeSha}-${'a'.repeat(64)}.signed.json`),
      installedRuntimeDigest: 'b'.repeat(64),
      recoveryRuntimeDigest: 'c'.repeat(64),
    });
    expect(checkpoint.stagingAttestationIdentity.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('never honors promotion signals from the invocation that first reaches the owner stop', () => {
    const preapproved = run(
      ['--backend-only', '--owner-authorized', '--promote'],
      { ...process.env, NEXUS_RELEASE_OWNER_AUTHORIZED: '1' },
    );
    expect(preapproved.status, preapproved.stderr).toBe(3);
    expect(JSON.parse(preapproved.stdout)).toMatchObject({
      phase: 'owner_stop',
      manualRequired: true,
      reason: 'owner_stop_requires_new_invocation',
    });
    expect(fs.readFileSync(operations, 'utf8')).not.toContain('promote\n');

    const laterInvocation = run(
      ['--owner-authorized', '--promote'],
      { ...process.env, NEXUS_RELEASE_OWNER_AUTHORIZED: '1' },
    );
    expect(laterInvocation.status, laterInvocation.stderr).toBe(0);
    expect(JSON.parse(laterInvocation.stdout).phase).toBe('promoted');
    expect(
      fs.readFileSync(operations, 'utf8').trim().split('\n')
        .filter((entry) => entry === 'promote'),
    ).toHaveLength(1);
  });

  it('resumes without repeating completed external work and promotes only with both owner signals', () => {
    expect(run(['--backend-only']).status).toBe(3);

    const missingEnvironment = run(['--owner-authorized', '--promote']);
    expect(missingEnvironment.status).toBe(1);
    expect(missingEnvironment.stderr).toContain('also requires NEXUS_RELEASE_OWNER_AUTHORIZED=1');

    const promoted = run(
      ['--owner-authorized', '--promote'],
      { ...process.env, NEXUS_RELEASE_OWNER_AUTHORIZED: '1' },
    );
    expect(promoted.status, promoted.stderr).toBe(0);
    expect(JSON.parse(promoted.stdout).phase).toBe('promoted');

    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'manifest-sign-dispatch')).toHaveLength(1);
    expect(operationList.filter((entry) => entry.startsWith('manifest-sign:'))).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'staging-sign-dispatch')).toHaveLength(1);
    expect(operationList.filter((entry) => entry.startsWith('staging-sign:'))).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'staging')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'promote')).toHaveLength(1);

    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.productionEvidenceIdentity).toMatchObject({
      runtimeSha,
      artifactDigest: 'a'.repeat(64),
      installedRuntimeDigest: 'b'.repeat(64),
      recoveryRuntimeDigest: 'c'.repeat(64),
      packageVersion: '4.14.231',
      transactionId: 'release-test-1234',
      backupSha256: 'e'.repeat(64),
      rollbackEscrowEvidenceSha256: 'f'.repeat(64),
    });

    const status = run(['--status']);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).phase).toBe('promoted');
  });

  it('treats a verified promoted checkpoint as terminal for every later invocation', () => {
    expect(run(['--backend-only']).status).toBe(3);
    const promoted = run(
      ['--owner-authorized', '--promote'],
      { ...process.env, NEXUS_RELEASE_OWNER_AUTHORIZED: '1' },
    );
    expect(promoted.status, promoted.stderr).toBe(0);

    const checkpointPath = path.join(
      root,
      '.local',
      'release',
      'checkpoints',
      `${runtimeSha}.json`,
    );
    const checkpointBefore = fs.readFileSync(checkpointPath);
    const operationsBefore = fs.readFileSync(operations, 'utf8');

    const plainResume = run([]);
    expect(plainResume.status, plainResume.stderr).toBe(0);
    expect(JSON.parse(plainResume.stdout).phase).toBe('promoted');
    const preapprovedResume = run(
      ['--owner-authorized', '--promote'],
      { ...process.env, NEXUS_RELEASE_OWNER_AUTHORIZED: '1' },
    );
    expect(preapprovedResume.status, preapprovedResume.stderr).toBe(0);
    expect(JSON.parse(preapprovedResume.stdout).phase).toBe('promoted');
    expect(fs.readFileSync(checkpointPath)).toEqual(checkpointBefore);
    expect(fs.readFileSync(operations, 'utf8')).toBe(operationsBefore);
    expect(
      operationsBefore.trim().split('\n').filter((entry) => entry === 'promote'),
    ).toHaveLength(1);
  });

  it('rejects an attempt to resume the checkpoint with a different RC identity', () => {
    expect(run(['--backend-only']).status).toBe(3);

    const mismatch = run(['--rc-run', '999999']);

    expect(mismatch.status).toBe(64);
    expect(mismatch.stderr).toContain('checkpoint RC run identity mismatch');
  });

  it('rejects an arbitrary RC id at sequence start and checkpoints terminal CodeQL failure', () => {
    const arbitrary = run(['--rc-run', '123456', '--backend-only']);
    expect(arbitrary.status).toBe(64);
    expect(arbitrary.stderr).toContain('dispatches its own RC');

    const missingSecurity = run(['--backend-only'], { ...process.env, GH_SECURITY_CONCLUSION: 'failure' });
    expect(missingSecurity.status).toBe(1);
    expect(missingSecurity.stderr).toContain(
      'security.yml did not reach exact-SHA terminal success (failure)',
    );
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.workflows.security).toMatchObject({
      status: 'terminal_failure',
      runId: '9001',
      observedStatus: 'completed',
      observedConclusion: 'failure',
    });
    expect(checkpoint.rcDispatch).toBeNull();
    expect(fs.existsSync(rcRunMarker)).toBe(false);
  });

  it('polls pending exact-SHA CI and CodeQL to success before dispatching RC once', () => {
    const result = run(
      ['--backend-only'],
      {
        ...process.env,
        GH_CI_SEQUENCE: 'pending,success',
        GH_SECURITY_SEQUENCE: 'pending,success',
      },
    );

    expect(result.status, result.stderr).toBe(3);
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.protectedMainChecks).toMatchObject({
      schema: 'nexus.release-required-workflows.v1',
      status: 'completed',
      headSha: runtimeSha,
    });
    expect(checkpoint.workflows.protectedMainCi).toMatchObject({
      workflow: 'ci.yml',
      workflowName: 'CI — Risk-based parallel matrix',
      workflowDatabaseId: 7001,
      workflowSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      status: 'completed',
      runId: '8001',
      attempt: 1,
      headSha: runtimeSha,
      observedConclusion: 'success',
      pollCount: 2,
      latestAttemptVerified: 1,
      latestWorkflowDatabaseIdVerified: 7001,
      latestAttemptVerifiedAt: expect.any(String),
    });
    expect(checkpoint.workflows.security).toMatchObject({
      workflow: 'security.yml',
      workflowDatabaseId: 7002,
      status: 'completed',
      runId: '9001',
      attempt: 1,
      codeqlJobId: '9101',
      codeqlConclusion: 'success',
      pollCount: 2,
      latestAttemptVerified: 1,
      latestWorkflowDatabaseIdVerified: 7002,
      latestAttemptVerifiedAt: expect.any(String),
    });
    // Successful polling remains distinct from one final live latest-attempt
    // check at the pre-dispatch boundary. The earlier duplicate revalidation
    // set is intentionally absent.
    expect(fs.readFileSync(ciViewCountMarker, 'utf8')).toBe('3');
    expect(fs.readFileSync(securityViewCountMarker, 'utf8')).toBe('3');
    expect(
      fs.readFileSync(operations, 'utf8').trim().split('\n')
        .filter((entry) => entry === 'rc-dispatch'),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: 'protected-main CI failure',
      env: { GH_CI_SEQUENCE: 'failure' },
      workflowKey: 'protectedMainCi',
      conclusion: 'failure',
      message: 'protected-main CI did not reach exact-SHA terminal success (failure)',
    },
    {
      label: 'security cancellation',
      env: { GH_SECURITY_SEQUENCE: 'cancelled' },
      workflowKey: 'security',
      conclusion: 'cancelled',
      message: 'security.yml did not reach exact-SHA terminal success (cancelled)',
    },
  ])('fails closed without RC dispatch on $label', ({
    env, workflowKey, conclusion, message,
  }) => {
    const result = run(['--backend-only'], { ...process.env, ...env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.workflows[workflowKey]).toMatchObject({
      status: 'terminal_failure',
      observedStatus: 'completed',
      observedConclusion: conclusion,
    });
    expect(checkpoint.rcDispatch).toBeNull();
    expect(fs.existsSync(rcRunMarker)).toBe(false);
  });

  it('fails closed on a checkpointed protected-workflow timeout', () => {
    const result = run(
      ['--backend-only'],
      {
        ...process.env,
        GH_CI_SEQUENCE: 'pending',
        NEXUS_RELEASE_TEST_PROTECTED_POLL_LIMIT: '1',
      },
    );

    expect(result.status).toBe(124);
    expect(result.stderr).toContain(
      'protected-main CI did not reach exact-SHA terminal success',
    );
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.workflows.protectedMainCi).toMatchObject({
      status: 'timed_out',
      runId: '8001',
      observedStatus: 'in_progress',
      pollCount: 1,
    });
    expect(checkpoint.rcDispatch).toBeNull();
    expect(fs.existsSync(rcRunMarker)).toBe(false);
  });

  it('rechecks CI after the sequential security wait and blocks changed success', () => {
    const result = run(
      ['--backend-only'],
      {
        ...process.env,
        GH_CI_SEQUENCE: 'success,failure',
        GH_SECURITY_SEQUENCE: 'pending,success',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'release checkpoint protected-main CI latest attempt is not successful (failure)',
    );
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.protectedMainChecks.status).toBe('completed');
    expect(checkpoint.workflows.protectedMainCi).toMatchObject({
      status: 'completed',
      runId: '8001',
      attempt: 1,
      workflowDatabaseId: 7001,
    });
    expect(checkpoint.workflows.security.status).toBe('completed');
    expect(checkpoint.rcDispatch).toMatchObject({
      schema: 'nexus.release-candidate-dispatch-intent.v1',
      status: 'intent_persisted',
    });
    expect(fs.existsSync(rcRunMarker)).toBe(false);
  });

  it('blocks a newer unverified CI attempt at the final pre-dispatch boundary', () => {
    const result = run(
      ['--backend-only'],
      {
        ...process.env,
        GH_CI_ATTEMPT_ADVANCES_AFTER_SECURITY: '1',
      },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      'release checkpoint protected-main CI is not bound to its latest exact-SHA attempt',
    );
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.workflows.protectedMainCi).toMatchObject({
      status: 'completed',
      attempt: 1,
      workflowDatabaseId: 7001,
    });
    expect(checkpoint.rcDispatch).toMatchObject({
      schema: 'nexus.release-candidate-dispatch-intent.v1',
      status: 'intent_persisted',
    });
    expect(fs.existsSync(rcRunMarker)).toBe(false);
  });

  it.each([
    {
      label: 'attempt',
      env: { GH_CI_VIEW_ATTEMPT: '2' },
    },
    {
      label: 'workflow database identity',
      env: { GH_CI_VIEW_WORKFLOW_ID: '7999' },
    },
  ])('rejects protected-main CI $label substitution without RC dispatch', ({ env }) => {
    const result = run(['--backend-only'], { ...process.env, ...env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'protected-main CI workflow run 8001 is not exact protected main',
    );
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.workflows.protectedMainCi).toMatchObject({
      status: 'run_identified',
      runId: '8001',
      attempt: 1,
      workflowDatabaseId: 7001,
    });
    expect(checkpoint.rcDispatch).toBeNull();
    expect(fs.existsSync(rcRunMarker)).toBe(false);
  });

  it('resumes a checkpointed exact-SHA CI run and never duplicates RC dispatch', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, GH_INTERRUPT_CI_VIEW_ONCE: '1' },
    );
    expect(interrupted.status).toBe(75);
    const checkpointPath = path.join(
      root,
      '.local',
      'release',
      'checkpoints',
      `${runtimeSha}.json`,
    );
    const interruptedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(interruptedCheckpoint.workflows.protectedMainCi).toMatchObject({
      status: 'run_identified',
      runId: '8001',
    });
    expect(interruptedCheckpoint.rcDispatch).toBeNull();
    expect(fs.existsSync(rcRunMarker)).toBe(false);

    const resumed = run(
      ['--backend-only'],
      { ...process.env, GH_INTERRUPT_CI_VIEW_ONCE: '1' },
    );
    expect(resumed.status, resumed.stderr).toBe(3);
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'rc-dispatch')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'rc-watch')).toHaveLength(1);
  });

  it('performs the final live workflow revalidation after a laptop pause', () => {
    const paused = run(
      ['--backend-only'],
      {
        ...process.env,
        NEXUS_RELEASE_TEST_PROTECTED_FRESHNESS_MS: '1000',
        NEXUS_RELEASE_TEST_RC_PRESPAWN_DELAY_MS: '1200',
      },
    );

    expect(paused.status, paused.stderr).toBe(3);
    const checkpointPath = path.join(
      root,
      '.local',
      'release',
      'checkpoints',
      `${runtimeSha}.json`,
    );
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(checkpoint.phase).toBe('owner_stop');
    expect(checkpoint.rcDispatch).toMatchObject({
      status: 'completed',
      protectedWorkflowBinding: {
        schema: 'nexus.release-candidate-protected-workflow-binding.v1',
      },
    });
    expect(checkpoint.rcDispatch.protectedWorkflowBinding.workflows.protectedMainCi)
      .toEqual(checkpoint.workflows.protectedMainCi.latestVerification);
    expect(checkpoint.rcDispatch.protectedWorkflowBinding.workflows.security)
      .toEqual(checkpoint.workflows.security.latestVerification);
    expect(checkpoint.inProgressStep).toBeNull();
    expect(fs.existsSync(rcRunMarker)).toBe(true);
    expect(
      fs.readFileSync(operations, 'utf8').trim().split('\n')
        .filter((entry) => entry === 'rc-dispatch'),
    ).toHaveLength(1);
  });

  it('keeps the RC intent retryable when the final live workflow revalidation fails', () => {
    const failed = run(
      ['--backend-only'],
      {
        ...process.env,
        GH_CI_SEQUENCE: 'success,failure',
      },
    );

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      'release checkpoint protected-main CI latest attempt is not successful (failure)',
    );
    const checkpointPath = path.join(
      root,
      '.local',
      'release',
      'checkpoints',
      `${runtimeSha}.json`,
    );
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(checkpoint.phase).toBe('rc_dispatch_intent');
    expect(checkpoint.rcDispatch).toMatchObject({ status: 'intent_persisted' });
    expect(checkpoint.inProgressStep).toBeNull();
    expect(fs.existsSync(rcRunMarker)).toBe(false);

    const resumed = run(['--backend-only']);
    expect(resumed.status, resumed.stderr).toBe(3);
    expect(
      fs.readFileSync(operations, 'utf8').trim().split('\n')
        .filter((entry) => entry === 'rc-dispatch'),
    ).toHaveLength(1);
  });

  it('revalidates branch protection and the exact stored CodeQL run on every resume', () => {
    expect(run(['--backend-only']).status).toBe(3);

    const unprotected = run(['--backend-only'], { ...process.env, GH_MAIN_PROTECTED: 'false' });
    expect(unprotected.status).toBe(1);
    expect(unprotected.stderr).toContain('origin/main is not protected according to GitHub');

    const failedCodeql = run(['--backend-only'], { ...process.env, GH_SECURITY_CONCLUSION: 'failure' });
    expect(failedCodeql.status).toBe(1);
    expect(failedCodeql.stderr).toContain(
      'release checkpoint security.yml latest attempt is not successful (failure)',
    );
  });

  it('keeps immutable protected evidence resumable after a newer workflow attempt', () => {
    expect(run(['--backend-only']).status).toBe(3);

    const resumed = run(
      ['--backend-only'],
      {
        ...process.env,
        GH_CI_LIST_ATTEMPT: '2',
        GH_SECURITY_LIST_ATTEMPT: '2',
      },
    );
    expect(resumed.status, resumed.stderr).toBe(3);
    expect(
      fs.readFileSync(operations, 'utf8').trim().split('\n')
        .filter((entry) => entry === 'rc-dispatch'),
    ).toHaveLength(1);
  });

  it('rejects locally rewritten CodeQL job identity even when the live run still succeeds', () => {
    expect(run(['--backend-only']).status).toBe(3);
    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    checkpoint.workflows.security.codeqlJobId = '9199';
    fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

    const resumed = run(['--backend-only']);
    expect(resumed.status).toBe(64);
    expect(resumed.stderr).toContain('CodeQL evidence no longer matches the exact stored run and job');
  });

  it('persists the exact RC run before watching and resumes it without duplicate dispatch', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, GH_INTERRUPT_RC_WATCH: '1' },
    );
    expect(interrupted.status, interrupted.stderr).toBe(75);

    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const interruptedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(interruptedCheckpoint.phase).toBe('rc_run_identified');
    expect(interruptedCheckpoint.rcRunId).toBe('123456');
    expect(interruptedCheckpoint.rcDispatch).toMatchObject({ status: 'run_identified', runId: '123456' });

    const resumed = run(['--backend-only']);
    expect(resumed.status, resumed.stderr).toBe(3);
    expect(JSON.parse(resumed.stdout).phase).toBe('owner_stop');
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'rc-dispatch')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'rc-watch-interrupted')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'rc-watch')).toHaveLength(1);
  });

  it('reconciles an uncertain accepted dispatch without dispatching a second RC', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, GH_INTERRUPT_AFTER_RC_DISPATCH: '1' },
    );
    expect(interrupted.status, interrupted.stderr).toBe(75);
    expect(interrupted.stderr).toContain('dispatch outcome is uncertain');

    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const interruptedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(interruptedCheckpoint.phase).toBe('rc_dispatch_started');
    expect(interruptedCheckpoint.rcRunId).toBeNull();
    expect(interruptedCheckpoint.rcDispatch.status).toBe('dispatch_started');

    const resumed = run(['--backend-only']);
    expect(resumed.status, resumed.stderr).toBe(3);
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'rc-dispatch')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'rc-watch')).toHaveLength(1);
  });

  it('does not select an unrelated same-SHA RC with a different correlation nonce', () => {
    const result = run(
      ['--backend-only'],
      { ...process.env, GH_RC_DIFFERENT_TITLE: '1' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'dispatched release-candidate workflow run was not uniquely found; refusing automatic redispatch',
    );
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'rc-dispatch')).toHaveLength(1);
  });

  it('snapshots and forwards only the exact private protected-main reuse activation', () => {
    const activation = path.join(fixtureRoot, 'protected-main-reuse-activation.json');
    const body = Buffer.from('{"schema":"nexus.protected-main-reuse-activation.v1","fixture":true}\n');
    fs.writeFileSync(activation, body, { mode: 0o600 });

    const result = run(['--backend-only', '--protected-reuse-activation', activation]);

    expect(result.status, result.stderr).toBe(3);
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.protectedReuseActivation).toMatchObject({
      status: 'forwarded',
      sizeBytes: body.length,
      mode: '0600',
    });
    expect(checkpoint.protectedReuseActivation.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const snapshot = checkpoint.protectedReuseActivation.snapshotPath;
    expect(fs.readFileSync(snapshot)).toEqual(body);
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o600);
    const dispatch = fs.readFileSync(rcDispatchArgs, 'utf8');
    expect(dispatch).toContain(`protected_reuse_activation_b64=${body.toString('base64')}`);
  });

  it.each([
    {
      name: 'group-readable input',
      prepare(file: string) {
        fs.writeFileSync(file, '{"schema":"fixture"}\n', { mode: 0o640 });
      },
    },
    {
      name: 'oversize input',
      prepare(file: string) {
        fs.writeFileSync(file, `${JSON.stringify({ payload: 'x'.repeat(45_001) })}\n`, { mode: 0o600 });
      },
    },
  ])('records explicit full-RC fallback for $name', ({ prepare }) => {
    const activation = path.join(fixtureRoot, 'unsafe-activation.json');
    prepare(activation);

    const result = run(['--backend-only', '--protected-reuse-activation', activation]);

    expect(result.status, result.stderr).toBe(3);
    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    expect(checkpoint.protectedReuseActivation).toMatchObject({
      status: 'fallback',
      reason: 'unsafe_invalid_or_oversize',
    });
    expect(fs.readFileSync(rcDispatchArgs, 'utf8')).not.toContain('protected_reuse_activation_b64=');
  });

  it('blocks checkpointed activation snapshot tamper and post-intent substitution', () => {
    const activation = path.join(fixtureRoot, 'activation.json');
    fs.writeFileSync(activation, '{"schema":"activation-a"}\n', { mode: 0o600 });
    expect(run(['--backend-only', '--protected-reuse-activation', activation]).status).toBe(3);
    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    const snapshotBody = fs.readFileSync(checkpoint.protectedReuseActivation.snapshotPath);
    fs.appendFileSync(checkpoint.protectedReuseActivation.snapshotPath, ' ');

    const tampered = run([]);
    expect(tampered.status).toBe(64);
    expect(tampered.stderr).toContain('activation snapshot drifted');

    fs.writeFileSync(checkpoint.protectedReuseActivation.snapshotPath, snapshotBody, { mode: 0o600 });
    const replacement = path.join(fixtureRoot, 'activation-b.json');
    fs.writeFileSync(replacement, '{"schema":"activation-b"}\n', { mode: 0o600 });
    const substituted = run(['--protected-reuse-activation', replacement]);
    expect(substituted.status).toBe(64);
    expect(substituted.stderr).toContain('differs from the checkpoint binding');
  });

  it('reconciles manifest-signing dispatch failure without a duplicate protected approval', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, GH_INTERRUPT_AFTER_MANIFEST_DISPATCH: '1' },
    );
    expect(interrupted.status, interrupted.stderr).toBe(75);
    expect(interrupted.stderr).toContain('resume will reconcile without redispatch');
    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const interruptedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(interruptedCheckpoint.manifestSigningDispatch).toMatchObject({
      status: 'dispatch_started',
    });
    expect(interruptedCheckpoint.manifestSigningDispatch.runId).toBeUndefined();

    const resumed = run([]);
    expect(resumed.status, resumed.stderr).toBe(3);
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'manifest-sign-dispatch')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'manifest-sign:223344')).toHaveLength(1);
  });

  it('resumes the exact manifest-signing run after watcher/download interruption', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, MANIFEST_HELPER_INTERRUPT: '1' },
    );
    expect(interrupted.status, interrupted.stderr).toBe(75);
    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const interruptedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(interruptedCheckpoint.manifestSigningDispatch).toMatchObject({
      status: 'run_identified',
      runId: '223344',
    });

    expect(run([]).status).toBe(3);
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'manifest-sign-dispatch')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'manifest-sign:223344')).toHaveLength(2);
  });

  it('fails closed when manifest-signing correlation is ambiguous', () => {
    const result = run(
      ['--backend-only'],
      { ...process.env, GH_MANIFEST_SIGNING_AMBIGUOUS: '1' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dispatch correlation is ambiguous');
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'manifest-sign-dispatch')).toHaveLength(1);
  });

  it('revalidates an already-active exact staging release after an interrupted switch', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, STAGING_INTERRUPT_AFTER_SWITCH: '1' },
    );
    expect(interrupted.status, interrupted.stderr).toBe(75);
    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const interruptedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    const requestId = interruptedCheckpoint.stagingAttempt.requestId;
    expect(interruptedCheckpoint.stagingAttempt.status).toBe('deploy_started');

    const resumed = run([]);
    expect(resumed.status, resumed.stderr).toBe(3);
    const completedCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(completedCheckpoint.stagingAttempt.requestId).toBe(requestId);
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'staging-switch-interrupted')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'staging-resume')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'staging')).toHaveLength(0);
  });

  it('reconciles staging-signing dispatch failure without duplicate dispatch or restaging', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, GH_INTERRUPT_AFTER_STAGING_DISPATCH: '1' },
    );
    expect(interrupted.status, interrupted.stderr).toBe(75);
    expect(interrupted.stderr).toContain('resume will reconcile without redispatch');

    const resumed = run([]);
    expect(resumed.status, resumed.stderr).toBe(3);
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'staging')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'staging-sign-dispatch')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'staging-sign:334455')).toHaveLength(1);
  });

  it('blocks a checkpointed staging request from drifting before signing resumes', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, STAGING_HELPER_INTERRUPT: '1' },
    );
    expect(interrupted.status, interrupted.stderr).toBe(75);
    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    fs.appendFileSync(checkpoint.stagingAttempt.requestPath, ' ');

    const resumed = run([]);
    expect(resumed.status).toBe(64);
    expect(resumed.stderr).toContain('staging attestation request drifted');
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'staging-sign-dispatch')).toHaveLength(1);
  });

  it('fails closed when staging-signing correlation is ambiguous', () => {
    const result = run(
      ['--backend-only'],
      { ...process.env, GH_STAGING_SIGNING_AMBIGUOUS: '1' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dispatch correlation is ambiguous');
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'staging')).toHaveLength(1);
    expect(operationList.filter((entry) => entry === 'staging-sign-dispatch')).toHaveLength(1);
  });

  it('does not reconcile an uncertain staging dispatch to the same UUID with another request digest', () => {
    const interrupted = run(
      ['--backend-only'],
      { ...process.env, GH_INTERRUPT_AFTER_STAGING_DISPATCH: '1' },
    );
    expect(interrupted.status, interrupted.stderr).toBe(75);

    const resumed = run(
      [],
      { ...process.env, GH_STAGING_DIFFERENT_REQUEST_DIGEST: '1' },
    );

    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain(
      'sign-staging-attestation.yml run was not uniquely found; refusing automatic redispatch',
    );
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'staging-sign-dispatch')).toHaveLength(1);
  }, 30_000);

  it('rejects a signed staging payload with the same request UUID but different trust digests', () => {
    const result = run(
      ['--backend-only'],
      { ...process.env, STAGING_HELPER_DIFFERENT_PAYLOAD: '1' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('signed staging attestation installed-tree identity is invalid');
    const operationList = fs.readFileSync(operations, 'utf8').trim().split('\n');
    expect(operationList.filter((entry) => entry === 'staging-sign-dispatch')).toHaveLength(1);
  });

  it('rejects signed-manifest content and path drift on resume', () => {
    expect(run(['--backend-only']).status).toBe(3);
    const manifestPath = path.join(root, '.local', 'release', 'manifests', `${runtimeSha}.json`);
    fs.appendFileSync(manifestPath, ' \n');

    const changedContent = run(['--backend-only']);
    expect(changedContent.status).toBe(1);
    expect(changedContent.stderr).toContain('signed release manifest identity drifted');

    const checkpoint = JSON.parse(fs.readFileSync(
      path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`),
      'utf8',
    ));
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      payload: {
        runtimeSha,
        packageVersion: '4.14.231',
        artifact: { digest: checkpoint.artifactDigest },
      },
    })}\n`);
    // Restore the exact original bytes from the recorded fixture format.
    fs.writeFileSync(manifestPath, `{"payload":{"runtimeSha":"${runtimeSha}","packageVersion":"4.14.231","artifact":{"digest":"${'a'.repeat(64)}"}}}\n`);
    const alternatePath = path.join(root, '.local', 'release', 'manifests', 'alternate.json');
    fs.copyFileSync(manifestPath, alternatePath);
    const changedPath = run(['--backend-only', '--manifest', alternatePath]);
    expect(changedPath.status).toBe(64);
    expect(changedPath.stderr).toContain('manifest path differs from the checkpoint identity');
  });

  it('rejects staging-attestation content and path drift on resume', () => {
    expect(run(['--backend-only']).status).toBe(3);
    const stagingPath = path.join(
      root,
      '.local',
      'release',
      'staging',
      `${runtimeSha}-${'a'.repeat(64)}.signed.json`,
    );
    const original = fs.readFileSync(stagingPath);
    fs.appendFileSync(stagingPath, ' \n');

    const changedContent = run(['--backend-only']);
    expect(changedContent.status).toBe(1);
    expect(changedContent.stderr).toContain('staging attestation identity drifted');

    fs.writeFileSync(stagingPath, original);
    const alternatePath = path.join(root, '.local', 'release', 'staging', 'alternate.signed.json');
    fs.copyFileSync(stagingPath, alternatePath);
    const changedPath = run(['--backend-only', '--staging-attestation', alternatePath]);
    expect(changedPath.status).toBe(64);
    expect(changedPath.stderr).toContain('staging attestation path differs from the checkpoint identity');
  });

  it('rejects installed-tree identity drift on resume and in production evidence', () => {
    expect(run(['--backend-only']).status).toBe(3);
    const checkpointPath = path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`);
    const originalCheckpoint = fs.readFileSync(checkpointPath);
    const changedCheckpoint = JSON.parse(originalCheckpoint.toString('utf8'));
    changedCheckpoint.installedRuntimeDigest = 'c'.repeat(64);
    fs.writeFileSync(checkpointPath, `${JSON.stringify(changedCheckpoint, null, 2)}\n`);

    const resumeDrift = run(['--backend-only']);
    expect(resumeDrift.status).toBe(1);
    expect(resumeDrift.stderr).toContain('staging attestation identity drifted');

    fs.writeFileSync(checkpointPath, originalCheckpoint);
    const productionDrift = run(
      ['--owner-authorized', '--promote'],
      {
        ...process.env,
        NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
        PROMOTION_INSTALLED_DIGEST_OVERRIDE: 'c'.repeat(64),
      },
    );
    expect(productionDrift.status).toBe(1);
    expect(productionDrift.stderr).toContain('production promotion evidence does not match');
  });

  it.each([
    'readiness-before-dr',
    'recovery-phase',
    'provider-semantics',
  ])('rejects incomplete production recovery evidence: %s', (tamperMode) => {
    expect(run(['--backend-only']).status).toBe(3);
    const result = run(
      ['--owner-authorized', '--promote'],
      {
        ...process.env,
        NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
        PROMOTION_EVIDENCE_TAMPER: tamperMode,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('production promotion evidence does not match');
  });
});

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const coordinator = path.resolve('scripts/release-sequence.mjs');

describe('resumable exact-release sequence', () => {
  let root: string;
  let fixtureRoot: string;
  let runtimeSha: string;
  let operations: string;
  let rcRunMarker: string;

  beforeEach(() => {
    fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-sequence-')));
    root = path.join(fixtureRoot, 'repo');
    fs.mkdirSync(root);
    operations = path.join(root, 'operations.log');
    rcRunMarker = path.join(fixtureRoot, 'rc-run-created-at.txt');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"4.14.231"}\n');
    fs.writeFileSync(path.join(root, '.gitignore'), '.local/\noperations.log\n');
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'security.yml'), 'name: Security — supply chain and static analysis\n');
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'release-candidate-evidence.yml'), 'name: RC — Release Evidence\n');
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
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  "repo view --json nameWithOwner") printf '{"nameWithOwner":"fixture/repository"}\n' ;;
  "api repos/fixture/repository/branches/main")
    protected="\${GH_MAIN_PROTECTED:-true}"
    printf '{"name":"main","protected":%s}\n' "$protected"
    ;;
  "run list --workflow security.yml"*)
    conclusion="\${GH_SECURITY_CONCLUSION:-success}"
    printf '[{"databaseId":9001,"headSha":"%s","status":"completed","conclusion":"%s","createdAt":"2026-07-22T12:00:00Z"}]\n' "$FIXTURE_SHA" "$conclusion"
    ;;
  "run view 9001"*)
    conclusion="\${GH_SECURITY_CONCLUSION:-success}"
    printf '{"databaseId":9001,"headSha":"%s","headBranch":"main","event":"push","status":"completed","conclusion":"%s","workflowName":"Security — supply chain and static analysis","url":"https://example.invalid/runs/9001","jobs":[{"databaseId":9101,"name":"CodeQL JavaScript/TypeScript","status":"completed","conclusion":"%s"}]}\n' "$FIXTURE_SHA" "$conclusion" "$conclusion"
    ;;
  "workflow run release-candidate-evidence.yml"*)
    checkpoint=".local/release/checkpoints/$FIXTURE_SHA.json"
    node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(x.phase!=="rc_dispatch_started"||x.rcDispatch?.status!=="dispatch_started"||!x.sourceIntent||!x.workflows?.security||x.rcRunId!==null)process.exit(65)' "$checkpoint"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$RC_RUN_MARKER"
    printf 'rc-dispatch\n' >> "$OPERATIONS_LOG"
    if [ "\${GH_INTERRUPT_AFTER_RC_DISPATCH:-0}" = 1 ]; then
      exit 75
    fi
    ;;
  "run list --workflow release-candidate-evidence.yml"*)
    if [ -f "$RC_RUN_MARKER" ]; then
      printf '[{"databaseId":123456,"headSha":"%s","status":"completed","conclusion":"success","createdAt":"%s"}]\n' "$FIXTURE_SHA" "$(cat "$RC_RUN_MARKER")"
    else
      printf '[]\n'
    fi
    ;;
  "run watch 123456 --exit-status")
    if [ "\${GH_INTERRUPT_RC_WATCH:-0}" = 1 ]; then
      printf 'rc-watch-interrupted\n' >> "$OPERATIONS_LOG"
      exit 75
    fi
    printf 'rc-watch\n' >> "$OPERATIONS_LOG"
    ;;
  "run view 123456"*)
    printf '{"databaseId":123456,"headSha":"%s","headBranch":"main","event":"workflow_dispatch","status":"completed","conclusion":"success","workflowName":"RC — Release Evidence","url":"https://example.invalid/runs/123456","jobs":[]}\n' "$FIXTURE_SHA"
    ;;
  *) echo "unexpected gh invocation: $args" >&2; exit 64 ;;
esac
`, { mode: 0o755 });

    fs.writeFileSync(path.join(root, 'scripts', 'request-release-manifest-signature.sh'), `#!/usr/bin/env bash
set -euo pipefail
sha="$1"; install_root="$3"
printf 'sign:%s\n' "$2" >> "$OPERATIONS_LOG"
mkdir -p "$install_root/.local/release/manifests"
printf '{"payload":{"runtimeSha":"%s","packageVersion":"4.14.231","artifact":{"digest":"%s"}}}\n' "$sha" "${'a'.repeat(64)}" > "$install_root/.local/release/manifests/$sha.json"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'scripts', 'release-operator.sh'), `#!/usr/bin/env bash
set -euo pipefail
command="$1"; shift
manifest=""
staging_attestation=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) manifest="$2"; shift 2 ;;
    --staging-attestation) staging_attestation="$2"; shift 2 ;;
    *) shift ;;
  esac
done
sha="$(node -e 'process.stdout.write(require(process.argv[1]).payload.runtimeSha)' "$manifest")"
digest="$(node -e 'process.stdout.write(require(process.argv[1]).payload.artifact.digest)' "$manifest")"
printf '%s\n' "$command" >> "$OPERATIONS_LOG"
case "$command" in
  status) ;;
  staging)
    mkdir -p .local/release/staging
    manifest_sha="$(node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$manifest")"
    printf '{"payload":{"runtimeSha":"%s","artifactDigest":"%s","releaseManifestSha256":"%s","installedRuntimeDigest":"%s"}}\n' "$sha" "$digest" "$manifest_sha" "${'b'.repeat(64)}" > ".local/release/staging/$sha-$digest.signed.json"
    ;;
  promote)
    mkdir -p .local/release/production
    installed_digest="$(node -e 'process.stdout.write(require(process.argv[1]).payload.installedRuntimeDigest)' "$staging_attestation")"
    installed_digest="\${PROMOTION_INSTALLED_DIGEST_OVERRIDE:-$installed_digest}"
    printf '{"status":"passed","runtimeSha":"%s","artifactDigest":"%s","installedRuntimeDigest":"%s","backupSha256":"%s","rollbackEscrow":{"status":"passed","objectKey":"nexus/releases/rollback.%s.age","evidenceSha256":"%s"},"completedAt":"2026-07-22T12:00:00Z"}\n' "$sha" "$digest" "$installed_digest" "${'e'.repeat(64)}" "${'e'.repeat(64)}" "${'f'.repeat(64)}" > ".local/release/production/$sha-$digest.json"
    ;;
  *) exit 64 ;;
esac
`, { mode: 0o755 });

    // The coordinator intentionally rejects any checkout that differs from
    // origin/main, so the executable fixture scripts are part of the exact
    // protected-main revision under test rather than untracked test setup.
    spawnSync('git', ['add', 'scripts'], { cwd: root });
    spawnSync('git', ['commit', '-m', 'fixture release scripts'], { cwd: root });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: root });
    runtimeSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  });

  afterEach(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  function run(extra: string[], env: NodeJS.ProcessEnv = process.env) {
    return spawnSync('node', [coordinator, '--root', root, ...extra], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...env,
        OPERATIONS_LOG: operations,
        FIXTURE_SHA: runtimeSha,
        RC_RUN_MARKER: rcRunMarker,
        PATH: `${path.join(fixtureRoot, 'bin')}:${env.PATH ?? process.env.PATH ?? ''}`,
      },
    });
  }

  it('checkpoints signing and staging, then stops for current owner authorization', () => {
    const first = run(['--backend-only']);

    expect(first.status, first.stderr).toBe(3);
    const output = JSON.parse(first.stdout);
    expect(output.phase).toBe('owner_stop');
    expect(output.manualRequired).toBe(true);
    expect(output.reason).toBe('owner_authorization_not_automatic');
    expect(fs.readFileSync(operations, 'utf8').trim().split('\n')).toEqual([
      'rc-dispatch',
      'rc-watch',
      'sign:123456',
      'status',
      'staging',
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
      correlationMode: 'baseline_run_ids_and_created_at',
    });
    expect(checkpoint.signedManifestIdentity).toMatchObject({
      path: path.join(root, '.local', 'release', 'manifests', `${runtimeSha}.json`),
      artifactDigest: 'a'.repeat(64),
    });
    expect(checkpoint.signedManifestIdentity.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkpoint.stagingAttestationIdentity).toMatchObject({
      path: path.join(root, '.local', 'release', 'staging', `${runtimeSha}-${'a'.repeat(64)}.signed.json`),
      installedRuntimeDigest: 'b'.repeat(64),
    });
    expect(checkpoint.stagingAttestationIdentity.sha256).toMatch(/^[a-f0-9]{64}$/u);
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
    expect(operationList.filter((entry) => entry.startsWith('sign:'))).toHaveLength(1);
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
      backupSha256: 'e'.repeat(64),
      rollbackEscrowEvidenceSha256: 'f'.repeat(64),
    });

    const status = run(['--status']);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).phase).toBe('promoted');
  });

  it('rejects an attempt to resume the checkpoint with a different RC identity', () => {
    expect(run(['--backend-only']).status).toBe(3);

    const mismatch = run(['--rc-run', '999999']);

    expect(mismatch.status).toBe(64);
    expect(mismatch.stderr).toContain('checkpoint RC run identity mismatch');
  });

  it('rejects an arbitrary RC id at sequence start and fails when exact-SHA CodeQL evidence is absent', () => {
    const arbitrary = run(['--rc-run', '123456', '--backend-only']);
    expect(arbitrary.status).toBe(64);
    expect(arbitrary.stderr).toContain('dispatches its own RC');

    const missingSecurity = run(['--backend-only'], { ...process.env, GH_SECURITY_CONCLUSION: 'failure' });
    expect(missingSecurity.status).toBe(1);
    expect(missingSecurity.stderr).toContain('security.yml evidence for exact origin/main is missing');
    expect(fs.existsSync(path.join(root, '.local', 'release', 'checkpoints', `${runtimeSha}.json`))).toBe(false);
  });

  it('revalidates branch protection and the exact stored CodeQL run on every resume', () => {
    expect(run(['--backend-only']).status).toBe(3);

    const unprotected = run(['--backend-only'], { ...process.env, GH_MAIN_PROTECTED: 'false' });
    expect(unprotected.status).toBe(1);
    expect(unprotected.stderr).toContain('origin/main is not protected according to GitHub');

    const failedCodeql = run(['--backend-only'], { ...process.env, GH_SECURITY_CONCLUSION: 'failure' });
    expect(failedCodeql.status).toBe(1);
    expect(failedCodeql.stderr).toContain('is not a successful exact origin/main run');
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
});

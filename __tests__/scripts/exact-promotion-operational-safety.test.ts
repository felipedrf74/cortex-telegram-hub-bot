import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const PROMOTE = join(ROOT, 'scripts', 'promote-exact-release.sh');
const PROMOTION_AUTHORIZATION = join(ROOT, 'scripts', 'promotion-authorization.mjs');
const RELEASE_OPERATOR = join(ROOT, 'scripts', 'release-operator.sh');
const RELEASE_GATES = join(ROOT, 'scripts', 'lib', 'release-gates.sh');

function source(path: string) {
  return readFileSync(path, 'utf8');
}

function cleanGitEnv(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) delete env[key];
  return { ...env, ...overrides };
}

function heredocBody(raw: string, label: string) {
  const opener = raw.indexOf(`<<'${label}'`);
  expect(opener, `missing ${label} opener`).toBeGreaterThan(-1);
  const bodyStart = raw.indexOf('\n', opener) + 1;
  const closer = raw.indexOf(`\n${label}\n`, bodyStart);
  expect(closer, `missing ${label} closer`).toBeGreaterThan(bodyStart);
  return raw.slice(bodyStart, closer);
}

function expectBoundedPerAttemptHealth(section: string, ports: number[]) {
  const loop = section.indexOf('for _ in $(seq');
  expect(loop).toBeGreaterThan(-1);
  const firstCurl = section.indexOf('curl ', loop);
  expect(firstCurl).toBeGreaterThan(loop);

  // A failed first attempt must not leave a true value latched for the next
  // attempt. Both flags are reset inside the retry loop, before either curl.
  for (const flag of ['backend_ok=false', 'content_ok=false']) {
    const reset = section.indexOf(flag, loop);
    expect(reset, `${flag} must reset inside the retry loop`).toBeGreaterThan(loop);
    expect(reset, `${flag} must reset before the first probe`).toBeLessThan(firstCurl);
  }

  for (const port of ports) {
    const url = section.indexOf(`127.0.0.1:${port}/health`, loop);
    expect(url, `missing loopback health probe for ${port}`).toBeGreaterThan(loop);
    const commandStart = section.lastIndexOf('curl ', url);
    expect(commandStart, `missing curl command for ${port}`).toBeGreaterThan(loop);
    const command = section.slice(commandStart, url);
    expect(command).toContain('--connect-timeout');
    expect(command).toContain('--max-time');
  }
}

function writeSshShim(binDir: string) {
  const shim = join(binDir, 'ssh');
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
`,
    { mode: 0o755 },
  );
}

function runExpiredUnsignedResumeFixture(
  statusMode: 'not-found' | 'existing' | 'malformed-not-found' | 'unreachable',
) {
  const fixture = mkdtempSync(join(tmpdir(), `exact-promotion-expired-unsigned-${statusMode}-`));
  const scriptsDir = join(fixture, 'scripts');
  const binDir = join(fixture, 'bin');
  const requestDir = join(fixture, '.local', 'release', 'transactions');
  const serverLog = join(fixture, '.local', 'server.log');
  const productionBase = '/home/dominguez/production';
  const stagingBase = '/home/dominguez/staging';
  const server = 'fixture-server';
  const oldTransactionId = '20260723T120000Z-4321-abcdef123456';
  const artifactDigest = 'c'.repeat(64);
  const installedRuntimeDigest = 'd'.repeat(64);
  const recoveryRuntimeDigest = 'e'.repeat(64);
  const predecessorArtifactDigest = 'a'.repeat(64);
  const predecessorInstalledRuntimeDigest = 'b'.repeat(64);
  const targetVersion = '4.14.231';
  const gitEnv = cleanGitEnv();

  mkdirSync(join(scriptsDir, 'lib'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  copyFileSync(PROMOTE, join(scriptsDir, 'promote-exact-release.sh'));
  chmodSync(join(scriptsDir, 'promote-exact-release.sh'), 0o755);
  writeFileSync(join(fixture, '.gitignore'), '.local/\n');
  writeFileSync(join(scriptsDir, 'lib', 'release-gates.sh'), `#!/usr/bin/env bash
release_require_git_worktree() { return 0; }
release_require_clean_tree() { return 0; }
release_acquire_local_lock() { return 0; }
release_acquire_remote_lock() { return 0; }
release_cleanup_all_locks() { return 0; }
`);
  writeFileSync(
    join(scriptsDir, 'rollback-drill-check.mjs'),
    '#!/usr/bin/env node\nprocess.exit(0);\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(scriptsDir, 'migration-safety-check.mjs'),
    'process.stdout.write(JSON.stringify({irreversibleChangedMigrations:[],reviewEvidence:null}));\n',
  );
  writeFileSync(join(scriptsDir, 'env-parity-check.sh'), '#!/usr/bin/env bash\nexit 0\n', {
    mode: 0o755,
  });
  writeFileSync(join(scriptsDir, 'remote-release-capacity.sh'), '# fixture capacity\n');
  for (let migration = 239; migration <= 253; migration += 1) {
    mkdirSync(join(fixture, 'migrations'), { recursive: true });
    writeFileSync(
      join(fixture, 'migrations', `${migration}_fixture.sql`),
      `-- fixture ${migration}\n`,
    );
  }

  expect(spawnSync('git', ['init', '--initial-branch=main'], {
    cwd: fixture,
    env: gitEnv,
  }).status).toBe(0);
  expect(spawnSync('git', ['config', 'user.name', 'Release Fixture'], {
    cwd: fixture,
    env: gitEnv,
  }).status).toBe(0);
  expect(spawnSync('git', ['config', 'user.email', 'release@example.invalid'], {
    cwd: fixture,
    env: gitEnv,
  }).status).toBe(0);
  expect(spawnSync('git', ['add', '.'], { cwd: fixture, env: gitEnv }).status).toBe(0);
  expect(spawnSync('git', ['commit', '-m', 'base fixture'], {
    cwd: fixture,
    env: gitEnv,
  }).status).toBe(0);
  const predecessorSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture,
    encoding: 'utf8',
    env: gitEnv,
  }).stdout.trim();
  writeFileSync(join(fixture, 'target.txt'), 'target\n');
  expect(spawnSync('git', ['add', 'target.txt'], { cwd: fixture, env: gitEnv }).status).toBe(0);
  expect(spawnSync('git', ['commit', '-m', 'target fixture'], {
    cwd: fixture,
    env: gitEnv,
  }).status).toBe(0);
  const runtimeSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture,
    encoding: 'utf8',
    env: gitEnv,
  }).stdout.trim();
  const predecessorRuntime = `${productionBase}/releases/${predecessorSha}-${predecessorArtifactDigest.slice(0, 12)}`;
  const productionRelease = `${productionBase}/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`;

  mkdirSync(requestDir, { recursive: true });
  for (const directory of [
    join(fixture, '.local'),
    join(fixture, '.local', 'release'),
    requestDir,
  ]) chmodSync(directory, 0o700);
  const localRoot = realpathSync(join(fixture, '.local'));
  const releaseManifestPath = join(localRoot, 'release-manifest.json');
  const releaseManifestBody = `${JSON.stringify({
    schema: 'nexus.release-manifest.v2',
    payload: { runtimeSha, artifact: { digest: artifactDigest } },
  })}\n`;
  writeFileSync(releaseManifestPath, releaseManifestBody, { mode: 0o600 });
  const releaseManifestSha256 = createHash('sha256').update(releaseManifestBody).digest('hex');
  const stagingAttestationPath = join(localRoot, 'staging-attestation.json');
  const stagingAttestationBody = `${JSON.stringify({
    schema: 'nexus.staging-attestation.v1',
    payload: {
      runtimeSha,
      artifactDigest,
      installedRuntimeDigest,
      recoveryRuntimeDigest,
      releaseManifestSha256,
    },
  })}\n`;
  writeFileSync(stagingAttestationPath, stagingAttestationBody, { mode: 0o600 });
  const stagingAttestationSha256 = createHash('sha256')
    .update(stagingAttestationBody).digest('hex');
  const checkpointPath = join(
    requestDir,
    `${runtimeSha}-${artifactDigest}.checkpoint.json`,
  );
  const checkpointBody = `${JSON.stringify({
    schema: 'nexus.promotion-client-checkpoint.v1',
    transactionId: oldTransactionId,
    startedAt: '2026-07-23T12:00:00.000Z',
    runtimeSha,
    artifactDigest,
    installedRuntimeDigest,
    recoveryRuntimeDigest,
    releaseManifestSha256,
    stagingAttestationSha256,
    targetVersion,
    server,
    productionBase,
  }, null, 2)}\n`;
  writeFileSync(checkpointPath, checkpointBody, { mode: 0o600 });
  const requestPath = join(requestDir, `${oldTransactionId}.request.json`);
  const requestBody = `${JSON.stringify({
    schema: 'nexus.promotion-transaction-request.v1',
    transactionId: oldTransactionId,
    createdAt: '2026-07-23T12:00:00.000Z',
    expiresAt: '2026-07-23T12:30:00.000Z',
    ownerAuthorization: 'explicit',
    productionBase,
    predecessor: {
      runtime: predecessorRuntime,
      sha: predecessorSha,
      artifactDigest: predecessorArtifactDigest,
      installedRuntimeDigest: predecessorInstalledRuntimeDigest,
    },
    target: {
      runtime: productionRelease,
      sha: runtimeSha,
      sentryRelease: runtimeSha,
      artifactDigest,
      installedRuntimeDigest,
      recoveryRuntimeDigest,
      version: targetVersion,
    },
    releaseEvidence: {
      releaseManifestBase64: Buffer.from(releaseManifestBody).toString('base64'),
      releaseManifestSha256,
      stagingAttestationBase64: Buffer.from(stagingAttestationBody).toString('base64'),
      stagingAttestationSha256,
    },
    backupDir: '/home/dominguez/backups/nexushub',
    preparedRuntimeDir: '/home/dominguez/backups/nexushub/.runtime-stage-fixture',
    pm2Bin: '/fake/pm2',
    publicBaseUrl: 'https://api.nexushub.test',
    stabilitySeconds: 60,
    gateTimeoutSeconds: 60,
    migration: {
      required: false,
      reviewEvidenceSha256: null,
      policySubjectSha256: null,
      onlineEvidenceSha256: null,
      onlineCloneSha256: null,
      onlineMigratedCloneSha256: null,
      onlinePendingSetSha256: null,
      onlineSourceDatabaseSha256: null,
    },
  }, null, 2)}\n`;
  writeFileSync(requestPath, requestBody, { mode: 0o600 });
  const keyPair = generateKeyPairSync('ed25519');
  const privateKey = join(localRoot, 'owner-private.pem');
  writeFileSync(
    privateKey,
    keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );

  const sshShim = join(binDir, 'ssh');
  writeFileSync(sshShim, `#!/usr/bin/env bash
set -euo pipefail
while [ "\${1:-}" = -o ]; do shift 2; done
server="\${1:-}"; shift || true
[ "$server" = fixture-server ] || exit 90
printf '%s\\n' "$*" >> "$NEXUS_TEST_SERVER_LOG"
if [ "\${1:-}" = sudo ] && [ "\${2:-}" = -n ]; then
  case "\${4:-}" in
    version) printf 'nexus-release-promotion-control.v2\\n'; exit 0 ;;
    status)
      [ "\${5:-}" = "$NEXUS_TEST_OLD_TRANSACTION_ID" ] || exit 91
      case "$NEXUS_TEST_STATUS_MODE" in
        not-found)
          printf '{"schema":"nexus.promotion-transaction-status.v1","transactionId":"%s","status":"not_found"}\\n' "$NEXUS_TEST_OLD_TRANSACTION_ID"
          exit 66
          ;;
        existing)
          printf '{"schema":"nexus.promotion-transaction-journal.v1","transactionId":"%s","requestSha256":"%064d","phase":"submitted","status":"pending"}\\n' "$NEXUS_TEST_OLD_TRANSACTION_ID" 0
          exit 0
          ;;
        malformed-not-found)
          printf '{"schema":"nexus.promotion-transaction-status.v1","transactionId":"%s","status":"not_found","extra":true}\\n' "$NEXUS_TEST_OLD_TRANSACTION_ID"
          exit 66
          ;;
        unreachable) exit 255 ;;
      esac
      ;;
    prepare-runtime-target) exit 91 ;;
  esac
  exit 94
fi
if [ "$#" -eq 1 ] && [[ "$1" == for\\ p\\ in* ]]; then
  printf '/fake/pm2'
  exit 0
fi
if [ "\${1:-}" = bash ] && [ "\${2:-}" = -s ]; then
  body="$(cat)"
  if [[ "$body" == *'if [ -L "$base_dir/current" ]; then readlink -f'* ]]; then
    printf '%s\\n' "$NEXUS_TEST_PREDECESSOR_RUNTIME"
  elif [[ "$body" == *'active PM2/current identity mismatch'* ]]; then
    exit 0
  elif [[ "$body" == *'marker.runtimeSha'* && "$body" == *'installed.aggregateDigest'* ]]; then
    printf '%s %s %s\\n' "$NEXUS_TEST_PREDECESSOR_SHA" \
      "$NEXUS_TEST_PREDECESSOR_ARTIFACT" "$NEXUS_TEST_PREDECESSOR_INSTALLED"
  fi
  exit 0
fi
echo "unexpected fixture SSH command: $*" >&2
exit 95
`, { mode: 0o755 });

  const result = spawnSync('/bin/bash', [
    'scripts/promote-exact-release.sh',
    server,
    stagingBase,
    productionBase,
    runtimeSha,
    artifactDigest,
    targetVersion,
    installedRuntimeDigest,
    recoveryRuntimeDigest,
    releaseManifestPath,
    stagingAttestationPath,
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: cleanGitEnv({
      NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
      NEXUS_RELEASE_OWNER_PRIVATE_KEY_PATH: privateKey,
      NEXUS_RELEASE_SYSTEMD_CONTROL: '/fake/control',
      NEXUS_TEST_OLD_TRANSACTION_ID: oldTransactionId,
      NEXUS_TEST_PREDECESSOR_ARTIFACT: predecessorArtifactDigest,
      NEXUS_TEST_PREDECESSOR_INSTALLED: predecessorInstalledRuntimeDigest,
      NEXUS_TEST_PREDECESSOR_RUNTIME: predecessorRuntime,
      NEXUS_TEST_PREDECESSOR_SHA: predecessorSha,
      NEXUS_TEST_SERVER_LOG: serverLog,
      NEXUS_TEST_STATUS_MODE: statusMode,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    }),
  });

  return {
    artifactDigest,
    checkpointBody,
    checkpointPath,
    fixture,
    oldTransactionId,
    requestBody,
    requestDir,
    requestPath,
    result,
    runtimeSha,
    serverLog,
  };
}

describe('exact production promotion operational safety', () => {
  it('locks staging and rejects an already-active release before rsync', () => {
    const operator = source(RELEASE_OPERATOR);
    const staging = operator.indexOf('  staging)');
    const lock = operator.indexOf(
      'release_acquire_remote_lock "$SERVER" "$BASE_DIR" "staging-deploy"',
      staging,
    );
    const activeGuard = operator.indexOf('if [ "$ACTIVE_STAGING" = "$RELEASE_DIR" ]', lock);
    const rsync = operator.indexOf('rsync -az --delete', activeGuard);

    expect(staging).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(staging);
    expect(activeGuard).toBeGreaterThan(lock);
    expect(rsync).toBeGreaterThan(activeGuard);
    expect(operator.slice(activeGuard, rsync)).toContain('exit 75');
    expect(operator.slice(activeGuard, rsync)).toContain('refusing to mutate it');
  });

  it('acquires the production lock before any copy or PM2 mutation path', () => {
    const exact = source(PROMOTE);
    const exactLock = exact.indexOf(
      'release_acquire_remote_lock "$SERVER" "$PROD_BASE" "prod-deploy"',
    );

    expect(exactLock).toBeGreaterThan(-1);
    expect(exact.indexOf('rsync -a --delete')).toBeGreaterThan(exactLock);

    for (const mutation of [
      '"$pm2_bin" stop "$app"',
      '"$pm2_bin" delete "$app"',
      '"$pm2_bin" start ',
    ]) {
      expect(exact.indexOf(mutation), mutation).toBeGreaterThan(exactLock);
    }
  });

  it('does not reclaim a fresh remote lock after its acquisition process exits', () => {
    const root = mkdtempSync(join(tmpdir(), 'exact-promotion-remote-lock-'));
    const binDir = join(root, 'bin');
    const remoteDir = join(root, 'remote');
    const owner = join(remoteDir, '.local', 'release', 'locks', 'prod-deploy.lock', 'owner');
    try {
      mkdirSync(binDir, { recursive: true });
      writeSshShim(binDir);
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
      const acquire = () => spawnSync(
        'bash',
        ['-c', 'set -euo pipefail; source "$1"; release_acquire_remote_lock fixture "$2" prod-deploy',
          'fixture-shell', RELEASE_GATES, remoteDir],
        { cwd: ROOT, encoding: 'utf8', env },
      );

      const first = acquire();
      expect(first.status, first.stderr).toBe(0);
      const firstOwner = readFileSync(owner, 'utf8');
      expect(firstOwner).toContain('script=fixture-shell');

      // release_acquire_remote_lock's SSH shell has exited by now. The lock is
      // still active because the owning local promotion has not cleaned it up.
      const second = acquire();
      expect(second.status).toBe(73);
      expect(`${second.stdout}\n${second.stderr}`).toContain('REMOTE_LOCK_EXISTS:');
      expect(readFileSync(owner, 'utf8')).toBe(firstOwner);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('arms recovery before stop and keeps it armed through candidate cutover', () => {
    const raw = source(PROMOTE);
    const stop = raw.indexOf("<<'REMOTE_STOP'");
    const cutover = raw.indexOf("<<'REMOTE_CUTOVER'");
    const beforeStop = raw.slice(0, stop);
    const recoveryTrap = [...beforeStop.matchAll(/^trap\s+(.+)\s+(?:EXIT|ERR)(?:\s|$)/gm)]
      .map((match) => match[0])
      .find((line) => /recover|rollback|quiesc|cutover|failure|promotion/i.test(line)
        && !line.includes('release_cleanup_all_locks'));

    expect(stop).toBeGreaterThan(-1);
    expect(cutover).toBeGreaterThan(stop);
    expect(recoveryTrap, 'a recovery EXIT/ERR trap must be armed before PM2 stop').toBeDefined();

    const recoveryName = recoveryTrap!.match(/^trap\s+['"]?([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    expect(recoveryName).toBeDefined();
    expect(beforeStop).toMatch(new RegExp(`${recoveryName}\\(\\)`));
    const handlerStart = beforeStop.indexOf(`${recoveryName}()`);
    const handler = beforeStop.slice(handlerStart, beforeStop.indexOf(`trap ${recoveryName}`, handlerStart));
    expect(handler).toContain('restart_previous');
    expect(handler).toContain('restore_exact_backup');
    expect(handler).toMatch(/trap\s+-\s+EXIT/);
    expect(raw.slice(cutover)).toContain('CUTOVER_EXIT=$?');
  });

  it('bounds and independently resets candidate and rollback readiness attempts', () => {
    const raw = source(PROMOTE);
    expectBoundedPerAttemptHealth(heredocBody(raw, 'REMOTE_CUTOVER'), [8200, 8100]);
    expectBoundedPerAttemptHealth(heredocBody(raw, 'REMOTE_RESTORE_EXACT'), [8200, 8100]);
  });

  it('bounds every PM2 identity probe used by the durable transaction path', () => {
    const raw = source(PROMOTE);
    for (const label of [
      'REMOTE_FAILED_BEFORE_STOP_IDENTITY',
      'REMOTE_ACTIVE_IDENTITY',
      'REMOTE_COMPLETED_IDENTITY',
    ]) {
      expect(heredocBody(raw, label)).toContain('timeout 5s "$pm2_bin" jlist');
    }
  });

  it('requires every exact runtime and public proof before writing success evidence', () => {
    const raw = source(PROMOTE);
    const cutover = raw.indexOf("<<'REMOTE_CUTOVER'");
    const evidence = raw.indexOf('EVIDENCE="$ROOT/.local/release/production/${RUNTIME_SHA}-${ARTIFACT_DIGEST}.json"');
    const successPath = raw.slice(cutover, evidence);

    expect(cutover).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(cutover);
    expect(successPath).toContain('127.0.0.1:8200/health');
    expect(successPath).toContain('127.0.0.1:8100/health');
    expect(successPath).toContain('remote-release-readiness.sh');
    expect(successPath).toContain('--role production');
    expect(successPath).toContain('.nexus-release-readiness-production.json');
    expect(successPath).toContain('["nexus-hub",root]');
    expect(successPath).toContain('["content-engine",`${root}/content-engine`]');
    expect(successPath).toContain('env.status!=="online"');
    expect(successPath).toContain('env.pm_cwd!==cwd');
    expect(successPath).toContain('(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha');
    expect(successPath).toMatch(/readlink -f[^\n]+current[^\n]+release_dir|current[^\n]+readlink -f[^\n]+release_dir/);

    const publicHealth = successPath.search(/\$(?:PUBLIC_BASE_URL|public_base_url)\/health/);
    const publicSnapshot = successPath.search(/\$(?:PUBLIC_BASE_URL|public_base_url)\/api\/snapshot/);
    expect(publicHealth).toBeGreaterThan(-1);
    expect(publicSnapshot).toBeGreaterThan(publicHealth);
    expect(successPath.slice(publicHealth, publicSnapshot)).toContain('JSON.parse');
    expect(successPath).toMatch(/x-portal-session|Authorization:\s*Bearer/i);
    expect(successPath).toContain('-H @"$auth_header"');
    expect(successPath).not.toContain('[ ! -s "$auth_header" ]');
    expect(successPath.slice(publicSnapshot)).toContain('x.version!==process.argv[2]');
    expect(successPath.slice(publicSnapshot)).toContain('$target_version');
    expect(successPath.slice(publicSnapshot)).toContain('JSON.parse');
    const readiness = raw.indexOf('remote-release-readiness.sh', cutover);
    const recoveryComplete = raw.indexOf('RECOVERY_COMPLETE=true', cutover);
    expect(readiness).toBeGreaterThan(cutover);
    expect(recoveryComplete).toBeGreaterThan(readiness);
  });

  it('runs env parity and strict owner bootstrap before production stop', () => {
    const raw = source(PROMOTE);
    const parity = raw.indexOf('scripts/env-parity-check.sh');
    const preflightArgs = raw.indexOf('PRODUCTION_PREFLIGHT_ARGS=(');
    const preflight = raw.indexOf('remote-release-preflight.sh', preflightArgs);
    const stop = raw.indexOf("<<'REMOTE_STOP'");
    expect(parity).toBeGreaterThan(-1);
    expect(preflightArgs).toBeGreaterThan(parity);
    expect(preflight).toBeGreaterThan(parity);
    expect(stop).toBeGreaterThan(preflight);
    expect(raw.slice(preflightArgs, stop)).toContain('--role production');
    expect(raw.slice(0, preflightArgs)).toContain('CONTENT_WORKSPACE_ROLLOUT_REQUIRED=true');
    expect(raw.slice(preflightArgs, stop)).toContain('--require-content-workspace-owner-write');
  });

  it('requires online and final stopped-state rehearsals plus exact backup evidence before candidate mutation', () => {
    const raw = source(PROMOTE);
    const review = raw.indexOf('--approval-mode review');
    const onlineRehearsal = raw.indexOf('online_pre_stop online');
    const stop = raw.indexOf("<<'REMOTE_STOP'");
    const backup = raw.indexOf('remote-create-release-backup.sh', stop);
    const finalRehearsal = raw.indexOf('stopped_final stopped', backup);
    const databaseIdentity = raw.indexOf('FINAL_MIGRATION_REHEARSAL_SOURCE_DATABASE_SHA256" = "$BACKUP_DATABASE_SHA256', finalRehearsal);
    const evidenceWrite = raw.indexOf('nexus.exact-migration-backup-evidence.v2', finalRehearsal);
    const strictGate = raw.indexOf('--approval-mode promotion', evidenceWrite);
    const candidateMutation = raw.indexOf('CANDIDATE_MUTATED=true', strictGate);
    const cutover = raw.indexOf("<<'REMOTE_CUTOVER'", candidateMutation);

    expect(review).toBeGreaterThan(-1);
    expect(onlineRehearsal).toBeGreaterThan(review);
    expect(onlineRehearsal).toBeLessThan(stop);
    expect(backup).toBeGreaterThan(stop);
    expect(finalRehearsal).toBeGreaterThan(backup);
    expect(databaseIdentity).toBeGreaterThan(finalRehearsal);
    expect(evidenceWrite).toBeGreaterThan(databaseIdentity);
    expect(strictGate).toBeGreaterThan(evidenceWrite);
    expect(candidateMutation).toBeGreaterThan(strictGate);
    expect(cutover).toBeGreaterThan(candidateMutation);
    expect(raw.slice(backup, strictGate)).toContain('NEXUS_BACKUP_SHA256');
    expect(raw.slice(backup, strictGate)).toContain('NEXUS_BACKUP_DATABASE_SHA256');
    expect(raw.slice(evidenceWrite, strictGate)).toContain("flag: 'wx'");
    expect(raw.slice(evidenceWrite, strictGate)).toContain('fs.linkSync(temporary, output)');
    expect(raw.slice(finalRehearsal, strictGate)).toContain('${PROMOTION_RUN_ID}.migration-backup.json');
    expect(raw.slice(evidenceWrite, strictGate)).toContain('databaseOwnersStopped: true');
    expect(raw.slice(evidenceWrite, strictGate)).toContain('noOpenDatabaseHandles: true');
    expect(raw.slice(evidenceWrite, strictGate)).toContain("sqliteIntegrity: 'ok'");
    expect(raw.slice(evidenceWrite, strictGate)).toContain('onlinePreStop');
    expect(raw.slice(evidenceWrite, strictGate)).toContain('stoppedFinal');
    expect(raw.slice(strictGate, candidateMutation)).toContain('--final-rehearsal-evidence');
  });

  it('keeps rehearsal diagnostics separate from JSON evidence in both phases', () => {
    const raw = source(PROMOTE);
    const captures = [
      ['MIGRATION_REHEARSAL_OUTPUT="$(', 'MIGRATION_REHEARSAL_EXIT=$?'],
      ['FINAL_MIGRATION_REHEARSAL_OUTPUT="$(', 'FINAL_MIGRATION_REHEARSAL_EXIT=$?'],
    ] as const;

    for (const [startMarker, endMarker] of captures) {
      const start = raw.indexOf(startMarker);
      const end = raw.indexOf(endMarker, start);
      const capture = raw.slice(start, end);

      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(capture).toContain('remote-production-shape-migration-rehearsal.sh');
      expect(capture).not.toContain('2>&1');
      expect(capture).not.toContain('2>/dev/null');
    }

    const fixture = spawnSync(
      'bash',
      ['-c', `set -euo pipefail
json="$(node -e 'process.stderr.write("[production launch warning] fixture\\n");process.stdout.write("{\\"ok\\":true}")')"
node -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true)process.exit(1)' "$json"`],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(fixture.status, fixture.stderr).toBe(0);
    expect(fixture.stderr).toContain('[production launch warning] fixture');
  });

  it('terminates both rehearsal digest records so strict Bash reads do not fail at EOF', () => {
    const raw = source(PROMOTE);
    expect(raw.split('].join(" ") + "\\n"').length - 1).toBe(2);
    const digest = 'a'.repeat(64);
    const valid = {
      evidenceSha256: digest,
      cloneSha256: digest,
      migratedCloneSha256: digest,
      pendingMigrationSetSha256: digest,
      sourceDatabaseSha256: digest,
    };
    const phases = [
      {
        prefix: 'MIGRATION_REHEARSAL',
        invalidError: 'migration rehearsal returned an invalid identity',
      },
      {
        prefix: 'FINAL_MIGRATION_REHEARSAL',
        invalidError: 'final migration rehearsal returned an invalid identity',
      },
    ];

    for (const phase of phases) {
      const start = raw.indexOf(`  read -r ${phase.prefix}_SHA256`);
      const endMarker = '\n  done';
      const end = raw.indexOf(endMarker, start) + endMarker.length;
      expect(start, `${phase.prefix} digest reader`).toBeGreaterThan(-1);
      expect(end, `${phase.prefix} digest validator`).toBeGreaterThan(start);
      const block = raw.slice(start, end);
      const run = (payload: typeof valid) => spawnSync(
        'bash',
        ['-c', `set -euo pipefail
${phase.prefix}_VALIDATION='${JSON.stringify(payload)}'
${block}
printf 'parser_completed\\n'`],
        { cwd: ROOT, encoding: 'utf8' },
      );

      const success = run(valid);
      expect(success.status, success.stderr).toBe(0);
      expect(success.stdout).toBe('parser_completed\n');

      const malformed = run({ ...valid, sourceDatabaseSha256: 'bad' });
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain(phase.invalidError);
    }
  });

  it('restarts the untouched predecessor when final rehearsal fails after backup but before mutation', () => {
    const raw = source(PROMOTE);
    const finalRehearsal = raw.indexOf('stopped_final stopped');
    const candidateMutation = raw.indexOf('CANDIDATE_MUTATED=true', finalRehearsal);
    const handlerStart = raw.indexOf('promotion_exit_handler()');
    const handlerEnd = raw.indexOf('trap promotion_exit_handler EXIT', handlerStart);
    const handler = raw.slice(handlerStart, handlerEnd);

    expect(finalRehearsal).toBeGreaterThan(raw.indexOf("<<'REMOTE_STOP'"));
    expect(finalRehearsal).toBeLessThan(candidateMutation);
    expect(handler).toContain('if [ "$CANDIDATE_MUTATED" = true ]');
    expect(handler).toContain('restart_previous');
    expect(handler.indexOf('restart_previous')).toBeGreaterThan(handler.indexOf('else'));
  });

  it('rejects an already-active exact release before rsync or symlink mutation', () => {
    const raw = source(PROMOTE);
    const identityProof = raw.indexOf('verify_active_runtime');
    const activeGuard = raw.indexOf('if [ "$CURRENT_RUNTIME" = "$PROD_RELEASE" ]');
    const remotePrepare = raw.indexOf("<<'REMOTE_PREPARE'");

    expect(identityProof).toBeGreaterThan(-1);
    expect(activeGuard).toBeGreaterThan(identityProof);
    expect(remotePrepare).toBeGreaterThan(activeGuard);
    expect(raw.slice(activeGuard, remotePrepare)).toContain('exit 75');
    expect(raw.slice(activeGuard, remotePrepare)).toContain('refusing to mutate the live runtime');
    expect(raw.slice(0, activeGuard)).not.toContain('rsync -a --delete');
    expect(raw.slice(0, activeGuard)).not.toContain('rm -f "$release_dir/$link"');
  });

  it('reconciles signed checkpoint authority before active-target rejection or new-ID creation', () => {
    const raw = source(PROMOTE);
    const checkpoint = raw.indexOf('if [ -f "$TRANSACTION_CHECKPOINT" ]');
    const localAuthorityGuard = raw.indexOf(
      'for local_authority_directory in',
    );
    const signedAuthority = raw.indexOf('signed_resume_request=', checkpoint);
    const signatureProof = raw.indexOf('const valid = crypto.verify(', signedAuthority);
    const authoritativeStatus = raw.indexOf(
      'status "$PROMOTION_RUN_ID"',
      signatureProof,
    );
    const resumeBranch = raw.indexOf('if [ "$RESUME_EXISTING_TRANSACTION" = true ]', authoritativeStatus);
    const environmentPreparation = raw.indexOf('scripts/env-parity-check.sh', resumeBranch);
    const activeGuard = raw.indexOf('if [ "$CURRENT_RUNTIME" = "$PROD_RELEASE" ]', environmentPreparation);
    const newId = raw.indexOf('PROMOTION_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)', activeGuard);
    const targetPreparation = raw.indexOf('prepare-runtime-target', newId);

    expect(checkpoint).toBeGreaterThan(-1);
    expect(localAuthorityGuard).toBeGreaterThan(-1);
    expect(localAuthorityGuard).toBeLessThan(checkpoint);
    expect(raw.slice(localAuthorityGuard, checkpoint)).toContain(
      '[ ! -L "$local_authority_directory" ]',
    );
    expect(signedAuthority).toBeGreaterThan(checkpoint);
    expect(signatureProof).toBeGreaterThan(signedAuthority);
    expect(authoritativeStatus).toBeGreaterThan(signatureProof);
    expect(resumeBranch).toBeGreaterThan(authoritativeStatus);
    expect(environmentPreparation).toBeGreaterThan(resumeBranch);
    expect(activeGuard).toBeGreaterThan(environmentPreparation);
    expect(newId).toBeGreaterThan(activeGuard);
    expect(targetPreparation).toBeGreaterThan(newId);
    expect(raw.slice(checkpoint, authoritativeStatus)).toContain('payload?.transactionId !== transactionId');
    expect(raw.slice(checkpoint, authoritativeStatus)).toContain('payload?.target?.runtime !== targetRuntime');
    expect(raw.slice(checkpoint, authoritativeStatus)).toContain('payload?.target?.artifactDigest !== artifactDigest');
    expect(raw.slice(checkpoint, authoritativeStatus)).toContain('payload?.target?.installedRuntimeDigest !== installedRuntimeDigest');
    expect(raw.slice(authoritativeStatus, environmentPreparation)).toContain('RESUME_EXISTING_TRANSACTION=true');
    expect(raw.slice(activeGuard, newId)).toContain('exit 75');
  });

  it('rotates an expired unsigned crash checkpoint only after exact authoritative not-found', () => {
    const fixture = runExpiredUnsignedResumeFixture('not-found');
    try {
      // The fixture stops at the first root target-preparation mutation, after
      // the stale authority has been retired and the fresh checkpoint is durable.
      expect(fixture.result.status, fixture.result.stderr).toBe(91);
      const archivePath = join(
        fixture.requestDir,
        'expired-unsigned-authority',
        `${fixture.oldTransactionId}.json`,
      );
      expect(existsSync(archivePath)).toBe(true);
      expect(statSync(archivePath).mode & 0o777).toBe(0o600);
      const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
      expect(archive).toMatchObject({
        schema: 'nexus.expired-unsigned-promotion-authority.v1',
        transactionId: fixture.oldTransactionId,
        reason: 'expired_unsigned_request_server_not_found',
        requestExpiredAt: '2026-07-23T12:30:00.000Z',
        authorityStatus: {
          schema: 'nexus.promotion-transaction-status.v1',
          transactionId: fixture.oldTransactionId,
          status: 'not_found',
        },
        clientCheckpoint: {
          sha256: createHash('sha256').update(fixture.checkpointBody).digest('hex'),
          bodyBase64: Buffer.from(fixture.checkpointBody).toString('base64'),
        },
        unsignedRequest: {
          sha256: createHash('sha256').update(fixture.requestBody).digest('hex'),
          bodyBase64: Buffer.from(fixture.requestBody).toString('base64'),
        },
      });
      expect(existsSync(fixture.requestPath)).toBe(false);
      const checkpoint = JSON.parse(readFileSync(fixture.checkpointPath, 'utf8'));
      expect(checkpoint.transactionId)
        .toMatch(/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u);
      expect(checkpoint.transactionId).not.toBe(fixture.oldTransactionId);
      expect(checkpoint.retiredUnsignedTransactionId).toBe(fixture.oldTransactionId);
      expect(statSync(fixture.checkpointPath).mode & 0o777).toBe(0o600);
      const serverCalls = readFileSync(fixture.serverLog, 'utf8');
      expect(serverCalls).toContain(`status ${fixture.oldTransactionId}`);
      expect(serverCalls).toContain('prepare-runtime-target');
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  });

  it('publishes retry authority archives durably and adopts a linked crash temporary', () => {
    const raw = source(PROMOTE);
    const archiveBlocks = [
      raw.slice(
        raw.indexOf('retry_archive="$retry_archive_dir/${PROMOTION_RUN_ID}.json"'),
        raw.indexOf('RETRY_TERMINAL_PREDECESSOR=true'),
      ),
      raw.slice(
        raw.indexOf('unsigned_archive="$unsigned_archive_dir/${PROMOTION_RUN_ID}.json"'),
        raw.indexOf('RETIRED_UNSIGNED_TRANSACTION_ID="$PROMOTION_RUN_ID"'),
      ),
    ];

    for (const block of archiveBlocks) {
      const write = block.indexOf("fs.openSync(temporary,'wx',0o600)");
      const fileFsync = block.indexOf('fs.fsyncSync(descriptor)', write);
      const publish = block.indexOf('fs.linkSync(temporary,output)', fileFsync);
      const publicationFsync = block.indexOf('fsyncParent()', publish);
      const unlinkTemporary = block.indexOf('fs.unlinkSync(temporary)', publicationFsync);
      const cleanupFsync = block.indexOf('fsyncParent()', unlinkTemporary);
      const finalValidation = block.indexOf('validateExisting()', cleanupFsync);

      expect(block).toContain('.next.');
      expect(block).toContain("error?.code!=='EEXIST'");
      expect(block).toContain('candidateStat.dev!==stat.dev');
      expect(block).toContain('candidateStat.ino!==stat.ino');
      expect(write).toBeGreaterThan(-1);
      expect(fileFsync).toBeGreaterThan(write);
      expect(publish).toBeGreaterThan(fileFsync);
      expect(publicationFsync).toBeGreaterThan(publish);
      expect(unlinkTemporary).toBeGreaterThan(publicationFsync);
      expect(cleanupFsync).toBeGreaterThan(unlinkTemporary);
      expect(finalValidation).toBeGreaterThan(cleanupFsync);
    }
  });

  it('durably publishes raw, signed, and completed local promotion authority', () => {
    const raw = source(PROMOTE);
    const authorization = source(PROMOTION_AUTHORIZATION);
    const requestStart = raw.indexOf('if [ ! -f "$request_file" ]; then');
    const requestBlock = raw.slice(
      requestStart,
      raw.indexOf('[ -f "$request_file" ] && [ ! -L "$request_file" ]', requestStart),
    );
    const evidenceStart = raw.indexOf(
      'SYSTEMD_RESULT_PATH="$ROOT/.local/release/production/',
    );
    const evidenceBlock = raw.slice(
      evidenceStart,
      raw.indexOf('fsync_local_directory "$ROOT/.local/release/production"', evidenceStart),
    );

    expect(raw).toContain('reconcile_local_link_publication "$unsigned_resume_request"');
    expect(raw).toContain('reconcile_local_link_publication "$signed_resume_request"');
    for (const block of [requestBlock, evidenceBlock]) {
      const write = block.indexOf("fs.openSync(temporary,'wx',0o600)");
      const fileFsync = block.indexOf('fs.fsyncSync(descriptor)', write);
      const publish = block.indexOf('fs.linkSync(temporary,', fileFsync);
      const publicationFsync = block.indexOf('fsyncParent()', publish);
      const unlinkTemporary = block.indexOf('fs.unlinkSync(temporary)', publicationFsync);
      const cleanupFsync = block.indexOf('fsyncParent()', unlinkTemporary);

      expect(block).toContain('.next.');
      expect(write).toBeGreaterThan(-1);
      expect(fileFsync).toBeGreaterThan(write);
      expect(publish).toBeGreaterThan(fileFsync);
      expect(publicationFsync).toBeGreaterThan(publish);
      expect(unlinkTemporary).toBeGreaterThan(publicationFsync);
      expect(cleanupFsync).toBeGreaterThan(unlinkTemporary);
    }
    expect(evidenceBlock).toContain('candidateStat.dev!==stat.dev');
    expect(evidenceBlock).toContain('candidateStat.ino!==stat.ino');
    expect(authorization).toContain('publishExactFile(output, Buffer.from(');
    expect(authorization).toContain('fs.linkSync(temporary, output)');
    expect(authorization).toContain('candidateStat.dev !== stat.dev');
    expect(authorization).toContain('candidateStat.ino !== stat.ino');
  });

  it.each([
    ['existing server authority', 'existing' as const, 'local signed envelope is unavailable'],
    ['malformed not-found response', 'malformed-not-found' as const, 'not-found response is invalid'],
    ['unreachable server authority', 'unreachable' as const, 'unable to prove'],
  ])('fails closed for expired unsigned crash state with %s', (_label, statusMode, error) => {
    const fixture = runExpiredUnsignedResumeFixture(statusMode);
    try {
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.result.stderr).toContain(error);
      expect(readFileSync(fixture.checkpointPath, 'utf8')).toBe(fixture.checkpointBody);
      expect(readFileSync(fixture.requestPath, 'utf8')).toBe(fixture.requestBody);
      expect(existsSync(join(
        fixture.requestDir,
        'expired-unsigned-authority',
        `${fixture.oldTransactionId}.json`,
      ))).toBe(false);
      expect(readFileSync(fixture.serverLog, 'utf8')).toContain(
        `status ${fixture.oldTransactionId}`,
      );
      expect(readFileSync(fixture.serverLog, 'utf8')).not.toContain('prepare-runtime-target');
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  });

  it('rejects hostile preseeded raw authority before the owner key signs it', () => {
    const raw = source(PROMOTE);
    const validationBody = heredocBody(raw, 'LOCAL_REQUEST_VALIDATION');
    const validationStart = raw.indexOf("<<'LOCAL_REQUEST_VALIDATION'");
    const signing = raw.indexOf(
      'promotion-authorization.mjs" sign-request',
      validationStart,
    );
    const fixture = mkdtempSync(join(tmpdir(), 'exact-promotion-raw-request-'));
    const requestPath = join(fixture, 'request.json');
    const transactionId = '20260723T120000Z-4321-abcdef123456';
    const productionBase = '/home/dominguez/production';
    const predecessorRuntime = `${productionBase}/releases/previous-aaaaaaaaaaaa`;
    const predecessorSha = 'a'.repeat(40);
    const predecessorArtifactDigest = 'b'.repeat(64);
    const predecessorInstalledRuntimeDigest = 'c'.repeat(64);
    const targetSha = 'd'.repeat(40);
    const artifactDigest = 'e'.repeat(64);
    const installedRuntimeDigest = 'f'.repeat(64);
    const recoveryRuntimeDigest = '1'.repeat(64);
    const targetRuntime = `${productionBase}/releases/${targetSha}-${artifactDigest.slice(0, 12)}`;
    const releaseManifestPath = join(fixture, 'release-manifest.json');
    const stagingAttestationPath = join(fixture, 'staging-attestation.json');
    writeFileSync(releaseManifestPath, '{"fixture":"manifest"}\n');
    writeFileSync(stagingAttestationPath, '{"fixture":"staging"}\n');
    const releaseManifestBytes = readFileSync(releaseManifestPath);
    const stagingAttestationBytes = readFileSync(stagingAttestationPath);
    const releaseManifestSha256 = createHash('sha256').update(releaseManifestBytes).digest('hex');
    const stagingAttestationSha256 = createHash('sha256').update(stagingAttestationBytes).digest('hex');
    const backupDir = '/home/dominguez/backups/nexushub';
    const preparedRuntimeDir = `${backupDir}/.runtime-stage-fixture`;
    const pm2Bin = '/usr/local/bin/pm2';
    const publicBaseUrl = 'https://api.nexushub.me';
    const targetVersion = '4.14.231';
    const createdAt = new Date();
    const request = {
      schema: 'nexus.promotion-transaction-request.v1',
      transactionId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 30 * 60_000).toISOString(),
      ownerAuthorization: 'explicit',
      productionBase,
      predecessor: {
        runtime: predecessorRuntime,
        sha: predecessorSha,
        artifactDigest: predecessorArtifactDigest,
        installedRuntimeDigest: predecessorInstalledRuntimeDigest,
      },
      target: {
        runtime: targetRuntime,
        sha: targetSha,
        sentryRelease: targetSha,
        artifactDigest,
        installedRuntimeDigest,
        recoveryRuntimeDigest,
        version: targetVersion,
      },
      releaseEvidence: {
        releaseManifestBase64: releaseManifestBytes.toString('base64'),
        releaseManifestSha256,
        stagingAttestationBase64: stagingAttestationBytes.toString('base64'),
        stagingAttestationSha256,
      },
      backupDir,
      preparedRuntimeDir,
      pm2Bin,
      publicBaseUrl,
      stabilitySeconds: 60,
      gateTimeoutSeconds: 60,
      migration: {
        required: false,
        reviewEvidenceSha256: null,
        policySubjectSha256: null,
        onlineEvidenceSha256: null,
        onlineCloneSha256: null,
        onlineMigratedCloneSha256: null,
        onlinePendingSetSha256: null,
        onlineSourceDatabaseSha256: null,
      },
    };
    const validationArgs = [
      requestPath,
      transactionId,
      productionBase,
      predecessorRuntime,
      predecessorSha,
      predecessorArtifactDigest,
      predecessorInstalledRuntimeDigest,
      targetRuntime,
      targetSha,
      artifactDigest,
      installedRuntimeDigest,
      recoveryRuntimeDigest,
      releaseManifestPath,
      stagingAttestationPath,
      releaseManifestSha256,
      stagingAttestationSha256,
      targetVersion,
      backupDir,
      preparedRuntimeDir,
      pm2Bin,
      publicBaseUrl,
      '60',
      '60',
      '0',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ];
    const validate = () => spawnSync(process.execPath, ['-', ...validationArgs], {
      input: validationBody,
      encoding: 'utf8',
    });

    try {
      expect(validationStart).toBeGreaterThan(-1);
      expect(signing).toBeGreaterThan(validationStart);
      const unsignedGuard = raw.slice(raw.lastIndexOf('if [ ! -f "$request_file" ]', validationStart), signing);
      expect(unsignedGuard).toContain('[ ! -L "$request_file" ]');
      expect(unsignedGuard).toContain('[ ! -e "$signed_request_file" ]');
      expect(raw.slice(signing)).toContain('request_sha" != "$validated_request_sha');

      writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
      const accepted = validate();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toMatch(/^[a-f0-9]{64}$/);

      writeFileSync(requestPath, `${JSON.stringify({
        ...request,
        productionBase: '/home/dominguez/other-production',
        target: {
          ...request.target,
          runtime: `/home/dominguez/other-production/releases/${targetSha}-${artifactDigest.slice(0, 12)}`,
        },
        unreviewedAuthority: true,
      }, null, 2)}\n`, { mode: 0o600 });
      const hostile = validate();
      expect(hostile.status).not.toBe(0);
      expect(hostile.stdout).toBe('');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('reattaches to a completed same-ID transaction and rebuilds missing local production evidence', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'exact-promotion-completed-resume-'));
    const scriptsDir = join(fixture, 'scripts');
    const requestDir = join(fixture, '.local', 'release', 'transactions');
    const binDir = join(fixture, 'bin');
    const serverLog = join(fixture, '.local', 'server.log');
    const statusFixture = join(fixture, '.local', 'authoritative-status.json');
    const resultFixture = join(fixture, '.local', 'authoritative-result.env');
    const escrowFixture = join(fixture, '.local', 'authoritative-escrow.json');
    const sshShim = join(binDir, 'ssh');
    const transactionId = '20260723T120000Z-4321-abcdef123456';
    const artifactDigest = 'c'.repeat(64);
    const installedRuntimeDigest = 'd'.repeat(64);
    const recoveryRuntimeDigest = 'e'.repeat(64);
    const backupSha = 'f'.repeat(64);
    const productionBase = '/home/dominguez/production';
    const exactBackup = '/home/dominguez/backups/nexushub/v4.14.231.tar.gz';
    try {
      mkdirSync(join(scriptsDir, 'lib'), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      copyFileSync(PROMOTE, join(scriptsDir, 'promote-exact-release.sh'));
      chmodSync(join(scriptsDir, 'promote-exact-release.sh'), 0o755);
      writeFileSync(join(fixture, '.gitignore'), '.local/\n');
      writeFileSync(join(scriptsDir, 'lib', 'release-gates.sh'), `#!/usr/bin/env bash
release_require_git_worktree() { return 0; }
release_require_clean_tree() { return 0; }
release_acquire_local_lock() { return 0; }
release_acquire_remote_lock() { return 0; }
release_cleanup_all_locks() { return 0; }
`);
      writeFileSync(join(scriptsDir, 'rollback-drill-check.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
      writeFileSync(sshShim, `#!/usr/bin/env bash
set -euo pipefail
while [ "\${1:-}" = -o ]; do shift 2; done
server="\${1:-}"; shift || true
[ "$server" = fixture-server ] || exit 90
printf '%s\n' "$*" >> "$NEXUS_TEST_SERVER_LOG"
if [ "\${1:-}" = sudo ] && [ "\${2:-}" = -n ]; then
  case "\${4:-}" in
    version) printf 'nexus-release-promotion-control.v2\n' ;;
    status)
      [ "\${5:-}" = "$NEXUS_TEST_TRANSACTION_ID" ] || exit 91
      cat "$NEXUS_TEST_STATUS_FIXTURE"
      ;;
    fetch)
      [ "\${5:-}" = "$NEXUS_TEST_TRANSACTION_ID" ] || exit 92
      case "\${6:-}" in
        result) cat "$NEXUS_TEST_RESULT_FIXTURE" ;;
        escrow) cat "$NEXUS_TEST_ESCROW_FIXTURE" ;;
        *) exit 93 ;;
      esac
      ;;
    *) exit 94 ;;
  esac
  exit 0
fi
if [ "$#" -eq 1 ] && [[ "$1" == for\\ p\\ in* ]]; then
  printf '/usr/local/bin/pm2'
  exit 0
fi
if [ "\${1:-}" = bash ] && [ "\${2:-}" = -s ]; then
  cat >/dev/null
  exit 0
fi
echo "unexpected fixture SSH command: $*" >&2
exit 95
`, { mode: 0o755 });

      const gitEnv = cleanGitEnv();
      expect(spawnSync('git', ['init', '--initial-branch=main'], { cwd: fixture, env: gitEnv }).status).toBe(0);
      expect(spawnSync('git', ['config', 'user.name', 'Release Fixture'], { cwd: fixture, env: gitEnv }).status).toBe(0);
      expect(spawnSync('git', ['config', 'user.email', 'release@example.invalid'], { cwd: fixture, env: gitEnv }).status).toBe(0);
      expect(spawnSync('git', ['add', '.'], { cwd: fixture, env: gitEnv }).status).toBe(0);
      const commit = spawnSync('git', ['commit', '-m', 'fixture'], {
        cwd: fixture,
        encoding: 'utf8',
        env: gitEnv,
      });
      expect(commit.status, commit.stderr).toBe(0);
      const runtimeSha = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture,
        encoding: 'utf8',
        env: gitEnv,
      }).stdout.trim();
      const productionRelease = `${productionBase}/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`;
      mkdirSync(join(fixture, '.local'), { recursive: true });
      const localFixtureRoot = realpathSync(join(fixture, '.local'));
      const releaseManifestPath = join(localFixtureRoot, 'release-manifest.json');
      const releaseManifestBody = `${JSON.stringify({
        schema: 'nexus.release-manifest.v2',
        payload: { runtimeSha, artifact: { digest: artifactDigest } },
      })}\n`;
      writeFileSync(releaseManifestPath, releaseManifestBody, { mode: 0o600 });
      const releaseManifestSha256 = createHash('sha256').update(releaseManifestBody).digest('hex');
      const stagingAttestationPath = join(localFixtureRoot, 'staging-attestation.json');
      const stagingAttestationBody = `${JSON.stringify({
        schema: 'nexus.staging-attestation.v1',
        payload: {
          runtimeSha,
          artifactDigest,
          installedRuntimeDigest,
          recoveryRuntimeDigest,
          releaseManifestSha256,
        },
      })}\n`;
      writeFileSync(stagingAttestationPath, stagingAttestationBody, { mode: 0o600 });
      const stagingAttestationSha256 = createHash('sha256')
        .update(stagingAttestationBody).digest('hex');

      mkdirSync(requestDir, { recursive: true });
      const keyPair = generateKeyPairSync('ed25519');
      const privateKey = join(fixture, '.local', 'owner-private.pem');
      writeFileSync(
        privateKey,
        keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        { mode: 0o600 },
      );
      const requestPath = join(requestDir, `${transactionId}.request.json`);
      const signedRequestPath = join(requestDir, `${transactionId}.request.envelope.json`);
      const createdAt = new Date();
      writeFileSync(requestPath, `${JSON.stringify({
        schema: 'nexus.promotion-transaction-request.v1',
        transactionId,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + 30 * 60_000).toISOString(),
        ownerAuthorization: 'explicit',
        productionBase,
        predecessor: {
          runtime: `${productionBase}/releases/previous-aaaaaaaaaaaa`,
          sha: 'a'.repeat(40),
          artifactDigest: 'a'.repeat(64),
          installedRuntimeDigest: 'b'.repeat(64),
        },
        target: {
          runtime: productionRelease,
          sha: runtimeSha,
          sentryRelease: runtimeSha,
          artifactDigest,
          installedRuntimeDigest,
          recoveryRuntimeDigest,
          version: '4.14.231',
        },
        releaseEvidence: {
          releaseManifestBase64: Buffer.from(releaseManifestBody).toString('base64'),
          releaseManifestSha256,
          stagingAttestationBase64: Buffer.from(stagingAttestationBody).toString('base64'),
          stagingAttestationSha256,
        },
        backupDir: '/home/dominguez/backups/nexushub',
        preparedRuntimeDir: '/home/dominguez/backups/nexushub/.runtime-stage-fixture',
        pm2Bin: '/usr/local/bin/pm2',
        publicBaseUrl: 'https://api.nexushub.me',
        stabilitySeconds: 60,
        gateTimeoutSeconds: 60,
        migration: {
          required: false,
          reviewEvidenceSha256: null,
          policySubjectSha256: null,
          onlineEvidenceSha256: null,
          onlineCloneSha256: null,
          onlineMigratedCloneSha256: null,
          onlinePendingSetSha256: null,
          onlineSourceDatabaseSha256: null,
        },
      }, null, 2)}\n`, { mode: 0o600 });
      const signing = spawnSync('node', [
        PROMOTION_AUTHORIZATION,
        'sign-request',
        '--input',
        requestPath,
        '--private-key',
        privateKey,
        '--output',
        signedRequestPath,
      ], {
        cwd: fixture,
        encoding: 'utf8',
        env: gitEnv,
      });
      expect(signing.status, signing.stderr).toBe(0);
      const requestSha = JSON.parse(signing.stdout).payloadSha256 as string;
      rmSync(requestPath);
      const checkpointPath = join(
        requestDir,
        `${runtimeSha}-${artifactDigest}.checkpoint.json`,
      );
      writeFileSync(checkpointPath, `${JSON.stringify({
        schema: 'nexus.promotion-client-checkpoint.v1',
        transactionId,
        startedAt: '2026-07-23T12:00:00Z',
        runtimeSha,
        artifactDigest,
        installedRuntimeDigest,
        recoveryRuntimeDigest,
        releaseManifestSha256,
        stagingAttestationSha256,
        targetVersion: '4.14.231',
        server: 'fixture-server',
        productionBase,
      }, null, 2)}\n`, { mode: 0o600 });
      const checkpointBefore = readFileSync(checkpointPath, 'utf8');
      const signedRequestBefore = readFileSync(signedRequestPath, 'utf8');
      writeFileSync(statusFixture, `${JSON.stringify({
        schema: 'nexus.promotion-transaction-journal.v1',
        transactionId,
        requestSha256: requestSha,
        phase: 'completed',
        status: 'completed',
      })}\n`, { mode: 0o600 });
      writeFileSync(resultFixture, [
        `NEXUS_TRANSACTION_ID=${transactionId}`,
        `NEXUS_RUNTIME_SHA=${runtimeSha}`,
        `NEXUS_SENTRY_RELEASE=${runtimeSha}`,
        `NEXUS_ARTIFACT_DIGEST=${artifactDigest}`,
        `NEXUS_INSTALLED_RUNTIME_DIGEST=${installedRuntimeDigest}`,
        'NEXUS_CUTOVER_STARTED_AT=2026-07-23T12:00:00Z',
        'NEXUS_SERVICE_UNAVAILABLE_STARTED_AT=2026-07-23T12:00:01Z',
        'NEXUS_CANDIDATE_AVAILABLE_AT=2026-07-23T12:00:08Z',
        'NEXUS_CUTOVER_SECONDS=68',
        'NEXUS_BACKUP_WINDOW_SECONDS=4',
        'NEXUS_BACKUP_OUTAGE_SECONDS=4',
        'NEXUS_FINAL_UNAVAILABILITY_SECONDS=8',
        'NEXUS_TOTAL_UNAVAILABILITY_SECONDS=8',
        'NEXUS_VERIFICATION_SOAK_SECONDS=60',
        'NEXUS_SOAK_STARTED_AT=2026-07-23T12:00:08Z',
        'NEXUS_SOAK_COMPLETED_AT=2026-07-23T12:01:08Z',
        'NEXUS_SOAK_OBSERVED_SECONDS=60',
        `NEXUS_BACKUP_FILE=${exactBackup}`,
        `NEXUS_BACKUP_SHA256=${backupSha}`,
        '',
      ].join('\n'), { mode: 0o600 });
      const recoveryPlaintextSha = '7'.repeat(64);
      const readinessChecks = {
        loopbackBackend: true,
        contentEngine: true,
        pm2Identity: true,
        publicHealth: true,
        authenticatedSnapshot: true,
      };
      const readiness = (verifiedAt: string) => ({
        schema: 'nexus.candidate-readiness-refresh.v1',
        status: 'passed',
        transactionId,
        runtimeSha,
        packageVersion: '4.14.231',
        verifiedAt,
        checks: readinessChecks,
      });
      writeFileSync(escrowFixture, `${JSON.stringify({
        schema: 'nexus.promotion-dr-escrow.v3',
        status: 'passed',
        transactionId,
        requestSha256: requestSha,
        confirmedAt: '2026-07-23T12:01:12Z',
        storageControls: {
          provider: 'aws-s3',
          controlMode: 'versioned-s3',
          releasePrefixLockVerified: true,
        },
        requiredRelease: {
          confirmed: true,
          path: exactBackup,
          plaintextSha256: backupSha,
          objectKey: `nexus/releases/v4.14.231.tar.gz.${backupSha}.age`,
          encryptedSha256: '8'.repeat(64),
          encryptedSizeBytes: 100,
          confirmedAt: '2026-07-23T12:01:10Z',
          retainUntil: '2027-01-01T00:00:00Z',
          objectVersionId: 'rollback-version',
          retentionVariance: null,
          approvedUnversionedVariance: false,
        },
        preMutationCurrentRecovery: {
          confirmed: true,
          path: productionRelease,
          plaintextSha256: recoveryPlaintextSha,
          objectKey: `nexus/releases/v4.14.231+current-${runtimeSha}`
            + `+escrow-${transactionId}+phase-pre-mutation.tar.gz.${recoveryPlaintextSha}.age`,
          encryptedSha256: '9'.repeat(64),
          encryptedSizeBytes: 101,
          runtimeSha,
          artifactDigest,
          installedRuntimeDigest,
          recoveryRuntimeDigest,
          releaseManifestSha256,
          stagingAttestationSha256,
          escrowId: transactionId,
          escrowPhase: 'pre-mutation',
          confirmedAt: '2026-07-23T11:59:58Z',
          retainUntil: '2027-01-01T00:00:00Z',
          objectVersionId: 'pre-recovery-version',
          retentionVariance: null,
          approvedUnversionedVariance: false,
        },
        currentRecoveryRuntime: {
          confirmed: true,
          path: productionRelease,
          plaintextSha256: recoveryPlaintextSha,
          objectKey: `nexus/releases/v4.14.231+current-${runtimeSha}`
            + `+escrow-${transactionId}+phase-post-soak.tar.gz.${recoveryPlaintextSha}.age`,
          encryptedSha256: 'a'.repeat(64),
          encryptedSizeBytes: 102,
          runtimeSha,
          artifactDigest,
          installedRuntimeDigest,
          recoveryRuntimeDigest,
          releaseManifestSha256,
          stagingAttestationSha256,
          escrowId: transactionId,
          escrowPhase: 'post-soak',
          confirmedAt: '2026-07-23T12:01:11Z',
          retainUntil: '2027-01-01T00:00:00Z',
          objectVersionId: 'post-recovery-version',
          retentionVariance: null,
          approvedUnversionedVariance: false,
        },
        preMutationDatabaseRecoveryPoint: {
          objectKey: 'nexus/database/hourly/nexus-db-20260723T115959Z.sqlite.age',
          plaintextSha256: 'b'.repeat(64),
          encryptedSha256: 'c'.repeat(64),
          encryptedSizeBytes: 103,
          objectVersionId: 'pre-database-version',
          confirmedAt: '2026-07-23T11:59:59Z',
          retentionVariance: null,
          approvedUnversionedVariance: false,
        },
        currentDatabaseRecoveryPoint: {
          objectKey: 'nexus/database/hourly/nexus-db-20260723T120112Z.sqlite.age',
          plaintextSha256: 'd'.repeat(64),
          encryptedSha256: 'e'.repeat(64),
          encryptedSizeBytes: 104,
          objectVersionId: 'post-database-version',
          confirmedAt: '2026-07-23T12:01:12Z',
          retentionVariance: null,
          approvedUnversionedVariance: false,
        },
        promotionTimeline: {
          cutoverStartedAt: '2026-07-23T12:00:00Z',
          serviceUnavailableStartedAt: '2026-07-23T12:00:01Z',
          soakCompletedAt: '2026-07-23T12:01:08Z',
        },
        candidateReadinessRefresh: {
          beforeEscrow: readiness('2026-07-23T12:01:09Z'),
          afterEscrow: readiness('2026-07-23T12:01:13Z'),
        },
      })}\n`, { mode: 0o600 });

      const run = spawnSync('/bin/bash', [
        'scripts/promote-exact-release.sh',
        'fixture-server',
        '/home/dominguez/staging',
        productionBase,
        runtimeSha,
        artifactDigest,
        '4.14.231',
        installedRuntimeDigest,
        recoveryRuntimeDigest,
        releaseManifestPath,
        stagingAttestationPath,
      ], {
        cwd: fixture,
        encoding: 'utf8',
        env: cleanGitEnv({
          NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
          NEXUS_RELEASE_OWNER_PRIVATE_KEY_PATH: privateKey,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          NEXUS_TEST_SERVER_LOG: serverLog,
          NEXUS_TEST_TRANSACTION_ID: transactionId,
          NEXUS_TEST_STATUS_FIXTURE: statusFixture,
          NEXUS_TEST_RESULT_FIXTURE: resultFixture,
          NEXUS_TEST_ESCROW_FIXTURE: escrowFixture,
        }),
      });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(`"transactionId":"${transactionId}"`);
      const evidencePath = join(
        fixture,
        '.local',
        'release',
        'production',
        `${runtimeSha}-${artifactDigest}.json`,
      );
      expect(existsSync(evidencePath)).toBe(true);
      expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
        status: 'passed',
        runtimeSha,
        artifactDigest,
        installedRuntimeDigest,
        transactionId,
        transactionMode: 'systemd_oneshot',
      });
      expect(readFileSync(checkpointPath, 'utf8')).toBe(checkpointBefore);
      expect(readFileSync(signedRequestPath, 'utf8')).toBe(signedRequestBefore);
      expect(existsSync(requestPath)).toBe(false);
      const serverCalls = readFileSync(serverLog, 'utf8');
      expect(serverCalls).toContain(`status ${transactionId}`);
      expect(serverCalls).toContain(`fetch ${transactionId} result`);
      expect(serverCalls).toContain(`fetch ${transactionId} escrow`);
      expect(serverCalls).toContain(`bash -s -- ${productionBase} ${productionRelease}`);
      expect(serverCalls).not.toContain(' launch ');
      expect(serverCalls).not.toContain('prepare-runtime-target');
      expect(serverCalls).not.toContain('seal-runtime');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a dirty exact-promotion checkout before the first SSH call', () => {
    const root = mkdtempSync(join(tmpdir(), 'exact-promotion-dirty-'));
    const binDir = join(root, 'bin');
    const sshLog = join(root, 'ssh-invoked');
    try {
      mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      copyFileSync(PROMOTE, join(root, 'scripts', 'promote-exact-release.sh'));
      copyFileSync(RELEASE_GATES, join(root, 'scripts', 'lib', 'release-gates.sh'));
      chmodSync(join(root, 'scripts', 'promote-exact-release.sh'), 0o755);
      writeFileSync(
        join(binDir, 'ssh'),
        '#!/usr/bin/env bash\nprintf invoked > "$SSH_INVOCATION_LOG"\nexit 99\n',
        { mode: 0o755 },
      );
      const gitEnv = cleanGitEnv();
      spawnSync('git', ['init', '--initial-branch=main'], { cwd: root, env: gitEnv });
      spawnSync('git', ['config', 'user.name', 'Release Fixture'], { cwd: root, env: gitEnv });
      spawnSync('git', ['config', 'user.email', 'release@example.invalid'], { cwd: root, env: gitEnv });
      spawnSync('git', ['add', '.'], { cwd: root, env: gitEnv });
      const commit = spawnSync('git', ['commit', '-m', 'fixture'], { cwd: root, encoding: 'utf8', env: gitEnv });
      expect(commit.status, commit.stderr).toBe(0);
      const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: gitEnv }).stdout.trim();
      writeFileSync(join(root, 'dirty.txt'), 'dirty\n');

      const result = spawnSync(
        'bash',
        [
          'scripts/promote-exact-release.sh',
          'fixture-server',
          '/home/dominguez/staging',
          '/home/dominguez/production',
          sha,
          'a'.repeat(64),
          '1.2.3',
          'b'.repeat(64),
          'c'.repeat(64),
          join(root, 'missing-manifest.json'),
          join(root, 'missing-staging.json'),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: cleanGitEnv({
            NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            SSH_INVOCATION_LOG: sshLog,
          }),
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exact promotion requires a clean checkout');
      expect(existsSync(sshLog)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

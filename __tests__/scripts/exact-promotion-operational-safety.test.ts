import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const PROMOTE = join(ROOT, 'scripts', 'promote-exact-release.sh');
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

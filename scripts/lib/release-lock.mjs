import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fail } from './release-canonical.mjs';

/**
 * Release serialization uses kernel `flock(2)` through util-linux `flock`, not a
 * lock file the process has to clean up. That choice is what makes an
 * interrupted release recoverable: when the poller dies, the kernel drops the
 * file-descriptor lock, so the next poll acquires it immediately and nothing has
 * to detect or expire a stale marker.
 *
 * The wrapper is the only path that may start a deployment. `assertLockHeld`
 * makes bypassing it a hard error rather than a silent second deployment.
 */

export const LOCK_HELD_ENV = 'NEXUS_RELEASE_LOCK_HELD';
export const FLOCK_BIN_ENV = 'NEXUS_RELEASE_FLOCK_BIN';
const DEFAULT_FLOCK_CANDIDATES = Object.freeze([
  '/usr/bin/flock',
  '/bin/flock',
  '/usr/local/bin/flock',
  '/opt/homebrew/opt/util-linux/bin/flock',
]);

export function resolveFlockBin(env = process.env) {
  const override = env[FLOCK_BIN_ENV];
  if (override) {
    if (!path.isAbsolute(override)) fail(`${FLOCK_BIN_ENV} must be an absolute path`);
    return override;
  }
  for (const candidate of DEFAULT_FLOCK_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function flockAvailable(env = process.env) {
  return resolveFlockBin(env) !== null;
}

/**
 * Build the exact argv used to serialize a release command.
 *
 * `--nonblock` is deliberate: a poll that cannot take the lock means another
 * release is already running, and the correct response is to exit quietly and
 * let the 30-second timer try again, not to queue up pollers behind each other.
 */
export function resolveFlockCommand({ lockFile, argv, env = process.env }) {
  if (!lockFile || !path.isAbsolute(lockFile)) {
    fail('release lock file must be an absolute path');
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    fail('release lock command requires an argv');
  }
  const flockBin = resolveFlockBin(env);
  if (!flockBin) fail('util-linux flock is required to serialize releases');
  return [flockBin, '--nonblock', '--conflict-exit-code', '75', lockFile, ...argv];
}

export const LOCK_CONTENDED_EXIT_CODE = 75;

export function ensureLockFile(lockFile) {
  if (!lockFile || !path.isAbsolute(lockFile)) {
    fail('release lock file must be an absolute path');
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
  fs.closeSync(fd);
  return lockFile;
}

/**
 * Refuse to deploy unless the caller was started under the flock wrapper. This
 * is the guard that keeps a hand-run `node scripts/release-deploy.mjs` from
 * racing the systemd poller.
 */
export function assertLockHeld(env = process.env) {
  if (env[LOCK_HELD_ENV] !== '1') {
    fail('release deployment must run under the flock wrapper (scripts/release-poll.sh)');
  }
}

export function runSerialized({ lockFile, argv, env = process.env, stdio = 'inherit' }) {
  const command = resolveFlockCommand({ lockFile, argv, env });
  ensureLockFile(lockFile);
  const result = spawnSync(command[0], command.slice(1), {
    stdio,
    env: { ...env, [LOCK_HELD_ENV]: '1' },
  });
  return {
    contended: result.status === LOCK_CONTENDED_EXIT_CODE,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ? String(result.stdout) : '',
    stderr: result.stderr ? String(result.stderr) : '',
  };
}

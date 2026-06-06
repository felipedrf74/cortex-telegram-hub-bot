import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const RELEASE_GATES = join(ROOT, 'scripts', 'lib', 'release-gates.sh');

function runBash(script: string) {
  return execFileSync('bash', ['-lc', script], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('release-gates local locks', () => {
  it('reclaims same-host stale local locks and cleans them up', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-stale-'));
    try {
      const output = runBash(`
        set -euo pipefail
        source "${RELEASE_GATES}"
        lock_root="$(release_lock_root "${root}")"
        mkdir -p "$lock_root/test.lock"
        {
          echo "pid=999999999"
          echo "host=$(release_current_host)"
          echo "script=old-deploy.sh"
          echo "createdAt=2026-06-06T00:00:00Z"
        } > "$lock_root/test.lock/owner"
        release_acquire_local_lock "${root}" test
        cat "$lock_root/test.lock/owner"
        release_cleanup_local_locks
        [ ! -e "$lock_root/test.lock" ]
      `);
      expect(output).toContain('script=bash');
      expect(output).not.toContain('old-deploy.sh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps active same-host local locks fail-closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-active-'));
    try {
      const script = `
        set -euo pipefail
        source "${RELEASE_GATES}"
        lock_root="$(release_lock_root "${root}")"
        mkdir -p "$lock_root/test.lock"
        {
          echo "pid=$$"
          echo "host=$(release_current_host)"
          echo "script=active-deploy.sh"
          echo "createdAt=2026-06-06T00:00:00Z"
        } > "$lock_root/test.lock/owner"
        release_acquire_local_lock "${root}" test
      `;
      let stderr = '';
      try {
        execFileSync('bash', ['-lc', script], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        throw new Error('expected active lock acquisition to fail');
      } catch (error) {
        const failure = error as { status?: number; stderr?: Buffer | string };
        expect(failure.status).toBe(73);
        stderr = String(failure.stderr ?? '');
      }
      expect(stderr).toContain('Local release lock already exists');
      expect(readFileSync(join(root, '.local/release/locks/test.lock/owner'), 'utf8')).toContain(
        'active-deploy.sh',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans acquired locks from an EXIT trap', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-trap-'));
    try {
      const output = runBash(`
        set -euo pipefail
        source "${RELEASE_GATES}"
        trap release_cleanup_all_locks EXIT
        release_acquire_local_lock "${root}" test
        echo "acquired"
        exit 0
      `);
      expect(output.trim()).toBe('acquired');
      expect(() => readFileSync(join(root, '.local/release/locks/test.lock/owner'), 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans local locks when the checkout path contains spaces', () => {
    const parent = mkdtempSync(join(tmpdir(), 'release-gates-spaces-'));
    const root = join(parent, 'checkout with spaces');
    try {
      const output = runBash(`
        set -euo pipefail
        mkdir -p "${root}"
        source "${RELEASE_GATES}"
        release_acquire_local_lock "${root}" test
        release_cleanup_local_locks
        [ ! -e "${root}/.local/release/locks/test.lock" ]
        echo "clean"
      `);
      expect(output.trim()).toBe('clean');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('allows only one concurrent stale-lock reclaimer to win', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-race-'));
    try {
      const output = runBash(`
        set -euo pipefail
        source "${RELEASE_GATES}"
        lock_root="$(release_lock_root "${root}")"
        mkdir -p "$lock_root/test.lock"
        {
          echo "pid=999999999"
          echo "host=$(release_current_host)"
          echo "script=dead-deploy.sh"
          echo "createdAt=2026-06-06T00:00:00Z"
        } > "$lock_root/test.lock/owner"
        wins="${root}/wins"
        pids=""
        for i in $(seq 1 40); do
          (
            set +e
            source "${RELEASE_GATES}"
            while [ ! -f "${root}/go" ]; do sleep 0.01; done
            if release_acquire_local_lock "${root}" test >/dev/null 2>&1; then
              echo "$i" >> "$wins"
              sleep 0.5
            fi
          ) &
          pids="$pids $!"
        done
        touch "${root}/go"
        for pid in $pids; do wait "$pid" || true; done
        wc -l < "$wins"
      `);
      expect(Number(output.trim())).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release-gates remote locks', () => {
  function writeSshShim(dir: string) {
    const shim = join(dir, 'ssh');
    writeFileSync(
      shim,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${SSH_SHIM_FAIL:-0}" = "1" ]; then
  exit 255
fi
shift
exec "$@"
`,
      { mode: 0o755 },
    );
    return shim;
  }

  it('reclaims stale remote locks and cleans up with argv-safe ssh', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-remote-'));
    const binDir = join(root, 'bin');
    const remoteDir = join(root, "remote path with ' quote");
    try {
      execFileSync('mkdir', ['-p', binDir, join(remoteDir, '.local/release/locks/prod.lock')]);
      writeSshShim(binDir);
      const output = runBash(`
        set -euo pipefail
        source "${RELEASE_GATES}"
        lock_dir="${remoteDir}/.local/release/locks/prod.lock"
        {
          echo "token=old"
          echo "pid=999999999"
          echo "host=$(release_current_host)"
          echo "script=dead-prod-deploy.sh"
          echo "createdAt=2026-06-06T00:00:00Z"
        } > "$lock_dir/owner"
        PATH="${binDir}:$PATH" release_acquire_remote_lock fake-server "${remoteDir}" prod
        cat "$lock_dir/owner"
        PATH="${binDir}:$PATH" release_cleanup_remote_locks
        [ ! -e "$lock_dir" ]
      `);
      expect(output).toContain('script=bash');
      expect(output).not.toContain('dead-prod-deploy.sh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns non-zero when ssh cannot acquire the remote lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-ssh-fail-'));
    const binDir = join(root, 'bin');
    try {
      execFileSync('mkdir', ['-p', binDir]);
      writeSshShim(binDir);
      const output = runBash(`
        set -euo pipefail
        source "${RELEASE_GATES}"
        set +e
        PATH="${binDir}:$PATH" SSH_SHIM_FAIL=1 release_acquire_remote_lock fake-server "${root}/remote" prod
        code="$?"
        set -e
        echo "$code"
      `);
      expect(Number(output.trim())).toBe(255);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

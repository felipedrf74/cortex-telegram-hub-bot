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

  it('reclaims stale local .reclaiming markers left by killed reclaimers', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-local-reclaim-marker-'));
    try {
      const output = runBash(`
        set -euo pipefail
        source "${RELEASE_GATES}"
        lock_root="$(release_lock_root "${root}")"
        lock_dir="$lock_root/test.lock"
        mkdir -p "$lock_dir/.reclaiming"
        {
          echo "pid=999999999"
          echo "host=$(release_current_host)"
          echo "script=dead-deploy.sh"
          echo "createdAt=1970-01-01T00:00:00Z"
        } > "$lock_dir/owner"
        {
          echo "pid=999999998"
          echo "host=$(release_current_host)"
          echo "createdAt=1970-01-01T00:00:00Z"
        } > "$lock_dir/.reclaiming/owner"
        NEXUS_RECLAIM_MARKER_MAX_AGE_S=1 release_acquire_local_lock "${root}" test
        cat "$lock_dir/owner"
        [ ! -e "$lock_dir/.reclaiming" ]
        release_cleanup_local_locks
      `);
      expect(output).toContain('script=bash');
      expect(output).not.toContain('dead-deploy.sh');
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
        attempts_dir="${root}/attempts"
        mkdir -p "$attempts_dir"
        pids=""
        for i in $(seq 1 40); do
          (
            set +e
            source "${RELEASE_GATES}"
            while [ ! -f "${root}/go" ]; do sleep 0.01; done
            if release_acquire_local_lock "${root}" test >/dev/null 2>&1; then
              echo "$i" >> "$wins"
              touch "$attempts_dir/$i"
              deadline=$((SECONDS + 10))
              while [ "$(find "$attempts_dir" -type f | wc -l | tr -d ' ')" -lt 40 ] && [ "$SECONDS" -lt "$deadline" ]; do
                sleep 0.01
              done
            else
              touch "$attempts_dir/$i"
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

  it('reclaims stale remote .reclaiming markers left by killed reclaimers', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-remote-reclaim-marker-'));
    const binDir = join(root, 'bin');
    const remoteDir = join(root, 'remote');
    try {
      execFileSync('mkdir', ['-p', binDir, join(remoteDir, '.local/release/locks/prod.lock/.reclaiming')]);
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
          echo "createdAt=1970-01-01T00:00:00Z"
        } > "$lock_dir/owner"
        {
          echo "pid=999999998"
          echo "host=$(release_current_host)"
          echo "createdAt=1970-01-01T00:00:00Z"
        } > "$lock_dir/.reclaiming/owner"
        PATH="${binDir}:$PATH" NEXUS_RECLAIM_MARKER_MAX_AGE_S=1 release_acquire_remote_lock fake-server "${remoteDir}" prod
        cat "$lock_dir/owner"
        [ ! -e "$lock_dir/.reclaiming" ]
        PATH="${binDir}:$PATH" release_cleanup_remote_locks
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

  it('does not reclaim a fresh remote lock when its acquisition shell has exited', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-remote-active-'));
    const binDir = join(root, 'bin');
    const remoteDir = join(root, 'remote');
    const lockDir = join(remoteDir, '.local/release/locks/prod-deploy.lock');
    try {
      execFileSync('mkdir', ['-p', binDir, lockDir]);
      writeSshShim(binDir);
      writeFileSync(join(lockDir, 'owner'), [
        'token=existing',
        'pid=999999999',
        'host=fixture-host',
        'script=first-promote.sh',
        `createdAt=${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
        '',
      ].join('\n'));

      const output = runBash(`
        set -euo pipefail
        source "${RELEASE_GATES}"
        set +e
        PATH="${binDir}:$PATH" release_acquire_remote_lock fake-server "${remoteDir}" prod-deploy >/dev/null 2>&1
        code="$?"
        set -e
        echo "$code"
        grep -Fxq 'token=existing' "${lockDir}/owner"
      `);

      expect(Number(output.trim())).toBe(73);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let an expired owner cleanup delete a replacement remote lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-gates-remote-token-'));
    const binDir = join(root, 'bin');
    const remoteDir = join(root, 'remote');
    try {
      execFileSync('mkdir', ['-p', binDir, remoteDir]);
      writeSshShim(binDir);
      const output = runBash(`
        set -euo pipefail
        source "${RELEASE_GATES}"
        PATH="${binDir}:$PATH" release_acquire_remote_lock fake-server "${remoteDir}" prod-deploy
        lock_dir="${remoteDir}/.local/release/locks/prod-deploy.lock"
        sed -E 's/^token=.*/token=replacement-owner/' "$lock_dir/owner" > "$lock_dir/owner.next"
        mv "$lock_dir/owner.next" "$lock_dir/owner"
        PATH="${binDir}:$PATH" release_cleanup_remote_locks
        [ -d "$lock_dir" ]
        grep -Fxq 'token=replacement-owner' "$lock_dir/owner"
        echo retained
      `);

      expect(output.trim()).toBe('retained');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

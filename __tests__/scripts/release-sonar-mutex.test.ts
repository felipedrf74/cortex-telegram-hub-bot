import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('shared release/Sonar SSH mutex lifecycle', () => {
  it('promptly releases and reacquires after the local FIFO holder closes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-sonar-mutex-'));
    try {
      const fixtureBin = path.join(root, 'bin');
      const fixtureLock = path.join(root, 'shared-release-sonar.lock');
      fs.mkdirSync(fixtureBin);
      fs.writeFileSync(fixtureLock, '');
      const fixtureFlock = path.join(fixtureBin, 'flock');
      if (fs.existsSync('/usr/bin/flock')) {
        fs.symlinkSync('/usr/bin/flock', fixtureFlock);
      } else {
        fs.writeFileSync(fixtureFlock, `#!/usr/bin/env python3
import fcntl
import sys

flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if "-n" in sys.argv else 0)
try:
    fcntl.flock(int(sys.argv[-1]), flags)
except BlockingIOError:
    raise SystemExit(1)
`, { mode: 0o755 });
      }
      fs.writeFileSync(path.join(fixtureBin, 'ssh'), `#!/usr/bin/env bash
set -euo pipefail
exec 7<>"$FAKE_SHARED_MUTEX"
flock -n 7 || exit 75
printf 'NEXUS_MUTEX_ACQUIRED\n'
cat >/dev/null
`, { mode: 0o755 });
      const gates = path.resolve('scripts/lib/release-gates.sh');

      const result = spawnSync('/bin/bash', ['-s', '--', gates], {
        input: [
          'set -euo pipefail',
          'source "$1"',
          'release_acquire_remote_sonar_lock fixture-host',
          'release_cleanup_remote_sonar_lock',
          'release_acquire_remote_sonar_lock fixture-host',
          'release_cleanup_remote_sonar_lock',
          "printf 'mutex_reacquired\\n'",
        ].join('\n'),
        encoding: 'utf8',
        timeout: 3_000,
        env: {
          ...process.env,
          FAKE_SHARED_MUTEX: fixtureLock,
          PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
          TMPDIR: root,
        },
      });

      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('mutex_reacquired');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

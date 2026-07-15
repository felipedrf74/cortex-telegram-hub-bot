import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const rollbackScript = path.resolve('scripts/rollback.sh');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-versioned-rollback-'));
  temporaryRoots.push(root);
  const backups = path.join(root, 'backups');
  const base = path.join(root, 'production');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(backups, { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const sshLog = path.join(root, 'ssh.log');
  const fakeSsh = path.join(bin, 'ssh');
  fs.writeFileSync(
    fakeSsh,
    `#!/usr/bin/env bash
set -euo pipefail
shift
if [ "$#" -eq 1 ]; then
  case "$1" in
    *"bash scripts/restore.sh"*)
      printf '%s\n' "$1" >> "$SSH_LOG"
      echo "fixture restore validated"
      exit 0
      ;;
  esac
  exec bash -c "$1"
fi
exec "$@"
`,
  );
  fs.chmodSync(fakeSsh, 0o755);

  const pm2 = path.join(bin, 'pm2');
  fs.writeFileSync(pm2, '#!/usr/bin/env bash\nexit 1\n');
  fs.chmodSync(pm2, 0o755);

  return { root, backups, base, bin, sshLog, pm2 };
}

function createArchive(
  backups: string,
  filename: string,
  archivedVersion: string,
  manifest?: { archivedVersion: string; targetVersion: string },
) {
  const source = fs.mkdtempSync(path.join(path.dirname(backups), 'archive-source-'));
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: archivedVersion }));
  fs.writeFileSync(path.join(source, 'data/bot.db'), 'fixture');
  const entries = ['package.json', 'data/bot.db'];
  if (manifest) {
    fs.writeFileSync(
      path.join(source, '.nexus-backup-manifest.json'),
      JSON.stringify({ schema: 'nexus.release-backup.v1', ...manifest }),
    );
    entries.push('.nexus-backup-manifest.json');
  }
  const archive = path.join(backups, filename);
  execFileSync('tar', ['czf', archive, '-C', source, ...entries]);
  fs.rmSync(source, { recursive: true, force: true });
  return archive;
}

function runRollback(
  fixture: ReturnType<typeof createFixture>,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync('bash', [rollbackScript, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
      DEPLOY_SERVER: 'fixture-server',
      DEPLOY_PATH: fixture.base,
      NEXUS_BACKUP_DIR: fixture.backups,
      NEXUS_PM2_BIN: fixture.pm2,
      SSH_LOG: fixture.sshLog,
      ...extraEnv,
    },
  });
}

describe('rollback versioned runtime identity', () => {
  it('selects and displays the rollback target from the archive manifest, not its filename', () => {
    const fixture = createFixture();
    const archive = createArchive(
      fixture.backups,
      'v4.14.219_20260715_120000.tar.gz',
      '4.14.218',
      { archivedVersion: '4.14.218', targetVersion: '4.14.219' },
    );

    const result = runRollback(fixture, ['--dry-run', 'v4.14.218']);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Rollback target: v4.14.218 (archived before v4.14.219)');
    expect(result.stdout).toContain(path.basename(archive));
    expect(fs.readFileSync(fixture.sshLog, 'utf8')).toContain(archive);
  });

  it('keeps old manifest-free archives selectable by their packaged version', () => {
    const fixture = createFixture();
    const archive = createArchive(
      fixture.backups,
      'v4.14.219_20260714_120000.tar.gz',
      '4.14.217',
    );

    const result = runRollback(fixture, ['--dry-run', '4.14.217']);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Rollback target: v4.14.217');
    expect(result.stdout).toContain('legacy metadata');
    expect(fs.readFileSync(fixture.sshLog, 'utf8')).toContain(archive);
  });

  it('fails before stop or restore when PM2 cwd disagrees with the current symlink', () => {
    const fixture = createFixture();
    createArchive(
      fixture.backups,
      'v4.14.218_before-v4.14.219_20260715_120000.tar.gz',
      '4.14.218',
      { archivedVersion: '4.14.218', targetVersion: '4.14.219' },
    );
    const release = path.join(fixture.base, 'releases/runtime-sha');
    fs.mkdirSync(path.join(release, 'content-engine'), { recursive: true });
    fs.writeFileSync(path.join(release, 'package.json'), JSON.stringify({ version: '4.14.219' }));
    fs.symlinkSync(release, path.join(fixture.base, 'current'));
    const mutationMarker = path.join(fixture.root, 'pm2-mutated');
    fs.writeFileSync(
      fixture.pm2,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "jlist" ]; then
  printf '%s\n' '${JSON.stringify([
    { name: 'nexus-hub', pm2_env: { status: 'online', pm_cwd: fixture.base } },
    {
      name: 'content-engine',
      pm2_env: { status: 'online', pm_cwd: path.join(fixture.base, 'content-engine') },
    },
  ])}'
  exit 0
fi
touch "$MUTATION_MARKER"
exit 0
`,
    );
    fs.chmodSync(fixture.pm2, 0o755);

    const result = runRollback(fixture, ['latest'], { MUTATION_MARKER: mutationMarker });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'PM2 cwd does not match active runtime: nexus-hub',
    );
    expect(fs.existsSync(mutationMarker)).toBe(false);
    expect(fs.existsSync(fixture.sshLog)).toBe(false);
  });
});

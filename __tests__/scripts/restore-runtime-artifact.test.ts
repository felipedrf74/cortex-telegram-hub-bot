import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const restoreScript = path.resolve('scripts/restore.sh');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('restore runtime artifact boundary', () => {
  it('retires apply before inspecting even an unknown-version backup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-catalog-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote');
    fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(source, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(source, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(source, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    fs.writeFileSync(path.join(source, 'dist/index.js'), 'old runtime');
    fs.writeFileSync(path.join(source, 'migrations/001.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(source, 'prompts/prompt.md'), 'old prompt');
    fs.writeFileSync(path.join(source, 'content-engine/main.py'), 'old engine');
    fs.writeFileSync(path.join(source, 'content-engine/config.py'), 'VALUE = 1');
    fs.writeFileSync(path.join(source, 'content-engine/requirements.txt'), 'fastapi\n');
    fs.writeFileSync(path.join(source, 'data/bot.db'), 'not opened before runtime check');
    fs.writeFileSync(path.join(source, 'package.json'), '{}');
    fs.writeFileSync(path.join(source, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(source, 'ecosystem.config.js'), 'module.exports = {};');
    const archive = path.join(root, 'legacy-backup.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', source, '.']);

    const result = spawnSync('bash', [restoreScript, '--apply', archive], {
      encoding: 'utf8',
      env: { ...process.env, BACKUP_DIR: root, REMOTE_DIR: remote },
    });

    expect(result.status).toBe(77);
    expect(`${result.stdout}${result.stderr}`).toContain('Direct restore apply is retired');
    expect(fs.readFileSync(path.join(source, 'dist/index.js'), 'utf8')).toBe('old runtime');
    expect(fs.readdirSync(remote)).toEqual([]);
  });

  it('refuses a legacy apply without changing the live runtime or creating a snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-legacy-catalog-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote');
    const backups = path.join(root, 'backups');
    for (const base of [source, remote]) {
      for (const directory of ['dist', 'migrations', 'prompts', 'data']) {
        fs.mkdirSync(path.join(base, directory), { recursive: true });
      }
      fs.mkdirSync(path.join(base, 'content-engine'), { recursive: true });
      fs.writeFileSync(path.join(base, 'content-engine/config.py'), 'VALUE = 1');
      fs.writeFileSync(path.join(base, 'content-engine/requirements.txt'), 'fastapi\n');
      fs.writeFileSync(path.join(base, 'migrations/001.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(base, 'prompts/prompt.md'), 'prompt');
      fs.writeFileSync(path.join(base, 'package-lock.json'), '{}');
      fs.writeFileSync(path.join(base, 'ecosystem.config.js'), 'module.exports = {};');
      const db = new Database(path.join(base, 'data/bot.db'));
      db.exec('CREATE TABLE fixture(id INTEGER PRIMARY KEY)');
      db.close();
    }
    fs.writeFileSync(path.join(source, 'dist/index.js'), 'legacy runtime');
    fs.writeFileSync(path.join(source, 'content-engine/main.py'), 'legacy engine');
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '4.14.215' }));
    fs.writeFileSync(path.join(remote, 'dist/index.js'), 'current runtime');
    fs.writeFileSync(path.join(remote, 'content-engine/main.py'), 'current engine');
    fs.mkdirSync(path.join(remote, 'content-engine/.venv'), { recursive: true });
    fs.mkdirSync(path.join(remote, 'content-engine/data'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'content-engine/.venv/preserved'), 'venv');
    fs.writeFileSync(path.join(remote, 'content-engine/data/preserved'), 'data');
    fs.writeFileSync(path.join(remote, 'package.json'), JSON.stringify({ version: '4.14.218' }));
    fs.mkdirSync(path.join(remote, 'catalog/training'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'catalog/training/catalog.json'), '{}');
    const archive = path.join(root, 'legacy-backup.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', source, '.']);

    const result = spawnSync('bash', [restoreScript, '--apply', archive], {
      encoding: 'utf8',
      input: 'YES\n',
      env: {
        ...process.env,
        BACKUP_DIR: backups,
        REMOTE_DIR: remote,
        NODE_BIN: process.execPath,
        NODE_PATH_LOCAL: path.resolve('node_modules'),
      },
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(77);
    expect(`${result.stdout}${result.stderr}`).toContain('Direct restore apply is retired');
    expect(fs.readFileSync(path.join(remote, 'dist/index.js'), 'utf8')).toBe('current runtime');
    expect(fs.readFileSync(path.join(remote, 'content-engine/main.py'), 'utf8')).toBe(
      'current engine',
    );
    expect(fs.readFileSync(path.join(remote, 'content-engine/.venv/preserved'), 'utf8')).toBe('venv');
    expect(fs.readFileSync(path.join(remote, 'content-engine/data/preserved'), 'utf8')).toBe('data');
    expect(fs.existsSync(path.join(remote, 'catalog/training/catalog.json'))).toBe(true);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('retires apply before archive extraction or a pre-restore snapshot attempt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-snapshot-failure-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote');
    const backups = path.join(root, 'backups');
    for (const base of [source, remote]) {
      for (const directory of ['dist', 'catalog/training', 'migrations', 'prompts', 'data']) {
        fs.mkdirSync(path.join(base, directory), { recursive: true });
      }
      fs.mkdirSync(path.join(base, 'content-engine'), { recursive: true });
      fs.writeFileSync(path.join(base, 'content-engine/config.py'), 'VALUE = 1');
      fs.writeFileSync(path.join(base, 'content-engine/requirements.txt'), 'fastapi\n');
      fs.writeFileSync(path.join(base, 'catalog/training/catalog.json'), '{}');
      fs.writeFileSync(path.join(base, 'migrations/001.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(base, 'prompts/prompt.md'), 'prompt');
      fs.writeFileSync(path.join(base, 'content-engine/main.py'), 'engine');
      fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ version: '4.14.218' }));
      fs.writeFileSync(path.join(base, 'package-lock.json'), '{}');
      fs.writeFileSync(path.join(base, 'ecosystem.config.js'), 'module.exports = {};');
      const db = new Database(path.join(base, 'data/bot.db'));
      db.exec('CREATE TABLE fixture(id INTEGER PRIMARY KEY)');
      db.close();
    }
    fs.writeFileSync(path.join(source, 'dist/index.js'), 'replacement runtime');
    fs.writeFileSync(path.join(remote, 'dist/index.js'), 'current runtime');
    const archive = path.join(root, 'current-backup.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', source, '.']);

    const bin = path.join(root, 'bin');
    const counter = path.join(root, 'tar-counter');
    const systemTar = execFileSync('bash', ['-lc', 'command -v tar'], { encoding: 'utf8' }).trim();
    fs.mkdirSync(bin);
    const tar = path.join(bin, 'tar');
    fs.writeFileSync(
      tar,
      `#!/usr/bin/env bash
set -euo pipefail
count=0
[ -f "${counter}" ] && count=$(cat "${counter}")
count=$((count + 1))
printf '%s' "$count" > "${counter}"
if [ "$count" -eq 1 ]; then exec "${systemTar}" "$@"; fi
exit 9
`,
    );
    fs.chmodSync(tar, 0o755);

    const result = spawnSync('bash', [restoreScript, '--apply', archive], {
      encoding: 'utf8',
      input: 'YES\n',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        BACKUP_DIR: backups,
        REMOTE_DIR: remote,
        NODE_BIN: process.execPath,
        NODE_PATH_LOCAL: path.resolve('node_modules'),
      },
    });

    expect(result.status).toBe(77);
    expect(`${result.stdout}${result.stderr}`).toContain('Direct restore apply is retired');
    expect(fs.existsSync(counter)).toBe(false);
    expect(fs.readFileSync(path.join(remote, 'dist/index.js'), 'utf8')).toBe('current runtime');
    expect(fs.existsSync(path.join(remote, 'catalog/training/catalog.json'))).toBe(true);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('rejects hostile Content Engine protected paths and symlinks before touching live state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-hostile-engine-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote');
    for (const base of [source, remote]) {
      for (const directory of [
        'dist',
        'catalog/training',
        'migrations',
        'prompts',
        'content-engine',
        'data',
      ]) {
        fs.mkdirSync(path.join(base, directory), { recursive: true });
      }
      fs.writeFileSync(path.join(base, 'dist/index.js'), 'runtime');
      fs.writeFileSync(path.join(base, 'catalog/training/catalog.json'), '{}');
      fs.writeFileSync(path.join(base, 'migrations/001.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(base, 'prompts/prompt.md'), 'prompt');
      fs.writeFileSync(path.join(base, 'content-engine/main.py'), 'print("engine")');
      fs.writeFileSync(path.join(base, 'content-engine/config.py'), 'VALUE = 1');
      fs.writeFileSync(path.join(base, 'content-engine/requirements.txt'), 'fastapi\n');
      fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ version: '4.14.218' }));
      fs.writeFileSync(path.join(base, 'package-lock.json'), '{}');
      fs.writeFileSync(path.join(base, 'ecosystem.config.js'), 'module.exports = {};');
      const db = new Database(path.join(base, 'data/bot.db'));
      db.exec('CREATE TABLE fixture(id INTEGER PRIMARY KEY)');
      db.close();
    }
    fs.writeFileSync(path.join(source, 'content-engine/.env'), 'HOSTILE=1');
    fs.symlinkSync('/tmp/escape', path.join(source, 'content-engine/alias'));
    fs.writeFileSync(path.join(remote, 'content-engine/.env'), 'LIVE_SECRET=preserve');
    fs.mkdirSync(path.join(remote, 'content-engine/.venv'), { recursive: true });
    fs.writeFileSync(path.join(remote, 'content-engine/.venv/preserved'), 'live-venv');
    const archive = path.join(root, 'hostile-backup.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', source, '.']);

    const result = spawnSync('bash', [restoreScript, archive], {
      encoding: 'utf8',
      input: 'YES\n',
      env: {
        ...process.env,
        BACKUP_DIR: path.join(root, 'backups'),
        REMOTE_DIR: remote,
        NODE_BIN: process.execPath,
        NODE_PATH_LOCAL: path.resolve('node_modules'),
      },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('protected archive path: .env');
    expect(`${result.stdout}${result.stderr}`).toContain('symlink archive path: alias');
    expect(fs.readFileSync(path.join(remote, 'content-engine/.env'), 'utf8')).toBe(
      'LIVE_SECRET=preserve',
    );
    expect(fs.readFileSync(path.join(remote, 'content-engine/.venv/preserved'), 'utf8')).toBe(
      'live-venv',
    );
    expect(fs.readFileSync(path.join(remote, 'content-engine/main.py'), 'utf8')).toBe(
      'print("engine")',
    );
  });
});

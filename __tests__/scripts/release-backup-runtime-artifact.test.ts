import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const backupScript = path.resolve('scripts/remote-create-release-backup.sh');
const prepareScript = path.resolve('scripts/remote-prepare-release-backup.sh');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createRuntime(version: string, includeCatalog: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-backup-'));
  temporaryRoots.push(root);
  const runtime = path.join(root, 'runtime');
  const backups = path.join(root, 'backups');
  for (const directory of ['dist', 'migrations', 'prompts', 'data']) {
    fs.mkdirSync(path.join(runtime, directory), { recursive: true });
  }
  fs.mkdirSync(path.join(runtime, 'content-engine/.venv'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'content-engine/data'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'content-engine/.local'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'content-engine/logs'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'content-engine/.git'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'content-engine/.codex'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'content-engine/.claude'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'content-engine/services/__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'content-engine/main.py'), 'print("runtime")');
  fs.writeFileSync(path.join(runtime, 'content-engine/config.py'), 'VALUE = 1');
  fs.writeFileSync(path.join(runtime, 'content-engine/requirements.txt'), 'fastapi\n');
  fs.writeFileSync(path.join(runtime, 'content-engine/.venv/preserved'), 'venv');
  fs.writeFileSync(path.join(runtime, 'content-engine/data/preserved'), 'data');
  fs.writeFileSync(path.join(runtime, 'content-engine/.env'), 'SECRET=value');
  fs.writeFileSync(path.join(runtime, 'content-engine/.local/secret'), 'secret');
  fs.writeFileSync(path.join(runtime, 'content-engine/logs/private.log'), 'private');
  fs.writeFileSync(path.join(runtime, 'content-engine/private.db'), 'private');
  fs.writeFileSync(path.join(runtime, 'content-engine/.git/config'), 'private');
  fs.writeFileSync(path.join(runtime, 'content-engine/.codex/state'), 'private');
  fs.writeFileSync(path.join(runtime, 'content-engine/.claude/state'), 'private');
  fs.writeFileSync(path.join(runtime, 'content-engine/services/__pycache__/ignored.pyc'), 'cache');
  if (includeCatalog) {
    fs.mkdirSync(path.join(runtime, 'catalog/training'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'catalog/training/catalog.json'), '{}');
  }
  fs.writeFileSync(path.join(runtime, 'dist/index.js'), 'runtime');
  fs.writeFileSync(path.join(runtime, 'migrations/001.sql'), 'SELECT 1;');
  fs.writeFileSync(path.join(runtime, 'prompts/prompt.md'), 'prompt');
  const db = new Database(path.join(runtime, 'data/bot.db'));
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE fixture(id INTEGER PRIMARY KEY)');
  db.close();
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(runtime, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(runtime, 'ecosystem.config.js'), 'module.exports = {};');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const pm2 = path.join(bin, 'pm2');
  fs.writeFileSync(
    pm2,
    '#!/usr/bin/env bash\nprintf \'%s\\n\' \'[{"name":"nexus-hub","pid":0,"pm2_env":{"status":"stopped"}},{"name":"content-engine","pid":0,"pm2_env":{"status":"stopped"}}]\'\n',
  );
  fs.chmodSync(pm2, 0o755);
  const fuser = path.join(bin, 'fuser');
  fs.writeFileSync(
    fuser,
    '#!/usr/bin/env bash\n[ "$#" -eq 2 ] || exit 9\n[ "$1" = "-s" ] || exit 9\n[ "$2" != "--" ] || exit 9\nexit 1\n',
  );
  fs.chmodSync(fuser, 0o755);
  return { root, runtime, backups };
}

function runBackup(runtime: string, backups: string, env: NodeJS.ProcessEnv = {}, prepared = '') {
  const bin = path.join(path.dirname(runtime), 'bin');
  return spawnSync(
    'bash',
    [
      backupScript,
      runtime,
      backups,
      '4.14.218',
      path.join(bin, 'pm2'),
      'nexus-hub,content-engine',
      ...(prepared ? [prepared] : []),
    ],
    {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_BIN: process.execPath,
      NODE_PATH: path.resolve('node_modules'),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ...env,
    },
    },
  );
}

function archives(backups: string) {
  if (!fs.existsSync(backups)) return [];
  return fs.readdirSync(backups).filter((name) => name.endsWith('.tar.gz'));
}

describe('release backup runtime artifact boundary', () => {
  it('prepares runtime content while live and finalizes only database state after stop', () => {
    const { root, runtime, backups } = createRuntime('4.14.218', true);
    const prepared = execFileSync('bash', [prepareScript, runtime, backups], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}` },
    }).match(/NEXUS_PREPARED_RUNTIME_DIR=(.+)/)?.[1].trim();
    expect(prepared).toBeTruthy();
    expect(fs.existsSync(path.join(prepared!, '.nexus-runtime-prestage.json'))).toBe(true);
    expect(fs.existsSync(path.join(prepared!, 'data/bot.db'))).toBe(false);

    const result = runBackup(runtime, backups, {}, prepared);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(fs.existsSync(prepared!)).toBe(false);
    const listing = execFileSync('tar', ['tzf', path.join(backups, archives(backups)[0])], {
      encoding: 'utf8',
    });
    expect(listing).toContain('dist/index.js');
    expect(listing).toContain('data/bot.db');
  });

  it('rejects a prepared runtime if source bytes drift before cutover', () => {
    const { root, runtime, backups } = createRuntime('4.14.218', true);
    const output = execFileSync('bash', [prepareScript, runtime, backups], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}` },
    });
    const prepared = output.match(/NEXUS_PREPARED_RUNTIME_DIR=(.+)/)?.[1].trim();
    fs.writeFileSync(path.join(runtime, 'dist/index.js'), 'drifted-after-prestage');

    const result = runBackup(runtime, backups, {}, prepared);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('prepared runtime drift: dist/index.js');
    expect(fs.existsSync(prepared!)).toBe(false);
    expect(archives(backups)).toEqual([]);
  });

  it('creates a verified legacy backup without catalog before v4.14.217', () => {
    const { runtime, backups } = createRuntime('4.14.215', false);

    const result = runBackup(runtime, backups);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('catalog: false');
    expect(archives(backups)).toHaveLength(1);
    const listing = execFileSync('tar', ['tzf', path.join(backups, archives(backups)[0])], {
      encoding: 'utf8',
    });
    expect(listing).toContain('data/bot.db');
    expect(listing).toContain('.nexus-backup-manifest.json');
    expect(listing).toContain('content-engine/main.py');
    expect(listing).not.toContain('content-engine/.venv');
    expect(listing).not.toContain('content-engine/data');
    expect(listing).not.toContain('content-engine/.env');
    expect(listing).not.toContain('content-engine/.local');
    expect(listing).not.toContain('content-engine/logs');
    expect(listing).not.toContain('content-engine/private.db');
    expect(listing).not.toContain('content-engine/.git');
    expect(listing).not.toContain('content-engine/.codex');
    expect(listing).not.toContain('content-engine/.claude');
    expect(listing).not.toContain('__pycache__');
    expect(listing).not.toMatch(/^catalog\//m);
  });

  it('fails closed when a catalog-bearing release is missing catalog', () => {
    const { runtime, backups } = createRuntime('4.14.217', false);

    const result = runBackup(runtime, backups);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'catalog is required for archived version 4.14.217',
    );
    expect(archives(backups)).toEqual([]);
  });

  it('includes catalog and the database for a catalog-bearing release', () => {
    const { runtime, backups } = createRuntime('4.14.218', true);

    const result = runBackup(runtime, backups);

    expect(result.status).toBe(0);
    const listing = execFileSync('tar', ['tzf', path.join(backups, archives(backups)[0])], {
      encoding: 'utf8',
    });
    expect(listing).toContain('catalog/training/catalog.json');
    expect(listing).toContain('data/bot.db');
  });

  it('leaves no final archive when tar fails', () => {
    const { root, runtime, backups } = createRuntime('4.14.218', true);
    const bin = path.join(root, 'bin');
    const tar = path.join(bin, 'tar');
    fs.writeFileSync(tar, '#!/usr/bin/env bash\nexit 7\n');
    fs.chmodSync(tar, 0o755);

    const result = runBackup(runtime, backups, {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    });

    expect(result.status).toBe(7);
    expect(archives(backups)).toEqual([]);
  });

  it('rejects an archive whose extracted database fails integrity validation', () => {
    const { runtime, backups } = createRuntime('4.14.218', true);
    fs.writeFileSync(path.join(runtime, 'data/bot.db'), 'not-a-sqlite-database');

    const result = runBackup(runtime, backups);

    expect(result.status).not.toBe(0);
    expect(archives(backups)).toEqual([]);
  });

  it('refuses backup unless every database-owning PM2 process is proved stopped', () => {
    const { root, runtime, backups } = createRuntime('4.14.218', true);
    const pm2 = path.join(root, 'bin/pm2');
    fs.writeFileSync(
      pm2,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' \'[{"name":"nexus-hub","pid":123,"pm2_env":{"status":"online"}},{"name":"content-engine","pid":0,"pm2_env":{"status":"stopped"}}]\'\n',
    );
    fs.chmodSync(pm2, 0o755);

    const result = runBackup(runtime, backups);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('PM2 process is not proved stopped');
    expect(archives(backups)).toEqual([]);
  });

  it('refuses backup when any database file still has an open handle', () => {
    const { root, runtime, backups } = createRuntime('4.14.218', true);
    const fuser = path.join(root, 'bin/fuser');
    fs.writeFileSync(fuser, '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(fuser, 0o755);

    const result = runBackup(runtime, backups);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'database file still has an open handle: data/bot.db',
    );
    expect(archives(backups)).toEqual([]);
  });

  it('accepts absent PM2 entries as a proved non-running state', () => {
    const { root, runtime, backups } = createRuntime('4.14.218', true);
    const pm2 = path.join(root, 'bin/pm2');
    fs.writeFileSync(pm2, '#!/usr/bin/env bash\nprintf \'[]\\n\'\n');
    fs.chmodSync(pm2, 0o755);

    const result = runBackup(runtime, backups);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(archives(backups)).toHaveLength(1);
  });

  it('rejects an incomplete Content Engine rollback runtime', () => {
    const { runtime, backups } = createRuntime('4.14.218', true);
    fs.rmSync(path.join(runtime, 'content-engine/requirements.txt'));

    const result = runBackup(runtime, backups);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'required backup path is missing: content-engine/requirements.txt',
    );
    expect(archives(backups)).toEqual([]);
  });
});

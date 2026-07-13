import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const restoreScript = path.resolve('scripts/restore.sh');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('restore runtime artifact boundary', () => {
  it('refuses apply when a legacy backup omits the release-bound catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-catalog-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote');
    fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(source, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(source, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    fs.writeFileSync(path.join(source, 'dist/index.js'), 'old runtime');
    fs.writeFileSync(path.join(source, 'migrations/001.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(source, 'prompts/prompt.md'), 'old prompt');
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

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Refusing --apply: backup is missing required runtime paths: catalog',
    );
    expect(fs.readFileSync(path.join(source, 'dist/index.js'), 'utf8')).toBe('old runtime');
  });
});

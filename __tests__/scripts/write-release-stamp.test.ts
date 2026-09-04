import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/write-release-stamp.mjs');

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-stamp-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
  fs.mkdirSync(path.join(tmpRoot, 'migrations'));
  fs.writeFileSync(path.join(tmpRoot, 'migrations', '001_a.sql'), '-- a');
  fs.writeFileSync(path.join(tmpRoot, 'migrations', '002_b.sql'), '-- b');
  fs.writeFileSync(path.join(tmpRoot, 'migrations', 'README.md'), 'not a migration');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('write-release-stamp', () => {
  it('builds a deterministic stamp from env overrides without wall-clock fields', async () => {
    const { buildReleaseStamp } = await import('../../scripts/write-release-stamp.mjs');
    const env = { RELEASE_GIT_SHA: 'abcdef1234567890', RELEASE_GIT_BRANCH: 'release/x' };

    const first = buildReleaseStamp({ rootDir: tmpRoot, env });
    const second = buildReleaseStamp({ rootDir: tmpRoot, env });

    expect(first).toEqual(second);
    expect(first).toEqual({
      stampVersion: 1,
      version: '9.9.9',
      gitSha: 'abcdef1234567890',
      gitShortSha: 'abcdef12',
      branch: 'release/x',
      commitTime: null,
      dirty: null,
      migrationCount: 2,
    });
    expect(Object.keys(first)).not.toContain('builtAt');
  });

  it('writes dist/release-stamp.json when invoked as a CLI', () => {
    const out = path.join(tmpRoot, 'dist', 'release-stamp.json');
    execFileSync(process.execPath, [SCRIPT, '--root', tmpRoot, '--out', out, '--quiet'], {
      env: { ...process.env, RELEASE_GIT_SHA: '0123456789abcdef', RELEASE_GIT_BRANCH: 'main' },
    });

    const stamp = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(stamp.gitShortSha).toBe('01234567');
    expect(stamp.version).toBe('9.9.9');
    expect(stamp.migrationCount).toBe(2);
  });

  it('reads git identity from the repository when no override is set', async () => {
    const { buildReleaseStamp } = await import('../../scripts/write-release-stamp.mjs');
    const repoRoot = path.resolve(__dirname, '../..');

    const stamp = buildReleaseStamp({ rootDir: repoRoot, env: {} });

    expect(stamp.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp.gitShortSha).toBe(stamp.gitSha.slice(0, 8));
    expect(typeof stamp.dirty).toBe('boolean');
    expect(stamp.migrationCount).toBeGreaterThan(200);
  });
});

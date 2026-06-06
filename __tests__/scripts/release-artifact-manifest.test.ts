import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/release-artifact-manifest.mjs');
const evidenceScript = path.resolve('scripts/release-evidence.mjs');

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete env[key];
  }
  return env;
}

describe('release-artifact-manifest', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-artifact-manifest-'));
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'content-engine/services'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dist/index.js'), 'console.log("one");\n');
    fs.writeFileSync(path.join(tmp, 'migrations/001_init.sql'), 'CREATE TABLE x(id INTEGER);\n');
    fs.writeFileSync(path.join(tmp, 'prompts/content.md'), 'prompt one\n');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(tmp, 'content-engine/requirements.txt'), 'fastapi\n');
    fs.writeFileSync(path.join(tmp, 'content-engine/services/orchestrator.py'), 'VALUE = 1\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function digest() {
    return execFileSync('node', [script, '--root', tmp, '--digest'], { encoding: 'utf8' }).trim();
  }

  it.each([
    ['migration', 'migrations/001_init.sql'],
    ['prompt', 'prompts/content.md'],
    ['package-lock', 'package-lock.json'],
    ['python source', 'content-engine/services/orchestrator.py'],
    ['dist', 'dist/index.js'],
  ])('changes digest when %s changes', (_label, relativePath) => {
    const before = digest();
    fs.appendFileSync(path.join(tmp, relativePath), 'changed\n');
    const after = digest();

    expect(after).not.toBe(before);
  });
});

describe('release-evidence', () => {
  let tmp: string;
  let gitEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-evidence-'));
    gitEnv = cleanGitEnv();
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'content-engine/services'), { recursive: true });
    fs.copyFileSync(script, path.join(tmp, 'scripts/release-artifact-manifest.mjs'));
    fs.writeFileSync(path.join(tmp, 'dist/index.js'), 'console.log("one");\n');
    fs.writeFileSync(path.join(tmp, 'migrations/001_init.sql'), 'CREATE TABLE x(id INTEGER);\n');
    fs.writeFileSync(path.join(tmp, 'prompts/content.md'), 'prompt one\n');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"1.0.0"}\n');
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(tmp, 'content-engine/requirements.txt'), 'fastapi\n');
    fs.writeFileSync(path.join(tmp, 'content-engine/services/orchestrator.py'), 'VALUE = 1\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, env: gitEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tmp, env: gitEnv });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, env: gitEnv });
    execFileSync('git', ['add', '.'], { cwd: tmp, env: gitEnv });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, env: gitEnv });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts matching evidence and rejects digest drift', () => {
    const evidencePath = path.join(tmp, 'docs/release/evidence/latest-release-evidence.json');
    execFileSync('node', [evidenceScript, 'write', '--root', tmp, '--evidence', evidencePath], {
      encoding: 'utf8',
    });

    const ok = execFileSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--json'],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(ok).ok).toBe(true);

    fs.appendFileSync(path.join(tmp, 'prompts/content.md'), 'changed\n');
    const failed = spawnSync(
      'node',
      [evidenceScript, 'validate', '--root', tmp, '--evidence', evidencePath, '--json'],
      { encoding: 'utf8' },
    );
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('manifest_digest_mismatch')]),
    );
  });
});

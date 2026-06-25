import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

describe('risk-gate dry run', () => {
  it('focused mode includes classifier globs and graph-aware changed tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/risk-gate.sh',
        '--dry-run',
        '--skip-typecheck',
        '--skip-python',
        '--skip-migrations',
        '--files',
        'src/services/content-radar-engine.ts',
      ],
      { encoding: 'utf8', env: cleanGitEnv() },
    );

    expect(raw).toContain('__tests__/services/content-radar-engine.test.ts');
    expect(raw).toContain('--changed');
  });

  it('prints cannot-skip gates from classifier output', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/risk-gate.sh',
        '--dry-run',
        '--skip-typecheck',
        '--skip-python',
        '--skip-migrations',
        '--files',
        'src/api/routes/auth.ts',
      ],
      { encoding: 'utf8', env: cleanGitEnv() },
    );

    expect(raw).toContain('tenant-auth-security');
  });

  it('runs content-engine pytest for Python engine changes', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/risk-gate.sh',
        '--dry-run',
        '--skip-typecheck',
        '--skip-migrations',
        '--files',
        'content-engine/main.py',
      ],
      { encoding: 'utf8', env: cleanGitEnv() },
    );

    expect(raw).toContain('-m pytest');
    expect(raw).toContain('/content-engine/tests');
  });

  it('prefers the Python 3.13 content-engine venv before the default venv', () => {
    const script = readFileSync('scripts/risk-gate.sh', 'utf8');
    const py313Index = script.indexOf('$ROOT/content-engine/.venv313/bin/python');
    const defaultVenvIndex = script.indexOf('$ROOT/content-engine/.venv/bin/python');

    expect(py313Index).toBeGreaterThan(-1);
    expect(defaultVenvIndex).toBeGreaterThan(-1);
    expect(py313Index).toBeLessThan(defaultVenvIndex);
  });

  it('escalates to full Vitest when the classifier fails', () => {
    const result = spawnSync(
      'bash',
      [
        'scripts/risk-gate.sh',
        '--dry-run',
        '--skip-typecheck',
        '--skip-python',
        '--skip-migrations',
        '--base',
        'definitely-missing-release-base',
      ],
      { encoding: 'utf8', env: cleanGitEnv() },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('classifier failed');
    expect(result.stdout).toContain('vitest mode: full');
    expect(result.stdout).toContain('npx vitest run --reporter=dot');
    expect(result.stdout).not.toContain('--changed');
  });
});

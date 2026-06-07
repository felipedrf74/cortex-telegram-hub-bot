import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

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
      { encoding: 'utf8' },
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
      { encoding: 'utf8' },
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
      { encoding: 'utf8' },
    );

    expect(raw).toContain('-m pytest');
    expect(raw).toContain('/content-engine/tests');
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
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('classifier failed');
    expect(result.stdout).toContain('vitest mode: full');
    expect(result.stdout).toContain('npx vitest run --reporter=dot');
    expect(result.stdout).not.toContain('--changed');
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('classifier failed');
    expect(result.stdout).toContain('vitest mode: full');
    expect(result.stdout).toContain('npx vitest run --reporter=dot');
    expect(result.stdout).not.toContain('--changed');
  });

  it('supports a validated full-suite shard for parallel CI', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/risk-gate.sh',
        '--dry-run',
        '--full',
        '--vitest-shard',
        '2/4',
        '--skip-typecheck',
        '--skip-python',
        '--skip-migrations',
        '--files',
        'src/services/training-exercise-media.ts',
      ],
      { encoding: 'utf8' },
    );

    expect(raw).toContain('vitest mode: full');
    expect(raw).toContain('npx vitest run --reporter=dot --shard=2/4');
  });

  it('rejects malformed or out-of-range Vitest shards', () => {
    for (const shard of ['0/4', '5/4', '1/0', 'one/four']) {
      const result = spawnSync(
        'bash',
        [
          'scripts/risk-gate.sh',
          '--dry-run',
          '--full',
          '--vitest-shard',
          shard,
          '--skip-typecheck',
          '--skip-python',
          '--skip-migrations',
          '--files',
          'src/services/training-exercise-media.ts',
        ],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(64);
      expect(result.stderr).toContain('Invalid --vitest-shard value');
    }
  });

  it('rejects shard execution when the effective mode is not full', () => {
    const result = spawnSync(
      'bash',
      [
        'scripts/risk-gate.sh',
        '--dry-run',
        '--vitest-shard',
        '1/4',
        '--skip-typecheck',
        '--skip-python',
        '--skip-migrations',
        '--files',
        'src/services/content-radar-engine.ts',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('--vitest-shard requires full Vitest mode');
  });

  it('fails cleanly when --vitest-shard has no value', () => {
    const result = spawnSync(
      'bash',
      ['scripts/risk-gate.sh', '--dry-run', '--full', '--vitest-shard'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('--vitest-shard requires an I/N value');
  });

  it('keeps classifier-failure escalation compatible with a valid shard', () => {
    const result = spawnSync(
      'bash',
      [
        'scripts/risk-gate.sh',
        '--dry-run',
        '--vitest-shard',
        '3/4',
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
    expect(result.stdout).toContain('vitest shard: 3/4');
    expect(result.stdout).toContain('--shard=3/4');
  });
});

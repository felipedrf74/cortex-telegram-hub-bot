import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('risk-gate dry run', () => {
  it('rejects a JSON evidence path that traverses outside .local', () => {
    const packageBefore = readFileSync('package.json', 'utf8');
    const result = spawnSync(
      'bash',
      [
        'scripts/risk-gate.sh',
        '--dry-run',
        '--full',
        '--skip-typecheck',
        '--skip-python',
        '--skip-migrations',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NEXUS_RISK_GATE_JSON_OUTPUT: '.local/../package.json',
        },
      },
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('must be a canonical path under .local');
    expect(readFileSync('package.json', 'utf8')).toBe(packageBefore);
  });

  it('resolves symbolic and hook fallback bases to one immutable commit', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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

    expect(raw).toContain(`base: ${head}`);
    expect(raw).toContain(`--base ${head}`);
  });

  it('focused mode builds one changed, focused, and critical union', () => {
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

    expect(raw).toContain('scripts/select-vitest-files.mjs');
    expect(raw).toContain('<changed+focused+critical-union>');
    expect(raw.match(/npx vitest run/g)).toHaveLength(1);
  });

  it('keeps classifier-mandated full runs fail-closed in the shared selector', () => {
    const selector = readFileSync('scripts/select-vitest-files.mjs', 'utf8');
    expect(selector).toContain("classifier.vitest?.mode === 'full'");
    expect(selector).toContain("escalated: 'classifier-full'");
    expect(selector).toContain('selected: allFiles');
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

  it('fails fast when the classifier fails', () => {
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

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('classifier failed');
    expect(result.stderr).toContain('refusing an incomplete local safety gate');
    expect(result.stdout).not.toContain('node scripts/run-test-tier.mjs deterministic');
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
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NEXUS_RISK_GATE_JSON_OUTPUT: '.local/ci-evidence/vitest-results-2.json',
        },
      },
    );

    expect(raw).toContain('vitest mode: full');
    expect(raw).toContain('node scripts/run-test-tier.mjs deterministic --reporter dot');
    expect(raw).toContain('--json-output .local/ci-evidence/vitest-results-2.json');
    expect(raw).toContain('--shard 2/4');
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

  it('does not let a valid shard override classifier failure', () => {
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

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('classifier failed');
    expect(result.stderr).toContain('refusing an incomplete local safety gate');
    expect(result.stdout).not.toContain('--shard 3/4');
  });
});

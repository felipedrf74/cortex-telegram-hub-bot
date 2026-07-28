import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertResolvedChangeImpact } from '../../scripts/lib/changed-area-classifier.mjs';

describe('lean risk gate', () => {
  it('rejects evidence paths that escape the private local directory', () => {
    const packageBefore = readFileSync('package.json', 'utf8');
    const result = spawnSync('bash', [
      'scripts/risk-gate.sh',
      '--dry-run',
      '--full',
      '--skip-typecheck',
      '--skip-python',
      '--skip-migrations',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_RISK_GATE_JSON_OUTPUT: '.local/../package.json',
      },
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('must be a canonical path under .local');
    expect(readFileSync('package.json', 'utf8')).toBe(packageBefore);
  });

  it('resolves the selected-test base to one immutable commit', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const output = execFileSync('bash', [
      'scripts/risk-gate.sh',
      '--dry-run',
      '--skip-typecheck',
      '--skip-python',
      '--skip-migrations',
      '--files',
      'src/services/content-radar-engine.ts',
    ], { encoding: 'utf8' });
    expect(output).toContain(`base: ${head}`);
    expect(output).toContain(`--base ${head}`);
  });

  it('runs one deduplicated focused Vitest selection', () => {
    const output = execFileSync('bash', [
      'scripts/risk-gate.sh',
      '--dry-run',
      '--skip-typecheck',
      '--skip-python',
      '--skip-migrations',
      '--coverage',
      '--files',
      'src/services/content-radar-engine.ts',
    ], { encoding: 'utf8' });
    expect(output).toContain('vitest mode: focused');
    expect(output).toContain('<core+owning-group-tests+static-dependents+changed-tests>');
    expect(output).toMatch(/--coverage\.changed=[0-9a-f]{40}/);
    expect(output.match(/npx vitest run/g)).toHaveLength(1);
    expect(output).toContain('changed-coverage-gate.mjs');
    expect(output).not.toContain('critical-union');
  });

  it('keeps explicit full execution available for a release checkpoint', () => {
    const output = execFileSync('bash', [
      'scripts/risk-gate.sh',
      '--dry-run',
      '--full',
      '--skip-typecheck',
      '--skip-python',
      '--skip-migrations',
      '--files',
      'src/services/content-radar-engine.ts',
    ], { encoding: 'utf8' });
    expect(output).toContain('vitest mode: full');
    expect(output).toContain('run-test-tier.mjs deterministic');
  });

  it('fails when classification cannot map a production path', () => {
    const result = spawnSync('bash', [
      'scripts/risk-gate.sh',
      '--dry-run',
      '--skip-typecheck',
      '--skip-python',
      '--skip-migrations',
      '--files',
      'src/new-unowned-area.ts',
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('classifier failed');
    expect(() => assertResolvedChangeImpact(false, 'untrusted-base')).toThrow(
      /automatic full-suite fallback is intentionally disabled/,
    );
  });

  it('runs Python only for the content engine and prefers the reviewed virtualenv order', () => {
    const output = execFileSync('bash', [
      'scripts/risk-gate.sh',
      '--dry-run',
      '--skip-typecheck',
      '--skip-migrations',
      '--files',
      'content-engine/main.py',
    ], { encoding: 'utf8' });
    expect(output).toContain('-m pytest');
    expect(output).toContain('/content-engine/tests');

    const script = readFileSync('scripts/risk-gate.sh', 'utf8');
    const codex313 = script.indexOf('$ROOT/content-engine/.venv-codex313/bin/python');
    const py313 = script.indexOf('$ROOT/content-engine/.venv313/bin/python');
    const defaultVenv = script.indexOf('$ROOT/content-engine/.venv/bin/python');
    expect(codex313).toBeGreaterThan(-1);
    expect(py313).toBeGreaterThan(codex313);
    expect(defaultVenv).toBeGreaterThan(py313);
  });

  it('never falls back from an empty focused selection to the full suite', () => {
    const script = readFileSync('scripts/risk-gate.sh', 'utf8');
    expect(script).toContain('focused selection was empty');
    expect(script).not.toContain('escalating to full Vitest');
  });
});

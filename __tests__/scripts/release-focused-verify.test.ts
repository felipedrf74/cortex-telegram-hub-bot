import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/release-focused-verify.sh');

function dryRun(files: string) {
  return execFileSync('bash', [SCRIPT, '--files', files, '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('release-focused-verify', () => {
  it('uses docs audit and drift checks without Vitest for docs-only changes', () => {
    const output = dryRun('docs/release/README.md');

    expect(output).toContain('Docs-only release diff');
    expect(output).toContain('./scripts/release-doc-drift-check.sh --strict');
    expect(output).toContain('npm run docs:audit');
    expect(output).not.toContain('scripts/risk-gate.sh');
    expect(output).not.toContain('npx vitest');
    expect(output).not.toContain('scripts/release-verify.sh');
  });

  it('escalates package or test-config changes to the full local release runner', () => {
    const output = dryRun('package.json');

    expect(output).toContain('vitest mode: full');
    expect(output).toContain('scripts/release-verify.sh');
    expect(output).not.toContain('Docs-only release diff');
  });

  it('delegates focused source changes to the risk gate instead of full Vitest by default', () => {
    const output = dryRun('src/services/content-pipeline.ts');

    expect(output).toContain('npm run science-policy:check');
    expect(output).toContain('env NEXUS_RISK_GATE_ASSERT_CANNOT_SKIP_DASHBOARD=1 scripts/risk-gate.sh');
    expect(output).toContain('./scripts/release-doc-drift-check.sh --strict');
    expect(output).not.toContain('scripts/release-verify.sh');
  });

  it('escalates to the full local release runner when the classifier fails', () => {
    const result = spawnSync('bash', [SCRIPT, '--base', 'definitely-missing-release-base', '--dry-run'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('classifier failed');
    expect(result.stdout).toContain('scripts/release-verify.sh');
    expect(result.stdout).not.toContain('scripts/risk-gate.sh');
  });
});

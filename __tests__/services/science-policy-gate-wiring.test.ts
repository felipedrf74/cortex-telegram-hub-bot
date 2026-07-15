/**
 * R4 P2 — Science-policy gate is wired into CI + pre-commit.
 *
 * Codex caught (R4 P2 #2) that the gate script existed at
 * scripts/ci/science-policy-version-check.mjs but no CI workflow or
 * pre-commit hook actually invoked it. So `training-principles.json`
 * could be edited and merged without a `sciencePolicyVersion` bump,
 * silently breaking the "every plan / every ledger row stamped with
 * a stable policy version" invariant.
 *
 * These tests pin the wiring:
 *
 *   - The script itself behaves as advertised (exits 0 on match,
 *     non-zero on drift, non-zero on missing pin without --bootstrap).
 *   - .github/workflows/ci.yml has a step that invokes the script.
 *   - .husky/pre-commit invokes the script when training-principles
 *     or its pin file is staged.
 *   - scripts/cannot-skip-gate-dashboard.sh registers the gate so the
 *     gate-status dashboard surfaces it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  unlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/ci/science-policy-version-check.mjs');
const JSON_PATH = resolve(
  REPO_ROOT,
  'src/services/coach-kernel/knowledge/entities/training-principles.json',
);
const PIN_PATH = resolve(
  REPO_ROOT,
  'src/services/coach-kernel/knowledge/entities/.science-policy-hash',
);
const CI_YAML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const HUSKY_PRE_COMMIT = resolve(REPO_ROOT, '.husky/pre-commit');
const RISK_GATE = resolve(REPO_ROOT, 'scripts/risk-gate.sh');
const DASHBOARD = resolve(REPO_ROOT, 'scripts/cannot-skip-gate-dashboard.sh');

// Snapshot the live JSON + pin so each test can mutate them safely.
let jsonBackup: string | null = null;
let pinBackup: string | null = null;

beforeEach(() => {
  jsonBackup = readFileSync(JSON_PATH, 'utf8');
  pinBackup = existsSync(PIN_PATH) ? readFileSync(PIN_PATH, 'utf8') : null;
});

afterEach(() => {
  if (jsonBackup !== null) writeFileSync(JSON_PATH, jsonBackup);
  if (pinBackup !== null) writeFileSync(PIN_PATH, pinBackup);
  // Defensive — if a test deleted the pin, restore from backup. If
  // there was no original pin file (unlikely on this repo), leave it
  // absent so we don't fabricate state.
  if (pinBackup === null && existsSync(PIN_PATH)) {
    try {
      unlinkSync(PIN_PATH);
    } catch { /* ignore */ }
  }
});

function runGate(args: string[] = []): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('R4 P2 — science-policy gate wiring', () => {
  it('exits 0 against the live pinned hash (baseline)', () => {
    const { exitCode, stdout } = runGate();
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/OK — sciencePolicyVersion/);
  });

  it('exits non-zero when JSON content drifts without a version bump', () => {
    // Inject a benign content change without touching sciencePolicyVersion.
    const principles = JSON.parse(jsonBackup as string);
    principles.__r4_p2_test_marker__ = 'drift-without-bump';
    writeFileSync(JSON_PATH, JSON.stringify(principles, null, 2));

    const { exitCode, stderr } = runGate();
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/content has changed but the pinned hash hasn't been updated/);
    expect(stderr).toMatch(/Bump sciencePolicyVersion/);
  });

  it('exits non-zero when the pin file is missing and --bootstrap was not passed', () => {
    if (existsSync(PIN_PATH)) unlinkSync(PIN_PATH);

    const { exitCode, stderr } = runGate();
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/pinned hash file is missing/);
    expect(stderr).toMatch(/--bootstrap/);
  });

  it('--update is refused when sciencePolicyVersion has not been bumped', () => {
    const principles = JSON.parse(jsonBackup as string);
    principles.__r4_p2_test_marker__ = 'drift-without-bump';
    writeFileSync(JSON_PATH, JSON.stringify(principles, null, 2));

    const { exitCode, stderr } = runGate(['--update']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/sciencePolicyVersion.*has NOT been bumped/);
  });

  it('--update succeeds after a real version bump', () => {
    const principles = JSON.parse(jsonBackup as string);
    principles.__r4_p2_test_marker__ = 'drift-with-bump';
    const parts = String(principles.sciencePolicyVersion).split('.');
    parts[parts.length - 1] = String(Number(parts[parts.length - 1] ?? 0) + 1);
    principles.sciencePolicyVersion = parts.join('.');
    writeFileSync(JSON_PATH, JSON.stringify(principles, null, 2));

    const { exitCode, stdout } = runGate(['--update']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/pinned hash updated/);
  });
});

describe('R4 P2 — CI workflow + pre-commit hook + cannot-skip dashboard register the gate', () => {
  it('ci.yml has a job step that invokes the science-policy gate script', () => {
    const yaml = readFileSync(CI_YAML, 'utf8');
    expect(yaml).toMatch(/science-policy-version-check\.mjs/);
    // The script is the verify path — we don't want CI accidentally
    // passing --bootstrap (which would launder a missing pin).
    const verifyInvocations = yaml.match(/science-policy-version-check\.mjs(?![^\n]*--bootstrap)/g);
    expect(verifyInvocations).not.toBeNull();
    expect((verifyInvocations ?? []).length).toBeGreaterThan(0);
  });

  it('.husky/pre-commit invokes the science-policy gate when training-principles is staged', () => {
    const hook = readFileSync(HUSKY_PRE_COMMIT, 'utf8');
    expect(hook).toMatch(/science-policy-version-check\.mjs/);
    expect(hook).toMatch(/training-principles\.json/);
    expect(hook).toMatch(/science-policy-hash/);
  });

  it('.husky/pre-commit isolates nested test repositories from hook-local Git variables', () => {
    const hook = readFileSync(HUSKY_PRE_COMMIT, 'utf8');
    const riskGate = readFileSync(RISK_GATE, 'utf8');
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_PREFIX',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_NAMESPACE',
    ]) {
      expect(hook).toContain(`-u ${key}`);
      expect(riskGate).toContain(`-u ${key}`);
    }
    expect(hook).toMatch(/env[\s\\]+(?:-u GIT_[A-Z_]+[\s\\]+)+scripts\/risk-gate\.sh/);
    expect(riskGate).toContain('NEXUS_RISK_GATE_GIT_ENV_SANITIZED=1');
  });

  it('cannot-skip-gate dashboard registers the science-policy check', () => {
    const dashboard = readFileSync(DASHBOARD, 'utf8');
    expect(dashboard).toMatch(/science-policy-version-check/);
    expect(dashboard).toMatch(/training-principles\.json/);
  });
});

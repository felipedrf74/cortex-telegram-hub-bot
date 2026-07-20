import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RELEASE_TIER,
  FULL_RELEASE_TIER,
  RELEASE_RESULTS_SCHEMA,
  RELEASE_SELECTION_SCHEMA,
  validateNightlyEvidence,
  validateReleaseSelection,
} from '../../scripts/release-test-evidence.mjs';

const roots: string[] = [];

function cleanGitEnv(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) delete env[key];
  return { ...env, ...overrides };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
  }).trim();
}

function installIrreversibleMigrationPolicyFixture(repo: string): void {
  const policyRelative = 'config/irreversible-migrations.json';
  const policy = JSON.parse(fs.readFileSync(policyRelative, 'utf8')) as {
    migrations: Array<{ file: string }>;
    syntaxExemptions: Array<{ file: string }>;
  };
  for (const relative of [
    'scripts/lib/git-changed-paths.mjs',
    'scripts/lib/irreversible-migration-policy.mjs',
    policyRelative,
    ...policy.migrations.map((entry) => entry.file),
    ...policy.syntaxExemptions.map((entry) => entry.file),
  ]) {
    const destination = path.join(repo, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(relative, destination);
  }
}

const headSha = git(process.cwd(), 'rev-parse', 'HEAD');
const policyBody = fs.readFileSync('config/test-policy.json');
const policyDigest = createHash('sha256').update(policyBody).digest('hex');
const testFile = '__tests__/scripts/filter-existing-vitest-globs.test.ts';

function selection(overrides: Record<string, unknown> = {}) {
  const base = {
    schema: RELEASE_SELECTION_SCHEMA,
    tier: DEFAULT_RELEASE_TIER,
    headSha,
    baseSha: headSha,
    policyDigest,
    fullRequired: false,
    fullRequiredReason: null,
    selected: {
      changed: [testFile],
      critical: [],
      cannotSkip: [],
      removed: [],
      removedDigest: createHash('sha256').update('[]').digest('hex'),
      unresolved: [],
      unresolvedDigest: createHash('sha256').update('[]').digest('hex'),
      files: [testFile],
      filesDigest: createHash('sha256').update(JSON.stringify([testFile])).digest('hex'),
    },
    classifier: { impactResolved: true, fullSuiteTrigger: false, cannotSkip: [] },
    nightlyEvidence: {
      headSha,
      completedAt: new Date().toISOString(),
      runId: '12345',
      runAttempt: '1',
    },
  };
  return { ...base, ...overrides };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('release test evidence policy', () => {
  it('accepts only an exact changed plus critical plus cannot-skip default selection', () => {
    const valid = selection();
    expect(validateReleaseSelection(valid, {
      expectedHeadSha: headSha,
      expectedPolicyDigest: policyDigest,
    })).toMatchObject({ tier: DEFAULT_RELEASE_TIER, fullRequired: false });

    const incomplete = structuredClone(valid);
    incomplete.selected.files = [];
    incomplete.selected.filesDigest = createHash('sha256').update('[]').digest('hex');
    expect(() => validateReleaseSelection(incomplete, {
      expectedHeadSha: headSha,
      expectedPolicyDigest: policyDigest,
    })).toThrow('changed plus critical plus cannot-skip');
  });

  it('requires a governed reason whenever the release tier is full-sharded', () => {
    const full = selection({
      tier: FULL_RELEASE_TIER,
      fullRequired: true,
      fullRequiredReason: 'full_suite_trigger',
      classifier: { impactResolved: true, fullSuiteTrigger: true, cannotSkip: ['test-infrastructure-full-suite'] },
    });
    expect(validateReleaseSelection(full)).toMatchObject({ fullRequiredReason: 'full_suite_trigger' });

    expect(() => validateReleaseSelection({ ...full, fullRequiredReason: 'because_many_tests' }))
      .toThrow('reason or tier is invalid');
    expect(() => validateReleaseSelection({
      ...full,
      classifier: { impactResolved: true, fullSuiteTrigger: false, cannotSkip: [] },
    })).toThrow('not supported by classifier evidence');
  });

  it('requires removed-test evidence for a test-topology full run', () => {
    const removed = '__tests__/services/retired.test.ts';
    const full = selection({
      tier: FULL_RELEASE_TIER,
      fullRequired: true,
      fullRequiredReason: 'test_topology_change',
      selected: {
        ...selection().selected,
        removed: [removed],
        removedDigest: createHash('sha256').update(JSON.stringify([removed])).digest('hex'),
      },
      classifier: { impactResolved: false, fullSuiteTrigger: false, cannotSkip: [] },
    });

    expect(validateReleaseSelection(full)).toMatchObject({
      fullRequired: true,
      fullRequiredReason: 'test_topology_change',
      selected: { removed: [removed] },
    });
    expect(() => validateReleaseSelection({
      ...full,
      selected: {
        ...full.selected,
        removed: [],
        removedDigest: createHash('sha256').update('[]').digest('hex'),
      },
    })).toThrow('not supported by removed-test evidence');
  });

  it('rejects stale, policy-mismatched, and non-ancestor nightly evidence', () => {
    const nowMs = Date.now();
    const evidence = {
      schema: 'nexus.nightly-full-suite-evidence.v1',
      status: 'passed',
      tier: FULL_RELEASE_TIER,
      headSha,
      completedAt: new Date(nowMs - 60_000).toISOString(),
      testPolicyDigest: policyDigest,
      counts: { vitest: 1 },
      testFiles: { count: 1, digest: createHash('sha256').update(JSON.stringify([testFile])).digest('hex') },
      ci: { runId: '12345', runAttempt: '1', workflow: 'Nightly — Full regression + coverage' },
    };
    expect(validateNightlyEvidence(evidence, {
      expectedPolicyDigest: policyDigest,
      expectedWorkflowName: 'Nightly — Full regression + coverage',
      nowMs,
      maxAgeHours: 36,
      headSha,
    })).toEqual(evidence);
    expect(() => validateNightlyEvidence({
      ...evidence,
      completedAt: new Date(nowMs - 37 * 3_600_000).toISOString(),
    }, {
      expectedPolicyDigest: policyDigest,
      expectedWorkflowName: 'Nightly — Full regression + coverage',
      nowMs,
      maxAgeHours: 36,
      headSha,
    })).toThrow('stale');
    expect(() => validateNightlyEvidence({ ...evidence, testPolicyDigest: 'a'.repeat(64) }, {
      expectedPolicyDigest: policyDigest,
      expectedWorkflowName: 'Nightly — Full regression + coverage',
      nowMs,
      maxAgeHours: 36,
      headSha,
    })).toThrow('policy digest mismatch');
    expect(() => validateNightlyEvidence(evidence, {
      expectedPolicyDigest: policyDigest,
      expectedWorkflowName: 'Nightly — Full regression + coverage',
      nowMs,
      maxAgeHours: 36,
      headSha,
      ancestorCheck: () => false,
    })).toThrow('not an RC ancestor');
  });

  it('refuses nightly evidence when the report omits deterministic test files', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-nightly-partial-'));
    roots.push(temp);
    const reportPath = path.join(temp, 'vitest-results.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      success: true,
      numTotalTests: 1,
      testResults: [{ name: path.resolve(testFile), assertionResults: [{ status: 'passed' }] }],
    }));
    const result = spawnSync(process.execPath, [
      'scripts/release-test-evidence.mjs', 'write-nightly',
      '--head', headSha,
      '--vitest-results', reportPath,
      '--out', path.join(temp, 'evidence.json'),
      '--run-id', '12345',
      '--run-attempt', '1',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv({ GITHUB_WORKFLOW: 'Nightly — Full regression + coverage' }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not cover every deterministic Vitest file');
  });

  it('writes exact v2 selected evidence without a raw full-suite count floor', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-selected-evidence-'));
    roots.push(temp);
    const resultDir = path.join(temp, 'results');
    const selectionPath = path.join(temp, 'selection.json');
    const pytestPath = path.join(resultDir, 'pytest-results.log');
    const outputPath = path.join(temp, 'release-result.json');
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(selectionPath, `${JSON.stringify(selection(), null, 2)}\n`);
    fs.writeFileSync(path.join(resultDir, 'vitest-results-selected.json'), JSON.stringify({
      success: true,
      numTotalTests: 1,
      testResults: [{ name: path.resolve(testFile), assertionResults: [{ status: 'passed' }] }],
    }));
    fs.writeFileSync(pytestPath, '1 passed in 0.01s\n');

    const result = spawnSync(process.execPath, [
      'scripts/release-test-evidence.mjs', 'write-result',
      '--runtime-sha', headSha,
      '--selection', selectionPath,
      '--vitest-results-dir', resultDir,
      '--pytest-log', pytestPath,
      '--python-version', 'Python 3.12',
      '--run-id', '12345',
      '--run-attempt', '1',
      '--out', outputPath,
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toMatchObject({
      schema: RELEASE_RESULTS_SCHEMA,
      tier: DEFAULT_RELEASE_TIER,
      testPolicyDigest: policyDigest,
      counts: { vitest: 1, pytest: 1 },
      selection: { fullRequired: false, fullRequiredReason: null },
    });
  });

  it('keeps missing qualifying nightly evidence fail-closed to full', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-plan-'));
    roots.push(temp);
    const outputPath = path.join(temp, 'selection.json');
    const result = spawnSync(process.execPath, [
      'scripts/release-test-evidence.mjs', 'plan',
      '--head', headSha,
      '--nightly-dir', path.join(temp, 'missing'),
      '--out', outputPath,
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toMatchObject({
      tier: FULL_RELEASE_TIER,
      fullRequired: true,
      fullRequiredReason: 'qualifying_nightly_evidence_missing',
      selected: { critical: expect.any(Array), unresolved: expect.any(Array) },
      classifier: { impactResolved: expect.any(Boolean) },
    });
  });

  it('parses CLI --force-full false as false when qualifying nightly evidence exists', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-plan-cli-'));
    roots.push(temp);
    for (const directory of ['scripts/lib', 'config', '__tests__/security', '.local/nightly']) {
      fs.mkdirSync(path.join(temp, directory), { recursive: true });
    }
    for (const relative of [
      'scripts/release-test-evidence.mjs',
      'scripts/select-vitest-files.mjs',
      'scripts/changed-area-classifier.sh',
      'scripts/changed-area-classifier.mjs',
      'scripts/lib/changed-area-classifier.mjs',
      'scripts/lib/git-ref.mjs',
      'scripts/lib/test-policy.mjs',
      'scripts/lib/static-test-dependency-map.mjs',
      'config/test-policy.json',
    ]) {
      fs.copyFileSync(relative, path.join(temp, relative));
    }
    installIrreversibleMigrationPolicyFixture(temp);
    fs.writeFileSync(path.join(temp, '__tests__/security/critical.test.ts'), 'export {};\n');
    git(temp, 'init', '-q');
    git(temp, 'config', 'user.email', 'fixture@example.com');
    git(temp, 'config', 'user.name', 'Fixture');
    git(temp, 'add', '.');
    git(temp, 'commit', '-qm', 'fixture');
    const fixtureHead = git(temp, 'rev-parse', 'HEAD');
    const fixturePolicyDigest = createHash('sha256')
      .update(fs.readFileSync(path.join(temp, 'config/test-policy.json')))
      .digest('hex');
    const nightly = {
      schema: 'nexus.nightly-full-suite-evidence.v1',
      status: 'passed',
      tier: FULL_RELEASE_TIER,
      headSha: fixtureHead,
      completedAt: new Date().toISOString(),
      testPolicyDigest: fixturePolicyDigest,
      counts: { vitest: 1 },
      testFiles: {
        count: 1,
        digest: createHash('sha256')
          .update(JSON.stringify(['__tests__/security/critical.test.ts']))
          .digest('hex'),
      },
      ci: { runId: '54321', runAttempt: '1', workflow: 'Nightly — Full regression + coverage' },
    };
    fs.writeFileSync(
      path.join(temp, '.local/nightly/nightly-full-suite-evidence.json'),
      `${JSON.stringify(nightly, null, 2)}\n`,
    );
    const output = path.join(temp, '.local/test-selection.json');
    const result = spawnSync(process.execPath, [
      path.join(temp, 'scripts/release-test-evidence.mjs'), 'plan',
      '--head', fixtureHead,
      '--nightly-dir', path.join(temp, '.local/nightly'),
      '--force-full', 'false',
      '--out', output,
    ], { cwd: temp, encoding: 'utf8', env: cleanGitEnv() });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
      tier: DEFAULT_RELEASE_TIER,
      fullRequired: false,
      fullRequiredReason: null,
      nightlyEvidence: { runId: '54321' },
    });
  });

  it('forces the full current suite when a qualifying-nightly descendant removes a test file', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-test-removal-'));
    roots.push(temp);
    for (const directory of ['scripts/lib', 'config', '__tests__/security', '__tests__/services', '.local/nightly']) {
      fs.mkdirSync(path.join(temp, directory), { recursive: true });
    }
    for (const relative of [
      'scripts/release-test-evidence.mjs',
      'scripts/select-vitest-files.mjs',
      'scripts/changed-area-classifier.sh',
      'scripts/changed-area-classifier.mjs',
      'scripts/lib/changed-area-classifier.mjs',
      'scripts/lib/git-ref.mjs',
      'scripts/lib/test-policy.mjs',
      'scripts/lib/static-test-dependency-map.mjs',
      'config/test-policy.json',
    ]) {
      fs.copyFileSync(relative, path.join(temp, relative));
    }
    installIrreversibleMigrationPolicyFixture(temp);
    const critical = '__tests__/security/critical.test.ts';
    const retired = '__tests__/services/retired.test.ts';
    fs.writeFileSync(path.join(temp, critical), 'export {};\n');
    fs.writeFileSync(path.join(temp, retired), 'export {};\n');
    git(temp, 'init', '-q');
    git(temp, 'config', 'user.email', 'fixture@example.com');
    git(temp, 'config', 'user.name', 'Fixture');
    git(temp, 'add', '.');
    git(temp, 'commit', '-qm', 'nightly base');
    const nightlyHead = git(temp, 'rev-parse', 'HEAD');
    const fixturePolicyDigest = createHash('sha256')
      .update(fs.readFileSync(path.join(temp, 'config/test-policy.json')))
      .digest('hex');
    const nightlyFiles = [critical, retired].sort();
    fs.writeFileSync(path.join(temp, '.local/nightly/nightly-full-suite-evidence.json'), JSON.stringify({
      schema: 'nexus.nightly-full-suite-evidence.v1',
      status: 'passed',
      tier: FULL_RELEASE_TIER,
      headSha: nightlyHead,
      completedAt: new Date().toISOString(),
      testPolicyDigest: fixturePolicyDigest,
      counts: { vitest: 2 },
      testFiles: {
        count: nightlyFiles.length,
        digest: createHash('sha256').update(JSON.stringify(nightlyFiles)).digest('hex'),
      },
      ci: { runId: '54321', runAttempt: '1', workflow: 'Nightly — Full regression + coverage' },
    }));
    fs.rmSync(path.join(temp, retired));
    git(temp, 'add', '-A');
    git(temp, 'commit', '-qm', 'retire duplicate test');
    const candidateHead = git(temp, 'rev-parse', 'HEAD');
    const output = path.join(temp, '.local/test-selection.json');
    const result = spawnSync(process.execPath, [
      path.join(temp, 'scripts/release-test-evidence.mjs'), 'plan',
      '--head', candidateHead,
      '--nightly-dir', path.join(temp, '.local/nightly'),
      '--out', output,
    ], { cwd: temp, encoding: 'utf8', env: cleanGitEnv() });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
      tier: FULL_RELEASE_TIER,
      fullRequired: true,
      fullRequiredReason: 'test_topology_change',
      selected: {
        removed: [retired],
        files: [critical],
      },
      classifier: { impactResolved: false },
      nightlyEvidence: { headSha: nightlyHead, runId: '54321' },
    });
  });
});

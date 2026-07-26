import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadTestPolicy,
  partitionTestFiles,
  resolveTestDisposition,
  walkTestFiles,
} from '../../scripts/lib/test-policy.mjs';

const tempRoots: string[] = [];

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

function listedTier(tier: string) {
  return execFileSync(process.execPath, ['scripts/run-test-tier.mjs', tier, '--list'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: cleanGitEnv(),
  }).trim().split('\n').filter(Boolean);
}

function createInventoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-inventory-fixture-'));
  tempRoots.push(root);
  for (const directory of [
    'config',
    '__tests__/scripts',
    '__tests__/evaluation',
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const [file, body] of [
    ['__tests__/scripts/keep.test.ts', "import value from '../../src/value.js';\nvoid value;\n"],
    ['__tests__/scripts/other.test.ts', 'export {};\n'],
    ['__tests__/evaluation/subjective.test.ts', 'export {};\n'],
    ['__tests__/evaluation/second.test.ts', 'export {};\n'],
  ]) {
    fs.writeFileSync(path.join(root, file), body);
  }
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/vitest': { version: '4.0.18' } },
  }));
  fs.writeFileSync(path.join(root, 'config/test-policy.json'), JSON.stringify({
    version: 'inventory-fixture.v1',
    defaultTier: 'full',
    tiers: {
      fast: { include: ['__tests__/scripts/**/*.test.ts'] },
      critical: { include: ['__tests__/scripts/keep.test.ts'] },
      evaluate: { dispositions: ['eval'] },
    },
    dispositionRules: [
      {
        pattern: '__tests__/evaluation/**/*.test.ts',
        disposition: 'eval',
        reason: 'bounded evaluation fixture',
      },
      {
        pattern: '__tests__/**/*.test.ts',
        disposition: 'keep',
        reason: 'bounded deterministic fixture',
      },
    ],
    timingExceptions: [],
    inventoryEvidence: {
      disposition: { maximumPatternFallbackFiles: 4 },
      timing: {
        minimumScopePercent: 100,
        minimumSamplesForPercentiles: 5,
        maximumSamplesForPercentiles: 5,
      },
      uniqueCoverage: { minimumPercent: 0 },
      lastFailure: { minimumPercent: 0 },
    },
  }, null, 2));
  const policy = loadTestPolicy(root);
  const files = walkTestFiles(root);
  return {
    root,
    policy,
    files,
    partitions: partitionTestFiles(files, policy),
  };
}

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('governed test tier partitions', () => {
  it('rejects traversal and symlink parents for JSON reporter output', () => {
    const packageBefore = fs.readFileSync('package.json', 'utf8');
    const traversal = spawnSync(process.execPath, [
      'scripts/run-test-tier.mjs',
      'deterministic',
      '--list',
      '--json-output',
      '.local/../package.json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv(),
    });
    expect(traversal.status).not.toBe(0);
    expect(traversal.stderr).toContain('must stay strictly under .local');
    expect(fs.readFileSync('package.json', 'utf8')).toBe(packageBefore);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-json-output-outside-'));
    tempRoots.push(outside);
    fs.mkdirSync('.local', { recursive: true });
    const linkName = `json-output-link-${process.pid}-${Date.now()}`;
    const link = path.join('.local', linkName);
    fs.symlinkSync(outside, link);
    try {
      const symlinked = spawnSync(process.execPath, [
        'scripts/run-test-tier.mjs',
        'deterministic',
        '--list',
        '--json-output',
        `${link}/report.json`,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: cleanGitEnv(),
      });
      expect(symlinked.status).not.toBe(0);
      expect(symlinked.stderr).toContain('parent must be a real directory');
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.unlinkSync(link);
    }

    const hardlinkTarget = path.join(outside, 'must-remain.json');
    fs.writeFileSync(hardlinkTarget, 'preserve-me\n');
    const hardlinkName = `json-output-hardlink-${process.pid}-${Date.now()}.json`;
    const hardlink = path.join('.local', hardlinkName);
    fs.linkSync(hardlinkTarget, hardlink);
    try {
      const hardlinked = spawnSync(process.execPath, [
        'scripts/run-test-tier.mjs',
        'deterministic',
        '--list',
        '--json-output',
        `.local/${hardlinkName}`,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: cleanGitEnv(),
      });
      expect(hardlinked.status).not.toBe(0);
      expect(hardlinked.stderr).toContain('must not be hardlinked');
      expect(fs.readFileSync(hardlinkTarget, 'utf8')).toBe('preserve-me\n');
    } finally {
      fs.unlinkSync(hardlink);
    }
  });

  it('resolves exact and pattern disposition provenance in policy order', () => {
    const policy = {
      dispositionRules: [
        { pattern: '__tests__/exact.test.ts', disposition: 'eval', reason: 'exact exception' },
        { pattern: '__tests__/**/*.test.ts', disposition: 'keep', reason: 'default' },
      ],
    };

    expect(resolveTestDisposition('__tests__/exact.test.ts', policy)).toMatchObject({
      disposition: 'eval',
      provenance: { kind: 'exact', pattern: '__tests__/exact.test.ts', ruleIndex: 0 },
    });
    expect(resolveTestDisposition('__tests__/nested/other.test.ts', policy)).toMatchObject({
      disposition: 'keep',
      provenance: { kind: 'pattern', pattern: '__tests__/**/*.test.ts', ruleIndex: 1 },
    });
  });

  it('preserves the earliest matching disposition across cached exact and glob rules', () => {
    const earlierGlob = {
      dispositionRules: [
        { pattern: '__tests__/**/*.test.ts', disposition: 'keep', reason: 'earlier glob' },
        { pattern: '__tests__/exact.test.ts', disposition: 'eval', reason: 'later exact' },
      ],
    };
    const earlierExact = {
      dispositionRules: [
        { pattern: '__tests__/exact.test.ts', disposition: 'eval', reason: 'earlier exact' },
        { pattern: '__tests__/**/*.test.ts', disposition: 'keep', reason: 'later glob' },
      ],
    };

    expect(resolveTestDisposition('__tests__/exact.test.ts', earlierGlob)).toMatchObject({
      disposition: 'keep',
      provenance: { kind: 'pattern', ruleIndex: 0 },
    });
    expect(resolveTestDisposition('__tests__/exact.test.ts', earlierExact)).toMatchObject({
      disposition: 'eval',
      provenance: { kind: 'exact', ruleIndex: 0 },
    });
    expect(resolveTestDisposition('__tests__/exact.test.ts', earlierExact)).toMatchObject({
      disposition: 'eval',
      provenance: { kind: 'exact', ruleIndex: 0 },
    });
  });

  it('keeps migration 253 legacy-idea authority suites on exact reviewed dispositions', () => {
    const policy = loadTestPolicy();
    for (const file of [
      '__tests__/migrations/content-legacy-idea-note-workspace-parity.test.ts',
      '__tests__/services/content-legacy-idea-workspace-exit.test.ts',
    ]) {
      expect(resolveTestDisposition(file, policy)).toMatchObject({
        disposition: 'keep',
        provenance: { kind: 'exact', pattern: file },
      });
    }
  });

  it('makes full and evaluation runners exact, disjoint disposition partitions', { timeout: 30_000 }, () => {
    const files = walkTestFiles();
    const policy = loadTestPolicy();
    const partitions = partitionTestFiles(files, policy);

    expect(listedTier('deterministic')).toEqual(partitions.deterministic);
    expect(listedTier('full-sharded')).toEqual(partitions.deterministic);
    expect(listedTier('evaluate')).toEqual(partitions.evaluation);
    expect(policy.tiers.evaluate.dispositions).toEqual(['eval']);
    expect(new Set([...partitions.deterministic, ...partitions.evaluation]).size).toBe(files.length);
    expect(partitions.deterministic.filter((file) => partitions.evaluation.includes(file))).toEqual([]);
  });

  it('keeps fail-closed changed-test escalation inside the deterministic partition', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-selection-partition-'));
    tempRoots.push(temp);
    const classifierPath = path.join(temp, 'classifier.json');
    fs.writeFileSync(classifierPath, JSON.stringify({
      vitest: { mode: 'full', globs: ['__tests__/**/*.test.ts'] },
      flags: { impactResolved: false },
      cannotSkip: ['test-infrastructure-full-suite'],
    }));
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv(),
    }).trim();
    const selection = JSON.parse(execFileSync(process.execPath, [
      'scripts/select-vitest-files.mjs',
      '--base', baseSha,
      '--classifier', classifierPath,
      '--json',
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() }));
    const partitions = partitionTestFiles(walkTestFiles(), loadTestPolicy());

    expect(selection.selected).toEqual(partitions.deterministic);
    expect(selection.selected).not.toContain(partitions.evaluation[0]);
    expect(selection.escalated).toBe('classifier-full');
  });

  it('reports scoped timing and missing historical evidence without inventing values', {
    timeout: 30_000,
  }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-inventory-'));
    tempRoots.push(temp);
    const fixture = createInventoryFixture();
    const { files, partitions } = fixture;
    const reportPath = path.join(temp, 'results.json');
    const outputPath = path.join(temp, 'inventory.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      success: true,
      testResults: partitions.evaluation.map((file, index) => ({
        name: path.resolve(fixture.root, file),
        startTime: index * 100,
        endTime: index * 100 + 25,
      })),
    }));

    const inventoryRun = spawnSync(process.execPath, [
      'scripts/test-inventory.mjs',
      '--root', fixture.root,
      '--timings', reportPath,
      '--timing-history-dir', path.join(temp, 'missing-history'),
      '--timing-scope', 'evaluate',
      '--enforce-evidence',
      '--output', outputPath,
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(inventoryRun.status).toBe(0);
    expect(inventoryRun.stderr).toContain('Timing history advisory');

    const inventory = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(inventory.summary).toMatchObject({
      schema: 'nexus.test-inventory.v4',
      testFiles: files.length,
      deterministicFiles: partitions.deterministic.length,
      evaluationFiles: partitions.evaluation.length,
      timingGovernance: { mode: 'enforce', thresholdMs: 10_000 },
      evidenceCompleteness: {
        timing: {
          scope: 'evaluate',
          observedFiles: partitions.evaluation.length,
          expectedFiles: partitions.evaluation.length,
          percent: 100,
          complete: true,
          percentileQualifiedFiles: 0,
          history: {
            requested: true,
            status: 'unavailable',
            candidateArtifacts: 0,
            compatibleArtifacts: 0,
            selectedArtifacts: 0,
            maximumArtifacts: 4,
            maximumSamplesPerFile: 5,
          },
        },
        uniqueCoverage: { collectionStatus: 'not-collected', observedFiles: 0, percent: 0 },
        lastFailure: { collectionStatus: 'not-collected', observedFiles: 0, percent: 0 },
      },
    });
    expect(inventory.summary.byDispositionProvenance.exact
      + inventory.summary.byDispositionProvenance.pattern).toBe(files.length);
    const evaluationRecord = inventory.records.find((record: { file: string }) => (
      record.file === partitions.evaluation[0]
    ));
    expect(evaluationRecord).toMatchObject({
      runtimeMs: 25,
      runtimeSampleCount: 1,
      runtimeP50Ms: null,
      runtimeP95Ms: null,
      runtimeEvidence: 'insufficient-history-for-percentiles',
      uniqueCoverage: null,
      uniqueCoverageEvidence: 'not-collected',
      lastFailure: null,
      lastFailureEvidence: 'not-collected',
    });
  });

  it('qualifies p50/p95 from the latest five exact-compatible nightly samples only', {
    timeout: 30_000,
  }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-timing-history-'));
    tempRoots.push(temp);
    const fixture = createInventoryFixture();
    const { partitions } = fixture;
    const reportPath = path.join(temp, 'results.json');
    const templatePath = path.join(temp, 'template.json');
    const outputPath = path.join(temp, 'inventory.json');
    const historyRoot = path.join(temp, 'history');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv(),
    }).trim();
    const writeReport = (runtimeMs: number) => {
      fs.writeFileSync(reportPath, JSON.stringify({
        success: true,
        testResults: partitions.evaluation.map((file, index) => ({
          name: path.resolve(fixture.root, file),
          startTime: index * 100,
          endTime: index * 100 + runtimeMs,
        })),
      }));
    };
    const ciEnv = (runId: string) => cleanGitEnv({
      GITHUB_WORKFLOW: 'Nightly — Full regression + coverage',
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: headSha,
    });

    writeReport(5);
    execFileSync(process.execPath, [
      'scripts/test-inventory.mjs',
      '--root', fixture.root,
      '--timings', reportPath,
      '--timing-scope', 'evaluate',
      '--output', templatePath,
    ], { cwd: process.cwd(), env: ciEnv('100') });
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const now = Date.now();
    const writeHistory = (
      directory: string,
      runId: string,
      runtimeMs: number,
      ageDays: number,
      mutate: (inventory: any) => void = () => {},
    ) => {
      const inventory = structuredClone(template);
      inventory.summary.generatedAt = new Date(now - ageDays * 86_400_000).toISOString();
      inventory.summary.timingIdentity.source.runId = runId;
      for (const record of inventory.records) {
        if (record.tiers.includes('evaluate')) record.runtimeMs = runtimeMs;
      }
      mutate(inventory);
      const destination = path.join(historyRoot, directory);
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'test-inventory.json'), JSON.stringify(inventory));
    };

    writeHistory('run-104', '104', 40, 1);
    writeHistory('run-103', '103', 30, 2);
    writeHistory('run-102', '102', 20, 3);
    writeHistory('run-101', '101', 10, 4);
    writeHistory('run-100', '100', 999, 5);
    writeHistory('old-schema', '99', 998, 0.1, (inventory) => {
      inventory.summary.schema = 'nexus.test-inventory.v3';
    });
    writeHistory('wrong-policy', '98', 997, 0.2, (inventory) => {
      inventory.summary.timingIdentity.policyDigest = '0'.repeat(64);
    });
    writeHistory('wrong-toolchain', '97', 996, 0.3, (inventory) => {
      inventory.summary.timingIdentity.toolchain.node = '0.0.0';
    });
    const malformedDirectory = path.join(historyRoot, 'malformed');
    fs.mkdirSync(malformedDirectory, { recursive: true });
    fs.writeFileSync(path.join(malformedDirectory, 'test-inventory.json'), '{');

    writeReport(50);
    const inventoryRun = spawnSync(process.execPath, [
      'scripts/test-inventory.mjs',
      '--root', fixture.root,
      '--timings', reportPath,
      '--timing-history-dir', historyRoot,
      '--timing-scope', 'evaluate',
      '--enforce-evidence',
      '--output', outputPath,
    ], { cwd: process.cwd(), encoding: 'utf8', env: ciEnv('105') });
    expect(inventoryRun.status).toBe(0);
    expect(inventoryRun.stderr).not.toContain('Timing history advisory');

    const inventory = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(inventory.summary.evidenceCompleteness.timing).toMatchObject({
      minimumSamplesForPercentiles: 5,
      maximumSamplesForPercentiles: 5,
      percentileQualifiedFiles: partitions.evaluation.length,
      history: {
        status: 'window-qualified',
        candidateArtifacts: 9,
        compatibleArtifacts: 5,
        selectedArtifacts: 4,
        unusedCompatibleArtifacts: 1,
        rejectedArtifacts: 4,
        maximumArtifacts: 4,
        discoveryLimits: {
          maximumCandidates: 10,
          maximumFileBytes: 2 * 1024 * 1024,
          maximumDepth: 4,
          maximumEntries: 64,
        },
        rejectionReasons: {
          'inventory-schema': 1,
          'test-policy-digest': 1,
          toolchain: 1,
          'malformed-json': 1,
        },
      },
    });
    const evaluationRecord = inventory.records.find((record: { file: string }) => (
      record.file === partitions.evaluation[0]
    ));
    expect(evaluationRecord).toMatchObject({
      runtimeMs: 50,
      runtimeSampleCount: 5,
      runtimeP50Ms: 30,
      runtimeP95Ms: 50,
      runtimeEvidence: 'percentiles-qualified',
    });
  });

  it('fails timing history closed on candidate over-count, oversize files, and symlinks', {
    timeout: 30_000,
  }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-timing-bounds-'));
    tempRoots.push(temp);
    const fixture = createInventoryFixture();
    const { partitions } = fixture;
    const reportPath = path.join(temp, 'results.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      success: true,
      testResults: partitions.evaluation.map((file, index) => ({
        name: path.resolve(fixture.root, file),
        startTime: index * 100,
        endTime: index * 100 + 25,
      })),
    }));
    const runInventory = (historyRoot: string, label: string) => {
      const outputPath = path.join(temp, `${label}.json`);
      const result = spawnSync(process.execPath, [
        'scripts/test-inventory.mjs',
        '--root', fixture.root,
        '--timings', reportPath,
        '--timing-history-dir', historyRoot,
        '--timing-scope', 'evaluate',
        '--enforce-evidence',
        '--output', outputPath,
      ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Timing history advisory');
      return JSON.parse(fs.readFileSync(outputPath, 'utf8'))
        .summary.evidenceCompleteness.timing.history;
    };

    const overCountRoot = path.join(temp, 'over-count');
    for (let index = 0; index < 11; index += 1) {
      const directory = path.join(overCountRoot, String(index));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'test-inventory.json'), '{}');
    }
    expect(runInventory(overCountRoot, 'over-count')).toMatchObject({
      status: 'unavailable',
      candidateArtifacts: 11,
      selectedArtifacts: 0,
      discoveryFailure: 'candidate-limit',
      rejectionReasons: { 'candidate-limit': 1 },
    });

    const oversizeRoot = path.join(temp, 'oversize', 'run');
    fs.mkdirSync(oversizeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(oversizeRoot, 'test-inventory.json'),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x20),
    );
    expect(runInventory(path.dirname(oversizeRoot), 'oversize')).toMatchObject({
      status: 'unavailable',
      candidateArtifacts: 1,
      rejectedArtifacts: 1,
      rejectionReasons: { 'inventory-size': 1 },
    });

    const symlinkRoot = path.join(temp, 'symlink', 'run');
    fs.mkdirSync(symlinkRoot, { recursive: true });
    const symlinkTarget = path.join(temp, 'symlink-target.json');
    fs.writeFileSync(symlinkTarget, '{}');
    fs.symlinkSync(symlinkTarget, path.join(symlinkRoot, 'test-inventory.json'));
    expect(runInventory(path.dirname(symlinkRoot), 'symlink')).toMatchObject({
      status: 'unavailable',
      candidateArtifacts: 1,
      rejectedArtifacts: 1,
      rejectionReasons: { 'candidate-type': 1 },
    });
  });

  it('accepts exactly one bounded run-bound artifact and rejects ambiguity or oversize metadata', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-timing-artifact-'));
    tempRoots.push(temp);
    const artifactsPath = path.join(temp, 'artifacts.json');
    const runSelector = (artifacts: unknown[], label: string) => {
      fs.writeFileSync(artifactsPath, JSON.stringify({ artifacts }));
      return spawnSync(process.execPath, [
        'scripts/test-timing-history-artifact.mjs', 'select',
        '--run-id', '123',
        '--artifacts', artifactsPath,
        '--output', path.join(temp, `${label}.json`),
      ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    };
    const validArtifact = {
      id: 456,
      name: 'test-inventory-123-2',
      expired: false,
      size_in_bytes: 1024,
      workflow_run: { id: 123 },
    };

    const accepted = runSelector([
      { ...validArtifact, id: 455, name: 'unrelated-artifact' },
      validArtifact,
      { ...validArtifact, id: 454, expired: true, name: 'test-inventory-123-1' },
    ], 'accepted');
    expect(accepted.status).toBe(0);
    expect(accepted.stdout.trim()).toBe('456');
    expect(JSON.parse(fs.readFileSync(path.join(temp, 'accepted.json'), 'utf8'))).toEqual({
      artifactId: 456,
      name: 'test-inventory-123-2',
      runId: '123',
      runAttempt: 2,
      archiveBytes: 1024,
    });

    const ambiguous = runSelector([
      validArtifact,
      { ...validArtifact, id: 457, name: 'test-inventory-123-3' },
    ], 'ambiguous');
    expect(ambiguous.status).not.toBe(0);
    expect(ambiguous.stderr).toContain('exactly one non-expired timing artifact');

    const oversized = runSelector([
      { ...validArtifact, size_in_bytes: 5 * 1024 * 1024 + 1 },
    ], 'oversized');
    expect(oversized.status).not.toBe(0);
    expect(oversized.stderr).toContain('invalid or oversized');

    const injectedRunId = spawnSync(process.execPath, [
      'scripts/test-timing-history-artifact.mjs', 'select',
      '--run-id', '123|.*',
      '--artifacts', artifactsPath,
      '--output', path.join(temp, 'injected-run-id.json'),
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(injectedRunId.status).not.toBe(0);
    expect(injectedRunId.stderr).toContain('run ID must be a positive integer');
  });

  it('extracts only a bounded canonical inventory document from the artifact archive', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-timing-extract-'));
    tempRoots.push(temp);
    const archiveRoot = path.join(temp, 'archive-root');
    const inventoryDirectory = path.join(archiveRoot, 'test-inventory');
    fs.mkdirSync(inventoryDirectory, { recursive: true });
    const sourceInventory = path.join(inventoryDirectory, 'test-inventory.json');
    const archivePath = path.join(temp, 'artifact.zip');
    fs.writeFileSync(sourceInventory, JSON.stringify({ summary: {}, records: [] }));
    execFileSync('zip', ['-q', '-r', archivePath, 'test-inventory'], {
      cwd: archiveRoot,
      env: cleanGitEnv(),
    });
    const outputPath = path.join(temp, 'extracted', 'test-inventory.json');
    const extracted = spawnSync(process.execPath, [
      'scripts/test-timing-history-artifact.mjs', 'extract',
      '--archive', archivePath,
      '--output', outputPath,
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(extracted.status).toBe(0);
    expect(fs.lstatSync(outputPath).isFile()).toBe(true);
    expect(fs.lstatSync(outputPath).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual({
      summary: {},
      records: [],
    });

    const oversizedRoot = path.join(temp, 'oversized-root');
    const oversizedDirectory = path.join(oversizedRoot, 'test-inventory');
    fs.mkdirSync(oversizedDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(oversizedDirectory, 'test-inventory.json'),
      JSON.stringify({ summary: {}, records: [], padding: 'x'.repeat(2 * 1024 * 1024) }),
    );
    const oversizedArchive = path.join(temp, 'oversized.zip');
    execFileSync('zip', ['-q', '-r', oversizedArchive, 'test-inventory'], {
      cwd: oversizedRoot,
      env: cleanGitEnv(),
    });
    const rejected = spawnSync(process.execPath, [
      'scripts/test-timing-history-artifact.mjs', 'extract',
      '--archive', oversizedArchive,
      '--output', path.join(temp, 'oversized-output.json'),
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('missing, invalid, or oversized');
  });

  it('keeps cold shared-runner timing advisory without hiding correctness evidence', { timeout: 30_000 }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-timing-advisory-'));
    tempRoots.push(temp);
    const fixture = createInventoryFixture();
    const { partitions, policy } = fixture;
    const exceptions = new Set((policy.timingExceptions ?? []).map(
      ({ file }: { file: string }) => file,
    ));
    const slowFile = partitions.evaluation.find((file) => !exceptions.has(file));
    expect(slowFile).toBeTruthy();
    const reportPath = path.join(temp, 'results.json');
    const advisoryOutput = path.join(temp, 'advisory.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      success: true,
      testResults: partitions.evaluation.map((file, index) => ({
        name: path.resolve(fixture.root, file),
        startTime: index * 20_000,
        endTime: index * 20_000 + (file === slowFile ? 10_001 : 25),
      })),
    }));

    const advisory = spawnSync(process.execPath, [
      'scripts/test-inventory.mjs',
      '--root', fixture.root,
      '--timings', reportPath,
      '--timing-scope', 'evaluate',
      '--timing-mode', 'advisory',
      '--enforce-evidence',
      '--output', advisoryOutput,
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(advisory.status).toBe(0);
    expect(advisory.stderr).toContain('Slow-test advisory');
    expect(JSON.parse(fs.readFileSync(advisoryOutput, 'utf8')).summary).toMatchObject({
      slowNonExemptFiles: 1,
      timingGovernance: { mode: 'advisory', thresholdMs: 10_000 },
    });

    const enforced = spawnSync(process.execPath, [
      'scripts/test-inventory.mjs',
      '--root', fixture.root,
      '--timings', reportPath,
      '--timing-scope', 'evaluate',
      '--timing-mode', 'enforce',
      '--enforce-evidence',
      '--output', path.join(temp, 'enforced.json'),
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(enforced.status).toBe(1);
    expect(enforced.stderr).toContain('Slow-test governance');
  });

  it('binds nightly release evidence to deterministic files only', {
    timeout: 30_000,
  }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-deterministic-nightly-'));
    tempRoots.push(temp);
    const partitions = partitionTestFiles(walkTestFiles(), loadTestPolicy());
    const reportPath = path.join(temp, 'results.json');
    const evidencePath = path.join(temp, 'evidence.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      success: true,
      numTotalTests: partitions.deterministic.length,
      testResults: partitions.deterministic.map((file) => ({
        name: path.resolve(file),
        assertionResults: [{ status: 'passed' }],
      })),
    }));
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv(),
    }).trim();
    execFileSync(process.execPath, [
      'scripts/release-test-evidence.mjs', 'write-nightly',
      '--head', headSha,
      '--vitest-results', reportPath,
      '--out', evidencePath,
      '--run-id', '12345',
      '--run-attempt', '1',
    ], {
      cwd: process.cwd(),
      env: cleanGitEnv({ GITHUB_WORKFLOW: 'Nightly — Full regression + coverage' }),
    });
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    expect(evidence.testFiles.count).toBe(partitions.deterministic.length);
    expect(evidence.testFiles.count).toBeLessThan(walkTestFiles().length);

    fs.writeFileSync(reportPath, JSON.stringify({
      success: true,
      numTotalTests: partitions.deterministic.length + 1,
      testResults: [
        ...partitions.deterministic.map((file) => ({ name: path.resolve(file) })),
        { name: path.resolve(partitions.evaluation[0]) },
      ],
    }));
    const contaminated = spawnSync(process.execPath, [
      'scripts/release-test-evidence.mjs', 'write-nightly',
      '--head', headSha,
      '--vitest-results', reportPath,
      '--out', evidencePath,
      '--run-id', '12345',
      '--run-attempt', '1',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv({ GITHUB_WORKFLOW: 'Nightly — Full regression + coverage' }),
    });
    expect(contaminated.status).not.toBe(0);
    expect(contaminated.stderr).toContain('does not cover every deterministic Vitest file exactly once');
  });

  it('wires scheduled evaluation and deterministic nightly workflows through governed tiers', () => {
    const evaluationWorkflow = fs.readFileSync('.github/workflows/evaluation.yml', 'utf8');
    const nightlyWorkflow = fs.readFileSync('.github/workflows/nightly.yml', 'utf8');
    const riskGate = fs.readFileSync('scripts/risk-gate.sh', 'utf8');

    expect(evaluationWorkflow).toContain('schedule:');
    expect(evaluationWorkflow).toContain('workflow_dispatch:');
    expect(evaluationWorkflow).toContain('npm run test:evaluate');
    expect(evaluationWorkflow).toContain('--timing-scope evaluate');
    expect(nightlyWorkflow).toContain('scripts/run-test-tier.mjs deterministic');
    expect(nightlyWorkflow).toContain('actions: read');
    expect(nightlyWorkflow).toContain('Download recent timing history (advisory)');
    expect(nightlyWorkflow).toContain('[ "$run_id" != "$GITHUB_RUN_ID" ]');
    expect(nightlyWorkflow).toContain('actions/runs/$run_id/artifacts?per_page=100');
    expect(nightlyWorkflow).toContain('test-timing-history-artifact.mjs select');
    expect(nightlyWorkflow).toContain('test-timing-history-artifact.mjs extract');
    expect(nightlyWorkflow).not.toContain('gh run download');
    expect(nightlyWorkflow).toContain('--timing-history-dir .local/test-profile/timing-history');
    expect(nightlyWorkflow).toContain('--timing-scope deterministic');
    expect(nightlyWorkflow).toContain('--timing-mode advisory');
    expect(riskGate).toContain('scripts/run-test-tier.mjs deterministic');
    const fullCase = riskGate.match(/\n  full\)\n(?<body>[\s\S]*?)\n    ;;/)?.groups?.body ?? '';
    expect(fullCase).toContain('scripts/run-test-tier.mjs deterministic');
    expect(fullCase).not.toContain('npx vitest run');
  });
});

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

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('governed test tier partitions', () => {
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

  it('reports scoped timing and missing historical evidence without inventing values', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-inventory-'));
    tempRoots.push(temp);
    const policy = loadTestPolicy();
    const files = walkTestFiles();
    const partitions = partitionTestFiles(files, policy);
    const reportPath = path.join(temp, 'results.json');
    const outputPath = path.join(temp, 'inventory.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      success: true,
      testResults: partitions.evaluation.map((file, index) => ({
        name: path.resolve(file),
        startTime: index * 100,
        endTime: index * 100 + 25,
      })),
    }));

    execFileSync(process.execPath, [
      'scripts/test-inventory.mjs',
      '--timings', reportPath,
      '--timing-scope', 'evaluate',
      '--enforce-evidence',
      '--output', outputPath,
    ], { cwd: process.cwd(), env: cleanGitEnv() });

    const inventory = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(inventory.summary).toMatchObject({
      schema: 'nexus.test-inventory.v2',
      testFiles: files.length,
      deterministicFiles: partitions.deterministic.length,
      evaluationFiles: partitions.evaluation.length,
      evidenceCompleteness: {
        timing: {
          scope: 'evaluate',
          observedFiles: partitions.evaluation.length,
          expectedFiles: partitions.evaluation.length,
          percent: 100,
          complete: true,
          percentileQualifiedFiles: 0,
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

  it('binds nightly release evidence to deterministic files only', () => {
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
    expect(nightlyWorkflow).toContain('--timing-scope deterministic');
    expect(riskGate).toContain('scripts/run-test-tier.mjs deterministic');
    const fullCase = riskGate.match(/\n  full\)\n(?<body>[\s\S]*?)\n    ;;/)?.groups?.body ?? '';
    expect(fullCase).toContain('scripts/run-test-tier.mjs deterministic');
    expect(fullCase).not.toContain('npx vitest run');
  });
});

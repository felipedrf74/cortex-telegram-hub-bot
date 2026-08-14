import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STAGING_SMOKE_PROFILE,
  validateStagingSmokeEvidenceFile,
} from '../../scripts/lib/staging-smoke-evidence.mjs';

const roots: string[] = [];
const runtimeSha = 'a'.repeat(40);
const artifactDigest = 'b'.repeat(64);
const classifierBaseSha = 'c'.repeat(40);
const canonicalChecks = [
  'content-engine /health',
  'nexus-hub /api/snapshot',
  'snapshot.uptime',
  'snapshot.bot',
  'snapshot.integrations',
  'snapshot.apiUsage',
  'cost-by-domain.totalCost',
  'cost-by-domain.detailed',
  'cost-by-domain.providerSplit',
  'cost-by-domain.dailySeries',
  'provider-stats.providers',
  'iOS /api/v1/dashboard',
  'iOS /api/v1/tasks/lists',
  'iOS /api/v1/training/today',
  'iOS /api/v1/plan/today',
  'iOS chat-message route boundary',
  'pm2 nexus-hub online',
  'pm2 content-engine online',
  'pm2 nexus-hub restarts == 0',
  'training plan preview e2e',
  'locale fidelity chat smoke',
  'Staging DB integrity',
  'Ollama release policy',
  'immutable staging selector',
];

function sha256(body: Buffer | string) {
  return createHash('sha256').update(body).digest('hex');
}

function writePrivateJson(root: string, name: string, value: unknown) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function validFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-staging-smoke-evidence-'));
  roots.push(root);
  const stagingCompletedAt = '2026-08-06T10:00:00.000Z';
  const checks = [
    ...canonicalChecks.map((name) => ({ name, status: 'passed', detail: null })),
    {
      name: 'domain training /api/v1/training/today',
      status: 'passed',
      detail: 'HTTP 401 canonical envelope',
    },
    {
      name: 'domain coach /api/v1/training/coach/briefing',
      status: 'passed',
      detail: 'HTTP 401 canonical envelope',
    },
    {
      name: 'domain calendar /api/v1/training/calendar',
      status: 'passed',
      detail: 'HTTP 401 canonical envelope',
    },
    { name: 'domain migration count', status: 'passed', detail: 'applied=282' },
  ];
  const evidence = {
    version: '2',
    profile: STAGING_SMOKE_PROFILE,
    runStartedAt: '2026-08-06T10:00:01.000Z',
    runCompletedAt: '2026-08-06T10:00:10.000Z',
    branch: 'main',
    sha: runtimeSha,
    runtimeSha,
    artifactDigest,
    classifierBaseSha,
    classifierHeadSha: runtimeSha,
    host: 'staging',
    verdict: 'passed',
    totals: { passed: checks.length, failed: 0, total: checks.length },
    checks,
  };
  const classifier = {
    version: '2',
    generatedAt: '2026-08-06T09:59:59.000Z',
    baseRef: classifierBaseSha,
    head: runtimeSha,
    flags: {
      training: true,
      coachKernel: true,
      calendar: true,
      cooking: false,
      content: false,
      secretary: false,
      migration: true,
    },
    stagingSmoke: {
      generic: true,
      domains: ['smoke:training-cross-skill:staging', 'smoke:training-calendar:staging'],
    },
  };
  const stagingState = {
    schema: 'nexus.lean-release-transaction.v1',
    role: 'staging',
    transactionId: `20260806T100000Z-${'f'.repeat(12)}`,
    runtimeSha,
    artifactDigest,
    phase: 'completed',
    status: 'passed',
    completedAt: stagingCompletedAt,
  };
  const evidencePath = writePrivateJson(root, 'smoke.json', evidence);
  const classifierPath = writePrivateJson(root, 'classifier.json', classifier);
  const stagingStatePath = writePrivateJson(root, 'staging.json', stagingState);
  return { root, evidence, classifier, stagingState, evidencePath, classifierPath, stagingStatePath };
}

function rewritePrivateJson(filename: string, value: unknown) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function validateFixture(
  fixture: ReturnType<typeof validFixture>,
  overrides: Partial<Parameters<typeof validateStagingSmokeEvidenceFile>[0]> = {},
) {
  return validateStagingSmokeEvidenceFile({
    evidencePath: fixture.evidencePath,
    classifierPath: fixture.classifierPath,
    stagingStatePath: fixture.stagingStatePath,
    expectedRuntimeSha: runtimeSha,
    expectedArtifactDigest: artifactDigest,
    expectedClassifierBaseSha: classifierBaseSha,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('release staging smoke evidence', () => {
  it('accepts one exact post-staging smoke and binds every required domain probe', () => {
    const fixture = validFixture();

    const result = validateFixture(fixture);

    expect(result).toMatchObject({
      schema: 'nexus.staging-smoke-evidence-validation.v1',
      evidenceSha256: sha256(fs.readFileSync(fixture.evidencePath)),
      classifierSha256: sha256(fs.readFileSync(fixture.classifierPath)),
      stagingStateSha256: sha256(fs.readFileSync(fixture.stagingStatePath)),
      stagingTransactionId: fixture.stagingState.transactionId,
      runtimeSha,
      artifactDigest,
      evidenceVersion: '2',
      profile: STAGING_SMOKE_PROFILE,
      host: 'staging',
      verdict: 'passed',
      stagingCompletedAt: fixture.stagingState.completedAt,
      runStartedAt: fixture.evidence.runStartedAt,
      runCompletedAt: fixture.evidence.runCompletedAt,
      totals: fixture.evidence.totals,
      classifierBaseSha,
      classifierHeadSha: runtimeSha,
      classifierVersion: '2',
      domainProbes: [
        'calendar',
        'coachKernel',
        'migration',
        'training',
      ],
    });
    expect(result.evidencePath).toBe(path.resolve(fixture.evidencePath));
    expect(result.classifierPath).toBe(path.resolve(fixture.classifierPath));
    expect(result.checks).toEqual(fixture.evidence.checks);
  });

  it.each([
    ['profile', 'unexpected-profile'],
    ['host', 'production'],
    ['runtimeSha', 'd'.repeat(40)],
  ] as const)('rejects evidence with a mismatched %s', (field, value) => {
    const fixture = validFixture();
    rewritePrivateJson(fixture.evidencePath, { ...fixture.evidence, [field]: value });

    expect(() => validateFixture(fixture)).toThrow('identity or verdict is invalid');
  });

  it('rejects evidence with a mismatched artifact digest', () => {
    const fixture = validFixture();
    rewritePrivateJson(fixture.evidencePath, {
      ...fixture.evidence,
      artifactDigest: 'e'.repeat(64),
    });

    expect(() => validateFixture(fixture)).toThrow('identity or verdict is invalid');
  });

  it('rejects evidence that started before the completed staging transaction', () => {
    const fixture = validFixture();
    rewritePrivateJson(fixture.evidencePath, {
      ...fixture.evidence,
      runStartedAt: '2026-08-06T09:59:59.000Z',
    });

    expect(() => validateFixture(fixture)).toThrow(
      'did not run after the completed staging transaction',
    );
  });

  it('rejects inconsistent totals and any missing required canonical check', () => {
    const totalsFixture = validFixture();
    rewritePrivateJson(totalsFixture.evidencePath, {
      ...totalsFixture.evidence,
      totals: { ...totalsFixture.evidence.totals, passed: 1 },
    });
    expect(() => validateFixture(totalsFixture)).toThrow('totals are inconsistent');

    const checksFixture = validFixture();
    const checks = checksFixture.evidence.checks.filter(
      (check) => check.name !== 'training plan preview e2e',
    );
    rewritePrivateJson(checksFixture.evidencePath, {
      ...checksFixture.evidence,
      totals: { passed: checks.length, failed: 0, total: checks.length },
      checks,
    });
    expect(() => validateFixture(checksFixture)).toThrow(
      'canonical checks are missing: training plan preview e2e',
    );
  });

  it('rejects missing, extra, or unknown classifier-driven domain probes', () => {
    const missingFixture = validFixture();
    const missingChecks = missingFixture.evidence.checks.filter(
      (check) => check.name !== 'domain migration count',
    );
    rewritePrivateJson(missingFixture.evidencePath, {
      ...missingFixture.evidence,
      totals: { passed: missingChecks.length, failed: 0, total: missingChecks.length },
      checks: missingChecks,
    });
    expect(() => validateFixture(missingFixture)).toThrow(
      'domain probes do not match the exact classifier result',
    );

    const extraFixture = validFixture();
    const extraChecks = [
      ...extraFixture.evidence.checks,
      { name: 'domain cooking /api/v1/cooking/recipes', status: 'passed', detail: null },
    ];
    rewritePrivateJson(extraFixture.evidencePath, {
      ...extraFixture.evidence,
      totals: { passed: extraChecks.length, failed: 0, total: extraChecks.length },
      checks: extraChecks,
    });
    expect(() => validateFixture(extraFixture)).toThrow(
      'domain probes do not match the exact classifier result',
    );

    const unknownFixture = validFixture();
    const unknownChecks = [
      ...unknownFixture.evidence.checks,
      { name: 'domain fabricated /api/v1/fabricated', status: 'passed', detail: null },
    ];
    rewritePrivateJson(unknownFixture.evidencePath, {
      ...unknownFixture.evidence,
      totals: { passed: unknownChecks.length, failed: 0, total: unknownChecks.length },
      checks: unknownChecks,
    });
    expect(() => validateFixture(unknownFixture)).toThrow('unknown domain probe');
  });

  it('binds evidence, classifier, and staging state hashes into one immutable local state', () => {
    const fixture = validFixture();
    const result = validateFixture(fixture);
    const bindingPath = writePrivateJson(fixture.root, 'release.json', {
      schema: 'nexus.lean-release-state.v1',
      stagingSmoke: result,
    });

    expect(validateFixture(fixture, {
      expectedEvidenceSha256: result.evidenceSha256,
      expectedClassifierSha256: result.classifierSha256,
      expectedBindingPath: bindingPath,
    })).toEqual(result);

    rewritePrivateJson(fixture.stagingStatePath, {
      ...fixture.stagingState,
      completedAt: '2026-08-06T10:00:00.500Z',
    });
    expect(() => validateFixture(fixture, {
      expectedEvidenceSha256: result.evidenceSha256,
      expectedClassifierSha256: result.classifierSha256,
      expectedBindingPath: bindingPath,
    })).toThrow('binding changed after preparation');
  });

  it('rejects evidence or classifier bytes changed after preparation', () => {
    const evidenceFixture = validFixture();
    const evidenceSha256 = sha256(fs.readFileSync(evidenceFixture.evidencePath));
    rewritePrivateJson(evidenceFixture.evidencePath, {
      ...evidenceFixture.evidence,
      branch: 'tampered',
    });
    expect(() => validateFixture(evidenceFixture, {
      expectedEvidenceSha256: evidenceSha256,
    })).toThrow('evidence digest changed after preparation');

    const classifierFixture = validFixture();
    const classifierSha256 = sha256(fs.readFileSync(classifierFixture.classifierPath));
    rewritePrivateJson(classifierFixture.classifierPath, {
      ...classifierFixture.classifier,
      generatedAt: '2026-08-06T10:00:00Z',
    });
    expect(() => validateFixture(classifierFixture, {
      expectedClassifierSha256: classifierSha256,
    })).toThrow('classifier digest changed after preparation');
  });

  it('exposes the same fail-closed contract through the release-operator CLI', () => {
    const fixture = validFixture();
    const result = validateFixture(fixture);
    const bindingPath = writePrivateJson(fixture.root, 'release.json', {
      schema: 'nexus.lean-release-state.v1',
      stagingSmoke: result,
    });
    const output = execFileSync(process.execPath, [
      path.resolve('scripts/lib/staging-smoke-evidence.mjs'),
      'validate',
      '--evidence', fixture.evidencePath,
      '--classifier', fixture.classifierPath,
      '--staging-state', fixture.stagingStatePath,
      '--expect-runtime-sha', runtimeSha,
      '--expect-artifact-digest', artifactDigest,
      '--expect-classifier-base-sha', classifierBaseSha,
      '--expect-evidence-sha256', result.evidenceSha256,
      '--expect-classifier-sha256', result.classifierSha256,
      '--expect-binding', bindingPath,
    ], { encoding: 'utf8' });

    expect(JSON.parse(output)).toEqual(result);
  });
});

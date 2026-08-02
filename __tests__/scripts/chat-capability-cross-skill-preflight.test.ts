// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCrossSkillPreflightReport,
  parseCrossSkillPreflightCliOptions,
  runCrossSkillPreflightCli,
  type CrossSkillPreflightDependencies,
} from '../../src/tools/chat-capability-cross-skill-preflight';

const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const GENERATED_AT = new Date('2026-08-02T01:02:08.700Z');

function runCli(args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  delete env.NEXUS_RELEASE_SHA;
  delete env.NEXUS_RELEASE_ARTIFACT_SHA256;
  Object.assign(env, envOverrides);
  return spawnSync(process.execPath, [
    '--import',
    'tsx',
    'src/tools/chat-capability-cross-skill-preflight.ts',
    ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
}

const RUNTIME_MODULES = [
  '../../src/api/routes/chat-message-context',
  '../../src/services/chat/executor/dispatch-table',
  '../../src/services/chat/registry',
] as const;

afterEach(() => {
  for (const modulePath of RUNTIME_MODULES) vi.doUnmock(modulePath);
  vi.resetModules();
});

describe('chat capability cross-skill preflight producer', () => {
  it('emits the strict provider-free readiness contract from the live dispatch and registry surfaces', () => {
    const report = buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: GENERATED_AT,
    });

    expect(report).toEqual({
      schema: 'nexus.chat-capability-cross-skill-preflight.v1',
      generatedAt: GENERATED_AT.toISOString(),
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      executorCoverage: {
        draft_email: true,
        send_email: true,
        connections_retry_sync: true,
      },
      legacyTailCoverage: {
        connections: true,
        notifications: true,
        decision_center: true,
      },
      trainingPlanCreateOutputRefs: 'absent',
      passed: true,
    });
    expect(Object.keys(report)).toEqual([
      'schema',
      'generatedAt',
      'runtimeSha',
      'artifactDigest',
      'executorCoverage',
      'legacyTailCoverage',
      'trainingPlanCreateOutputRefs',
      'passed',
    ]);
  });

  it('fails closed when any executor, legacy tail, or outputRefs decision drifts', () => {
    const dependencies: CrossSkillPreflightDependencies = {
      hasExecutor: (action) => action !== 'send_email',
      hasLegacyTail: (domain) => domain !== 'notifications',
      trainingPlanCreateOutputRefs: () => 'present',
    };

    const report = buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: GENERATED_AT,
    }, dependencies);

    expect(report.executorCoverage.send_email).toBe(false);
    expect(report.legacyTailCoverage.notifications).toBe(false);
    expect(report.trainingPlanCreateOutputRefs).toBe('present');
    expect(report.passed).toBe(false);
  });

  it('evaluates legacy-tail and outputRefs failures independently after executor coverage passes', () => {
    const legacyTailDrift: CrossSkillPreflightDependencies = {
      hasExecutor: () => true,
      hasLegacyTail: (domain) => domain !== 'decision_center',
      trainingPlanCreateOutputRefs: () => 'absent',
    };
    const outputRefsMissing: CrossSkillPreflightDependencies = {
      hasExecutor: () => true,
      hasLegacyTail: () => true,
      trainingPlanCreateOutputRefs: () => 'missing',
    };

    const legacyReport = buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: GENERATED_AT,
    }, legacyTailDrift);
    const outputRefsReport = buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: GENERATED_AT,
    }, outputRefsMissing);

    expect(legacyReport.executorCoverage).toEqual({
      draft_email: true,
      send_email: true,
      connections_retry_sync: true,
    });
    expect(legacyReport.legacyTailCoverage.decision_center).toBe(false);
    expect(legacyReport.trainingPlanCreateOutputRefs).toBe('absent');
    expect(legacyReport.passed).toBe(false);
    expect(outputRefsReport.legacyTailCoverage).toEqual({
      connections: true,
      notifications: true,
      decision_center: true,
    });
    expect(outputRefsReport.trainingPlanCreateOutputRefs).toBe('missing');
    expect(outputRefsReport.passed).toBe(false);
  });

  it('generates a canonical timestamp when the library caller omits generatedAt', () => {
    const report = buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
    });

    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    expect(report.passed).toBe(true);
  });

  it('fails the live runtime dependency probe when executors, tails, and registry rows are absent', async () => {
    vi.resetModules();
    vi.doMock('../../src/api/routes/chat-message-context', () => ({
      getChatDomainHandler: () => undefined,
    }));
    vi.doMock('../../src/services/chat/executor/dispatch-table', () => ({
      getChatStepExecutor: () => undefined,
    }));
    vi.doMock('../../src/services/chat/registry', () => ({
      findChatActionDefinition: () => undefined,
    }));
    const runtime = await import('../../src/tools/chat-capability-cross-skill-preflight');

    const report = runtime.buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: GENERATED_AT,
    });

    expect(report.executorCoverage).toEqual({
      draft_email: false,
      send_email: false,
      connections_retry_sync: false,
    });
    expect(report.legacyTailCoverage).toEqual({
      connections: false,
      notifications: false,
      decision_center: false,
    });
    expect(report.trainingPlanCreateOutputRefs).toBe('missing');
    expect(report.passed).toBe(false);
  });

  it('detects present outputRefs through the live registry dependency after runtime handlers pass', async () => {
    vi.resetModules();
    vi.doMock('../../src/api/routes/chat-message-context', () => ({
      getChatDomainHandler: () => () => undefined,
    }));
    vi.doMock('../../src/services/chat/executor/dispatch-table', () => ({
      getChatStepExecutor: () => () => undefined,
    }));
    vi.doMock('../../src/services/chat/registry', () => ({
      findChatActionDefinition: () => ({ outputRefs: ['plan.title'] }),
    }));
    const runtime = await import('../../src/tools/chat-capability-cross-skill-preflight');

    const report = runtime.buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: GENERATED_AT,
    });

    expect(Object.values(report.executorCoverage)).toEqual([true, true, true]);
    expect(Object.values(report.legacyTailCoverage)).toEqual([true, true, true]);
    expect(report.trainingPlanCreateOutputRefs).toBe('present');
    expect(report.passed).toBe(false);
  });

  it('refuses non-exact release identity and invalid timestamps', () => {
    expect(() => buildCrossSkillPreflightReport({
      runtimeSha: 'abc123',
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: GENERATED_AT,
    })).toThrow(/runtime SHA/i);

    expect(() => buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: 'not-a-digest',
      generatedAt: GENERATED_AT,
    })).toThrow(/artifact digest/i);

    expect(() => buildCrossSkillPreflightReport({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: new Date(Number.NaN),
    })).toThrow(/generatedAt/i);
  });

  it('supports the installed-tool --json interface with JSON-only stdout', () => {
    const result = runCli([
      `--runtime-sha=${RUNTIME_SHA}`,
      `--artifact-digest=${ARTIFACT_DIGEST}`,
      `--generated-at=${GENERATED_AT.toISOString()}`,
      '--json',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'nexus.chat-capability-cross-skill-preflight.v1',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      passed: true,
    });
    expect(result.stdout.trimStart().startsWith('{')).toBe(true);
  });

  it('parses equals and split CLI values into the same exact options', () => {
    const equalsOptions = parseCrossSkillPreflightCliOptions([
      `--runtime-sha=${RUNTIME_SHA}`,
      `--artifact-digest=${ARTIFACT_DIGEST}`,
      `--generated-at=${GENERATED_AT.toISOString()}`,
      '--json',
    ]);
    const splitOptions = parseCrossSkillPreflightCliOptions([
      '--runtime-sha', RUNTIME_SHA,
      '--artifact-digest', ARTIFACT_DIGEST,
      '--generated-at', GENERATED_AT.toISOString(),
      '--json',
    ]);

    expect(equalsOptions).toEqual({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      generatedAt: GENERATED_AT,
      json: true,
    });
    expect(splitOptions).toEqual(equalsOptions);
  });

  it.each([
    {
      name: 'unknown argument',
      args: ['--unexpected'],
      error: /unknown argument: --unexpected/u,
    },
    {
      name: 'missing JSON mode',
      args: [
        `--runtime-sha=${RUNTIME_SHA}`,
        `--artifact-digest=${ARTIFACT_DIGEST}`,
        `--generated-at=${GENERATED_AT.toISOString()}`,
      ],
      error: /--json is required/u,
    },
    {
      name: 'missing generated timestamp',
      args: [
        `--runtime-sha=${RUNTIME_SHA}`,
        `--artifact-digest=${ARTIFACT_DIGEST}`,
        '--json',
      ],
      error: /--generated-at is required/u,
    },
    {
      name: 'invalid generated timestamp',
      args: [
        `--runtime-sha=${RUNTIME_SHA}`,
        `--artifact-digest=${ARTIFACT_DIGEST}`,
        '--generated-at=not-a-timestamp',
        '--json',
      ],
      error: /canonical UTC timestamp/u,
    },
    {
      name: 'noncanonical generated timestamp',
      args: [
        `--runtime-sha=${RUNTIME_SHA}`,
        `--artifact-digest=${ARTIFACT_DIGEST}`,
        '--generated-at=2026-08-02T01:02:08Z',
        '--json',
      ],
      error: /canonical UTC timestamp/u,
    },
  ])('fails parser validation for $name', ({ args, error }) => {
    expect(() => parseCrossSkillPreflightCliOptions(args)).toThrow(error);
  });

  it('runs the CLI contract in-process with matching installed release attestations', () => {
    const result = runCrossSkillPreflightCli([
      '--runtime-sha', RUNTIME_SHA,
      '--artifact-digest', ARTIFACT_DIGEST,
      '--generated-at', GENERATED_AT.toISOString(),
      '--json',
    ], {
      NEXUS_RELEASE_SHA: RUNTIME_SHA,
      NEXUS_RELEASE_ARTIFACT_SHA256: ARTIFACT_DIGEST,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      generatedAt: GENERATED_AT.toISOString(),
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      passed: true,
    });
  });

  it.each([
    {
      name: 'runtime release mismatch',
      args: [
        `--runtime-sha=${RUNTIME_SHA}`,
        `--artifact-digest=${ARTIFACT_DIGEST}`,
        `--generated-at=${GENERATED_AT.toISOString()}`,
        '--json',
      ],
      env: { NEXUS_RELEASE_SHA: 'c'.repeat(40) },
      error: /runtime-sha differs from NEXUS_RELEASE_SHA/u,
    },
    {
      name: 'artifact release mismatch',
      args: [
        `--runtime-sha=${RUNTIME_SHA}`,
        `--artifact-digest=${ARTIFACT_DIGEST}`,
        `--generated-at=${GENERATED_AT.toISOString()}`,
        '--json',
      ],
      env: { NEXUS_RELEASE_ARTIFACT_SHA256: 'd'.repeat(64) },
      error: /artifact-digest differs from NEXUS_RELEASE_ARTIFACT_SHA256/u,
    },
    {
      name: 'invalid runtime identity',
      args: [
        '--runtime-sha=abc123',
        `--artifact-digest=${ARTIFACT_DIGEST}`,
        `--generated-at=${GENERATED_AT.toISOString()}`,
        '--json',
      ],
      env: {},
      error: /runtime SHA must be a full lowercase 40-hex value/u,
    },
  ])('returns a JSON-free CLI failure for $name', ({ args, env, error }) => {
    const result = runCrossSkillPreflightCli(args, env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(error);
  });

  it('preserves a failed readiness report on stdout while returning exit 1', () => {
    const missingExecutor: CrossSkillPreflightDependencies = {
      hasExecutor: () => false,
      hasLegacyTail: () => true,
      trainingPlanCreateOutputRefs: () => 'absent',
    };

    const result = runCrossSkillPreflightCli([
      `--runtime-sha=${RUNTIME_SHA}`,
      `--artifact-digest=${ARTIFACT_DIGEST}`,
      `--generated-at=${GENERATED_AT.toISOString()}`,
      '--json',
    ], {}, missingExecutor);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      executorCoverage: {
        draft_email: false,
        send_email: false,
        connections_retry_sync: false,
      },
      passed: false,
    });
  });
});

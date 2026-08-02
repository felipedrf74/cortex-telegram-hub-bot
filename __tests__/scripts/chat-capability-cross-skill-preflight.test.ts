// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import {
  buildCrossSkillPreflightReport,
  type CrossSkillPreflightDependencies,
} from '../../src/tools/chat-capability-cross-skill-preflight';

const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const GENERATED_AT = new Date('2026-08-02T01:02:08.700Z');

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
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'src/tools/chat-capability-cross-skill-preflight.ts',
      `--runtime-sha=${RUNTIME_SHA}`,
      `--artifact-digest=${ARTIFACT_DIGEST}`,
      `--generated-at=${GENERATED_AT.toISOString()}`,
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
    });

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
});

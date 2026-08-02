// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildShadowRouteHookPlan,
  buildShadowRouteHookReceipt,
} from '../../scripts/lib/chat-capability-flag-transaction.mjs';

const repoRoot = path.resolve(__dirname, '../..');
const candidateSince = '2026-07-31T12:00:00.000Z';
const candidateDivergenceVersion = 'routing_divergence_shadow@4.0.0';
const candidateResolverVersion = 'manifest-intent-resolver@1.0.0';
const candidateRuntimeSha = 'a'.repeat(40);
const candidateArtifactDigest = 'b'.repeat(64);
const candidateRole = 'staging';
const dedicatedTenantId = 42;
const receiptCompletedAt = '2026-07-31T11:59:59.000Z';
/** Every manifest-routing surface still answering with legacy logic. */
const flagsAllOff = Object.freeze({
  classifierKeyword: false,
  orchestratorPrimary: false,
  registrySubset: false,
  shadowRoute: false,
  masterKill: false,
});
let tempDir: string;
let dbPath: string;
let shadowHookReceiptPath: string;
let liveHealthPath: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'routing-divergence-report-'));
  dbPath = path.join(tempDir, 'telemetry.db');
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE chat_v2_replay_bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      replay_bundle_id TEXT NOT NULL,
      redacted_bundle_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  shadowHookReceiptPath = path.join(tempDir, 'shadow-hook-receipt.json');
  liveHealthPath = path.join(tempDir, 'live-health.json');
  const dotenvSource = [
    `CHAT_EVAL_DEDICATED_TENANT_ID=${dedicatedTenantId}`,
    `CLASSIFY_SHADOW_HASH_SECRET=${'classifier-secret-'.repeat(3)}`,
    `CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET=${'route-secret-'.repeat(4)}`,
    'AI_ROUTING_MANIFEST_CLASSIFIER=false',
    'AI_ROUTING_MANIFEST_ORCHESTRATOR=false',
    'AI_ROUTING_MANIFEST_SHADOW=false',
    'AI_ROUTING_MANIFEST_REGISTRY=false',
    'AI_ROUTING_CLARIFY=false',
    'AI_CLASSIFY_MANIFEST_PROMPT=false',
    'AI_CROSS_SKILL_EXECUTION=false',
    'AI_ROUTING_MANIFEST_KILL=false',
    '',
  ].join('\n');
  const plan = buildShadowRouteHookPlan({
    role: candidateRole,
    runtimeSha: candidateRuntimeSha,
    artifactDigest: candidateArtifactDigest,
    dotenvSource,
    dedicatedIdentityAttested: true,
    desiredValue: true,
    transitionReason: 'dedicated_eval_evidence_collection',
    previousPlanSequence: 7,
    generatedAt: '2026-07-31T11:58:00.000Z',
  });
  const receipt = buildShadowRouteHookReceipt({
    plan,
    transactionId: '20260731T115900Z-abcdef123456',
    startedAt: '2026-07-31T11:59:00.000Z',
    completedAt: receiptCompletedAt,
    status: 'passed',
    health: { backend: 'passed', identity: 'passed', shadowHook: 'passed' },
    rollback: { status: 'not_required' },
  });
  writeFileSync(shadowHookReceiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  writeFileSync(liveHealthPath, `${JSON.stringify({
    status: 'healthy',
    database: 'connected',
    timestamp: '2026-07-31T12:10:00.000Z',
    releaseAttestation: {
      schema: 'nexus.chat-capability-release-attestation.v2',
      runtimeSha: candidateRuntimeSha,
      artifactDigest: candidateArtifactDigest,
      role: candidateRole,
      capabilityRuntimeGuard: {
        status: 'clear', reason: 'no_unresolved_transaction', transactionId: null, planDigest: null,
      },
      shadowPlannerEffective: {
        global: false,
        user1000014: false,
        tenant1000014: false,
        user1000016: false,
        tenant1000016: false,
        dedicatedEval: { present: true, user: false, tenant: false },
      },
      shadowRouteHookEffective: {
        global: false,
        dedicatedEval: { present: true, user: true, tenant: true },
      },
    },
  })}\n`, { mode: 0o600 });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedDivergence(input: {
  skill: string;
  domain: string;
  agreement: Record<string, boolean | null>;
  createdAt?: string;
  divergenceVersion?: string;
  resolverVersion?: string;
  runtimeSha?: string;
  artifactDigest?: string;
  role?: string;
  releaseIdentityExtra?: Record<string, unknown>;
  capabilityFlags?: Record<string, unknown>;
  omitCapabilityFlags?: boolean;
  recorderState?: Record<string, unknown>;
  omitRecorderState?: boolean;
}): void {
  const sequence = db.prepare('SELECT COUNT(*) AS count FROM chat_v2_replay_bundles').get() as {
    count: number;
  };
  db.prepare(`
    INSERT INTO chat_v2_replay_bundles (
      replay_bundle_id, redacted_bundle_json, created_at
    ) VALUES (?, ?, ?)
  `).run(
    `chatv2-shadow-replay:${sequence.count + 1}`,
    JSON.stringify({
      contextPack: {
        routingDivergence: {
          divergenceVersion: input.divergenceVersion ?? candidateDivergenceVersion,
          resolverVersion: input.resolverVersion ?? candidateResolverVersion,
          releaseIdentity: {
            runtimeSha: input.runtimeSha ?? candidateRuntimeSha,
            artifactDigest: input.artifactDigest ?? candidateArtifactDigest,
            role: input.role ?? candidateRole,
            ...input.releaseIdentityExtra,
          },
          capabilityFlags: input.omitCapabilityFlags
            ? undefined
            : { ...flagsAllOff, ...input.capabilityFlags },
          recorderState: input.omitRecorderState
            ? undefined
            : {
              userId: String(dedicatedTenantId),
              tenantId: String(dedicatedTenantId),
              shadowRouteHookEffective: true,
              shadowPlannerEffective: false,
              ...input.recorderState,
            },
          topCandidate: {
            capabilityId: input.domain,
            skill: input.skill,
            domain: input.domain,
            rawScore: 2,
            matchedEvidenceCount: 1,
          },
          candidateCount: 1,
          surfaces: {
            classifierKeywordDomain: 'secretary',
            orchestratorPrimaryDomain: 'secretary',
            registryActionSkills: ['secretary.tasks'],
            shadowRouteIntent: 'create_action',
            shadowRouteDomains: ['secretary'],
          },
          agreement: input.agreement,
        },
      },
    }),
    input.createdAt ?? `2026-07-31T12:00:${String(sequence.count).padStart(2, '0')}.000Z`,
  );
}

function runReportRaw(...args: string[]) {
  return spawnSync(process.execPath, [
    'scripts/routing-divergence-report.mjs',
    '--db', dbPath,
    ...args,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function runReport(...args: string[]) {
  return runReportRaw('--json', ...args);
}

function candidateGateArgs(): string[] {
  return [
    '--gate',
    '--surface', 'classifierKeyword',
    '--since', candidateSince,
    '--divergence-version', candidateDivergenceVersion,
    '--resolver-version', candidateResolverVersion,
    '--runtime-sha', candidateRuntimeSha,
    '--artifact-digest', candidateArtifactDigest,
    '--environment', candidateRole,
    '--minimum-comparisons', '1',
    '--shadow-hook-receipt', shadowHookReceiptPath,
    '--live-health', liveHealthPath,
  ];
}

describe('routing-divergence-report gate', () => {
  it('reports aggregate agreement totals for every surface without replacing per-skill output', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
    });
    seedDivergence({
      skill: 'draft_email',
      domain: 'secretary',
      agreement: {
        classifierKeyword: false,
        orchestratorPrimary: true,
        registrySubset: false,
        shadowRoute: null,
      },
    });

    const result = runReport();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.surfaceTotals).toEqual({
      classifierKeyword: { compared: 2, agreed: 1, agreementRate: 0.5 },
      orchestratorPrimary: { compared: 2, agreed: 2, agreementRate: 1 },
      registrySubset: { compared: 2, agreed: 1, agreementRate: 0.5 },
      shadowRoute: { compared: 1, agreed: 1, agreementRate: 1 },
    });
    expect(report.agreement.classifierKeyword).toMatchObject({
      create_task: { compared: 1, agreed: 1, agreementRate: 1 },
      draft_email: { compared: 1, agreed: 0, agreementRate: 0 },
    });
  });

  it('gates only the explicitly selected surface and maps it to its capability flag', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: false,
        shadowRoute: false,
      },
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.surfaceFlags).toEqual({
      classifierKeyword: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      orchestratorPrimary: 'AI_ROUTING_MANIFEST_ORCHESTRATOR',
      registrySubset: 'AI_ROUTING_MANIFEST_REGISTRY',
      shadowRoute: 'AI_ROUTING_MANIFEST_SHADOW',
    });
    expect(report.gate).toMatchObject({
      enabled: true,
      selectedSurface: 'classifierKeyword',
      capabilityFlag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      minimumComparisons: 1,
      minimumAgreementRate: 0.99,
      passed: true,
      failures: [],
    });
    expect(report.evidence.shadowRecorderBinding).toEqual({
      enforced: true,
      receipt: {
        schema: 'nexus.chat-shadow-route-hook-transaction.v1',
        sha256: createHash('sha256').update(readFileSync(shadowHookReceiptPath)).digest('hex'),
        transactionId: '20260731T115900Z-abcdef123456',
        planDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        planSequence: 8,
        completedAt: receiptCompletedAt,
        runtimeSha: candidateRuntimeSha,
        artifactDigest: candidateArtifactDigest,
        role: candidateRole,
        status: 'passed',
        action: 'enable',
        dedicatedTenantId,
      },
      requiredState: {
        shadowRouteHookEffective: true,
        shadowPlannerEffective: false,
      },
      liveHealth: {
        sha256: createHash('sha256').update(readFileSync(liveHealthPath)).digest('hex'),
        checkedAt: '2026-07-31T12:10:00.000Z',
        shadowRouteHookGlobal: false,
        shadowRouteHookDedicatedUser: true,
        shadowRouteHookDedicatedTenant: true,
        shadowPlannerGlobal: false,
        shadowPlannerDedicatedUser: false,
        shadowPlannerDedicatedTenant: false,
      },
      counts: {
        exactRecorderStateBundles: 1,
        missingRecorderStateBundles: 0,
        dedicatedScopeMismatchBundles: 0,
        hookNotEffectiveBundles: 0,
        plannerEffectiveBundles: 0,
      },
    });
  });

  it('requires exact server receipt and live-health bindings and anchors since after enable completion', () => {
    const missing = candidateGateArgs().filter((value, index, values) => (
      value !== '--shadow-hook-receipt'
      && values[index - 1] !== '--shadow-hook-receipt'
      && value !== '--live-health'
      && values[index - 1] !== '--live-health'
    ));
    const missingResult = runReport(...missing);
    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain('--shadow-hook-receipt');
    expect(missingResult.stderr).toContain('--live-health');

    const beforeReceipt = runReport(
      ...candidateGateArgs().flatMap((value, index, values) =>
        index > 0 && values[index - 1] === '--since'
          ? ['2026-07-31T11:59:58.999Z']
          : [value]),
    );
    expect(beforeReceipt.status).toBe(1);
    expect(beforeReceipt.stderr).toContain('--since must be at or after shadow hook receipt completedAt');

    writeFileSync(shadowHookReceiptPath, '{}\n');
    const malformedReceipt = runReport(...candidateGateArgs());
    expect(malformedReceipt.status).toBe(1);
    expect(malformedReceipt.stderr).toMatch(/shadow hook receipt.*invalid|receipt.*field/i);
  });

  it('refuses live health unless the exact release has the dedicated hook on and planner off', () => {
    const health = JSON.parse(readFileSync(liveHealthPath, 'utf8'));
    health.releaseAttestation.shadowRouteHookEffective.dedicatedEval.tenant = false;
    writeFileSync(liveHealthPath, `${JSON.stringify(health)}\n`);

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'live health does not attest the exact healthy dedicated recorder state',
    );
    expect(result.stdout).toBe('');

    health.releaseAttestation.shadowRouteHookEffective.dedicatedEval.tenant = true;
    health.releaseAttestation.capabilityRuntimeGuard.transactionId = 'pending-shadow-transaction';
    writeFileSync(liveHealthPath, `${JSON.stringify(health)}\n`);
    const pendingGuard = runReport(...candidateGateArgs());
    expect(pendingGuard.status).toBe(1);
    expect(pendingGuard.stderr).toContain(
      'live health does not attest the exact healthy dedicated recorder state',
    );
  });

  it('fails the gate for malformed JSON or a shadow row without divergence telemetry', () => {
    db.prepare(`
      INSERT INTO chat_v2_replay_bundles (
        replay_bundle_id, redacted_bundle_json, created_at
      ) VALUES (?, ?, ?)
    `).run(
      'chatv2-shadow-replay:malformed-json',
      '{not-json',
      candidateSince,
    );
    db.prepare(`
      INSERT INTO chat_v2_replay_bundles (
        replay_bundle_id, redacted_bundle_json, created_at
      ) VALUES (?, ?, ?)
    `).run(
      'chatv2-shadow-replay:missing-divergence',
      JSON.stringify({ contextPack: {} }),
      '2026-07-31T12:00:01.000Z',
    );

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.failures).toEqual(expect.arrayContaining([
      { scope: 'evidence', reason: 'malformed_bundle_json', bundles: 1 },
      { scope: 'evidence', reason: 'missing_divergence_telemetry', bundles: 1 },
    ]));
  });

  it('rejects every malformed, mixed-scope, hook-off, or planner-on row in the anchored gate window', () => {
    const agreement = {
      classifierKeyword: true,
      orchestratorPrimary: true,
      registrySubset: true,
      shadowRoute: true,
    };
    seedDivergence({ skill: 'exact', domain: 'secretary', agreement });
    seedDivergence({
      skill: 'missing', domain: 'secretary', agreement, omitRecorderState: true,
    });
    seedDivergence({
      skill: 'foreign', domain: 'secretary', agreement, recorderState: { tenantId: '43' },
    });
    seedDivergence({
      skill: 'hook_off', domain: 'secretary', agreement,
      recorderState: { shadowRouteHookEffective: false },
    });
    seedDivergence({
      skill: 'planner_on', domain: 'secretary', agreement,
      recorderState: { shadowPlannerEffective: true },
    });
    seedDivergence({
      skill: 'extra', domain: 'secretary', agreement,
      recorderState: { unsafeExtra: 'private-text' },
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.passed).toBe(false);
    expect(report.evidence.shadowRecorderBinding.counts).toEqual({
      exactRecorderStateBundles: 1,
      missingRecorderStateBundles: 2,
      dedicatedScopeMismatchBundles: 1,
      hookNotEffectiveBundles: 1,
      plannerEffectiveBundles: 1,
    });
    expect(report.gate.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'missing_or_malformed_recorder_state', bundles: 2 }),
      expect.objectContaining({ reason: 'dedicated_scope_mismatch', bundles: 1 }),
      expect.objectContaining({ reason: 'shadow_route_hook_not_effective', bundles: 1 }),
      expect.objectContaining({ reason: 'shadow_planner_effective', bundles: 1 }),
    ]));
    expect(report.surfaceTotals.classifierKeyword.compared).toBe(1);
  });

  it('fails --gate when the selected surface has fewer than the explicit minimum comparisons', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
    });
    const result = runReport(
      ...candidateGateArgs().flatMap((value, index, values) =>
        index > 0 && values[index - 1] === '--minimum-comparisons' ? ['2'] : [value]),
    );
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.failures).toContainEqual({
      surface: 'classifierKeyword',
      reason: 'insufficient_comparisons',
      minimumComparisons: 2,
      compared: 1,
      agreed: 1,
      agreementRate: 1,
    });
  });

  it('fails --gate when the selected surface agreement is below 99 percent', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: {
        classifierKeyword: false,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.failures).toContainEqual({
      surface: 'classifierKeyword',
      reason: 'agreement_below_threshold',
      compared: 1,
      agreed: 0,
      agreementRate: 0,
    });
  });

  it('fails closed when a gate omits or supplies invalid candidate evidence identity', () => {
    const missing = runReport('--gate');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      '--gate requires explicit --surface, --since, --divergence-version, --resolver-version, '
      + '--runtime-sha, --artifact-digest, --environment, --minimum-comparisons, '
      + '--shadow-hook-receipt, and --live-health',
    );

    const invalidTimestamp = runReport(
      '--gate',
      '--surface', 'classifierKeyword',
      '--since', '2026-07-31T12:00:00Z',
      '--divergence-version', candidateDivergenceVersion,
      '--resolver-version', candidateResolverVersion,
      '--runtime-sha', candidateRuntimeSha,
      '--artifact-digest', candidateArtifactDigest,
      '--environment', candidateRole,
      '--minimum-comparisons', '1',
      '--shadow-hook-receipt', shadowHookReceiptPath,
      '--live-health', liveHealthPath,
    );
    expect(invalidTimestamp.status).toBe(1);
    expect(invalidTimestamp.stderr).toContain(
      '--since must be a canonical UTC ISO timestamp with milliseconds',
    );

    const invalidVersion = runReport(
      '--gate',
      '--surface', 'classifierKeyword',
      '--since', candidateSince,
      '--divergence-version', 'routing divergence latest',
      '--resolver-version', candidateResolverVersion,
      '--runtime-sha', candidateRuntimeSha,
      '--artifact-digest', candidateArtifactDigest,
      '--environment', candidateRole,
      '--minimum-comparisons', '1',
      '--shadow-hook-receipt', shadowHookReceiptPath,
      '--live-health', liveHealthPath,
    );
    expect(invalidVersion.status).toBe(1);
    expect(invalidVersion.stderr).toContain('--divergence-version must be an exact telemetry identifier');

    const invalidSurface = runReport(
      ...candidateGateArgs().flatMap((value, index, values) =>
        index > 0 && values[index - 1] === '--surface' ? ['not-a-surface'] : [value]),
    );
    expect(invalidSurface.status).toBe(1);
    expect(invalidSurface.stderr).toContain('--surface must be one of');

    const shortSha = runReport(
      ...candidateGateArgs().flatMap((value, index, values) =>
        index > 0 && values[index - 1] === '--runtime-sha' ? ['abc123'] : [value]),
    );
    expect(shortSha.status).toBe(1);
    expect(shortSha.stderr).toContain('--runtime-sha must be a full lowercase 40-hex SHA');

    const production = runReport(
      ...candidateGateArgs().flatMap((value, index, values) =>
        index > 0 && values[index - 1] === '--environment' ? ['production'] : [value]),
    );
    expect(production.status).toBe(1);
    expect(production.stderr).toContain('--gate evidence must come from the staging environment');

    const zeroMinimum = runReport(
      ...candidateGateArgs().flatMap((value, index, values) =>
        index > 0 && values[index - 1] === '--minimum-comparisons' ? ['0'] : [value]),
    );
    expect(zeroMinimum.status).toBe(1);
    expect(zeroMinimum.stderr).toContain('--minimum-comparisons must be a positive integer');
  });

  it('binds gate evidence to the exact window and versions across mixed old and new telemetry', () => {
    const agreement = {
      classifierKeyword: true,
      orchestratorPrimary: true,
      registrySubset: true,
      shadowRoute: true,
    };
    seedDivergence({
      skill: 'old_matching_row',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T11:59:59.999Z',
    });
    seedDivergence({
      skill: 'wrong_divergence_version',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T12:01:00.000Z',
      divergenceVersion: 'routing_divergence_shadow@0.9.0',
    });
    seedDivergence({
      skill: 'wrong_resolver_version',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T12:02:00.000Z',
      resolverVersion: 'manifest-intent-resolver@0.9.0',
    });
    seedDivergence({
      skill: 'wrong_runtime_sha',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T12:02:30.000Z',
      runtimeSha: 'c'.repeat(40),
    });
    seedDivergence({
      skill: 'wrong_artifact_digest',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T12:02:40.000Z',
      artifactDigest: 'd'.repeat(64),
    });
    seedDivergence({
      skill: 'wrong_environment',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T12:02:50.000Z',
      role: 'production',
    });
    seedDivergence({
      skill: 'non_allowlisted_release_identity',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T12:02:55.000Z',
      releaseIdentityExtra: { deploymentLabel: 'must-not-count' },
    });
    seedDivergence({
      skill: 'candidate_matching_row',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T12:03:00.000Z',
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.failures).toEqual(expect.arrayContaining([
      { scope: 'evidence', reason: 'mixed_evidence_identity', bundles: 6 },
      {
        scope: 'shadow_recorder',
        reason: 'recorder_state_count_does_not_match_eligible_bundles',
        exactRecorderStateBundles: 7,
        eligibleBundles: 1,
      },
    ]));

    expect(report.evidence).toMatchObject({
      identity: {
        divergenceVersion: candidateDivergenceVersion,
        resolverVersion: candidateResolverVersion,
        releaseIdentity: {
          runtimeSha: candidateRuntimeSha,
          artifactDigest: candidateArtifactDigest,
          role: candidateRole,
        },
      },
      window: {
        sinceInclusive: candidateSince,
      },
      counts: {
        shadowBundlesInWindow: 7,
        divergenceTelemetryBundles: 7,
        identityMatchedBundles: 1,
        identityMismatchBundles: 6,
        divergenceVersionMismatchBundles: 1,
        resolverVersionMismatchBundles: 1,
        runtimeShaMismatchBundles: 1,
        artifactDigestMismatchBundles: 1,
        environmentMismatchBundles: 1,
        releaseIdentityShapeMismatchBundles: 1,
      },
      runtimeArtifactBinding: {
        available: true,
      },
    });
    expect(report.evidence.window.throughInclusive).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(report.totalShadowBundles).toBe(7);
    expect(report.surfaceTotals).toEqual({
      classifierKeyword: { compared: 1, agreed: 1, agreementRate: 1 },
      orchestratorPrimary: { compared: 1, agreed: 1, agreementRate: 1 },
      registrySubset: { compared: 1, agreed: 1, agreementRate: 1 },
      shadowRoute: { compared: 1, agreed: 1, agreementRate: 1 },
    });
    expect(report.agreement.classifierKeyword).toEqual({
      candidate_matching_row: { compared: 1, agreed: 1, agreementRate: 1 },
    });
  });

  it('normalizes SQLite-default created_at values when applying the candidate window', () => {
    seedDivergence({
      skill: 'sqlite_default_timestamp_row',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
      createdAt: '2026-07-31 12:04:00',
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.evidence.counts).toMatchObject({
      shadowBundlesInWindow: 1,
      identityMatchedBundles: 1,
    });
    expect(report.surfaceTotals.classifierKeyword).toEqual({
      compared: 1,
      agreed: 1,
      agreementRate: 1,
    });
  });

  it('refuses evidence collected while the selected surface already consumed the manifest', () => {
    // A surface running on the manifest resolver is scored against itself, so a
    // perfect agreement rate here is circular rather than evidence.
    for (let index = 0; index < 3; index += 1) {
      seedDivergence({
        skill: 'create_task',
        domain: 'secretary',
        agreement: {
          classifierKeyword: true,
          orchestratorPrimary: true,
          registrySubset: true,
          shadowRoute: true,
        },
        capabilityFlags: { classifierKeyword: true },
      });
    }

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures).toContainEqual({
      scope: 'capability_flags',
      reason: 'selected_surface_flag_already_enabled',
      surface: 'classifierKeyword',
      capabilityFlag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      bundles: 3,
    });
    expect(report.surfaceTotals.classifierKeyword).toEqual({
      compared: 0,
      agreed: 0,
      agreementRate: null,
    });
    expect(report.evidence.capabilityFlagBinding).toMatchObject({
      enforced: true,
      selectedSurface: 'classifierKeyword',
      selectedSurfaceFlag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      counts: {
        knownFlagStateBundles: 3,
        unknownFlagStateBundles: 0,
        selectedSurfaceFlagOnBundles: 3,
        flagEligibleBundles: 0,
        flagIneligibleBundles: 3,
      },
    });
  });

  it('records the observed capability-flag state and still gates on the selected surface alone', () => {
    // Section 7.1 allows previously authorized flags to stay ON while the next
    // surface in the order is measured.
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
      capabilityFlags: { orchestratorPrimary: true },
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.gate.passed).toBe(true);
    expect(report.evidence.capabilityFlagBinding.observedStates).toEqual([
      {
        state: 'classifierKeyword=off,orchestratorPrimary=on,registrySubset=off,'
          + 'shadowRoute=off,masterKill=off',
        bundles: 1,
      },
    ]);
    expect(report.evidence.capabilityFlagBinding.counts).toMatchObject({
      knownFlagStateBundles: 1,
      selectedSurfaceFlagOnBundles: 0,
      masterKillEngagedBundles: 0,
      flagEligibleBundles: 1,
    });
  });

  it('refuses evidence whose capability-flag state was never recorded', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
      omitCapabilityFlags: true,
    });
    seedDivergence({
      skill: 'partial_flag_state',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
      capabilityFlags: { masterKill: undefined },
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures).toContainEqual({
      scope: 'capability_flags',
      reason: 'unknown_capability_flag_state',
      bundles: 2,
    });
    expect(report.evidence.capabilityFlagBinding.counts).toMatchObject({
      knownFlagStateBundles: 0,
      unknownFlagStateBundles: 2,
      flagEligibleBundles: 0,
    });
  });

  it('refuses flag-off evidence manufactured with the manifest master kill', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
      capabilityFlags: { masterKill: true },
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.failures).toContainEqual({
      scope: 'capability_flags',
      reason: 'master_kill_engaged',
      capabilityFlag: 'AI_ROUTING_MANIFEST_KILL',
      bundles: 1,
    });
  });

  it('treats zero eligible comparisons as a gate failure rather than an empty pass', () => {
    const result = runReport(...candidateGateArgs());

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures).toContainEqual({
      scope: 'evidence',
      reason: 'zero_identity_matched_bundles',
      matchedBundles: 0,
    });
    expect(report.gate.failures).toContainEqual({
      surface: 'classifierKeyword',
      reason: 'insufficient_comparisons',
      minimumComparisons: 1,
      compared: 0,
      agreed: 0,
      agreementRate: null,
    });
  });

  it('reports zero identity-matched bundles when every bundle belongs to another candidate', () => {
    seedDivergence({
      skill: 'other_candidate_row',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
      runtimeSha: 'c'.repeat(40),
    });

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.evidence.counts).toMatchObject({
      shadowBundlesInWindow: 1,
      identityMatchedBundles: 0,
      identityMismatchBundles: 1,
    });
    expect(report.gate.failures).toContainEqual({
      scope: 'evidence',
      reason: 'zero_identity_matched_bundles',
      matchedBundles: 0,
    });
  });

  it('applies the release-identity filter it advertises without the telemetry version pair', () => {
    const agreement = {
      classifierKeyword: true,
      orchestratorPrimary: true,
      registrySubset: true,
      shadowRoute: true,
    };
    seedDivergence({ skill: 'candidate_row', domain: 'secretary', agreement });
    seedDivergence({
      skill: 'other_candidate_row',
      domain: 'secretary',
      agreement,
      runtimeSha: 'c'.repeat(40),
    });

    const result = runReport(
      '--runtime-sha', candidateRuntimeSha,
      '--artifact-digest', candidateArtifactDigest,
      '--environment', candidateRole,
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.evidence.identity).toMatchObject({
      divergenceVersion: null,
      resolverVersion: null,
      enforced: true,
      enforcedFields: ['runtimeSha', 'artifactDigest', 'role'],
    });
    expect(report.evidence.counts).toMatchObject({
      identityMatchedBundles: 1,
      identityMismatchBundles: 1,
      runtimeShaMismatchBundles: 1,
    });
    expect(report.agreement.classifierKeyword).toEqual({
      candidate_row: { compared: 1, agreed: 1, agreementRate: 1 },
    });
  });

  it('states plainly when no identity binding was requested at all', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: { classifierKeyword: true, orchestratorPrimary: null, registrySubset: null, shadowRoute: null },
    });

    const report = JSON.parse(runReport().stdout);
    expect(report.evidence.identity).toMatchObject({
      releaseIdentity: null,
      enforced: false,
      enforcedFields: [],
    });
    expect(report.evidence.runtimeArtifactBinding).toEqual({ available: false, enforced: false });
  });

  it('evaluates the operator-pinned upper bound instead of silently widening the window', () => {
    const agreement = {
      classifierKeyword: true,
      orchestratorPrimary: true,
      registrySubset: true,
      shadowRoute: true,
    };
    seedDivergence({
      skill: 'inside_window_row',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T12:30:00.000Z',
    });
    seedDivergence({
      skill: 'after_window_row',
      domain: 'secretary',
      agreement,
      createdAt: '2026-07-31T13:30:00.000Z',
    });

    const until = '2026-07-31T13:00:00.000Z';
    const result = runReport(...candidateGateArgs(), '--until', until);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.evidence.window).toMatchObject({
      sinceInclusive: candidateSince,
      throughInclusive: until,
      untilInclusive: until,
      upperBoundSource: 'until_flag',
    });
    expect(report.evidence.counts.shadowBundlesInWindow).toBe(1);
    expect(report.agreement.classifierKeyword).toEqual({
      inside_window_row: { compared: 1, agreed: 1, agreementRate: 1 },
    });
  });

  it('records report-generation time as the upper bound when none is pinned', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: { classifierKeyword: true, orchestratorPrimary: null, registrySubset: null, shadowRoute: null },
    });

    const report = JSON.parse(runReport().stdout);
    expect(report.evidence.window).toMatchObject({
      untilInclusive: null,
      upperBoundSource: 'report_generation_time',
    });
    expect(report.evidence.window.throughInclusive).toBe(report.generatedAt);
  });

  it('rejects an upper bound that is not canonical or precedes the start of the window', () => {
    const notCanonical = runReport(...candidateGateArgs(), '--until', '2026-07-31T13:00:00Z');
    expect(notCanonical.status).toBe(1);
    expect(notCanonical.stderr).toContain(
      '--until must be a canonical UTC ISO timestamp with milliseconds',
    );

    const inverted = runReport(...candidateGateArgs(), '--until', '2026-07-31T11:00:00.000Z');
    expect(inverted.status).toBe(1);
    expect(inverted.stderr).toContain('--until must not be earlier than --since');
  });

  it('refuses to write a gate receipt as human-readable text', () => {
    const result = runReportRaw(...candidateGateArgs());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--gate requires --json so the saved receipt is machine-readable');
    expect(result.stdout).toBe('');
  });

  it('refuses a nominally clear runtime guard that still names a transaction', () => {
    seedDivergence({
      skill: 'create_task',
      domain: 'secretary',
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
    });
    const health = JSON.parse(readFileSync(liveHealthPath, 'utf8'));
    health.releaseAttestation.capabilityRuntimeGuard.transactionId =
      '20260731T115900Z-abcdef123456';
    health.releaseAttestation.capabilityRuntimeGuard.planDigest = `sha256:${'a'.repeat(64)}`;
    writeFileSync(liveHealthPath, `${JSON.stringify(health)}\n`);

    const result = runReport(...candidateGateArgs());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'live health does not attest the exact healthy dedicated recorder state',
    );
    expect(result.stdout).toBe('');
  });
});

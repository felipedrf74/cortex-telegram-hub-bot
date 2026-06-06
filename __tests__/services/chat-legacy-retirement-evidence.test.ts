// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateRecordedChatV2LegacyRetirementReadiness,
  loadChatV2LegacyRetirementReadinessInput,
  recordChatV2LegacyFallbackRateEvidence,
  recordChatV2LegacyRouteExitEvidence,
  recordChatV2LegacyVerifyRunEvidence,
} from '../../src/services/chat-legacy-retirement-evidence';

let testDb: Database.Database;
const PEER_REVIEW_SIGNOFF_HASH = 'c'.repeat(64);

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

describe('chat-legacy-retirement-evidence', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/160_chatv2_legacy_retirement_evidence.sql'), 'utf8'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CHAT_V2_EVIDENCE_HMAC_SECRET', 'test-legacy-retirement-evidence-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb.close();
  });

  it('stays dark by default when legacy evidence is disabled', () => {
    recordChatV2LegacyRouteExitEvidence(routeEvidence({ routeId: 'domain-handler' }));

    expect(rowCount()).toBe(0);
  });

  it('records HMAC-only route retirement evidence when enabled', () => {
    vi.stubEnv('CHAT_V2_LEGACY_RETIREMENT_EVIDENCE_ENABLED', 'true');

    recordChatV2LegacyRouteExitEvidence(routeEvidence({
      routeId: 'domain-handler',
      safeMetadata: {
        plannedReplacement: 'chatv2-domain-adapter',
      },
    }));

    const row = testDb.prepare('SELECT * FROM chat_v2_legacy_retirement_evidence').get() as any;
    expect(row.evidence_source).toBe('runtime_route');
    expect(row.evidence_kind).toBe('route_exit');
    expect(row.sample_hmac).toMatch(/^hmac:legacy-route:[a-f0-9]{64}$/);
    expect(row.sample_identifier_kind).toBe('hmac');
    expect(row.route_id).toBe('domain-handler');
    expect(row.raw_field_audit_count).toBe(0);
  });

  it('excludes local sandbox seed rows from readiness unless explicitly requested', () => {
    vi.stubEnv('CHAT_V2_LEGACY_RETIREMENT_EVIDENCE_ENABLED', 'true');

    recordChatV2LegacyRouteExitEvidence(routeEvidence({ evidenceSource: 'local_sandbox_seed' }));
    recordChatV2LegacyFallbackRateEvidence({
      evidenceSource: 'local_sandbox_seed',
      requestId: 'req-rate',
      legacyFallbackRate24h: 0.01,
    });
    recordChatV2LegacyVerifyRunEvidence({
      evidenceSource: 'local_sandbox_seed',
      requestId: 'req-verify',
      fullVerifyClean: true,
    });

    expect(loadChatV2LegacyRetirementReadinessInput().routeSamples).toEqual([]);
    expect(loadChatV2LegacyRetirementReadinessInput(10, ['local_sandbox_seed']).routeSamples).toHaveLength(1);
  });

  it('evaluates local legacy retirement readiness when parity/fallback/verify gates pass', () => {
    vi.stubEnv('CHAT_V2_LEGACY_RETIREMENT_EVIDENCE_ENABLED', 'true');

    for (const routeId of ['domain-handler', 'legacy-classifier']) {
      recordChatV2LegacyRouteExitEvidence(routeEvidence({
        evidenceSource: 'local_sandbox_seed',
        routeId,
        shadowParityRate: 0.97,
        sampleCount: 55,
      }));
    }
    recordChatV2LegacyFallbackRateEvidence({
      evidenceSource: 'local_sandbox_seed',
      requestId: 'req-rate',
      legacyFallbackRate24h: 0.01,
    });
    recordChatV2LegacyVerifyRunEvidence({
      evidenceSource: 'local_sandbox_seed',
      requestId: 'req-verify',
      fullVerifyClean: true,
    });

    const result = evaluateRecordedChatV2LegacyRetirementReadiness(10, ['local_sandbox_seed']);
    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['route_exit_replacements', true],
      ['route_shadow_parity', true],
      ['route_independent_peer_review', true],
      ['route_safety_regressions', true],
      ['route_quality_regressions', true],
      ['route_degraded_not_comparable', true],
      ['legacy_fallback_rate', true],
      ['full_verify_clean', true],
    ]);
  });

  it('does not let newer inventory-only rows mask imported parity evidence', () => {
    vi.stubEnv('CHAT_V2_LEGACY_RETIREMENT_EVIDENCE_ENABLED', 'true');

    recordChatV2LegacyRouteExitEvidence(routeEvidence({
      routeId: 'domain-handler',
      shadowParityRate: 0.98,
      sampleCount: 60,
      safeMetadata: {
        parityObservationImport: true,
        evaluator: 'claude',
        peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
        safetyRegressionCount: 0,
        qualityRegressionCount: 0,
        degradedNotComparableCount: 0,
      },
    }));
    recordChatV2LegacyRouteExitEvidence(routeEvidence({
      requestId: 'req-inventory',
      routeId: 'domain-handler',
      replaced: false,
      tested: false,
      shadowParityRate: 0,
      sampleCount: 0,
      safeMetadata: {
        status: 'inventory_only_not_retired',
      },
    }));
    recordChatV2LegacyFallbackRateEvidence({
      requestId: 'req-rate',
      legacyFallbackRate24h: 0.01,
    });
    recordChatV2LegacyVerifyRunEvidence({
      requestId: 'req-verify',
      fullVerifyClean: true,
    });

    const input = loadChatV2LegacyRetirementReadinessInput();
    expect(input.routeSamples).toEqual([
      expect.objectContaining({
        routeId: 'domain-handler',
        replaced: true,
        tested: true,
        shadowParityRate: 0.98,
        sampleCount: 60,
      }),
    ]);
    expect(evaluateRecordedChatV2LegacyRetirementReadiness().passed).toBe(true);
  });

  it('fails retirement readiness for self-attested parity labels without independent signoff', () => {
    vi.stubEnv('CHAT_V2_LEGACY_RETIREMENT_EVIDENCE_ENABLED', 'true');

    recordChatV2LegacyRouteExitEvidence(routeEvidence({
      routeId: 'domain-handler',
      shadowParityRate: 0.98,
      sampleCount: 60,
      safeMetadata: {
        parityLabelImport: true,
        evaluator: 'runtime_tool',
      },
    }));
    recordChatV2LegacyFallbackRateEvidence({
      requestId: 'req-rate',
      legacyFallbackRate24h: 0.01,
    });
    recordChatV2LegacyVerifyRunEvidence({
      requestId: 'req-verify',
      fullVerifyClean: true,
    });

    const result = evaluateRecordedChatV2LegacyRetirementReadiness();
    expect(result.passed).toBe(false);
    expect(result.gates.find((gate) => gate.gateId === 'route_independent_peer_review')).toMatchObject({
      passed: false,
      reasonCode: 'missing_independent_peer_review',
    });
  });
});

function rowCount(): number {
  return (testDb.prepare('SELECT COUNT(*) AS count FROM chat_v2_legacy_retirement_evidence').get() as { count: number }).count;
}

function routeEvidence(
  overrides: Partial<Parameters<typeof recordChatV2LegacyRouteExitEvidence>[0]> = {},
): Parameters<typeof recordChatV2LegacyRouteExitEvidence>[0] {
  const { safeMetadata, ...rest } = overrides;
  return {
    requestId: 'req-route',
    routeId: 'domain-handler',
    replaced: true,
    tested: true,
    shadowParityRate: 0.97,
    sampleCount: 55,
    safeMetadata: {
      evaluator: 'claude',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      ...(safeMetadata ?? {}),
    },
    ...rest,
  };
}

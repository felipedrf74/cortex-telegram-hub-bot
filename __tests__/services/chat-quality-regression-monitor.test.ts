import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING } from '../../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
} from '../../src/services/chat-v2-completion-evidence';
import { runChatQualityRegressionMonitor } from '../../src/services/chat-quality-regression-monitor';
import type {
  ChatV2CompletionReadinessReportLike,
  ChatV2ReadinessGateLike,
} from '../../src/services/chatv2-readiness-alerts';

const NOW = new Date('2026-07-22T12:00:00.000Z');
let db: Database.Database;

beforeEach(() => {
  db = createMigratedTestDatabase();
});

afterEach(() => {
  db.close();
});

function insertSignedBehaviorRegression(): void {
  db.prepare(`
    INSERT INTO chat_v2_legacy_retirement_evidence (
      evidence_source, evidence_kind, request_id, sample_hmac,
      sample_identifier_kind, route_id, replaced, tested,
      shadow_parity_rate, route_sample_count, raw_field_audit_count,
      safe_metadata_json, created_at
    ) VALUES ('runtime_route', 'route_exit', 'monitor-behavior', ?, 'hmac',
      'training_plan_shortcut', 1, 1, 0.94, 50, 0, ?, ?)
  `).run(
    `hmac:test:${'b'.repeat(64)}`,
    JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
      parityLabelImport: true,
      evaluator: 'manual',
      peerReviewSignoffHash: 'a'.repeat(64),
      matchingCount: 47,
      sampleCount: 50,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
      parityRate: 0.94,
      reviewCompletenessChecked: true,
      rawReviewArtifactCompletenessChecked: true,
      observedRouteSampleCount: 50,
      observerManifestSha256: '1'.repeat(64),
      observerObservationsSha256: '2'.repeat(64),
      rawReviewArtifactSha256: '3'.repeat(64),
      forbiddenRawText: 'never surface me',
      ...CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
    }),
    NOW.toISOString(),
  );
}

function makeCompleteReadinessReport(
  generatedAt: string,
  legacyRetirement: { passed: boolean; gates: ChatV2ReadinessGateLike[] },
): ChatV2CompletionReadinessReportLike {
  const passingPhase = () => ({ passed: true, gates: [] });
  return {
    schemaVersion: 'chat_v2_completion_readiness_report.v1',
    generatedAt,
    evidenceSources: ['runtime_route'],
    evidenceContract: {
      retirementObserverCorpusBinding: CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
      responseLocaleEvidenceVersion: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
    },
    shadow: passingPhase(),
    answerCanary: passingPhase(),
    deterministicRead: passingPhase(),
    writePreview: passingPhase(),
    confirmedWrites: passingPhase(),
    cloudAllowlist: passingPhase(),
    legacyRetirement,
  };
}

describe('chat quality regression monitor', () => {
  it('records readiness and signed behavior regressions without activation or tenant inputs', async () => {
    insertSignedBehaviorRegression();
    const recorded: unknown[] = [];
    const result = await runChatQualityRegressionMonitor({
      db,
      now: NOW,
      readinessReport: makeCompleteReadinessReport(NOW.toISOString(), {
          passed: false,
          gates: [{
            gateId: 'legacy_parity_match_rate',
            passed: false,
            sampleCount: 50,
            observed: 0.94,
            threshold: 0.95,
          }],
      }),
      recordAlert: (input) => {
        recorded.push(input);
        return { ok: true, action: 'created' } as never;
      },
    });

    expect(result).toMatchObject({
      readinessAvailable: true,
      readinessArtifactHealthy: true,
      readinessHealthAlertCount: 0,
      readinessRegressionAlertCount: 1,
      behaviorRegressionAlertCount: 1,
      fallbackRegressionAlertCount: 0,
      recordedAlertCount: 2,
    });
    expect(recorded.map((input: any) => input.dedupeKey).sort()).toEqual([
      'chatv2-readiness:legacyRetirement:legacy_parity_match_rate',
      'chatv2-retirement:behavior:training_plan_shortcut',
    ]);
    expect(JSON.stringify(recorded)).not.toContain('never surface me');
    expect(JSON.stringify(recorded)).not.toContain('a'.repeat(64));
  });

  it('records one deduped monitor-health warning for a missing artifact and still checks other evidence', async () => {
    const recordAlert = vi.fn(() => ({ ok: true, action: 'created' } as never));
    const result = await runChatQualityRegressionMonitor({
      db,
      now: NOW,
      readinessReport: null,
      readinessUnavailableReason: 'artifact not found',
      recordAlert,
    });

    expect(result).toEqual({
      readinessAvailable: false,
      readinessArtifactHealthy: false,
      readinessUnavailableReason: 'artifact not found',
      readinessHealthAlertCount: 1,
      readinessRegressionAlertCount: 0,
      behaviorRegressionAlertCount: 0,
      fallbackRegressionAlertCount: 0,
      recordedAlertCount: 1,
    });
    expect(recordAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warning',
      dedupeKey: 'chat-quality-regression-monitor:readiness-artifact-health',
      metadata: expect.objectContaining({ health: 'unavailable' }),
    }));
  });

  it('fails malformed readiness structure soft, warns once, and still checks signed behavior evidence', async () => {
    insertSignedBehaviorRegression();
    const recorded: any[] = [];

    const result = await runChatQualityRegressionMonitor({
      db,
      now: NOW,
      readinessReport: {
        ...makeCompleteReadinessReport(NOW.toISOString(), { passed: true, gates: [] }),
        legacyRetirement: {
          passed: false,
          gates: { corrupt: true },
        },
      } as never,
      recordAlert: (input) => {
        recorded.push(input);
        return { ok: true, action: 'created' } as never;
      },
    });

    expect(result).toMatchObject({
      readinessAvailable: true,
      readinessArtifactHealthy: false,
      readinessHealthAlertCount: 1,
      readinessRegressionAlertCount: 0,
      behaviorRegressionAlertCount: 1,
      recordedAlertCount: 2,
    });
    expect(recorded.map((alert) => alert.dedupeKey).sort()).toEqual([
      'chat-quality-regression-monitor:readiness-artifact-health',
      'chatv2-retirement:behavior:training_plan_shortcut',
    ]);
    expect(recorded[0].metadata.health).toBe('invalid');
  });

  it('refuses stale readiness parity claims and emits only the health warning', async () => {
    const recorded: any[] = [];
    const result = await runChatQualityRegressionMonitor({
      db,
      now: NOW,
      readinessReport: makeCompleteReadinessReport('2026-07-13T11:59:59.000Z', {
          passed: false,
          gates: [{
            gateId: 'legacy_parity_match_rate', passed: false,
            sampleCount: 50, observed: 0.9, threshold: 0.95,
          }],
      }),
      recordAlert: (input) => {
        recorded.push(input);
        return { ok: true, action: 'created' } as never;
      },
    });

    expect(result).toMatchObject({
      readinessAvailable: true,
      readinessArtifactHealthy: false,
      readinessHealthAlertCount: 1,
      readinessRegressionAlertCount: 0,
      recordedAlertCount: 1,
    });
    expect(recorded.map((alert) => alert.dedupeKey)).toEqual([
      'chat-quality-regression-monitor:readiness-artifact-health',
    ]);
    expect(recorded[0].metadata).toMatchObject({ health: 'stale', maxAgeHours: 192 });
  });
});

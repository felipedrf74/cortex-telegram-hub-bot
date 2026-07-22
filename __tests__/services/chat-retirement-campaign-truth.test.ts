// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_MESSAGE_STAGES, NON_RETIRABLE_CHAT_STAGES } from '../../src/api/routes/chat-pipeline/runner';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  CHAT_V2_RETIREMENT_STAGE_MAPPINGS,
  buildChatV2RetirementCampaign,
  buildChatV2RetirementBehaviorRegressionAlertInputs,
  buildChatV2RetirementFallbackAlertInputs,
  validateChatV2RetirementStageMappings,
} from '../../src/services/chat-route-exit-sampler';

const NOW = new Date('2026-07-22T12:00:00.000Z');
const SIGNOFF = 'a'.repeat(64);

let db: Database.Database;

beforeEach(() => {
  db = createMigratedTestDatabase();
});

afterEach(() => {
  db.close();
});

function insertBehaviorEvidence(input: {
  routeId: string;
  sampleCount?: number;
  matchingCount?: number;
  evaluator?: string;
  signoff?: string | null;
  safetyRegressionCount?: number;
  qualityRegressionCount?: number;
  degradedNotComparableCount?: number;
}): void {
  const sampleCount = input.sampleCount ?? 50;
  const matchingCount = input.matchingCount ?? sampleCount;
  const safeMetadata = {
    schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
    parityObservationImport: true,
    evaluator: input.evaluator ?? 'manual',
    peerReviewSignoffHash: input.signoff === undefined ? SIGNOFF : input.signoff,
    matchingCount,
    sampleCount,
    safetyRegressionCount: input.safetyRegressionCount ?? 0,
    qualityRegressionCount: input.qualityRegressionCount ?? 0,
    degradedNotComparableCount: input.degradedNotComparableCount ?? 0,
  };
  db.prepare(`
    INSERT INTO chat_v2_legacy_retirement_evidence (
      evidence_source, evidence_kind, request_id, sample_hmac,
      sample_identifier_kind, route_id, replaced, tested,
      shadow_parity_rate, route_sample_count, raw_field_audit_count,
      safe_metadata_json, created_at
    ) VALUES ('runtime_route', 'route_exit', ?, ?, 'hmac', ?, 1, 1, ?, ?, 0, ?, ?)
  `).run(
    `behavior:${input.routeId}`,
    `hmac:test:${'b'.repeat(64)}`,
    input.routeId,
    matchingCount / Math.max(1, sampleCount),
    sampleCount,
    JSON.stringify(safeMetadata),
    NOW.toISOString(),
  );
}

function insertRoutingDiagnostic(count: number): void {
  const insert = db.prepare(`
    INSERT INTO chat_v2_route_exit_samples (
      source, source_row_id, source_key, route_id, route_method,
      kind, routing_agreement, health_ok, reason, sampled_at
    ) VALUES ('shadow_replay_bundle', ?, ?, 'training_plan_shortcut',
      'llm_synthesis', 'routing_diagnostic', 1, NULL, 'legacy_v2_routing_agreement', ?)
  `);
  for (let index = 0; index < count; index += 1) {
    insert.run(index + 1, `routing-${index}`, NOW.toISOString());
  }
}

function insertFallback(input: {
  routeOwner: string;
  routeMethod: string;
  fallback: number;
  total: number;
}): void {
  db.prepare(`
    INSERT INTO chat_v2_legacy_fallback_attribution_counter (
      tenant_id, window_start, domain, route_owner, route_method,
      fallback_count, total_count, updated_at
    ) VALUES ('tenant-a', ?, 'training', ?, ?, ?, ?, ?)
  `).run(
    '2026-07-22T11',
    input.routeOwner,
    input.routeMethod,
    input.fallback,
    input.total,
    NOW.toISOString(),
  );
}

describe('ChatV2 retirement campaign evidence truth', () => {
  it('never turns routing-domain agreement into behavior parity or PASS', () => {
    insertRoutingDiagnostic(60);
    insertFallback({
      routeOwner: 'training_plan_shortcut',
      routeMethod: 'training-plan-shortcut',
      fallback: 0,
      total: 100,
    });

    const route = buildChatV2RetirementCampaign(db, { now: NOW })
      .find((row) => row.routeId === 'training_plan_shortcut')!;

    expect(route.routingAgreementSamples).toBe(60);
    expect(route.behaviorParitySamples).toBe(0);
    expect(route.behaviorGatePassed).toBe(false);
    expect(route.verdict).toBe('insufficient_evidence');
    expect(route.candidate).toBe(false);
  });

  it('passes only signed paired behavior evidence with a safe stage mapping and <=2% fallback', () => {
    insertBehaviorEvidence({ routeId: 'training_plan_shortcut', sampleCount: 50, matchingCount: 48 });
    insertFallback({
      routeOwner: 'training_plan_shortcut',
      routeMethod: 'training-plan-shortcut',
      fallback: 2,
      total: 100,
    });

    const route = buildChatV2RetirementCampaign(db, { now: NOW })
      .find((row) => row.routeId === 'training_plan_shortcut')!;

    expect(route).toMatchObject({
      behaviorParitySamples: 50,
      behaviorMatchingCount: 48,
      behaviorParityRate: 0.96,
      peerReviewPassed: true,
      regressionReviewPassed: true,
      disableStages: ['training_plan_shortcut'],
      mappingStatus: 'mapped',
      fallback24h: { fallbackCount: 2, totalCount: 100, rate: 0.02, passed: true },
      behaviorGatePassed: true,
      candidate: true,
      verdict: 'pass',
    });
  });

  it('fails closed when peer signoff or regression review is missing', () => {
    insertBehaviorEvidence({ routeId: 'training_plan_shortcut', signoff: null });
    insertFallback({
      routeOwner: 'training_plan_shortcut',
      routeMethod: 'training-plan-shortcut',
      fallback: 0,
      total: 100,
    });

    const route = buildChatV2RetirementCampaign(db, { now: NOW })
      .find((row) => row.routeId === 'training_plan_shortcut')!;
    expect(route.peerReviewPassed).toBe(false);
    expect(route.behaviorGatePassed).toBe(false);
    expect(route.verdict).toBe('fail');
    expect(route.blockingReasons).toContain('missing_independent_peer_review');
  });

  it('uses the latest paired behavior package instead of a newer inventory-only row', () => {
    insertBehaviorEvidence({ routeId: 'training_plan_shortcut' });
    db.prepare(`
      INSERT INTO chat_v2_legacy_retirement_evidence (
        evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
        route_id, replaced, tested, shadow_parity_rate, route_sample_count,
        raw_field_audit_count, safe_metadata_json, created_at
      ) VALUES ('runtime_route', 'route_exit', 'inventory-later', ?, 'hmac',
        'training_plan_shortcut', 0, 0, 0, 0, 0, ?, '2026-07-22T13:00:00.000Z')
    `).run(
      `hmac:test:${'9'.repeat(64)}`,
      JSON.stringify({ status: 'inventory_only_not_retired' }),
    );
    insertFallback({
      routeOwner: 'training_plan_shortcut',
      routeMethod: 'training-plan-shortcut',
      fallback: 0,
      total: 100,
    });

    const route = buildChatV2RetirementCampaign(db, { now: NOW })
      .find((row) => row.routeId === 'training_plan_shortcut')!;
    expect(route.behaviorParitySamples).toBe(50);
    expect(route.behaviorGatePassed).toBe(true);
    expect(route.verdict).toBe('pass');
  });

  it('validates every candidate stage against the real runner and blocks safety/unmapped routes', () => {
    expect(validateChatV2RetirementStageMappings(
      CHAT_MESSAGE_STAGES.map((stage) => stage.name),
      NON_RETIRABLE_CHAT_STAGES,
    )).toEqual([]);
    expect(Object.entries(CHAT_V2_RETIREMENT_STAGE_MAPPINGS)
      .filter(([, mapping]) => mapping.status === 'mapped')
      .map(([routeId, mapping]) => [routeId, [...mapping.disableStages]])).toEqual([
      ['training_plan_shortcut', ['training_plan_shortcut']],
      ['decision_confirmation_shortcut', ['decision_confirmation_shortcut']],
    ]);

    insertBehaviorEvidence({ routeId: 'destructive_confirmation_hold' });
    const route = buildChatV2RetirementCampaign(db, { now: NOW })
      .find((row) => row.routeId === 'destructive_confirmation_hold')!;
    expect(route.mappingStatus).toBe('non_retirable');
    expect(route.disableStages).toEqual([]);
    expect(route.candidate).toBe(false);
    expect(route.verdict).toBe('blocked');
  });

  it('emits route-scoped near-real-time critical alerts above the 2% fallback ceiling', () => {
    insertBehaviorEvidence({ routeId: 'training_plan_shortcut' });
    insertFallback({
      routeOwner: 'training_plan_shortcut',
      routeMethod: 'training-plan-shortcut',
      fallback: 3,
      total: 100,
    });
    const campaign = buildChatV2RetirementCampaign(db, { now: NOW });
    const alerts = buildChatV2RetirementFallbackAlertInputs(campaign, { generatedAt: NOW.toISOString() });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'critical',
      dedupeKey: 'chatv2-retirement:fallback:training_plan_shortcut',
      metadata: {
        routeId: 'training_plan_shortcut',
        fallbackRate24h: 0.03,
        threshold: 0.02,
        fallbackCount: 3,
        totalCount: 100,
      },
    });
  });

  it('does not round a just-over-2% fallback regression into a PASS', () => {
    insertBehaviorEvidence({ routeId: 'training_plan_shortcut' });
    insertFallback({
      routeOwner: 'training_plan_shortcut',
      routeMethod: 'training-plan-shortcut',
      fallback: 20_001,
      total: 1_000_000,
    });
    const route = buildChatV2RetirementCampaign(db, { now: NOW })
      .find((row) => row.routeId === 'training_plan_shortcut')!;
    expect(route.fallback24h.rate).toBe(0.020001);
    expect(route.fallback24h.passed).toBe(false);
    expect(route.verdict).toBe('fail');
    expect(buildChatV2RetirementFallbackAlertInputs([route])).toHaveLength(1);
  });

  it('emits aggregate-only alerts when signed paired behavior parity regresses', () => {
    insertBehaviorEvidence({
      routeId: 'training_plan_shortcut',
      sampleCount: 50,
      matchingCount: 47,
    });
    const route = buildChatV2RetirementCampaign(db, { now: NOW })
      .find((row) => row.routeId === 'training_plan_shortcut')!;
    const alerts = buildChatV2RetirementBehaviorRegressionAlertInputs([route], {
      generatedAt: NOW.toISOString(),
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'warning',
      dedupeKey: 'chatv2-retirement:behavior:training_plan_shortcut',
      metadata: {
        routeId: 'training_plan_shortcut',
        behaviorParitySamples: 50,
        behaviorMatchingCount: 47,
        behaviorParityRate: 0.94,
        threshold: 0.95,
        peerReviewPassed: true,
      },
    });
    expect(JSON.stringify(alerts)).not.toContain(SIGNOFF);
  });

  it('runs behavior/readiness/fallback alerts in an independent five-minute monitor', () => {
    const scheduler = fs.readFileSync(path.resolve(__dirname, '../../src/services/scheduler.ts'), 'utf8');
    const monitor = scheduler.match(
      /cron\.schedule\('\*\/5 \* \* \* \*', wrapJob\('chat_quality_regression_monitor',[\s\S]*?timezone: 'UTC'/,
    )?.[0] ?? '';
    expect(scheduler).toContain(
      "registerJob('chat_quality_regression_monitor', 'Chat Quality Regression Monitor', '*/5 * * * *', 'system')",
    );
    expect(monitor).toContain('CHAT_QUALITY_REGRESSION_MONITOR_DISABLED');
    expect(monitor).toContain('runChatQualityRegressionMonitor');
    expect(monitor).not.toContain('getActiveChatCoreV2TenantIds');
    expect(monitor).not.toContain('resolveChatCoreV2ActivationConfig');
  });
});

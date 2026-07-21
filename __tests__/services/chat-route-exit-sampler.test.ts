// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Chat M20 — ChatV2 route-exit evidence sampler.
//
// Parity rows come ONLY from shadow replay bundles that carry a usable
// legacy-vs-v2 routing comparison (the M4 routingDivergence surfaces).
// Bundles without that comparison become parity_unknown (parity NULL) and
// are EXCLUDED from the retirement gate's sample floor and parity rate.
// Online-eval captures are v2-health context rows (kind='health') and never
// feed the parity gate. Re-syncs refresh in-place-upserted source rows.

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { recordChatV2ReplayBundle } from '../../src/services/chat-core-v2/model-run-audit';
import {
  recordChatV2OnlineEvalSample,
} from '../../src/services/chat-core-v2/online-eval-sampler';
import { CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS } from '../../src/services/chat-legacy-parity-route-prompts';
import {
  CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER,
  CHAT_V2_RETIREMENT_REQUIRED_ROUTE_IDS,
  buildChatLegacyRetirementEvidence,
  buildChatV2RetirementCampaign,
  isChatRouteExitSamplerMigrationApplied,
  resolveChatV2LegacyRouteId,
  syncChatRouteExitSamples,
} from '../../src/services/chat-route-exit-sampler';

const NOW = new Date('2026-07-20T12:00:00.000Z');

let db: Database.Database;

beforeEach(() => {
  db = createMigratedTestDatabase();
});

// ─── seeding helpers (synthetic fixtures — no real captures) ─────────────

let bundleSeq = 0;
function seedShadowBundle(options: {
  id?: string;
  routeMethod?: string;
  domain?: string;
  /** Legacy orchestrator surface domain recorded in routingDivergence.surfaces. */
  legacyDomain?: string | null;
  /** v2 shadow route domains recorded in routingDivergence.surfaces. */
  shadowDomains?: string[];
  omitDivergence?: boolean;
  nonShadow?: boolean;
} = {}): string {
  bundleSeq += 1;
  const replayBundleId = options.id ?? `bundle-${bundleSeq}`;
  const routeMethod = options.routeMethod ?? 'deterministic_read';
  const shadowDomains = options.shadowDomains ?? (options.domain ? [options.domain] : []);
  const bundle = {
    turnId: `turn-${replayBundleId}`,
    routeDecision: {
      routeMethod,
      domains: options.domain ? [options.domain] : [],
      selectedCapabilityIds: [],
    },
    contextPack: {
      ...(options.nonShadow ? {} : { shadowRouteHookVersion: 'chat_core_v2_shadow_route_hook@1.0.0' }),
      guessedDomains: options.domain ? [options.domain] : [],
      ...(options.omitDivergence ? {} : {
        routingDivergence: {
          divergenceVersion: 'routing_divergence_shadow@1.0.0',
          surfaces: {
            classifierKeywordDomain: null,
            orchestratorPrimaryDomain: options.legacyDomain ?? null,
            registryActionSkills: [],
            shadowRouteIntent: 'read',
            shadowRouteDomains: shadowDomains,
          },
        },
      }),
    },
    modelRuns: [],
    toolSchemaSetVersion: 'tools@1',
    commandProposals: [],
    commandEvents: [],
    traceSpans: [],
    response: options.nonShadow
      ? { type: 'live_turn' }
      : { type: 'chat_core_v2_shadow_plan', routeMethod },
  };
  recordChatV2ReplayBundle({
    replayBundleId,
    bundle: bundle as never,
    sensitivity: 'normal',
    retentionPolicy: '90d',
    createdAt: NOW.toISOString(),
  }, db);
  return replayBundleId;
}

let evalSeq = 0;
function seedOnlineEvalSample(options: {
  routeMethod?: string;
  domain?: string;
  failure?: boolean;
  notSampled?: boolean;
} = {}): string {
  evalSeq += 1;
  const sampleId = `sample-${evalSeq}`;
  recordChatV2OnlineEvalSample({
    sampleId,
    turnId: `eval-turn-${evalSeq}`,
    tenantId: 'tenant-1',
    userId: 'user-1',
    routeMethod: (options.routeMethod ?? 'planner') as never,
    risk: 'low',
    sensitivity: 'normal',
    domain: options.domain as never,
    createdAt: NOW.toISOString(),
    decision: options.notSampled
      ? {
          sample: false,
          status: 'not_sampled',
          reason: 'not_sampled',
          sampleRate: 0.01,
          samplerVersion: 'test',
        }
      : {
          sample: true,
          status: 'sampled',
          reason: options.failure ? 'schema_failure' : 'baseline_random',
          sampleRate: 1,
          samplerVersion: 'test',
        },
  }, db);
  return sampleId;
}

function allSamples(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM chat_v2_route_exit_samples ORDER BY id ASC').all() as Array<Record<string, unknown>>;
}

// ─── route id vocabulary ─────────────────────────────────────────────────

describe('retirement campaign route vocabulary', () => {
  it('campaign order covers exactly the real Phase-7 required route ids', () => {
    const required = [...new Set(CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.map((route) => route.routeId))].sort();
    expect([...CHAT_V2_RETIREMENT_REQUIRED_ROUTE_IDS].sort()).toEqual(required);
    expect([...CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER].sort()).toEqual(required);
    expect(new Set(CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER).size)
      .toBe(CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER.length);
  });

  it('resolves route methods to real legacy route ids deterministically', () => {
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'deterministic_read' }))
      .toBe('chat_message_shortcut_after_route');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_synthesis', domain: 'training' }))
      .toBe('training_plan_shortcut');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_synthesis' }))
      .toBe('selective_internet_research');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_command_translation', domain: 'decision_center' }))
      .toBe('decision_confirmation_shortcut');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_command_translation', domain: 'cooking' }))
      .toBe('domain_handler_execution');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_command_translation', domain: 'tasks' }))
      .toBe('general_action_planner');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_command_translation' }))
      .toBe('general_action_planner');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'planner' }))
      .toBe('chat_reasoning_engine_v1');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'background_planner' }))
      .toBe('chat_reasoning_engine_v1');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'needs_clarification' }))
      .toBe('classifier_route_skill_orchestration');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'unsupported' }))
      .toBe('classifier_route_skill_orchestration');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'blocked' }))
      .toBe('destructive_confirmation_hold');
    // Explicit legacyRouteId wins, but only when it is a real route id.
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'planner', legacyRouteId: 'training_plan_shortcut' }))
      .toBe('training_plan_shortcut');
    expect(resolveChatV2LegacyRouteId({ legacyRouteId: 'made_up_route' })).toBeNull();
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'unknown_method' })).toBeNull();
    expect(resolveChatV2LegacyRouteId({})).toBeNull();
  });
});

// ─── conversion semantics ────────────────────────────────────────────────

describe('syncChatRouteExitSamples', () => {
  it('derives parity from the legacy-vs-v2 routing comparison in the divergence surfaces', () => {
    // Legacy surface said secretary; v2 shadow said tasks (→ legacy secretary): agree.
    seedShadowBundle({
      routeMethod: 'deterministic_read',
      legacyDomain: 'secretary',
      shadowDomains: ['tasks'],
    });
    // Legacy surface said triathlon; v2 shadow said training (→ triathlon): agree.
    seedShadowBundle({
      routeMethod: 'llm_synthesis',
      domain: 'training',
      legacyDomain: 'triathlon',
      shadowDomains: ['training'],
    });
    // Legacy surface said finance; v2 shadow said training: diverge.
    seedShadowBundle({
      routeMethod: 'llm_synthesis',
      domain: 'training',
      legacyDomain: 'finance',
      shadowDomains: ['training'],
    });

    const result = syncChatRouteExitSamples(db, { now: NOW });
    expect(result.sources.shadow_replay_bundle.converted).toBe(3);

    const rows = allSamples();
    const byKey = new Map(rows.map((row) => [String(row.source_key), row]));
    expect(byKey.get('bundle-1')).toMatchObject({
      source: 'shadow_replay_bundle',
      kind: 'parity',
      route_id: 'chat_message_shortcut_after_route',
      parity: 1,
      health_ok: null,
    });
    expect(byKey.get('bundle-2')).toMatchObject({
      kind: 'parity',
      route_id: 'training_plan_shortcut',
      parity: 1,
    });
    expect(byKey.get('bundle-3')).toMatchObject({
      kind: 'parity',
      route_id: 'training_plan_shortcut',
      parity: 0,
      reason: 'legacy_v2_domain_divergence',
    });
  });

  it('records parity_unknown (NULL) when the bundle lacks a usable legacy-vs-v2 comparison', () => {
    // No divergence record at all (pre-M4 bundle).
    seedShadowBundle({ routeMethod: 'deterministic_read', omitDivergence: true });
    // Divergence record, but no legacy surface decision.
    seedShadowBundle({
      routeMethod: 'deterministic_read',
      legacyDomain: null,
      shadowDomains: ['tasks'],
    });
    // Divergence record, legacy decision, but no v2 shadow domains.
    seedShadowBundle({
      routeMethod: 'deterministic_read',
      legacyDomain: 'secretary',
      shadowDomains: [],
    });

    syncChatRouteExitSamples(db, { now: NOW });
    const rows = allSamples();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.kind).toBe('parity');
      expect(row.parity).toBeNull();
    }
    expect(rows.map((row) => row.reason)).toEqual([
      'parity_unknown_no_divergence_record',
      'parity_unknown_no_legacy_route_decision',
      'parity_unknown_no_v2_route_decision',
    ]);
  });

  it('stores online-eval captures as health rows, never parity', () => {
    seedOnlineEvalSample({ routeMethod: 'planner' });
    seedOnlineEvalSample({ routeMethod: 'planner', failure: true });

    const result = syncChatRouteExitSamples(db, { now: NOW });
    expect(result.sources.online_eval_sample.converted).toBe(2);

    const rows = allSamples();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: 'online_eval_sample',
      kind: 'health',
      route_id: 'chat_reasoning_engine_v1',
      parity: null,
      health_ok: 1,
      reason: 'eval_capture_baseline_random',
    });
    expect(rows[1]).toMatchObject({
      kind: 'health',
      parity: null,
      health_ok: 0,
      reason: 'eval_capture_schema_failure',
    });
  });

  it('does not ingest eval-history scenario rows (dropped source)', () => {
    const result = syncChatRouteExitSamples(db, { now: NOW });
    expect(Object.keys(result.sources).sort()).toEqual([
      'online_eval_sample', 'shadow_replay_bundle',
    ]);
  });

  it('skips non-shadow bundles and unsampled captures', () => {
    seedShadowBundle({ nonShadow: true });
    seedOnlineEvalSample({ notSampled: true });

    const result = syncChatRouteExitSamples(db, { now: NOW });
    expect(result.sources.shadow_replay_bundle.converted).toBe(0);
    expect(result.sources.shadow_replay_bundle.skipped).toBe(1);
    expect(result.sources.online_eval_sample.converted).toBe(0);
    expect(result.sources.online_eval_sample.skipped).toBe(1);
    expect(allSamples()).toHaveLength(0);
  });

  it('refreshes existing rows when a source row is upserted in place under the same natural key', () => {
    // Original recording: legacy and v2 agree.
    seedShadowBundle({
      id: 'bundle-fixed',
      routeMethod: 'deterministic_read',
      legacyDomain: 'secretary',
      shadowDomains: ['tasks'],
    });
    const first = syncChatRouteExitSamples(db, { now: NOW });
    expect(first.sources.shadow_replay_bundle.converted).toBe(1);
    expect(allSamples()[0]).toMatchObject({ parity: 1 });

    // Source-row rewrite IN PLACE (recordChatV2ReplayBundle upserts on
    // replay_bundle_id): the comparison now diverges.
    seedShadowBundle({
      id: 'bundle-fixed',
      routeMethod: 'deterministic_read',
      legacyDomain: 'finance',
      shadowDomains: ['tasks'],
    });
    const second = syncChatRouteExitSamples(db, { now: NOW });
    expect(second.sources.shadow_replay_bundle.refreshed).toBe(1);
    expect(second.sources.shadow_replay_bundle.converted).toBe(0);

    const rows = allSamples();
    expect(rows).toHaveLength(1); // never duplicated
    expect(rows[0]).toMatchObject({ parity: 0, reason: 'legacy_v2_domain_divergence' });
  });

  it('is idempotent on unchanged sources', () => {
    seedShadowBundle({ legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    seedOnlineEvalSample({ routeMethod: 'planner' });
    syncChatRouteExitSamples(db, { now: NOW });
    const again = syncChatRouteExitSamples(db, { now: NOW });
    expect(again.sources.shadow_replay_bundle.converted).toBe(0);
    expect(again.sources.online_eval_sample.converted).toBe(0);
    expect(allSamples()).toHaveLength(2);
  });
});

// ─── aggregation + gate integration ──────────────────────────────────────

describe('buildChatLegacyRetirementEvidence', () => {
  it('excludes parity_unknown rows from both the sample floor and the parity rate', () => {
    // 3 known-parity agreements + 1 divergence + 4 unknown rows.
    for (let i = 0; i < 3; i += 1) {
      seedShadowBundle({ legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    }
    seedShadowBundle({ legacyDomain: 'finance', shadowDomains: ['tasks'] });
    for (let i = 0; i < 4; i += 1) {
      seedShadowBundle({ omitDivergence: true });
    }
    syncChatRouteExitSamples(db, { now: NOW });

    const evidence = buildChatLegacyRetirementEvidence(db);
    const route = evidence.routes.find((row) => row.routeId === 'chat_message_shortcut_after_route')!;
    expect(route.paritySamples).toBe(4);
    expect(route.parityUnknown).toBe(4);
    expect(route.parityRate).toBeCloseTo(0.75, 10);
    expect(route.gateResult.gateId).toBe('route_shadow_parity');
    expect(route.gatePassed).toBe(false);
    // Floor counts KNOWN parity rows only: 50 - 4 = 46.
    expect(route.missingSamples).toBe(46);
  });

  it('never passes vacuously on unknown-only evidence', () => {
    for (let i = 0; i < 60; i += 1) {
      seedShadowBundle({ omitDivergence: true });
    }
    syncChatRouteExitSamples(db, { now: NOW });
    const evidence = buildChatLegacyRetirementEvidence(db);
    const route = evidence.routes.find((row) => row.routeId === 'chat_message_shortcut_after_route')!;
    expect(route.paritySamples).toBe(0);
    expect(route.parityUnknown).toBe(60);
    expect(route.gatePassed).toBe(false);
    expect(route.missingSamples).toBe(50);
  });

  it('excludes health rows from the retirement gate but reports them as context', () => {
    // 50 clean health captures for chat_reasoning_engine_v1 must NOT satisfy
    // the parity gate.
    for (let i = 0; i < 50; i += 1) seedOnlineEvalSample({ routeMethod: 'planner' });
    seedOnlineEvalSample({ routeMethod: 'planner', failure: true });
    syncChatRouteExitSamples(db, { now: NOW });

    const evidence = buildChatLegacyRetirementEvidence(db);
    const route = evidence.routes.find((row) => row.routeId === 'chat_reasoning_engine_v1')!;
    expect(route.paritySamples).toBe(0);
    expect(route.healthSamples).toBe(51);
    expect(route.healthFailures).toBe(1);
    expect(route.gatePassed).toBe(false);
    expect(route.missingSamples).toBe(50);
    const gateSample = evidence.routeSamples.find((row) => row.routeId === 'chat_reasoning_engine_v1')!;
    expect(gateSample.sampleCount).toBe(0);
  });

  it('passes the retirement parity gate at >=50 known samples and >=0.95 parity, fails below', () => {
    // 50 known samples, 48 agree => 0.96 => PASS (even with unknown noise rows).
    for (let i = 0; i < 48; i += 1) {
      seedShadowBundle({ legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    }
    for (let i = 0; i < 2; i += 1) {
      seedShadowBundle({ legacyDomain: 'finance', shadowDomains: ['tasks'] });
    }
    for (let i = 0; i < 5; i += 1) seedShadowBundle({ omitDivergence: true });
    // 49 known samples at 100% => floor unmet => FAIL.
    for (let i = 0; i < 49; i += 1) {
      seedShadowBundle({
        routeMethod: 'planner',
        legacyDomain: 'secretary',
        shadowDomains: ['tasks'],
      });
    }
    // 50 known samples, 45 agree => 0.90 => FAIL.
    for (let i = 0; i < 45; i += 1) {
      seedShadowBundle({
        routeMethod: 'llm_synthesis',
        legacyDomain: 'secretary',
        shadowDomains: ['tasks'],
      });
    }
    for (let i = 0; i < 5; i += 1) {
      seedShadowBundle({
        routeMethod: 'llm_synthesis',
        legacyDomain: 'finance',
        shadowDomains: ['tasks'],
      });
    }
    syncChatRouteExitSamples(db, { now: NOW });

    const evidence = buildChatLegacyRetirementEvidence(db);
    const byRoute = new Map(evidence.routes.map((row) => [row.routeId, row]));

    const passRoute = byRoute.get('chat_message_shortcut_after_route')!;
    expect(passRoute.paritySamples).toBe(50);
    expect(passRoute.parityRate).toBeCloseTo(0.96, 10);
    expect(passRoute.gatePassed).toBe(true);
    expect(passRoute.missingSamples).toBe(0);

    const underSampled = byRoute.get('chat_reasoning_engine_v1')!;
    expect(underSampled.paritySamples).toBe(49);
    expect(underSampled.parityRate).toBe(1);
    expect(underSampled.gatePassed).toBe(false);
    expect(underSampled.missingSamples).toBe(1);

    const lowParity = byRoute.get('selective_internet_research')!;
    expect(lowParity.paritySamples).toBe(50);
    expect(lowParity.parityRate).toBeCloseTo(0.9, 10);
    expect(lowParity.gatePassed).toBe(false);
  });

  it('feeds evaluateChatLegacyRetirementReadiness-compatible route samples from parity rows only', () => {
    seedShadowBundle({ legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    seedShadowBundle({ omitDivergence: true });
    seedOnlineEvalSample({ routeMethod: 'deterministic_read' });
    syncChatRouteExitSamples(db, { now: NOW });
    const evidence = buildChatLegacyRetirementEvidence(db);
    const sample = evidence.routeSamples.find((row) => row.routeId === 'chat_message_shortcut_after_route');
    expect(sample).toMatchObject({
      routeId: 'chat_message_shortcut_after_route',
      replaced: false,
      tested: false,
      sampleCount: 1,
      shadowParityRate: 1,
    });
  });
});

// ─── campaign table ──────────────────────────────────────────────────────

describe('buildChatV2RetirementCampaign', () => {
  it('returns the nine routes in campaign order with honest verdicts', () => {
    for (let i = 0; i < 50; i += 1) {
      seedShadowBundle({ legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    }
    // Under-floor known-parity evidence for the planner route.
    for (let i = 0; i < 3; i += 1) {
      seedShadowBundle({ routeMethod: 'planner', legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    }
    // Health-only evidence for research.
    for (let i = 0; i < 5; i += 1) seedOnlineEvalSample({ routeMethod: 'llm_synthesis' });
    syncChatRouteExitSamples(db, { now: NOW });

    const campaign = buildChatV2RetirementCampaign(db);
    expect(campaign.map((row) => row.routeId)).toEqual([
      'chat_message_shortcut_after_route',
      'training_plan_shortcut',
      'decision_confirmation_shortcut',
      'chat_reasoning_engine_v1',
      'destructive_confirmation_hold',
      'selective_internet_research',
      'classifier_route_skill_orchestration',
      'domain_handler_execution',
      'general_action_planner',
    ]);
    expect(campaign[0]).toMatchObject({
      position: 1,
      routeId: 'chat_message_shortcut_after_route',
      paritySamples: 50,
      parityRate: 1,
      gatePassed: true,
      verdict: 'pass',
      missingSamples: 0,
    });
    const planner = campaign.find((row) => row.routeId === 'chat_reasoning_engine_v1')!;
    expect(planner).toMatchObject({
      paritySamples: 3,
      gatePassed: false,
      verdict: 'insufficient_evidence',
      missingSamples: 47,
    });
    const research = campaign.find((row) => row.routeId === 'selective_internet_research')!;
    expect(research).toMatchObject({
      paritySamples: 0,
      healthSamples: 5,
      verdict: 'insufficient_evidence',
      gatePassed: false,
    });
  });

  it('reports fail (not insufficient) when the floor is met but parity is below threshold', () => {
    for (let i = 0; i < 45; i += 1) {
      seedShadowBundle({ legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    }
    for (let i = 0; i < 5; i += 1) {
      seedShadowBundle({ legacyDomain: 'finance', shadowDomains: ['tasks'] });
    }
    syncChatRouteExitSamples(db, { now: NOW });
    const campaign = buildChatV2RetirementCampaign(db);
    expect(campaign[0]).toMatchObject({
      routeId: 'chat_message_shortcut_after_route',
      paritySamples: 50,
      gatePassed: false,
      verdict: 'fail',
    });
  });
});

// ─── readonly / pre-migration safety ─────────────────────────────────────

describe('migration guard', () => {
  it('reports the migration as applied on a migrated database', () => {
    expect(isChatRouteExitSamplerMigrationApplied(db)).toBe(true);
  });

  it('reports not-applied on a pre-257 database without running DDL', () => {
    const bare = new Database(':memory:');
    try {
      expect(isChatRouteExitSamplerMigrationApplied(bare)).toBe(false);
      // The check itself must not create the table.
      const table = bare.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_v2_route_exit_samples'",
      ).get();
      expect(table).toBeUndefined();
    } finally {
      bare.close();
    }
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { recordChatV2ReplayBundle } from '../../src/services/chat-core-v2/model-run-audit';
import { recordChatV2OnlineEvalSample } from '../../src/services/chat-core-v2/online-eval-sampler';
import { CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS } from '../../src/services/chat-legacy-parity-route-prompts';
import {
  CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER,
  CHAT_V2_RETIREMENT_REQUIRED_ROUTE_IDS,
  isChatRouteExitSamplerMigrationApplied,
  resolveChatV2LegacyRouteId,
  syncChatRouteExitSamples,
} from '../../src/services/chat-route-exit-sampler';

const NOW = new Date('2026-07-20T12:00:00.000Z');
let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createMigratedTestDatabase();
  sequence = 0;
});

afterEach(() => {
  db.close();
});

function seedShadow(input: {
  id?: string;
  routeMethod?: string;
  domain?: string;
  legacyDomain?: string | null;
  shadowDomains?: string[];
  omitDivergence?: boolean;
  nonShadow?: boolean;
} = {}): void {
  sequence += 1;
  const id = input.id ?? `bundle-${sequence}`;
  const routeMethod = input.routeMethod ?? 'deterministic_read';
  recordChatV2ReplayBundle({
    replayBundleId: id,
    bundle: {
      turnId: `turn-${id}`,
      routeDecision: {
        routeMethod,
        domains: input.domain ? [input.domain] : [],
        selectedCapabilityIds: [],
      },
      contextPack: {
        ...(input.nonShadow ? {} : { shadowRouteHookVersion: 'chat_core_v2_shadow_route_hook@1.0.0' }),
        guessedDomains: input.domain ? [input.domain] : [],
        ...(input.omitDivergence ? {} : {
          routingDivergence: {
            surfaces: {
              classifierKeywordDomain: null,
              orchestratorPrimaryDomain: input.legacyDomain ?? null,
              registryActionSkills: [],
              shadowRouteIntent: 'read',
              shadowRouteDomains: input.shadowDomains ?? [],
            },
          },
        }),
      },
      modelRuns: [],
      toolSchemaSetVersion: 'tools@1',
      commandProposals: [],
      commandEvents: [],
      traceSpans: [],
      response: input.nonShadow
        ? { type: 'live_turn' }
        : { type: 'chat_core_v2_shadow_plan', routeMethod },
    } as never,
    sensitivity: 'normal',
    retentionPolicy: '90d',
    createdAt: NOW.toISOString(),
  }, db);
}

function seedEval(input: {
  failure?: boolean;
  sampled?: boolean;
  omitLegacyRouteId?: boolean;
} = {}): void {
  sequence += 1;
  recordChatV2OnlineEvalSample({
    sampleId: `sample-${sequence}`,
    turnId: `eval-turn-${sequence}`,
    tenantId: 'tenant-1',
    userId: 'user-1',
    routeMethod: 'planner',
    risk: 'low',
    sensitivity: 'normal',
    metadata: input.omitLegacyRouteId ? {} : { legacyRouteId: 'chat_reasoning_engine_v1' },
    createdAt: NOW.toISOString(),
    decision: input.sampled === false
      ? { sample: false, status: 'not_sampled', reason: 'not_sampled', sampleRate: 0.1, samplerVersion: 'test' }
      : {
          sample: true,
          status: 'sampled',
          reason: input.failure ? 'schema_failure' : 'baseline_random',
          sampleRate: 1,
          samplerVersion: 'test',
        },
  }, db);
}

function rows(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM chat_v2_route_exit_samples ORDER BY id').all() as Array<Record<string, unknown>>;
}

describe('ChatV2 route-exit diagnostic sampler', () => {
  it('pins campaign order to the held-out behavior route corpus', () => {
    const required = [...new Set(CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.map((route) => route.routeId))].sort();
    expect([...CHAT_V2_RETIREMENT_REQUIRED_ROUTE_IDS].sort()).toEqual(required);
    expect([...CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER].sort()).toEqual(required);
  });

  it('resolves route methods without guessing unsupported rows', () => {
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'deterministic_read' })).toBe('chat_message_shortcut_after_route');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_synthesis', domain: 'training' })).toBe('training_plan_shortcut');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_synthesis' })).toBe('selective_internet_research');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_command_translation', domain: 'decision_center' }))
      .toBe('decision_confirmation_shortcut');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'llm_command_translation', domain: 'cooking' }))
      .toBe('domain_handler_execution');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'planner' })).toBe('chat_reasoning_engine_v1');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'unsupported' })).toBe('classifier_route_skill_orchestration');
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'blocked' })).toBe('destructive_confirmation_hold');
    expect(resolveChatV2LegacyRouteId({ legacyRouteId: 'made_up_route' })).toBeNull();
    expect(resolveChatV2LegacyRouteId({ routeMethod: 'made_up_method' })).toBeNull();
  });

  it('stores routing agreement as an explicitly diagnostic row', () => {
    seedShadow({ legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    seedShadow({ routeMethod: 'llm_synthesis', domain: 'training', legacyDomain: 'finance', shadowDomains: ['training'] });
    const result = syncChatRouteExitSamples(db, { now: NOW });
    expect(result.sources.shadow_replay_bundle.converted).toBe(2);
    expect(rows()).toEqual([
      expect.objectContaining({
        kind: 'routing_diagnostic',
        route_id: 'chat_message_shortcut_after_route',
        routing_agreement: 1,
        health_ok: null,
        reason: 'legacy_v2_routing_agreement',
      }),
      expect.objectContaining({
        kind: 'routing_diagnostic',
        route_id: 'training_plan_shortcut',
        routing_agreement: 0,
        reason: 'legacy_v2_routing_divergence',
      }),
    ]);
  });

  it('keeps unusable routing comparisons unknown rather than calling them parity', () => {
    seedShadow({ omitDivergence: true });
    seedShadow({ legacyDomain: null, shadowDomains: ['tasks'] });
    seedShadow({ legacyDomain: 'secretary', shadowDomains: [] });
    syncChatRouteExitSamples(db, { now: NOW });
    expect(rows().map((row) => [row.routing_agreement, row.reason])).toEqual([
      [null, 'routing_unknown_no_divergence_record'],
      [null, 'routing_unknown_no_legacy_decision'],
      [null, 'routing_unknown_no_v2_decision'],
    ]);
  });

  it('stores online eval only as route health', () => {
    seedEval();
    seedEval({ failure: true });
    syncChatRouteExitSamples(db, { now: NOW });
    expect(rows()).toEqual([
      expect.objectContaining({ kind: 'health', routing_agreement: null, health_ok: 1 }),
      expect.objectContaining({ kind: 'health', routing_agreement: null, health_ok: 0 }),
    ]);
  });

  it('requires an explicit persisted retirement route before crediting eval health', () => {
    seedEval({ omitLegacyRouteId: true });
    const result = syncChatRouteExitSamples(db, { now: NOW });
    expect(result.sources.online_eval_sample.skipped).toBe(1);
    expect(rows()).toEqual([]);
  });

  it('skips non-shadow and non-sampled rows', () => {
    seedShadow({ nonShadow: true });
    seedEval({ sampled: false });
    const result = syncChatRouteExitSamples(db, { now: NOW });
    expect(result.sources.shadow_replay_bundle.skipped).toBe(1);
    expect(result.sources.online_eval_sample.skipped).toBe(1);
    expect(rows()).toEqual([]);
  });

  it('refreshes source upserts and stays idempotent', () => {
    seedShadow({ id: 'fixed', legacyDomain: 'secretary', shadowDomains: ['tasks'] });
    expect(syncChatRouteExitSamples(db, { now: NOW }).sources.shadow_replay_bundle.converted).toBe(1);
    seedShadow({ id: 'fixed', legacyDomain: 'finance', shadowDomains: ['tasks'] });
    const refreshed = syncChatRouteExitSamples(db, { now: NOW });
    expect(refreshed.sources.shadow_replay_bundle.refreshed).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ routing_agreement: 0, reason: 'legacy_v2_routing_divergence' });
    expect(syncChatRouteExitSamples(db, { now: NOW }).sources.shadow_replay_bundle.converted).toBe(0);
  });

  it('checks migration state without running DDL', () => {
    expect(isChatRouteExitSamplerMigrationApplied(db)).toBe(true);
    const bare = new Database(':memory:');
    try {
      expect(isChatRouteExitSamplerMigrationApplied(bare)).toBe(false);
      expect(bare.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_v2_route_exit_samples'",
      ).get()).toBeUndefined();
    } finally {
      bare.close();
    }
  });
});

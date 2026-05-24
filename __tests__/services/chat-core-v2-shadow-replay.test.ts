import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  CHAT_CORE_V2_SHADOW_REPLAY_VERSION,
  buildChatCoreV2ShadowReplayInput,
  listChatV2TraceSpansForTurn,
  planChatCoreV2ShadowTurn,
  recordChatCoreV2ShadowReplay,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const BASE = {
  turnId: 'turn_shadow_replay_1',
  tenantId: 'tenant_1',
  userId: 'user_1',
  now: new Date('2026-05-24T10:00:00.000Z'),
};

describe('Chat Core v2 shadow replay adapter', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('builds a deterministic replay input from a shadow plan', () => {
    const result = planChatCoreV2ShadowTurn({
      ...BASE,
      intent: 'create_action',
      confidence: 0.93,
      domains: ['tasks'],
      capabilityIds: ['tasks.create'],
    });

    const replay = buildChatCoreV2ShadowReplayInput({ result });

    expect(replay.replayBundleId).toMatch(/^chatv2-shadow-replay:/);
    expect(replay.turnId).toBe(result.turnId);
    expect(replay.routeDecision).toBe(result.routeDecision);
    expect(replay.toolSchemaSetVersion).toBe(result.toolSchemaSet.toolSchemaSetVersion);
    expect(replay.traceSpans).toEqual(result.traceSpans);
    expect(replay.sensitivity).toBe('personal');
    expect(replay.retentionPolicy).toBe('90d');
    expect(replay.response).toMatchObject({
      type: 'chat_core_v2_shadow_plan',
      shadowReplayVersion: CHAT_CORE_V2_SHADOW_REPLAY_VERSION,
      routeMethod: 'llm_command_translation',
      wouldExecute: false,
      wouldCallModel: true,
    });
  });

  it('uses short retention for financial or credential-adjacent shadow evidence', () => {
    const result = planChatCoreV2ShadowTurn({
      ...BASE,
      intent: 'unsafe_or_disallowed',
      confidence: 0.99,
      domains: ['finance'],
      capabilityIds: ['finance.payment_or_tax_action_blocked'],
      sensitivity: 'financial',
    });

    const replay = buildChatCoreV2ShadowReplayInput({ result });

    expect(replay.sensitivity).toBe('financial');
    expect(replay.retentionPolicy).toBe('30d');
  });

  it('records redacted shadow replay bundles and trace spans without raw provider context', () => {
    const result = planChatCoreV2ShadowTurn({
      ...BASE,
      intent: 'app_question',
      confidence: 0.94,
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
    });

    const saved = recordChatCoreV2ShadowReplay({
      result,
      contextPack: {
        messages: ['raw user/provider prompt should not persist'],
        apiKey: 'sk_secret_should_not_persist',
        visibleSummary: 'Task context summary.',
      },
      response: {
        type: 'message',
        text: 'You have two tasks today.',
        bearer: 'Bearer abcdefghijklmnop',
      },
      createdAt: '2026-05-24T10:00:02.000Z',
    }, db);

    const serialized = JSON.stringify(saved.replayBundle.bundle);
    expect(serialized).not.toContain('sk_secret_should_not_persist');
    expect(serialized).not.toContain('raw user/provider prompt should not persist');
    expect(serialized).not.toContain('Bearer abcdefghijklmnop');
    expect(saved.replayBundle.bundle?.contextPack).toMatchObject({
      messages: '[redacted]',
      apiKey: '[redacted]',
      visibleSummary: 'Task context summary.',
    });
    expect(saved.replayBundle.bundle?.response).toMatchObject({
      bearer: 'Bearer [redacted]',
    });
    expect(saved.traceSpans).toHaveLength(4);
    expect(listChatV2TraceSpansForTurn(result.turnId, db)).toHaveLength(4);
  });
});

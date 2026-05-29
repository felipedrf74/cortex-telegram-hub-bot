import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  evaluateChatCoreV2ShadowGateReadiness,
  runChatCoreV2ShadowRouteHook,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const ENABLED_ENV = {
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true',
  CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: 'gate-readiness-test-secret',
};

function seedSafeShadowTurns(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const result = runChatCoreV2ShadowRouteHook({
      normalizedText: `What is my next training session number ${i}?`,
      userId: 7,
      tenantId: 7,
      chatRequestId: `gate-turn-${i}`,
      userMessageId: `gate-msg-${i}`,
      clientMessageId: `gate-client-${i}`,
      locale: 'en',
      env: ENABLED_ENV,
      db,
    });
    expect(result.recorded).toBe(true);
  }
}

describe('Chat Core v2 shadow gate readiness', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('reports the gate NOT met below the row threshold and never claims completion', () => {
    seedSafeShadowTurns(3);

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);

    expect(readiness.rowCount).toBe(3);
    expect(readiness.schemaValidCount).toBe(3);
    expect(readiness.schemaValidPct).toBe(1);
    expect(readiness.safeShapeViolationCount).toBe(0);
    expect(readiness.meetsMinRows).toBe(false); // 3 < 50
    expect(readiness.meetsSchemaValidity).toBe(true);
    expect(readiness.meetsSafeShape).toBe(true);
    expect(readiness.recallAt8).toBe('requires_labeled_corpus');
    expect(readiness.gateMet).toBe(false);
    expect(readiness.notes).toContain('NOT met');
  });

  it('meets row/schema/shape thresholds at >=50 valid rows but still does not claim the gate (recall@8 pending)', () => {
    seedSafeShadowTurns(50);

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);

    expect(readiness.rowCount).toBe(50);
    expect(readiness.meetsMinRows).toBe(true);
    expect(readiness.meetsSchemaValidity).toBe(true);
    expect(readiness.meetsSafeShape).toBe(true);
    expect(readiness.gateMet).toBe(false); // structural thresholds met, recall@8 still required
    expect(readiness.notes).toContain('recall@8');
  });

  it('flags a shadow row that lacks the HMAC-hashed shape as a safe-shape violation', () => {
    seedSafeShadowTurns(1); // ensures the audit table exists + 1 clean row

    // Directly seed a crafted shadow-prefixed bundle whose contextPack carries a
    // raw message instead of an HMAC hash; the readiness report must catch it so
    // a privacy regression in the write path can never silently pass the gate.
    db.prepare(
      `INSERT INTO chat_v2_replay_bundles
        (replay_bundle_id, turn_id, sensitivity, retention_policy, redacted_bundle_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'chatv2-shadow-replay:crafted-unsafe',
      'crafted-unsafe',
      'normal',
      '90d',
      JSON.stringify({
        response: { type: 'chat_core_v2_shadow_plan', routeMethod: 'llm_command_translation', wouldExecute: false },
        contextPack: { hashVersion: 'hmac_sha256@1', message: 'raw private text that must never appear' },
      }),
      '2026-05-29T12:00:00.000Z',
    );

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);

    expect(readiness.rowCount).toBe(2);
    expect(readiness.safeShapeViolationCount).toBe(1);
    expect(readiness.meetsSafeShape).toBe(false);
    expect(readiness.gateMet).toBe(false);
  });
});

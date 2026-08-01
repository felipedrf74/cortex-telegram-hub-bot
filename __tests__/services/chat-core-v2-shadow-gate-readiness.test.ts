import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  evaluateChatCoreV2ShadowGateReadiness,
  runChatCoreV2ShadowRouteHook,
} from '../../src/services/chat-core-v2';
import { buildRoutingDivergenceShadowRecord } from '../../src/services/intent-resolution/divergence-shadow';
import { incrementSchemaCompliance } from '../../src/services/chat-core-v2/autorevert-counters-store';

let db: Database.Database;

const ENABLED_ENV = {
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true',
  CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: 'gate-readiness-test-secret',
};
const SCHEMA_NOW = new Date('2026-05-30T12:00:00.000Z');

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

function seedPlannerSchemaCompliance(passCount: number, failCount = 0): void {
  for (let i = 0; i < passCount; i += 1) {
    expect(incrementSchemaCompliance(db, 'tenant-7', { valid: true }, SCHEMA_NOW)).toBe(true);
  }
  for (let i = 0; i < failCount; i += 1) {
    expect(incrementSchemaCompliance(db, 'tenant-7', { valid: false }, SCHEMA_NOW)).toBe(true);
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
    seedPlannerSchemaCompliance(50);

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);

    expect(readiness.rowCount).toBe(3);
    expect(readiness.schemaSampleCount).toBe(50);
    expect(readiness.schemaValidCount).toBe(50);
    expect(readiness.schemaValidPct).toBe(1);
    expect(readiness.replayBundleSchemaValidCount).toBe(3);
    expect(readiness.replayBundleSchemaValidPct).toBe(1);
    expect(readiness.safeShapeViolationCount).toBe(0);
    expect(readiness.meetsMinRows).toBe(false); // 3 < 50
    expect(readiness.meetsSchemaValidity).toBe(true);
    expect(readiness.meetsReplayBundleSchemaValidity).toBe(true);
    expect(readiness.meetsSafeShape).toBe(true);
    expect(readiness.recallAt8).toBe('requires_labeled_corpus');
    expect(readiness.gateMet).toBe(false);
    expect(readiness.notes).toContain('NOT met');
  });

  it('does not satisfy schema readiness from replay rows when planner compliance samples are absent', () => {
    seedSafeShadowTurns(50);

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);

    expect(readiness.rowCount).toBe(50);
    expect(readiness.replayBundleSchemaValidCount).toBe(50);
    expect(readiness.meetsReplayBundleSchemaValidity).toBe(true);
    expect(readiness.schemaSampleCount).toBe(0);
    expect(readiness.schemaValidCount).toBe(0);
    expect(readiness.schemaInvalidCount).toBe(0);
    expect(readiness.schemaValidPct).toBe(0);
    expect(readiness.meetsSchemaValidity).toBe(false);
    expect(readiness.gateMet).toBe(false);
    expect(readiness.notes).toContain('planner schema');
  });

  it('fails schema readiness when planner compliance is 49 pass / 1 fail (<99%)', () => {
    seedSafeShadowTurns(50);
    seedPlannerSchemaCompliance(49, 1);

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);

    expect(readiness.schemaSampleCount).toBe(50);
    expect(readiness.schemaValidCount).toBe(49);
    expect(readiness.schemaInvalidCount).toBe(1);
    expect(readiness.schemaValidPct).toBeCloseTo(0.98, 10);
    expect(readiness.meetsSchemaValidity).toBe(false);
    expect(readiness.gateMet).toBe(false);
  });

  it('meets row/schema/shape thresholds at >=50 valid rows but still does not claim the gate (recall@8 pending)', () => {
    seedSafeShadowTurns(50);
    seedPlannerSchemaCompliance(50);

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);

    expect(readiness.rowCount).toBe(50);
    expect(readiness.meetsMinRows).toBe(true);
    expect(readiness.schemaSampleCount).toBe(50);
    expect(readiness.schemaValidCount).toBe(50);
    expect(readiness.meetsSchemaValidity).toBe(true);
    expect(readiness.meetsReplayBundleSchemaValidity).toBe(true);
    expect(readiness.meetsSafeShape).toBe(true);
    expect(readiness.gateMet).toBe(false); // structural thresholds met, recall@8 still required
    expect(readiness.notes).toContain('recall@8');
  });

  it('flags a shadow row that lacks the HMAC-hashed shape as a safe-shape violation', () => {
    seedSafeShadowTurns(1); // ensures the audit table exists + 1 clean row
    seedPlannerSchemaCompliance(50);

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

  it('accepts only the exact candidate-bound routing-divergence identity shape', () => {
    seedSafeShadowTurns(1);
    seedPlannerSchemaCompliance(50);

    const baseDivergence = {
      divergenceVersion: 'routing_divergence_shadow@2.0.0',
      resolverVersion: 'manifest-intent-resolver@1.0.0',
      releaseIdentity: {
        runtimeSha: 'a'.repeat(40),
        artifactDigest: 'b'.repeat(64),
        role: 'staging',
      },
      topCandidate: {
        capabilityId: 'secretary',
        domain: 'secretary',
        skill: 'create_task',
        rawScore: 2,
        matchedEvidenceCount: 2,
      },
      candidateCount: 1,
      surfaces: {
        classifierKeywordDomain: 'secretary',
        orchestratorPrimaryDomain: 'secretary',
        registryActionSkills: ['tasks'],
        shadowRouteIntent: 'create_action',
        shadowRouteDomains: ['tasks'],
      },
      agreement: {
        classifierKeyword: true,
        orchestratorPrimary: true,
        registrySubset: true,
        shadowRoute: true,
      },
    };
    const insert = db.prepare(
      `INSERT INTO chat_v2_replay_bundles
        (replay_bundle_id, turn_id, sensitivity, retention_policy, redacted_bundle_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const bundle = (routingDivergence: unknown) => JSON.stringify({
      response: {
        type: 'chat_core_v2_shadow_plan',
        routeMethod: 'llm_command_translation',
        wouldExecute: false,
      },
      contextPack: {
        hashVersion: 'hmac_sha256@1',
        messageHash: 'c'.repeat(64),
        routingDivergence,
      },
    });

    insert.run(
      'chatv2-shadow-replay:candidate-bound-safe',
      'candidate-bound-safe',
      'normal',
      '90d',
      bundle(baseDivergence),
      '2026-05-29T12:00:00.000Z',
    );
    insert.run(
      'chatv2-shadow-replay:candidate-bound-extra-key',
      'candidate-bound-extra-key',
      'normal',
      '90d',
      bundle({
        ...baseDivergence,
        releaseIdentity: {
          ...baseDivergence.releaseIdentity,
          deploymentLabel: 'untrusted-extra-field',
        },
      }),
      '2026-05-29T12:00:01.000Z',
    );
    insert.run(
      'chatv2-shadow-replay:candidate-bound-invalid-role',
      'candidate-bound-invalid-role',
      'normal',
      '90d',
      bundle({
        ...baseDivergence,
        releaseIdentity: { ...baseDivergence.releaseIdentity, role: 'development' },
      }),
      '2026-05-29T12:00:02.000Z',
    );

    const readiness = evaluateChatCoreV2ShadowGateReadiness(db);
    expect(readiness.rowCount).toBe(4);
    expect(readiness.safeShapeViolationCount).toBe(2);
    expect(readiness.meetsSafeShape).toBe(false);
  });

  it('accepts a divergence record actually produced by the shadow builder', () => {
    // Round-trip guard: the readiness allowlist and the record the runtime
    // emits must evolve together. Hand-built fixtures cannot catch a new
    // producer field, which silently turns every real bundle into a shape
    // violation and empties the Phase 7.1 evidence set.
    const produced = buildRoutingDivergenceShadowRecord(
      'add milk to my shopping list',
      { intent: 'create_action', domains: ['tasks'] },
      {
        env: {
          NEXUS_RELEASE_SHA: 'a'.repeat(40),
          NEXUS_RELEASE_ARTIFACT_SHA256: 'b'.repeat(64),
          NEXUS_RELEASE_ROLE: 'staging',
        },
      },
    );

    // One real hook turn creates the replay schema; the produced record is
    // then stored through the same column contract the runtime uses.
    seedSafeShadowTurns(1);
    db.prepare(
      `INSERT INTO chat_v2_replay_bundles
        (replay_bundle_id, turn_id, sensitivity, retention_policy, redacted_bundle_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'chatv2-shadow-replay:produced-record',
      'produced-record',
      'normal',
      '30d',
      JSON.stringify({
        response: {
          type: 'chat_core_v2_shadow_plan',
          routeMethod: 'llm_command_translation',
          wouldExecute: false,
        },
        contextPack: {
          hashVersion: 'hmac_sha256@1',
          messageHash: 'c'.repeat(64),
          routingDivergence: produced,
        },
      }),
      '2026-05-30T11:00:00.000Z',
    );

    expect(evaluateChatCoreV2ShadowGateReadiness(db).safeShapeViolationCount).toBe(0);
  });
});

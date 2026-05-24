import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  decideChatV2OnlineEvalSampling,
  ensureChatCoreV2OnlineEvalTables,
  getChatV2OnlineEvalSampleById,
  listChatV2OnlineEvalSamplesForTurn,
  recordChatV2OnlineEvalSample,
} from '../../src/services/chat-core-v2';

let db: Database.Database;

const baseInput = {
  turnId: 'turn-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  routeMethod: 'llm_command_translation' as const,
  risk: 'low' as const,
  sensitivity: 'personal' as const,
  domain: 'tasks' as const,
  replayBundleId: 'replay-1',
};

describe('Chat Core v2 online eval sampler', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates online eval sample table without raw prompt/provider columns', () => {
    ensureChatCoreV2OnlineEvalTables(db);

    const columns = db.prepare('PRAGMA table_info(chat_v2_online_eval_samples)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain('replay_bundle_id');
    expect(names).toContain('metadata_json');
    expect(names).not.toContain('raw_prompt');
    expect(names).not.toContain('provider_payload_json');
    expect(names).not.toContain('raw_bundle_json');
  });

  it('forces sampling for schema, fallback, verification, policy, and prompt-injection risk signals', () => {
    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      modelRunStatuses: ['schema_failed'],
    })).toMatchObject({ sample: true, reason: 'schema_failure', sampleRate: 1 });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      fallbackReason: 'v2_timeout',
    })).toMatchObject({ sample: true, reason: 'fallback', sampleRate: 1 });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      commandStatuses: ['verification_failed'],
    })).toMatchObject({ sample: true, reason: 'verification_failure', sampleRate: 1 });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      commandStatuses: ['rejected_by_policy'],
    })).toMatchObject({ sample: true, reason: 'policy_rejection', sampleRate: 1 });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      evidenceSignalCodes: ['prompt_injection_phrase'],
    })).toMatchObject({ sample: true, reason: 'prompt_injection_signal', sampleRate: 1 });
  });

  it('forces sampling for high-risk, restricted, finance, unsupported, and blocked turns', () => {
    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      risk: 'high',
    })).toMatchObject({ sample: true, reason: 'high_risk' });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      risk: 'restricted',
    })).toMatchObject({ sample: true, reason: 'restricted_risk' });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      domain: 'finance',
      sensitivity: 'financial',
    })).toMatchObject({ sample: true, reason: 'finance_sensitive' });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      routeMethod: 'unsupported',
    })).toMatchObject({ sample: true, reason: 'unsupported_or_blocked' });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      routeMethod: 'blocked',
    })).toMatchObject({ sample: true, reason: 'unsupported_or_blocked' });
  });

  it('uses deterministic baseline sampling for healthy turns', () => {
    const sampled = decideChatV2OnlineEvalSampling(baseInput, { baselineRate: 1, seed: 'stable' });
    const notSampled = decideChatV2OnlineEvalSampling(baseInput, { baselineRate: 0, seed: 'stable' });
    const repeated = decideChatV2OnlineEvalSampling(baseInput, { baselineRate: 1, seed: 'stable' });

    expect(sampled).toMatchObject({ sample: true, status: 'sampled', reason: 'baseline_random', sampleRate: 1 });
    expect(notSampled).toMatchObject({ sample: false, status: 'not_sampled', reason: 'not_sampled', sampleRate: 0 });
    expect(repeated).toEqual(sampled);
  });

  it('suppresses credential-adjacent turns unless explicitly allowed', () => {
    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      sensitivity: 'credential_adjacent',
      modelRunStatuses: ['schema_failed'],
    })).toMatchObject({
      sample: false,
      status: 'privacy_suppressed',
      reason: 'privacy_suppressed',
      sampleRate: 0,
    });

    expect(decideChatV2OnlineEvalSampling({
      ...baseInput,
      sensitivity: 'credential_adjacent',
      modelRunStatuses: ['schema_failed'],
    }, { allowCredentialAdjacent: true })).toMatchObject({
      sample: true,
      status: 'sampled',
      reason: 'schema_failure',
    });
  });

  it('records samples with redacted metadata and retry-safe upserts', () => {
    const decision = decideChatV2OnlineEvalSampling({
      ...baseInput,
      modelRunStatuses: ['schema_failed'],
    });
    const saved = recordChatV2OnlineEvalSample({
      ...baseInput,
      sampleId: 'sample-1',
      decision,
      metadata: {
        prompt: 'raw prompt must not persist',
        apiKey: 'sk-secret',
        routeConfidence: 0.92,
      },
      createdAt: '2026-05-24T10:00:00.000Z',
    }, db);

    expect(saved).toMatchObject({
      sampleId: 'sample-1',
      turnId: 'turn-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      replayBundleId: 'replay-1',
      routeMethod: 'llm_command_translation',
      domain: 'tasks',
      risk: 'low',
      sensitivity: 'personal',
      sample: true,
      status: 'sampled',
      reason: 'schema_failure',
      metadata: {
        prompt: '[redacted]',
        apiKey: '[redacted]',
        routeConfidence: 0.92,
      },
    });

    recordChatV2OnlineEvalSample({
      ...baseInput,
      sampleId: 'sample-1',
      decision: { ...decision, reason: 'fallback' },
      createdAt: '2026-05-24T10:00:01.000Z',
    }, db);

    const count = db.prepare('SELECT COUNT(*) as count FROM chat_v2_online_eval_samples WHERE sample_id = ?')
      .get('sample-1') as { count: number };
    const updated = getChatV2OnlineEvalSampleById('sample-1', db);
    expect(count.count).toBe(1);
    expect(updated?.reason).toBe('fallback');
    expect(updated?.createdAt).toBe('2026-05-24T10:00:01.000Z');
  });

  it('lists samples for a turn chronologically', () => {
    recordChatV2OnlineEvalSample({
      ...baseInput,
      sampleId: 'sample-2',
      decision: decideChatV2OnlineEvalSampling({ ...baseInput, modelRunStatuses: ['schema_failed'] }),
      createdAt: '2026-05-24T10:00:02.000Z',
    }, db);
    recordChatV2OnlineEvalSample({
      ...baseInput,
      sampleId: 'sample-1',
      decision: decideChatV2OnlineEvalSampling({ ...baseInput, fallbackReason: 'v2_timeout' }),
      createdAt: '2026-05-24T10:00:01.000Z',
    }, db);
    recordChatV2OnlineEvalSample({
      ...baseInput,
      turnId: 'turn-2',
      sampleId: 'other-turn',
      decision: decideChatV2OnlineEvalSampling({ ...baseInput, turnId: 'turn-2', fallbackReason: 'v2_timeout' }),
      createdAt: '2026-05-24T10:00:03.000Z',
    }, db);

    expect(listChatV2OnlineEvalSamplesForTurn('turn-1', db).map((sample) => sample.sampleId))
      .toEqual(['sample-1', 'sample-2']);
  });

  it('rejects invalid sampler metadata before SQLite checks', () => {
    expect(() => decideChatV2OnlineEvalSampling({
      ...baseInput,
      routeMethod: 'unknown' as typeof baseInput.routeMethod,
    })).toThrow(/route method/);

    expect(() => decideChatV2OnlineEvalSampling({
      ...baseInput,
      risk: 'unknown' as typeof baseInput.risk,
    })).toThrow(/risk/);

    expect(() => recordChatV2OnlineEvalSample({
      ...baseInput,
      sampleId: '',
    }, db)).toThrow(/sampleId/);
  });
});

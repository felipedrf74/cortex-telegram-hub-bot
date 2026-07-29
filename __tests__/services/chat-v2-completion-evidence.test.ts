// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNexusAnswerContract } from '../../src/services/chat-answer-contract';
import { buildChatShadowSampleEvidenceHash } from '../../src/services/chat-shadow-gate-readiness';
import {
  CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
  evaluateRecordedChatV2AnswerCanaryExit,
  evaluateRecordedChatV2ShadowGateReadiness,
  loadChatV2AnswerCanaryEvaluationInput,
  loadChatV2ShadowGateSamples,
  recordChatV2CompletionEvidence,
} from '../../src/services/chat-v2-completion-evidence';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

describe('chat-v2-completion-evidence', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/155_chatv2_completion_evidence.sql'), 'utf8'));
    testDb.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/156_chatv2_completion_evidence_source.sql'), 'utf8'));
    testDb.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/159_chatv2_cloud_allowlist_evidence.sql'), 'utf8'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CHAT_V2_EVIDENCE_HMAC_SECRET', 'test-evidence-hmac-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb.close();
  });

  it('stays dark by default when evidence flags are off', () => {
    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-dark',
      normalizedMessage: 'private message should not be stored',
      response: responseEnvelope(),
    });

    expect(rowCount()).toBe(0);
  });

  it('records shadow evidence with HMAC message IDs and no raw message text', () => {
    vi.stubEnv('CHAT_V2_SHADOW_EVIDENCE_ENABLED', 'true');
    const rawMessage = 'crie uma tarefa privada chamada comprar suplemento';

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-shadow',
      normalizedMessage: rawMessage,
      userLanguage: 'pt-BR',
      response: responseEnvelope({
        text: 'Tarefa verificada.',
        routeMethod: 'chat-reasoning-engine',
      }),
      firstProgressMs: 450,
    });

    expect(rowCount()).toBe(1);
    const row = testDb.prepare('SELECT * FROM chat_v2_completion_evidence').get() as any;
    expect(row.evidence_kind).toBe('shadow');
    expect(row.evidence_source).toBe('runtime_route');
    expect(row.message_hmac).toMatch(/^hmac:message:[a-f0-9]{64}$/);
    expect(row.message_identifier_kind).toBe('hmac');
    expect(JSON.stringify(row)).not.toContain(rawMessage);
    expect(row.raw_field_audit_count).toBe(0);
    expect(JSON.parse(row.safe_metadata_json)).toMatchObject({
      responseLocaleEvidence: {
        version: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
        effectiveLocale: 'pt-BR',
      },
    });

    const samples = loadChatV2ShadowGateSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0].sampleId).toMatch(/^hmac:message:[a-f0-9]{64}$/);
    expect(samples[0]).toMatchObject({
      language: 'pt-BR',
      finalCapabilityId: 'tasks.complete',
      messageIdentifierKind: 'hmac',
      storedRawMessageText: false,
      unsafeRawFieldCount: 0,
    });
    expect(samples[0].candidateCapabilities).toContain('tasks.complete');
    expect(samples[0].candidateEvidenceHash).toBe(buildChatShadowSampleEvidenceHash(samples[0]));
    const readiness = evaluateRecordedChatV2ShadowGateReadiness(10);
    expect(readiness.gates.find((gate) => gate.gateId === 'shadow_storage_privacy')).toMatchObject({
      passed: true,
      observed: 0,
    });
    expect(readiness.gates.find((gate) => gate.gateId === 'shadow_candidate_evidence_binding')).toMatchObject({
      passed: true,
      observed: 0,
    });
  });

  it('excludes local sandbox seed rows from readiness unless explicitly requested', () => {
    vi.stubEnv('CHAT_V2_SHADOW_EVIDENCE_ENABLED', 'true');

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-local-seed',
      normalizedMessage: 'local seed source probe',
      evidenceSource: 'local_sandbox_seed',
      userLanguage: 'en',
      response: responseEnvelope({
        text: 'Seed row.',
        routeMethod: 'local-chat-v2',
      }),
      firstProgressMs: 300,
    });

    expect(loadChatV2ShadowGateSamples()).toEqual([]);
    expect(loadChatV2ShadowGateSamples(10, ['local_sandbox_seed'])).toHaveLength(1);
  });

  it('loads only exact current response-locale evidence for EN, PT, and mixed gate buckets', () => {
    vi.stubEnv('CHAT_V2_SHADOW_EVIDENCE_ENABLED', 'true');
    const cases = [
      { requestId: 'current-en', userLanguage: 'en', responseLocale: 'en' },
      { requestId: 'current-pt', userLanguage: 'pt-BR', responseLocale: 'pt-BR' },
      { requestId: 'current-mixed', userLanguage: 'mixed', responseLocale: 'en' },
    ] as const;
    for (const testCase of cases) {
      recordChatV2CompletionEvidence({
        tenantId: 7,
        userId: 42,
        requestId: testCase.requestId,
        normalizedMessage: `message-${testCase.requestId}`,
        userLanguage: testCase.userLanguage,
        responseLocale: testCase.responseLocale,
        response: responseEnvelope({ text: `Response ${testCase.requestId}` }),
      });
    }

    expect(loadChatV2ShadowGateSamples(10).map((sample) => sample.language).sort()).toEqual([
      'en',
      'mixed',
      'pt-BR',
    ]);

    testDb.prepare(`
      UPDATE chat_v2_completion_evidence
      SET safe_metadata_json = '{}'
      WHERE request_id = 'current-en'
    `).run();
    expect(loadChatV2ShadowGateSamples(10).map((sample) => sample.language).sort()).toEqual([
      'mixed',
      'pt-BR',
    ]);
  });

  it('records canary evidence separately without inventing manual acceptance labels', () => {
    vi.stubEnv('CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED', 'true');

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-canary',
      normalizedMessage: 'What should I cook today?',
      userLanguage: 'en',
      response: responseEnvelope({
        text: 'Use a quick protein-heavy dinner.',
        domain: 'cooking',
        routeMethod: 'local-chat-v2',
        metadata: {
          ...responseEnvelope().metadata,
          finalAnswerComposition: {
            version: 'nexus_final_answer_composer.v1',
            ok: true,
            mode: 'templated',
          },
        },
      }),
      firstProgressMs: 1200,
    });

    const evidence = loadChatV2AnswerCanaryEvaluationInput();
    expect(evidence.acceptanceSamples).toEqual([]);
    expect(evidence.unsupportedClaimSamples).toEqual([]);
    expect(evidence.progressSamples).toEqual([{ sampleId: expect.stringMatching(/^hmac:message:[a-f0-9]{64}$/), firstProgressMs: 1200 }]);
    expect(evidence.privacySamples).toEqual([{ sampleId: expect.stringMatching(/^hmac:message:[a-f0-9]{64}$/), leakedRawPrivateField: false }]);
    expect(evidence.compositionSamples).toEqual([{ sampleId: expect.stringMatching(/^hmac:message:[a-f0-9]{64}$/), mode: 'templated' }]);
    expect(evaluateRecordedChatV2AnswerCanaryExit().gates.find((gate) => gate.gateId === 'answer_acceptance_by_language')).toMatchObject({
      passed: false,
      reasonCode: 'missing_required_language_samples',
    });
  });

  it('audits cloud allowlist packets from safe metadata without storing or sending raw chat text', () => {
    vi.stubEnv('CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED', 'true');
    vi.stubEnv('CHAT_V2_CLOUD_ALLOWLIST_EVIDENCE_ENABLED', 'true');
    const rawMessage = 'What is a safe focus tip with private wording?';

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-cloud-packet-audit',
      normalizedMessage: rawMessage,
      userLanguage: 'en',
      response: responseEnvelope({
        text: 'Start with one short focus block.',
        domain: 'chat',
        routeMethod: 'local-chat-v2',
        metadata: {
          chatReasoning: buildNexusAnswerContract({
            intent: 'chat.general_answer',
            ownerSkill: 'chat',
            routeMethod: 'local-chat-v2',
            routeKind: 'generic_skill_answer',
            groundingRequirement: 'none',
            language: 'en',
            actionability: 'answer_only',
            verificationStatus: 'not_required',
            expectedResponseShape: 'direct_answer',
            confidence: 0.92,
            traceId: 'trace-cloud-packet-audit',
          }),
          finalAnswerComposition: {
            version: 'nexus_final_answer_composer.v1',
            ok: true,
            mode: 'model_constrained',
          },
        },
      }),
      firstProgressMs: 400,
    });

    const row = testDb.prepare('SELECT * FROM chat_v2_cloud_allowlist_evidence').get() as any;
    expect(row).toMatchObject({
      evidence_source: 'runtime_route',
      sent_to_cloud: 0,
      denied: 0,
      raw_private_field_count: 0,
      non_hmac_entity_id_count: 0,
      non_hmac_evidence_fingerprint_count: 0,
    });
    expect(row.hmac_entity_id_count).toBeGreaterThan(0);
    expect(row.hmac_evidence_fingerprint_count).toBeGreaterThan(0);
    expect(JSON.stringify(row)).not.toContain(rawMessage);
  });

  it('records observable cloud allowlist denial rows for private/action contracts', () => {
    vi.stubEnv('CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED', 'true');
    vi.stubEnv('CHAT_V2_CLOUD_ALLOWLIST_EVIDENCE_ENABLED', 'true');

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-cloud-denied-action',
      normalizedMessage: 'mark my private task done',
      userLanguage: 'en',
      response: responseEnvelope(),
      firstProgressMs: 400,
    });

    const row = testDb.prepare('SELECT * FROM chat_v2_cloud_allowlist_evidence').get() as any;
    expect(row).toMatchObject({
      evidence_source: 'runtime_route',
      sent_to_cloud: 0,
      denied: 1,
      denial_reason_observable: 1,
      denial_reason: 'required_fact_never_cloud',
      raw_private_field_count: 0,
    });
    expect(JSON.stringify(row)).not.toContain('mark my private task done');
  });

  it('records unsupported-claim critic samples only for explicit probes or detected issues', () => {
    vi.stubEnv('CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED', 'true');

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-unsupported-probe',
      normalizedMessage: 'unsupported claim probe',
      userLanguage: 'en',
      unsupportedClaimProbe: true,
      response: responseEnvelope({
        text: 'I marked the task done.',
        routeMethod: 'local-chat-v2',
        metadata: {
          ...responseEnvelope().metadata,
          chatReasoning: buildNexusAnswerContract({
            intent: 'tasks.complete',
            ownerSkill: 'tasks',
            routeMethod: 'local-chat-v2',
            routeKind: 'action',
            language: 'en',
            actionability: 'answer_only',
            verificationStatus: 'unverified',
            expectedResponseShape: 'confirmation',
            confidence: 0.8,
            traceId: 'trace-unsupported-probe',
          }),
        },
      }),
      firstProgressMs: 700,
    });

    const evidence = loadChatV2AnswerCanaryEvaluationInput();
    expect(evidence.unsupportedClaimSamples).toEqual([{
      sampleId: expect.stringMatching(/^hmac:message:[a-f0-9]{64}$/),
      caughtByDeterministicCritic: true,
    }]);
  });

  it('does not count probe attempts as unsupported-claim samples when no issue was observed', () => {
    vi.stubEnv('CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED', 'true');

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-normal-answer',
      normalizedMessage: 'normal answer row',
      userLanguage: 'en',
      response: responseEnvelope({
        text: 'Use a short checklist before starting.',
        routeMethod: 'local-chat-v2',
        metadata: {
          ...responseEnvelope().metadata,
          chatReasoning: buildNexusAnswerContract({
            intent: 'general_chat',
            ownerSkill: 'general',
            routeMethod: 'local-chat-v2',
            routeKind: 'answer',
            language: 'en',
            actionability: 'answer_only',
            verificationStatus: 'not_required',
            expectedResponseShape: 'plain_text',
            confidence: 0.8,
            traceId: 'trace-normal-answer',
          }),
        },
      }),
      firstProgressMs: 800,
    });

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-unsupported-probe-miss',
      normalizedMessage: 'unsupported claim probe miss',
      userLanguage: 'en',
      unsupportedClaimProbe: true,
      response: responseEnvelope({
        text: 'Use a short checklist before starting.',
        routeMethod: 'local-chat-v2',
        metadata: {
          ...responseEnvelope().metadata,
          chatReasoning: buildNexusAnswerContract({
            intent: 'general_chat',
            ownerSkill: 'general',
            routeMethod: 'local-chat-v2',
            routeKind: 'answer',
            language: 'en',
            actionability: 'answer_only',
            verificationStatus: 'not_required',
            expectedResponseShape: 'plain_text',
            confidence: 0.8,
            traceId: 'trace-unsupported-probe-miss',
          }),
        },
      }),
      firstProgressMs: 800,
    });

    const evidence = loadChatV2AnswerCanaryEvaluationInput();
    expect(evidence.unsupportedClaimSamples).toEqual([]);
  });

  it('counts repaired response-quality metadata as an unsupported-claim critic catch', () => {
    vi.stubEnv('CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED', 'true');

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-repaired-unsupported-probe',
      normalizedMessage: 'unsupported claim repair probe',
      userLanguage: 'en',
      unsupportedClaimProbe: true,
      response: responseEnvelope({
        text: 'I did not claim success without readback verification.',
        routeMethod: 'local-chat-v2',
        metadata: {
          ...responseEnvelope().metadata,
          chatReasoning: buildNexusAnswerContract({
            intent: 'tasks.complete',
            ownerSkill: 'tasks',
            routeMethod: 'local-chat-v2',
            routeKind: 'action',
            language: 'en',
            actionability: 'clarify',
            verificationStatus: 'pending',
            expectedResponseShape: 'confirmation',
            confidence: 0.8,
            traceId: 'trace-repaired-unsupported-probe',
          }),
          responseQuality: {
            status: 'repaired',
            issues: ['unverified_success_claim'],
            score: 0.8,
          },
        },
      }),
      firstProgressMs: 700,
    });

    const evidence = loadChatV2AnswerCanaryEvaluationInput();
    expect(evidence.unsupportedClaimSamples).toEqual([{
      sampleId: expect.stringMatching(/^hmac:message:[a-f0-9]{64}$/),
      caughtByDeterministicCritic: true,
    }]);
  });

  it('does not record unsupported-claim probes as ordinary shadow samples', () => {
    vi.stubEnv('CHAT_V2_SHADOW_EVIDENCE_ENABLED', 'true');
    vi.stubEnv('CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED', 'true');

    recordChatV2CompletionEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-probe-not-shadow',
      normalizedMessage: 'unsupported claim probe should not pollute shadow',
      userLanguage: 'en',
      unsupportedClaimProbe: true,
      response: responseEnvelope({
        text: 'I did not claim success without readback verification.',
        routeMethod: 'local-chat-v2',
        metadata: {
          ...responseEnvelope().metadata,
          responseQuality: {
            status: 'repaired',
            issues: ['unverified_success_claim'],
            score: 0.8,
          },
        },
      }),
      firstProgressMs: 700,
    });

    expect(testDb.prepare('SELECT evidence_kind, COUNT(*) AS count FROM chat_v2_completion_evidence GROUP BY evidence_kind').all()).toEqual([
      { evidence_kind: 'answer_canary', count: 1 },
    ]);
  });
});

function rowCount(): number {
  return (testDb.prepare('SELECT COUNT(*) AS count FROM chat_v2_completion_evidence').get() as { count: number }).count;
}

function responseEnvelope(overrides: Record<string, unknown> = {}) {
  const contract = buildNexusAnswerContract({
    intent: 'tasks.complete',
    ownerSkill: 'tasks',
    routeMethod: String(overrides.routeMethod ?? 'chat-reasoning-engine'),
    routeKind: 'action',
    language: 'pt',
    actionability: 'execute',
    verificationStatus: 'verified',
    expectedResponseShape: 'task_options',
    confidence: 0.94,
    traceId: 'trace-test',
  });
  return {
    id: 'msg-test-response',
    text: 'Done.',
    domain: 'secretary',
    routeMethod: 'chat-reasoning-engine',
    confidence: 0.94,
    metadata: {
      type: 'chat_action_verified_success',
      chatReasoning: contract,
      finalAnswerComposition: {
        version: 'nexus_final_answer_composer.v1',
        ok: true,
        mode: 'model_constrained',
      },
    },
    ...overrides,
  };
}

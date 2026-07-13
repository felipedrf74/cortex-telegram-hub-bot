// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNexusAnswerContract } from '../../src/services/chat-answer-contract';
import {
  evaluateRecordedChatV2DeterministicReadReadiness,
  loadChatV2DeterministicReadEvaluationInput,
  recordChatV2DeterministicReadEvidence,
} from '../../src/services/chat-deterministic-read-evidence';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

describe('chat-deterministic-read-evidence', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/157_chatv2_deterministic_read_evidence.sql'), 'utf8'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CHAT_V2_EVIDENCE_HMAC_SECRET', 'test-deterministic-read-evidence-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb.close();
  });

  it('stays dark by default when deterministic-read evidence is disabled', () => {
    recordChatV2DeterministicReadEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-dark',
      normalizedMessage: '/today',
      response: responseEnvelope(),
      tokenZeroSurface: 'slash',
    });

    expect(rowCount()).toBe(0);
  });

  it('records HMAC-only deterministic-read and token-zero evidence when enabled', () => {
    vi.stubEnv('CHAT_V2_DETERMINISTIC_READ_EVIDENCE_ENABLED', 'true');
    const rawMessage = '/tasks private supplement list';

    recordChatV2DeterministicReadEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-read',
      normalizedMessage: rawMessage,
      response: responseEnvelope({
        text: 'You have three tasks.',
        routeMethod: 'fast-path',
      }),
      tokenZeroSurface: 'slash',
    });

    expect(rowCount()).toBe(2);
    const rows = testDb.prepare('SELECT * FROM chat_v2_deterministic_read_evidence ORDER BY evidence_kind').all() as any[];
    expect(rows.map((row) => row.evidence_kind)).toEqual(['deterministic_read', 'token_zero_surface']);
    for (const row of rows) {
      expect(row.evidence_source).toBe('runtime_route');
      expect(row.sample_hmac).toMatch(/^hmac:(deterministic-read|token-zero-read):[a-f0-9]{64}$/);
      expect(row.sample_identifier_kind).toBe('hmac');
      expect(JSON.stringify(row)).not.toContain(rawMessage);
      expect(row.raw_field_audit_count).toBe(0);
      expect(row.response_contract_valid).toBe(1);
      expect(row.tenant_user_isolation_passed).toBe(1);
    }

    const input = loadChatV2DeterministicReadEvaluationInput();
    expect(input.readSamples).toHaveLength(1);
    expect(input.tokenZeroSamples).toEqual([
      { sampleId: rows[0].sample_hmac, surface: 'slash', preserved: true },
    ]);
  });

  it('excludes local sandbox seed rows from readiness unless explicitly requested', () => {
    vi.stubEnv('CHAT_V2_DETERMINISTIC_READ_EVIDENCE_ENABLED', 'true');

    recordChatV2DeterministicReadEvidence({
      tenantId: 7,
      userId: 42,
      requestId: 'req-local-seed',
      normalizedMessage: '/today',
      evidenceSource: 'local_sandbox_seed',
      response: responseEnvelope(),
      tokenZeroSurface: 'slash',
    });

    expect(loadChatV2DeterministicReadEvaluationInput().readSamples).toEqual([]);
    expect(loadChatV2DeterministicReadEvaluationInput(10, ['local_sandbox_seed']).readSamples).toHaveLength(1);
  });

  it('evaluates deterministic-read readiness from recorded local seed rows', () => {
    vi.stubEnv('CHAT_V2_DETERMINISTIC_READ_EVIDENCE_ENABLED', 'true');

    for (const surface of ['slash', 'button', 'api'] as const) {
      recordChatV2DeterministicReadEvidence({
        tenantId: 7,
        userId: 42,
        requestId: `req-${surface}`,
        normalizedMessage: `/${surface}`,
        evidenceSource: 'local_sandbox_seed',
        response: responseEnvelope(),
        tokenZeroSurface: surface,
      });
    }

    const result = evaluateRecordedChatV2DeterministicReadReadiness(10, ['local_sandbox_seed']);
    expect(result.passed).toBe(true);
    expect(result.tokenZeroResults).toEqual([
      { surface: 'slash', preserved: 1, total: 1, passed: true },
      { surface: 'button', preserved: 1, total: 1, passed: true },
      { surface: 'api', preserved: 1, total: 1, passed: true },
    ]);
  });
});

function rowCount(): number {
  return (testDb.prepare('SELECT COUNT(*) AS count FROM chat_v2_deterministic_read_evidence').get() as { count: number }).count;
}

function responseEnvelope(overrides: Record<string, unknown> = {}) {
  const routeMethod = String(overrides.routeMethod ?? 'fast-path');
  const contract = buildNexusAnswerContract({
    intent: 'tasks.read',
    ownerSkill: 'tasks',
    routeMethod,
    routeKind: 'local_read',
    language: 'en',
    actionability: 'answer_only',
    verificationStatus: 'not_required',
    expectedResponseShape: 'task_options',
    confidence: 1,
    traceId: 'trace-deterministic-read-test',
  });
  return {
    id: 'msg-deterministic-read-test',
    text: 'Here is the deterministic read.',
    domain: 'secretary',
    routeMethod,
    confidence: 1,
    metadata: {
      type: 'deterministic_read',
      chatReasoning: contract,
    },
    ...overrides,
  };
}

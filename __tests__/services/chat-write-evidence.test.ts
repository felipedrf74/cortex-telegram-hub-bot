// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateRecordedChatV2WriteReadiness,
  loadChatV2WriteReadinessInput,
  recordChatV2WriteEvidence,
} from '../../src/services/chat-write-evidence';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

describe('chat-write-evidence', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/158_chatv2_write_evidence.sql'), 'utf8'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CHAT_V2_EVIDENCE_HMAC_SECRET', 'test-write-evidence-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb.close();
  });

  it('stays dark by default when write evidence is disabled', () => {
    recordChatV2WriteEvidence(sampleInput({ sampleKey: 'private task title' }));

    expect(rowCount()).toBe(0);
  });

  it('records HMAC-only write preview evidence when enabled', () => {
    vi.stubEnv('CHAT_V2_WRITE_EVIDENCE_ENABLED', 'true');
    const rawSampleKey = 'private task title';

    recordChatV2WriteEvidence(sampleInput({
      sampleKey: rawSampleKey,
      safeMetadata: {
        capabilityId: 'tasks.create',
      },
    }));

    expect(rowCount()).toBe(1);
    const row = testDb.prepare('SELECT * FROM chat_v2_write_evidence').get() as any;
    expect(row.evidence_source).toBe('runtime_route');
    expect(row.sample_hmac).toMatch(/^hmac:write:[a-f0-9]{64}$/);
    expect(row.sample_identifier_kind).toBe('hmac');
    expect(row.preview_valid).toBe(1);
    expect(row.diff_required).toBe(1);
    expect(row.visible_diff_present).toBe(1);
    expect(row.raw_field_audit_count).toBe(0);
    expect(JSON.stringify(row)).not.toContain(rawSampleKey);
  });

  it('excludes local sandbox seed rows from readiness unless explicitly requested', () => {
    vi.stubEnv('CHAT_V2_WRITE_EVIDENCE_ENABLED', 'true');

    recordChatV2WriteEvidence(sampleInput({
      evidenceSource: 'local_sandbox_seed',
    }));

    expect(loadChatV2WriteReadinessInput('write_preview').samples).toEqual([]);
    expect(loadChatV2WriteReadinessInput('write_preview', 10, ['local_sandbox_seed']).samples).toHaveLength(1);
  });

  it('evaluates confirmed write readiness from recorded local seed rows', () => {
    vi.stubEnv('CHAT_V2_WRITE_EVIDENCE_ENABLED', 'true');

    recordChatV2WriteEvidence(sampleInput({
      evidenceSource: 'local_sandbox_seed',
      phase: 'confirmed_writes',
      sampleKey: 'task-complete',
      executed: true,
      successClaimed: true,
      verificationStatus: 'verified',
    }));
    recordChatV2WriteEvidence(sampleInput({
      evidenceSource: 'local_sandbox_seed',
      phase: 'confirmed_writes',
      sampleKey: 'training-change',
      riskClass: 'C',
      executed: true,
      successClaimed: false,
      verificationStatus: 'indeterminate',
      escalatedPerPolicy: true,
    }));

    const result = evaluateRecordedChatV2WriteReadiness('confirmed_writes', 10, ['local_sandbox_seed']);
    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['class_a_preview_cards', true],
      ['zero_unvalidated_executions', true],
      ['diff_required_cards_have_visible_diffs', true],
      ['no_success_claim_without_verified_readback', true],
      ['class_c_escalation_policy', true],
      ['idempotency_retry_cancel', true],
    ]);
  });
});

function rowCount(): number {
  return (testDb.prepare('SELECT COUNT(*) AS count FROM chat_v2_write_evidence').get() as { count: number }).count;
}

function sampleInput(overrides: Partial<Parameters<typeof recordChatV2WriteEvidence>[0]> = {}): Parameters<typeof recordChatV2WriteEvidence>[0] {
  return {
    tenantId: 7,
    userId: 42,
    requestId: 'req-write',
    sampleKey: 'task-create',
    phase: 'write_preview',
    riskClass: 'A',
    previewValid: true,
    diffRequired: true,
    visibleDiffPresent: true,
    executed: false,
    validatedBeforeExecution: true,
    successClaimed: false,
    verificationStatus: 'not_required',
    escalatedPerPolicy: true,
    idempotencyPassed: true,
    retryCancelPassed: true,
    ...overrides,
  };
}

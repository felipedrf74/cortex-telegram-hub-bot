// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateRecordedChatV2CloudAllowlistReadiness,
  loadChatV2CloudAllowlistReadinessInput,
  recordChatV2CloudAllowlistEvidence,
} from '../../src/services/chat-cloud-allowlist-evidence';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

describe('chat-cloud-allowlist-evidence', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations/159_chatv2_cloud_allowlist_evidence.sql'), 'utf8'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CHAT_V2_EVIDENCE_HMAC_SECRET', 'test-cloud-allowlist-evidence-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb.close();
  });

  it('stays dark by default when cloud allowlist evidence is disabled', () => {
    recordChatV2CloudAllowlistEvidence(sampleInput({ sampleKey: 'raw private phrase' }));

    expect(rowCount()).toBe(0);
  });

  it('records packet-only HMAC evidence when enabled', () => {
    vi.stubEnv('CHAT_V2_CLOUD_ALLOWLIST_EVIDENCE_ENABLED', 'true');
    const rawSampleKey = 'raw private phrase';

    recordChatV2CloudAllowlistEvidence(sampleInput({
      sampleKey: rawSampleKey,
      sentToCloud: true,
      denied: false,
      denialReasonObservable: false,
      hmacEntityIdCount: 1,
      hmacEvidenceFingerprintCount: 2,
      safeMetadata: {
        capabilityId: 'tasks.read',
      },
    }));

    expect(rowCount()).toBe(1);
    const row = testDb.prepare('SELECT * FROM chat_v2_cloud_allowlist_evidence').get() as any;
    expect(row.evidence_source).toBe('runtime_route');
    expect(row.sample_hmac).toMatch(/^hmac:cloud-allowlist:[a-f0-9]{64}$/);
    expect(row.sample_identifier_kind).toBe('hmac');
    expect(row.sent_to_cloud).toBe(1);
    expect(row.raw_private_field_count).toBe(0);
    expect(row.hmac_entity_id_count).toBe(1);
    expect(row.non_hmac_entity_id_count).toBe(0);
    expect(JSON.stringify(row)).not.toContain(rawSampleKey);
  });

  it('excludes local sandbox seed rows from readiness unless explicitly requested', () => {
    vi.stubEnv('CHAT_V2_CLOUD_ALLOWLIST_EVIDENCE_ENABLED', 'true');

    recordChatV2CloudAllowlistEvidence(sampleInput({
      evidenceSource: 'local_sandbox_seed',
      sentToCloud: true,
      denied: false,
      denialReasonObservable: false,
      hmacEntityIdCount: 1,
      hmacEvidenceFingerprintCount: 1,
    }));

    expect(loadChatV2CloudAllowlistReadinessInput().packetSamples).toEqual([]);
    expect(loadChatV2CloudAllowlistReadinessInput(10, ['local_sandbox_seed']).packetSamples).toHaveLength(1);
  });

  it('evaluates local cloud allowlist readiness with low usage and observable denials', () => {
    vi.stubEnv('CHAT_V2_CLOUD_ALLOWLIST_EVIDENCE_ENABLED', 'true');

    recordChatV2CloudAllowlistEvidence(sampleInput({
      evidenceSource: 'local_sandbox_seed',
      sampleKey: 'sent-packet',
      sentToCloud: true,
      denied: false,
      denialReasonObservable: false,
      hmacEntityIdCount: 1,
      hmacEvidenceFingerprintCount: 1,
    }));
    for (let index = 0; index < 99; index++) {
      recordChatV2CloudAllowlistEvidence(sampleInput({
        evidenceSource: 'local_sandbox_seed',
        sampleKey: `denied-${index}`,
        sentToCloud: false,
        denied: true,
        denialReason: 'insufficient_safe_context_for_cloud',
        denialReasonObservable: true,
      }));
    }

    const result = evaluateRecordedChatV2CloudAllowlistReadiness(100, ['local_sandbox_seed']);
    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => [gate.gateId, gate.passed])).toEqual([
      ['cloud_usage_share', true],
      ['zero_raw_private_cloud_fields', true],
      ['cloud_denial_reasons_observable', true],
      ['cloud_hmac_only_identifiers', true],
    ]);
  });
});

function rowCount(): number {
  return (testDb.prepare('SELECT COUNT(*) AS count FROM chat_v2_cloud_allowlist_evidence').get() as { count: number }).count;
}

function sampleInput(
  overrides: Partial<Parameters<typeof recordChatV2CloudAllowlistEvidence>[0]> = {},
): Parameters<typeof recordChatV2CloudAllowlistEvidence>[0] {
  return {
    tenantId: 7,
    userId: 42,
    requestId: 'req-cloud',
    sampleKey: 'cloud-sample',
    sentToCloud: false,
    rawPrivateFieldCount: 0,
    denied: true,
    denialReason: 'insufficient_safe_context_for_cloud',
    denialReasonObservable: true,
    hmacEntityIdCount: 0,
    nonHmacEntityIdCount: 0,
    hmacEvidenceFingerprintCount: 0,
    nonHmacEvidenceFingerprintCount: 0,
    ...overrides,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import {
  claimReceiptAiTransferExecution,
  completeReceiptAiTransferExecution,
  computeReceiptAiTransferDigest,
  failReceiptAiTransferExecution,
  pruneExpiredReceiptAiTransferResponses,
  type ReceiptAiTransferConsent,
} from '../../src/services/receipt-ai-transfer-consent';

const protectionSecret = 'receipt-transfer-test-protection-secret-at-least-32-bytes';

function consentFor(
  consentReceiptId: string,
  computedTransferDigest: string,
): ReceiptAiTransferConsent {
  return {
    granted: true,
    disclosureVersion: 'receipt-ai-transfer-v1',
    scope: 'receipt_image_and_ocr_to_configured_ai_providers',
    consentReceiptId,
    transferDigest: computedTransferDigest,
  };
}

function claimAndComplete(input: {
  tenantId: number;
  userId: number;
  consentReceiptId: string;
  responseMarker: string;
}): string {
  const computedTransferDigest = computeReceiptAiTransferDigest({
    imageBytes: Buffer.from(`image:${input.responseMarker}`),
    mimeType: 'IMAGE/JPG',
    ocrHint: `Receipt\r\n${input.responseMarker}`,
  });
  expect(claimReceiptAiTransferExecution({
    tenantId: input.tenantId,
    userId: input.userId,
    actorId: input.userId,
    consent: consentFor(input.consentReceiptId, computedTransferDigest),
    computedTransferDigest,
    protectionSecret,
  }, testDb).state).toBe('claimed');
  completeReceiptAiTransferExecution({
    tenantId: input.tenantId,
    userId: input.userId,
    consentReceiptId: input.consentReceiptId,
    computedTransferDigest,
    responseData: { marker: input.responseMarker },
    protectionSecret,
  }, testDb);
  return computedTransferDigest;
}

describe('receipt AI transfer consent execution', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    testDb.close();
  });

  it('pins the decoded-byte, canonical-MIME, normalized-OCR cross-platform digest', () => {
    const expected = 'e6bf61b48f337b70991028f47c2b6b278456e616415281f9b1483f1de6800785';
    expect(computeReceiptAiTransferDigest({
      imageBytes: Buffer.from('Y2FwdHVyZS0x', 'base64'),
      mimeType: ' IMAGE/JPG ',
      ocrHint: 'Market\r\nTotal €12.34',
    })).toBe(expected);
    expect(computeReceiptAiTransferDigest({
      imageBytes: Buffer.from('capture-1'),
      mimeType: 'image/jpeg',
      ocrHint: 'Market\nTotal €12.34',
    })).toBe(expected);
    expect(computeReceiptAiTransferDigest({
      imageBytes: Buffer.from('capture-1'),
      mimeType: 'image/jpeg',
      ocrHint: ' Market\nTotal €12.34\n',
    })).not.toBe(expected);
  });

  it('supports legitimate tenant/user pairs without weakening tuple isolation', () => {
    const digest = computeReceiptAiTransferDigest({
      imageBytes: Buffer.from('same image'),
      mimeType: 'image/jpeg',
    });
    const receipt = '90c9ef4c-a989-45e0-b96a-ed6808cb34d7';
    for (const [tenantId, userId] of [[41, 7], [42, 7], [41, 8]] as const) {
      expect(claimReceiptAiTransferExecution({
        tenantId,
        userId,
        actorId: userId,
        consent: consentFor(receipt, digest),
        computedTransferDigest: digest,
        protectionSecret,
      }, testDb).state).toBe('claimed');
    }
    expect(testDb.prepare(`
      SELECT tenant_id AS tenantId, user_id AS userId
        FROM receipt_ai_transfer_executions
       ORDER BY tenant_id, user_id
    `).all()).toEqual([
      { tenantId: 41, userId: 7 },
      { tenantId: 41, userId: 8 },
      { tenantId: 42, userId: 7 },
    ]);
  });

  it('scrubs every expired encrypted response in scope and globally while retaining spend guards', () => {
    claimAndComplete({
      tenantId: 51,
      userId: 9,
      consentReceiptId: '377d38ee-ef6a-4f33-b003-f0c7bec89d7e',
      responseMarker: 'first-private-result',
    });
    claimAndComplete({
      tenantId: 52,
      userId: 9,
      consentReceiptId: 'd4711629-589b-4d2e-94ef-7e8c0108dbb0',
      responseMarker: 'second-private-result',
    });
    testDb.prepare(`
      UPDATE receipt_ai_transfer_executions
         SET response_expires_at = datetime('now', '-1 minute')
    `).run();

    expect(pruneExpiredReceiptAiTransferResponses({ tenantId: 51, userId: 9 }, testDb)).toBe(1);
    expect(testDb.prepare(`
      SELECT status, response_ciphertext AS ciphertext
        FROM receipt_ai_transfer_executions
       WHERE tenant_id = 51 AND user_id = 9
    `).get()).toEqual({ status: 'completed', ciphertext: null });
    expect(testDb.prepare(`
      SELECT response_ciphertext IS NOT NULL AS retained
        FROM receipt_ai_transfer_executions
       WHERE tenant_id = 52 AND user_id = 9
    `).get()).toEqual({ retained: 1 });

    expect(pruneExpiredReceiptAiTransferResponses({}, testDb)).toBe(1);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count,
             SUM(response_ciphertext IS NOT NULL) AS ciphertextCount
        FROM receipt_ai_transfer_executions
    `).get()).toEqual({ count: 2, ciphertextCount: 0 });
  });

  it('maps arbitrary provider failure text to stable allowlisted durable metadata', () => {
    const marker = 'PRIVATE_PROVIDER_REQUEST_AND_RESPONSE_MARKER';
    const tenantId = 61;
    const userId = 10;
    const consentReceiptId = '3a3ce0bf-f3fe-496a-89ca-200f7622a614';
    const digest = computeReceiptAiTransferDigest({
      imageBytes: Buffer.from('failed-image'),
      mimeType: 'image/jpeg',
    });
    const consent = consentFor(consentReceiptId, digest);
    expect(claimReceiptAiTransferExecution({
      tenantId,
      userId,
      actorId: userId,
      consent,
      computedTransferDigest: digest,
      protectionSecret,
    }, testDb).state).toBe('claimed');

    failReceiptAiTransferExecution({
      tenantId,
      userId,
      consentReceiptId,
      computedTransferDigest: digest,
      protectionSecret,
      error: { code: 'PROVIDER_RAW_FAILURE', message: marker, status: 502 },
    }, testDb);

    const row = testDb.prepare(`
      SELECT error_code AS code, error_message AS message, error_status AS status
        FROM receipt_ai_transfer_executions
       WHERE tenant_id = ? AND user_id = ?
    `).get(tenantId, userId);
    expect(row).toEqual({
      code: 'RECEIPT_AI_ANALYSIS_FAILED',
      message: 'Receipt analysis failed.',
      status: 500,
    });
    expect(JSON.stringify(row)).not.toContain(marker);

    const replay = claimReceiptAiTransferExecution({
      tenantId,
      userId,
      actorId: userId,
      consent,
      computedTransferDigest: digest,
      protectionSecret,
    }, testDb);
    expect(replay).toMatchObject({
      state: 'failed',
      error: {
        code: 'RECEIPT_AI_ANALYSIS_FAILED',
        message: 'Receipt analysis failed.',
        status: 500,
      },
    });
  });

  it('wires global encrypted-response housekeeping into startup', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf8');
    expect(source).toContain('pruneExpiredReceiptAiTransferResponses()');
    expect(source).toContain('receipt_ai_replay_retention_housekeeping_failed');
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';

export interface FiscalBundleSendRow {
  id: number;
  tenant_id: number;
  user_id: number;
  period_start: string;
  period_end: string;
  sent_at: string;
  document_count: number;
  total_bytes: number;
  idempotency_key: string;
  result_json: string | null;
  created_at: string;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} required: must be a positive integer`);
  }
}

export function normalizeFiscalBundleIdempotencyKey(
  tenantId: number,
  userId: number,
  periodStart: string,
  periodEnd: string,
  idempotencyKey?: string | null,
): string {
  const explicit = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
  if (explicit) return explicit.slice(0, 160);
  return `fiscal_bundle:${tenantId}:${userId}:${periodStart}:${periodEnd}`;
}

export function findFiscalBundleSendByIdempotencyKey(
  tenantId: number,
  userId: number,
  idempotencyKey: string,
): FiscalBundleSendRow | null {
  assertPositiveId(tenantId, 'tenantId');
  assertPositiveId(userId, 'userId');
  return (
    getDb().prepare(`
      SELECT * FROM fiscal_bundle_sends
      WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
    `).get(tenantId, userId, idempotencyKey) as FiscalBundleSendRow | undefined
  ) ?? null;
}

export function findFiscalBundleSendForPeriod(
  tenantId: number,
  userId: number,
  periodStart: string,
  periodEnd: string,
): FiscalBundleSendRow | null {
  assertPositiveId(tenantId, 'tenantId');
  assertPositiveId(userId, 'userId');
  return (
    getDb().prepare(`
      SELECT * FROM fiscal_bundle_sends
      WHERE tenant_id = ? AND user_id = ? AND period_start = ? AND period_end = ?
    `).get(tenantId, userId, periodStart, periodEnd) as FiscalBundleSendRow | undefined
  ) ?? null;
}

export function recordFiscalBundleSend(input: {
  tenantId: number;
  userId: number;
  periodStart: string;
  periodEnd: string;
  documentCount: number;
  totalBytes: number;
  idempotencyKey: string;
  resultJson: string;
}): FiscalBundleSendRow {
  assertPositiveId(input.tenantId, 'tenantId');
  assertPositiveId(input.userId, 'userId');
  const db = getDb();
  db.prepare(`
    INSERT INTO fiscal_bundle_sends (
      tenant_id, user_id, period_start, period_end, document_count,
      total_bytes, idempotency_key, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(
    input.tenantId,
    input.userId,
    input.periodStart,
    input.periodEnd,
    Math.max(0, input.documentCount),
    Math.max(0, input.totalBytes),
    input.idempotencyKey,
    input.resultJson,
  );

  const row = (
    findFiscalBundleSendByIdempotencyKey(input.tenantId, input.userId, input.idempotencyKey)
    ?? findFiscalBundleSendForPeriod(input.tenantId, input.userId, input.periodStart, input.periodEnd)
  );
  if (!row) {
    throw new Error('Failed to record fiscal bundle send history.');
  }
  return row;
}

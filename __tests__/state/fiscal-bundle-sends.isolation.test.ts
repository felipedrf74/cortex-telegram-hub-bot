import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import {
  findFiscalBundleSendByIdempotencyKey,
  findFiscalBundleSendForPeriod,
  normalizeFiscalBundleIdempotencyKey,
  recordFiscalBundleSend,
} from '../../src/state/fiscal-bundle-sends';

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE fiscal_bundle_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      document_count INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, user_id, idempotency_key),
      UNIQUE(tenant_id, user_id, period_start, period_end)
    );
  `);
}

describe('state/fiscal-bundle-sends idempotent writes', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createSchema(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('reselects the existing row when the idempotency key already exists', () => {
    const first = recordFiscalBundleSend({
      tenantId: 7,
      userId: 7,
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-05-01T00:00:00.000Z',
      documentCount: 3,
      totalBytes: 1234,
      idempotencyKey: 'bundle-key',
      resultJson: '{"sent":true}',
    });
    const retry = recordFiscalBundleSend({
      tenantId: 7,
      userId: 7,
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-05-01T00:00:00.000Z',
      documentCount: 99,
      totalBytes: 9999,
      idempotencyKey: 'bundle-key',
      resultJson: '{"sent":true,"retry":true}',
    });

    expect(retry).toMatchObject({
      id: first.id,
      document_count: 3,
      total_bytes: 1234,
      idempotency_key: 'bundle-key',
    });
    expect(findFiscalBundleSendByIdempotencyKey(7, 7, 'bundle-key')?.id).toBe(first.id);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM fiscal_bundle_sends').get()).toMatchObject({ count: 1 });
  });

  it('reselects the existing row when a different key targets the same period', () => {
    const periodStart = '2026-04-01T00:00:00.000Z';
    const periodEnd = '2026-05-01T00:00:00.000Z';
    const firstKey = normalizeFiscalBundleIdempotencyKey(7, 7, periodStart, periodEnd, 'explicit-a');
    const secondKey = normalizeFiscalBundleIdempotencyKey(7, 7, periodStart, periodEnd, 'explicit-b');
    const first = recordFiscalBundleSend({
      tenantId: 7,
      userId: 7,
      periodStart,
      periodEnd,
      documentCount: 2,
      totalBytes: 200,
      idempotencyKey: firstKey,
      resultJson: '{"sent":true}',
    });

    const periodRetry = recordFiscalBundleSend({
      tenantId: 7,
      userId: 7,
      periodStart,
      periodEnd,
      documentCount: 4,
      totalBytes: 400,
      idempotencyKey: secondKey,
      resultJson: '{"sent":true,"retry":true}',
    });

    expect(periodRetry).toMatchObject({
      id: first.id,
      idempotency_key: firstKey,
      document_count: 2,
    });
    expect(findFiscalBundleSendForPeriod(7, 7, periodStart, periodEnd)?.id).toBe(first.id);
    expect(findFiscalBundleSendByIdempotencyKey(7, 7, secondKey)).toBeNull();
  });
});

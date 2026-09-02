import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const upSql = readFileSync(
  resolve(__dirname, '../../migrations/309_secretary_calendar_mutation_receipts.sql'),
  'utf8',
);
const downSql = readFileSync(
  resolve(__dirname, '../../migrations/down/309_secretary_calendar_mutation_receipts.sql'),
  'utf8',
);

function insert(db: Database.Database, overrides: Record<string, unknown> = {}): void {
  db.prepare(`
    INSERT INTO secretary_calendar_mutation_receipts (
      user_id, tenant_id, idempotency_key, request_hash, operation,
      provider_source, provider_event_id, command_json, state,
      processing_lease_token, processing_lease_expires_at, created_at, updated_at, expires_at
    ) VALUES (
      @userId, @tenantId, @idempotencyKey, @requestHash, @operation,
      @providerSource, @providerEventId, @commandJson, @state,
      @processingLeaseToken, @processingLeaseExpiresAt, @createdAt, @updatedAt, @expiresAt
    )
  `).run({
    userId: 1,
    tenantId: '1',
    idempotencyKey: 'mutation-1',
    requestHash: 'a'.repeat(64),
    operation: 'update',
    providerSource: 'google',
    providerEventId: 'event-1',
    commandJson: '{}',
    state: 'prechecking',
    processingLeaseToken: null,
    processingLeaseExpiresAt: null,
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
    expiresAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  });
}

describe('migration 309 Secretary calendar mutation receipts', () => {
  it('creates a scoped additive receipt ledger and reverses it', () => {
    const db = new Database(':memory:');
    try {
      db.exec(upSql);
      insert(db);
      expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_calendar_mutation_receipts').get())
        .toEqual({ count: 1 });
      expect(() => insert(db, { tenantId: '2', idempotencyKey: 'cross-scope' }))
        .toThrow(/constraint failed/i);
      expect(() => insert(db, { operation: 'create', idempotencyKey: 'bad-operation' }))
        .toThrow(/constraint failed/i);
      expect(() => insert(db, { idempotencyKey: 'bad-lease-token', processingLeaseToken: 'lease-1' }))
        .toThrow(/constraint failed/i);
      expect(() => insert(db, {
        idempotencyKey: 'bad-lease-expiry',
        processingLeaseExpiresAt: '2026-08-30T10:05:00.000Z',
      })).toThrow(/constraint failed/i);
      db.exec(downSql);
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE name = 'secretary_calendar_mutation_receipts'
      `).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

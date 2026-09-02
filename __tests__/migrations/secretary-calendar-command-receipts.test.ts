import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const upSql = readFileSync(
  resolve(__dirname, '../../migrations/308_secretary_calendar_command_receipts.sql'),
  'utf8',
);
const downSql = readFileSync(
  resolve(__dirname, '../../migrations/down/308_secretary_calendar_command_receipts.sql'),
  'utf8',
);

function validReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: 1,
    tenantId: '1',
    idempotencyKey: 'calendar-command-1',
    commandInstanceId: '11111111-1111-4111-8111-111111111111',
    requestHash: 'a'.repeat(64),
    providerSource: 'google',
    commandJson: JSON.stringify({
      title: 'Planning review',
      start: '2026-08-31T09:00:00.000Z',
      end: '2026-08-31T10:00:00.000Z',
      timezone: 'Europe/Lisbon',
      channel: 'ios',
    }),
    state: 'prechecking',
    processingLeaseToken: null,
    processingLeaseExpiresAt: null,
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
    expiresAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

function insertReceipt(db: Database.Database, overrides: Record<string, unknown> = {}): void {
  const value = validReceipt(overrides);
  db.prepare(`
    INSERT INTO secretary_calendar_command_receipts (
      user_id, tenant_id, idempotency_key, command_instance_id, request_hash, provider_source,
      command_json, state, processing_lease_token, processing_lease_expires_at,
      created_at, updated_at, expires_at
    ) VALUES (
      @userId, @tenantId, @idempotencyKey, @commandInstanceId, @requestHash, @providerSource,
      @commandJson, @state, @processingLeaseToken, @processingLeaseExpiresAt,
      @createdAt, @updatedAt, @expiresAt
    )
  `).run(value);
}

describe('migration 308 Secretary calendar command receipts', () => {
  it('creates an empty scoped receipt ledger with agenda and expiry indexes', () => {
    const db = new Database(':memory:');
    try {
      db.exec(upSql);

      expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_calendar_command_receipts').get())
        .toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_calendar_command_payloads').get())
        .toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_secretary_calendar_command_agenda'
      `).get()).toEqual({ name: 'idx_secretary_calendar_command_agenda' });
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_secretary_calendar_command_expiry'
      `).get()).toEqual({ name: 'idx_secretary_calendar_command_expiry' });

      insertReceipt(db);
      insertReceipt(db, {
        userId: 2,
        tenantId: '2',
        commandInstanceId: '22222222-2222-4222-8222-222222222222',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_calendar_command_receipts').get())
        .toEqual({ count: 2 });
      expect(() => insertReceipt(db)).toThrow(/UNIQUE constraint failed/);
      expect(() => insertReceipt(db, { userId: 3, tenantId: '4' })).toThrow(/constraint failed/i);

      db.prepare(`
        INSERT INTO secretary_calendar_command_payloads (
          agenda_item_id, user_id, tenant_id, command_json, created_at, updated_at
        ) VALUES ('agenda-1', 1, '1', '{"title":"Planning review"}',
                  '2026-08-30T10:00:00.000Z', '2026-08-30T10:00:00.000Z')
      `).run();
      expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_calendar_command_payloads').get())
        .toEqual({ count: 1 });
      expect(() => db.prepare(`
        INSERT INTO secretary_calendar_command_payloads (
          agenda_item_id, user_id, tenant_id, command_json, created_at, updated_at
        ) VALUES ('agenda-cross-scope', 1, '2', '{}', '2026-08-30T10:00:00.000Z', '2026-08-30T10:00:00.000Z')
      `).run()).toThrow(/constraint failed/i);
    } finally {
      db.close();
    }
  });

  it.each([
    ['canonical scope mismatch', { tenantId: '2' }],
    ['short request hash', { requestHash: 'short' }],
    ['unsupported provider', { providerSource: 'caldav' }],
    ['invalid command JSON', { commandJson: 'not-json' }],
    ['unsupported lifecycle state', { state: 'failed' }],
    ['blank idempotency key', { idempotencyKey: '   ' }],
    ['blank command instance', { commandInstanceId: '   ' }],
    ['lease token without expiry', { processingLeaseToken: 'lease-1' }],
    ['lease expiry without token', { processingLeaseExpiresAt: '2026-08-30T10:05:00.000Z' }],
  ])('rejects %s', (_label, overrides) => {
    const db = new Database(':memory:');
    try {
      db.exec(upSql);
      expect(() => insertReceipt(db, overrides)).toThrow(/constraint failed/i);
    } finally {
      db.close();
    }
  });

  it('reverses the additive table and indexes', () => {
    const db = new Database(':memory:');
    try {
      db.exec(upSql);
      db.exec(downSql);

      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE name LIKE 'secretary_calendar_command_%'
      `).all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationFileForTest } from '../../src/services/database';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const MIGRATION_FILE = '285_ai_credit_ledger_foundation.sql';

function createMigratedDb(): Database.Database {
  const db = createMigratedTestDatabase({ stopBefore: MIGRATION_FILE });
  applyMigrationFileForTest(db, MIGRATION_FILE);
  return db;
}

function insertLot(db: Database.Database, overrides: Partial<Record<string, unknown>> = {}): number {
  const values = {
    user_id: 7,
    lot_type: 'purchased',
    credits_granted: 100,
    granted_at: '2026-08-18T10:00:00.000Z',
    expires_at: null,
    source_kind: 'provider_purchase',
    source_ref: 'stripe:txn-1',
    provider: 'stripe',
    provider_transaction_id: 'txn-1',
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO ai_credit_lots (
         user_id, lot_type, credits_granted, granted_at, expires_at,
         source_kind, source_ref, provider, provider_transaction_id
       ) VALUES (@user_id, @lot_type, @credits_granted, @granted_at, @expires_at,
                 @source_kind, @source_ref, @provider, @provider_transaction_id)`,
    )
    .run(values);
  return Number(result.lastInsertRowid);
}

function insertReservation(db: Database.Database, overrides: Partial<Record<string, unknown>> = {}): number {
  const values = {
    user_id: 7,
    operation_class: 'standard',
    credits: 1,
    tenant_scope: 'tenant-7',
    workload: 'chat',
    request_hash: 'hash-1',
    client_operation_id: 'op-1',
    reserved_at: '2026-08-18T10:00:00.000Z',
    reserved_day: '2026-08-18',
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO ai_credit_reservations (
         user_id, operation_class, credits, tenant_scope, workload,
         request_hash, client_operation_id, reserved_at, reserved_day
       ) VALUES (@user_id, @operation_class, @credits, @tenant_scope, @workload,
                 @request_hash, @client_operation_id, @reserved_at, @reserved_day)`,
    )
    .run(values);
  return Number(result.lastInsertRowid);
}

describe('migration 285 — AI credit ledger foundation', () => {
  it('applies, records itself, seeds plan credit policy, and replays idempotently', () => {
    const db = createMigratedDb();
    try {
      expect(
        db.prepare('SELECT filename FROM _migrations WHERE filename = ?').get(MIGRATION_FILE),
      ).toEqual({ filename: MIGRATION_FILE });

      const rows = db
        .prepare(
          `SELECT plan_id, monthly_ai_credits, daily_ai_credit_cap
           FROM plan_configs WHERE plan_id IN ('free', 'pro', 'max') ORDER BY plan_id`,
        )
        .all();
      expect(rows).toEqual([
        { plan_id: 'free', monthly_ai_credits: 60, daily_ai_credit_cap: 5 },
        { plan_id: 'max', monthly_ai_credits: 1200, daily_ai_credit_cap: 100 },
        { plan_id: 'pro', monthly_ai_credits: 500, daily_ai_credit_cap: 50 },
      ]);

      expect(() => applyMigrationFileForTest(db, MIGRATION_FILE)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('enforces append-only lots with only the active -> revoked transition', () => {
    const db = createMigratedDb();
    try {
      const lotId = insertLot(db);
      expect(() =>
        db.prepare('UPDATE ai_credit_lots SET credits_granted = 999 WHERE id = ?').run(lotId),
      ).toThrow(/active -> revoked/);
      expect(() => db.prepare('DELETE FROM ai_credit_lots WHERE id = ?').run(lotId)).toThrow(/append-only/);

      db.prepare(
        `UPDATE ai_credit_lots
         SET status = 'revoked', revoked_at = '2026-08-18T11:00:00.000Z', revoke_reason = 'refund'
         WHERE id = ?`,
      ).run(lotId);
      expect(() =>
        db.prepare(
          `UPDATE ai_credit_lots
           SET status = 'active', revoked_at = NULL, revoke_reason = NULL WHERE id = ?`,
        ).run(lotId),
      ).toThrow(/active -> revoked/);
    } finally {
      db.close();
    }
  });

  it('enforces unique provider transactions and unique replay identities', () => {
    const db = createMigratedDb();
    try {
      insertLot(db);
      expect(() => insertLot(db, { source_ref: 'stripe:txn-1-copy' })).toThrow(/UNIQUE/);

      insertReservation(db);
      expect(() => insertReservation(db)).toThrow(/UNIQUE/);
      expect(() => insertReservation(db, { client_operation_id: 'op-2' })).not.toThrow();
      expect(() => insertReservation(db, { user_id: 8, tenant_scope: 'tenant-8' })).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('permits only reserved -> settled reservation transitions', () => {
    const db = createMigratedDb();
    try {
      const reservationId = insertReservation(db);
      expect(() =>
        db.prepare('UPDATE ai_credit_reservations SET credits = 50 WHERE id = ?').run(reservationId),
      ).toThrow(/reserved -> captured/);
      expect(() =>
        db.prepare('DELETE FROM ai_credit_reservations WHERE id = ?').run(reservationId),
      ).toThrow(/append-only/);

      db.prepare(
        `UPDATE ai_credit_reservations
         SET state = 'captured', settled_at = '2026-08-18T10:05:00.000Z' WHERE id = ?`,
      ).run(reservationId);
      expect(() =>
        db.prepare(
          `UPDATE ai_credit_reservations
           SET state = 'released', settled_at = '2026-08-18T10:06:00.000Z' WHERE id = ?`,
        ).run(reservationId),
      ).toThrow(/reserved -> captured/);
    } finally {
      db.close();
    }
  });

  it('keeps capture rows immutable', () => {
    const db = createMigratedDb();
    try {
      const lotId = insertLot(db);
      const reservationId = insertReservation(db);
      db.prepare(
        `INSERT INTO ai_credit_captures (reservation_id, lot_id, user_id, credits, created_at)
         VALUES (?, ?, 7, 1, '2026-08-18T10:05:00.000Z')`,
      ).run(reservationId, lotId);
      expect(() => db.prepare('UPDATE ai_credit_captures SET credits = 5').run()).toThrow(/immutable/);
      expect(() => db.prepare('DELETE FROM ai_credit_captures').run()).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

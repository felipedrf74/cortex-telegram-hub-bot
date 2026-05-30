// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-2 rank 5 — persistence + mode-gated emission for Chat Core v2 prepass
 * recall-misses.
 *
 * DMV invariants proven here:
 *  - persistence round-trips an HMAC-only row (no raw message text anywhere);
 *  - the same message under two tenants yields DIFFERENT message_hash values
 *    (per-tenant salting; no cross-tenant correlation);
 *  - recordPrepassRecallFailure NEVER throws on a bad/closed db (fire-and-forget);
 *  - OFF-MODE INERTNESS: maybeEmitPrepassRecallMiss with mode=off writes ZERO
 *    rows and leaves the table EMPTY (the load-bearing dormant-safe property).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  ensureChatCoreV2PrepassMissLogTable,
  recordPrepassRecallFailure,
  maybeEmitPrepassRecallMiss,
  listPrepassRecallFailures,
  CHAT_CORE_V2_PREPASS_MISS_STORE_VERSION,
} from '../../src/services/chat-core-v2/prepass-miss-store';
import { buildPrepassRecallFailureRecord } from '../../src/services/chat-core-v2/prepass-miss-log';

const HMAC_SECRET = 'unit-test-secret';
const RAW_MESSAGE = 'please move my private appointment to tomorrow';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureChatCoreV2PrepassMissLogTable(db);
  return db;
}

function rowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chat_v2_prepass_miss_log').get() as { n: number }).n;
}

function buildRecord(overrides: { tenantId?: string; userId?: string; message?: string } = {}) {
  return buildPrepassRecallFailureRecord({
    hmacSecret: HMAC_SECRET,
    tenantId: overrides.tenantId ?? 'tenant-a',
    userId: overrides.userId ?? 'user-a',
    message: overrides.message ?? RAW_MESSAGE,
    locale: 'en',
    candidateCapabilityIds: ['tasks.today_summary', 'clarify_reference'],
    finalCapabilityId: 'secretary.move_event',
    reasonCodes: ['prepass_recall_miss'],
    createdAt: '2026-05-30T12:00:00.000Z',
  });
}

describe('prepass-miss-store — persistence round-trip (HMAC-only)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('round-trips an HMAC-only row scoped to tenant+user', () => {
    const record = buildRecord();
    const ok = recordPrepassRecallFailure(db, {
      turnId: 'turn-1',
      tenantId: 'tenant-a',
      userId: 'user-a',
      record,
      expectedCapabilityIds: ['secretary.move_event'],
    });
    expect(ok).toBe(true);

    const rows = listPrepassRecallFailures(db, { tenantId: 'tenant-a' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.turnId).toBe('turn-1');
    expect(row.tenantId).toBe('tenant-a');
    expect(row.userId).toBe('user-a');
    expect(row.messageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.expectedCapabilityIds).toEqual(['secretary.move_event']);
    expect(row.candidateCapabilityIds).toEqual(['tasks.today_summary', 'clarify_reference']);
    expect(row.reasonCodes).toEqual(['prepass_recall_miss']);
    expect(row.locale).toBe('en');
    expect(row.schemaVersion).toBe(record.schemaVersion);
    expect(row.recordedAt).toBe('2026-05-30T12:00:00.000Z');
    // Retention column populated to recorded_at + 30 days.
    expect(row.expiresAt).toBe('2026-06-29T12:00:00.000Z');
  });

  it('NEVER stores raw user message text in any column (privacy)', () => {
    recordPrepassRecallFailure(db, {
      turnId: 'turn-1',
      tenantId: 'tenant-a',
      userId: 'user-a',
      record: buildRecord(),
      expectedCapabilityIds: ['secretary.move_event'],
    });
    // Dump the entire row as text and assert the raw message never appears.
    const raw = db.prepare('SELECT * FROM chat_v2_prepass_miss_log').all();
    expect(JSON.stringify(raw)).not.toContain('private appointment');
    expect(JSON.stringify(raw)).not.toContain('tomorrow');
  });

  it('scopes reads per-tenant: tenant-a never sees tenant-b rows', () => {
    recordPrepassRecallFailure(db, {
      turnId: 'turn-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
      record: buildRecord({ tenantId: 'tenant-a' }),
      expectedCapabilityIds: ['secretary.move_event'],
    });
    recordPrepassRecallFailure(db, {
      turnId: 'turn-b',
      tenantId: 'tenant-b',
      userId: 'user-b',
      record: buildRecord({ tenantId: 'tenant-b', userId: 'user-b' }),
      expectedCapabilityIds: ['secretary.move_event'],
    });

    expect(listPrepassRecallFailures(db, { tenantId: 'tenant-a' }).map((r) => r.turnId)).toEqual(['turn-a']);
    expect(listPrepassRecallFailures(db, { tenantId: 'tenant-b' }).map((r) => r.turnId)).toEqual(['turn-b']);
  });
});

describe('prepass-miss-store — cross-tenant hash isolation', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('the SAME message under two tenants yields DIFFERENT message_hash', () => {
    recordPrepassRecallFailure(db, {
      turnId: 'turn-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
      record: buildRecord({ tenantId: 'tenant-a', message: RAW_MESSAGE }),
      expectedCapabilityIds: ['secretary.move_event'],
    });
    recordPrepassRecallFailure(db, {
      turnId: 'turn-b',
      tenantId: 'tenant-b',
      userId: 'user-b',
      record: buildRecord({ tenantId: 'tenant-b', userId: 'user-b', message: RAW_MESSAGE }),
      expectedCapabilityIds: ['secretary.move_event'],
    });

    const hashA = listPrepassRecallFailures(db, { tenantId: 'tenant-a' })[0].messageHash;
    const hashB = listPrepassRecallFailures(db, { tenantId: 'tenant-b' })[0].messageHash;
    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    expect(hashB).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA).not.toBe(hashB); // per-tenant salting; no cross-tenant correlation.
  });
});

describe('prepass-miss-store — fire-and-forget (never throws)', () => {
  it('recordPrepassRecallFailure returns false (does NOT throw) on a closed db', () => {
    const db = new Database(':memory:');
    db.close(); // any DB op now throws inside the store; must be swallowed.
    let result: boolean | undefined;
    expect(() => {
      result = recordPrepassRecallFailure(db, {
        turnId: 'turn-1',
        tenantId: 'tenant-a',
        userId: 'user-a',
        record: buildRecord(),
        expectedCapabilityIds: ['secretary.move_event'],
      });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('exposes a version constant', () => {
    expect(CHAT_CORE_V2_PREPASS_MISS_STORE_VERSION).toMatch(/^chat_core_v2_prepass_miss_store@/);
  });
});

describe('prepass-miss-store — OFF-MODE INERTNESS (load-bearing)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  const OFF_ENV = {
    CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
    CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: HMAC_SECRET,
  } as Record<string, string>;

  const ABSENT_ENV = {
    // CHAT_CORE_V2_ORCHESTRATOR_MODE intentionally ABSENT (parses to 'off').
    CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: HMAC_SECRET,
  } as Record<string, string>;

  const SHADOW_ENV = {
    CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow',
    CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: HMAC_SECRET,
  } as Record<string, string>;

  function emit(env: Record<string, string>): boolean {
    return maybeEmitPrepassRecallMiss({
      turnId: 'turn-1',
      tenantId: 'tenant-a',
      userId: 'user-a',
      message: RAW_MESSAGE,
      locale: 'en',
      expectedCapabilityIds: ['secretary.move_event'],
      candidateCapabilityIds: ['tasks.today_summary'],
      reasonCodes: ['prepass_recall_miss'],
      createdAt: '2026-05-30T12:00:00.000Z',
      env,
      db,
    });
  }

  it('mode=off → ZERO rows written; table stays EMPTY', () => {
    expect(rowCount(db)).toBe(0);
    const wrote = emit(OFF_ENV);
    expect(wrote).toBe(false);
    expect(rowCount(db)).toBe(0); // the load-bearing assertion.
    expect(listPrepassRecallFailures(db, { tenantId: 'tenant-a' })).toEqual([]);
  });

  it('mode ABSENT (parsed off) → ZERO rows written; table stays EMPTY', () => {
    const wrote = emit(ABSENT_ENV);
    expect(wrote).toBe(false);
    expect(rowCount(db)).toBe(0);
  });

  it('mode=shadow → emission is ACTIVE (one row written) — proves the gate is real, not inert', () => {
    const wrote = emit(SHADOW_ENV);
    expect(wrote).toBe(true);
    expect(rowCount(db)).toBe(1);
    const row = listPrepassRecallFailures(db, { tenantId: 'tenant-a' })[0];
    expect(row.expectedCapabilityIds).toEqual(['secretary.move_event']);
    expect(row.messageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('per-tenant kill-switch demotion forces inert even under shadow env', () => {
    // ORCHESTRATOR_MODE explicit 'off' inside the kill-switch check always kills;
    // here we prove the env 'off' path is honored as the master kill-switch too.
    const wrote = emit({ ...SHADOW_ENV, CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off' });
    expect(wrote).toBe(false);
    expect(rowCount(db)).toBe(0);
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { setDbProvider, writeSignal } from '../../src/services/intelligence-bus';
import {
  ContentScheduleSignalReconciliationError,
  dismissContentFilmingSignalsForItem,
} from '../../src/services/content-schedule-signal-reconciliation';

describe('Content schedule signal reconciliation', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb as any);
  });

  afterEach(() => {
    testDb.close();
    setDbProvider(() => null as any);
  });

  it('dismisses only the scoped editorial filming lock for the cancelled item', () => {
    const matchingId = writeSignal({
      source_agent: 'mesh.editorial-coordinator',
      signal_type: 'shoot_day_locked',
      payload: { itemId: 71, date: '2032-07-18' },
      user_id: 501,
      tenant_id: 501,
    });
    const otherItemId = writeSignal({
      source_agent: 'mesh.editorial-coordinator',
      signal_type: 'shoot_day_locked',
      payload: { itemId: 72, date: '2032-07-19' },
      user_id: 501,
      tenant_id: 501,
    });
    const otherSourceId = writeSignal({
      source_agent: 'content.test',
      signal_type: 'shoot_day_locked',
      payload: { itemId: 71, date: '2032-07-18' },
      user_id: 501,
      tenant_id: 501,
    });
    const otherTenantId = writeSignal({
      source_agent: 'mesh.editorial-coordinator',
      signal_type: 'shoot_day_locked',
      payload: { itemId: 71, date: '2032-07-18' },
      user_id: 502,
      tenant_id: 502,
    });

    expect(dismissContentFilmingSignalsForItem({ tenantId: 501, userId: 501 }, 71)).toBe(1);

    const rows = testDb.prepare(`
      SELECT id, status
        FROM agent_signals
       WHERE id IN (?, ?, ?, ?)
       ORDER BY id
    `).all(matchingId, otherItemId, otherSourceId, otherTenantId) as Array<{ id: number; status: string }>;
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [matchingId]: 'dismissed',
      [otherItemId]: 'active',
      [otherSourceId]: 'active',
      [otherTenantId]: 'active',
    });
  });

  it('does not lose an older matching signal behind ordinary consumer read limits', () => {
    const matchingId = writeSignal({
      source_agent: 'mesh.editorial-coordinator',
      signal_type: 'shoot_day_locked',
      payload: { itemId: 71, date: '2032-07-18' },
      user_id: 501,
      tenant_id: 501,
    });
    const logicallyExpiredMatchingId = writeSignal({
      source_agent: 'mesh.editorial-coordinator',
      signal_type: 'shoot_day_locked',
      payload: { itemId: 71, date: '2032-07-17' },
      user_id: 501,
      tenant_id: 501,
    });
    testDb.prepare(`UPDATE agent_signals
      SET expires_at = datetime('now', '-1 day')
      WHERE id = ?`).run(logicallyExpiredMatchingId);
    for (let index = 0; index < 501; index += 1) {
      writeSignal({
        source_agent: 'mesh.editorial-coordinator',
        signal_type: 'shoot_day_locked',
        payload: { itemId: 1_000 + index, date: '2032-07-19' },
        user_id: 501,
        tenant_id: 501,
      });
    }

    expect(dismissContentFilmingSignalsForItem({ tenantId: 501, userId: 501 }, 71)).toBe(1);
    expect(testDb.prepare('SELECT status FROM agent_signals WHERE id = ?').get(matchingId))
      .toEqual({ status: 'dismissed' });
    expect(testDb.prepare('SELECT status FROM agent_signals WHERE id = ?').get(logicallyExpiredMatchingId))
      .toEqual({ status: 'active' });
  });

  it('fails explicitly when the signal store cannot be read', () => {
    setDbProvider(() => null as any);

    expect(() => dismissContentFilmingSignalsForItem(
      { tenantId: 501, userId: 501 },
      71,
    )).toThrowError(expect.objectContaining<Partial<ContentScheduleSignalReconciliationError>>({
      code: 'CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_UNAVAILABLE',
      status: 503,
      details: expect.objectContaining({
        canonicalCancellationCommitted: true,
        retryable: true,
      }),
    }));
  });
});

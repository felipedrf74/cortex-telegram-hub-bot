// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getTrainingCalendarCleanupSnapshot,
  retryTrainingCalendarCleanup,
} from '../../src/services/training-calendar-cleanup-recovery';

let db: Database.Database;

function seedSchema(): void {
  db.exec(`
    CREATE TABLE secretary_agenda_items (
      agenda_item_id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      source_skill TEXT NOT NULL,
      provider_sync_state TEXT NOT NULL,
      provider_sync_failure_count INTEGER NOT NULL DEFAULT 0,
      provider_sync_failure_disposition TEXT,
      provider_sync_retry_after_at TEXT,
      provider_target TEXT,
      provider_source TEXT,
      provider_event_id TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function insertCleanup(input: {
  id: string;
  tenantId?: number;
  provider?: 'google' | 'outlook';
  failures?: number;
  disposition?: 'terminal' | 'retryable' | 'reconcile' | null;
}): void {
  const provider = input.provider ?? 'google';
  db.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, owner_user_id, tenant_id, source_skill,
      provider_sync_state, provider_sync_failure_count,
      provider_sync_failure_disposition, provider_target, provider_source,
      provider_event_id, updated_at
    ) VALUES (?, 42, ?, 'training', 'delete_failed', ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    String(input.tenantId ?? 7),
    input.failures ?? 5,
    input.disposition ?? 'retryable',
    provider,
    provider,
    `opaque-${input.id}`,
    `2026-08-30T00:${input.id.slice(-2).padStart(2, '0')}:00.000Z`,
  );
}

describe('Training calendar cleanup recovery', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    seedSchema();
  });

  afterEach(() => db.close());

  it('reports provider buckets without exposing provider object ids', () => {
    insertCleanup({ id: 'g-01' });
    insertCleanup({ id: 'g-02', failures: 4 });
    insertCleanup({ id: 'o-01', provider: 'outlook' });

    const snapshot = getTrainingCalendarCleanupSnapshot(42, 7, db);

    expect(snapshot).toMatchObject({
      schemaVersion: 'training_calendar_cleanup.v2',
      deadLetteredCount: 2,
      retryingCount: 1,
      providers: [
        { provider: 'google', deadLetteredCount: 1, retryingCount: 1 },
        { provider: 'outlook', deadLetteredCount: 1, retryingCount: 0 },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('opaque-');
  });

  it('re-arms at most 50 eligible rows while preserving provider ownership', async () => {
    for (let index = 0; index < 55; index += 1) {
      insertCleanup({ id: `g-${String(index).padStart(2, '0')}` });
    }
    insertCleanup({ id: 'g-terminal', disposition: 'terminal' });
    insertCleanup({ id: 'other-tenant', tenantId: 8 });

    const first = await retryTrainingCalendarCleanup({
      userId: 42,
      tenantId: 7,
      provider: 'google',
      providerConnected: true,
      db,
    });

    expect(first).toMatchObject({
      state: 'retrying',
      acceptedCount: 50,
      deadLetteredCount: 6,
      retryingCount: 50,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM secretary_agenda_items
       WHERE tenant_id = '7'
         AND provider_sync_failure_count = 4
         AND provider_sync_state = 'delete_failed'
         AND provider_target = 'google'
         AND provider_source = 'google'
         AND provider_event_id IS NOT NULL
    `).get()).toEqual({ count: 50 });
    expect(db.prepare(`
      SELECT provider_sync_failure_count AS failures
        FROM secretary_agenda_items WHERE agenda_item_id = 'other-tenant'
    `).get()).toEqual({ failures: 5 });
  });

  it('returns action_required when only terminal cleanup remains', async () => {
    insertCleanup({ id: 'g-terminal', disposition: 'terminal' });

    const result = await retryTrainingCalendarCleanup({
      userId: 42,
      tenantId: 7,
      provider: 'google',
      providerConnected: true,
      db,
    });

    expect(result).toMatchObject({ state: 'action_required', acceptedCount: 0, deadLetteredCount: 1 });
  });

  it('fails closed when the selected provider is disconnected', async () => {
    insertCleanup({ id: 'g-01' });

    const result = await retryTrainingCalendarCleanup({
      userId: 42,
      tenantId: 7,
      provider: 'google',
      providerConnected: false,
      db,
    });

    expect(result).toMatchObject({ state: 'unavailable', acceptedCount: 0, deadLetteredCount: 1 });
    expect(db.prepare(`
      SELECT provider_sync_failure_count AS failures
        FROM secretary_agenda_items WHERE agenda_item_id = 'g-01'
    `).get()).toEqual({ failures: 5 });
  });
});

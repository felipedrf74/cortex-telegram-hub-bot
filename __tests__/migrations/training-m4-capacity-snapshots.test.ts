// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationFileForTest, runMigrationsForTest } from '../../src/services/database';

describe('migration 231 — Training M4 capacity snapshots', () => {
  it('applies additively, replays idempotently, and enforces personal immutable scope', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      applyMigrationFileForTest(db, '231_training_m4_capacity_snapshots.sql');
      expect(db.prepare("SELECT filename FROM _migrations WHERE filename = '231_training_m4_capacity_snapshots.sql'").get())
        .toEqual({ filename: '231_training_m4_capacity_snapshots.sql' });
      const insert = db.prepare(`
        INSERT INTO training_m4_capacity_snapshots (
          snapshot_id, tenant_id, user_id, schema_version, context_version,
          idempotency_key, request_hash, profile_source_version,
          calendar_event_set_hash, provider_sources_json, provider_status,
          plan_start_date, plan_end_date, horizon_weeks, range_start_at,
          range_end_at, profile_windows_json, capacity_windows_json,
          conflict_count, observed_at, expires_at
        ) VALUES (?, ?, ?, 'training-m4-capacity-snapshot.v1', ?, ?, ?, ?, ?,
          '["google"]', 'ready', '2026-08-03', '2026-08-30', 4,
          '2026-08-02T23:00:00.000Z', '2026-08-31T23:00:00.000Z', ?, ?, 0,
          '2026-07-14T09:00:00.000Z', '2026-07-14T09:05:00.000Z')
      `);
      const windows = JSON.stringify([{
        dayOfWeek: 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
      }]);
      insert.run('snapshot-7', 7, 7, `m4cap_${'7'.repeat(48)}`, 'refresh-7', 'a'.repeat(64),
        `m4profile_${'b'.repeat(64)}`, 'c'.repeat(64), windows, windows);
      expect(() => db.prepare(`
        UPDATE training_m4_capacity_snapshots SET conflict_count = 1 WHERE snapshot_id = 'snapshot-7'
      `).run()).toThrow(/immutable/i);
      expect(() => insert.run('snapshot-cross-scope', 7, 8, `m4cap_${'8'.repeat(48)}`, 'refresh-8',
        'd'.repeat(64), `m4profile_${'e'.repeat(64)}`, 'f'.repeat(64), windows, windows))
        .toThrow(/CHECK constraint/i);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      db.close();
    }
  });

  it('has a staging-only inverse that removes only M4 capacity snapshots', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      db.exec(readFileSync(resolve(process.cwd(), 'migrations/down/231_training_m4_capacity_snapshots.sql'), 'utf8'));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'training_m4_capacity_snapshots'").get())
        .toBeUndefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'training_plan_revisions'").get())
        .toEqual({ name: 'training_plan_revisions' });
    } finally {
      db.close();
    }
  });
});

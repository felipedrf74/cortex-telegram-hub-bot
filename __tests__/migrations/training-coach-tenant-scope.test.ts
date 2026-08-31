// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { applyMigrationFileForTest } from '../../src/services/database';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const MIGRATION_FILE = '304_training_coach_tenant_scope.sql';
const DOWN_SQL = readFileSync(
  resolve(process.cwd(), 'migrations/down/304_training_coach_tenant_scope.sql'),
  'utf8',
);

function ensureUser(db: Database.Database, userId: number): void {
  db.prepare(`
    INSERT INTO users (
      id,
      telegram_id,
      first_name,
      language,
      timezone,
      tier,
      status,
      auth_provider,
      created_at,
      last_active_at
    )
    VALUES (?, ?, ?, 'en-US', 'Europe/Lisbon', 'pro', 'active', 'telegram', datetime('now'), datetime('now'))
  `).run(userId, userId, `Tenant scope ${userId}`);
}

describe('migration 304 — durable Training coach tenant scope', () => {
  it('identity-backfills legacy rows and permits independent delegated-tenant state', () => {
    const db = createMigratedTestDatabase({ stopBefore: MIGRATION_FILE });
    try {
      ensureUser(db, 41);
      db.prepare(`
        INSERT INTO report_documents (
          user_id,
          type,
          title,
          summary,
          document_json,
          source_job
        )
        VALUES (41, 'coach_briefing', 'Legacy coach', 'Legacy summary', '{}', 'migration_test')
      `).run();
      db.prepare(`
        INSERT INTO coach_states (
          user_id,
          recommendations_json,
          briefing_summary,
          created_at_ms,
          expires_at_ms
        )
        VALUES (41, '[]', 'Legacy state', 1000, 2000)
      `).run();
      db.prepare(`
        INSERT INTO report_schedule_ledger (
          user_id,
          tenant_id,
          job_type,
          fired_for_local_date,
          fired_at
        )
        VALUES (41, 41, 'garmin_coach', '2026-08-30', '2026-08-30T06:00:00.000Z')
      `).run();

      applyMigrationFileForTest(db, MIGRATION_FILE);

      expect(
        db.prepare('SELECT tenant_id, user_id FROM report_documents_scoped WHERE source_job = ?')
          .get('migration_test'),
      ).toEqual({ tenant_id: 41, user_id: 41 });
      expect(
        db.prepare('SELECT tenant_id, user_id, briefing_summary FROM coach_states_scoped WHERE user_id = ?')
          .get(41),
      ).toEqual({ tenant_id: 41, user_id: 41, briefing_summary: 'Legacy state' });

      const insertScopedState = db.prepare(`
        INSERT INTO coach_states_scoped (
          tenant_id,
          user_id,
          recommendations_json,
          briefing_summary,
          created_at_ms,
          expires_at_ms
        )
        VALUES (?, 41, '[]', ?, 3000, 4000)
      `);
      insertScopedState.run(701, 'Tenant 701');
      insertScopedState.run(702, 'Tenant 702');

      const insertScopedClaim = db.prepare(`
        INSERT INTO report_schedule_ledger_scoped (
          tenant_id,
          user_id,
          job_type,
          fired_for_local_date,
          fired_at
        )
        VALUES (?, 41, 'garmin_coach', '2026-08-31', ?)
      `);
      insertScopedClaim.run(701, '2026-08-31T06:00:00.000Z');
      insertScopedClaim.run(702, '2026-08-31T06:00:00.000Z');

      expect(
        db.prepare(`
          SELECT tenant_id, briefing_summary
          FROM coach_states_scoped
          WHERE user_id = 41
          ORDER BY tenant_id
        `).all(),
      ).toEqual([
        { tenant_id: 41, briefing_summary: 'Legacy state' },
        { tenant_id: 701, briefing_summary: 'Tenant 701' },
        { tenant_id: 702, briefing_summary: 'Tenant 702' },
      ]);
      expect(
        db.prepare(`
          SELECT tenant_id, user_id, job_type, fired_for_local_date
          FROM report_schedule_ledger_scoped
          WHERE user_id = 41
          ORDER BY fired_for_local_date, tenant_id
        `).all(),
      ).toEqual([
        {
          tenant_id: 41,
          user_id: 41,
          job_type: 'garmin_coach',
          fired_for_local_date: '2026-08-30',
        },
        {
          tenant_id: 701,
          user_id: 41,
          job_type: 'garmin_coach',
          fired_for_local_date: '2026-08-31',
        },
        {
          tenant_id: 702,
          user_id: 41,
          job_type: 'garmin_coach',
          fired_for_local_date: '2026-08-31',
        },
      ]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%tenant%'")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(expect.arrayContaining([
        'idx_coach_states_scoped_user_tenant',
        'idx_reports_tenant_user_status',
        'idx_reports_tenant_user_type',
        'idx_report_schedule_ledger_scoped_user_tenant',
      ]));
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('leaves malformed legacy report ownership unassigned and therefore fail-closed', () => {
    const db = createMigratedTestDatabase({ stopBefore: MIGRATION_FILE });
    try {
      db.prepare(`
        INSERT INTO report_documents (
          user_id,
          type,
          title,
          document_json,
          source_job
        )
        VALUES ('ambiguous', 'coach_briefing', 'Malformed legacy owner', '{}', 'ambiguous_owner')
      `).run();

      applyMigrationFileForTest(db, MIGRATION_FILE);

      expect(db.prepare(
        'SELECT user_id, tenant_id FROM report_documents_scoped WHERE source_job = ?',
      ).get('ambiguous_owner')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rolls back without widening delegated rows into legacy identity scope', () => {
    const db = createMigratedTestDatabase();
    try {
      ensureUser(db, 42);
      const insertReport = db.prepare(`
        INSERT INTO report_documents_scoped (
          tenant_id,
          user_id,
          type,
          title,
          document_json,
          source_job
        )
        VALUES (?, 42, 'coach_briefing', ?, '{}', ?)
      `);
      insertReport.run(42, 'Identity report', 'identity_report');
      insertReport.run(701, 'Delegated report', 'delegated_report');

      const insertState = db.prepare(`
        INSERT INTO coach_states_scoped (
          tenant_id,
          user_id,
          recommendations_json,
          briefing_summary,
          created_at_ms,
          expires_at_ms
        )
        VALUES (?, 42, '[]', ?, 1000, 2000)
      `);
      insertState.run(42, 'Identity state');
      insertState.run(701, 'Delegated state');

      const insertClaim = db.prepare(`
        INSERT INTO report_schedule_ledger_scoped (
          tenant_id,
          user_id,
          job_type,
          fired_for_local_date
        )
        VALUES (?, 42, 'garmin_coach', ?)
      `);
      insertClaim.run(42, '2026-08-29');
      insertClaim.run(701, '2026-08-30');

      db.exec(DOWN_SQL);

      expect(
        db.prepare('SELECT source_job FROM report_documents WHERE user_id = 42 ORDER BY source_job').all(),
      ).toEqual([{ source_job: 'identity_report' }]);
      expect(
        db.prepare('SELECT user_id, briefing_summary FROM coach_states WHERE user_id = 42').all(),
      ).toEqual([{ user_id: 42, briefing_summary: 'Identity state' }]);
      expect(
        db.prepare(`
          SELECT user_id, tenant_id, fired_for_local_date
          FROM report_schedule_ledger
          WHERE user_id = 42
        `).all(),
      ).toEqual([{
        user_id: 42,
        tenant_id: 42,
        fired_for_local_date: '2026-08-29',
      }]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_documents_scoped'")
          .get(),
      ).toBeUndefined();
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});

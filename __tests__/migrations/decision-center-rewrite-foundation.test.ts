import { describe, expect, it } from 'vitest';
import { applyMigrationFileForTest } from '../../src/services/database';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const MIGRATION = '306_decision_center_rewrite_foundation.sql';

describe('migration 306 — Decision Center rewrite foundation', () => {
  it('upgrades predecessor data and leaves previous-binary inserts readable', () => {
    const db = createMigratedTestDatabase({ stopBefore: MIGRATION });
    try {
      db.prepare(`
        INSERT INTO agent_signals (
          source_agent, signal_type, payload, priority, consumed_by, status,
          created_at, expires_at, user_id, tenant_id
        ) VALUES (
          'mesh.secretary-context', 'deadline_pressure', '{}', 'normal', '[]', 'active',
          '2026-08-31T09:00:00.000Z', '2026-09-07T09:00:00.000Z', 7, 70
        )
      `).run();
      const reportId = Number(db.prepare(`
        INSERT INTO report_documents_scoped (
          tenant_id, user_id, type, title, summary, document_json, source_job
        ) VALUES (70, 7, 'morning_briefing', 'Before upgrade', NULL, '{}', 'legacy-cron')
      `).run().lastInsertRowid);
      db.prepare(`
        INSERT INTO background_jobs (
          job_id, tenant_id, user_id, job_type, payload_json, status,
          attempts, max_attempts, idempotency_key, completed_at
        ) VALUES (
          'legacy-completed-report', 70, 7,
          'scheduled_report_delivery:morning_briefing',
          '{"reportJob":"morning_briefing","localDate":"2026-08-31"}',
          'completed', 1, 3, 'morning_briefing:2026-08-31',
          '2026-08-31T09:05:00.000Z'
        )
      `).run();

      applyMigrationFileForTest(db, MIGRATION);

      expect(db.prepare(`
        SELECT signal_identity AS signalIdentity, provenance_json AS provenanceJson
          FROM agent_signals WHERE user_id = 7 AND tenant_id = 70
      `).get()).toMatchObject({
        signalIdentity: expect.stringMatching(/^legacy:/),
        provenanceJson: expect.any(String),
      });
      expect(db.prepare(`
        SELECT tenant_id AS tenantId, dispatch_key AS dispatchKey
          FROM report_documents_scoped WHERE id = ?
      `).get(reportId)).toEqual({ tenantId: 70, dispatchKey: null });
      expect(db.prepare(`
        SELECT user_id AS userId, tenant_id AS tenantId, report_job AS reportJob,
               local_date AS localDate
          FROM scheduled_report_completion_receipts
         WHERE job_id = 'legacy-completed-report'
      `).get()).toEqual({
        userId: 7,
        tenantId: 70,
        reportJob: 'morning_briefing',
        localDate: '2026-08-31',
      });

      // A previous binary continues writing the untouched legacy report table.
      // The scoped projection and its nullable dispatch identity remain isolated
      // so a governed runtime rollback retains the predecessor insert shape.
      const previousBinaryReportId = Number(db.prepare(`
        INSERT INTO report_documents (
          user_id, type, title, summary, document_json, source_job
        ) VALUES (7, 'weekly_review', 'Previous binary', NULL, '{}', 'legacy-cron')
      `).run().lastInsertRowid);
      expect(db.prepare(`
        SELECT user_id AS userId
          FROM report_documents
         WHERE id = ?
      `).get(previousBinaryReportId)).toEqual({ userId: 7 });
      expect(() => db.prepare(`
        INSERT INTO agent_signals (
          source_agent, signal_type, payload, priority, consumed_by, status,
          created_at, expires_at, user_id, tenant_id
        ) VALUES (
          'mesh.secretary-context', 'deadline_pressure', '{}', 'normal', '[]', 'active',
          '2026-08-31T10:00:00.000Z', '2026-09-07T10:00:00.000Z', 7, 70
        )
      `).run()).not.toThrow();

      const tables = db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'decision_center_rank_snapshots',
             'decision_center_rank_snapshot_entries',
             'report_document_dispatch_receipts',
             'scheduled_report_completion_receipts',
             'planning_recompute_receipts'
           )
         ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        'decision_center_rank_snapshot_entries',
        'decision_center_rank_snapshots',
        'planning_recompute_receipts',
        'report_document_dispatch_receipts',
        'scheduled_report_completion_receipts',
      ]);
    } finally {
      db.close();
    }
  });
});

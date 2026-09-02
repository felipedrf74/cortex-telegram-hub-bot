import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { withDatabaseForTest } from '../../src/services/database';
import { putSecretaryRoutineProfile } from '../../src/services/secretary-routine-profile';
import {
  deleteAllUserData,
  exportAllUserData,
  getAccountDeletionInventoryForUser,
} from '../../src/services/user-data-export';
import {
  beginSkillInferenceAccountDeletionFence,
  clearSkillInferenceAccountDeletionFence,
} from '../../src/services/skill-inference-account-lifecycle';

let db: Database.Database;

function seedRoutineProfile(): void {
  db.prepare(`
    INSERT INTO users (id, telegram_id, first_name, language, timezone, status, auth_provider)
    VALUES (1, 1, 'Privacy Tester', 'en-US', 'Europe/Lisbon', 'active', 'invite_code')
  `).run();
  putSecretaryRoutineProfile({ userId: 1, tenantId: 1 }, {
    expectedVersion: 0,
    idempotencyKey: 'privacy-routine-0001',
    timezone: 'Europe/Lisbon',
    workingWindows: [{
      id: '11111111-1111-4111-8111-111111111111',
      weekdays: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '17:00',
    }],
    preferredFocusWindows: [],
    protectedRoutines: [{
      id: '22222222-2222-4222-8222-222222222222',
      weekdays: [1],
      start: '18:00',
      end: '19:00',
      label: 'Personal routine',
      kind: 'personal',
    }],
  }, 'privacy-routine-0001', db);
  const command = JSON.stringify({
    title: 'Private planning review',
    start: '2026-08-31T09:00:00.000Z',
    end: '2026-08-31T10:00:00.000Z',
    timezone: 'Europe/Lisbon',
    description: 'Private agenda context',
    channel: 'ios',
  });
  db.prepare(`
    INSERT INTO secretary_calendar_command_receipts (
      user_id, tenant_id, idempotency_key, command_instance_id, request_hash, provider_source,
      command_json, state, agenda_item_id, processing_lease_token, processing_lease_expires_at,
      created_at, updated_at, expires_at
    ) VALUES (1, '1', 'privacy-calendar-0001',
              '33333333-3333-4333-8333-333333333333', ?, 'google', ?, 'sync_pending',
              'privacy-agenda-1', 'private-command-lease', '2026-08-30T10:05:00.000Z',
              '2026-08-30T10:00:00.000Z',
              '2026-08-30T10:00:00.000Z', '2026-09-29T10:00:00.000Z')
  `).run('a'.repeat(64), command);
  db.prepare(`
    INSERT INTO secretary_calendar_command_payloads (
      agenda_item_id, user_id, tenant_id, command_json, created_at, updated_at
    ) VALUES ('privacy-agenda-1', 1, '1', ?,
              '2026-08-30T10:00:00.000Z', '2026-08-30T10:00:00.000Z')
  `).run(command);
  db.prepare(`
    INSERT INTO secretary_calendar_mutation_receipts (
      user_id, tenant_id, idempotency_key, request_hash, operation,
      provider_source, provider_event_id, command_json, state,
      processing_lease_token, processing_lease_expires_at, created_at, updated_at, expires_at
    ) VALUES (1, '1', 'privacy-calendar-mutation-0001', ?, 'update',
              'google', 'private-provider-event', ?, 'prechecking',
              'private-mutation-lease', '2026-08-30T10:05:00.000Z',
              '2026-08-30T10:00:00.000Z', '2026-08-30T10:00:00.000Z',
              '2026-09-29T10:00:00.000Z')
  `).run('b'.repeat(64), JSON.stringify({
    operation: 'update',
    source: 'google',
    eventId: 'private-provider-event',
    title: 'Updated private meeting',
    timezone: 'Europe/Lisbon',
    channel: 'ios',
  }));
  db.prepare(`
    INSERT INTO report_documents (
      user_id, type, title, summary, document_json, source_job
    ) VALUES (1, 'morning_briefing', 'Private brief', 'Private summary', '{}', 'daily_briefing')
  `).run();
  db.prepare(`
    INSERT INTO scheduled_job_execution_state (
      job_name, scope_key, last_started_at, last_completed_at,
      last_succeeded_at, last_result, updated_at
    ) VALUES (
      'report:morning_briefing',
      'tenant:1:user:1:local-date:2026-08-31',
      '2026-08-31T06:00:00.000Z', '2026-08-31T06:00:01.000Z',
      '2026-08-31T06:00:01.000Z', 'success', '2026-08-31T06:00:01.000Z'
    )
  `).run();
  db.prepare(`
    INSERT INTO scheduled_job_execution_state (
      job_name, scope_key, last_started_at, last_completed_at,
      last_succeeded_at, last_result, updated_at
    ) VALUES (
      'notification:deliver_intent',
      'tenant:1:user:1:intent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '2026-08-31T06:05:00.000Z', '2026-08-31T06:05:01.000Z',
      '2026-08-31T06:05:01.000Z', 'success', '2026-08-31T06:05:01.000Z'
    )
  `).run();
}

describe('Secretary routine profile privacy lifecycle', () => {
  beforeEach(() => {
    db = createMigratedTestDatabase();
    seedRoutineProfile();
  });

  afterEach(() => {
    db.close();
  });

  it('includes the profile and sanitized receipt metadata in the full DSAR export', () => {
    const exported = withDatabaseForTest(db, () => exportAllUserData(1));

    expect(exported.secretaryRoutineProfile).toEqual([
      expect.objectContaining({
        status: 'configured',
        version: 1,
        timezone: 'Europe/Lisbon',
        workingWindows: [expect.objectContaining({ start: '09:00', end: '17:00' })],
        protectedRoutines: [expect.objectContaining({ label: 'Personal routine', kind: 'personal' })],
      }),
    ]);
    expect(exported.secretaryRoutineIdempotencyReceipts).toEqual([
      expect.objectContaining({
        idempotencyKey: 'privacy-routine-0001',
        response: expect.objectContaining({
          changed: true,
          profile: expect.objectContaining({ version: 1, status: 'configured' }),
        }),
      }),
    ]);
    expect(JSON.stringify(exported.secretaryRoutineIdempotencyReceipts)).not.toContain('request_hash');
    expect(exported.secretaryCalendarCommandReceipts).toEqual([
      expect.objectContaining({
        idempotencyKey: 'privacy-calendar-0001',
        providerSource: 'google',
        state: 'sync_pending',
        command: expect.objectContaining({ description: 'Private agenda context' }),
      }),
    ]);
    expect(JSON.stringify(exported.secretaryCalendarCommandReceipts)).not.toContain('request_hash');
    expect(JSON.stringify(exported.secretaryCalendarCommandReceipts)).not.toContain('private-command-lease');
    expect(exported.secretaryCalendarCommandPayloads).toEqual([
      expect.objectContaining({
        agendaItemId: 'privacy-agenda-1',
        command: expect.objectContaining({ description: 'Private agenda context' }),
      }),
    ]);
    expect(exported.secretaryCalendarMutationReceipts).toEqual([
      expect.objectContaining({
        idempotencyKey: 'privacy-calendar-mutation-0001',
        operation: 'update',
        command: expect.objectContaining({ title: 'Updated private meeting' }),
      }),
    ]);
    expect(JSON.stringify(exported.secretaryCalendarMutationReceipts)).not.toContain('request_hash');
    expect(JSON.stringify(exported.secretaryCalendarMutationReceipts)).not.toContain('private-mutation-lease');
    expect(exported.reportScheduleExecutionState).toEqual([
      expect.objectContaining({
        jobName: 'report:morning_briefing',
        scopeKey: 'tenant:1:user:1:local-date:2026-08-31',
        lastResult: 'success',
      }),
    ]);
    expect(JSON.stringify(exported.reportScheduleExecutionState)).not.toContain('leaseToken');
    expect(JSON.stringify(exported.reportScheduleExecutionState)).not.toContain('leaseOwner');
    expect(exported.notificationDeliveryExecutionState).toEqual([
      expect.objectContaining({
        jobName: 'notification:deliver_intent',
        scopeKey: 'tenant:1:user:1:intent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        lastResult: 'success',
      }),
    ]);
    expect(JSON.stringify(exported.notificationDeliveryExecutionState)).not.toContain('leaseToken');
    expect(JSON.stringify(exported.notificationDeliveryExecutionState)).not.toContain('leaseOwner');
  });

  it('inventories and deletes both routine tables during account erasure', () => {
    const inventory = withDatabaseForTest(db, () => getAccountDeletionInventoryForUser(1));
    expect(inventory.deletableTables.secretary_routine_profiles).toBe(1);
    expect(inventory.deletableTables.secretary_routine_idempotency_receipts).toBe(1);
    expect(inventory.deletableTables.secretary_calendar_command_receipts).toBe(1);
    expect(inventory.deletableTables.secretary_calendar_command_payloads).toBe(1);
    expect(inventory.deletableTables.secretary_calendar_mutation_receipts).toBe(1);
    expect(inventory.deletableTables.scheduled_job_execution_state_reports).toBe(1);
    expect(inventory.deletableTables.scheduled_job_execution_state_notification_deliveries).toBe(1);

    const fenceToken = beginSkillInferenceAccountDeletionFence(1, db);
    let counts: Record<string, number>;
    try {
      counts = withDatabaseForTest(db, () => deleteAllUserData(1, fenceToken));
    } catch (error) {
      clearSkillInferenceAccountDeletionFence(1, fenceToken, db);
      throw error;
    }

    expect(counts.secretary_routine_profiles).toBe(1);
    expect(counts.secretary_routine_idempotency_receipts).toBe(1);
    expect(counts.secretary_calendar_command_receipts).toBe(1);
    expect(counts.secretary_calendar_command_payloads).toBe(1);
    expect(counts.secretary_calendar_mutation_receipts).toBe(1);
    expect(counts.scheduled_job_execution_state_reports).toBe(1);
    expect(counts.scheduled_job_execution_state_notification_deliveries).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_profiles').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_idempotency_receipts').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_calendar_command_receipts').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_calendar_command_payloads').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_calendar_mutation_receipts').get())
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM scheduled_job_execution_state
       WHERE job_name LIKE 'report:%'
         AND scope_key = 'tenant:1:user:1:local-date:2026-08-31'
    `).get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM scheduled_job_execution_state
       WHERE job_name = 'notification:deliver_intent'
         AND scope_key = 'tenant:1:user:1:intent:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    `).get()).toEqual({ count: 0 });
  });
});

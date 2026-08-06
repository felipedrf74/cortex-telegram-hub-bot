import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql');
const MIGRATION_098 = path.resolve(__dirname, '../../migrations/098_secretary_decision_explanation.sql');
const MIGRATION_126 = path.resolve(__dirname, '../../migrations/126_secretary_reasoning_trail.sql');
const MIGRATION_276 = path.resolve(__dirname, '../../migrations/276_training_secretary_feedback_durability.sql');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretarySourceSkillFeedback,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  _resetSecretaryFeedbackBusForTests,
} from '../../src/services/secretary-feedback-bus';
import {
  _resetTrainingSecretaryFeedbackConsumerForTests,
  getLatestTrainingSecretaryFeedbackDecisionForPlan,
  listCurrentTrainingSecretaryFeedbackDecisionsForPlan,
  listTrainingSecretaryFeedbackDecisions,
  recordTrainingSecretaryFeedback,
  registerTrainingSecretaryFeedbackConsumer,
} from '../../src/services/training-secretary-feedback-consumer';
import {
  emitDomainEvent,
  ensureEventOutboxTables,
  processPendingEvents,
} from '../../src/services/event-outbox';
import { defaultEventHandlers } from '../../src/services/event-backbone-worker';

const OWNER_USER_ID = 77;
const TENANT_ID = 'tenant-training-feedback';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  testDb.exec(fs.readFileSync(MIGRATION_126, 'utf8'));
  // RED-checkpoint compatibility: exercise the consumer semantics before the
  // production migration exists. A separate test below still requires the
  // real migration so this fallback cannot accidentally become the contract.
  if (fs.existsSync(MIGRATION_276)) {
    testDb.exec(fs.readFileSync(MIGRATION_276, 'utf8'));
  } else {
    testDb.exec('ALTER TABLE training_feedback_decisions ADD COLUMN agenda_version INTEGER NOT NULL DEFAULT 1');
  }
  _resetSecretaryFeedbackBusForTests();
  _resetTrainingSecretaryFeedbackConsumerForTests();
  registerTrainingSecretaryFeedbackConsumer();
});

afterEach(() => {
  _resetSecretaryFeedbackBusForTests();
  _resetTrainingSecretaryFeedbackConsumerForTests();
  testDb.close();
});

function compressedTrainingIntent(intentId: string): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'training',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `Compressed training ${intentId}`,
    requestedDurationMinutes: 60,
    minimumDurationMinutes: 30,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T08:30:00.000Z' }],
    priority: 'medium',
    flexibility: 'compressible',
  };
}

function secretaryFeedback(overrides: Partial<SecretarySourceSkillFeedback>): SecretarySourceSkillFeedback {
  const intentId = overrides.sourceIntentId ?? `feedback-${overrides.status ?? 'scheduled'}`;
  return {
    sourceSkill: 'training',
    ownerUserId: overrides.ownerUserId ?? OWNER_USER_ID,
    tenantId: overrides.tenantId ?? TENANT_ID,
    agendaItemId: overrides.agendaItemId ?? `sec_agenda_${intentId}`,
    sourceIntentId: intentId,
    agendaVersion: overrides.agendaVersion ?? 1,
    status: overrides.status ?? 'scheduled',
    reasonCodes: overrides.reasonCodes ?? ['scheduled_in_available_window'],
    scheduledStart: overrides.scheduledStart ?? '2026-05-20T08:00:00.000Z',
    scheduledEnd: overrides.scheduledEnd ?? '2026-05-20T09:00:00.000Z',
    shouldRefreshSource: overrides.shouldRefreshSource ?? false,
    downstreamImplications: overrides.downstreamImplications ?? [],
  };
}

function emitTrainingFeedbackEvent(
  decision: SecretarySchedulingDecision,
  agendaTenantId: string = TENANT_ID,
): void {
  emitDomainEvent({
    tenantId: OWNER_USER_ID,
    userId: OWNER_USER_ID,
    sourceSkill: 'secretary',
    eventType: 'secretary.training_feedback.requested.v1',
    entityType: 'secretary_agenda_item',
    entityId: decision.agendaItem.agendaItemId,
    entityVersion: decision.agendaItem.version,
    schemaVersion: 'secretary-training-feedback-v1',
    payload: { agendaTenantId },
    privacyClassification: 'health',
    idempotencyKey: `secretary.training_feedback.requested:${decision.agendaItem.agendaItemId}:${decision.agendaItem.version}`,
  }, testDb);
}

describe('Training Secretary feedback consumer', () => {
  it('ships migration 276 with the monotonic agenda-version column', () => {
    expect(fs.existsSync(MIGRATION_276)).toBe(true);
    if (!fs.existsSync(MIGRATION_276)) return;

    const migrationDb = new Database(':memory:');
    try {
      migrationDb.exec(`
        CREATE TABLE secretary_agenda_items (
          agenda_item_id TEXT PRIMARY KEY,
          source_intent_id TEXT NOT NULL,
          source_skill TEXT NOT NULL,
          owner_user_id INTEGER NOT NULL,
          tenant_id TEXT NOT NULL,
          version INTEGER NOT NULL
        );
        INSERT INTO secretary_agenda_items (
          agenda_item_id, source_intent_id, source_skill, owner_user_id, tenant_id, version
        ) VALUES
          ('legacy-agenda-v1', 'legacy-intent', 'training', 77, 'legacy-tenant', 1),
          ('legacy-agenda-v2', 'legacy-intent', 'training', 77, 'legacy-tenant', 2);
      `);
      migrationDb.exec(fs.readFileSync(MIGRATION_126, 'utf8'));
      migrationDb.prepare(`
        INSERT INTO training_feedback_decisions (
          user_id, tenant_id, agenda_item_id, source_intent_id,
          feedback_type, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(77, 'legacy-tenant', 'legacy-agenda-v1', 'legacy-intent', 'schedule_confirmed', 'scheduled',
        '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z');
      migrationDb.prepare(`
        INSERT INTO training_feedback_decisions (
          user_id, tenant_id, agenda_item_id, source_intent_id,
          feedback_type, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(77, 'legacy-tenant', 'legacy-agenda-v2', 'legacy-intent', 'reflowed_session', 'reflowed',
        '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z');
      migrationDb.exec(fs.readFileSync(MIGRATION_276, 'utf8'));
      const columns = migrationDb.prepare('PRAGMA table_info(training_feedback_decisions)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('agenda_version');
      expect(migrationDb.prepare(`
        SELECT agenda_item_id, agenda_version, status
        FROM training_feedback_decisions
        WHERE user_id = 77 AND tenant_id = 'legacy-tenant' AND source_intent_id = 'legacy-intent'
      `).all()).toEqual([{ agenda_item_id: 'legacy-agenda-v2', agenda_version: 2, status: 'reflowed' }]);
      expect(() => migrationDb.prepare(`
        INSERT INTO training_feedback_decisions (
          user_id, tenant_id, agenda_item_id, source_intent_id,
          feedback_type, status, created_at, updated_at
        ) VALUES (77, 'legacy-tenant', 'legacy-agenda-v3', 'legacy-intent',
                  'schedule_attention', 'unscheduled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run()).toThrow(/UNIQUE constraint failed/);
    } finally {
      migrationDb.close();
    }
  });

  it('persists the agenda mutation and durable feedback event in one transaction', () => {
    ensureEventOutboxTables(testDb);
    testDb.exec(`
      CREATE TRIGGER fail_training_feedback_event
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'secretary.training_feedback.requested.v1'
      BEGIN
        SELECT RAISE(ABORT, 'injected feedback outbox failure');
      END;
    `);

    expect(() => submitSecretarySchedulingIntent(compressedTrainingIntent('atomic-feedback')))
      .toThrow(/injected feedback outbox failure/);
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM secretary_agenda_items
      WHERE owner_user_id = ? AND tenant_id = ? AND source_intent_id = ?
    `).get(OWNER_USER_ID, TENANT_ID, 'atomic-feedback')).toEqual({ count: 0 });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM training_feedback_decisions
      WHERE user_id = ? AND tenant_id = ? AND source_intent_id = ?
    `).get(OWNER_USER_ID, TENANT_ID, 'atomic-feedback')).toEqual({ count: 0 });
  });

  it('maps a string Secretary tenant to the owner-scoped outbox partition without losing exact scope', () => {
    const decision = submitSecretarySchedulingIntent(compressedTrainingIntent('string-tenant-outbox'));
    const row = testDb.prepare(`
      SELECT tenant_id, user_id, source_skill, event_type, entity_type,
             entity_id, entity_version, schema_version, payload_json,
             privacy_classification, idempotency_key
      FROM event_outbox
      WHERE event_type = 'secretary.training_feedback.requested.v1'
    `).get() as Record<string, unknown> | undefined;

    expect(row).toMatchObject({
      tenant_id: OWNER_USER_ID,
      user_id: OWNER_USER_ID,
      source_skill: 'secretary',
      event_type: 'secretary.training_feedback.requested.v1',
      entity_type: 'secretary_agenda_item',
      entity_id: decision.agendaItem.agendaItemId,
      entity_version: decision.agendaItem.version,
      schema_version: 'secretary-training-feedback-v1',
      privacy_classification: 'health',
      idempotency_key: `secretary.training_feedback.requested:${decision.agendaItem.agendaItemId}:${decision.agendaItem.version}`,
    });
    expect(JSON.parse(String(row?.payload_json))).toEqual({ agendaTenantId: TENANT_ID });
  });

  it('drains durable feedback after consumer registration state is lost on restart', async () => {
    const decision = submitSecretarySchedulingIntent(compressedTrainingIntent('restart-feedback'));
    testDb.prepare(`
      DELETE FROM training_feedback_decisions
      WHERE user_id = ? AND tenant_id = ? AND source_intent_id = ?
    `).run(OWNER_USER_ID, TENANT_ID, 'restart-feedback');
    _resetSecretaryFeedbackBusForTests();
    _resetTrainingSecretaryFeedbackConsumerForTests();

    const result = await processPendingEvents(defaultEventHandlers, {
      limit: 10,
      lockOwner: 'training-feedback-restart-test',
      db: testDb,
    });

    expect(result).toEqual({ processed: 1, failed: 0, deadLetter: 0 });
    expect(listTrainingSecretaryFeedbackDecisions({ userId: OWNER_USER_ID, tenantId: TENANT_ID }))
      .toEqual([expect.objectContaining({
        agendaItemId: decision.agendaItem.agendaItemId,
        sourceIntentId: 'restart-feedback',
        agendaVersion: 1,
        status: 'compressed',
      })]);
  });

  it('rejects a durable event whose exact Secretary tenant does not own the agenda item', async () => {
    ensureEventOutboxTables(testDb);
    const decision = submitSecretarySchedulingIntent(compressedTrainingIntent('tenant-tamper'));
    testDb.prepare("DELETE FROM event_outbox WHERE event_type = 'secretary.training_feedback.requested.v1'").run();
    testDb.prepare('DELETE FROM training_feedback_decisions WHERE source_intent_id = ?').run('tenant-tamper');
    emitTrainingFeedbackEvent(decision, 'different-tenant');

    const result = await processPendingEvents(defaultEventHandlers, {
      limit: 10,
      lockOwner: 'training-feedback-tenant-test',
      db: testDb,
    });

    expect(result).toEqual({ processed: 0, failed: 1, deadLetter: 0 });
    expect(listTrainingSecretaryFeedbackDecisions({ userId: OWNER_USER_ID, tenantId: TENANT_ID }))
      .toHaveLength(0);
  });

  it('keeps one monotonic state per scoped source intent under out-of-order delivery', () => {
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_monotonic_v2',
      sourceIntentId: 'monotonic-source',
      agendaVersion: 2,
      status: 'reflowed',
      reasonCodes: ['reflowed_to_available_window'],
      shouldRefreshSource: true,
      scheduledStart: '2026-05-21T09:00:00.000Z',
      scheduledEnd: '2026-05-21T10:00:00.000Z',
    }));
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_monotonic_v1',
      sourceIntentId: 'monotonic-source',
      agendaVersion: 1,
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      shouldRefreshSource: false,
    }));

    expect(listTrainingSecretaryFeedbackDecisions({ userId: OWNER_USER_ID, tenantId: TENANT_ID }))
      .toEqual([expect.objectContaining({
        agendaItemId: 'sec_agenda_monotonic_v2',
        sourceIntentId: 'monotonic-source',
        agendaVersion: 2,
        status: 'reflowed',
        scheduledStart: '2026-05-21T09:00:00.000Z',
      })]);
  });

  it('reads only the newest monotonic decision for the requested Training plan', () => {
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_plan_501_v4',
      sourceIntentId: 'training:501:9:77',
      agendaVersion: 4,
      status: 'compressed',
      reasonCodes: ['compressed_to_fit_capacity', 'duration_reduced'],
      shouldRefreshSource: true,
      scheduledStart: '2026-05-21T09:00:00.000Z',
      scheduledEnd: '2026-05-21T09:30:00.000Z',
    }));
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_plan_501_delayed_v3',
      sourceIntentId: 'training:501:9:77',
      agendaVersion: 3,
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      shouldRefreshSource: false,
    }));
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_other_plan_v9',
      sourceIntentId: 'training:502:1:88',
      agendaVersion: 9,
      status: 'unscheduled',
      reasonCodes: ['unscheduled_no_capacity'],
      shouldRefreshSource: true,
      scheduledStart: null,
      scheduledEnd: null,
    }));
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_old_plan_version_v9',
      sourceIntentId: 'training:501:8:66',
      agendaVersion: 9,
      status: 'unscheduled',
      reasonCodes: ['unscheduled_no_capacity'],
      shouldRefreshSource: true,
      scheduledStart: null,
      scheduledEnd: null,
    }));
    recordTrainingSecretaryFeedback(secretaryFeedback({
      ownerUserId: OWNER_USER_ID + 1,
      agendaItemId: 'sec_agenda_other_user_v10',
      sourceIntentId: 'training:501:9:77',
      agendaVersion: 10,
      status: 'unscheduled',
      reasonCodes: ['unscheduled_no_capacity'],
      shouldRefreshSource: true,
      scheduledStart: null,
      scheduledEnd: null,
    }));
    recordTrainingSecretaryFeedback(secretaryFeedback({
      tenantId: 'tenant-training-feedback-other',
      agendaItemId: 'sec_agenda_other_tenant_v11',
      sourceIntentId: 'training:501:9:77',
      agendaVersion: 11,
      status: 'unscheduled',
      reasonCodes: ['unscheduled_no_capacity'],
      shouldRefreshSource: true,
      scheduledStart: null,
      scheduledEnd: null,
    }));

    expect(getLatestTrainingSecretaryFeedbackDecisionForPlan({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      planId: 501,
      planVersion: 9,
    })).toEqual(expect.objectContaining({
      agendaItemId: 'sec_agenda_plan_501_v4',
      sourceIntentId: 'training:501:9:77',
      agendaVersion: 4,
      status: 'compressed',
      scheduledEnd: '2026-05-21T09:30:00.000Z',
    }));
  });

  it('keeps unresolved plan-session state ahead of a later routine scheduled decision without cross-intent version ordering', () => {
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_plan_601_session_77_v7',
      sourceIntentId: 'training:601:3:77',
      agendaVersion: 7,
      status: 'unscheduled',
      reasonCodes: ['unscheduled_no_capacity'],
      shouldRefreshSource: true,
      scheduledStart: null,
      scheduledEnd: null,
    }));
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_plan_601_session_88_v1',
      sourceIntentId: 'training:601:3:88',
      agendaVersion: 1,
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      shouldRefreshSource: false,
    }));
    // RED guarantee: agenda_version is monotonic only within one source intent.
    // Force an equal timestamp so the plan read cannot accidentally use that
    // per-session version as a plan-wide recency clock.
    testDb.prepare(`
      UPDATE training_feedback_decisions
      SET updated_at = '2026-05-21T12:00:00.000Z'
      WHERE user_id = ? AND tenant_id = ?
        AND substr(source_intent_id, 1, length('training:601:3:')) = 'training:601:3:'
    `).run(OWNER_USER_ID, TENANT_ID);

    const rows = listCurrentTrainingSecretaryFeedbackDecisionsForPlan({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      planId: 601,
      planVersion: 3,
    });

    expect(rows.map((row) => row.status)).toEqual(['unscheduled', 'scheduled']);
    expect(getLatestTrainingSecretaryFeedbackDecisionForPlan({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      planId: 601,
      planVersion: 3,
    })?.status).toBe('unscheduled');
  });

  it('does not let an equal-version replay mutate already-consumed state', () => {
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_replay_v3',
      sourceIntentId: 'equal-version-replay',
      agendaVersion: 3,
      status: 'reflowed',
      reasonCodes: ['reflowed_to_available_window'],
      shouldRefreshSource: true,
    }));
    recordTrainingSecretaryFeedback(secretaryFeedback({
      agendaItemId: 'sec_agenda_conflicting_v3',
      sourceIntentId: 'equal-version-replay',
      agendaVersion: 3,
      status: 'unscheduled',
      reasonCodes: ['unscheduled_no_capacity'],
      shouldRefreshSource: true,
      scheduledStart: null,
      scheduledEnd: null,
    }));

    expect(listTrainingSecretaryFeedbackDecisions({ userId: OWNER_USER_ID, tenantId: TENANT_ID }))
      .toEqual([expect.objectContaining({
        agendaItemId: 'sec_agenda_replay_v3',
        agendaVersion: 3,
        status: 'reflowed',
      })]);
  });

  it('records compressed-session feedback with recovery-debt hints', () => {
    submitSecretarySchedulingIntent(compressedTrainingIntent('compressed-1'));

    const rows = listTrainingSecretaryFeedbackDecisions({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agendaItemId: expect.stringMatching(/^sec_agenda_/),
      sourceIntentId: 'compressed-1',
      feedbackType: 'compressed_session',
      status: 'compressed',
      shouldRefreshSource: true,
    });
    expect(rows[0].hints).toEqual(expect.arrayContaining([
      'recovery_debt',
      'adapt_workload_to_capacity',
      'refresh_training_plan_context',
    ]));
  });

  it('dedupes repeat feedback for the same agenda item and source intent', () => {
    submitSecretarySchedulingIntent(compressedTrainingIntent('compressed-dedupe'));
    submitSecretarySchedulingIntent(compressedTrainingIntent('compressed-dedupe'));

    const rows = listTrainingSecretaryFeedbackDecisions({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceIntentId).toBe('compressed-dedupe');
  });

  it.each([
    {
      status: 'reflowed',
      feedbackType: 'reflowed_session',
      expectedHints: ['refresh_user_facing_time_copy', 'refresh_training_plan_context'],
      downstreamImplications: ['Move visible Training session time copy to the chosen Secretary slot.'],
    },
    {
      status: 'unscheduled',
      feedbackType: 'schedule_attention',
      expectedHints: ['refresh_training_plan_context'],
      downstreamImplications: ['Training needs user input before this session can be placed.'],
    },
    {
      status: 'needs_more_context',
      feedbackType: 'needs_context',
      expectedHints: ['refresh_training_plan_context'],
      downstreamImplications: ['Training needs missing time-window context before planning.'],
    },
  ] as const)('records %s feedback with the expected Training hints', ({
    status,
    feedbackType,
    expectedHints,
    downstreamImplications,
  }) => {
    recordTrainingSecretaryFeedback(secretaryFeedback({
      sourceIntentId: `${status}-source`,
      status,
      reasonCodes: status === 'reflowed' ? ['reflowed_to_available_window'] : ['unscheduled_no_capacity'],
      shouldRefreshSource: true,
      downstreamImplications,
      scheduledStart: status === 'needs_more_context' ? null : '2026-05-20T09:00:00.000Z',
      scheduledEnd: status === 'needs_more_context' ? null : '2026-05-20T10:00:00.000Z',
    }));

    const rows = listTrainingSecretaryFeedbackDecisions({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceIntentId: `${status}-source`,
      feedbackType,
      status,
      shouldRefreshSource: true,
    });
    expect(rows[0].hints).toEqual(expect.arrayContaining(expectedHints));
  });
});

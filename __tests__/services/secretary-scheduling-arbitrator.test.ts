import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(
  __dirname,
  '../../migrations/083_secretary_agenda_ledger.sql',
);
const MIGRATION_098 = path.resolve(
  __dirname,
  '../../migrations/098_secretary_decision_explanation.sql',
);
const MIGRATION_224 = path.resolve(
  __dirname,
  '../../migrations/224_secretary_agenda_sync_fingerprint.sql',
);

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
  arbitrateSecretarySchedulingIntents,
  computeSecretaryAgendaProviderSyncFingerprint,
  getSecretaryAgendaItemById,
  listSecretaryAgendaItems,
  markSecretaryAgendaProviderCleanupRequired,
  markSecretaryAgendaProviderSyncSatisfied,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
  type SecretaryTimeWindow,
} from '../../src/services/secretary-scheduling-arbitrator';

const TENANT_ID = 'tenant-secretary-test';
const OWNER_USER_ID = 42;

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_224, 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
});

afterEach(() => {
  testDb.close();
});

function timeWindow(start: string, end: string, label?: string): SecretaryTimeWindow {
  return { start, end, label };
}

function intent(overrides: Partial<SecretarySchedulingIntent> = {}): SecretarySchedulingIntent {
  return {
    intentId: 'intent-training-1',
    sourceSkill: 'training',
    sourceAction: 'schedule_session',
    sourceEntityId: 'session-1',
    sourceEntityType: 'training_session',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: 'Strength session',
    requestedDurationMinutes: 60,
    preferredWindows: [
      timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T11:00:00.000Z', 'morning'),
    ],
    priority: 'high',
    flexibility: 'fixed',
    ...overrides,
  };
}

describe('secretary-scheduling-arbitrator', () => {
  it('hard-fails missing tenant scope before persisting agenda rows', () => {
    expect(() => submitSecretarySchedulingIntent(intent({ tenantId: '  ' }))).toThrow(/SECRETARY_INVALID_TENANT_SCOPE/);
    expect(() => arbitrateSecretarySchedulingIntents([intent({ tenantId: '' })])).toThrow(/SECRETARY_INVALID_TENANT_SCOPE/);
    expect(listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    })).toHaveLength(0);
  });

  it('schedules a Training intent through Secretary with source attribution and lifecycle state', () => {
    const decision = submitSecretarySchedulingIntent(intent(), {
      now: '2026-05-01T08:00:00.000Z',
    });

    expect(decision.status).toBe('scheduled');
    expect(decision.selectedSlot).toEqual({
      start: '2026-05-04T09:00:00.000Z',
      end: '2026-05-04T10:00:00.000Z',
      label: 'morning',
    });
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      'scheduled_in_available_window',
      'training_schedule_request',
      'fixed_intent_respected',
    ]));
    expect(decision.agendaItem.sourceSkill).toBe('training');
    expect(decision.agendaItem.sourceIntentId).toBe('intent-training-1');
    expect(decision.agendaItem.sourceEntityId).toBe('session-1');
    expect(decision.agendaItem.lifecycleState).toBe('scheduled');
    expect(decision.agendaItem.providerSyncState).toBe('not_synced');
    expect(decision.feedback).toMatchObject({
      sourceSkill: 'training',
      status: 'scheduled',
      shouldRefreshSource: false,
      scheduledStart: '2026-05-04T09:00:00.000Z',
      scheduledEnd: '2026-05-04T10:00:00.000Z',
    });
  });

  it('marks Training-created provider events as Secretary synced to prevent duplicate provider writes', () => {
    const decision = submitSecretarySchedulingIntent(intent(), {
      now: '2026-05-01T08:00:00.000Z',
    });

    const updated = markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'outlook-training-event-1',
      providerSource: 'outlook',
      now: '2026-05-01T08:05:00.000Z',
    });

    expect(updated).toMatchObject({
      agendaItemId: decision.agendaItem.agendaItemId,
      lifecycleState: 'synced',
      providerSyncState: 'synced',
      providerEventId: 'outlook-training-event-1',
      providerSource: 'outlook',
    });
    expect(getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'synced',
      providerSyncState: 'synced',
      providerEventId: 'outlook-training-event-1',
      providerSource: 'outlook',
    });
  });

  it('records the provider-sync fingerprint on markSatisfied so the sync loop can short-circuit', () => {
    const decision = submitSecretarySchedulingIntent(intent(), {
      now: '2026-05-01T08:00:00.000Z',
    });

    const updated = markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'outlook-training-event-1',
      providerSource: 'outlook',
      now: '2026-05-01T08:05:00.000Z',
    });

    expect(updated?.lastSyncedFingerprint).toBe(
      computeSecretaryAgendaProviderSyncFingerprint(updated!, 'outlook'),
    );
    expect(updated?.lastSyncedVerifiedAt).toBe('2026-05-01T08:05:00.000Z');
  });

  it('promotes failed_sync rows back to synced when Training satisfies the provider sync', () => {
    const decision = submitSecretarySchedulingIntent(intent(), {
      now: '2026-05-01T08:00:00.000Z',
    });
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'failed_sync',
             provider_sync_state = 'create_failed'
       WHERE agenda_item_id = ?
    `).run(decision.agendaItem.agendaItemId);

    const updated = markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-training-event-1',
      providerSource: 'google',
      now: '2026-05-01T08:05:00.000Z',
    });

    // Pre-fix the row stayed lifecycle 'failed_sync' while the fresh
    // fingerprint short-circuited the loop that used to heal it, so Decision
    // Center reported a failed session for up to 6h despite a correct event.
    expect(updated).toMatchObject({
      lifecycleState: 'synced',
      providerSyncState: 'synced',
      providerEventId: 'google-training-event-1',
    });
  });

  it('markSatisfied stays functional on pre-fingerprint database schemas', () => {
    testDb.close();
    testDb = new Database(':memory:');
    testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
    testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
    testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
    const decision = submitSecretarySchedulingIntent(intent(), {
      now: '2026-05-01T08:00:00.000Z',
    });

    const updated = markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'outlook-training-event-1',
      providerSource: 'outlook',
      now: '2026-05-01T08:05:00.000Z',
    });

    expect(updated).toMatchObject({
      lifecycleState: 'synced',
      providerSyncState: 'synced',
      providerEventId: 'outlook-training-event-1',
    });
    expect(updated?.lastSyncedFingerprint ?? null).toBeNull();
  });

  it('marks Training permanent provider failures as cleanup rows and clears stale provider ids', () => {
    const scheduled = submitSecretarySchedulingIntent(intent({ intentId: 'cleanup-scheduled' }), {
      now: '2026-05-01T08:00:00.000Z',
    });
    const completed = submitSecretarySchedulingIntent(intent({ intentId: 'cleanup-completed' }), {
      now: '2026-05-01T08:00:00.000Z',
    });

    for (const [decision, eventId] of [
      [scheduled, 'event-scheduled'],
      [completed, 'event-completed'],
    ] as const) {
      markSecretaryAgendaProviderSyncSatisfied({
        agendaItemId: decision.agendaItem.agendaItemId,
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        providerEventId: eventId,
        providerSource: 'google',
        now: '2026-05-01T08:05:00.000Z',
      });
    }
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'completed'
       WHERE agenda_item_id = ?
    `).run(completed.agendaItem.agendaItemId);

    markSecretaryAgendaProviderCleanupRequired({
      agendaItemId: scheduled.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerSyncState: 'deleted',
      lifecycleState: 'unscheduled',
      reason: 'training_provider_ownership_record_failed',
      clearProviderMapping: true,
      now: '2026-05-01T08:10:00.000Z',
    });
    markSecretaryAgendaProviderCleanupRequired({
      agendaItemId: completed.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerSyncState: 'deleted',
      lifecycleState: 'unscheduled',
      reason: 'training_provider_ownership_record_failed',
      clearProviderMapping: true,
      now: '2026-05-01T08:10:00.000Z',
    });

    expect(getSecretaryAgendaItemById({
      agendaItemId: scheduled.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'unscheduled',
      providerSyncState: 'deleted',
      providerEventId: null,
      providerSource: null,
      cancellationReason: 'training_provider_ownership_record_failed',
    });
    expect(getSecretaryAgendaItemById({
      agendaItemId: completed.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'completed',
      providerSyncState: 'synced',
      providerEventId: 'event-completed',
      providerSource: 'google',
    });
  });

  it('retains provider mapping when provider cleanup delete fails for retry visibility', () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'cleanup-delete-failed',
      sourceEntityId: 'session-cleanup-delete-failed',
    }), {
      now: '2026-05-01T08:00:00.000Z',
    });

    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'event-delete-retry',
      providerSource: 'google',
      now: '2026-05-01T08:05:00.000Z',
    });

    markSecretaryAgendaProviderCleanupRequired({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'event-delete-retry',
      providerSource: 'google',
      providerSyncState: 'delete_failed',
      lifecycleState: 'unscheduled',
      reason: 'training_provider_ownership_record_failed',
      clearProviderMapping: false,
      now: '2026-05-01T08:10:00.000Z',
    });

    expect(getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'unscheduled',
      providerSyncState: 'delete_failed',
      providerEventId: 'event-delete-retry',
      providerSource: 'google',
      cancellationReason: 'training_provider_ownership_record_failed',
    });
  });

  it('persists the human-readable decision explanation for iOS/support read-back', () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'explanation-roundtrip',
      title: 'Explainable planning block',
    }), {
      now: '2026-05-01T08:00:00.000Z',
    });

    const stored = getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });

    expect(decision.explanation).toContain('scheduled');
    expect(stored?.decisionExplanation).toBe(decision.explanation);
  });

  it('persists selected and alternative candidate slots for Decision Center enrichment', () => {
    const request = intent({
      intentId: 'decision-center-candidates',
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'best'),
        timeWindow('2026-05-04T10:00:00.000Z', '2026-05-04T11:00:00.000Z', 'backup'),
      ],
    });
    const decision = submitSecretarySchedulingIntent(request, {
      now: '2026-05-01T08:00:00.000Z',
    });

    expect(decision.selectedSlot).toMatchObject({
      start: '2026-05-04T09:00:00.000Z',
      end: '2026-05-04T10:00:00.000Z',
    });
    expect(decision.alternativeSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        start: '2026-05-04T10:00:00.000Z',
        end: '2026-05-04T11:00:00.000Z',
      }),
    ]));
    expect(decision.agendaItem.scheduledSegments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        start: '2026-05-04T09:00:00.000Z',
        end: '2026-05-04T10:00:00.000Z',
      }),
      expect.objectContaining({
        start: '2026-05-04T10:00:00.000Z',
        end: '2026-05-04T11:00:00.000Z',
      }),
    ]));

    const retry = submitSecretarySchedulingIntent(request, {
      now: '2026-05-01T08:05:00.000Z',
    });
    expect(retry.agendaItem.agendaItemId).toBe(decision.agendaItem.agendaItemId);
    expect(retry.alternativeSlots).toHaveLength(1);
    expect(retry.alternativeSlots[0]).toMatchObject({
      start: '2026-05-04T10:00:00.000Z',
      end: '2026-05-04T11:00:00.000Z',
    });
  });

  it('places Cooking prep after an existing Training block instead of overlapping it', () => {
    submitSecretarySchedulingIntent(intent({
      intentId: 'training-block',
      title: 'Bike intervals',
      requestedDurationMinutes: 60,
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'workout'),
      ],
    }));

    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'cooking-prep',
      sourceSkill: 'cooking',
      sourceAction: 'schedule_meal_prep',
      sourceEntityId: 'meal-prep-1',
      sourceEntityType: 'meal_prep_block',
      title: 'Meal prep',
      requestedDurationMinutes: 60,
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T12:00:00.000Z', 'prep window'),
      ],
      priority: 'normal',
      flexibility: 'flexible',
    }));

    expect(decision.status).toBe('scheduled');
    expect(decision.selectedSlot?.start).toBe('2026-05-04T10:00:00.000Z');
    expect(decision.selectedSlot?.end).toBe('2026-05-04T11:00:00.000Z');
    expect(decision.reasonCodes).toContain('cooking_support_request');
    expect(decision.conflicts.join('\n')).toContain('Bike intervals');
  });

  it('prioritizes Finance deadline intents over flexible Content work when capacity conflicts', () => {
    const batch = arbitrateSecretarySchedulingIntents([
      intent({
        intentId: 'content-writing',
        sourceSkill: 'content',
        sourceAction: 'schedule_writing_block',
        sourceEntityId: 'draft-1',
        sourceEntityType: 'content_block',
        title: 'Write launch post',
        requestedDurationMinutes: 60,
        preferredWindows: [
          timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'focus'),
        ],
        priority: 'normal',
        flexibility: 'fixed',
      }),
      intent({
        intentId: 'finance-bill',
        sourceSkill: 'finance',
        sourceAction: 'schedule_bill_review',
        sourceEntityId: 'bill-1',
        sourceEntityType: 'bill_review',
        title: 'Review bill due tomorrow',
        requestedDurationMinutes: 60,
        preferredWindows: [
          timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'admin'),
        ],
        deadline: '2026-05-05T12:00:00.000Z',
        priority: 'high',
        flexibility: 'fixed',
      }),
    ]);

    const finance = batch.decisions.find((decision) => decision.agendaItem.sourceSkill === 'finance');
    const content = batch.decisions.find((decision) => decision.agendaItem.sourceSkill === 'content');

    expect(finance?.status).toBe('scheduled');
    expect(finance?.reasonCodes).toContain('finance_deadline_priority');
    expect(content?.status).toBe('unscheduled');
    expect(content?.reasonCodes).toContain('no_valid_slot');
    expect(batch.feedbackBySourceSkill.finance[0]?.status).toBe('scheduled');
    expect(batch.feedbackBySourceSkill.content[0]?.shouldRefreshSource).toBe(true);
  });

  it('schedules Content focus blocks with lifecycle state exposed to downstream clients', () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'content-editing',
      sourceSkill: 'content',
      sourceAction: 'schedule_editing_block',
      sourceEntityId: 'edit-1',
      sourceEntityType: 'content_edit',
      title: 'Edit content batch',
      requestedDurationMinutes: 90,
      preferredWindows: [
        timeWindow('2026-05-04T13:00:00.000Z', '2026-05-04T15:00:00.000Z', 'deep work'),
      ],
      priority: 'high',
      flexibility: 'fixed',
    }));

    expect(decision.status).toBe('scheduled');
    expect(decision.agendaItem).toMatchObject({
      sourceSkill: 'content',
      lifecycleState: 'scheduled',
      decisionAction: 'scheduled',
      startAt: '2026-05-04T13:00:00.000Z',
      endAt: '2026-05-04T14:30:00.000Z',
      durationMinutes: 90,
    });
    expect(decision.agendaItem.decisionReasonCodes).toContain('content_focus_request');
  });

  it('creates reminder and follow-up agenda intents with explicit lifecycle and intent actions', () => {
    const reminder = submitSecretarySchedulingIntent(intent({
      intentId: 'finance-reminder',
      action: 'create_reminder',
      sourceSkill: 'finance',
      sourceAction: 'create_payment_reminder',
      sourceEntityId: 'invoice-1',
      sourceEntityType: 'finance_reminder',
      title: 'Payment reminder',
      requestedDurationMinutes: 15,
      preferredWindows: [
        timeWindow('2026-05-04T08:00:00.000Z', '2026-05-04T08:30:00.000Z', 'admin reminder'),
      ],
      deadline: '2026-05-04T12:00:00.000Z',
      priority: 'urgent',
      flexibility: 'fixed',
    }));
    const followUp = submitSecretarySchedulingIntent(intent({
      intentId: 'secretary-follow-up',
      action: 'create_follow_up',
      sourceSkill: 'secretary',
      sourceAction: 'create_external_follow_up',
      sourceEntityId: 'follow-up-1',
      sourceEntityType: 'follow_up',
      title: 'Follow up with Alex',
      requestedDurationMinutes: 15,
      preferredWindows: [
        timeWindow('2026-05-04T08:30:00.000Z', '2026-05-04T09:00:00.000Z', 'follow-up window'),
      ],
      priority: 'normal',
      flexibility: 'fixed',
    }));

    expect(reminder.status).toBe('scheduled');
    expect(reminder.agendaItem.intentAction).toBe('create_reminder');
    expect(reminder.agendaItem.lifecycleState).toBe('scheduled');
    expect(followUp.status).toBe('scheduled');
    expect(followUp.agendaItem.intentAction).toBe('create_follow_up');
    expect(followUp.agendaItem.sourceSkill).toBe('secretary');
  });

  it('prevents duplicate agenda items when the same source intent is retried unchanged', () => {
    const request = intent({
      intentId: 'retry-safe-training',
      sourceEntityId: 'session-retry',
      title: 'Retry-safe ride',
    });
    const first = submitSecretarySchedulingIntent(request);
    const second = submitSecretarySchedulingIntent(request);

    const all = listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    }).filter((item) => item.sourceIntentId === 'retry-safe-training');

    expect(first.status).toBe('scheduled');
    expect(second.status).toBe('scheduled');
    expect(second.agendaItem.agendaItemId).toBe(first.agendaItem.agendaItemId);
    expect(all).toHaveLength(1);
  });

  it('arbitrates competing skill intents with compression and unscheduled feedback', () => {
    const batch = arbitrateSecretarySchedulingIntents([
      intent({
        intentId: 'training-priority',
        sourceSkill: 'training',
        title: 'Run workout',
        requestedDurationMinutes: 60,
        preferredWindows: [
          timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'only slot'),
        ],
        priority: 'urgent',
        flexibility: 'fixed',
      }),
      intent({
        intentId: 'cooking-compress',
        sourceSkill: 'cooking',
        title: 'Grocery prep',
        requestedDurationMinutes: 60,
        minimumDurationMinutes: 30,
        preferredWindows: [
          timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:30:00.000Z', 'shared window'),
        ],
        priority: 'normal',
        flexibility: 'compressible',
      }),
      intent({
        intentId: 'content-low',
        sourceSkill: 'content',
        title: 'Draft newsletter',
        requestedDurationMinutes: 60,
        preferredWindows: [
          timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'same slot'),
        ],
        priority: 'low',
        flexibility: 'fixed',
      }),
    ]);

    const training = batch.decisions.find((decision) => decision.agendaItem.sourceIntentId === 'training-priority');
    const cooking = batch.decisions.find((decision) => decision.agendaItem.sourceIntentId === 'cooking-compress');
    const content = batch.decisions.find((decision) => decision.agendaItem.sourceIntentId === 'content-low');

    expect(training?.status).toBe('scheduled');
    expect(cooking?.status).toBe('compressed');
    expect(cooking?.selectedSlot).toMatchObject({
      start: '2026-05-04T10:00:00.000Z',
      end: '2026-05-04T10:30:00.000Z',
    });
    expect(cooking?.feedback.shouldRefreshSource).toBe(true);
    expect(content?.status).toBe('unscheduled');
    expect(batch.scheduledCount).toBe(2);
    expect(batch.unscheduledCount).toBe(1);
  });

  it('persists an unscheduled lifecycle state when there is no valid slot', () => {
    const decision = submitSecretarySchedulingIntent(intent({
      intentId: 'no-valid-slot',
      sourceSkill: 'training',
      title: 'Long brick workout',
      requestedDurationMinutes: 120,
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'too short'),
      ],
      priority: 'high',
      flexibility: 'fixed',
    }));

    expect(decision.status).toBe('unscheduled');
    expect(decision.selectedSlot).toBeNull();
    expect(decision.agendaItem.lifecycleState).toBe('unscheduled');
    expect(decision.agendaItem.startAt).toBeNull();
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      'unscheduled_no_capacity',
      'no_valid_slot',
      'training_schedule_request',
    ]));
    expect(decision.feedback.shouldRefreshSource).toBe(true);
  });

  it('reuses a deferred same-shape request instead of creating a new agenda version', () => {
    const request = intent({
      intentId: 'deferred-idempotent',
      sourceEntityId: 'session-deferred-idempotent',
      requestedDurationMinutes: 120,
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'too short now'),
      ],
      deadline: '2026-05-07T10:00:00.000Z',
      priority: 'normal',
      flexibility: 'flexible',
    });

    const first = submitSecretarySchedulingIntent(request, {
      now: '2026-05-01T08:00:00.000Z',
    });
    const second = submitSecretarySchedulingIntent(request, {
      now: '2026-05-01T08:05:00.000Z',
    });
    const all = listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    }).filter((item) => item.sourceIntentId === 'deferred-idempotent');

    expect(first.status).toBe('deferred');
    expect(second.status).toBe('deferred');
    expect(second.agendaItem.agendaItemId).toBe(first.agendaItem.agendaItemId);
    expect(second.agendaItem.version).toBe(1);
    expect(second.agendaItem.lifecycleState).toBe('deferred');
    expect(second.selectedSlot).toBeNull();
    expect(all).toHaveLength(1);
  });

  it('reuses a completed same-slot request without deleting and recreating the provider row', () => {
    const request = intent({
      intentId: 'completed-idempotent',
      sourceEntityId: 'session-completed-idempotent',
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T11:00:00.000Z', 'same-slot'),
      ],
    });
    const first = submitSecretarySchedulingIntent(request, {
      now: '2026-05-01T08:00:00.000Z',
    });
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: first.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'outlook-completed-event',
      providerSource: 'outlook',
      now: '2026-05-01T08:05:00.000Z',
    });
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'completed',
             completed_at = ?
       WHERE agenda_item_id = ?
    `).run('2026-05-04T10:05:00.000Z', first.agendaItem.agendaItemId);

    const second = submitSecretarySchedulingIntent(request, {
      now: '2026-05-01T08:10:00.000Z',
    });
    const all = listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    }).filter((item) => item.sourceIntentId === 'completed-idempotent');

    expect(second.agendaItem.agendaItemId).toBe(first.agendaItem.agendaItemId);
    expect(second.agendaItem.version).toBe(1);
    expect(second.selectedSlot).toEqual({
      start: '2026-05-04T09:00:00.000Z',
      end: '2026-05-04T10:00:00.000Z',
    });
    expect(second.agendaItem).toMatchObject({
      lifecycleState: 'completed',
      providerSyncState: 'synced',
      providerEventId: 'outlook-completed-event',
      providerSource: 'outlook',
    });
    expect(all).toHaveLength(1);
  });

  it('reflows a prior placement and supersedes the old agenda row when capacity changes', () => {
    const first = submitSecretarySchedulingIntent(intent({
      intentId: 'training-reflow',
      title: 'Tempo run',
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T11:00:00.000Z', 'original'),
      ],
    }));

    const second = submitSecretarySchedulingIntent(intent({
      intentId: 'training-reflow',
      title: 'Tempo run',
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T12:00:00.000Z', 'expanded'),
      ],
    }), {
      additionalBusyWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T10:00:00.000Z', 'new meeting'),
      ],
    });

    const all = listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    });

    expect(first.status).toBe('scheduled');
    expect(second.status).toBe('reflowed');
    expect(second.selectedSlot).toMatchObject({
      start: '2026-05-04T10:00:00.000Z',
      end: '2026-05-04T11:00:00.000Z',
    });
    expect(second.reasonCodes).toContain('reflowed_to_available_window');
    expect(second.feedback.shouldRefreshSource).toBe(true);
    expect(all.find((item) => item.agendaItemId === first.agendaItem.agendaItemId)?.lifecycleState).toBe('superseded');
    expect(all.find((item) => item.agendaItemId === second.agendaItem.agendaItemId)?.lifecycleState).toBe('reflowed');
  });

  it('creates a fresh active row when a same-slot reschedule follows a terminal cleanup row', () => {
    const first = submitSecretarySchedulingIntent(intent({
      intentId: 'cleanup-reschedule-same-slot',
      sourceEntityId: 'session-cleanup-reschedule',
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T11:00:00.000Z', 'same-slot'),
      ],
    }), {
      now: '2026-05-01T08:00:00.000Z',
    });

    markSecretaryAgendaProviderCleanupRequired({
      agendaItemId: first.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerSyncState: 'deleted',
      lifecycleState: 'unscheduled',
      reason: 'training_provider_ownership_record_failed',
      clearProviderMapping: true,
      now: '2026-05-01T08:05:00.000Z',
    });

    const second = submitSecretarySchedulingIntent(intent({
      intentId: 'cleanup-reschedule-same-slot',
      sourceEntityId: 'session-cleanup-reschedule',
      preferredWindows: [
        timeWindow('2026-05-04T09:00:00.000Z', '2026-05-04T11:00:00.000Z', 'same-slot'),
      ],
    }), {
      now: '2026-05-01T08:10:00.000Z',
    });
    const all = listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    }).filter((item) => item.sourceIntentId === 'cleanup-reschedule-same-slot');

    expect(first.status).toBe('scheduled');
    expect(second.status).toBe('scheduled');
    expect(second.agendaItem.agendaItemId).not.toBe(first.agendaItem.agendaItemId);
    expect(all).toHaveLength(2);
    expect(all.find((item) => item.agendaItemId === first.agendaItem.agendaItemId)).toMatchObject({
      lifecycleState: 'superseded',
      providerSyncState: 'deleted',
    });
    expect(all.find((item) => item.agendaItemId === second.agendaItem.agendaItemId)).toMatchObject({
      lifecycleState: 'scheduled',
      providerSyncState: 'not_synced',
      startAt: '2026-05-04T09:00:00.000Z',
      endAt: '2026-05-04T10:00:00.000Z',
    });
  });
});

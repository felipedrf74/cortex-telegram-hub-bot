import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(
  __dirname,
  '../../migrations/083_secretary_agenda_ledger.sql',
);

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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
  getSecretaryAgendaItemById,
  listSecretaryAgendaItems,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
  type SecretaryTimeWindow,
} from '../../src/services/secretary-scheduling-arbitrator';

const TENANT_ID = 'tenant-secretary-test';
const OWNER_USER_ID = 42;

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
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
});

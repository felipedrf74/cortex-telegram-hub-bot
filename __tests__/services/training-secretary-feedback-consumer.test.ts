import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql');
const MIGRATION_126 = path.resolve(__dirname, '../../migrations/126_secretary_reasoning_trail.sql');

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
  submitSecretarySchedulingIntent,
  type SecretarySourceSkillFeedback,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  _resetSecretaryFeedbackBusForTests,
} from '../../src/services/secretary-feedback-bus';
import {
  _resetTrainingSecretaryFeedbackConsumerForTests,
  listTrainingSecretaryFeedbackDecisions,
  recordTrainingSecretaryFeedback,
  registerTrainingSecretaryFeedbackConsumer,
} from '../../src/services/training-secretary-feedback-consumer';

const OWNER_USER_ID = 77;
const TENANT_ID = 'tenant-training-feedback';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_126, 'utf8'));
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
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
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

describe('Training Secretary feedback consumer', () => {
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

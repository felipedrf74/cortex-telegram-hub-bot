import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql');
const MIGRATION_098 = path.resolve(__dirname, '../../migrations/098_secretary_decision_explanation.sql');
const MIGRATION_126 = path.resolve(__dirname, '../../migrations/126_secretary_reasoning_trail.sql');
const MIGRATION_276 = path.resolve(__dirname, '../../migrations/276_training_secretary_feedback_durability.sql');

const USER_ID = 77;
const PLAN_ID = 501;
const PLAN_VERSION = 9;

let testDb: Database.Database;

const mockReadTrainingContextAll = vi.fn();
const mockGetLatestByType = vi.fn();
const mockGetCurrentCoachPhase = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetWeeklyAdherence = vi.fn();
const mockGetLatestCompletionForPlan = vi.fn();

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

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
    garmin: { tokenPath: '/tmp' },
  },
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

vi.mock('../../src/services/training-signals', () => ({
  readTrainingContextAll: (...args: unknown[]) => mockReadTrainingContextAll(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getLatestByType: (...args: unknown[]) => mockGetLatestByType(...args),
}));

vi.mock('../../src/services/coach-phase-memory', () => ({
  getCurrentCoachPhase: (...args: unknown[]) => mockGetCurrentCoachPhase(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
  getLatestCompletionForPlan: (...args: unknown[]) => mockGetLatestCompletionForPlan(...args),
}));

import {
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  _resetSecretaryFeedbackBusForTests,
} from '../../src/services/secretary-feedback-bus';
import {
  _resetTrainingSecretaryFeedbackConsumerForTests,
  consumeTrainingSecretaryFeedbackEvent,
} from '../../src/services/training-secretary-feedback-consumer';
import {
  processPendingEvents,
  type EventHandler,
} from '../../src/services/event-outbox';
import { readTrainingMeshContext } from '../../src/services/cross-agent-learning/training-mesh-context';
import { buildTrainingPlanCoordination } from '../../src/services/training-plan-coordination';

const feedbackProjectionHandler: EventHandler = {
  eventType: '*',
  handle(event, db) {
    consumeTrainingSecretaryFeedbackEvent(event, db);
  },
};

function trainingIntent(input: {
  sessionId: number;
  requestedDurationMinutes: number;
  windowMinutes: number;
}): SecretarySchedulingIntent {
  const start = new Date(`2026-05-20T${input.sessionId === 77 ? '08' : '10'}:00:00.000Z`);
  const end = new Date(start.getTime() + input.windowMinutes * 60_000);
  return {
    intentId: `training:${PLAN_ID}:${PLAN_VERSION}:${input.sessionId}`,
    sourceSkill: 'training',
    sourceAction: 'sync_training_session_calendar',
    sourceEntityId: input.sessionId,
    sourceEntityType: 'training_session',
    ownerUserId: USER_ID,
    tenantId: USER_ID,
    title: `Session ${input.sessionId}`,
    requestedDurationMinutes: input.requestedDurationMinutes,
    minimumDurationMinutes: input.requestedDurationMinutes,
    preferredWindows: [{
      start: start.toISOString(),
      end: end.toISOString(),
      hard: true,
    }],
    priority: 'high',
    flexibility: 'fixed',
  };
}

describe('Training Secretary feedback production consumption', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
    testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
    testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
    testDb.exec(fs.readFileSync(MIGRATION_126, 'utf8'));
    testDb.exec(fs.readFileSync(MIGRATION_276, 'utf8'));

    _resetSecretaryFeedbackBusForTests();
    _resetTrainingSecretaryFeedbackConsumerForTests();

    mockReadTrainingContextAll.mockReturnValue({
      signals: [],
      flags: {
        lowSleep: false,
        lowHrv: false,
        lowReadiness: false,
        highLegLoad: false,
        highShoulderLoad: false,
        raceThisWeek: false,
        lowAdherence: false,
        highAdherence: false,
        planDrift: false,
        fuelingGap: false,
        budgetConstraint: false,
        contentCommitment: false,
        otherSportRpeToday: 0,
      },
    });
    mockGetLatestByType.mockReturnValue(null);
    mockGetCurrentCoachPhase.mockReturnValue(null);
    mockGetActivePlans.mockReturnValue([{
      id: PLAN_ID,
      user_id: USER_ID,
      tenant_id: USER_ID,
      name: 'Current plan',
      sport: 'running',
      goal: 'consistency',
      duration_weeks: 4,
      periodization: 'linear',
      status: 'active',
      start_date: '2026-05-18',
      end_date: '2026-06-14',
      preferences_json: JSON.stringify({ schedulingTimezone: 'Europe/Lisbon' }),
      plan_version: PLAN_VERSION,
      created_at: '2026-05-17T00:00:00.000Z',
      updated_at: '2026-05-17T00:00:00.000Z',
    }]);
    mockGetWeeksForPlan.mockReturnValue([{
      id: 9001,
      plan_id: PLAN_ID,
      week_number: 1,
      focus: 'Base',
      intensity_pct: 70,
      volume_sessions: 5,
      notes: null,
      auto_adjusted: 0,
      adjustment_reason: null,
      created_at: '2026-05-17T00:00:00.000Z',
    }]);
    mockGetSessionsForWeek.mockReturnValue([]);
    mockGetWeeklyAdherence.mockReturnValue(null);
    mockGetLatestCompletionForPlan.mockReturnValue(null);
  });

  afterEach(() => {
    _resetSecretaryFeedbackBusForTests();
    _resetTrainingSecretaryFeedbackConsumerForTests();
    testDb.close();
    vi.clearAllMocks();
  });

  it('keeps an unresolved durable decision visible through mesh projection and plan coordination after a later scheduled session', async () => {
    const unresolved = submitSecretarySchedulingIntent(trainingIntent({
      sessionId: 77,
      requestedDurationMinutes: 120,
      windowMinutes: 60,
    }), { now: '2026-05-18T08:00:00.000Z' });
    const scheduled = submitSecretarySchedulingIntent(trainingIntent({
      sessionId: 88,
      requestedDurationMinutes: 60,
      windowMinutes: 60,
    }), { now: '2026-05-18T08:01:00.000Z' });
    expect(unresolved.status).toBe('unscheduled');
    expect(scheduled.status).toBe('scheduled');

    const drained = await processPendingEvents([feedbackProjectionHandler], {
      limit: 10,
      lockOwner: 'training-feedback-production-consumption',
      db: testDb,
    });
    expect(drained).toEqual({ processed: 2, failed: 0, deadLetter: 0 });

    const context = await readTrainingMeshContext({
      userId: USER_ID,
      tenantId: USER_ID,
      weekStart: '2026-05-18',
    });
    expect(context.secretaryFeedback).toMatchObject({
      planId: PLAN_ID,
      status: 'unscheduled',
      feedbackType: 'schedule_attention',
      shouldRefreshSource: true,
    });
    const serializedFeedback = JSON.stringify(context.secretaryFeedback);
    expect(serializedFeedback).not.toContain(`training:${PLAN_ID}:${PLAN_VERSION}:`);
    expect(serializedFeedback).not.toContain('agendaItemId');
    expect(serializedFeedback).not.toContain('2026-05-20T');

    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 2,
      training: context,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
      sharedDecisionContext: '',
    });
    expect(coordination.conservativeFirstWeek).toBe(true);
    expect(coordination.weeklySessionTarget).toBe(5);
    expect(coordination.maxHardSessionsPerWeek).toBe(1);
    expect(coordination.promptBlock).toContain('at least one plan session remains unscheduled');
  });
});

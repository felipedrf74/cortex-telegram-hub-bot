import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadTrainingContextAll = vi.fn();
const mockGetLatestByType = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetWeeklyAdherence = vi.fn();
const mockGetLatestCompletionForPlan = vi.fn();
const mockListCurrentTrainingSecretaryFeedbackDecisionsForPlan = vi.fn();

vi.mock('../../src/config', () => ({
  config: {
    app: {
      timezone: 'Europe/Lisbon',
    },
    garmin: {
      tokenPath: '/tmp',
    },
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

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
  getLatestCompletionForPlan: (...args: unknown[]) => mockGetLatestCompletionForPlan(...args),
}));

vi.mock('../../src/services/training-secretary-feedback-consumer', () => ({
  listCurrentTrainingSecretaryFeedbackDecisionsForPlan: (...args: unknown[]) =>
    mockListCurrentTrainingSecretaryFeedbackDecisionsForPlan(...args),
}));

import { readTrainingMeshContext } from '../../src/services/cross-agent-learning';

describe('readTrainingMeshContext', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mockReadTrainingContextAll.mockReset();
    mockGetLatestByType.mockReset();
    mockGetActivePlans.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockGetWeeklyAdherence.mockReset();
    mockGetLatestCompletionForPlan.mockReset();
    mockListCurrentTrainingSecretaryFeedbackDecisionsForPlan.mockReset();

    mockReadTrainingContextAll.mockReturnValue({
      signals: [{ id: 7001, signal_type: 'low_sleep' }],
      flags: {
        lowSleep: true,
        lowHrv: false,
        lowReadiness: false,
        highAdherence: true,
      },
    });
    mockGetLatestByType.mockReturnValue(null);
    mockGetActivePlans.mockReturnValue([
      {
        id: 1,
        user_id: 42,
        start_date: '2026-04-13',
      },
    ]);
    mockGetWeeksForPlan.mockReturnValue([
      {
        id: 11,
        week_number: 1,
        focus: 'Threshold',
      },
    ]);
    mockGetSessionsForWeek.mockReturnValue([
      {
        id: 101,
        week_id: 11,
        plan_id: 1,
        day_of_week: 'Wednesday',
        session_type: 'run',
        title: 'Track intervals',
        description: '6x800m at 5K pace',
        duration_minutes: 60,
        intensity_text: 'Hard',
      },
    ]);
    mockGetWeeklyAdherence.mockReturnValue({
      adherenceRate: 100,
    });
    mockGetLatestCompletionForPlan.mockReturnValue(null);
    mockListCurrentTrainingSecretaryFeedbackDecisionsForPlan.mockReturnValue([]);
  });

  it('pins plan-week and upcoming-session reads to the persisted plan timezone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:30:00.000Z'));
    mockGetActivePlans.mockReturnValueOnce([
      {
        id: 1,
        user_id: 42,
        tenant_id: 91,
        start_date: '2026-04-06',
        preferences_json: JSON.stringify({ schedulingTimezone: 'America/Los_Angeles' }),
      },
    ]);
    mockGetWeeksForPlan.mockReturnValueOnce([
      { id: 11, week_number: 1, focus: 'Base' },
      { id: 12, week_number: 2, focus: 'Build' },
    ]);
    mockGetSessionsForWeek.mockImplementationOnce((weekId: number) => weekId === 11
      ? [
          {
            id: 100,
            week_id: 11,
            plan_id: 1,
            day_of_week: 'Monday',
            session_type: 'run',
            title: 'LA Monday run',
            description: 'Already completed in the persisted-zone week',
            duration_minutes: 45,
            intensity_text: 'Easy',
          },
          {
            id: 101,
            week_id: 11,
            plan_id: 1,
            day_of_week: 'Sunday',
            session_type: 'run',
            title: 'LA Sunday run',
            description: 'Finish the persisted-zone week',
            duration_minutes: 45,
            intensity_text: 'Easy',
          },
        ]
      : [{
          id: 102,
          week_id: 12,
          plan_id: 1,
          day_of_week: 'Monday',
          session_type: 'run',
          title: 'Lisbon Monday run',
          description: 'Wrong config-zone week',
          duration_minutes: 45,
          intensity_text: 'Easy',
        }]);

    // Lisbon has crossed into Monday/week 2, while the immutable plan zone
    // is still Sunday/week 1. A later user/config change must not move it.
    const context = await readTrainingMeshContext({ userId: 42, tenantId: 91 });
    const prescription = context.derivedSignals.find(
      (signal) => signal.signalType === 'session_prescription',
    );

    expect(mockGetActivePlans).toHaveBeenCalledWith(42, 91);
    expect(mockGetSessionsForWeek).toHaveBeenCalledWith(11);
    expect(context.weekStart).toBe('2026-04-06');
    expect(context.weekEnd).toBe('2026-04-12');
    expect(context.activeWeek?.week_number).toBe(1);
    expect(prescription?.payload).toMatchObject({
      date: '2026-04-12',
      title: 'LA Sunday run',
    });
  });

  it('projects latest completion feedback as safe state/presence/reason-code facts only', async () => {
    mockGetLatestCompletionForPlan.mockReturnValueOnce({
      id: 7002,
      session_id: 101,
      plan_id: 1,
      completion_state: 'skipped',
      readiness_level: 2,
      discomfort_flag: 1,
      missed_reason: 'schedule_conflict',
      pain_score: 9.875310246,
      pain_location: 'PRIVATE_F18_MESH_PAIN_LOCATION',
      discomfort_details: 'PRIVATE_F18_MESH_DISCOMFORT_DETAILS',
      notes: 'PRIVATE_F18_MESH_NOTES',
    });

    const context = await readTrainingMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-13' });
    const completion = context.derivedSignals.find(
      (signal) => String(signal.signalType) === 'training_completion_summary',
    );

    expect(mockGetLatestCompletionForPlan).toHaveBeenCalledWith(1);
    expect(completion?.payload).toEqual({
      completionState: 'skipped',
      hasDiscomfort: true,
      hasReadiness: true,
      skippedReasonCode: 'schedule_conflict',
    });
    const serialized = JSON.stringify(completion);
    expect(serialized).not.toContain('9.875310246');
    expect(serialized).not.toContain('PRIVATE_F18_MESH_PAIN_LOCATION');
    expect(serialized).not.toContain('PRIVATE_F18_MESH_DISCOMFORT_DETAILS');
    expect(serialized).not.toContain('PRIVATE_F18_MESH_NOTES');
  });

  it('projects the active plan Secretary aggregate without agenda identifiers or raw times', async () => {
    mockListCurrentTrainingSecretaryFeedbackDecisionsForPlan.mockReturnValueOnce([{
      id: 901,
      userId: 42,
      tenantId: '91',
      agendaItemId: 'PRIVATE_AGENDA_ITEM_ID',
      sourceIntentId: 'training:1:1:101',
      agendaVersion: 4,
      feedbackType: 'compressed_session',
      status: 'compressed',
      reasonCodes: ['compressed_to_fit_capacity', 'duration_reduced'],
      scheduledStart: '2026-04-15T08:00:00.000Z',
      scheduledEnd: '2026-04-15T08:30:00.000Z',
      shouldRefreshSource: true,
      downstreamImplications: ['PRIVATE_RAW_IMPLICATION'],
      hints: ['recovery_debt', 'adapt_workload_to_capacity'],
      createdAt: '2026-04-13T09:00:00.000Z',
      updatedAt: '2026-04-13T09:01:00.000Z',
    }]);

    const context = await readTrainingMeshContext({
      userId: 42,
      tenantId: 91,
      weekStart: '2026-04-13',
    });

    expect(mockListCurrentTrainingSecretaryFeedbackDecisionsForPlan).toHaveBeenCalledWith({
      userId: 42,
      tenantId: 91,
      planId: 1,
      planVersion: 1,
    });
    expect(context.secretaryFeedback).toEqual({
      planId: 1,
      feedbackType: 'compressed_session',
      status: 'compressed',
      reasonCodes: ['compressed_to_fit_capacity', 'duration_reduced'],
      shouldRefreshSource: true,
      hints: ['recovery_debt', 'adapt_workload_to_capacity'],
      scheduledDurationMinutes: 30,
    });
    const serialized = JSON.stringify(context.secretaryFeedback);
    expect(serialized).not.toContain('PRIVATE_AGENDA_ITEM_ID');
    expect(serialized).not.toContain('PRIVATE_RAW_IMPLICATION');
    expect(serialized).not.toContain('2026-04-15T08:00:00.000Z');
  });

  it('publishes session immovability and fueling requirements for a hard upcoming session', async () => {
    const context = await readTrainingMeshContext({ userId: 42, weekStart: '2026-04-13' });

    const immovability = context.derivedSignals.find((signal) => signal.signalType === 'session_immovability');
    const fueling = context.derivedSignals.find((signal) => signal.signalType === 'fueling_requirements');
    const story = context.derivedSignals.find((signal) => signal.signalType === 'content_capture_opportunity');

    expect(immovability?.payload).toMatchObject({
      date: '2026-04-15',
      title: 'Track intervals',
      level: 'high',
      load: 'hard',
    });
    expect(fueling?.payload).toMatchObject({
      date: '2026-04-15',
      title: 'Track intervals',
      supportLevel: 'elevated',
      carbFocus: 'high',
      hydrationFocus: 'elevated',
      proteinRecovery: true,
    });
    expect(story?.payload).toMatchObject({
      date: '2026-04-15',
      title: 'Track intervals',
      angle: 'coach_adjustment',
      recoveryState: 'strained',
    });
  });

  it('does not publish those downstream constraints for a light session', async () => {
    mockGetSessionsForWeek.mockReturnValueOnce([
      {
        id: 102,
        week_id: 11,
        plan_id: 1,
        day_of_week: 'Wednesday',
        session_type: 'mobility',
        title: 'Easy mobility reset',
        description: '20 minutes easy',
        duration_minutes: 20,
        intensity_text: 'Easy',
      },
    ]);

    const context = await readTrainingMeshContext({ userId: 42, weekStart: '2026-04-13' });

    expect(context.derivedSignals.some((signal) => signal.signalType === 'session_immovability')).toBe(false);
    expect(context.derivedSignals.some((signal) => signal.signalType === 'fueling_requirements')).toBe(false);
    expect(context.derivedSignals.some((signal) => signal.signalType === 'content_capture_opportunity')).toBe(false);
  });

  it('publishes steady support and a block-focus capture for a moderate stable session', async () => {
    mockReadTrainingContextAll.mockReturnValueOnce({
      signals: [],
      flags: {
        lowSleep: false,
        lowHrv: false,
        lowReadiness: false,
        highAdherence: false,
      },
    });
    mockGetWeeklyAdherence.mockReturnValueOnce({ adherenceRate: 70 });
    mockGetSessionsForWeek.mockReturnValueOnce([
      {
        id: 103,
        week_id: 11,
        plan_id: 1,
        day_of_week: 'Thursday',
        session_type: 'cycling',
        title: 'Steady endurance ride',
        description: 'Aerobic progression',
        duration_minutes: 75,
        intensity_text: 'Moderate',
      },
    ]);

    const context = await readTrainingMeshContext({ userId: 42, weekStart: '2026-04-13' });
    const recovery = context.derivedSignals.find((signal) => signal.signalType === 'recovery_state');
    const immovability = context.derivedSignals.find((signal) => signal.signalType === 'session_immovability');
    const fueling = context.derivedSignals.find((signal) => signal.signalType === 'fueling_requirements');
    const story = context.derivedSignals.find((signal) => signal.signalType === 'content_capture_opportunity');

    expect(recovery?.payload.state).toBe('stable');
    expect(immovability?.payload).toMatchObject({ level: 'medium', load: 'moderate' });
    expect(fueling?.payload).toMatchObject({
      supportLevel: 'steady',
      carbFocus: 'moderate',
      hydrationFocus: 'steady',
    });
    expect(story?.payload).toMatchObject({
      angle: 'block_focus',
      recoveryState: 'stable',
      focus: 'Threshold',
    });
  });
});

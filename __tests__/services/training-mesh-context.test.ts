import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadTrainingContextAll = vi.fn();
const mockGetLatestByType = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetWeeklyAdherence = vi.fn();

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
}));

import { readTrainingMeshContext } from '../../src/services/cross-agent-learning';

describe('readTrainingMeshContext', () => {
  beforeEach(() => {
    mockReadTrainingContextAll.mockReset();
    mockGetLatestByType.mockReset();
    mockGetActivePlans.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockGetWeeklyAdherence.mockReset();

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

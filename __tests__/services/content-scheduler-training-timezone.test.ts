import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCalculateReadiness = vi.fn();
const mockGetFocusBlockRecommendation = vi.fn();
const mockReadTrainingContextAll = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetEventsWithDiagnostics = vi.fn();
const mockHasWritableCalendarForUser = vi.fn();

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
  },
}));

vi.mock('../../src/services/user-service', () => ({
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database'
  )),
  getDb: vi.fn(),
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

vi.mock('../../src/services/readiness-scorer', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/readiness-scorer')>(
    '../../src/services/readiness-scorer'
  )),
  calculateReadiness: (...args: unknown[]) => mockCalculateReadiness(...args),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: (...args: unknown[]) => mockGetFocusBlockRecommendation(...args),
}));

vi.mock('../../src/services/training-signals', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/training-signals')>(
    '../../src/services/training-signals'
  )),
  readTrainingContextAll: (...args: unknown[]) => mockReadTrainingContextAll(...args),
}));

vi.mock('../../src/services/training-plans', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/training-plans')>(
    '../../src/services/training-plans'
  )),
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
}));

vi.mock('../../src/services/unified-calendar', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/unified-calendar')>(
    '../../src/services/unified-calendar'
  )),
  getEventsWithDiagnostics: (...args: unknown[]) => mockGetEventsWithDiagnostics(...args),
  hasWritableCalendarForUser: (...args: unknown[]) => mockHasWritableCalendarForUser(...args),
}));

vi.mock('../../src/services/content-topic-workspace-compat', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/content-topic-workspace-compat')>(
    '../../src/services/content-topic-workspace-compat'
  )),
  countUpcomingContentTopicCompatibility: vi.fn(),
  createContentTopicCompatibility: vi.fn(),
  deleteContentTopicCompatibility: vi.fn(),
  findContentTopicCompatibilityByClientRequestId: vi.fn(),
  getContentTopicCompatibility: vi.fn(),
  listContentTopicCompatibility: vi.fn(),
  updateContentTopicCompatibility: vi.fn(),
}));

import { getFilmingRecommendation } from '../../src/services/content-scheduler';

describe('content scheduler training timezone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCalculateReadiness.mockResolvedValue({ score: 75 });
    mockGetFocusBlockRecommendation.mockResolvedValue(null);
    mockReadTrainingContextAll.mockReturnValue({
      signals: [],
      flags: {
        lowSleep: false,
        lowHrv: false,
        lowReadiness: false,
        highLegLoad: false,
      },
    });
    mockGetActivePlans.mockReturnValue([
      {
        id: 1,
        user_id: 42,
        tenant_id: 42,
        start_date: '2026-04-06',
        duration_weeks: 4,
        preferences_json: JSON.stringify({ schedulingTimezone: 'America/Los_Angeles' }),
      },
    ]);
    mockGetWeeksForPlan.mockReturnValue([
      { id: 11, week_number: 1 },
      { id: 12, week_number: 2 },
    ]);
    mockGetSessionsForWeek.mockImplementation((weekId: number) => weekId === 11
      ? [{
          id: 101,
          day_of_week: 'Sunday',
          session_type: 'run',
          title: 'Long run',
          intensity_text: 'Hard',
          description: null,
        }]
      : []);
    mockGetEventsWithDiagnostics.mockResolvedValue(readyCalendarResult([]));
    mockHasWritableCalendarForUser.mockReturnValue(false);
  });

  it('reads the plan week in its persisted zone and keeps the plan lookup tenant-scoped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T00:30:00.000Z'));

    // Lisbon is Monday/week 2, but the immutable Los Angeles plan clock is
    // still Sunday/week 1 at the same instant.
    const recommendation = await getFilmingRecommendation(42, [], 42);

    expect(recommendation).not.toBeNull();
    expect(mockGetActivePlans).toHaveBeenCalledWith(42, 42);
    expect(mockGetSessionsForWeek).toHaveBeenCalledWith(11);
  });

  it('keeps a filming recommendation provisional when calendar state is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T10:30:00.000Z'));
    mockGetEventsWithDiagnostics.mockRejectedValue(new Error('calendar unavailable'));

    const recommendation = await getFilmingRecommendation(42, [], 42);

    expect(recommendation).not.toBeNull();
    expect(recommendation?.calendarLoad).toBe('unknown');
    expect(recommendation?.reason).toContain('calendar could not be confirmed');
    expect(recommendation?.reasons.join(' ')).not.toContain('calendar is clear');
    expect(recommendation?.confidence).not.toBe('high');
    expect(mockGetFocusBlockRecommendation).not.toHaveBeenCalled();
  });

  it('keeps a filming recommendation provisional when one calendar provider fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T10:30:00.000Z'));
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [],
      status: 'degraded',
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      warnings: ['Google Calendar is unavailable right now.'],
      sources: {
        configured: ['google', 'outlook'],
        fulfilled: ['outlook'],
        failed: ['google'],
      },
    });

    const recommendation = await getFilmingRecommendation(42, [], 42);

    expect(recommendation?.calendarLoad).toBe('unknown');
    expect(recommendation?.reason).toContain('calendar could not be confirmed');
    expect(mockGetFocusBlockRecommendation).not.toHaveBeenCalled();
  });
});

function readyCalendarResult(events: unknown[]) {
  return {
    events,
    status: 'ready',
    warningCodes: [],
    warnings: [],
    sources: {
      configured: ['outlook'],
      fulfilled: ['outlook'],
      failed: [],
    },
  };
}

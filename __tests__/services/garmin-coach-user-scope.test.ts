// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockNow = {
  toFormat: vi.fn(() => 'Friday, April 17 2026'),
  plus: vi.fn(() => ({
    startOf: vi.fn(() => ({ toISO: vi.fn(() => '2026-04-18T00:00:00.000Z') })),
    endOf: vi.fn(() => ({ toISO: vi.fn(() => '2026-04-18T23:59:59.999Z') })),
  })),
  startOf: vi.fn(() => ({ toISO: vi.fn(() => '2026-04-17T00:00:00.000Z') })),
  endOf: vi.fn(() => ({ toISO: vi.fn(() => '2026-04-17T23:59:59.999Z') })),
};

const mockFetchDailyCoachData = vi.fn();
const mockIsGarminConfigured = vi.fn();
const mockGetEvents = vi.fn();
const mockHasConnectedCalendarForUser = vi.fn();
const mockTryComplete = vi.fn();
const mockGetLastCoachState = vi.fn();
const mockTrackedCreate = vi.fn();
const mockIsOwnerUserRef = vi.fn();
const mockGetDb = vi.fn();

vi.mock('../../src/config', () => ({
  config: { anthropic: { apiKey: 'test-key' } },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/utils/date-parser', () => ({
  now: () => mockNow,
  startOfDay: vi.fn(),
  endOfDay: vi.fn(),
}));

vi.mock('../../src/utils/telegram-formatter', () => ({
  escapeHtml: (value: string) => value,
  splitMessage: (value: string) => [value],
}));

vi.mock('../../src/services/garmin', () => ({
  fetchDailyCoachData: (...args: unknown[]) => mockFetchDailyCoachData(...args),
  isGarminConfigured: (...args: unknown[]) => mockIsGarminConfigured(...args),
  summarizeActivityDetails: vi.fn(() => 'details'),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  hasConnectedCalendarForUser: (...args: unknown[]) => mockHasConnectedCalendarForUser(...args),
  isAnyCalendarConfigured: vi.fn(() => false),
  updateEvent: vi.fn(),
}));

vi.mock('../../src/services/training-plans', () => ({
  syncSessionWithCoachRecommendation: vi.fn(),
}));

vi.mock('../../src/services/anthropic', () => ({
  getDomainSystemPrompt: vi.fn(() => 'system'),
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: (...args: unknown[]) => mockTrackedCreate(...args),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: (...args: unknown[]) => mockTryComplete(...args),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  getLastCoachState: (...args: unknown[]) => mockGetLastCoachState(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  isOwnerUserRef: (...args: unknown[]) => mockIsOwnerUserRef(...args),
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import { generateCoachBriefing, resolveCoachAnalysisMeteringScope } from '../../src/services/garmin-coach';

describe('garmin-coach user scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFetchDailyCoachData.mockResolvedValue({
      sleepHours: 7,
      sleepQuality: 'Good',
      restingHeartRate: 50,
      hrv: 70,
      bodyBatterySummary: { current: 80, charged: 95, lowest: 30 },
      stressAverage: 25,
      readiness: 85,
      bodyBattery: null,
      activities: [],
      errors: [],
    });
    mockHasConnectedCalendarForUser.mockReturnValue(true);
    mockGetEvents.mockResolvedValue([]);
    mockIsGarminConfigured.mockReturnValue(true);
    mockIsOwnerUserRef.mockReturnValue(false);
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => [
          { data_type: 'sleep', data_json: JSON.stringify({ totalMinutes: 450, deepMinutes: 90, remMinutes: 100 }) },
          { data_type: 'resting_hr', data_json: JSON.stringify({ bpm: 48 }) },
          { data_type: 'hrv', data_json: JSON.stringify({ ms: 65 }) },
          { data_type: 'body_battery', data_json: JSON.stringify({ current: 72, highest: 95, lowest: 28, charged: 60, drained: 50 }) },
          { data_type: 'stress', data_json: JSON.stringify({ average: 24 }) },
          { data_type: 'readiness', data_json: JSON.stringify({ score: 83 }) },
          { data_type: 'workouts', data_json: JSON.stringify([]) },
          { data_type: 'steps', data_json: JSON.stringify({ count: 8000 }) },
        ]),
      })),
    });
    mockTryComplete.mockResolvedValue({
      text: '🏋️ <b>NEXUS HUB — DAILY COACH BRIEFING</b>\n<!-- COACH_RECS_START -->[]<!-- COACH_RECS_END -->',
      provider: 'gemini',
    });
    mockTrackedCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'fallback' }],
      usage: {},
    });
    mockGetLastCoachState.mockReturnValue(null);
  });

  it('does not use global Garmin data for a non-owner scoped user', async () => {
    await generateCoachBriefing(42);
    expect(mockIsOwnerUserRef).toHaveBeenCalledWith(42);
    expect(mockFetchDailyCoachData).not.toHaveBeenCalled();
  });

  it('uses scoped calendar reads when a userId is provided', async () => {
    await generateCoachBriefing(42);
    expect(mockHasConnectedCalendarForUser).toHaveBeenCalledWith(42);
    expect(mockGetEvents).toHaveBeenNthCalledWith(
      1,
      '2026-04-17T00:00:00.000Z',
      '2026-04-17T23:59:59.999Z',
      42,
    );
    expect(mockGetEvents).toHaveBeenNthCalledWith(
      2,
      '2026-04-18T00:00:00.000Z',
      '2026-04-18T23:59:59.999Z',
      42,
    );
  });

  it('attributes coach explanation LLM cost to the scoped user and tenant', async () => {
    await generateCoachBriefing(42);

    expect(resolveCoachAnalysisMeteringScope(42)).toEqual({
      actor: 'user',
      userId: 42,
      tenantId: 42,
    });
    expect(mockTryComplete).toHaveBeenCalledTimes(1);
    const [, , category, fallback, options] = mockTryComplete.mock.calls[0];
    expect(category).toBe('coach_analysis');
    expect(options).toMatchObject({ maxTokens: 2500, userId: 42, tenantId: 42 });

    await fallback();
    expect(mockTrackedCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'coach_analysis',
      { userId: 42, tenantId: 42 },
    );
  });

  it('preserves active tenant scope for coach explanation metering', async () => {
    await generateCoachBriefing(77, { tenantId: 77, meteringUserId: 42 });

    expect(resolveCoachAnalysisMeteringScope(42, 77)).toEqual({
      actor: 'user',
      userId: 42,
      tenantId: 77,
    });
    const [, , category, fallback, options] = mockTryComplete.mock.calls[0];
    expect(category).toBe('coach_analysis');
    expect(options).toMatchObject({ maxTokens: 2500, userId: 42, tenantId: 77 });

    await fallback();
    expect(mockTrackedCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'coach_analysis',
      { userId: 42, tenantId: 77 },
    );
  });

  it('classifies owner-bootstrap coach analysis as a system metering actor', () => {
    expect(resolveCoachAnalysisMeteringScope()).toEqual({
      actor: 'system',
      userId: 0,
      tenantId: 0,
    });
    expect(resolveCoachAnalysisMeteringScope(null)).toEqual({
      actor: 'system',
      userId: 0,
      tenantId: 0,
    });
    expect(resolveCoachAnalysisMeteringScope(0)).toEqual({
      actor: 'system',
      userId: 0,
      tenantId: 0,
    });
  });

  it('still allows Garmin for owner-scoped users', async () => {
    mockIsOwnerUserRef.mockReturnValue(true);
    await generateCoachBriefing(7);
    expect(mockFetchDailyCoachData).toHaveBeenCalledWith({ silent: undefined });
  });

  it('passes silent Garmin mode through for scheduled coach report generation', async () => {
    mockIsOwnerUserRef.mockReturnValue(true);
    await generateCoachBriefing(7, { garminSilent: true });
    expect(mockFetchDailyCoachData).toHaveBeenCalledWith({ silent: true });
  });
});

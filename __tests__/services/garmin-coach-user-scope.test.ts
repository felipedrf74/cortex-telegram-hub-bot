// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
const mockWithAiBudgetReservation = vi.hoisted(() => vi.fn());

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

vi.mock('../../src/services/cost-guardrail', () => ({
  withAiBudgetReservation: (...args: unknown[]) => mockWithAiBudgetReservation(...args),
}));

import {
  COACH_ANALYSIS_SYSTEM_METERING_TENANT_ID,
  COACH_ANALYSIS_SYSTEM_METERING_USER_ID,
  COACH_SYSTEM_PROMPT_MAX_CHARS,
  buildCoachAnalysisSystemPrompt,
  generateCoachBriefing,
  resolveCoachAnalysisMeteringScope,
} from '../../src/services/garmin-coach';

describe('garmin-coach user scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithAiBudgetReservation.mockImplementation(
      async (_request: unknown, fn: () => Promise<unknown>) => fn(),
    );

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
    await generateCoachBriefing(42, { tenantId: 42 });
    expect(mockIsOwnerUserRef).toHaveBeenCalledWith(42, {
      allowPersistedTier: false,
      requireConfiguredIdentity: true,
    });
    expect(mockFetchDailyCoachData).not.toHaveBeenCalled();
  });

  it('uses scoped calendar reads when a userId is provided', async () => {
    await generateCoachBriefing(42, { tenantId: 42 });
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

  it('lets same-user chat finish while Coach is still collecting calendar data', async () => {
    let releaseCalendar!: () => void;
    const calendarPending = new Promise<unknown[]>((resolve) => {
      releaseCalendar = () => resolve([]);
    });
    mockGetEvents.mockImplementation(() => calendarPending);

    const coach = generateCoachBriefing(42, {
      tenantId: 42,
      meteringUserId: 42,
      budgetRequestSource: 'automation',
      budgetJobName: 'garmin_coach',
    });
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2));
    expect(mockWithAiBudgetReservation).not.toHaveBeenCalled();

    await expect(mockWithAiBudgetReservation(
      { userId: 42, requestSource: 'interactive', baseCategory: 'chat_secretary' },
      async () => 'chat-complete',
    )).resolves.toBe('chat-complete');

    releaseCalendar();
    await expect(coach).resolves.toMatchObject({ message: expect.stringContaining('DAILY COACH BRIEFING') });
    expect(mockWithAiBudgetReservation).toHaveBeenCalledTimes(2);
  });

  it('attributes coach explanation LLM cost to the scoped user and tenant', async () => {
    await generateCoachBriefing(42, { tenantId: 42 });

    expect(resolveCoachAnalysisMeteringScope(42)).toEqual({
      actor: 'user',
      userId: 42,
      tenantId: 42,
    });
    expect(mockTryComplete).toHaveBeenCalledTimes(1);
    const [, , category, fallback, options] = mockTryComplete.mock.calls[0];
    expect(category).toBe('coach_analysis');
    expect(options).toMatchObject({ maxTokens: 1400, userId: 42, tenantId: 42 });

    await fallback();
    const primarySystemPrompt = mockTryComplete.mock.calls[0][0];
    expect(mockTrackedCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ system: primarySystemPrompt }),
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
    expect(options).toMatchObject({ maxTokens: 1400, userId: 42, tenantId: 77 });

    await fallback();
    expect(mockTrackedCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'coach_analysis',
      { userId: 42, tenantId: 77 },
    );
  });

  it('requires tenant scope for coach briefing generation', async () => {
    await expect(generateCoachBriefing(42)).rejects.toThrow(/TENANT_SCOPE_REQUIRED|requires a validated tenantId/);
  });

  it('keeps the complete Coach instruction contract under the prompt cap', () => {
    const prompt = buildCoachAnalysisSystemPrompt('persona '.repeat(4_000));
    expect(prompt.length).toBeLessThanOrEqual(COACH_SYSTEM_PROMPT_MAX_CHARS);
    expect(prompt).toContain('DATA INTERPRETATION:');
    expect(prompt).toContain('<!-- COACH_RECS_START -->');
    expect(prompt).toContain('<!-- COACH_RECS_END -->');
    expect(prompt).toContain('Respond ONLY with the structured coach briefing');
  });

  it('classifies owner-bootstrap coach analysis as a system metering actor', () => {
    const systemScope = {
      actor: 'system',
      userId: COACH_ANALYSIS_SYSTEM_METERING_USER_ID,
      tenantId: COACH_ANALYSIS_SYSTEM_METERING_TENANT_ID,
    };

    expect(resolveCoachAnalysisMeteringScope()).toEqual({
      ...systemScope,
    });
    expect(resolveCoachAnalysisMeteringScope(null)).toEqual({
      ...systemScope,
    });
    expect(resolveCoachAnalysisMeteringScope(0)).toEqual({
      ...systemScope,
    });
    expect(resolveCoachAnalysisMeteringScope(-1)).toEqual({
      ...systemScope,
    });
    expect(resolveCoachAnalysisMeteringScope(1.5)).toEqual({
      ...systemScope,
    });
  });

  it('still allows Garmin for owner-scoped users', async () => {
    mockIsOwnerUserRef.mockReturnValue(true);
    await generateCoachBriefing(7, { tenantId: 7 });
    expect(mockIsOwnerUserRef).toHaveBeenCalledWith(7, {
      allowPersistedTier: false,
      requireConfiguredIdentity: true,
    });
    expect(mockFetchDailyCoachData).toHaveBeenCalledWith({ silent: undefined });
  });

  it('passes silent Garmin mode through for scheduled coach report generation', async () => {
    mockIsOwnerUserRef.mockReturnValue(true);
    await generateCoachBriefing(7, { tenantId: 7, garminSilent: true });
    expect(mockFetchDailyCoachData).toHaveBeenCalledWith({ silent: true });
  });

  it('sends a compact coach input without missing-data boilerplate or full schedule dumps', async () => {
    mockIsOwnerUserRef.mockReturnValue(true);
    mockFetchDailyCoachData.mockResolvedValue({
      date: '2026-07-09',
      summary: { totalSteps: 4200, bodyBatteryHighestValue: null, unusedVerboseBlob: 'x'.repeat(1000) },
      sleepSummary: null,
      stressSummary: null,
      heartRateSummary: null,
      hrvSummary: null,
      trainingReadiness: null,
      trainingStatus: null,
      bodyBatterySummary: { current: null, highest: null, lowest: null, charged: null, drained: null },
      activities: [],
      activityDetails: new Map(),
      tomorrowWorkouts: [],
      tomorrowTrainingPlan: null,
      weeklyStress: null,
      weeklyIntensityMinutes: null,
      errors: ['sleep unavailable', 'hrv unavailable'],
    });
    mockGetEvents
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'train-1', source: 'outlook', summary: 'Lower Body Strength A', start: '2026-07-10T11:00:00+01:00', end: '2026-07-10T11:42:00+01:00' },
        { id: 'ctx-1', source: 'outlook', summary: 'Wake up', start: '2026-07-10T05:00:00+01:00', end: '2026-07-10T05:05:00+01:00' },
        { id: 'ctx-2', source: 'outlook', summary: 'Meditation', start: '2026-07-10T05:30:00+01:00', end: '2026-07-10T05:45:00+01:00' },
        { id: 'ctx-3', source: 'outlook', summary: 'SMS - Focus Work', start: '2026-07-10T08:00:00+01:00', end: '2026-07-10T09:00:00+01:00' },
        { id: 'ctx-4', source: 'outlook', summary: 'SMS - SHERPAX DevOps Daily', start: '2026-07-10T09:15:00+01:00', end: '2026-07-10T09:30:00+01:00' },
        { id: 'ctx-5', source: 'outlook', summary: 'EC - Focus Work', start: '2026-07-10T14:00:00+01:00', end: '2026-07-10T15:00:00+01:00' },
        { id: 'ctx-6', source: 'outlook', summary: 'Construindo Familia', start: '2026-07-10T15:30:00+01:00', end: '2026-07-10T16:30:00+01:00' },
        { id: 'ctx-7', source: 'outlook', summary: 'Content: Weekly retro', start: '2026-07-10T18:30:00+01:00', end: '2026-07-10T19:00:00+01:00' },
        { id: 'ctx-8', source: 'outlook', summary: 'Late admin block', start: '2026-07-10T20:00:00+01:00', end: '2026-07-10T20:30:00+01:00' },
      ]);

    await generateCoachBriefing(7, { tenantId: 7 });

    const [, userPrompt] = mockTryComplete.mock.calls[0];
    expect(userPrompt).toContain('## COMPACT COACH INPUT');
    expect(userPrompt).not.toContain('## RAW GARMIN DATA');
    expect(userPrompt).toContain('"recovery":{"available":false');
    expect(userPrompt).toContain('"note":"Recovery data unavailable today"');
    expect(userPrompt).toContain('"trainingEvents":[{"id":"train-1"');
    expect(userPrompt).toContain('"displayTime":"11:00-11:42 (42 min)"');
    expect(userPrompt).toContain('"scheduleContext":{"count":8');
    expect(userPrompt).toContain('"omittedCount":2');
    expect(userPrompt).toContain('Use displayTime for visible event times');
    expect(userPrompt).not.toContain('Sleep: No data');
    expect(userPrompt).not.toContain('Late admin block');
    expect(userPrompt).not.toContain('unusedVerboseBlob');
    expect(userPrompt.length).toBeLessThan(5000);
  });

  it('preserves Apple Health fallback recovery signals in the compact coach input', async () => {
    await generateCoachBriefing(42, { tenantId: 42 });

    const [, userPrompt] = mockTryComplete.mock.calls[0];
    expect(userPrompt).toContain('"recovery":{"available":true');
    expect(userPrompt).toContain('"sleep"');
    expect(userPrompt).toContain('"restingHeartRate":48');
    expect(userPrompt).toContain('"dailySummary":{"steps":8000,"source":"apple_health"}');
  });

  it('strips malformed COACH_RECS artifacts from the user-visible message', async () => {
    mockTryComplete.mockResolvedValueOnce({
      text: [
        '🏋️ NEXUS HUB — DAILY COACH BRIEFING',
        'Coach-visible summary.',
        '<!-- COACH_RECS_START -->',
        '[',
        '  { "eventId": "evt-1", "source": "outlook", "action": "KEEP" }',
      ].join('\n'),
      provider: 'gemini',
    });

    const result = await generateCoachBriefing(42, { tenantId: 42 });

    expect(result.message).toContain('Coach-visible summary.');
    expect(result.message).not.toMatch(/COACH_RECS_START|eventId|source|action/i);
    expect(result.recommendations).toEqual([]);
  });

  it('strips an orphaned recommendation tail and normalizes visible ISO timestamps', async () => {
    mockTryComplete.mockResolvedValueOnce({
      text: [
        '🏋️ NEXUS HUB — DAILY COACH BRIEFING',
        '⏰ 2026-07-10T11:00:00.0000000+01:00 – 2026-07-10T11:42:00.0000000+01:00',
        '[',
        '  { "eventId": "evt-1", "source": "outlook", "action": "KEEP" }',
        ']',
        '<!-- COACH_RECS_END -->',
      ].join('\n'),
      provider: 'gemini',
    });

    const result = await generateCoachBriefing(42, { tenantId: 42 });

    expect(result.message).toContain('⏰ 11:00-11:42 (42 min)');
    expect(result.message).not.toMatch(/2026-07-10T|COACH_RECS_END|eventId|source|action/i);
    expect(result.recommendations).toEqual([]);
  });

  // ── Local-LLM pilot: GARMIN_COACH_CAPTURE_PROMPT payload capture ──

  it('captures the prompt payload to .local/coach-payloads when GARMIN_COACH_CAPTURE_PROMPT=true', async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-capture-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(scratchDir);
    vi.stubEnv('GARMIN_COACH_CAPTURE_PROMPT', 'true');
    try {
      const result = await generateCoachBriefing(42, { tenantId: 42 });

      const captureDir = path.join(scratchDir, '.local', 'coach-payloads');
      const files = fs.readdirSync(captureDir).filter((f) => /^coach-\d+-u42\.json$/.test(f));
      expect(files).toHaveLength(1);
      const payload = JSON.parse(fs.readFileSync(path.join(captureDir, files[0]), 'utf8'));
      expect(payload).toMatchObject({ userId: 42, maxTokens: 1400 });
      expect(typeof payload.capturedAt).toBe('string');
      expect(typeof payload.systemPrompt).toBe('string');
      expect(payload.systemPrompt.length).toBeGreaterThan(0);
      expect(payload.userPrompt).toContain('DAILY COACHING ANALYSIS');

      // Capture is observe-only: the captured prompts are exactly what the
      // LLM call receives, and the briefing itself is unchanged.
      const [calledSystem, calledUser] = mockTryComplete.mock.calls[0];
      expect(payload.systemPrompt).toBe(calledSystem);
      expect(payload.userPrompt).toBe(calledUser);
      expect(result.message).toContain('NEXUS HUB');
    } finally {
      vi.unstubAllEnvs();
      cwdSpy.mockRestore();
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('never captures when the env flag is off (default)', async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-capture-off-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(scratchDir);
    try {
      await generateCoachBriefing(42, { tenantId: 42 });
      expect(fs.existsSync(path.join(scratchDir, '.local', 'coach-payloads'))).toBe(false);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('capture failures never break the briefing', async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-capture-fail-'));
    // Point cwd at a path UNDER a regular file so mkdirSync throws ENOTDIR.
    const blockerFile = path.join(scratchDir, 'not-a-dir');
    fs.writeFileSync(blockerFile, 'x');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(path.join(blockerFile, 'nested'));
    vi.stubEnv('GARMIN_COACH_CAPTURE_PROMPT', 'true');
    try {
      const result = await generateCoachBriefing(42, { tenantId: 42 });
      expect(result.message).toContain('NEXUS HUB');
      expect(mockTryComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      cwdSpy.mockRestore();
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

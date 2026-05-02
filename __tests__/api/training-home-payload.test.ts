// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/services/coach-kernel/types';

const mockGetStoredPlanCoveringDate = vi.fn();
const mockAdjustForFatigue = vi.fn();
const mockLoggerDebug = vi.fn();

vi.mock('../../src/services/coach-plan-registry', () => ({
  getStoredPlanCoveringDate: (...args: unknown[]) => mockGetStoredPlanCoveringDate(...args),
}));

vi.mock('../../src/services/coach-kernel/planner-engine', () => ({
  adjustForFatigue: (...args: unknown[]) => mockAdjustForFatigue(...args),
}));

vi.mock('../../src/services/integration-status', () => ({
  isGarminActivelyIntegrated: vi.fn(() => false),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

function currentDayOfWeek(): Session['dayOfWeek'] {
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const mapping: Record<number, Session['dayOfWeek']> = {
    0: 'sunday',
    1: 'monday',
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
  };
  return mapping[dow];
}

function tomorrowDayLabel(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-US', { weekday: 'long' });
}

describe('training home payload builder', () => {
  beforeEach(() => {
    mockGetStoredPlanCoveringDate.mockReset();
    mockAdjustForFatigue.mockReset();
    mockLoggerDebug.mockReset();
  });

  it('keeps fallback metadata honest when upstream reads degrade', async () => {
    const { buildTrainingHomePayload } = await import('../../src/api/routes/training-home-payload');

    const payload = await buildTrainingHomePayload(12, 'pt-PT', {
      getTodaySession: async () => {
        throw new Error('today unavailable');
      },
      getWeekPlan: async () => ({
        plan: null,
        sessions: [],
        adherence: 0,
      }),
      getReadiness: async () => ({
        score: 60,
        factors: {},
        recommendation: null,
        reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      }),
      buildActiveSignalsResponse: async () => {
        throw new Error('signals unavailable');
      },
      getCoachBriefingSnapshot: () => ({
        briefing: 'Coach cached.',
        recommendations: [],
        garminData: null,
        degraded: true,
      }),
    });

    expect(payload.meta.isFallback).toBe(true);
    expect(payload.meta.isPartial).toBe(true);
    expect(payload.meta.isStale).toBe(true);
    expect(payload.meta.reasonCodes).toEqual(
      expect.arrayContaining([
        'TODAY_UNAVAILABLE',
        'WEARABLE_INTEGRATION_MISSING',
        'SIGNALS_UNAVAILABLE',
        'COACH_STALE',
      ]),
    );
  });

  it('re-runs fatigue adjustment on orange readiness and exposes before/after prescriptions', async () => {
    const { buildTrainingHomePayload } = await import('../../src/api/routes/training-home-payload');
    const todayDow = currentDayOfWeek();
    const originalPlan = {
      sessions: [
        {
          dayOfWeek: todayDow,
          sessionType: 'threshold_run',
          title: 'Tempo Run',
          durationMinutes: 50,
          intensityZone: 'zone 4',
        },
      ],
      guardrailResults: [
        {
          ruleId: 'fatigue_gate',
          status: 'pass',
          message: 'original plan',
          adjusted: false,
        },
      ],
    };
    mockGetStoredPlanCoveringDate.mockReturnValue({
      athleteState: {
        profile: { athleteId: 88 },
        readiness: {
          capturedAt: '2026-04-20T07:00:00.000Z',
          score: 72,
          level: 'yellow',
          energyReserve: 70,
        },
      },
      plan: originalPlan,
    });
    mockAdjustForFatigue.mockReturnValue({
      sessions: [
        {
          dayOfWeek: todayDow,
          sessionType: 'recovery_run',
          title: 'Recovery Run',
          durationMinutes: 35,
          intensityZone: 'zone 2',
        },
      ],
      guardrailResults: [
        {
          ruleId: 'fatigue_gate',
          status: 'warn',
          message: 'threshold_run → recovery_run because readiness is low',
          adjusted: true,
        },
      ],
    });

    const payload = await buildTrainingHomePayload(12, 'en', {
      getTodaySession: async () => ({
        session: {
          type: 'run',
          sessionType: 'run',
          status: 'planned',
        },
        plan: { id: 1 },
      }),
      getWeekPlan: async () => ({
        plan: { id: 1 },
        sessions: [
          {
            day: tomorrowDayLabel(),
            type: 'run',
            status: 'planned',
          },
        ],
        adherence: 0.8,
      }),
      getReadiness: async () => ({
        score: 45,
        factors: {
          bodyBattery: 32,
          hrvStatus: 'low',
        },
        recommendation: 'Reduce load today.',
      }),
      buildActiveSignalsResponse: async () => ({ signals: [] }),
      getCoachBriefingSnapshot: () => null,
    });

    expect(mockAdjustForFatigue).toHaveBeenCalledTimes(1);
    expect(payload.hero.originalPrescription).toEqual({
      title: 'Tempo Run',
      detail: '50 min · zone 4',
      durationMinutes: 50,
      sessionType: 'threshold_run',
    });
    expect(payload.hero.adaptedPrescription).toEqual({
      title: 'Recovery Run',
      detail: '35 min · zone 2',
      durationMinutes: 35,
      sessionType: 'recovery_run',
    });
    expect(payload.weekProtection?.kernelAdjustments).toEqual(
      expect.arrayContaining([
        expect.stringContaining('threshold run → recovery run because readiness is low'),
      ]),
    );
    expect(payload.weekProtection?.kernelAdjustments.join('\n')).not.toContain('threshold_run');
  });

  it('skips the fatigue re-run on green or yellow readiness', async () => {
    const { buildTrainingHomePayload } = await import('../../src/api/routes/training-home-payload');
    const todayDow = currentDayOfWeek();
    mockGetStoredPlanCoveringDate.mockReturnValue({
      athleteState: {
        profile: { athleteId: 99 },
        readiness: {
          capturedAt: '2026-04-20T07:00:00.000Z',
          score: 82,
          level: 'green',
          energyReserve: 88,
        },
      },
      plan: {
        sessions: [
          {
            dayOfWeek: todayDow,
            sessionType: 'run',
            title: 'Easy Run',
            durationMinutes: 40,
            intensityZone: 'zone 2',
          },
        ],
        guardrailResults: [],
      },
    });

    await buildTrainingHomePayload(12, 'en', {
      getTodaySession: async () => ({
        session: {
          type: 'run',
          sessionType: 'run',
          status: 'planned',
        },
        plan: { id: 1 },
      }),
      getWeekPlan: async () => ({
        plan: { id: 1 },
        sessions: [],
        adherence: 0.9,
      }),
      getReadiness: async () => ({
        score: 82,
        factors: {
          bodyBattery: 88,
          hrvStatus: 'normal',
        },
        recommendation: 'Train as planned.',
      }),
      buildActiveSignalsResponse: async () => ({ signals: [] }),
      getCoachBriefingSnapshot: () => null,
    });

    expect(mockAdjustForFatigue).not.toHaveBeenCalled();
  });
});

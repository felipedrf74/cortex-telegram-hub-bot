import { describe, expect, it } from 'vitest';
import {
  buildSecretaryDaySnapshot,
  markDailyPlanSourcesStale,
  markWeeklyPlanSourcesStale,
  readyWeeklyPlanSourceHealth,
  unavailableDailyPlanSourceHealth,
} from '../../src/services/secretary-planning-snapshot';

describe('Secretary planning snapshot source-health compatibility', () => {
  it('never upgrades a legacy week without source health to all-ready', () => {
    const context = {
      userId: 42,
      tenantId: 42,
      timezone: 'Europe/Lisbon',
      language: 'en-US',
      targetDate: '2026-08-31',
      weekStart: '2026-08-31',
      weekEnd: '2026-09-06',
      user: { id: 42 },
      warningCodes: [],
      warnings: [],
    } as const;
    const week = {
      weekStart: context.weekStart,
      weekEnd: context.weekEnd,
      generatedAt: '2026-08-31T08:00:00.000Z',
      timezone: context.timezone,
      warningCodes: [],
      warnings: [],
      variant: 'steady',
      degraded: false,
      gated: { skills: [] },
      garmin_stale: false,
      conflicts: [],
      creativeCopy: { headline: '', note: '' },
      summary: { sessionCount: 0, mealCount: 0, activeConflictCount: 0 },
      days: [],
    } as any;

    const snapshot = buildSecretaryDaySnapshot({ context: context as any, week });

    expect(Object.values(snapshot.sourceHealth).every((health) => health.status === 'unavailable')).toBe(true);
  });

  it('marks legacy cached week and day payloads unavailable instead of fresh', () => {
    const week = markWeeklyPlanSourcesStale({ warningCodes: [], warnings: [] });
    const day = markDailyPlanSourcesStale({ warningCodes: [], warnings: [] });

    expect(week.warningCodes).toContain('PLANNING_SOURCE_UNAVAILABLE');
    expect(Object.values(week.sourceHealth!).every((health) => health.status === 'unavailable')).toBe(true);
    expect(day.warningCodes).toContain('PLANNING_SOURCE_UNAVAILABLE');
    expect(Object.values(day.sourceHealth!).every((health) => health.status === 'unavailable')).toBe(true);
  });

  it('adds compatibility warnings when legacy cached payloads omit warning arrays', () => {
    const week = markWeeklyPlanSourcesStale({});
    const day = markDailyPlanSourcesStale({});

    expect(week.warningCodes).toEqual(['PLAN_CACHE_STALE', 'PLANNING_SOURCE_UNAVAILABLE']);
    expect(week.warnings).toEqual(['This cached plan does not include current source health.']);
    expect(day.warningCodes).toEqual(['PLAN_CACHE_STALE', 'PLANNING_SOURCE_UNAVAILABLE']);
    expect(day.warnings).toEqual(['This cached plan does not include current source health.']);
  });

  it('marks only ready sources stale and preserves existing health failures and unique warnings', () => {
    const weeklyHealth = readyWeeklyPlanSourceHealth();
    weeklyHealth.mail = {
      status: 'degraded',
      warningCodes: ['MAIL_PARTIAL'],
      warnings: ['Mail is partial.'],
    };
    const week = markWeeklyPlanSourcesStale({
      sourceHealth: weeklyHealth,
      warningCodes: ['PLAN_CACHE_STALE'],
      warnings: ['This plan is cached while current source state refreshes.'],
    });
    const weekWithoutWarningArrays = markWeeklyPlanSourcesStale({
      sourceHealth: readyWeeklyPlanSourceHealth(),
    });

    const dailyHealth = unavailableDailyPlanSourceHealth();
    dailyHealth.calendar = { status: 'ready', warningCodes: [], warnings: [] };
    const day = markDailyPlanSourcesStale({ sourceHealth: dailyHealth });

    expect(week.sourceHealth.calendar.status).toBe('stale');
    expect(week.sourceHealth.mail).toEqual(weeklyHealth.mail);
    expect(week.warningCodes).toEqual(['PLAN_CACHE_STALE']);
    expect(week.warnings).toEqual(['This plan is cached while current source state refreshes.']);
    expect(weekWithoutWarningArrays.warningCodes).toEqual(['PLAN_CACHE_STALE']);
    expect(weekWithoutWarningArrays.warnings).toEqual([
      'This plan is cached while current source state refreshes.',
    ]);
    expect(day.sourceHealth.calendar.status).toBe('stale');
    expect(day.sourceHealth.decision_center.status).toBe('unavailable');
    expect(day.warningCodes).toEqual(['PLAN_CACHE_STALE']);
    expect(day.warnings).toEqual(['This plan is cached while current source state refreshes.']);
  });
});

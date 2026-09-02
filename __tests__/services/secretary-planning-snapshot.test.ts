import { describe, expect, it } from 'vitest';
import {
  buildSecretaryDaySnapshot,
  markDailyPlanSourcesStale,
  markWeeklyPlanSourcesStale,
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
});

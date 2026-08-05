import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';

import { resolvePlanSlotDate } from '../../src/api/routes/training-plan-persistence';

describe('training plan persistence slot-date anchoring', () => {
  it('anchors next-full-week plans to the resolved start date, not the request day', () => {
    const result = resolvePlanSlotDate({
      weekNumber: 1,
      dayIndex: 0,
      planStartDate: '2026-04-20',
      now: new Date('2026-04-17T10:00:00.000Z'),
    });

    expect(result.kind).toBe('usable');
    if (result.kind === 'usable') {
      expect(DateTime.fromJSDate(result.sessionDate).setZone('Europe/Lisbon').toISODate()).toBe('2026-04-20');
    }
  });

  it('keeps Sunday at the end of a Monday-start week instead of marking it past', () => {
    const result = resolvePlanSlotDate({
      weekNumber: 1,
      dayIndex: 6,
      planStartDate: '2026-06-15',
      now: new Date('2026-06-15T06:00:00.000Z'),
    });

    expect(result.kind).toBe('usable');
    if (result.kind === 'usable') {
      expect(DateTime.fromJSDate(result.sessionDate).setZone('Europe/Lisbon').toISODate()).toBe('2026-06-21');
    }
  });

  it('still rejects earlier week-one days when the user explicitly starts today mid-week', () => {
    const result = resolvePlanSlotDate({
      weekNumber: 1,
      dayIndex: 0,
      planStartDate: '2026-04-17',
      now: new Date('2026-04-17T10:00:00.000Z'),
    });

    expect(result).toEqual({
      kind: 'past_day_in_week_1',
      dayName: 'Monday',
      generatedOnDayName: 'Friday',
    });
  });

  it('uses the plan timezone for the week-one past-day floor at UTC midnight', () => {
    const result = resolvePlanSlotDate({
      weekNumber: 1,
      dayIndex: 0,
      planStartDate: '2026-04-20',
      now: new Date('2026-04-20T00:30:00.000Z'),
      schedulingTimezone: 'America/Los_Angeles',
    });

    // Stronger guarantee: Sunday evening in Los Angeles must not make the
    // plan's Monday slot look stale merely because the server is already UTC Monday.
    expect(result.kind).toBe('usable');
    if (result.kind === 'usable') {
      expect(result.sessionDate.toISOString()).toBe('2026-04-20T07:00:00.000Z');
    }
  });
});

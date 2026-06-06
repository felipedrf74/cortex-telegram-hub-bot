import { describe, expect, it } from 'vitest';

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
      expect(result.sessionDate.toISOString().slice(0, 10)).toBe('2026-04-20');
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
});

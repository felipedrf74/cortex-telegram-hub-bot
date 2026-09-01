import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/user-service', () => ({
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
  getUserLanguageById: vi.fn(() => 'pt-PT'),
}));

import { createDecisionPlanningContext } from '../../src/services/decision-planning-context';

describe('Decision Planning request context', () => {
  it.each([
    {
      label: 'Lisbon spring DST boundary',
      timezone: 'Europe/Lisbon',
      now: '2026-03-29T00:30:00.000Z',
      localDate: '2026-03-29',
      isoWeek: '2026-W13',
      dayStart: '2026-03-29T00:00:00.000Z',
      dayEnd: '2026-03-29T23:00:00.000Z',
    },
    {
      label: 'Sao Paulo previous local day and ISO week-year',
      timezone: 'America/Sao_Paulo',
      now: '2026-01-01T01:00:00.000Z',
      localDate: '2025-12-31',
      isoWeek: '2026-W01',
      dayStart: '2025-12-31T03:00:00.000Z',
      dayEnd: '2026-01-01T03:00:00.000Z',
    },
    {
      label: 'Los Angeles repeated fall-back hour',
      timezone: 'America/Los_Angeles',
      now: '2026-11-01T08:30:00.000Z',
      localDate: '2026-11-01',
      isoWeek: '2026-W44',
      dayStart: '2026-11-01T07:00:00.000Z',
      dayEnd: '2026-11-02T08:00:00.000Z',
    },
  ])('pins $label from one instant', ({ timezone, now, localDate, isoWeek, dayStart, dayEnd }) => {
    const context = createDecisionPlanningContext({
      userId: 42,
      tenantId: 84,
      timezone,
      locale: 'en-US',
      now: new Date(now),
    });

    expect(context).toMatchObject({
      userId: 42,
      tenantId: 84,
      timezone,
      locale: 'en-US',
      localDate,
      isoWeek,
      localDayStartUtc: dayStart,
      localDayEndUtc: dayEnd,
    });
  });

  it('reads an injected clock exactly once', () => {
    const clock = {
      now: vi.fn(() => new Date('2026-08-30T23:30:00.000Z')),
    };

    const context = createDecisionPlanningContext({
      userId: 7,
      tenantId: 7,
      timezone: 'Europe/Lisbon',
      locale: 'pt-PT',
      clock,
    });

    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(context.localDate).toBe('2026-08-31');
  });
});

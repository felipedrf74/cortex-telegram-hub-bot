import { describe, expect, it } from 'vitest';
import { normalizeMicrosoftRecurrence, recurrenceToGoogleRRule } from '../../src/services/recurrence-utils';

describe('recurrence-utils', () => {
  it('normalizes simple weekly recurrence and converts it to Google RRULE', () => {
    const recurrence = normalizeMicrosoftRecurrence(
      {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'bad-day'] },
        range: { type: 'noEnd', startDate: '2026-04-27' },
      },
      '2026-04-27T09:00:00.000Z',
    );

    expect(recurrence).toEqual({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
      range: { type: 'noEnd', startDate: '2026-04-27' },
    });
    expect(recurrenceToGoogleRRule(recurrence)).toBe('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
  });

  it('rejects unsupported recurrence pattern types', () => {
    const recurrence = normalizeMicrosoftRecurrence(
      { pattern: { type: 'relativeYearly', interval: 1 } },
      '2026-04-27T09:00:00.000Z',
    );

    expect(recurrence).toBeUndefined();
  });
});

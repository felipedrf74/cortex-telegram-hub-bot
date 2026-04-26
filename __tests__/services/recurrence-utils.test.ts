import { describe, expect, it } from 'vitest';
import {
  expandRecurringTaskOccurrencesForRange,
  normalizeMicrosoftRecurrence,
  recurrenceToGoogleRRule,
} from '../../src/services/recurrence-utils';

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

  it('projects weekly recurring task occurrences into a due-date range', () => {
    const tasks = [
      {
        id: 'task-1',
        title: 'Weekly review',
        dueDateTime: '2026-04-27T09:00:00.000Z',
        recurrence: {
          pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
          range: { type: 'noEnd', startDate: '2026-04-27' },
        },
      },
    ];

    const occurrences = expandRecurringTaskOccurrencesForRange(
      tasks,
      '2026-05-04T00:00:00.000Z',
      '2026-05-10T23:59:59.000Z',
      { timezone: 'UTC' },
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toEqual(expect.objectContaining({
      id: 'task-1',
      title: 'Weekly review',
      dueDateTime: '2026-05-04T09:00:00.000Z',
      recurrenceInstanceDate: '2026-05-04',
    }));
  });

  it('uses the requested timezone when projecting date-only recurring tasks across DST', () => {
    const tasks = [
      {
        id: 'task-dst',
        title: 'Morning check',
        dueDate: '2026-03-01',
        recurrence: {
          pattern: { type: 'weekly', interval: 1, daysOfWeek: ['sunday'] },
          range: { type: 'noEnd', startDate: '2026-03-01' },
        },
      },
    ];

    const occurrences = expandRecurringTaskOccurrencesForRange(
      tasks,
      '2026-03-29',
      '2026-03-29',
      { timezone: 'Europe/Lisbon' },
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].dueDate).toBe('2026-03-29T00:00:00.000Z');
    expect(occurrences[0].recurrenceInstanceDate).toBe('2026-03-29');
  });
});

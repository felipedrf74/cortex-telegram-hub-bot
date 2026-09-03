import { describe, expect, it } from 'vitest';
import {
  extractTravelDates,
  summarizeBusyDates,
  summarizeCalendarFragmentation,
} from '../../src/services/cross-agent-learning/mesh-common';

describe('mesh calendar date projection', () => {
  it('groups UTC events by the canonical planning timezone', () => {
    const events = [
      { summary: 'Flight', start: '2026-11-02T01:30:00.000Z' },
      { summary: 'Planning', start: '2026-11-02T02:00:00.000Z' },
      { summary: 'Review', start: '2026-11-02T02:30:00.000Z' },
      { summary: 'Wrap', start: '2026-11-02T03:00:00.000Z' },
    ] as any[];

    expect(summarizeBusyDates(events, 'America/Los_Angeles')).toEqual(['2026-11-01']);
    expect(summarizeCalendarFragmentation(events, 'America/Los_Angeles').fragmentedDates)
      .toEqual(['2026-11-01']);
    expect(extractTravelDates(events, 'America/Los_Angeles')).toEqual(['2026-11-01']);
  });

  it('keeps all-day and zone-less provider values on their stated local date', () => {
    const events = [
      { summary: 'Travel day', start: '2026-11-02' },
      { summary: 'Hotel check-in', start: '2026-11-02T00:30:00' },
    ] as any[];

    expect(summarizeBusyDates(events, 'America/Los_Angeles')).toEqual([]);
    expect(extractTravelDates(events, 'America/Los_Angeles')).toEqual(['2026-11-02']);
  });
});

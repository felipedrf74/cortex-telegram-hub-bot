/**
 * Tests for calendar event deduplication in unified-calendar.ts
 *
 * Validates:
 * - eventFingerprint() generates deterministic fingerprints
 * - deduplicateEvents() merges same-event across sources
 * - Richer event data is preserved during merge
 * - syncedSources tracks which calendars have the event
 * - Single-source events pass through unchanged
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  eventFingerprint,
  deduplicateEvents,
  type UnifiedCalendarEvent,
} from '../../src/services/unified-calendar';

// ── Test helpers ───────────────────────────────────────────────────

function makeEvent(
  summary: string,
  start: string,
  source: 'google' | 'outlook',
  opts?: { description?: string; location?: string; id?: string; htmlLink?: string },
): UnifiedCalendarEvent {
  const startDate = new Date(start);
  const endDate = new Date(startDate.getTime() + 3600_000); // +1 hour
  return {
    id: opts?.id || `${source}-${Math.random().toString(36).slice(2, 8)}`,
    summary,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    description: opts?.description,
    location: opts?.location,
    htmlLink: opts?.htmlLink,
    source,
  };
}

function makeAllDayEvent(
  summary: string,
  start: string,
  end: string,
  source: 'google' | 'outlook',
): UnifiedCalendarEvent {
  return {
    id: `${source}-all-day`,
    summary,
    start,
    end,
    source,
    isAllDay: true,
  };
}

// ═══════════════════════════════════════════════════════════════════
// EVENT FINGERPRINT
// ═══════════════════════════════════════════════════════════════════

describe('eventFingerprint', () => {
  it('generates same fingerprint for identical events from different sources', () => {
    const google = makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'google');
    const outlook = makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'outlook');
    expect(eventFingerprint(google)).toBe(eventFingerprint(outlook));
  });

  it('normalizes case and whitespace in subject', () => {
    const a = makeEvent('Team  Standup', '2024-06-15T09:00:00Z', 'google');
    const b = makeEvent('team standup', '2024-06-15T09:00:00Z', 'outlook');
    expect(eventFingerprint(a)).toBe(eventFingerprint(b));
  });

  it('different subjects produce different fingerprints', () => {
    const a = makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'google');
    const b = makeEvent('1:1 with John', '2024-06-15T09:00:00Z', 'google');
    expect(eventFingerprint(a)).not.toBe(eventFingerprint(b));
  });

  it('different times produce different fingerprints', () => {
    const a = makeEvent('Meeting', '2024-06-15T09:00:00Z', 'google');
    const b = makeEvent('Meeting', '2024-06-15T10:00:00Z', 'google');
    expect(eventFingerprint(a)).not.toBe(eventFingerprint(b));
  });

  it('handles small time differences (< 30s) from timezone conversion', () => {
    const a = makeEvent('Meeting', '2024-06-15T09:00:00Z', 'google');
    const b = makeEvent('Meeting', '2024-06-15T09:00:25Z', 'outlook');
    // Both round to the same minute
    expect(eventFingerprint(a)).toBe(eventFingerprint(b));
  });

  it('normalizes all-day date-only and timezone-shifted provider starts to the same day', () => {
    const google = makeAllDayEvent('Holiday', '2026-04-25', '2026-04-26', 'google');
    const outlook = makeAllDayEvent('Holiday', '2026-04-24T23:00:00.000Z', '2026-04-25T23:00:00.000Z', 'outlook');

    expect(eventFingerprint(google)).toBe(eventFingerprint(outlook));
  });
});

// ═══════════════════════════════════════════════════════════════════
// DEDUPLICATE EVENTS
// ═══════════════════════════════════════════════════════════════════

describe('deduplicateEvents', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicateEvents([])).toEqual([]);
  });

  it('passes through single event unchanged', () => {
    const events = [makeEvent('Meeting', '2024-06-15T09:00:00Z', 'google')];
    const result = deduplicateEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].syncedSources).toEqual(['google']);
  });

  it('merges duplicate events from different sources', () => {
    const events = [
      makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'google'),
      makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'outlook'),
    ];
    const result = deduplicateEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Team Standup');
    expect(result[0].syncedSources).toEqual(expect.arrayContaining(['google', 'outlook']));
    expect(result[0].syncedSources).toHaveLength(2);
  });

  it('keeps distinct events from the same source', () => {
    const events = [
      makeEvent('Meeting A', '2024-06-15T09:00:00Z', 'google'),
      makeEvent('Meeting B', '2024-06-15T10:00:00Z', 'google'),
    ];
    const result = deduplicateEvents(events);
    expect(result).toHaveLength(2);
  });

  it('preserves exact same-source duplicates so cleanup paths can delete both provider events', () => {
    const events = [
      makeEvent('Strength + Core', '2024-06-15T09:00:00Z', 'google', { id: 'g-1' }),
      makeEvent('Strength + Core', '2024-06-15T09:00:00Z', 'google', { id: 'g-2' }),
    ];

    const result = deduplicateEvents(events);

    expect(result).toHaveLength(2);
    expect(result.map((event) => event.id)).toEqual(['g-1', 'g-2']);
    expect(result.every((event) => event.syncedSources?.length === 1)).toBe(true);
  });

  it('preserves richer event data regardless of provider order', () => {
    const sparse = makeEvent('Meeting', '2024-06-15T09:00:00Z', 'google', {
      description: 'Short note',
    });
    const rich = makeEvent('Meeting', '2024-06-15T09:00:00Z', 'outlook', {
      description: 'Detailed agenda with multiple topics to discuss. Including budget review.',
      location: 'Conference Room B',
    });

    for (const events of [[sparse, rich], [rich, sparse]]) {
      const result = deduplicateEvents(events);
      expect(result).toHaveLength(1);
      expect(result[0].location).toBe('Conference Room B');
      expect(result[0].description).toContain('Detailed agenda');
      expect(result[0].syncedSources).toEqual(expect.arrayContaining(['google', 'outlook']));
    }
  });

  it('prefers a provider event with a canonical link when other metadata is equal', () => {
    const withoutLink = makeEvent('Meeting', '2024-06-15T09:00:00Z', 'google', { id: 'g' });
    const withLink = makeEvent('Meeting', '2024-06-15T09:00:00Z', 'outlook', {
      id: 'o',
      htmlLink: 'https://outlook.office.com/calendar/item/o',
    });

    const result = deduplicateEvents([withoutLink, withLink]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'o',
      htmlLink: 'https://outlook.office.com/calendar/item/o',
    });
  });

  it('unions duplicate provider intervals even when the richer event ends earlier', () => {
    const events: UnifiedCalendarEvent[] = [
      {
        id: 'g', source: 'google', summary: 'Private appointment',
        start: '2026-08-03T05:00:00.000Z', end: '2026-08-03T05:30:00.000Z',
        description: 'A much richer private description that wins metadata selection.',
      },
      {
        id: 'o', source: 'outlook', summary: 'Private appointment',
        start: '2026-08-03T05:00:00.000Z', end: '2026-08-03T07:00:00.000Z',
      },
    ];

    const result = deduplicateEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'g',
      start: '2026-08-03T05:00:00.000Z',
      end: '2026-08-03T07:00:00.000Z',
      syncedSources: expect.arrayContaining(['google', 'outlook']),
    });
  });

  it('keeps cross-provider duplicates busy unless every copy is explicitly free', () => {
    const google = makeEvent('Shared hold', '2024-06-15T09:00:00Z', 'google');
    const outlook = makeEvent('Shared hold', '2024-06-15T09:00:00Z', 'outlook');

    google.blocksTime = false;
    outlook.blocksTime = true;
    expect(deduplicateEvents([google, outlook])[0].blocksTime).toBe(true);

    outlook.blocksTime = false;
    expect(deduplicateEvents([google, outlook])[0].blocksTime).toBe(false);
  });

  it('handles mixed duplicate and unique events', () => {
    const events = [
      makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'google'),
      makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'outlook'),
      makeEvent('Lunch with Bob', '2024-06-15T12:00:00Z', 'google'),
      makeEvent('Doctor Appt', '2024-06-15T15:00:00Z', 'outlook'),
    ];
    const result = deduplicateEvents(events);
    expect(result).toHaveLength(3); // 1 merged + 2 unique
    const synced = result.find(e => e.summary === 'Team Standup');
    expect(synced?.syncedSources).toHaveLength(2);
  });

  it('handles case-insensitive subject matching', () => {
    const events = [
      makeEvent('TEAM standup', '2024-06-15T09:00:00Z', 'google'),
      makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'outlook'),
    ];
    const result = deduplicateEvents(events);
    expect(result).toHaveLength(1);
  });

  it('does not merge events with same subject but different times', () => {
    const events = [
      makeEvent('Team Standup', '2024-06-15T09:00:00Z', 'google'),
      makeEvent('Team Standup', '2024-06-15T14:00:00Z', 'outlook'),
    ];
    const result = deduplicateEvents(events);
    expect(result).toHaveLength(2);
  });

  it('handles events with empty summaries', () => {
    const events = [
      makeEvent('', '2024-06-15T09:00:00Z', 'google'),
      makeEvent('', '2024-06-15T09:00:00Z', 'outlook'),
    ];
    const result = deduplicateEvents(events);
    expect(result).toHaveLength(1);
  });

  it('deduplicates all-day events from Google date fields and Outlook UTC fields', () => {
    const events = [
      makeAllDayEvent('Public Holiday', '2026-04-25', '2026-04-26', 'google'),
      makeAllDayEvent('Public Holiday', '2026-04-24T23:00:00.000Z', '2026-04-25T23:00:00.000Z', 'outlook'),
    ];

    const result = deduplicateEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].syncedSources).toEqual(expect.arrayContaining(['google', 'outlook']));
  });
});

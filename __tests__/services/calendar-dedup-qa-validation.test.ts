/**
 * QA Validation Tests — Calendar Event Deduplication
 *
 * Additional edge case coverage for the calendar dedup feature:
 * fingerprint normalization, timezone handling, three-plus events,
 * and the syncedSources merge behavior.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  eventFingerprint,
  deduplicateEvents,
  type UnifiedCalendarEvent,
} from '../../src/services/unified-calendar';

function makeEvent(
  summary: string,
  start: string,
  source: 'google' | 'outlook',
  opts?: { description?: string; location?: string; id?: string; htmlLink?: string },
): UnifiedCalendarEvent {
  return {
    id: opts?.id || `${source}-${Math.random().toString(36).slice(2)}`,
    summary,
    start,
    end: start, // simplified for dedup testing
    source,
    description: opts?.description,
    location: opts?.location,
    htmlLink: opts?.htmlLink,
  } as UnifiedCalendarEvent;
}

describe('Calendar Dedup — QA Validation', () => {

  // ── Fingerprint Normalization ────────────────────────────────────

  describe('eventFingerprint normalization', () => {
    it('is case-insensitive', () => {
      const fp1 = eventFingerprint(makeEvent('Team Meeting', '2024-03-15T10:00:00Z', 'google'));
      const fp2 = eventFingerprint(makeEvent('team meeting', '2024-03-15T10:00:00Z', 'outlook'));
      expect(fp1).toBe(fp2);
    });

    it('normalizes multiple spaces to single space', () => {
      const fp1 = eventFingerprint(makeEvent('Team  Meeting', '2024-03-15T10:00:00Z', 'google'));
      const fp2 = eventFingerprint(makeEvent('Team Meeting', '2024-03-15T10:00:00Z', 'outlook'));
      expect(fp1).toBe(fp2);
    });

    it('trims leading/trailing whitespace', () => {
      const fp1 = eventFingerprint(makeEvent('  Team Meeting  ', '2024-03-15T10:00:00Z', 'google'));
      const fp2 = eventFingerprint(makeEvent('Team Meeting', '2024-03-15T10:00:00Z', 'outlook'));
      expect(fp1).toBe(fp2);
    });

    it('handles empty summary', () => {
      const fp = eventFingerprint(makeEvent('', '2024-03-15T10:00:00Z', 'google'));
      expect(fp).toContain('|');
      expect(fp.startsWith('|')).toBe(true);
    });

    it('produces different fingerprints for different times', () => {
      const fp1 = eventFingerprint(makeEvent('Meeting', '2024-03-15T10:00:00Z', 'google'));
      const fp2 = eventFingerprint(makeEvent('Meeting', '2024-03-15T11:00:00Z', 'google'));
      expect(fp1).not.toBe(fp2);
    });

    it('produces different fingerprints for different subjects', () => {
      const fp1 = eventFingerprint(makeEvent('Meeting A', '2024-03-15T10:00:00Z', 'google'));
      const fp2 = eventFingerprint(makeEvent('Meeting B', '2024-03-15T10:00:00Z', 'google'));
      expect(fp1).not.toBe(fp2);
    });

    it('treats events within a few seconds as duplicates', () => {
      // Tiny difference (< 30s) rounds to the same minute
      const fp1 = eventFingerprint(makeEvent('Meeting', '2024-03-15T10:00:00Z', 'google'));
      const fp2 = eventFingerprint(makeEvent('Meeting', '2024-03-15T10:00:15Z', 'outlook'));
      expect(fp1).toBe(fp2);
    });
  });

  // ── Deduplication Edge Cases ────────────────────────────────────

  describe('deduplicateEvents edge cases', () => {
    it('handles empty array', () => {
      const result = deduplicateEvents([]);
      expect(result).toEqual([]);
    });

    it('single event gets syncedSources populated', () => {
      const events = [makeEvent('Meeting', '2024-03-15T10:00:00Z', 'google')];
      const result = deduplicateEvents(events);
      expect(result.length).toBe(1);
      expect(result[0].syncedSources).toEqual(['google']);
    });

    it('two identical events from different sources are merged', () => {
      const events = [
        makeEvent('Team Standup', '2024-03-15T09:00:00Z', 'google'),
        makeEvent('Team Standup', '2024-03-15T09:00:00Z', 'outlook'),
      ];
      const result = deduplicateEvents(events);
      expect(result.length).toBe(1);
      expect(result[0].syncedSources).toContain('google');
      expect(result[0].syncedSources).toContain('outlook');
    });

    it('two different events at same time are NOT merged', () => {
      const events = [
        makeEvent('Meeting A', '2024-03-15T10:00:00Z', 'google'),
        makeEvent('Meeting B', '2024-03-15T10:00:00Z', 'outlook'),
      ];
      const result = deduplicateEvents(events);
      expect(result.length).toBe(2);
    });

    it('same subject at different times are NOT merged', () => {
      const events = [
        makeEvent('Daily Standup', '2024-03-15T09:00:00Z', 'google'),
        makeEvent('Daily Standup', '2024-03-16T09:00:00Z', 'google'),
      ];
      const result = deduplicateEvents(events);
      expect(result.length).toBe(2);
    });

    it('keeps richer event data when merging (description wins)', () => {
      const events = [
        makeEvent('Meeting', '2024-03-15T10:00:00Z', 'google'),
        makeEvent('Meeting', '2024-03-15T10:00:00Z', 'outlook', {
          description: 'Detailed agenda: 1. Review 2. Plan',
          location: 'Room 4B',
        }),
      ];
      const result = deduplicateEvents(events);
      expect(result.length).toBe(1);
      expect(result[0].description).toBe('Detailed agenda: 1. Review 2. Plan');
      expect(result[0].location).toBe('Room 4B');
    });

    it('keeps richer event data when first event is richer', () => {
      const events = [
        makeEvent('Meeting', '2024-03-15T10:00:00Z', 'google', {
          description: 'Very detailed description here',
          location: 'Conference Room A',
          htmlLink: 'https://calendar.google.com/event/123',
        }),
        makeEvent('Meeting', '2024-03-15T10:00:00Z', 'outlook'),
      ];
      const result = deduplicateEvents(events);
      expect(result.length).toBe(1);
      expect(result[0].description).toBe('Very detailed description here');
      expect(result[0].syncedSources).toContain('google');
      expect(result[0].syncedSources).toContain('outlook');
    });

    it('handles multiple groups of duplicates correctly', () => {
      const events = [
        makeEvent('Meeting A', '2024-03-15T09:00:00Z', 'google'),
        makeEvent('Meeting A', '2024-03-15T09:00:00Z', 'outlook'),
        makeEvent('Meeting B', '2024-03-15T14:00:00Z', 'google'),
        makeEvent('Meeting B', '2024-03-15T14:00:00Z', 'outlook'),
        makeEvent('Unique Event', '2024-03-15T16:00:00Z', 'google'),
      ];
      const result = deduplicateEvents(events);
      expect(result.length).toBe(3);

      const meetingA = result.find(e => e.summary === 'Meeting A');
      expect(meetingA?.syncedSources?.length).toBe(2);

      const unique = result.find(e => e.summary === 'Unique Event');
      expect(unique?.syncedSources).toEqual(['google']);
    });

    it('same source duplicates are also merged (e.g., recurring event bug)', () => {
      const events = [
        makeEvent('Standup', '2024-03-15T09:00:00Z', 'google', { id: 'g1' }),
        makeEvent('Standup', '2024-03-15T09:00:00Z', 'google', { id: 'g2' }),
      ];
      const result = deduplicateEvents(events);
      expect(result.length).toBe(1);
      // syncedSources should still just have 'google' (Set deduplication)
      expect(result[0].syncedSources).toEqual(['google']);
    });
  });

  // ── UnifiedCalendarEvent Type ───────────────────────────────────

  describe('UnifiedCalendarEvent type', () => {
    it('syncedSources field is optional on the type', () => {
      const event = makeEvent('Test', '2024-01-01T00:00:00Z', 'google');
      // Before dedup, syncedSources is undefined
      expect(event.syncedSources).toBeUndefined();
    });

    it('source field is preserved after dedup', () => {
      const events = [
        makeEvent('Meeting', '2024-03-15T10:00:00Z', 'outlook'),
      ];
      const result = deduplicateEvents(events);
      expect(result[0].source).toBe('outlook');
    });
  });
});

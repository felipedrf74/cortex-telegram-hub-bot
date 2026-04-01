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
  opts?: { description?: string; location?: string; id?: string },
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
    source,
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

  it('preserves richer event data during merge', () => {
    const events = [
      makeEvent('Meeting', '2024-06-15T09:00:00Z', 'google', {
        description: 'Short note',
      }),
      makeEvent('Meeting', '2024-06-15T09:00:00Z', 'outlook', {
        description: 'Detailed agenda with multiple topics to discuss. Including budget review.',
        location: 'Conference Room B',
      }),
    ];
    const result = deduplicateEvents(events);
    expect(result).toHaveLength(1);
    // Outlook event has richer data — should be kept
    expect(result[0].location).toBe('Conference Room B');
    expect(result[0].description).toContain('Detailed agenda');
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
});

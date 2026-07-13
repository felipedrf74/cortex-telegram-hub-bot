// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  conflictPairKey,
  findCalendarConflictPairs,
} from '../../src/services/calendar-conflict-analysis';
import type { UnifiedCalendarEvent } from '../../src/services/unified-calendar';

function event(id: string, start: string, end: string, source: 'google' | 'outlook' = 'google'): UnifiedCalendarEvent {
  return { id, summary: `Event ${id}`, start, end, source };
}

describe('calendar-conflict-analysis', () => {
  it('detects every event nested inside one long commitment', () => {
    const long = event('long', '2026-07-11T08:00:00.000Z', '2026-07-11T12:00:00.000Z');
    const firstNested = event('nested-1', '2026-07-11T09:00:00.000Z', '2026-07-11T09:30:00.000Z');
    const secondNested = event('nested-2', '2026-07-11T10:00:00.000Z', '2026-07-11T10:30:00.000Z');

    const pairs = findCalendarConflictPairs([secondNested, long, firstNested]);

    expect(pairs.map(({ first, second }) => conflictPairKey(first, second))).toEqual([
      conflictPairKey(long, firstNested),
      conflictPairKey(long, secondNested),
    ]);
  });

  it('does not classify touching endpoints as overlap', () => {
    expect(findCalendarConflictPairs([
      event('one', '2026-07-11T08:00:00.000Z', '2026-07-11T09:00:00.000Z'),
      event('two', '2026-07-11T09:00:00.000Z', '2026-07-11T10:00:00.000Z'),
    ])).toEqual([]);
  });

  it('skips invalid windows and emits one stable pair for duplicate inputs', () => {
    const first = event('one', '2026-07-11T08:00:00.000Z', '2026-07-11T10:00:00.000Z');
    const second = event('two', '2026-07-11T09:00:00.000Z', '2026-07-11T11:00:00.000Z');
    const invalid = event('invalid', 'not-a-date', '2026-07-11T12:00:00.000Z');

    expect(findCalendarConflictPairs([first, second, invalid, first, second])).toHaveLength(1);
  });
});

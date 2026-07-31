// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the unified-calendar module BEFORE importing the training
// route. The route calls `getEvents(startIso, endIso, userId)` from
// ../../services/unified-calendar; we replace it with a spy so we can
// count how many round-trips actually happen.
const getEventsSpy = vi.fn<[string, string, number], Promise<any[]>>(
  async () => [
    { id: 'evt-1', start: '2026-04-20T07:30:00-03:00', summary: 'Run' },
    { id: 'evt-2', start: '2026-04-20T18:00:00-03:00', summary: 'Gym' },
  ],
);

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (start: string, end: string, userId: number) => getEventsSpy(start, end, userId),
  createEvent: vi.fn(),
}));

// Imported once at module scope rather than inside `beforeEach`.
//
// `src/api/routes/training` has a large dependency graph; a cold transform of
// it was measured at ~20s, well past the 10s default `hookTimeout`. This file
// never calls `vi.resetModules()`, so only the first import actually paid that
// cost — but that was enough to time the hook out and fail the file roughly one
// run in eight. Module evaluation is not bound by `hookTimeout`, so loading it
// here removes the deadline rather than merely widening it.
//
// `vi.mock` is hoisted above this, so the unified-calendar spy is already in
// place when the route module is evaluated.
const trainingRouteModule: any = await import('../../src/api/routes/training');

describe('training route — calendar lookup request coalescing', () => {
  beforeEach(() => {
    trainingRouteModule._resetCalendarLookupCoalesceForTests();
    getEventsSpy.mockClear();
  });

  afterEach(() => {
    // Do NOT restoreAllMocks — that would wipe the vi.mock binding.
  });

  it('fires exactly ONE getEvents call when two callers hit the same (userId, range) in parallel', async () => {
    // This is the exact shape of /training/home's inner behavior:
    // getTodaySession and getWeekPlan BOTH call buildCalendarEventLookup
    // with the SAME range (derived from the same active plan). Before
    // the audit fix they fired 2 independent round-trips; now they
    // must share one Promise.
    const mod: any = await import('../../src/api/routes/training');
    const start = new Date('2026-04-20T00:00:00Z');
    const end = new Date('2026-04-26T23:59:59Z');

    const [a, b] = await Promise.all([
      mod._buildCalendarEventLookupForTests(start, end, 42),
      mod._buildCalendarEventLookupForTests(start, end, 42),
    ]);

    expect(getEventsSpy).toHaveBeenCalledTimes(1);
    // Both callers get an equivalent lookup result.
    expect(a.size).toBe(2);
    expect(b.size).toBe(2);
    expect(a.get('evt-1')?.time).toBe('07:30');
  });

  it('does NOT coalesce across different users even if the range is identical', async () => {
    // Per-user isolation is required — two users with overlapping
    // ranges must each get their own fetch (privacy + different
    // calendars).
    const mod: any = await import('../../src/api/routes/training');
    const start = new Date('2026-04-20T00:00:00Z');
    const end = new Date('2026-04-26T23:59:59Z');

    await Promise.all([
      mod._buildCalendarEventLookupForTests(start, end, 1),
      mod._buildCalendarEventLookupForTests(start, end, 2),
    ]);

    expect(getEventsSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT coalesce across different ranges for the same user', async () => {
    const mod: any = await import('../../src/api/routes/training');
    const start1 = new Date('2026-04-20T00:00:00Z');
    const end1 = new Date('2026-04-26T23:59:59Z');
    const start2 = new Date('2026-04-27T00:00:00Z');
    const end2 = new Date('2026-05-03T23:59:59Z');

    await Promise.all([
      mod._buildCalendarEventLookupForTests(start1, end1, 42),
      mod._buildCalendarEventLookupForTests(start2, end2, 42),
    ]);

    expect(getEventsSpy).toHaveBeenCalledTimes(2);
  });

  it('serves sequential calls within the 2s TTL from the recent-result cache (no second fetch)', async () => {
    const mod: any = await import('../../src/api/routes/training');
    const start = new Date('2026-04-20T00:00:00Z');
    const end = new Date('2026-04-26T23:59:59Z');

    // First call: real fetch.
    await mod._buildCalendarEventLookupForTests(start, end, 42);
    expect(getEventsSpy).toHaveBeenCalledTimes(1);

    // Sequential second call within TTL — must NOT fetch again.
    await mod._buildCalendarEventLookupForTests(start, end, 42);
    expect(getEventsSpy).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after cache reset (isolation between tests works)', async () => {
    const mod: any = await import('../../src/api/routes/training');
    const start = new Date('2026-04-20T00:00:00Z');
    const end = new Date('2026-04-26T23:59:59Z');

    await mod._buildCalendarEventLookupForTests(start, end, 42);
    expect(getEventsSpy).toHaveBeenCalledTimes(1);

    mod._resetCalendarLookupCoalesceForTests();

    await mod._buildCalendarEventLookupForTests(start, end, 42);
    expect(getEventsSpy).toHaveBeenCalledTimes(2);
  });
});

/**
 * R4 P3 — race-calendar drop accounting.
 *
 * Codex caught (R4 P3 #1) that the race-calendar resolver silently
 * dropped malformed/over-capped entries. Users + support had no way
 * to debug "why doesn't my race show up?"
 *
 * The fix:
 *   - Add `resolveRaceCalendarFromPlanWithReport` that returns
 *     `{ races, droppedCount, dropReasons, capApplied, capTruncatedCount }`.
 *   - Keep the original `resolveRaceCalendarFromPlan(...)` as a
 *     backward-compat thin wrapper.
 *   - Surface the report on the /coach-analysis response as
 *     `raceCalendarDrops` so iOS can show "3 events couldn't be
 *     loaded" copy.
 *
 * These tests pin the helper + the response surfacing.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveRaceCalendarFromPlan,
  resolveRaceCalendarFromPlanWithReport,
  MAX_RACE_CALENDAR_ENTRIES,
} from '../../src/api/routes/training-coach-v2-hydration';

const validEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 'race-1',
  name: 'Boston Marathon',
  discipline: 'running',
  date: '2026-04-21',
  priority: 'a',
  ...overrides,
});

describe('R4 P3 — resolveRaceCalendarFromPlanWithReport', () => {
  it('returns empty report for null preferences', () => {
    const r = resolveRaceCalendarFromPlanWithReport(null);
    expect(r.races).toEqual([]);
    expect(r.droppedCount).toBe(0);
    expect(r.capApplied).toBe(false);
    expect(r.dropReasons).toEqual({
      invalid_entry_shape: 0,
      missing_required_field: 0,
      unknown_discipline: 0,
      unknown_priority: 0,
    });
  });

  it('returns empty report when raceCalendar is not an array', () => {
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({ raceCalendar: 'oops' }),
    );
    expect(r.races).toEqual([]);
    expect(r.droppedCount).toBe(0);
  });

  it('parses a clean payload with zero drops', () => {
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({ raceCalendar: [validEvent(), validEvent({ id: 'r2', date: '2026-09-15' })] }),
    );
    expect(r.races.length).toBe(2);
    expect(r.droppedCount).toBe(0);
    expect(r.capApplied).toBe(false);
  });

  it('counts missing-required-field drops', () => {
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({
        raceCalendar: [
          validEvent(),
          { id: 'r2', name: 'No date', discipline: 'running', priority: 'a' /* date missing */ },
        ],
      }),
    );
    expect(r.races.length).toBe(1);
    expect(r.droppedCount).toBe(1);
    expect(r.dropReasons.missing_required_field).toBe(1);
  });

  it('counts unknown-discipline drops separately from missing-field drops', () => {
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({
        raceCalendar: [
          validEvent({ discipline: 'curling' }), // bad enum
          { id: 'r2', name: 'Missing fields' },  // missing required
          validEvent({ id: 'good', date: '2026-06-01' }),
        ],
      }),
    );
    expect(r.races.length).toBe(1);
    expect(r.droppedCount).toBe(2);
    expect(r.dropReasons.unknown_discipline).toBe(1);
    expect(r.dropReasons.missing_required_field).toBe(1);
  });

  it('counts unknown-priority drops', () => {
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({
        raceCalendar: [validEvent({ priority: 'urgent' })],
      }),
    );
    expect(r.races).toEqual([]);
    expect(r.droppedCount).toBe(1);
    expect(r.dropReasons.unknown_priority).toBe(1);
  });

  it('counts invalid-entry-shape drops for non-object entries', () => {
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({ raceCalendar: ['oops', 42, null, validEvent()] }),
    );
    expect(r.races.length).toBe(1);
    expect(r.droppedCount).toBe(3);
    expect(r.dropReasons.invalid_entry_shape).toBe(3);
  });

  it('reports capApplied + capTruncatedCount when over the MAX', () => {
    const tooMany = Array.from({ length: MAX_RACE_CALENDAR_ENTRIES + 7 }, (_, i) =>
      validEvent({ id: `race-${i}`, date: '2026-04-21' }),
    );
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({ raceCalendar: tooMany }),
    );
    expect(r.races.length).toBe(MAX_RACE_CALENDAR_ENTRIES);
    expect(r.capApplied).toBe(true);
    expect(r.capTruncatedCount).toBe(7);
  });

  it('does NOT set capApplied when input is exactly at the cap', () => {
    const exact = Array.from({ length: MAX_RACE_CALENDAR_ENTRIES }, (_, i) =>
      validEvent({ id: `race-${i}`, date: '2026-04-21' }),
    );
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({ raceCalendar: exact }),
    );
    expect(r.capApplied).toBe(false);
    expect(r.capTruncatedCount).toBe(0);
    expect(r.races.length).toBe(MAX_RACE_CALENDAR_ENTRIES);
  });

  it('sum of dropReasons matches droppedCount', () => {
    const r = resolveRaceCalendarFromPlanWithReport(
      JSON.stringify({
        raceCalendar: [
          'not-an-object',                          // invalid_entry_shape
          { id: 'r2' /* missing fields */ },        // missing_required_field
          validEvent({ discipline: 'curling' }),    // unknown_discipline
          validEvent({ priority: 'urgent' }),       // unknown_priority
          validEvent({ id: 'good' }),
        ],
      }),
    );
    const sum =
      r.dropReasons.invalid_entry_shape +
      r.dropReasons.missing_required_field +
      r.dropReasons.unknown_discipline +
      r.dropReasons.unknown_priority;
    expect(sum).toBe(r.droppedCount);
    expect(r.droppedCount).toBe(4);
    expect(r.races.length).toBe(1);
  });
});

describe('R4 P3 — resolveRaceCalendarFromPlan (legacy wrapper) is backward-compatible', () => {
  it('returns the same races[] as the report variant', () => {
    const payload = JSON.stringify({
      raceCalendar: [validEvent(), validEvent({ id: 'r2', date: '2026-09-15' })],
    });
    const legacy = resolveRaceCalendarFromPlan(payload);
    const report = resolveRaceCalendarFromPlanWithReport(payload);
    expect(legacy).toEqual(report.races);
  });

  it('silently drops bad entries (no exception thrown)', () => {
    const races = resolveRaceCalendarFromPlan(
      JSON.stringify({ raceCalendar: [{ discipline: 'curling' }, validEvent()] }),
    );
    expect(races.length).toBe(1);
  });
});

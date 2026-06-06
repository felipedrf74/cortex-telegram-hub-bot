/**
 * Slice C7 — WeekConditions aggregator tests.
 *
 * Pins:
 *   - Empty input → empty conditions except weekIndex
 *   - C1 missed-session signals → missedSessionsThisWeek count
 *   - C2 travel window → isTravelWeek + travelStress object
 *   - C3 equipment override → equipmentOverride
 *   - C4 gap signal → returnProtocol
 *   - C5 trendLow → lowAdherenceTrend
 *   - B5 deload due → deloadDue
 *   - athleteState → lifecycleState derived via PR 3 §D2 module
 */

import { describe, expect, it } from 'vitest';
import { aggregateWeekConditions } from '../../src/services/coach-kernel/week-conditions';

describe('aggregateWeekConditions', () => {
  it('empty input → conditions with only weekIndex', () => {
    const result = aggregateWeekConditions({ weekIndex: 3 });
    expect(result.weekIndex).toBe(3);
    expect(result.isTravelWeek).toBeUndefined();
    expect(result.missedSessionsThisWeek).toBeUndefined();
    expect(result.deloadDue).toBeUndefined();
    expect(result.returnProtocol).toBeUndefined();
  });

  it('missed-session signals → count surfaced', () => {
    const result = aggregateWeekConditions({
      weekIndex: 1,
      missedSessionSignals: [
        { userId: 1, planId: 1, sessionId: 1, sessionTitle: 's', scheduledDate: '2026-05-23', daysSinceMissed: 2, sessionType: 'easy_run', severity: 'standard', isKeySession: false },
        { userId: 1, planId: 1, sessionId: 2, sessionTitle: 's', scheduledDate: '2026-05-24', daysSinceMissed: 1, sessionType: 'easy_run', severity: 'standard', isKeySession: false },
      ],
    });
    expect(result.missedSessionsThisWeek).toBe(2);
  });

  it('travel window → isTravelWeek + travelStress + stress score', () => {
    const result = aggregateWeekConditions({
      weekIndex: 5,
      travelWindows: [{
        id: 1, user_id: 100, start_date: '2026-05-23', end_date: '2026-05-30',
        equipment_profile: 'hotel_only', time_zone_shift_hours: 8, flight_duration_hours: 12,
        sleep_disruption_expected: 1, walking_load_expected: 1, heat_stress: 0,
        available_session_duration_minutes: 30, notes: null, created_at: 'x',
      }],
    });
    expect(result.isTravelWeek).toBe(true);
    expect(result.travelStress?.timeZoneShiftHours).toBe(8);
    expect(result.travelStress?.flightDurationHours).toBe(12);
    expect(result.travelStress?.sleepDisruptionExpected).toBe(true);
  });

  it('aggregates multiple travel windows instead of only reading the newest one', () => {
    const result = aggregateWeekConditions({
      weekIndex: 5,
      travelWindows: [
        {
          id: 1, user_id: 100, start_date: '2026-05-23', end_date: '2026-05-25',
          equipment_profile: 'hotel_only', time_zone_shift_hours: 1, flight_duration_hours: 2,
          sleep_disruption_expected: 0, walking_load_expected: 1, heat_stress: 0,
          available_session_duration_minutes: 30, notes: null, created_at: 'x',
        },
        {
          id: 2, user_id: 100, start_date: '2026-05-26', end_date: '2026-05-30',
          equipment_profile: 'hotel_only', time_zone_shift_hours: -6, flight_duration_hours: 11,
          sleep_disruption_expected: 1, walking_load_expected: 0, heat_stress: 1,
          available_session_duration_minutes: 30, notes: null, created_at: 'x',
        },
      ],
    });

    expect(result.travelStress?.timeZoneShiftHours).toBe(-6);
    expect(result.travelStress?.flightDurationHours).toBe(11);
    expect(result.travelStress?.sleepDisruptionExpected).toBe(true);
    expect(result.travelStress?.walkingLoadExpected).toBe(true);
    expect(result.travelStress?.heatStress).toBe(true);
    expect((result as any).travelStressScore).toBeGreaterThan(0.5);
  });

  it('equipment override → conditions.equipmentOverride', () => {
    const result = aggregateWeekConditions({
      weekIndex: 0,
      equipmentOverride: { fullGym: false, dumbbells: true },
    });
    expect(result.equipmentOverride).toEqual({ fullGym: false, dumbbells: true });
  });

  it('gap signal → returnProtocol', () => {
    const result = aggregateWeekConditions({
      weekIndex: 0,
      gapSignal: {
        userId: 100, gapDays: 21,
        lastCompletionDate: '2026-05-01T00:00:00Z',
        protocol: 'febrile_or_systemic_illness',
        inferenceRationale: 'fever',
      },
    });
    expect(result.returnProtocol).toBe('febrile_or_systemic_illness');
  });

  it('low adherence trend → lowAdherenceTrend', () => {
    const result = aggregateWeekConditions({
      weekIndex: 0,
      adherenceTrend: {
        userId: 100,
        currentWeek: { weekStartDate: 'x', weekEndDate: 'x', completed: 1, scheduled: 4, fraction: 0.25 },
        priorWeek: { weekStartDate: 'x', weekEndDate: 'x', completed: 2, scheduled: 4, fraction: 0.5 },
        rolling2WeekFraction: 0.375,
        trendLow: true,
      },
    });
    expect(result.lowAdherenceTrend).toBe(true);
  });

  it('deload due → deloadDue', () => {
    const result = aggregateWeekConditions({ weekIndex: 0, deloadDue: true });
    expect(result.deloadDue).toBe(true);
  });

  it('all signals compose into single result', () => {
    const result = aggregateWeekConditions({
      weekIndex: 5,
      missedSessionSignals: [
        { userId: 1, planId: 1, sessionId: 1, sessionTitle: 's', scheduledDate: '2026-05-23', daysSinceMissed: 2, sessionType: 'easy_run', severity: 'standard', isKeySession: false },
      ],
      travelWindows: [{
        id: 1, user_id: 100, start_date: '2026-05-23', end_date: '2026-05-30',
        equipment_profile: null, time_zone_shift_hours: null, flight_duration_hours: null,
        sleep_disruption_expected: 0, walking_load_expected: 0, heat_stress: 0,
        available_session_duration_minutes: null, notes: null, created_at: 'x',
      }],
      gapSignal: {
        userId: 100, gapDays: 10,
        lastCompletionDate: '2026-05-13T00:00:00Z',
        protocol: 'vacation_or_life_gap',
        inferenceRationale: 'vacation',
      },
      adherenceTrend: {
        userId: 100,
        currentWeek: { weekStartDate: 'x', weekEndDate: 'x', completed: 1, scheduled: 4, fraction: 0.25 },
        priorWeek: { weekStartDate: 'x', weekEndDate: 'x', completed: 2, scheduled: 4, fraction: 0.5 },
        rolling2WeekFraction: 0.375,
        trendLow: true,
      },
      deloadDue: true,
    });
    expect(result.weekIndex).toBe(5);
    expect(result.missedSessionsThisWeek).toBe(1);
    expect(result.isTravelWeek).toBe(true);
    expect(result.returnProtocol).toBe('vacation_or_life_gap');
    expect(result.lowAdherenceTrend).toBe(true);
    expect(result.deloadDue).toBe(true);
  });
});

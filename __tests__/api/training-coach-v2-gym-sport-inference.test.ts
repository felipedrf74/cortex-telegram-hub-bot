/**
 * R5 P1 #2 — inferSportFromSessionType must NOT map gym→running.
 *
 * Codex's concrete probe: `inferSportFromSessionType('gym','gym')`
 * returned `'running'`. The result was that strength/gym sessions
 * skipped strength-specific travel downgrades, missed-session roles,
 * and the strength load-model dimension.
 *
 * These tests pin the new mapping + verify the fallback paths
 * accept gym/strength/weights/lifting plan-sport tokens.
 */
import { describe, expect, it } from 'vitest';
import { inferSportFromSessionType } from '../../src/api/routes/training-coach-v2-hydration';

describe('R5 P1 — gym-sport inference (regression for Codex case)', () => {
  it('the regression case: ("gym","gym") returns "strength" (NOT "running")', () => {
    expect(inferSportFromSessionType('gym', 'gym')).toBe('strength');
  });

  it('common gym session-type aliases all map to strength', () => {
    const aliases = ['gym', 'lift', 'lifting', 'weights', 'weight_training', 'strength', 'resistance', 'squat', 'deadlift', 'press'];
    for (const alias of aliases) {
      expect(inferSportFromSessionType(alias, 'unknown')).toBe('strength');
    }
  });

  it('mixed-case gym tokens still match', () => {
    expect(inferSportFromSessionType('GYM', 'gym')).toBe('strength');
    expect(inferSportFromSessionType('Gym', 'gym')).toBe('strength');
  });

  it('plan-sport-only fallback accepts gym/strength/weights/lifting', () => {
    expect(inferSportFromSessionType('cardio', 'gym')).toBe('strength');
    expect(inferSportFromSessionType('cardio', 'strength')).toBe('strength');
    expect(inferSportFromSessionType('cardio', 'weights')).toBe('strength');
    expect(inferSportFromSessionType('cardio', 'lifting')).toBe('strength');
  });

  it('endurance session types still resolve correctly', () => {
    expect(inferSportFromSessionType('easy_run', 'running')).toBe('running');
    expect(inferSportFromSessionType('threshold_ride', 'cycling')).toBe('cycling');
    expect(inferSportFromSessionType('swim_intervals', 'swimming')).toBe('swimming');
  });

  it('strength branch takes precedence over running/cycling branches when session_type contains both', () => {
    // Example: an "after-run strength" session — strength wins because
    // the more specific token is the lift/strength keyword.
    expect(inferSportFromSessionType('strength_after_run', 'running')).toBe('strength');
  });

  it('totally unknown session_type + plan sport falls back to running (backward compat)', () => {
    // Codex flagged the BUG case (`('gym','gym')`) — the unknown
    // fallback to 'running' stays in place to preserve existing
    // behavior for legitimate unknowns.
    expect(inferSportFromSessionType('foo', 'bar')).toBe('running');
  });

  it('null/undefined session_type or planSport do not crash', () => {
    // Defensive — runtime null guards.
    expect(inferSportFromSessionType(null as unknown as string, 'gym')).toBe('strength');
    expect(inferSportFromSessionType('gym', null as unknown as string)).toBe('strength');
    expect(inferSportFromSessionType(undefined as unknown as string, undefined as unknown as string)).toBe('running');
  });
});

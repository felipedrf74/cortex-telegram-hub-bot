import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getTrainingWeeklyAdherenceRate,
  resolveTrainingMutationSession,
  type TrainingSessionMutationDeps,
} from '../../src/api/routes/training-session-mutations';
import { resolveTrainingDay } from '../../src/services/training-date-utils';

function buildDeps(overrides: Partial<TrainingSessionMutationDeps> = {}): TrainingSessionMutationDeps {
  return {
    getActivePlan: vi.fn(() => ({ id: 44, user_id: 12, tenant_id: 12 })),
    getCurrentWeek: vi.fn(() => ({ id: 78 })),
    getSessionsForWeek: vi.fn(() => [
      {
        id: 321,
        plan_id: 44,
        day_of_week: resolveTrainingDay().weekdayName,
        status: 'pending',
      },
    ]),
    getSessionById: vi.fn(() => ({ id: 321, plan_id: 44 })),
    getPlanById: vi.fn(() => ({ id: 44, user_id: 12, tenant_id: 12 })),
    getWeeklyAdherence: vi.fn(() => ({ adherenceRate: 40 })),
    ...overrides,
  };
}

describe('training-session-mutations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves an explicit numeric session id and verifies ownership', () => {
    const deps = buildDeps();

    const result = resolveTrainingMutationSession(12, 12, '321', deps);

    expect(result).toEqual({
      kind: 'resolved',
      rowId: 321,
      session: { id: 321, plan_id: 44 },
      plan: { id: 44, user_id: 12, tenant_id: 12 },
    });
  });

  it.each(['abc', '12.5', '-1', 'Infinity', {}, 0, 12.5])(
    'rejects malformed explicit session id %s before falling back to today',
    (sessionId) => {
      const deps = buildDeps();

      const result = resolveTrainingMutationSession(12, 12, sessionId, deps);

      expect(result).toEqual({
        kind: 'bad_input',
        message: 'sessionId must be a positive integer or "today"',
      });
      expect(deps.getActivePlan).not.toHaveBeenCalled();
      expect(deps.getSessionById).not.toHaveBeenCalled();
    },
  );

  it('resolves today session from the active week when sessionId is today', () => {
    const todayName = resolveTrainingDay().weekdayName;
    const deps = buildDeps({
      getSessionsForWeek: vi.fn(() => [
        { id: 111, plan_id: 44, day_of_week: todayName, status: 'completed' },
        { id: 222, plan_id: 44, day_of_week: todayName, status: 'pending' },
      ]),
      getSessionById: vi.fn((sessionId: number) => ({ id: sessionId, plan_id: 44 })),
    });

    const result = resolveTrainingMutationSession(12, 12, 'today', deps);

    expect(result).toMatchObject({
      kind: 'resolved',
      rowId: 222,
    });
    expect(deps.getActivePlan).toHaveBeenCalledWith(12, 12);
  });

  it('resolves today using the Training timezone instead of the process date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T23:30:00.000Z'));
    const deps = buildDeps({
      getSessionsForWeek: vi.fn(() => [
        { id: 111, plan_id: 44, day_of_week: 'Sunday', status: 'pending' },
        { id: 222, plan_id: 44, day_of_week: 'Monday', status: 'pending' },
      ]),
      getSessionById: vi.fn((sessionId: number) => ({ id: sessionId, plan_id: 44 })),
    });

    const result = resolveTrainingMutationSession(12, 12, 'today', deps);

    expect(result).toMatchObject({
      kind: 'resolved',
      rowId: 222,
    });
  });

  it('treats skipped sessions as unavailable when excludeSkippedSessions is enabled', () => {
    const todayName = resolveTrainingDay().weekdayName;
    const deps = buildDeps({
      getSessionsForWeek: vi.fn(() => [
        { id: 111, plan_id: 44, day_of_week: todayName, status: 'completed' },
        { id: 222, plan_id: 44, day_of_week: todayName, status: 'skipped' },
      ]),
    });

    const result = resolveTrainingMutationSession(12, 12, 'today', deps, {
      excludeSkippedSessions: true,
    });

    expect(result).toEqual({ kind: 'no_active_session' });
  });

  it('returns not_found when the row id does not resolve to a session', () => {
    const deps = buildDeps({
      getSessionById: vi.fn(() => null),
    });

    const result = resolveTrainingMutationSession(12, 12, '999', deps);

    expect(result).toEqual({ kind: 'not_found', rowId: 999 });
  });

  it('returns forbidden when the session belongs to another user plan', () => {
    const deps = buildDeps({
      getSessionById: vi.fn(() => ({ id: 999, plan_id: 88 })),
      getPlanById: vi.fn(() => ({ id: 88, user_id: 77 })),
    });

    const result = resolveTrainingMutationSession(12, 12, '999', deps);

    expect(result).toEqual({
      kind: 'forbidden',
      rowId: 999,
      session: { id: 999, plan_id: 88 },
    });
  });

  it('returns forbidden when the session belongs to the same user in another tenant', () => {
    const deps = buildDeps({
      getSessionById: vi.fn(() => ({ id: 999, plan_id: 88 })),
      getPlanById: vi.fn(() => ({ id: 88, user_id: 12, tenant_id: 99 })),
    });

    const result = resolveTrainingMutationSession(12, 12, '999', deps);

    expect(result).toEqual({
      kind: 'forbidden',
      rowId: 999,
      session: { id: 999, plan_id: 88 },
    });
  });

  it('normalizes weekly adherence percentage objects to a 0-1 value', () => {
    const deps = buildDeps({
      getWeeklyAdherence: vi.fn(() => ({ adherenceRate: 55 })),
    });

    expect(getTrainingWeeklyAdherenceRate(12, 12, deps)).toBe(0.55);
  });

  it('returns numeric weekly adherence unchanged when already normalized', () => {
    const deps = buildDeps({
      getWeeklyAdherence: vi.fn(() => 0.4),
    });

    expect(getTrainingWeeklyAdherenceRate(12, 12, deps)).toBe(0.4);
  });

  it('returns null when adherence lookup throws', () => {
    const deps = buildDeps({
      getWeeklyAdherence: vi.fn(() => {
        throw new Error('db unavailable');
      }),
    });

    expect(getTrainingWeeklyAdherenceRate(12, 12, deps)).toBeNull();
  });
});

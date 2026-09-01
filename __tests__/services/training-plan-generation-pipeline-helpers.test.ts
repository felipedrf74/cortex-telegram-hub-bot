import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import {
  applyTrainingSafetyOutputToGeneratedPlan,
  buildKernelCapacityWindows,
  buildScheduledWeeklyTargetsFromPlan,
  buildTrainingPlanCreatedMessage,
  buildTrainingSafetyGenerationSummary,
  dedupeDecisionReasons,
  generatedPlanContainsSafetyPause,
  summarizeEquipmentPlanForShadow,
} from '../../src/services/training-plan-generation-pipeline';

const fallbackTargets = {
  sessionsPerWeek: 6,
  runSessionsPerWeek: 3,
  bikeSessionsPerWeek: null,
  swimSessionsPerWeek: 1,
  strengthSessionsPerWeek: 2,
};

function safetyOutput(
  effectiveSeverity: 'pass' | 'warn' | 'block',
  decisionReasons: any[] = [],
): any {
  return {
    effectiveSeverity,
    decisionReasons,
  };
}

describe('training plan generation pipeline domain helpers', () => {
  it('describes singular, disconnected, pending, and reconnect calendar outcomes honestly', () => {
    expect(buildTrainingPlanCreatedMessage({
      totalSessions: 1,
      durationWeeks: 1,
      calendarSyncPending: false,
      calendarSource: null,
    })).toBe('Plan created! 1 session scheduled across 1 week. Calendar sync is not connected for this plan.');

    expect(buildTrainingPlanCreatedMessage({
      totalSessions: 4,
      durationWeeks: 2,
      calendarSyncPending: true,
      calendarSource: 'google',
    })).toContain('Google Calendar events are being created in the background');

    expect(buildTrainingPlanCreatedMessage({
      totalSessions: 4,
      durationWeeks: 2,
      calendarSyncPending: false,
      calendarSource: 'outlook',
    })).toContain('No Outlook Calendar events were queued');
  });

  it('derives realized weekly targets across aliases while excluding non-schedulable sessions', () => {
    const targets = buildScheduledWeeklyTargetsFromPlan({
      weeks: [
        {
          sessions: [
            { date: '2026-09-07T06:00:00Z', sessionType: 'gym' },
            { scheduledDate: '2026-09-07', sessionType: 'lift' },
            { sessionDate: '2026-09-08', sessionType: 'ride' },
            { startDate: '2026-09-09', sessionType: 'swimming' },
            { day: 'Thursday', sessionType: 'brick' },
            { dayOfWeek: 'Friday', title: 'Easy run' },
            { sessionType: 'strength-endurance', scheduleState: 'dropped' },
            { sessionType: 'cycling', scheduleState: 'deferred' },
            { sessionType: 'swim', scheduleState: 'unscheduled' },
            { sessionType: 'jog', scheduleState: 'canceled' },
            { sessionType: 'running', scheduleState: 'cancelled' },
            { sessionType: 'mobility', title: 'Mobility' },
            {},
          ],
        },
        { sessions: 'invalid' },
      ],
    }, fallbackTargets);

    expect(targets).toEqual({
      sessionsPerWeek: 7,
      runSessionsPerWeek: 2,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 1,
      strengthSessionsPerWeek: 2,
    });
    expect(buildScheduledWeeklyTargetsFromPlan({}, fallbackTargets)).toEqual({
      sessionsPerWeek: 0,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: null,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 0,
    });
  });

  it('builds bounded free capacity around clipped, overlapping, and short busy windows', () => {
    expect(buildKernelCapacityWindows({
      startDate: 'not-a-date',
      busyWindows: [],
      schedulingTimezone: 'UTC',
    })).toEqual([]);

    const monday = DateTime.utc(2026, 9, 7);
    const windows = buildKernelCapacityWindows({
      startDate: '2026-09-07',
      schedulingTimezone: 'UTC',
      busyWindows: [
        {
          startMs: monday.set({ hour: 4 }).toMillis(),
          endMs: monday.set({ hour: 6 }).toMillis(),
        },
        {
          startMs: monday.set({ hour: 6, minute: 10 }).toMillis(),
          endMs: monday.set({ hour: 8 }).toMillis(),
        },
        {
          startMs: monday.set({ hour: 19 }).toMillis(),
          endMs: monday.set({ hour: 20, minute: 30 }).toMillis(),
        },
        {
          startMs: monday.set({ hour: 19, minute: 15 }).toMillis(),
          endMs: monday.set({ hour: 20 }).toMillis(),
        },
        {
          startMs: monday.set({ hour: 20 }).toMillis(),
          endMs: monday.set({ hour: 22 }).toMillis(),
        },
      ],
    });

    expect(windows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        date: '2026-09-07',
        startTime: '08:00',
        endTime: '19:00',
        constraints: ['calendar_busy_windows_present'],
      }),
      expect.objectContaining({
        date: '2026-09-08',
        startTime: '05:00',
        endTime: '21:00',
        constraints: ['calendar_open_day'],
      }),
    ]));
    expect(windows.some((window) => window.startTime === '06:00' && window.endTime === '06:10')).toBe(false);
  });

  it('normalizes equipment shadow summaries without leaking exercise text', () => {
    const summary = summarizeEquipmentPlanForShadow({
      weeks: [
        {
          sessions: [
            {
              sessionType: 'GYM',
              exercises: [
                { exerciseId: ' squat ' },
                { name: 'Squat' },
                { name: '  ' },
                {},
              ],
            },
            { sessionType: 'gym', exercises: 'invalid' },
            { sessionType: 'run', exercises: [{ name: 'Run' }] },
          ],
        },
        { sessions: 'invalid' },
      ],
    });

    expect(summary).toMatchObject({
      gymSessionCount: 2,
      exerciseCount: 2,
      duplicateSessionCount: 1,
    });
    expect(summary.sessionExerciseFingerprints).toHaveLength(2);
    expect(summary.sessionExerciseFingerprints).not.toContain('squat');
    expect(summarizeEquipmentPlanForShadow(null)).toEqual({
      gymSessionCount: 0,
      exerciseCount: 0,
      duplicateSessionCount: 0,
      sessionExerciseFingerprints: [],
    });
  });

  it('applies warning and blocking safety dispositions with server-derived reasons', () => {
    const warning = applyTrainingSafetyOutputToGeneratedPlan(
      { planName: 'Plan', decisionReasons: 'invalid' },
      safetyOutput('warn'),
      '2026-09-07',
    );
    expect(warning.decisionReasons).toEqual([
      expect.objectContaining({ code: 'safety_warning_inferred', severity: 'warning' }),
    ]);

    const blocked = applyTrainingSafetyOutputToGeneratedPlan({
      weeks: [
        {
          intensityPct: 'invalid',
          sessions: 'invalid',
          decisionReasons: [],
        },
        {
          weekNumber: 3,
          intensityPct: 80,
          sessions: [{
            sessionType: 'run',
            title: 'Intervals',
            decisionReasons: [],
          }],
        },
      ],
    }, safetyOutput('block'), '2026-09-07');

    expect(blocked.weeks[0]).toMatchObject({
      weekNumber: 1,
      focus: 'recovery',
      intensityPct: 30,
      sessions: [expect.objectContaining({ safetyPause: true, scheduleState: 'deferred' })],
    });
    expect(blocked.weeks[1]).toMatchObject({
      weekNumber: 3,
      intensityPct: 30,
      sessions: [expect.objectContaining({ safetyPause: true })],
    });
    expect(generatedPlanContainsSafetyPause(blocked)).toBe(true);
    expect(generatedPlanContainsSafetyPause({
      weeks: [{
        sessions: [{
          sessionType: ' rest ',
          title: ' Safety Pause ',
          scheduleState: ' Deferred ',
        }],
      }],
    })).toBe(true);
    expect(generatedPlanContainsSafetyPause({ weeks: [{ sessions: [] }] })).toBe(false);
    expect(generatedPlanContainsSafetyPause({ weeks: 'invalid' })).toBe(false);
  });

  it('summarizes pass, warning, and block safety outcomes and deduplicates reasons', () => {
    const reason = {
      code: 'medical_referral',
      text: ' Pause and seek care. ',
      severity: 'block',
      affectedEntity: { type: 'week', id: '2026-09-07' },
      evidence: [],
    };
    expect(buildTrainingSafetyGenerationSummary(undefined)).toBeNull();
    expect(buildTrainingSafetyGenerationSummary(safetyOutput('pass'))).toMatchObject({ status: 'pass' });
    expect(buildTrainingSafetyGenerationSummary(safetyOutput('warn'))).toMatchObject({
      status: 'warning',
      reasonCode: 'safety_warning_inferred',
    });
    expect(buildTrainingSafetyGenerationSummary(safetyOutput('block', [reason]))).toMatchObject({
      status: 'blocked',
      message: ' Pause and seek care. ',
      reasonCode: 'medical_referral',
    });
    expect(dedupeDecisionReasons([
      reason as any,
      { ...reason, text: 'pause   and seek care.' } as any,
      { ...reason, affectedEntity: undefined } as any,
    ])).toHaveLength(2);
  });
});

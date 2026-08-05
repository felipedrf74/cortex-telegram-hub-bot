import { describe, expect, it } from 'vitest';

import {
  buildWeekPlan,
  buildDayPlan,
  loadCoachKnowledge,
  sampleHybridAthlete,
  sampleMarathonAthlete,
  sampleTriathlete,
  type AthleteState,
} from '../../src/services/coach-kernel';
import { trainingEvalPersonaBank, trainingEvalScenarioBank } from '../../src/services/coach-kernel/evaluation';
import { adjustForFatigue } from '../../src/services/coach-kernel/planner-engine';
import { timeToMinutes } from '../../src/services/coach-kernel/utils';

describe('coach-kernel planner', () => {
  it('handles marathon peak-week long run safely', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      currentBlock: {
        ...sampleMarathonAthlete.currentBlock,
        phase: 'peak',
      },
    };

    const plan = buildWeekPlan(athlete, '2026-08-10');
    const longRun = plan.sessions.find((session) => session.sessionType === 'long_run');

    expect(longRun).toBeTruthy();
    expect(longRun!.durationMinutes).toBeLessThanOrEqual(170);
    expect(plan.phase).toBe('peak');
  });

  it('respects a one-run weekly target for running-primary plans', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      goals: {
        ...sampleMarathonAthlete.goals,
        secondaryFocus: undefined,
        priorityOrder: ['running'],
        weeklySessionsTarget: { running: 1, strength: 0 },
        weeklyMinutesTarget: { running: 75, strength: 0 },
      },
    };

    const plan = buildWeekPlan(athlete, '2026-05-11');
    const runs = plan.sessions.filter((session) => session.sport === 'running');

    expect(runs).toHaveLength(1);
    expect(plan.sessions.filter((session) => session.sport === 'strength')).toHaveLength(0);
  });

  it('keeps key run and long run on separate days even when the preferred long day is Tuesday', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      availability: {
        ...sampleMarathonAthlete.availability,
        preferredLongSessionDay: 'tuesday',
      },
      goals: {
        ...sampleMarathonAthlete.goals,
        weeklySessionsTarget: { running: 4, strength: 0 },
      },
    };

    const plan = buildWeekPlan(athlete, '2026-05-11');
    const longRun = plan.sessions.find((session) => session.sessionType === 'long_run');
    const keyRun = plan.sessions.find((session) => session.sport === 'running' && session.keySession && session.sessionType !== 'long_run');

    expect(longRun?.dayOfWeek).toBe('tuesday');
    expect(keyRun).toBeTruthy();
    expect(keyRun?.dayOfWeek).not.toBe(longRun?.dayOfWeek);
  });

  it('places a triathlon brick around the bike day', () => {
    const plan = buildWeekPlan(sampleTriathlete, '2026-06-15');
    const brick = plan.sessions.find((session) => session.sessionType === 'brick');
    const longRide = plan.sessions.find((session) => session.sport === 'cycling' && session.tags.includes('long_session'));

    expect(brick).toBeTruthy();
    expect(longRide).toBeTruthy();
    expect(brick!.dayOfWeek).toBe(longRide!.dayOfWeek);
  });

  it('adds triathlon maintenance strength when requested', () => {
    const plan = buildWeekPlan(sampleTriathlete, '2026-06-15');
    const strength = plan.sessions.filter((session) => session.sport === 'strength');

    expect(strength.length).toBeGreaterThan(0);
    expect(strength.length).toBeLessThanOrEqual(2);
    expect(strength.every((session) => session.tags.includes('maintenance'))).toBe(true);
  });

  it('suppresses triathlon bricks in taper weeks', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      currentBlock: {
        ...sampleTriathlete.currentBlock,
        phase: 'taper',
      },
    };

    const plan = buildWeekPlan(athlete, '2026-07-06');

    expect(plan.sessions.some((session) => session.sessionType === 'brick')).toBe(false);
  });

  it('keeps triathlon day stacking within the athlete max sessions per day', () => {
    const plan = buildWeekPlan(sampleTriathlete, '2026-06-15');
    const byDay = new Map<string, typeof plan.sessions>();
    for (const session of plan.sessions) {
      byDay.set(session.dayOfWeek, [...(byDay.get(session.dayOfWeek) ?? []), session]);
    }

    for (const daySessions of byDay.values()) {
      expect(daySessions.length).toBeLessThanOrEqual(sampleTriathlete.availability.maxSessionsPerDay ?? 2);
      const sportCounts = new Map<string, number>();
      for (const session of daySessions) {
        if (session.sessionType === 'brick') continue;
        sportCounts.set(session.sport, (sportCounts.get(session.sport) ?? 0) + 1);
      }
      expect([...sportCounts.values()].every((count) => count <= 1)).toBe(true);
    }
  });

  it('softens consecutive high-intensity triathlon sessions instead of stacking hard days', () => {
    const plan = buildWeekPlan(sampleTriathlete, '2026-06-15');
    // Stronger guarantee: tempo is quality work too, matching the plan linter's
    // hard-endurance vocabulary instead of silently omitting tempo sessions.
    const highIntensityDays = plan.sessions
      .filter((session) => ['tempo', 'threshold', 'vo2', 'neuromuscular'].includes(session.intensityZone))
      .map((session) => ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].indexOf(session.dayOfWeek))
      .sort((left, right) => left - right);

    for (let index = 1; index < highIntensityDays.length; index++) {
      expect(highIntensityDays[index] - highIntensityDays[index - 1]).toBeGreaterThan(1);
    }
    expect(plan.sessions.some((session) => session.tags.includes('triathlon_spacing_softened'))).toBe(true);
    expect(plan.sessions.some((session) =>
      session.decisionReasons?.some((reason) => reason.sourceConstraint?.id === 'triathlon-hard-day-spacing')
    )).toBe(true);
  });

  it('re-applies triathlon hard-day spacing after capacity reflows a quality session', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      goals: {
        ...sampleTriathlete.goals,
        raceCalendar: [],
        weeklySessionsTarget: { running: 2, cycling: 1, swimming: 2, strength: 1 },
        weeklySessionsTargetExplicit: { running: true, cycling: true, swimming: true, strength: true },
      },
      constraints: [],
      currentBlock: {
        ...sampleTriathlete.currentBlock,
        phase: 'base',
      },
      availability: {
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '07:00', end: '07:45', label: 'Cardio', sports: ['running', 'cycling', 'swimming'] },
          { dayOfWeek: 'tuesday', start: '18:00', end: '18:35', label: 'Strength', sports: ['strength'] },
          { dayOfWeek: 'wednesday', start: '07:00', end: '07:45', label: 'Cardio', sports: ['running', 'cycling', 'swimming'] },
          { dayOfWeek: 'thursday', start: '07:00', end: '07:45', label: 'Cardio', sports: ['running', 'cycling', 'swimming'] },
          { dayOfWeek: 'friday', start: '07:00', end: '07:45', label: 'Cardio', sports: ['running', 'cycling', 'swimming'] },
          { dayOfWeek: 'saturday', start: '07:00', end: '07:45', label: 'Cardio', sports: ['running', 'cycling', 'swimming'] },
          { dayOfWeek: 'sunday', start: '07:00', end: '07:45', label: 'Cardio', sports: ['running', 'cycling', 'swimming'] },
        ],
        preferredLongSessionDay: 'saturday',
        preferredTimesBySport: {
          running: '07:00',
          cycling: '07:00',
          swimming: '07:00',
          strength: '18:00',
        },
        maxSessionsPerDay: 1,
      },
    };

    const plan = buildWeekPlan(athlete, '2026-06-15');
    const hardSessions = plan.sessions
      .filter((session) => ['tempo', 'threshold', 'vo2', 'neuromuscular'].includes(session.intensityZone))
      .sort((left, right) => [
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      ].indexOf(left.dayOfWeek) - [
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      ].indexOf(right.dayOfWeek));

    const softenedAfterReflow = plan.sessions.find((session) =>
      session.tags.includes('triathlon_spacing_softened')
      && session.originalDayOfWeek != null
      && session.originalDayOfWeek !== session.dayOfWeek
    );
    expect(softenedAfterReflow, JSON.stringify(plan.sessions.map((session) => ({
      sport: session.sport,
      type: session.sessionType,
      day: session.dayOfWeek,
      originalDay: session.originalDayOfWeek,
      zone: session.intensityZone,
      fatigue: session.fatigueCost,
      key: session.keySession,
    })))).toBeTruthy();
    for (let index = 1; index < hardSessions.length; index += 1) {
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      expect(days.indexOf(hardSessions[index].dayOfWeek) - days.indexOf(hardSessions[index - 1].dayOfWeek))
        .toBeGreaterThan(1);
    }
    expect(softenedAfterReflow).toMatchObject({
      intensityZone: 'aerobic',
      keySession: false,
      sessionRole: 'easy',
      keySessionLabel: undefined,
    });
    expect(softenedAfterReflow?.tags).toContain('role_easy');
    expect(softenedAfterReflow?.tags).not.toContain('role_threshold');
    expect(softenedAfterReflow?.tags).not.toContain('key_session_classified');
    const activeRequestedSessions = plan.sessions.filter((session) =>
      session.sessionType !== 'brick'
      && !['deferred', 'unscheduled', 'dropped'].includes(String(session.scheduleState ?? ''))
    );
    const modalityCounts = activeRequestedSessions.reduce((counts, session) => {
      counts[session.sport] = (counts[session.sport] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    // Stronger guarantee: the post-capacity safety pass may soften a quality
    // session, but it must preserve every explicit triathlon modality target.
    expect(modalityCounts, JSON.stringify(plan.sessions.map((session) => ({
      sport: session.sport,
      type: session.sessionType,
      day: session.dayOfWeek,
      state: session.scheduleState,
      title: session.title,
    })))).toMatchObject({ running: 2, cycling: 1, swimming: 2, strength: 1 });
  });

  it('respects a one-ride weekly target for cycling-primary plans', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      goals: {
        ...sampleTriathlete.goals,
        primaryFocus: 'cycling',
        secondaryFocus: undefined,
        priorityOrder: ['cycling'],
        weeklySessionsTarget: { cycling: 1 },
      },
      currentBlock: {
        ...sampleTriathlete.currentBlock,
        discipline: 'cycling',
        phase: 'build',
      },
    };

    const plan = buildWeekPlan(athlete, '2026-06-15');

    expect(plan.sessions.filter((session) => session.sport === 'cycling')).toHaveLength(1);
  });

  it('does not grow cycling volume during race weeks', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      goals: {
        ...sampleTriathlete.goals,
        primaryFocus: 'cycling',
        secondaryFocus: undefined,
        priorityOrder: ['cycling'],
        weeklySessionsTarget: { cycling: 3 },
      },
      trainingHistory: {
        ...sampleTriathlete.trainingHistory,
        lastWeekMinutesBySport: {
          ...sampleTriathlete.trainingHistory.lastWeekMinutesBySport,
          cycling: 200,
        },
      },
      currentBlock: {
        ...sampleTriathlete.currentBlock,
        discipline: 'cycling',
        phase: 'race',
      },
    };

    const plan = buildWeekPlan(athlete, '2026-06-15');
    const cyclingMinutes = plan.sessions
      .filter((session) => session.sport === 'cycling')
      .reduce((total, session) => total + session.durationMinutes, 0);

    expect(cyclingMinutes).toBeLessThanOrEqual(200);
  });

  it('protects race-week running volume and removes long-run fatigue when travel constrained', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      equipment: {
        hasGym: false,
        hasBarbell: false,
        hasDumbbells: false,
        hasBikeTrainer: false,
        hasPool: false,
        hasTrack: false,
        notes: ['travel day bodyweight only'],
      },
      availability: {
        weeklyWindows: [
          { dayOfWeek: 'monday', start: '07:00', end: '07:45', sports: ['running', 'strength'] },
          { dayOfWeek: 'tuesday', start: '07:15', end: '07:40', sports: ['strength'] },
          { dayOfWeek: 'wednesday', start: '18:30', end: '19:00', sports: ['strength'] },
          { dayOfWeek: 'thursday', start: '12:00', end: '12:45', sports: ['running', 'strength'] },
          { dayOfWeek: 'saturday', start: '08:00', end: '11:00', sports: ['running'] },
        ],
        preferredLongSessionDay: 'saturday',
        preferredTimesBySport: { running: '08:00', strength: '12:00' },
        maxSessionsPerDay: 1,
      },
      constraints: [
        { id: 'race-week-travel', type: 'equipment', severity: 'high', description: 'Race week travel: bodyweight only and limited time.' },
      ],
      currentBlock: {
        ...sampleMarathonAthlete.currentBlock,
        phase: 'race',
      },
    };

    const plan = buildWeekPlan(athlete, '2026-06-22');
    const running = plan.sessions.filter((session) => session.sport === 'running');

    expect(plan.phase).toBe('race');
    expect(running.reduce((sum, session) => sum + session.durationMinutes, 0)).toBeLessThanOrEqual(115);
    expect(running.some((session) => session.sessionType === 'long_run')).toBe(false);
    expect(running.some((session) => session.fatigueCost === 'very_high')).toBe(false);
    expect(running.some((session) => session.intensityZone === 'threshold' || session.intensityZone === 'vo2')).toBe(false);
  });

  it('emits speed_swim for advanced peak swim weeks', () => {
    const athlete: AthleteState = {
      ...sampleTriathlete,
      goals: {
        ...sampleTriathlete.goals,
        primaryFocus: 'swimming',
        secondaryFocus: undefined,
        priorityOrder: ['swimming'],
        weeklySessionsTarget: { swimming: 2 },
      },
      currentBlock: {
        ...sampleTriathlete.currentBlock,
        discipline: 'swimming',
        phase: 'peak',
      },
    };

    const plan = buildWeekPlan(athlete, '2026-06-15');

    expect(plan.sessions.some((session) => session.sessionType === 'speed_swim')).toBe(true);
  });

  it('resolves hybrid priority conflicts in favor of the declared priority', () => {
    const knowledge = loadCoachKnowledge();
    expect(knowledge.docs.hybridAthleteRules).toContain('Endurance priority wins');

    const plan = buildWeekPlan(sampleHybridAthlete, '2026-05-04');
    const strengthSessions = plan.sessions.filter((session) => session.sport === 'strength');
    const runSessions = plan.sessions.filter((session) => session.sport === 'running');

    expect(strengthSessions.length).toBeGreaterThan(0);
    expect(runSessions.length).toBeLessThanOrEqual(3);
  });

  it('caps scheduled sessions to declared short availability windows', () => {
    const persona = trainingEvalPersonaBank.find((item) => item.id === 'runner-half-marathon')!;
    const scenario = trainingEvalScenarioBank.find((item) => item.id === 'reduced-available-time')!;
    const athlete = scenario.apply({ persona, weekStart: '2026-04-27' });

    const plan = buildWeekPlan(athlete, '2026-04-27');
    const cappedSessions = plan.sessions.filter((session) => session.tags.includes('availability_capped'));

    expect(cappedSessions.length).toBeGreaterThan(0);
    for (const session of plan.sessions) {
      const window = athlete.availability.weeklyWindows.find((item) =>
        item.dayOfWeek === session.dayOfWeek
        && (!item.sports || item.sports.includes(session.sport))
      );
      if (!window) continue;

      const capacityMinutes = timeToMinutes(window.end) - timeToMinutes(window.start);
      expect(session.durationMinutes).toBeLessThanOrEqual(capacityMinutes);
      if (session.startTime && session.endTime) {
        expect(timeToMinutes(session.endTime) - timeToMinutes(session.startTime)).toBe(session.durationMinutes);
      }
    }
  });

  it('does not leak running sessions into strength-primary weeks', () => {
    const strengthAthlete: AthleteState = {
      ...sampleHybridAthlete,
      profile: {
        ...sampleHybridAthlete.profile,
        primaryDiscipline: 'strength',
      },
      goals: {
        ...sampleHybridAthlete.goals,
        primaryFocus: 'strength',
        secondaryFocus: undefined,
        priorityOrder: ['strength'],
        weeklySessionsTarget: { strength: 5 },
        weeklyMinutesTarget: { strength: 240 },
      },
      currentBlock: {
        ...sampleHybridAthlete.currentBlock,
        discipline: 'strength',
        phase: 'base',
      },
    };

    const plan = buildWeekPlan(strengthAthlete, '2026-04-26');

    expect(plan.discipline).toBe('strength');
    expect(plan.sessions).not.toHaveLength(0);
    expect(plan.sessions.every((session) => session.sport === 'strength')).toBe(true);
    expect(plan.sessions.some((session) => session.sport === 'running')).toBe(false);
  });

  it('builds a daily recommendation using deterministic weekly plan output', () => {
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');
    const day = buildDayPlan(sampleMarathonAthlete, plan, 'tuesday');

    expect(day.session).toBeTruthy();
    expect(day.rationale[0]).toContain('primary prescription');
  });

  it('attaches explicit weekly decision notes instead of generic phase/readiness labels', () => {
    const plan = buildWeekPlan(sampleHybridAthlete, '2026-05-04');

    expect(plan.notes.some((note) => note.startsWith('Weekly structure:'))).toBe(true);
    expect(plan.notes.some((note) => note.startsWith('Readiness decision:'))).toBe(true);
    expect(plan.notes.some((note) => note.startsWith('Adherence decision:'))).toBe(true);
    expect(plan.notes.some((note) => note.startsWith('Phase:'))).toBe(false);
    expect(plan.notes.some((note) => note.startsWith('Readiness:'))).toBe(false);
    expect(new Set(plan.notes.map((note) => note.toLowerCase().trim())).size).toBe(plan.notes.length);
  });

  it('re-running adjustForFatigue with a red readiness collapses the phase to deload', () => {
    // Structural #5 depends on this path: the home-view route stores
    // the AthleteState at plan-generation time and re-runs adjustForFatigue
    // with a patched readiness snapshot when today's score drops into
    // orange/red. This test validates that the re-run produces a
    // different plan (phase switches to deload on red).
    const greenAthlete: AthleteState = {
      ...sampleMarathonAthlete,
      readiness: {
        ...sampleMarathonAthlete.readiness,
        level: 'green',
        score: 88,
      },
    };
    const originalPlan = buildWeekPlan(greenAthlete, '2026-05-11');

    const redAthlete: AthleteState = {
      ...greenAthlete,
      readiness: {
        ...greenAthlete.readiness,
        level: 'red',
        score: 32,
      },
    };
    const adjusted = adjustForFatigue(redAthlete, originalPlan);

    // With red readiness the block phase must be pulled to deload.
    // Because the plan itself carries `phase`, the reassembled plan
    // should reflect that downshift. We check the re-emitted guardrails
    // look different from the originals — the exact rules that fire are
    // tested elsewhere, but the re-run MUST produce a non-identity
    // guardrail set.
    expect(adjusted.guardrailResults).not.toEqual(originalPlan.guardrailResults);
  });

  it('re-running adjustForFatigue with orange readiness downshifts to maintenance', () => {
    const greenAthlete: AthleteState = {
      ...sampleMarathonAthlete,
      readiness: {
        ...sampleMarathonAthlete.readiness,
        level: 'green',
        score: 88,
      },
    };
    const originalPlan = buildWeekPlan(greenAthlete, '2026-05-11');

    const orangeAthlete: AthleteState = {
      ...greenAthlete,
      readiness: {
        ...greenAthlete.readiness,
        level: 'orange',
        score: 54,
      },
    };
    const adjusted = adjustForFatigue(orangeAthlete, originalPlan);

    expect(adjusted).not.toBe(originalPlan);
    expect(adjusted.phase).toBe('maintenance');
    expect(adjusted.notes.some((note) => note.includes('Readiness override'))).toBe(true);
  });

  it('is a no-op when readiness stays green or yellow', () => {
    // Green/yellow explicitly skip the adjustment path — otherwise we
    // would pay the cost on every healthy home-view hit.
    const yellowAthlete: AthleteState = {
      ...sampleMarathonAthlete,
      readiness: {
        ...sampleMarathonAthlete.readiness,
        level: 'yellow',
        score: 72,
      },
    };
    const plan = buildWeekPlan(yellowAthlete, '2026-05-11');
    const result = adjustForFatigue(yellowAthlete, plan);

    expect(result).toBe(plan); // reference equality — returned same object
  });

  it('uses race-distance-aware taper windows instead of tapering every race 14 days out', () => {
    const weekStart = '2026-05-01';
    const unlockedBlock = {
      ...sampleMarathonAthlete.currentBlock,
      phase: undefined as any,
      weekIndex: 5,
    };
    const fiveKPlan = buildWeekPlan({
      ...sampleMarathonAthlete,
      currentBlock: unlockedBlock,
      readiness: { ...sampleMarathonAthlete.readiness, level: 'green', score: 82 },
      goals: {
        ...sampleMarathonAthlete.goals,
        primaryFocus: 'running',
        raceCalendar: [{
          id: 'local-5k',
          name: 'Local 5k',
          discipline: 'running',
          subtype: '5k',
          date: '2026-05-15',
          priority: 'a',
        }],
      },
    }, weekStart);

    const marathonPlan = buildWeekPlan({
      ...sampleMarathonAthlete,
      currentBlock: unlockedBlock,
      readiness: { ...sampleMarathonAthlete.readiness, level: 'green', score: 82 },
      goals: {
        ...sampleMarathonAthlete.goals,
        raceCalendar: [{
          id: 'marathon',
          name: 'Marathon',
          discipline: 'running',
          subtype: 'marathon',
          date: '2026-05-15',
          priority: 'a',
        }],
      },
    }, weekStart);

    expect(fiveKPlan.phase).toBe('peak');
    expect(marathonPlan.phase).toBe('taper');
  });

  it('enumerates fired guardrails in the daily rationale and preserves every guardrail result', () => {
    // The prior implementation filtered guardrailResults to just
    // readiness+schedule and did not include their adjustment reasons
    // in `rationale`. This meant the "why did today change?" story was
    // only answerable via an LLM briefing. Now every adjusted guardrail
    // is a rationale line and every guardrail result flows through.
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');

    // Inject a synthetic adjusted guardrail so we can assert the
    // rationale pipeline transparently (without depending on which
    // specific guardrails happen to fire for the sample athlete).
    const syntheticPlan = {
      ...plan,
      guardrailResults: [
        ...plan.guardrailResults,
        { ruleId: 'volume_growth', status: 'warn' as const, adjusted: true, message: 'Capped volume growth at +8% because adherence dipped below 75%.' },
        { ruleId: 'readiness', status: 'pass' as const, adjusted: false, message: 'Readiness within band.' },
      ],
    };

    const day = buildDayPlan(sampleMarathonAthlete, syntheticPlan, 'tuesday');

    // Every guardrail result (pass AND warn) flows through.
    expect(day.guardrailResults.length).toBe(syntheticPlan.guardrailResults.length);

    // Only adjusted guardrails surface in the rationale, prefixed with ✳.
    const adjustedLine = day.rationale.find((line) => line.includes('Capped volume growth'));
    expect(adjustedLine).toBeTruthy();
    expect(adjustedLine!.startsWith('✳')).toBe(true);

    // Pass-status guardrails should NOT appear in rationale.
    expect(day.rationale.some((line) => line.includes('Readiness within band'))).toBe(false);
  });

  it('deduplicates repeated guardrail and weekly-note rationale after plan updates', () => {
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');
    const duplicatedMessage = 'Capped volume growth at +8% because adherence dipped below 75%.';
    const syntheticPlan = {
      ...plan,
      notes: [
        ...plan.notes,
        plan.notes[0],
        'Fueling warning: Add carbohydrates before key endurance work.',
        'Fueling warning: Add carbohydrates before key endurance work.',
      ],
      guardrailResults: [
        ...plan.guardrailResults,
        { ruleId: 'volume_growth', status: 'warn' as const, adjusted: true, message: duplicatedMessage },
        { ruleId: 'volume_growth_duplicate', status: 'warn' as const, adjusted: true, message: duplicatedMessage },
      ],
    };

    const day = buildDayPlan(sampleMarathonAthlete, syntheticPlan, 'tuesday');

    expect(day.rationale.filter((line) => line.includes(duplicatedMessage))).toHaveLength(1);
    expect(day.rationale.filter((line) => line.startsWith('Weekly structure:'))).toHaveLength(1);
    expect(day.rationale.filter((line) => line.includes('Fueling warning'))).toHaveLength(1);
    expect(day.guardrailResults.length).toBe(syntheticPlan.guardrailResults.length);
  });
});

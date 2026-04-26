// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { loadCoachKnowledge } from './knowledge-loader';
import type {
  AthleteState,
  BlockPhase,
  DailyRecommendation,
  Session,
  WeeklyPlan,
} from './types';
import { clamp, findWindowsForDay, resolvePreferredStartTime, withDuration } from './utils';
import { runningEngine } from './engines/running-engine';
import { cyclingEngine } from './engines/cycling-engine';
import { swimmingEngine } from './engines/swimming-engine';
import { strengthEngine } from './engines/strength-engine';
import { triathlonEngine } from './engines/triathlon-engine';
import { resolveHybridPriority } from './engines/hybrid-engine';
import { applyGuardrails } from './guardrails';

function hasHighImpactInjuryConstraint(athlete: AthleteState): boolean {
  return athlete.constraints.some((constraint) =>
    constraint.type === 'injury' && (constraint.severity === 'medium' || constraint.severity === 'high')
  ) || (athlete.readiness.painFlags ?? []).some((pain) => pain.severity === 'moderate' || pain.severity === 'high');
}

function raceWindowDays(race: AthleteState['goals']['raceCalendar'][number]): { taperDays: number; peakDays: number } {
  switch (race.subtype) {
  case '5k':
  case 'sprint':
    return { taperDays: 5, peakDays: 14 };
  case '10k':
  case 'olympic':
    return { taperDays: 7, peakDays: 21 };
  case 'half_marathon':
    return { taperDays: 10, peakDays: 28 };
  case 'marathon':
  case '70.3':
    return { taperDays: 14, peakDays: 35 };
  case 'ironman':
    return { taperDays: 21, peakDays: 56 };
  default:
    if (race.discipline === 'triathlon') return { taperDays: 14, peakDays: 42 };
    if (race.discipline === 'running') return { taperDays: 10, peakDays: 28 };
    return { taperDays: 7, peakDays: 21 };
  }
}

function inferPhase(athlete: AthleteState, weekStart: string): BlockPhase {
  if (hasHighImpactInjuryConstraint(athlete) || athlete.readiness.level === 'red') return 'deload';
  if (athlete.readiness.level === 'orange') return 'maintenance';
  if (athlete.currentBlock.phase) return athlete.currentBlock.phase;

  const nextRace = [...athlete.goals.raceCalendar]
    .map((race) => ({ ...race, diffDays: Math.round((Date.parse(race.date) - Date.parse(weekStart)) / (24 * 60 * 60 * 1000)) }))
    .filter((race) => Number.isFinite(race.diffDays) && race.diffDays >= 0)
    .sort((a, b) => a.diffDays - b.diffDays)[0];

  if (!nextRace) return 'base';
  const windows = raceWindowDays(nextRace);
  if (nextRace.diffDays <= 7) return 'race';
  if (nextRace.diffDays <= windows.taperDays) return 'taper';
  if (nextRace.diffDays <= windows.peakDays) return 'peak';
  if (athlete.currentBlock.weekIndex > 0 && athlete.currentBlock.weekIndex % 4 === 0) return 'deload';
  return 'build';
}

function scheduleSessions(athlete: AthleteState, sessions: Session[]): Session[] {
  return sessions.map((session) => {
    const matchingWindow = findWindowsForDay(athlete.availability, session.dayOfWeek, session.sport)[0]
      ?? findWindowsForDay(athlete.availability, session.dayOfWeek)[0];
    if (!matchingWindow) return session;
    const startTime = resolvePreferredStartTime(athlete, session.sport, matchingWindow);
    return {
      ...session,
      startTime,
      endTime: withDuration(startTime, session.durationMinutes),
    };
  });
}

function reschedulePlanSessions(athlete: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  return {
    ...weeklyPlan,
    sessions: scheduleSessions(athlete, weeklyPlan.sessions),
  };
}

export function buildWeekPlan(athlete: AthleteState, weekStart: string): WeeklyPlan {
  const phase = inferPhase(athlete, weekStart);
  const knowledge = loadCoachKnowledge();
  const context = { athlete, phase, knowledge, weekStart };
  let sessions: Session[] = [];

  if (athlete.goals.primaryFocus === 'triathlon') {
    sessions = triathlonEngine.buildCandidateSessions(context);
  } else if (athlete.goals.primaryFocus === 'hybrid') {
    const hybrid = resolveHybridPriority(athlete, phase);
    const hybridAthlete: AthleteState = {
      ...athlete,
      goals: {
        ...athlete.goals,
        weeklySessionsTarget: {
          ...athlete.goals.weeklySessionsTarget,
          running: hybrid.adjustedRunSessions,
          strength: hybrid.adjustedStrengthSessions,
        },
      },
    };
    sessions = [
      ...runningEngine.buildCandidateSessions({ ...context, athlete: hybridAthlete }),
      ...strengthEngine.buildCandidateSessions({ ...context, athlete: hybridAthlete }),
    ];
  } else {
    if ((athlete.goals.weeklySessionsTarget.running ?? 0) > 0 || athlete.goals.primaryFocus === 'marathon' || athlete.goals.primaryFocus === 'running') {
      sessions.push(...runningEngine.buildCandidateSessions(context));
    }
    if ((athlete.goals.weeklySessionsTarget.cycling ?? 0) > 0 || athlete.goals.primaryFocus === 'cycling') {
      sessions.push(...cyclingEngine.buildCandidateSessions(context));
    }
    if ((athlete.goals.weeklySessionsTarget.swimming ?? 0) > 0 || athlete.goals.primaryFocus === 'swimming') {
      sessions.push(...swimmingEngine.buildCandidateSessions(context));
    }
    if ((athlete.goals.weeklySessionsTarget.strength ?? 0) > 0 || athlete.goals.primaryFocus === 'strength') {
      sessions.push(...strengthEngine.buildCandidateSessions(context));
    }
  }

  sessions = scheduleSessions(athlete, sessions);
  const plan: WeeklyPlan = {
    athleteId: athlete.profile.athleteId,
    weekStart,
    discipline: athlete.goals.primaryFocus,
    phase,
    sessions,
    notes: [
      `Phase: ${phase}`,
      `Readiness: ${athlete.readiness.level}`,
      `Compliance: ${Math.round(athlete.compliance.trailing14DayCompliance * 100)}%`,
    ],
    guardrailResults: [],
  };

  return reschedulePlanSessions(athlete, applyGuardrails(plan, athlete));
}

export function buildDayPlan(athlete: AthleteState, weeklyPlan: WeeklyPlan, dayOfWeek: Session['dayOfWeek']): DailyRecommendation {
  const session = weeklyPlan.sessions.find((item) => item.dayOfWeek === dayOfWeek) ?? null;
  // Preserve ALL guardrails that fired during plan generation so downstream
  // consumers can surface every adjustment reason, not only readiness /
  // schedule. Volume-growth and deload guardrails are just as explanatory
  // for "why is today what it is" — the prior filter silently dropped them.
  const guardrailResults = [...weeklyPlan.guardrailResults];
  const alternatives = session
    ? weeklyPlan.sessions.filter((item) => item.dayOfWeek === dayOfWeek && item.id !== session.id).slice(0, 2)
    : [];

  // Build a rationale list that enumerates every adjusted guardrail so
  // downstream UIs can render "why today changed" without re-querying the
  // LLM briefing. Adjusted guardrails get prefixed with ✳ so renderers
  // can style them distinctly from generic plan notes.
  const adjustedGuardrailMessages = weeklyPlan.guardrailResults
    .filter((result) => result.adjusted && typeof result.message === 'string' && result.message.trim().length > 0)
    .map((result) => `✳ ${result.message}`);

  const baseRationale = session
    ? `Today's primary prescription is ${session.title} because it fits the ${weeklyPlan.phase} phase.`
    : 'No primary session is scheduled for today.';

  return {
    date: `${weeklyPlan.weekStart}:${dayOfWeek}`,
    readinessLevel: athlete.readiness.level,
    session,
    alternatives,
    rationale: [
      baseRationale,
      ...adjustedGuardrailMessages,
      ...weeklyPlan.notes,
    ],
    guardrailResults,
  };
}

export function adjustForFatigue(athlete: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  if (athlete.readiness.level === 'green' || athlete.readiness.level === 'yellow') return weeklyPlan;
  const fatiguePhase: BlockPhase = athlete.readiness.level === 'red' ? 'deload' : 'maintenance';
  const adjustedState: AthleteState = {
    ...athlete,
    currentBlock: {
      ...athlete.currentBlock,
      phase: fatiguePhase,
    },
  };
  const adjustedPlan: WeeklyPlan = {
    ...weeklyPlan,
    phase: fatiguePhase,
    notes: [
      ...weeklyPlan.notes.filter((note) => !note.startsWith('Readiness override:')),
      `Readiness override: ${athlete.readiness.level} shifted this week to ${fatiguePhase}.`,
    ],
  };
  return reschedulePlanSessions(adjustedState, applyGuardrails(adjustedPlan, adjustedState));
}

export function replaceSession(weeklyPlan: WeeklyPlan, sessionId: string, replacement: Session): WeeklyPlan {
  return {
    ...weeklyPlan,
    sessions: weeklyPlan.sessions.map((session) => (session.id === sessionId ? replacement : session)),
  };
}

export function resolveScheduleConflicts(athlete: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  return reschedulePlanSessions(athlete, applyGuardrails(weeklyPlan, athlete));
}

export function progressStrengthBlock(athlete: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  const complianceBoost = athlete.compliance.trailing14DayCompliance >= 0.85 && athlete.readiness.level === 'green';
  if (!complianceBoost) return weeklyPlan;
  return {
    ...weeklyPlan,
    sessions: weeklyPlan.sessions.map((session) => {
      if (session.sport !== 'strength' || !session.exercises || session.sessionType === 'strength_maintenance') return session;
      return {
        ...session,
        exercises: session.exercises.map((exercise) => ({
          ...exercise,
          sets: clamp(exercise.sets + 1, 2, 6),
          rir: exercise.rir != null ? Math.max(1, exercise.rir - 1) : 2,
        })),
      };
    }),
  };
}

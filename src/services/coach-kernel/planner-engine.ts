// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { loadCoachKnowledge } from './knowledge-loader';
import type {
  AthleteState,
  BlockPhase,
  DailyRecommendation,
  GuardrailResult,
  Session,
  TrainingDecisionReason,
  WeeklyPlan,
} from './types';
import { clamp } from './utils';
import { runningEngine } from './engines/running-engine';
import { cyclingEngine } from './engines/cycling-engine';
import { swimmingEngine } from './engines/swimming-engine';
import { strengthEngine } from './engines/strength-engine';
import { triathlonEngine } from './engines/triathlon-engine';
import { resolveHybridPriority } from './engines/hybrid-engine';
import { applyGuardrails } from './guardrails';
import { profileFollowUpNotes } from '../training-profile-model';
import { logger } from '../../utils/logger';
import { buildSecretaryWeeklySummary, buildWeeklyDecisionNotes, dedupeDecisionLines } from './decision-trail';
import { listSecretaryAgendaItems } from '../secretary-scheduling-arbitrator';
import {
  analyzeTrainingFeedback,
  applyFeedbackToAthleteState,
  applyFeedbackToWeeklyPlan,
} from './feedback-analysis';
import { isActiveTrainingSession, reconcileWeeklyCapacity } from './capacity-reconciliation';
import { validateEnduranceCoherence } from './endurance-coherence';

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

/**
 * C8: pull Secretary agenda items for this athlete/week and build the
 * one-line summary that gets woven into weekly decision notes. Wrapped in
 * try/catch so unit tests that don't initialize the Secretary database
 * (no `vi.mock` for `../database`) still pass — `listSecretaryAgendaItems`
 * touches SQLite directly.
 *
 * Returns `null` on any failure or empty result. The notes builder drops
 * the Secretary line entirely when this returns null/empty.
 */
function trySecretaryWeeklySummary(athleteId: number, weekStart: string): string | null {
  try {
    const items = listSecretaryAgendaItems({
      ownerUserId: athleteId,
      // Single-tenant assumption: tenant === ownerUserId. Production
      // multi-tenant callers should pass through `resolveCurrentTenantIdForUser`
      // at the higher layer (training-coach-kernel-plan-generator) before
      // calling buildWeekPlan; this fallback is the safe default.
      tenantId: athleteId,
      includeInactive: true,
    });
    return buildSecretaryWeeklySummary(items, weekStart);
  } catch {
    return null;
  }
}

function reconcilePlanSessions(athlete: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  const reconciliation = reconcileWeeklyCapacity(athlete, weeklyPlan.sessions);
  const guardrailDecisionReasons = decisionReasonsFromGuardrails(weeklyPlan.guardrailResults);
  const candidatePlan: WeeklyPlan = {
    ...weeklyPlan,
    sessions: reconciliation.sessions,
    guardrailResults: [
      ...weeklyPlan.guardrailResults,
      ...reconciliation.guardrailResults,
    ],
    decisionReasons: dedupeDecisionReasons([
      ...(weeklyPlan.decisionReasons ?? []),
      ...guardrailDecisionReasons,
      ...reconciliation.decisionReasons,
    ]),
  };
  const enduranceCoherence = validateEnduranceCoherence(candidatePlan.sessions);
  return {
    ...candidatePlan,
    guardrailResults: [
      ...candidatePlan.guardrailResults,
      ...enduranceCoherence.guardrailResults,
    ],
    decisionReasons: dedupeDecisionReasons([
      ...(candidatePlan.decisionReasons ?? []),
      ...enduranceCoherence.decisionReasons,
    ]),
  };
}

export function buildWeekPlan(athlete: AthleteState, weekStart: string): WeeklyPlan {
  const feedbackAnalysis = analyzeTrainingFeedback(athlete);
  const coachingAthlete = applyFeedbackToAthleteState(athlete, feedbackAnalysis);
  const phase = inferPhase(coachingAthlete, weekStart);
  const knowledge = loadCoachKnowledge();
  const context = { athlete: coachingAthlete, phase, knowledge, weekStart };
  let sessions: Session[] = [];
  const planningNotes: string[] = [];

  if (coachingAthlete.goals.primaryFocus === 'triathlon') {
    sessions = triathlonEngine.buildCandidateSessions(context);
  } else if (coachingAthlete.goals.primaryFocus === 'hybrid') {
    const hybrid = resolveHybridPriority(coachingAthlete, phase);
    planningNotes.push(...hybrid.notes);
    const hybridAthlete: AthleteState = {
      ...coachingAthlete,
      goals: {
        ...coachingAthlete.goals,
        weeklySessionsTarget: {
          ...coachingAthlete.goals.weeklySessionsTarget,
          running: hybrid.adjustedRunSessions,
          cycling: hybrid.adjustedCyclingSessions,
          strength: hybrid.adjustedStrengthSessions,
        },
      },
    };
    if ((hybrid.adjustedRunSessions ?? 0) > 0) {
      sessions.push(...runningEngine.buildCandidateSessions({ ...context, athlete: hybridAthlete }));
    }
    if ((hybrid.adjustedCyclingSessions ?? 0) > 0) {
      sessions.push(...cyclingEngine.buildCandidateSessions({ ...context, athlete: hybridAthlete }));
    }
    if ((hybrid.adjustedStrengthSessions ?? 0) > 0) {
      sessions.push(...strengthEngine.buildCandidateSessions({ ...context, athlete: hybridAthlete }));
    }
  } else {
    if ((coachingAthlete.goals.weeklySessionsTarget.running ?? 0) > 0 || coachingAthlete.goals.primaryFocus === 'marathon' || coachingAthlete.goals.primaryFocus === 'running') {
      sessions.push(...runningEngine.buildCandidateSessions(context));
    }
    if ((coachingAthlete.goals.weeklySessionsTarget.cycling ?? 0) > 0 || coachingAthlete.goals.primaryFocus === 'cycling') {
      sessions.push(...cyclingEngine.buildCandidateSessions(context));
    }
    if ((coachingAthlete.goals.weeklySessionsTarget.swimming ?? 0) > 0 || coachingAthlete.goals.primaryFocus === 'swimming') {
      sessions.push(...swimmingEngine.buildCandidateSessions(context));
    }
    if ((coachingAthlete.goals.weeklySessionsTarget.strength ?? 0) > 0 || coachingAthlete.goals.primaryFocus === 'strength') {
      sessions.push(...strengthEngine.buildCandidateSessions(context));
    }
  }

  const plan: WeeklyPlan = {
    athleteId: coachingAthlete.profile.athleteId,
    weekStart,
    discipline: coachingAthlete.goals.primaryFocus,
    phase,
    sessions,
    notes: [
      ...profileFollowUpNotes(coachingAthlete.profileQuality),
      ...planningNotes,
    ],
    guardrailResults: [],
  };

  const guardedPlan = reconcilePlanSessions(
    coachingAthlete,
    applyGuardrails(applyFeedbackToWeeklyPlan(plan, feedbackAnalysis), coachingAthlete),
  );
  // C8: weave Secretary's weekly contribution into the notes when the
  // agenda store is reachable (production); silently no-op when it isn't
  // (test environments without a mocked DB).
  const secretarySummary = trySecretaryWeeklySummary(coachingAthlete.profile.athleteId, weekStart);
  const finalPlan: WeeklyPlan = {
    ...guardedPlan,
    notes: buildWeeklyDecisionNotes(guardedPlan, coachingAthlete, secretarySummary),
  };

  logger.debug({
    athleteId: finalPlan.athleteId,
    weekStart: finalPlan.weekStart,
    discipline: finalPlan.discipline,
    phase: finalPlan.phase,
    sessionCount: finalPlan.sessions.length,
    activeSessionCount: finalPlan.sessions.filter(isActiveTrainingSession).length,
    adjustedGuardrails: finalPlan.guardrailResults
      .filter((result) => result.adjusted)
      .map((result) => result.ruleId),
    feedbackDecisionCount: feedbackAnalysis.decisions.length,
    decisionNoteCount: finalPlan.notes.length,
  }, 'coach-kernel week plan built');

  return finalPlan;
}

export function buildDayPlan(athlete: AthleteState, weeklyPlan: WeeklyPlan, dayOfWeek: Session['dayOfWeek']): DailyRecommendation {
  const daySessions = weeklyPlan.sessions.filter((item) => item.dayOfWeek === dayOfWeek);
  const session = daySessions.find(isActiveTrainingSession) ?? daySessions[0] ?? null;
  // Preserve ALL guardrails that fired during plan generation so downstream
  // consumers can surface every adjustment reason, not only readiness /
  // schedule. Volume-growth and deload guardrails are just as explanatory
  // for "why is today what it is" — the prior filter silently dropped them.
  const guardrailResults = [...weeklyPlan.guardrailResults];
  const alternatives = session
    ? daySessions.filter((item) => item.id !== session.id && isActiveTrainingSession(item)).slice(0, 2)
    : [];

  // Build a rationale list that enumerates every adjusted guardrail so
  // downstream UIs can render "why today changed" without re-querying the
  // LLM briefing. Adjusted guardrails get prefixed with ✳ so renderers
  // can style them distinctly from generic plan notes.
  const adjustedGuardrailMessages = weeklyPlan.guardrailResults
    .filter((result) => result.adjusted && typeof result.message === 'string' && result.message.trim().length > 0)
    .map((result) => `✳ ${result.message}`);
  const decisionReasonMessages = [
    ...(weeklyPlan.decisionReasons ?? []),
    ...(session?.decisionReasons ?? []),
  ]
    .filter((reason) => reason.severity !== 'info')
    .map((reason) => `✳ ${reason.text}`);

  const baseRationale = session && isActiveTrainingSession(session)
    ? `Today's primary prescription is ${session.title} because it fits the ${weeklyPlan.phase} phase.`
    : session?.scheduleReason
    ? session.scheduleReason
    : 'No primary session is scheduled for today.';

  return {
    date: `${weeklyPlan.weekStart}:${dayOfWeek}`,
    readinessLevel: athlete.readiness.level,
    session,
    alternatives,
    rationale: dedupeDecisionLines([
      baseRationale,
      ...decisionReasonMessages,
      ...adjustedGuardrailMessages,
      ...weeklyPlan.notes,
    ]),
    guardrailResults,
  };
}

function decisionReasonsFromGuardrails(guardrails: GuardrailResult[]): TrainingDecisionReason[] {
  return guardrails.flatMap((guardrail) => guardrail.decisionReasons ?? []);
}

function dedupeDecisionReasons(reasons: TrainingDecisionReason[]): TrainingDecisionReason[] {
  const seen = new Set<string>();
  const output: TrainingDecisionReason[] = [];
  for (const reason of reasons) {
    const key = [
      reason.code,
      reason.affectedEntity.type,
      reason.affectedEntity.id ?? '',
      reason.text.trim().toLowerCase().replace(/\s+/g, ' '),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(reason);
  }
  return output;
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
    notes: dedupeDecisionLines([
      ...weeklyPlan.notes.filter((note) => !note.startsWith('Readiness override:')),
      `Readiness override: ${athlete.readiness.level} shifted this week to ${fatiguePhase}.`,
    ]),
  };
  const guardedPlan = reconcilePlanSessions(adjustedState, applyGuardrails(adjustedPlan, adjustedState));
  const secretarySummary = trySecretaryWeeklySummary(adjustedState.profile.athleteId, weeklyPlan.weekStart);
  const finalPlan: WeeklyPlan = {
    ...guardedPlan,
    notes: buildWeeklyDecisionNotes(guardedPlan, adjustedState, secretarySummary),
  };

  logger.debug({
    athleteId: finalPlan.athleteId,
    readiness: athlete.readiness.level,
    fromPhase: weeklyPlan.phase,
    toPhase: finalPlan.phase,
    adjustedGuardrails: finalPlan.guardrailResults
      .filter((result) => result.adjusted)
      .map((result) => result.ruleId),
    decisionNoteCount: finalPlan.notes.length,
  }, 'coach-kernel fatigue adjustment applied');

  return finalPlan;
}

export function replaceSession(weeklyPlan: WeeklyPlan, sessionId: string, replacement: Session): WeeklyPlan {
  return {
    ...weeklyPlan,
    sessions: weeklyPlan.sessions.map((session) => (session.id === sessionId ? replacement : session)),
  };
}

export function resolveScheduleConflicts(athlete: AthleteState, weeklyPlan: WeeklyPlan): WeeklyPlan {
  return reconcilePlanSessions(athlete, applyGuardrails(weeklyPlan, athlete));
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

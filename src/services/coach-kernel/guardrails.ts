// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, ExercisePrescription, GuardrailResult, Session, TrainingDecisionReason, WeeklyPlan } from './types';
import { loadCoachKnowledge } from './knowledge-loader';
import { trimOverstuffedStrengthSessionToDuration } from './session-coherence';
import { cloneSessions, dayIndex, durationToLoad, isKeyEnduranceSession, isLowerBodyStrength, nextDaysFrom, sumMinutes, DAY_ORDER } from './utils';
import { adaptSessionForPoorRecovery } from './poor-recovery-variation';
import { getVolumeGrowthCap } from './training-principles';

function compareDays(left: string, right: string): number {
  return dayIndex(left as any) - dayIndex(right as any);
}

function scaleSessionDuration(session: Session, factor: number): Session {
  const durationMinutes = Math.max(15, Math.round(session.durationMinutes * factor));
  const scaled = {
    ...session,
    durationMinutes,
    endTime: syncEndTime(session.startTime, durationMinutes),
    plannedLoad: durationToLoad(durationMinutes, session.intensityZone, session.fatigueCost),
  };
  if (session.sport !== 'strength' || durationMinutes >= session.durationMinutes || !session.exercises?.length) {
    return scaled;
  }
  return trimOverstuffedStrengthSessionToDuration(scaled, loadCoachKnowledge(), {
    tag: 'guardrail_duration_coherent',
    alternative: 'Guardrail duration reduction trimmed trailing strength volume so the session matches the shorter slot.',
  }).session;
}

function syncEndTime(startTime: string | undefined, durationMinutes: number): string | undefined {
  if (!startTime || !/^\d{2}:\d{2}$/.test(startTime) || durationMinutes <= 0) return undefined;
  const [hours, minutes] = startTime.split(':').map(Number);
  const totalMinutes = (hours * 60) + minutes + durationMinutes;
  const normalized = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const nextHours = Math.floor(normalized / 60);
  const nextMinutes = normalized % 60;
  return `${String(nextHours).padStart(2, '0')}:${String(nextMinutes).padStart(2, '0')}`;
}

function syncSessionClockFields(session: Session): Session {
  if (session.sessionType === 'rest' || session.durationMinutes <= 0) {
    const { startTime: _startTime, endTime: _endTime, ...rest } = session;
    return rest;
  }

  return {
    ...session,
    endTime: syncEndTime(session.startTime, session.durationMinutes),
  };
}

function sessionReason(args: TrainingDecisionReason): TrainingDecisionReason {
  return args;
}

function techniqueStrengthExercisesForRedReadiness(session: Session): ExercisePrescription[] | undefined {
  const exercises = session.exercises?.slice(0, 2) ?? [];
  if (exercises.length === 0) return undefined;

  return exercises.map((exercise) => ({
    ...exercise,
    sets: Math.min(2, Math.max(1, exercise.sets)),
    reps: normalizeTechniqueReps(exercise.reps),
    rir: Math.max(exercise.rir ?? 0, 4),
    restSec: Math.min(exercise.restSec ?? 45, 45),
    notes: appendTechniqueNote(exercise.notes),
  }));
}

function normalizeTechniqueReps(reps: string): string {
  const lower = reps.toLowerCase();
  if (lower.includes('sec') || lower.includes('hold') || lower.includes('m')) return reps;
  if (lower.includes('each') || lower.includes('per side') || lower.includes('per leg') || lower.includes('per arm')) {
    return '6-8 each side';
  }
  return '6-8';
}

function appendTechniqueNote(notes: string | undefined): string {
  const techniqueNote = 'Technique only: light load, smooth tempo, stop far from failure.';
  if (!notes || notes.trim().length === 0) return techniqueNote;
  if (notes.includes(techniqueNote)) return notes;
  return `${notes} ${techniqueNote}`;
}

function enforceVolumeGrowth(plan: WeeklyPlan, athlete: AthleteState): GuardrailResult[] {
  const results: GuardrailResult[] = [];
  const knowledge = loadCoachKnowledge();
  const limits: Record<'running' | 'cycling' | 'swimming' | 'strength', number> = {
    running: (getVolumeGrowthCap(knowledge.principles, 'running') ?? 8) / 100,
    cycling: (getVolumeGrowthCap(knowledge.principles, 'cycling') ?? 12) / 100,
    swimming: (getVolumeGrowthCap(knowledge.principles, 'swimming') ?? 15) / 100,
    strength: (getVolumeGrowthCap(knowledge.principles, 'strength') ?? 10) / 100,
  };

  for (const [sport, cap] of Object.entries(limits)) {
    const sportKey = sport as keyof typeof athlete.trainingHistory.lastWeekMinutesBySport;
    const previous = athlete.trainingHistory.lastWeekMinutesBySport[sportKey] ?? 0;
    const baseline = postDeloadVolumeBaseline(athlete, sport as keyof typeof limits, previous);
    const planned = sumMinutes(plan.sessions, sport as any);
    if (baseline <= 0 || planned <= baseline * (1 + cap)) {
      results.push({
        ruleId: `volume_growth_${sport}`,
        status: 'pass',
        message: `${sport} weekly volume remains inside the safe growth cap.`,
        metadata: { previous, baseline },
      });
      continue;
    }

    const allowed = Math.round(baseline * (1 + cap));
    const factor = allowed / planned;
    plan.sessions = plan.sessions.map((session) => {
      if (session.sport !== sport) return session;
      return scaleSessionDuration(session, factor);
    });

    let remaining = sumMinutes(plan.sessions, sport as any) - allowed;
    if (remaining > 0) {
      const candidateIndexes = plan.sessions
        .map((session, index) => ({ session, index }))
        .filter(({ session }) => session.sport === sport)
        .sort((left, right) => right.session.durationMinutes - left.session.durationMinutes);
      for (const { session, index } of candidateIndexes) {
        if (remaining <= 0) break;
        const reducible = Math.min(remaining, Math.max(0, session.durationMinutes - 15));
        if (reducible <= 0) continue;
        const nextDuration = session.durationMinutes - reducible;
        plan.sessions[index] = {
          ...session,
          durationMinutes: nextDuration,
          plannedLoad: durationToLoad(nextDuration, session.intensityZone, session.fatigueCost),
        };
        remaining -= reducible;
      }
    }

    results.push({
      ruleId: `volume_growth_${sport}`,
      status: 'warn',
      adjusted: true,
      message: `${sport} volume jumped too quickly (${planned}min vs ${baseline}min). Non-key volume was trimmed to ${allowed}min.`,
      metadata: { previous, baseline, planned, allowed },
      decisionReasons: [sessionReason({
        code: 'volume_growth_trimmed',
        text: `${sport} volume was reduced from ${planned} to ${allowed} minutes because the recent baseline was ${baseline} minutes and the safe growth cap was exceeded.`,
        severity: 'warning',
        affectedEntity: { type: 'week' },
        sourceConstraint: { type: 'volume', label: `${sport} weekly growth cap` },
        before: { previousMinutes: previous, baselineMinutes: baseline, plannedMinutes: planned },
        after: { allowedMinutes: allowed },
        preservedIntent: 'Preserved the week structure while trimming non-key volume first.',
        evidence: [`previous_minutes=${previous}`, `baseline_minutes=${baseline}`, `planned_minutes=${planned}`, `allowed_minutes=${allowed}`],
      })],
    });
  }

  return results;
}

function postDeloadVolumeBaseline(
  athlete: AthleteState,
  sport: 'running' | 'cycling' | 'swimming' | 'strength',
  previous: number,
): number {
  const lastDeloadWeekIndex = athlete.currentBlock.lastDeloadWeekIndex;
  const isFirstPostDeloadWeek = typeof lastDeloadWeekIndex === 'number'
    && athlete.currentBlock.weekIndex === lastDeloadWeekIndex + 1;
  if (!isFirstPostDeloadWeek) return previous;

  const trailing = athlete.trainingHistory.trailing4WeekMinutesBySport[sport] ?? [];
  const lastTrailing = trailing[trailing.length - 1];
  const trailingMatchesPrevious = typeof lastTrailing === 'number'
    && Number.isFinite(lastTrailing)
    && Math.abs(lastTrailing - previous) <= Math.max(5, previous * 0.1);
  if (!trailingMatchesPrevious) return previous;

  const recentBaseline = Math.max(previous, ...trailing.filter((value) => Number.isFinite(value) && value > 0));
  if (previous > recentBaseline * 0.75) return previous;
  return Number.isFinite(recentBaseline) && recentBaseline > 0 ? recentBaseline : previous;
}

function enforceDeload(plan: WeeklyPlan, athlete: AthleteState): GuardrailResult[] {
  const shouldDeload = plan.phase === 'deload'
    || athlete.compliance.trailing14DayCompliance < 0.7
    || athlete.readiness.level === 'red'
    || athlete.readiness.painFlags.some((flag) => flag.severity !== 'low');

  if (!shouldDeload) {
    return [{
      ruleId: 'deload',
      status: 'pass',
      message: 'No deload trigger detected this week.',
    }];
  }

  plan.phase = 'deload';
  plan.sessions = plan.sessions.map((session) => {
    if (session.sessionType === 'rest') return session;
    if (session.keySession && session.sport !== 'strength') {
      return scaleSessionDuration({
        ...session,
        title: session.sessionType === 'long_run' ? 'Reduced Long Run' : `Reduced ${session.title}`,
      }, 0.75);
    }
    return scaleSessionDuration(session, 0.7);
  });

  return [{
    ruleId: 'deload',
    status: 'warn',
    adjusted: true,
    message: 'Deload triggered by block timing, compliance, readiness, or pain flags. Weekly volume and intensity were reduced.',
    decisionReasons: [sessionReason({
      code: 'recovery_volume_reduced',
      text: 'Weekly volume and intensity were reduced because deload, compliance, readiness, or pain signals called for a lower-stress week.',
      severity: 'warning',
      affectedEntity: { type: 'week' },
      sourceConstraint: { type: 'recovery', label: 'deload/readiness guardrail' },
      before: { phase: plan.phase },
      after: { phase: 'deload' },
      preservedIntent: 'Preserved training rhythm while reducing fatigue risk.',
      evidence: [
        `readiness=${athlete.readiness.level}/${athlete.readiness.score}`,
        `compliance=${athlete.compliance.trailing14DayCompliance}`,
        `pain_flags=${athlete.readiness.painFlags.length}`,
      ],
    })],
  }];
}

function enforceReadiness(plan: WeeklyPlan, athlete: AthleteState): GuardrailResult[] {
  if (athlete.readiness.level === 'green' || athlete.readiness.level === 'yellow') {
    return [{
      ruleId: 'readiness',
      status: 'pass',
      message: 'Readiness supports the planned week.',
    }];
  }

  const red = athlete.readiness.level === 'red';
  const adaptationMessages: string[] = [];
  const scenarioCounts: Record<string, number> = {};
  const originalSessions = cloneSessions(plan.sessions);

  plan.sessions = plan.sessions.map((session, sessionIndex) => {
    if (!shouldAdaptSessionForReadiness(session, red)) return session;
    if (red || session.fatigueCost === 'high' || session.fatigueCost === 'very_high' || session.keySession) {
      const adaptation = adaptSessionForPoorRecovery({
        athlete,
        session,
        weekSessions: originalSessions,
        sessionIndex,
      });
      adaptationMessages.push(adaptation.explanation);
      scenarioCounts[adaptation.scenario] = (scenarioCounts[adaptation.scenario] ?? 0) + 1;
      return {
        ...adaptation.session,
        exercises: adaptation.session.sport !== 'strength'
          ? adaptation.session.exercises
          : adaptation.session.sessionType === 'mobility'
            ? adaptation.session.exercises
            : techniqueStrengthExercisesForRedReadiness(session),
      };
    }

    const reduced = scaleSessionDuration(session, 0.75);
    return {
      ...reduced,
      title: reduced.sessionType === 'threshold_run' || reduced.sessionType === 'interval_run'
        ? 'Aerobic Support Run'
        : reduced.title,
      description: 'Readiness is low enough that the session was downgraded to preserve recovery while keeping rhythm.',
      intensityZone: reduced.intensityZone === 'vo2' || reduced.intensityZone === 'threshold' ? 'aerobic' : reduced.intensityZone,
      fatigueCost: reduced.fatigueCost === 'very_high' ? 'medium' : reduced.fatigueCost,
      keySession: false,
      plannedLoad: durationToLoad(reduced.durationMinutes, reduced.intensityZone === 'vo2' || reduced.intensityZone === 'threshold' ? 'aerobic' : reduced.intensityZone, reduced.fatigueCost === 'very_high' ? 'medium' : reduced.fatigueCost),
      tags: [...reduced.tags.filter((tag) => !tag.startsWith('key_')), 'readiness_adjusted'],
    };
  });

  return [{
    ruleId: 'readiness',
    status: red ? 'block' : 'warn',
    adjusted: true,
    message: red
      ? 'Readiness is critically low. Hard work was replaced with varied low-fatigue recovery, technique, or mobility options.'
      : 'Readiness is strained. High-stress work was downgraded before prescription, with recovery variants used where fatigue risk was high.',
    decisionReasons: [sessionReason({
      code: red ? 'recovery_volume_reduced' : 'recovery_intensity_reduced',
      text: red
        ? 'Hard work was replaced with low-fatigue recovery, technique, or mobility options because readiness is critically low.'
        : 'High-stress work was downgraded before prescription because recovery signals are strained.',
      severity: red ? 'block' : 'warning',
      affectedEntity: { type: 'week' },
      sourceConstraint: { type: 'recovery', label: `${athlete.readiness.level} readiness` },
      before: { readiness: athlete.readiness.level, score: athlete.readiness.score },
      after: { recoveryScenarios: scenarioCounts },
      preservedIntent: 'Preserved weekly continuity while reducing recovery risk.',
      evidence: [
        `readiness=${athlete.readiness.level}/${athlete.readiness.score}`,
        `adapted_sessions=${adaptationMessages.length}`,
      ],
    })],
    metadata: {
      recoveryScenarios: scenarioCounts,
      examples: adaptationMessages.slice(0, 4),
    },
  }];
}

function shouldAdaptSessionForReadiness(session: Session, red: boolean): boolean {
  if (session.sessionType === 'rest' || session.durationMinutes <= 0) return false;
  if (red) return session.sport === 'strength' || session.keySession || session.fatigueCost !== 'low';
  return session.sport === 'strength'
    || session.keySession
    || session.fatigueCost === 'high'
    || session.fatigueCost === 'very_high';
}

function moveSessionToSaferDay(plan: WeeklyPlan, session: Session, blockedDays: Set<string>): Session {
  for (const candidateDay of nextDaysFrom(session.dayOfWeek)) {
    if (!blockedDays.has(candidateDay)) {
      return { ...session, dayOfWeek: candidateDay };
    }
  }
  return session;
}

function enforceInterference(plan: WeeklyPlan): GuardrailResult[] {
  const results: GuardrailResult[] = [];
  const sessions = cloneSessions(plan.sessions).sort((a, b) => compareDays(a.dayOfWeek, b.dayOfWeek));
  const keyDays = new Set(sessions.filter(isKeyEnduranceSession).map((session) => session.dayOfWeek));

  plan.sessions = sessions.map((session) => {
    if (!isLowerBodyStrength(session)) return session;
    const previousDay = nextDaysFrom(session.dayOfWeek)[6];
    const nextDay = nextDaysFrom(session.dayOfWeek)[1];
    if (keyDays.has(session.dayOfWeek) || keyDays.has(previousDay) || keyDays.has(nextDay)) {
      results.push({
        ruleId: `interference_${session.id}`,
        status: 'warn',
        adjusted: true,
        message: `${session.title} conflicted with a key endurance day and was moved or softened.`,
        decisionReasons: [sessionReason({
          code: 'interference_reflowed',
          text: `${session.title} was moved or softened because it conflicted with a key endurance day.`,
          severity: 'warning',
          affectedEntity: {
            type: 'session',
            id: session.id,
            title: session.title,
            dayOfWeek: session.dayOfWeek,
          },
          sourceConstraint: { type: 'interference', label: 'key endurance spacing' },
          before: { dayOfWeek: session.dayOfWeek, sessionType: session.sessionType },
          after: { protectedDays: [...keyDays] },
          preservedIntent: 'Protected the key endurance session while keeping lower-body support work feasible.',
          evidence: [`key_days=${[...keyDays].join(',')}`, `session_day=${session.dayOfWeek}`],
        })],
      });
      const moved = moveSessionToSaferDay(plan, session, new Set([session.dayOfWeek, previousDay, nextDay]));
      if (moved.dayOfWeek !== session.dayOfWeek) return moved;
      return {
        ...session,
        sessionType: 'strength_maintenance',
        title: 'Strength Maintenance + Core',
        fatigueCost: 'low',
        durationMinutes: 35,
        endTime: syncEndTime(session.startTime, 35),
        plannedLoad: durationToLoad(35, 'aerobic', 'low'),
        tags: ['maintenance', 'core'],
      };
    }
    return session;
  });

  if (results.length === 0) {
    return [{
      ruleId: 'interference',
      status: 'pass',
      message: 'No lower-body strength interference with key endurance sessions was detected.',
    }];
  }

  return results;
}

function enforceScheduleConflicts(plan: WeeklyPlan, athlete: AthleteState): GuardrailResult[] {
  const results: GuardrailResult[] = [];
  const maxTotalSessions = DAY_ORDER.length * athlete.availability.maxSessionsPerDay;
  if (plan.sessions.length > maxTotalSessions) {
    const sorted = [...plan.sessions].sort((left, right) => {
      const leftPriority = Number(left.keySession) * 10 + (left.sport === 'strength' ? 0 : 1);
      const rightPriority = Number(right.keySession) * 10 + (right.sport === 'strength' ? 0 : 1);
      return rightPriority - leftPriority;
    });
    const kept = sorted.slice(0, maxTotalSessions);
    const dropped = sorted.slice(maxTotalSessions);
    if (dropped.length > 0) {
      results.push({
        ruleId: 'schedule_density_trim',
        status: 'warn',
        adjusted: true,
        message: `Schedule density exceeded the weekly limit, so ${dropped.length} low-priority sessions were dropped or deferred.`,
        decisionReasons: [sessionReason({
          code: 'schedule_density_trimmed',
          text: `${dropped.length} low-priority session${dropped.length === 1 ? '' : 's'} were dropped or deferred because the weekly session limit was ${maxTotalSessions}.`,
          severity: 'warning',
          affectedEntity: { type: 'week' },
          sourceConstraint: { type: 'capacity', label: 'weekly session density' },
          before: { plannedSessions: plan.sessions.length },
          after: { keptSessions: kept.length, droppedSessions: dropped.length },
          preservedIntent: 'Preserved higher-priority and key sessions first.',
          evidence: [`max_sessions=${maxTotalSessions}`, `dropped=${dropped.map((session) => session.id).join(',')}`],
        })],
        metadata: { droppedSessionIds: dropped.map((session) => session.id) },
      });
    }
    plan.sessions = kept;
  }

  const dayCounts = plan.sessions.reduce<Record<string, number>>((acc, session) => {
    acc[session.dayOfWeek] = (acc[session.dayOfWeek] ?? 0) + 1;
    return acc;
  }, {});

  plan.sessions = plan.sessions.map((session) => {
    const immovableKey = session.keySession && session.sessionType !== 'brick';
    if ((dayCounts[session.dayOfWeek] ?? 0) <= athlete.availability.maxSessionsPerDay || immovableKey) {
      return session;
    }

    const targetDay = nextDaysFrom(session.dayOfWeek).find((candidateDay) => (dayCounts[candidateDay] ?? 0) < athlete.availability.maxSessionsPerDay);
    if (targetDay) {
      dayCounts[session.dayOfWeek] -= 1;
      dayCounts[targetDay] = (dayCounts[targetDay] ?? 0) + 1;
      results.push({
        ruleId: `schedule_conflict_${session.id}`,
        status: 'warn',
        adjusted: true,
        message: `${session.title} was moved to ${targetDay} to respect session density and time windows.`,
        decisionReasons: [sessionReason({
          code: 'session_reflowed',
          text: `${session.title} moved from ${session.dayOfWeek} to ${targetDay} to respect session density and time windows.`,
          severity: 'notice',
          affectedEntity: {
            type: 'session',
            id: session.id,
            title: session.title,
            dayOfWeek: targetDay,
          },
          sourceConstraint: { type: 'capacity', label: 'max sessions per day' },
          before: { dayOfWeek: session.dayOfWeek },
          after: { dayOfWeek: targetDay },
          preservedIntent: `Preserved the ${session.sport} ${session.sessionType.replace(/_/g, ' ')} intent.`,
          evidence: [`max_sessions_per_day=${athlete.availability.maxSessionsPerDay}`],
        })],
      });
      return { ...session, dayOfWeek: targetDay };
    }

    dayCounts[session.dayOfWeek] -= 1;
    results.push({
      ruleId: `schedule_conflict_${session.id}`,
      status: 'block',
      adjusted: true,
      message: `${session.title} could not be placed safely and was deferred instead of creating a standalone mobility session.`,
      decisionReasons: [sessionReason({
        code: 'low_priority_deferred',
        text: `${session.title} was deferred because no safe session-density slot remained.`,
        severity: 'block',
        affectedEntity: {
          type: 'session',
          id: session.id,
          title: session.title,
          dayOfWeek: session.dayOfWeek,
        },
        sourceConstraint: { type: 'capacity', label: 'max sessions per day' },
        before: { dayOfWeek: session.dayOfWeek, sessionType: session.sessionType },
        after: { scheduleState: 'deferred', sessionType: 'rest' },
        preservedIntent: 'Avoided creating a misleading standalone session when the week had no safe capacity.',
        evidence: [`max_sessions_per_day=${athlete.availability.maxSessionsPerDay}`],
      })],
    });
    return {
      ...session,
      sessionType: 'rest' as const,
      title: 'Rest / Recovery',
      intensityZone: 'recovery' as const,
      fatigueCost: 'low' as const,
      durationMinutes: 0,
      endTime: undefined,
      plannedLoad: 0,
      tags: ['deferred'],
    };
  }).filter((session) => !(session.durationMinutes <= 0 && session.tags.includes('deferred')));

  return results.length > 0
    ? results
    : [{
      ruleId: 'schedule_conflicts',
      status: 'pass',
      message: 'No unresolved schedule conflicts were detected.',
    }];
}

export function applyGuardrails(plan: WeeklyPlan, athlete: AthleteState): WeeklyPlan {
  const nextPlan: WeeklyPlan = {
    ...plan,
    sessions: cloneSessions(plan.sessions),
    notes: [...plan.notes],
    guardrailResults: [],
  };

  nextPlan.guardrailResults.push(...enforceVolumeGrowth(nextPlan, athlete));
  nextPlan.guardrailResults.push(...enforceDeload(nextPlan, athlete));
  nextPlan.guardrailResults.push(...enforceReadiness(nextPlan, athlete));
  nextPlan.guardrailResults.push(...enforceInterference(nextPlan));
  nextPlan.guardrailResults.push(...enforceScheduleConflicts(nextPlan, athlete));
  nextPlan.sessions = nextPlan.sessions.map(syncSessionClockFields);
  return nextPlan;
}

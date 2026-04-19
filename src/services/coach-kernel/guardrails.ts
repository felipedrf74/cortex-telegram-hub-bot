// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, GuardrailResult, Session, WeeklyPlan } from './types';
import { cloneSessions, dayIndex, durationToLoad, isKeyEnduranceSession, isLowerBodyStrength, nextDaysFrom, sumMinutes, DAY_ORDER } from './utils';

function compareDays(left: string, right: string): number {
  return dayIndex(left as any) - dayIndex(right as any);
}

function scaleSessionDuration(session: Session, factor: number): Session {
  const durationMinutes = Math.max(15, Math.round(session.durationMinutes * factor));
  return {
    ...session,
    durationMinutes,
    endTime: syncEndTime(session.startTime, durationMinutes),
    plannedLoad: durationToLoad(durationMinutes, session.intensityZone, session.fatigueCost),
  };
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

function redReadyReplacementSessionType(session: Session): Session['sessionType'] {
  if (session.sport === 'strength') return 'mobility';
  if (session.sport === 'cycling') return 'recovery_ride';
  if (session.sport === 'swimming') return 'recovery_swim';
  return 'recovery_run';
}

function redReadyReplacementTitle(session: Session): string {
  if (session.sport === 'strength') return 'Mobility / Tissue Care';
  if (session.sport === 'cycling') return 'Recovery Ride';
  if (session.sport === 'swimming') return 'Recovery Swim';
  return 'Recovery Run';
}

function enforceVolumeGrowth(plan: WeeklyPlan, athlete: AthleteState): GuardrailResult[] {
  const results: GuardrailResult[] = [];
  const limits: Record<string, number> = {
    running: 0.08,
    cycling: 0.12,
    swimming: 0.15,
    strength: 0.1,
  };

  for (const [sport, cap] of Object.entries(limits)) {
    const previous = athlete.trainingHistory.lastWeekMinutesBySport[sport as keyof typeof athlete.trainingHistory.lastWeekMinutesBySport] ?? 0;
    const planned = sumMinutes(plan.sessions, sport as any);
    if (previous <= 0 || planned <= previous * (1 + cap)) {
      results.push({
        ruleId: `volume_growth_${sport}`,
        status: 'pass',
        message: `${sport} weekly volume remains inside the safe growth cap.`,
      });
      continue;
    }

    const allowed = Math.round(previous * (1 + cap));
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
      message: `${sport} volume jumped too quickly (${planned}min vs ${previous}min). Non-key volume was trimmed to ${allowed}min.`,
      metadata: { previous, planned, allowed },
    });
  }

  return results;
}

function enforceDeload(plan: WeeklyPlan, athlete: AthleteState): GuardrailResult[] {
  const shouldDeload = plan.phase === 'deload'
    || (athlete.currentBlock.phase === 'build' && athlete.currentBlock.weekIndex % 4 === 0)
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
  plan.sessions = plan.sessions.map((session) => {
    if (!isKeyEnduranceSession(session) && session.sport !== 'strength') return session;
    if (red) {
      const replacementSessionType = redReadyReplacementSessionType(session);
      const replacementDuration = Math.max(20, Math.round(session.durationMinutes * 0.5));
      return {
        ...session,
        sessionType: replacementSessionType,
        title: redReadyReplacementTitle(session),
        description: 'Readiness is too low for the original prescription. Replace with recovery-focused work or full rest.',
        intensityZone: 'recovery',
        fatigueCost: 'low',
        keySession: false,
        durationMinutes: replacementDuration,
        plannedLoad: durationToLoad(replacementDuration, 'recovery', 'low'),
        tags: [...session.tags.filter((tag) => tag !== 'key_run' && tag !== 'key_ride'), 'readiness_adjusted'],
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
      ? 'Readiness is critically low. Hard work was replaced with recovery or mobility.'
      : 'Readiness is strained. Hard work was downgraded before prescription.',
  }];
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
      });
      return { ...session, dayOfWeek: targetDay };
    }

    dayCounts[session.dayOfWeek] -= 1;
    results.push({
      ruleId: `schedule_conflict_${session.id}`,
      status: 'block',
      adjusted: true,
      message: `${session.title} could not be placed safely and was replaced by mobility.`,
    });
    return {
      ...session,
      sessionType: 'mobility',
      title: 'Mobility / Reset',
      sport: 'strength',
      intensityZone: 'recovery',
      fatigueCost: 'low',
      durationMinutes: 20,
      endTime: syncEndTime(session.startTime, 20),
      plannedLoad: durationToLoad(20, 'recovery', 'low'),
      tags: ['mobility'],
    };
  });

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

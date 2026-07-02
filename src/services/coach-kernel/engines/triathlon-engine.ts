// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, Sport, TrainingDecisionReason } from '../types';
import { DAY_ORDER, createSessionId, durationToLoad } from '../utils';
import { runningEngine } from './running-engine';
import { cyclingEngine } from './cycling-engine';
import { swimmingEngine } from './swimming-engine';
import { strengthEngine } from './strength-engine';
import { attachTrainingSessionRole } from '../endurance-session-classifier';

function availableDaysForSport(context: EngineContext, sport: Sport): DayOfWeek[] {
  const days = DAY_ORDER.filter((day) =>
    context.athlete.availability.weeklyWindows.some((window) =>
      window.dayOfWeek === day && (!window.sports || window.sports.includes(sport))
    )
  );
  return days.length > 0 ? days : DAY_ORDER;
}

function canPlaceTriathlonSession(session: Session, placed: readonly Session[], maxSessionsPerDay: number): boolean {
  if (placed.length >= maxSessionsPerDay) return false;
  if (placed.some((item) => item.sport === session.sport && session.sessionType !== 'brick')) return false;
  if (session.sessionType === 'brick') {
    return placed.length === 1 && placed.some((item) => item.sport === 'cycling' && item.tags.includes('long_session'));
  }
  if (placed.some((item) => item.sessionType === 'brick')) return false;
  if (session.keySession && placed.some((item) => item.keySession)) return false;
  return true;
}

function retagSessionDay(session: Session, dayOfWeek: DayOfWeek): Session {
  if (session.dayOfWeek === dayOfWeek) return session;
  return {
    ...session,
    id: createSessionId(session.sport, dayOfWeek, session.title),
    dayOfWeek,
    tags: [...new Set([...(session.tags ?? []), 'triathlon_day_deduped'])],
  };
}

function placementRank(session: Session): number {
  if (session.sport === 'cycling' && session.tags.includes('long_session')) return 0;
  if (session.sessionType === 'brick') return 1;
  if (session.keySession) return 2;
  if (session.sport === 'strength') return 4;
  return 3;
}

function isHighIntensityTriathlonKey(session: Session): boolean {
  return session.keySession && ['threshold', 'vo2', 'neuromuscular'].includes(session.intensityZone);
}

function aerobicSessionTypeForSport(session: Session): Session['sessionType'] {
  if (session.sport === 'cycling') return 'endurance_ride';
  if (session.sport === 'swimming') return 'aerobic_swim';
  return 'easy_run';
}

function softenForTriathlonSpacing(session: Session): Session {
  const reason: TrainingDecisionReason = {
    code: 'interference_reflowed',
    text: `${session.title} was softened to aerobic support to avoid stacking hard triathlon sessions on consecutive days.`,
    severity: 'notice',
    affectedEntity: {
      type: 'session',
      id: session.id,
      title: session.title,
      dayOfWeek: session.dayOfWeek,
    },
    sourceConstraint: {
      type: 'interference',
      id: 'triathlon-hard-day-spacing',
      label: 'Triathlon hard-day spacing',
    },
    before: {
      intensityZone: session.intensityZone,
      fatigueCost: session.fatigueCost,
      keySession: session.keySession,
    },
    after: {
      intensityZone: 'aerobic',
      fatigueCost: 'medium',
      keySession: false,
    },
    preservedIntent: 'Kept multisport frequency while protecting recovery between quality sessions.',
  };
  return {
    ...session,
    sessionType: aerobicSessionTypeForSport(session),
    title: `${session.sport[0].toUpperCase()}${session.sport.slice(1)} Aerobic Support`,
    description: `Aerobic support work replacing ${session.title} so quality days are not stacked back-to-back.`,
    intensityZone: 'aerobic',
    fatigueCost: 'medium',
    keySession: false,
    plannedLoad: durationToLoad(session.durationMinutes, 'aerobic', 'medium'),
    tags: [...new Set([...session.tags, 'triathlon_spacing_softened', 'aerobic_support'])],
    decisionReasons: [...(session.decisionReasons ?? []), reason],
    intensityProfile: undefined,
    intensitySummary: {
      primaryZone: 'aerobic',
      lowPct: 1,
      moderatePct: 0,
      highPct: 0,
      targetSummaryText: `${session.durationMinutes}min aerobic support.`,
    },
  };
}

function softenConsecutiveTriathlonIntensity(sessions: readonly Session[]): Session[] {
  let lastHighIntensityDay: number | null = null;
  return sessions.map((session) => {
    const dayIndex = DAY_ORDER.indexOf(session.dayOfWeek);
    if (!isHighIntensityTriathlonKey(session) || dayIndex < 0) return session;
    if (lastHighIntensityDay !== null && Math.abs(dayIndex - lastHighIntensityDay) <= 1) {
      return softenForTriathlonSpacing(session);
    }
    lastHighIntensityDay = dayIndex;
    return session;
  });
}

function spreadTriathlonSessions(context: EngineContext, sessions: readonly Session[]): Session[] {
  const maxSessionsPerDay = Math.max(1, context.athlete.availability.maxSessionsPerDay ?? 2);
  const byDay = new Map<DayOfWeek, Session[]>();
  const placed: Session[] = [];
  const ordered = [...sessions].sort((left, right) => placementRank(left) - placementRank(right));

  for (const session of ordered) {
    const candidateDays = [
      session.dayOfWeek,
      ...availableDaysForSport(context, session.sport),
      ...DAY_ORDER,
    ].filter((day, index, all) => all.indexOf(day) === index);
    const day = candidateDays.find((candidate) =>
      canPlaceTriathlonSession(session, byDay.get(candidate) ?? [], maxSessionsPerDay)
    ) ?? session.dayOfWeek;
    const nextSession = retagSessionDay(session, day);
    const daySessions = byDay.get(day) ?? [];
    daySessions.push(nextSession);
    byDay.set(day, daySessions);
    placed.push(nextSession);
  }

  return placed;
}

export const triathlonEngine: SportEngine = {
  buildCandidateSessions(context: EngineContext): Session[] {
    // Explicit user asks (goals.weeklySessionsTargetExplicit) are consumed
    // verbatim — the engine must not re-clamp what the user dialed in.
    // Auto-derived targets arrive as the constraint layer's legacy floors
    // and are expanded here to the triathlon viability bands (3-4 runs,
    // 2-3 rides/swims), matching the historical default plan shape.
    const explicit = context.athlete.goals.weeklySessionsTargetExplicit ?? {};
    const targets = context.athlete.goals.weeklySessionsTarget;
    const runningTarget = explicit.running
      ? (targets.running ?? 3)
      : Math.max(3, Math.min(4, targets.running ?? 3));
    const cyclingTarget = explicit.cycling
      ? (targets.cycling ?? 2)
      : Math.max(2, Math.min(3, targets.cycling ?? 2));
    const swimmingTarget = explicit.swimming
      ? (targets.swimming ?? 2)
      : Math.max(2, Math.min(3, targets.swimming ?? 2));
    const runs = runningEngine.buildCandidateSessions({
      ...context,
      athlete: {
        ...context.athlete,
        goals: {
          ...context.athlete.goals,
          weeklySessionsTarget: {
            ...context.athlete.goals.weeklySessionsTarget,
            running: runningTarget,
          },
        },
      },
    });
    const rides = cyclingEngine.buildCandidateSessions({
      ...context,
      athlete: {
        ...context.athlete,
        goals: {
          ...context.athlete.goals,
          weeklySessionsTarget: {
            ...context.athlete.goals.weeklySessionsTarget,
            cycling: cyclingTarget,
          },
        },
      },
    });
    const swims = swimmingEngine.buildCandidateSessions({
      ...context,
      athlete: {
        ...context.athlete,
        goals: {
          ...context.athlete.goals,
          weeklySessionsTarget: {
            ...context.athlete.goals.weeklySessionsTarget,
            swimming: swimmingTarget,
          },
        },
      },
    });
    const requestedStrength = context.athlete.goals.weeklySessionsTarget.strength ?? 0;
    const strength = requestedStrength > 0
      ? strengthEngine.buildCandidateSessions({
          ...context,
          athlete: {
            ...context.athlete,
            goals: {
              ...context.athlete.goals,
              strengthGoal: context.athlete.goals.strengthGoal ?? 'maintenance',
              weeklySessionsTarget: {
                ...context.athlete.goals.weeklySessionsTarget,
                strength: requestedStrength,
              },
            },
          },
        })
      : [];

    const includeBrick = context.phase !== 'taper' && context.phase !== 'race';
    const longRide = rides.find((session) => session.tags.includes('long_session'));
    const brickDay = longRide?.dayOfWeek ?? rides.find((session) => session.tags.includes('key_ride'))?.dayOfWeek ?? 'saturday';
    const brick: Session[] = includeBrick
      ? [attachTrainingSessionRole({
          id: createSessionId('brick', brickDay, 'Brick Run'),
          sport: 'running',
          sessionType: 'brick',
          title: 'Brick Run',
          description: 'Short transition run off the bike to rehearse race mechanics.',
          dayOfWeek: brickDay,
          durationMinutes: 20,
          intensityZone: 'aerobic',
          fatigueCost: 'medium',
          keySession: true,
          plannedLoad: durationToLoad(20, 'aerobic', 'medium'),
          intensityProfile: {
            primaryZone: 'aerobic',
            segments: [{
              role: 'steady',
              modality: 'running',
              durationSec: 20 * 60,
              targetZone: 'aerobic',
            }],
            intensityDistribution: { aerobic: 1 },
          },
          intensitySummary: {
            primaryZone: 'aerobic',
            lowPct: 1,
            moderatePct: 0,
            highPct: 0,
            targetSummaryText: '20min easy transition run off the bike.',
          },
          tags: ['brick', 'triathlon_specific'],
          alternatives: ['Swap for easy run the following day'],
        })]
      : [];

    return softenConsecutiveTriathlonIntensity(spreadTriathlonSessions(context, [...runs, ...rides, ...swims, ...strength, ...brick]));
  },
};

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, Sport } from '../types';
import { DAY_ORDER, createSessionId, durationToLoad } from '../utils';
import { runningEngine } from './running-engine';
import { cyclingEngine } from './cycling-engine';
import { swimmingEngine } from './swimming-engine';
import { strengthEngine } from './strength-engine';

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
    const runs = runningEngine.buildCandidateSessions({
      ...context,
      athlete: {
        ...context.athlete,
        goals: {
          ...context.athlete.goals,
          weeklySessionsTarget: {
            ...context.athlete.goals.weeklySessionsTarget,
            running: Math.max(3, Math.min(4, context.athlete.goals.weeklySessionsTarget.running ?? 3)),
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
            cycling: Math.max(2, Math.min(3, context.athlete.goals.weeklySessionsTarget.cycling ?? 2)),
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
            swimming: Math.max(2, Math.min(3, context.athlete.goals.weeklySessionsTarget.swimming ?? 2)),
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
                strength: Math.min(2, requestedStrength),
              },
            },
          },
        })
      : [];

    const includeBrick = context.phase !== 'taper' && context.phase !== 'race';
    const longRide = rides.find((session) => session.tags.includes('long_session'));
    const brickDay = longRide?.dayOfWeek ?? rides.find((session) => session.tags.includes('key_ride'))?.dayOfWeek ?? 'saturday';
    const brick: Session[] = includeBrick
      ? [{
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
          tags: ['brick', 'triathlon_specific'],
          alternatives: ['Swap for easy run the following day'],
        }]
      : [];

    return spreadTriathlonSessions(context, [...runs, ...rides, ...swims, ...strength, ...brick]);
  },
};

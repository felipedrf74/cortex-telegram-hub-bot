// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { Session } from '../types';
import { createSessionId, durationToLoad } from '../utils';
import { runningEngine } from './running-engine';
import { cyclingEngine } from './cycling-engine';
import { swimmingEngine } from './swimming-engine';

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

    const bikeDay = rides.find((session) => session.tags.includes('key_ride'))?.dayOfWeek ?? 'saturday';
    const brick: Session = {
      id: createSessionId('brick', bikeDay, 'Brick Run'),
      sport: 'running',
      sessionType: 'brick',
      title: 'Brick Run',
      description: 'Short transition run off the bike to rehearse race mechanics.',
      dayOfWeek: bikeDay,
      durationMinutes: 20,
      intensityZone: 'aerobic',
      fatigueCost: 'medium',
      keySession: true,
      plannedLoad: durationToLoad(20, 'aerobic', 'medium'),
      tags: ['brick', 'triathlon_specific'],
      alternatives: ['Swap for easy run the following day'],
    };

    return [...runs, ...rides, ...swims, brick];
  },
};


// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';

function templateFor(templates: WorkoutTemplate[], sessionType: SessionType): WorkoutTemplate {
  const match = templates.find((template) => template.sessionType === sessionType);
  if (!match) throw new Error(`Missing cycling template for ${sessionType}`);
  return match;
}

function buildRideSession(template: WorkoutTemplate, dayOfWeek: DayOfWeek, durationMinutes: number, tags: string[]): Session {
  return {
    id: createSessionId('ride', dayOfWeek, template.title),
    sport: 'cycling',
    sessionType: template.sessionType,
    title: template.title,
    description: template.instructions.join(' '),
    dayOfWeek,
    durationMinutes,
    intensityZone: template.primaryZone,
    fatigueCost: template.fatigueCost,
    keySession: template.keySession,
    plannedLoad: durationToLoad(durationMinutes, template.primaryZone, template.fatigueCost),
    sourceTemplateId: template.id,
    tags,
    alternatives: ['Swap for indoor endurance ride', 'Swap for short aerobic spin'],
  };
}

export const cyclingEngine: SportEngine = {
  buildCandidateSessions(context: EngineContext): Session[] {
    const templates = context.knowledge.workoutTemplates.filter((template) => template.sport === 'cycling');
    const targetSessions = clamp(context.athlete.goals.weeklySessionsTarget.cycling ?? 3, 1, 5);
    const previousMinutes = context.athlete.trainingHistory.lastWeekMinutesBySport.cycling ?? 150;
    const targetMinutes = Math.round(previousMinutes * (context.phase === 'deload' ? 0.78 : context.phase === 'taper' ? 0.7 : 1.05));
    const longRideMinutes = clamp(Math.round(targetMinutes * 0.4), 90, 240);
    const keyMinutes = clamp(Math.round(targetMinutes * 0.22), 45, 75);
    const fillerMinutes = clamp(Math.round((targetMinutes - longRideMinutes - keyMinutes) / Math.max(1, targetSessions - 2)), 40, 75);

    const sessions: Session[] = [
      buildRideSession(templateFor(templates, 'threshold_ride'), 'wednesday', keyMinutes, ['key_ride']),
      buildRideSession(templateFor(templates, 'endurance_ride'), 'saturday', longRideMinutes, ['long_session']),
    ];

    const fillerDays: DayOfWeek[] = ['monday', 'friday', 'thursday'];
    for (const dayOfWeek of fillerDays) {
      if (sessions.length >= targetSessions) break;
      sessions.push(buildRideSession(templateFor(templates, 'recovery_ride'), dayOfWeek, fillerMinutes, ['support_ride']));
    }

    return sessions;
  },
};


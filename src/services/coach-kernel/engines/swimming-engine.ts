// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';

function templateFor(templates: WorkoutTemplate[], sessionType: SessionType): WorkoutTemplate {
  const match = templates.find((template) => template.sessionType === sessionType);
  if (!match) throw new Error(`Missing swimming template for ${sessionType}`);
  return match;
}

function buildSwimSession(template: WorkoutTemplate, dayOfWeek: DayOfWeek, durationMinutes: number, tags: string[]): Session {
  return {
    id: createSessionId('swim', dayOfWeek, template.title),
    sport: 'swimming',
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
    alternatives: ['Swap for technique swim', 'Swap for short aerobic swim'],
  };
}

export const swimmingEngine: SportEngine = {
  buildCandidateSessions(context: EngineContext): Session[] {
    const templates = context.knowledge.workoutTemplates.filter((template) => template.sport === 'swimming');
    const targetSessions = clamp(context.athlete.goals.weeklySessionsTarget.swimming ?? 2, 1, 4);
    const sessions: Session[] = [
      buildSwimSession(templateFor(templates, 'technique_swim'), 'monday', 45, ['technique_focus']),
    ];

    if (targetSessions >= 2) {
      sessions.push(buildSwimSession(templateFor(templates, 'threshold_swim'), 'thursday', 55, ['key_swim']));
    }
    if (targetSessions >= 3) {
      sessions.push(buildSwimSession(templateFor(templates, 'aerobic_swim'), 'saturday', 50, ['aerobic_swim']));
    }
    if (targetSessions >= 4) {
      sessions.push(buildSwimSession(templateFor(templates, 'recovery_swim'), 'friday', 35, ['recovery_swim']));
    }

    return sessions;
  },
};


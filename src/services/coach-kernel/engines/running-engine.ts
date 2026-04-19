// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';

function templateFor(templates: WorkoutTemplate[], sessionType: SessionType): WorkoutTemplate {
  const match = templates.find((template) => template.sessionType === sessionType);
  if (!match) throw new Error(`Missing running template for ${sessionType}`);
  return match;
}

function buildRunSession(
  template: WorkoutTemplate,
  dayOfWeek: DayOfWeek,
  durationMinutes: number,
  tags: string[],
): Session {
  return {
    id: createSessionId('run', dayOfWeek, template.title),
    sport: 'running',
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
    alternatives: ['Swap for aerobic support run', 'Swap for mobility and strides'],
  };
}

export const runningEngine: SportEngine = {
  buildCandidateSessions(context: EngineContext): Session[] {
    const templates = context.knowledge.workoutTemplates.filter((template) => template.sport === 'running');
    const targetSessions = clamp(context.athlete.goals.weeklySessionsTarget.running ?? 4, 2, 7);
    const previousMinutes = context.athlete.trainingHistory.lastWeekMinutesBySport.running ?? 180;
    const phaseMultiplier = context.phase === 'taper' ? 0.7 : context.phase === 'peak' ? 1.05 : context.phase === 'deload' ? 0.75 : 1;
    const targetMinutes = Math.round(previousMinutes * phaseMultiplier);
    const longRunMinutes = clamp(Math.round(targetMinutes * (context.phase === 'peak' ? 0.32 : 0.28)), 70, 170);
    const keyMinutes = clamp(Math.round(targetMinutes * 0.18), 30, 70);
    const remainingMinutes = Math.max(targetMinutes - longRunMinutes - keyMinutes, 40);
    const fillerMinutes = Math.max(30, Math.round(remainingMinutes / Math.max(1, targetSessions - 2)));
    const longRunDay = context.athlete.availability.preferredLongSessionDay ?? 'sunday';
    const keyTemplate = context.phase === 'peak'
      ? templateFor(templates, 'threshold_run')
      : templateFor(templates, 'interval_run');

    const sessions: Session[] = [
      buildRunSession(keyTemplate, 'tuesday', keyMinutes, ['key_run']),
      buildRunSession(templateFor(templates, 'long_run'), longRunDay, longRunMinutes, ['long_session']),
    ];

    const fillerDays: DayOfWeek[] = ['monday', 'thursday', 'friday', 'saturday', 'wednesday'];
    for (const dayOfWeek of fillerDays) {
      if (sessions.length >= targetSessions) break;
      const template = sessions.length === targetSessions - 1
        ? templateFor(templates, 'recovery_run')
        : templateFor(templates, 'easy_run');
      const duration = template.sessionType === 'recovery_run'
        ? Math.max(25, fillerMinutes - 10)
        : fillerMinutes;
      if (!sessions.find((session) => session.dayOfWeek === dayOfWeek)) {
        sessions.push(buildRunSession(template, dayOfWeek, duration, ['support_run']));
      }
    }

    return sessions;
  },
};


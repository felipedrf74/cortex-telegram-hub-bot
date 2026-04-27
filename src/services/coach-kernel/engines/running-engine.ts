// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';
import { pickAvailableDays, pickKeyDay } from '../availability-day-picker';

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

    // Slice 4.F — availability-aware key-day pick. When the user has
    // declared availability for running, pick the first day in the
    // canonical preference list where they have a window. Falls back
    // to 'tuesday' (the legacy default) when the user has no
    // availability data — preserving the pre-slice-4.F behavior for
    // brand-new users.
    const keyDayPreferences: DayOfWeek[] = ['tuesday', 'wednesday', 'thursday', 'monday', 'friday'];
    const keyDay = pickKeyDay(context.athlete, 'running', keyDayPreferences);

    const sessions: Session[] = [
      buildRunSession(keyTemplate, keyDay, keyMinutes, ['key_run']),
      buildRunSession(templateFor(templates, 'long_run'), longRunDay, longRunMinutes, ['long_session']),
    ];

    // Slice 4.F — filler days now respect availability windows too.
    // We pass the legacy hardcoded order as preferences; the picker
    // drops days the user can't run on (returning the legacy order
    // when not enough days have windows, so a fully-busy week still
    // produces a session list and the scheduler can attempt slotting).
    const fillerPreferences: DayOfWeek[] = ['monday', 'thursday', 'friday', 'saturday', 'wednesday'];
    const fillerDays = pickAvailableDays(context.athlete, 'running', fillerPreferences, 3);
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


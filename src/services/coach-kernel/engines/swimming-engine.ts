// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';
import { pickKeyDay } from '../availability-day-picker';

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

    // Slice 4.F — availability-aware day picks. The pre-slice
    // engine hardcoded monday/thursday/saturday/friday with no
    // pool-availability check; with this change a user who can
    // only access the pool Tue/Thu/Sat gets sessions on those
    // days. Each pickKeyDay pass excludes already-used days via
    // the preference list ordering so sessions don't collide.
    const techniquePreferences: DayOfWeek[] = ['monday', 'tuesday', 'wednesday'];
    const keyPreferences: DayOfWeek[] = ['thursday', 'wednesday', 'tuesday', 'friday'];
    const aerobicPreferences: DayOfWeek[] = ['saturday', 'sunday', 'friday'];
    const recoveryPreferences: DayOfWeek[] = ['friday', 'sunday', 'wednesday'];

    const usedDays = new Set<DayOfWeek>();
    const pickFresh = (prefs: DayOfWeek[]): DayOfWeek => {
      const available = prefs.filter((day) => !usedDays.has(day));
      const pick = pickKeyDay(context.athlete, 'swimming', available.length > 0 ? available : prefs);
      usedDays.add(pick);
      return pick;
    };

    const sessions: Session[] = [
      buildSwimSession(templateFor(templates, 'technique_swim'), pickFresh(techniquePreferences), 45, ['technique_focus']),
    ];

    if (targetSessions >= 2) {
      sessions.push(buildSwimSession(templateFor(templates, 'threshold_swim'), pickFresh(keyPreferences), 55, ['key_swim']));
    }
    if (targetSessions >= 3) {
      sessions.push(buildSwimSession(templateFor(templates, 'aerobic_swim'), pickFresh(aerobicPreferences), 50, ['aerobic_swim']));
    }
    if (targetSessions >= 4) {
      sessions.push(buildSwimSession(templateFor(templates, 'recovery_swim'), pickFresh(recoveryPreferences), 35, ['recovery_swim']));
    }

    return sessions;
  },
};


// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';
import { pickKeyDay } from '../availability-day-picker';
import { attachTrainingSessionRole } from '../endurance-session-classifier';
import { attachSessionIntensityMetadata } from '../session-intensity-metadata';

function templateFor(templates: WorkoutTemplate[], sessionType: SessionType): WorkoutTemplate {
  const match = templates.find((template) => template.sessionType === sessionType);
  if (!match) throw new Error(`Missing swimming template for ${sessionType}`);
  return match;
}

function buildSwimSession(
  template: WorkoutTemplate,
  dayOfWeek: DayOfWeek,
  durationMinutes: number,
  tags: string[],
  athleteProfile: EngineContext['athlete']['profile'],
): Session {
  return attachTrainingSessionRole(attachSessionIntensityMetadata({
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
  }, template, athleteProfile), template);
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
      buildSwimSession(templateFor(templates, 'technique_swim'), pickFresh(techniquePreferences), 45, ['technique_focus'], context.athlete.profile),
    ];

    if (targetSessions >= 2) {
      const keyType: SessionType = context.phase === 'peak' && context.athlete.profile.experienceLevel !== 'novice'
        ? 'speed_swim'
        : 'threshold_swim';
      sessions.push(buildSwimSession(templateFor(templates, keyType), pickFresh(keyPreferences), keyType === 'speed_swim' ? 45 : 55, ['key_swim'], context.athlete.profile));
    }
    if (targetSessions >= 3) {
      sessions.push(buildSwimSession(templateFor(templates, 'aerobic_swim'), pickFresh(aerobicPreferences), 50, ['aerobic_swim'], context.athlete.profile));
    }
    if (targetSessions >= 4) {
      sessions.push(buildSwimSession(templateFor(templates, 'recovery_swim'), pickFresh(recoveryPreferences), 35, ['recovery_swim'], context.athlete.profile));
    }

    return sessions;
  },
};

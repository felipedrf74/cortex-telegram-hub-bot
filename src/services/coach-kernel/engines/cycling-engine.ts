// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';
import { pickAvailableDays, pickKeyDay } from '../availability-day-picker';
import { applyVolumeGrowthCapForSport } from '../training-principles';

function templateFor(templates: WorkoutTemplate[], sessionType: SessionType): WorkoutTemplate {
  const match = templates.find((template) => template.sessionType === sessionType);
  if (!match) throw new Error(`Missing cycling template for ${sessionType}`);
  return match;
}

function templateByIdOrType(templates: WorkoutTemplate[], templateId: string, fallbackType: SessionType): WorkoutTemplate {
  return templates.find((template) => template.id === templateId) ?? templateFor(templates, fallbackType);
}

function constraintText(context: EngineContext): string {
  return [
    ...(context.athlete.equipment.notes ?? []),
    ...context.athlete.constraints.map((constraint) => constraint.description),
  ].join(' ').toLowerCase();
}

function isTravelOrLimitedWeek(context: EngineContext): boolean {
  return /travel|hotel|trip|limited equipment|away/.test(constraintText(context));
}

function hasHybridStrengthPressure(context: EngineContext): boolean {
  return context.athlete.goals.primaryFocus === 'hybrid'
    && (context.athlete.goals.weeklySessionsTarget.strength ?? 0) >= 2;
}

function hasLowRecoverySignal(context: EngineContext): boolean {
  return context.athlete.readiness.level === 'orange'
    || context.athlete.readiness.level === 'red'
    || context.athlete.readiness.soreness === 'high';
}

function cyclingPhaseVolumeMultiplier(phase: EngineContext['phase']): number {
  if (phase === 'deload') return 0.78;
  if (phase === 'race') return 0.6;
  if (phase === 'taper') return 0.7;
  if (phase === 'maintenance') return 1;
  return 1.05;
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

function keyRideTemplateFor(context: EngineContext, templates: WorkoutTemplate[]): WorkoutTemplate {
  const weekSlot = Math.max(0, context.athlete.currentBlock.weekIndex - 1) % 3;
  if (isTravelOrLimitedWeek(context)) {
    return templateByIdOrType(templates, 'ride_endurance_short', 'endurance_ride');
  }
  if (context.phase === 'peak') {
    return weekSlot === 0
      ? templateByIdOrType(templates, 'ride_vo2_over_under', 'vo2_ride')
      : templateFor(templates, 'threshold_ride');
  }
  if (weekSlot === 0) return templateFor(templates, 'threshold_ride');
  if (weekSlot === 1) return templateByIdOrType(templates, 'ride_tempo_sweet_spot', 'tempo_ride');
  return templateByIdOrType(templates, 'ride_vo2_over_under', 'vo2_ride');
}

function supportRideTemplateFor(
  context: EngineContext,
  templates: WorkoutTemplate[],
  supportIndex: number,
  finalSupport: boolean,
): WorkoutTemplate {
  if (isTravelOrLimitedWeek(context)) return templateByIdOrType(templates, 'ride_travel_hotel_spin', 'recovery_ride');
  if (hasLowRecoverySignal(context)) return templateFor(templates, 'recovery_ride');
  if (hasHybridStrengthPressure(context)) return templateByIdOrType(templates, 'ride_hybrid_flush', 'recovery_ride');
  if (finalSupport) return templateFor(templates, 'recovery_ride');
  if (supportIndex % 2 === 0) return templateByIdOrType(templates, 'ride_cadence_technique', 'recovery_ride');
  return templateFor(templates, 'recovery_ride');
}

export const cyclingEngine: SportEngine = {
  buildCandidateSessions(context: EngineContext): Session[] {
    const templates = context.knowledge.workoutTemplates.filter((template) => template.sport === 'cycling');
    const targetSessions = clamp(context.athlete.goals.weeklySessionsTarget.cycling ?? 3, 1, 5);
    const previousMinutes = context.athlete.trainingHistory.lastWeekMinutesBySport.cycling ?? 150;
    // Slice A1a — activate training-principles.json volume growth cap.
    // Build/peak can grow modestly, maintenance holds, and taper/race
    // reduce volume rather than accidentally growing into event week.
    const cyclingPhaseTarget = Math.round(previousMinutes * cyclingPhaseVolumeMultiplier(context.phase));
    const targetMinutes = applyVolumeGrowthCapForSport(
      context.knowledge.principles,
      'cycling',
      previousMinutes,
      cyclingPhaseTarget,
    );

    // Slice 4.F — availability-aware day picks. Falls back to the
    // canonical legacy defaults when the user has no availability
    // declared (brand-new user case, no behavior change there).
    const keyDayPreferences: DayOfWeek[] = ['wednesday', 'tuesday', 'thursday', 'monday', 'friday'];
    const longDayPreferences: DayOfWeek[] = ['saturday', 'sunday'];
    const keyDay = pickKeyDay(context.athlete, 'cycling', keyDayPreferences);
    const longDay = pickKeyDay(context.athlete, 'cycling', longDayPreferences);

    if (targetSessions === 1) {
      const template = context.phase === 'deload' || context.phase === 'race' || context.phase === 'taper'
        ? templateFor(templates, 'recovery_ride')
        : templateFor(templates, 'endurance_ride');
      const duration = clamp(Math.round(targetMinutes), 45, template.sessionType === 'recovery_ride' ? 75 : 180);
      return [buildRideSession(template, longDay, duration, ['single_ride', template.id])];
    }

    const longRideMinutes = clamp(Math.round(targetMinutes * 0.4), 90, 240);
    const keyMinutes = clamp(Math.round(targetMinutes * 0.22), 45, 75);
    const fillerMinutes = clamp(Math.round((targetMinutes - longRideMinutes - keyMinutes) / Math.max(1, targetSessions - 2)), 40, 75);

    const keyTemplate = keyRideTemplateFor(context, templates);
    const sessions: Session[] = [
      buildRideSession(keyTemplate, keyDay, keyMinutes, ['key_ride', keyTemplate.id]),
      buildRideSession(templateFor(templates, 'endurance_ride'), longDay, longRideMinutes, ['long_session']),
    ];

    const fillerPreferences: DayOfWeek[] = ['monday', 'friday', 'thursday'];
    const fillerDays = pickAvailableDays(context.athlete, 'cycling', fillerPreferences, fillerPreferences.length);
    for (const [supportIndex, dayOfWeek] of fillerDays.entries()) {
      if (sessions.length >= targetSessions) break;
      if (sessions.find((session) => session.dayOfWeek === dayOfWeek)) continue;
      const template = supportRideTemplateFor(context, templates, supportIndex, sessions.length === targetSessions - 1);
      sessions.push(buildRideSession(template, dayOfWeek, fillerMinutes, ['support_ride', template.id]));
    }

    return sessions;
  },
};

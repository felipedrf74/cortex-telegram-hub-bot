// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { DayOfWeek, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';
import { pickAvailableDays, pickKeyDay } from '../availability-day-picker';
import { applyVolumeGrowthCapForSport } from '../training-principles';

function templateFor(templates: WorkoutTemplate[], sessionType: SessionType): WorkoutTemplate {
  const match = templates.find((template) => template.sessionType === sessionType);
  if (!match) throw new Error(`Missing running template for ${sessionType}`);
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

function runningPhaseVolumeMultiplier(phase: EngineContext['phase']): number {
  if (phase === 'deload') return 0.75;
  if (phase === 'taper') return 0.7;
  if (phase === 'peak') return 1.05;
  return 1;
}

function uniqueDays(days: DayOfWeek[]): DayOfWeek[] {
  return [...new Set(days)];
}

function isPrimaryEnduranceRunningContext(context: EngineContext): boolean {
  return context.athlete.goals.primaryFocus === 'running'
    || context.athlete.goals.primaryFocus === 'marathon'
    || context.athlete.goals.primaryFocus === 'hybrid'
    || context.athlete.goals.primaryFocus === 'triathlon';
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

function buildSupportOnlyRunSessions(context: EngineContext, templates: WorkoutTemplate[], requestedRunning: number): Session[] {
  const targetSessions = clamp(requestedRunning, 1, 3);
  const previousMinutes = context.athlete.trainingHistory.lastWeekMinutesBySport.running ?? targetSessions * 40;
  const phaseMultiplier = runningPhaseVolumeMultiplier(context.phase);
  // Slice A1a — activate training-principles.json volume growth cap.
  // The principles file specifies `volumeGrowthCapsPct.running = 8`,
  // so a build week cannot grow more than 8% over the prior week.
  // This is a defensive ceiling: deload/taper multipliers reduce
  // volume (the cap doesn't apply); only build/peak weeks bind.
  const phaseTarget = Math.round(previousMinutes * phaseMultiplier);
  const cappedTarget = applyVolumeGrowthCapForSport(
    context.knowledge.principles,
    'running',
    previousMinutes,
    phaseTarget,
  );
  const targetMinutes = Math.max(targetSessions * 25, cappedTarget);
  const baseMinutes = clamp(Math.round(targetMinutes / targetSessions), 25, 50);
  const dayPreferences: DayOfWeek[] = ['tuesday', 'thursday', 'saturday', 'monday', 'friday', 'wednesday', 'sunday'];
  const days = pickAvailableDays(context.athlete, 'running', dayPreferences, targetSessions);
  const sessions: Session[] = [];

  for (const [supportIndex, dayOfWeek] of days.entries()) {
    if (sessions.length >= targetSessions) break;
    const template = supportRunTemplateFor(context, templates, supportIndex, sessions.length === targetSessions - 1);
    const duration = template.sessionType === 'recovery_run'
      ? Math.max(25, baseMinutes - 5)
      : baseMinutes;
    sessions.push(buildRunSession(template, dayOfWeek, duration, ['aerobic_support', 'support_run', template.id]));
  }

  return sessions;
}

function keyRunTemplateFor(context: EngineContext, templates: WorkoutTemplate[]): WorkoutTemplate {
  const weekSlot = Math.max(0, context.athlete.currentBlock.weekIndex - 1) % 3;
  if (context.athlete.profile.experienceLevel === 'novice') {
    return templateByIdOrType(templates, 'run_fartlek_controlled', 'easy_run');
  }
  if (context.phase === 'peak') {
    return templateByIdOrType(templates, weekSlot === 0 ? 'run_threshold' : 'run_interval', 'threshold_run');
  }
  if (context.phase === 'base') {
    return templateByIdOrType(templates, weekSlot === 2 ? 'run_hill_repeats' : 'run_tempo_progression', 'threshold_run');
  }
  if (weekSlot === 0) return templateByIdOrType(templates, 'run_interval', 'interval_run');
  if (weekSlot === 1) return templateByIdOrType(templates, 'run_tempo_progression', 'threshold_run');
  return templateByIdOrType(templates, 'run_hill_repeats', 'interval_run');
}

function supportRunTemplateFor(
  context: EngineContext,
  templates: WorkoutTemplate[],
  supportIndex: number,
  finalSupport: boolean,
): WorkoutTemplate {
  if (isTravelOrLimitedWeek(context)) return templateByIdOrType(templates, 'run_travel_treadmill_easy', 'easy_run');
  if (context.athlete.profile.experienceLevel === 'novice') {
    return templateByIdOrType(templates, 'run_walk_beginner', 'easy_run');
  }
  if (hasLowRecoverySignal(context)) return templateFor(templates, 'recovery_run');
  if (hasHybridStrengthPressure(context) && supportIndex % 2 === 0) {
    return templateByIdOrType(templates, 'run_hybrid_flush', 'recovery_run');
  }
  if (finalSupport) return templateFor(templates, 'recovery_run');
  if (supportIndex % 2 === 1) return templateByIdOrType(templates, 'run_strides_aerobic', 'easy_run');
  return templateFor(templates, 'easy_run');
}

export const runningEngine: SportEngine = {
  buildCandidateSessions(context: EngineContext): Session[] {
    const templates = context.knowledge.workoutTemplates.filter((template) => template.sport === 'running');
    const explicitRunningTarget = context.athlete.goals.weeklySessionsTarget.running;
    if (!isPrimaryEnduranceRunningContext(context) && explicitRunningTarget && explicitRunningTarget > 0) {
      return buildSupportOnlyRunSessions(context, templates, explicitRunningTarget);
    }

    const requestedRunning = explicitRunningTarget ?? 4;
    const targetSessions = clamp(requestedRunning, 1, 7);
    const previousMinutes = context.athlete.trainingHistory.lastWeekMinutesBySport.running ?? 180;
    const phaseMultiplier = runningPhaseVolumeMultiplier(context.phase);
    // Slice A1a — apply principles.json volume-growth cap. With cap=8
    // and previousMinutes=200, even a peak-phase 1.05× multiplier
    // (planned 210) stays under the ceiling (216); the cap binds only
    // when phaseMultiplier > 1 AND the planned value exceeds the cap.
    const phaseTarget = Math.round(previousMinutes * phaseMultiplier);
    const targetMinutes = applyVolumeGrowthCapForSport(
      context.knowledge.principles,
      'running',
      previousMinutes,
      phaseTarget,
    );
    const longRunDayPreferences = uniqueDays([
      context.athlete.availability.preferredLongSessionDay ?? 'sunday',
      'sunday',
      'saturday',
      'friday',
      'monday',
    ]);
    const longRunDay = pickKeyDay(context.athlete, 'running', longRunDayPreferences);
    if (targetSessions === 1) {
      const template = context.phase === 'deload'
        ? templateFor(templates, 'recovery_run')
        : templateFor(templates, 'long_run');
      const duration = clamp(Math.round(targetMinutes), 30, template.sessionType === 'long_run' ? 120 : 50);
      return [buildRunSession(template, longRunDay, duration, ['single_run', template.id])];
    }
    const longRunMinutes = clamp(Math.round(targetMinutes * (context.phase === 'peak' ? 0.32 : 0.28)), 70, 170);
    const keyMinutes = clamp(Math.round(targetMinutes * 0.18), 30, 70);
    const remainingMinutes = Math.max(targetMinutes - longRunMinutes - keyMinutes, 40);
    const fillerMinutes = Math.max(30, Math.round(remainingMinutes / Math.max(1, targetSessions - 2)));
    const keyTemplate = keyRunTemplateFor(context, templates);

    // Slice 4.F — availability-aware key-day pick. When the user has
    // declared availability for running, pick the first day in the
    // canonical preference list where they have a window. Falls back
    // to 'tuesday' (the legacy default) when the user has no
    // availability data — preserving the pre-slice-4.F behavior for
    // brand-new users.
    const keyDayPreferenceOrder: DayOfWeek[] = ['tuesday', 'wednesday', 'thursday', 'monday', 'friday', 'saturday', 'sunday'];
    const keyDayPreferences = keyDayPreferenceOrder.filter((day) => day !== longRunDay);
    const keyDay = pickKeyDay(context.athlete, 'running', keyDayPreferences);

    const sessions: Session[] = [
      buildRunSession(keyTemplate, keyDay, keyMinutes, ['key_run', keyTemplate.id]),
      buildRunSession(templateFor(templates, 'long_run'), longRunDay, longRunMinutes, ['long_session']),
    ];

    // Slice 4.F — filler days now respect availability windows too.
    // We pass the legacy hardcoded order as preferences; the picker
    // drops days the user can't run on (returning the legacy order
    // when not enough days have windows, so a fully-busy week still
    // produces a session list and the scheduler can attempt slotting).
    const fillerPreferences: DayOfWeek[] = ['monday', 'thursday', 'friday', 'saturday', 'wednesday'];
    const fillerDays = pickAvailableDays(context.athlete, 'running', fillerPreferences, 3);
    let supportIndex = 0;
    for (const dayOfWeek of fillerDays) {
      if (sessions.length >= targetSessions) break;
      if (sessions.find((session) => session.dayOfWeek === dayOfWeek)) continue;
      const template = supportRunTemplateFor(context, templates, supportIndex, sessions.length === targetSessions - 1);
      const duration = template.sessionType === 'recovery_run'
        ? Math.max(25, fillerMinutes - 10)
        : fillerMinutes;
      sessions.push(buildRunSession(template, dayOfWeek, duration, ['support_run', template.id]));
      supportIndex += 1;
    }

    return sessions;
  },
};

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { CoachingDiscipline, DayOfWeek, SessionType } from './coach-kernel/types';
import type { TrainingPlanMode } from './training-workout-capability-registry';

export const TRAINING_M4_PLAN_STRATEGY_VERSION = 'training-m4-plan-strategy.v1' as const;

export type TrainingEventSubtype =
  | 'running_race'
  | 'marathon'
  | 'cycling_event'
  | 'open_water_swim'
  | 'triathlon'
  | 'hybrid_event';

export interface TrainingM4ResourceAccess {
  pool: boolean;
  bicycle: boolean;
  indoorTrainer: boolean;
  safeRunEnvironment: boolean;
  outdoorRideEnvironment: boolean;
}

export interface TrainingM4CapacityWindow {
  dayOfWeek: DayOfWeek;
  startTime: string;
  endTime: string;
  timezone: string;
  allowedDisciplines?: CoachingDiscipline[];
}

export interface TrainingM4GoalPriority {
  primaryDiscipline: CoachingDiscipline;
  secondaryDisciplines: CoachingDiscipline[];
}

const MODE_ARCHETYPES: Readonly<Record<TrainingPlanMode, Readonly<Record<CoachingDiscipline, readonly SessionType[]>>>> = {
  event_based: {
    running: ['easy_run', 'long_run', 'threshold_run', 'interval_run', 'recovery_run', 'strength_maintenance', 'mobility'],
    marathon: ['easy_run', 'long_run', 'threshold_run', 'recovery_run', 'strength_maintenance', 'mobility', 'interval_run'],
    cycling: ['endurance_ride', 'threshold_ride', 'tempo_ride', 'recovery_ride', 'strength_maintenance', 'mobility', 'vo2_ride'],
    swimming: ['technique_swim', 'aerobic_swim', 'threshold_swim', 'recovery_swim', 'strength_maintenance', 'mobility', 'speed_swim'],
    strength: ['strength_max', 'strength_maintenance', 'mobility', 'strength_hypertrophy', 'mobility', 'strength_maintenance', 'mobility'],
    triathlon: ['technique_swim', 'endurance_ride', 'easy_run', 'brick', 'strength_maintenance', 'mobility', 'recovery_run'],
    hybrid: ['easy_run', 'strength_hypertrophy', 'threshold_run', 'strength_maintenance', 'mobility', 'endurance_ride', 'recovery_run'],
  },
  continuous: {
    running: ['easy_run', 'long_run', 'threshold_run', 'recovery_run', 'strength_maintenance', 'mobility', 'interval_run'],
    marathon: ['easy_run', 'long_run', 'threshold_run', 'recovery_run', 'strength_maintenance', 'mobility', 'interval_run'],
    cycling: ['endurance_ride', 'tempo_ride', 'threshold_ride', 'recovery_ride', 'strength_maintenance', 'mobility', 'vo2_ride'],
    swimming: ['technique_swim', 'aerobic_swim', 'threshold_swim', 'recovery_swim', 'strength_maintenance', 'mobility', 'speed_swim'],
    strength: ['strength_hypertrophy', 'strength_maintenance', 'mobility', 'strength_hypertrophy', 'mobility', 'strength_maintenance', 'mobility'],
    triathlon: ['technique_swim', 'endurance_ride', 'easy_run', 'brick', 'strength_maintenance', 'mobility', 'recovery_run'],
    hybrid: ['easy_run', 'strength_hypertrophy', 'endurance_ride', 'strength_maintenance', 'mobility', 'threshold_run', 'recovery_run'],
  },
  maintenance: {
    running: ['easy_run', 'threshold_run', 'strength_maintenance', 'mobility'],
    marathon: ['easy_run', 'long_run', 'strength_maintenance', 'mobility'],
    cycling: ['endurance_ride', 'tempo_ride', 'strength_maintenance', 'mobility'],
    swimming: ['technique_swim', 'aerobic_swim', 'strength_maintenance', 'mobility'],
    strength: ['strength_maintenance', 'mobility', 'strength_maintenance', 'mobility'],
    triathlon: ['technique_swim', 'endurance_ride', 'easy_run', 'mobility'],
    hybrid: ['easy_run', 'strength_maintenance', 'endurance_ride', 'mobility'],
  },
  return_to_training: {
    running: ['easy_run', 'recovery_run', 'mobility'],
    marathon: ['easy_run', 'recovery_run', 'mobility'],
    cycling: ['endurance_ride', 'recovery_ride', 'mobility'],
    swimming: ['technique_swim', 'recovery_swim', 'mobility'],
    strength: ['strength_maintenance', 'mobility', 'strength_maintenance'],
    triathlon: ['technique_swim', 'endurance_ride', 'easy_run'],
    hybrid: ['easy_run', 'strength_maintenance', 'mobility'],
  },
};

export function selectTrainingM4SessionTypes(input: {
  planMode: TrainingPlanMode;
  discipline: CoachingDiscipline;
  sessionsPerWeek: number;
  goalPriority?: TrainingM4GoalPriority;
}): SessionType[] {
  const maximum = input.planMode === 'maintenance' ? 4 : input.planMode === 'return_to_training' ? 3 : 7;
  if (input.sessionsPerWeek > maximum) {
    throw new Error(`TRAINING_M4_${input.planMode.toUpperCase()}_FREQUENCY_MAX_${maximum}`);
  }
  const base = MODE_ARCHETYPES[input.planMode][input.discipline];
  const archetype = (input.discipline === 'hybrid' || input.discipline === 'triathlon') && input.goalPriority
    ? prioritizeCompositeArchetype(input.discipline, base, input.goalPriority)
    : [...base];
  const selected = archetype.slice(0, input.sessionsPerWeek);
  if (selected.length !== input.sessionsPerWeek) throw new Error('TRAINING_M4_ARCHETYPE_COVERAGE_FAILED');
  return selected;
}

function prioritizeCompositeArchetype(
  discipline: 'hybrid' | 'triathlon',
  archetype: readonly SessionType[],
  priority: TrainingM4GoalPriority,
): SessionType[] {
  if (discipline === 'hybrid') {
    const preferred: SessionType[] = priority.primaryDiscipline === 'strength'
      ? ['strength_hypertrophy', 'strength_maintenance', 'easy_run', 'threshold_run', 'endurance_ride', 'mobility', 'recovery_run']
      : priority.primaryDiscipline === 'cycling'
        ? ['endurance_ride', 'easy_run', 'strength_hypertrophy', 'threshold_run', 'strength_maintenance', 'mobility', 'recovery_run']
        : ['easy_run', 'threshold_run', 'strength_hypertrophy', 'strength_maintenance', 'endurance_ride', 'mobility', 'recovery_run'];
    return preferred.filter((type) => archetype.includes(type));
  }
  const order = [priority.primaryDiscipline, ...priority.secondaryDisciplines];
  for (const modality of ['running', 'cycling', 'swimming'] as const) {
    if (!order.includes(modality)) order.push(modality);
  }
  const leaders = order.flatMap((modality) => {
    const found = archetype.find((sessionType) => disciplineForSessionType(sessionType) === modality);
    return found ? [found] : [];
  });
  return [...leaders, ...archetype.filter((sessionType) => !leaders.includes(sessionType))];
}

function disciplineForSessionType(sessionType: SessionType): CoachingDiscipline {
  if (sessionType.endsWith('_run')) return 'running';
  if (sessionType.endsWith('_ride')) return 'cycling';
  if (sessionType.endsWith('_swim')) return 'swimming';
  if (sessionType.startsWith('strength_')) return 'strength';
  if (sessionType === 'brick') return 'triathlon';
  return 'hybrid';
}

export function eventSessionTypeForDiscipline(discipline: CoachingDiscipline): SessionType {
  if (discipline === 'running' || discipline === 'marathon') return 'long_run';
  if (discipline === 'cycling') return 'endurance_ride';
  if (discipline === 'swimming') return 'aerobic_swim';
  if (discipline === 'strength') return 'strength_max';
  return 'brick';
}

export function validateTrainingM4EventSubtype(
  discipline: CoachingDiscipline,
  subtype: TrainingEventSubtype,
): void {
  const expected: Record<CoachingDiscipline, readonly TrainingEventSubtype[]> = {
    running: ['running_race'],
    marathon: ['marathon'],
    cycling: ['cycling_event'],
    swimming: ['open_water_swim'],
    strength: ['hybrid_event'],
    triathlon: ['triathlon'],
    hybrid: ['hybrid_event'],
  };
  if (!expected[discipline].includes(subtype)) throw new Error('TRAINING_M4_EVENT_SUBTYPE_DISCIPLINE_MISMATCH');
}

export function deriveEventHorizonWeeks(planStartDate: string, eventDate: string): number {
  const start = parseIsoDate(planStartDate, 'TRAINING_M4_PLAN_START_DATE_INVALID');
  const event = parseIsoDate(eventDate, 'TRAINING_M4_EVENT_DATE_INVALID');
  const days = Math.floor((event.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days < 29) throw new Error('TRAINING_M4_EVENT_HORIZON_TOO_SHORT');
  const weeks = Math.ceil(days / 7);
  if (weeks > 52) throw new Error('TRAINING_M4_EVENT_HORIZON_TOO_LONG');
  return weeks;
}

export function validateTrainingM4PlanStartDate(value: string): void {
  parseIsoDate(value, 'TRAINING_M4_PLAN_START_DATE_INVALID');
}

export function dayOfWeekForIsoDate(value: string): DayOfWeek {
  const date = parseIsoDate(value, 'TRAINING_M4_DATE_INVALID');
  const days: DayOfWeek[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getUTCDay()];
}

export function isoDateForWeekDay(planStartDate: string, weekNumber: number, day: DayOfWeek): string {
  const start = parseIsoDate(planStartDate, 'TRAINING_M4_PLAN_START_DATE_INVALID');
  const desired = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(day);
  const offsetToDay = (desired - start.getUTCDay() + 7) % 7;
  const date = new Date(start.getTime() + ((weekNumber - 1) * 7 + offsetToDay) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export function validateTrainingM4ResourceAccess(
  discipline: CoachingDiscipline,
  resources: TrainingM4ResourceAccess,
): void {
  const expectedKeys = ['bicycle', 'indoorTrainer', 'outdoorRideEnvironment', 'pool', 'safeRunEnvironment'];
  if (!resources || typeof resources !== 'object'
      || Object.keys(resources).sort().join(',') !== expectedKeys.join(',')
      || Object.values(resources).some((value) => typeof value !== 'boolean')) {
    throw new Error('TRAINING_M4_RESOURCE_ACCESS_INVALID');
  }
  if ((discipline === 'swimming' || discipline === 'triathlon') && !resources.pool) {
    throw new Error('TRAINING_M4_RESOURCE_POOL_REQUIRED');
  }
  if ((discipline === 'cycling' || discipline === 'triathlon')
      && !resources.indoorTrainer
      && !(resources.bicycle && resources.outdoorRideEnvironment)) {
    throw new Error('TRAINING_M4_RESOURCE_BICYCLE_REQUIRED');
  }
  if (discipline === 'hybrid'
      && !resources.indoorTrainer
      && !(resources.bicycle && resources.outdoorRideEnvironment)) {
    throw new Error('TRAINING_M4_RESOURCE_HYBRID_BICYCLE_REQUIRED');
  }
  if ((discipline === 'running' || discipline === 'marathon' || discipline === 'triathlon' || discipline === 'hybrid')
      && !resources.safeRunEnvironment) {
    throw new Error('TRAINING_M4_RESOURCE_SAFE_RUN_ENVIRONMENT_REQUIRED');
  }
}

export function validateTrainingM4GoalPriority(
  discipline: CoachingDiscipline,
  priority: TrainingM4GoalPriority,
): void {
  if (!priority || typeof priority !== 'object'
      || typeof priority.primaryDiscipline !== 'string'
      || !Array.isArray(priority.secondaryDisciplines)
      || !priority.secondaryDisciplines.every((value) => typeof value === 'string')) {
    throw new Error('TRAINING_M4_GOAL_PRIORITY_INVALID');
  }
  if (priority.secondaryDisciplines.includes(priority.primaryDiscipline)
      || new Set(priority.secondaryDisciplines).size !== priority.secondaryDisciplines.length) {
    throw new Error('TRAINING_M4_GOAL_PRIORITY_CONFLICT');
  }
  const compatible = discipline === 'hybrid' || discipline === 'triathlon'
    ? new Set<CoachingDiscipline>(['running', 'cycling', 'swimming', 'strength'])
    : new Set<CoachingDiscipline>([discipline]);
  if (!compatible.has(priority.primaryDiscipline)
      || priority.secondaryDisciplines.some((value) => !compatible.has(value))) {
    throw new Error('TRAINING_M4_GOAL_PRIORITY_DISCIPLINE_MISMATCH');
  }
}

export function validateTrainingM4CapacityWindows(
  availableDays: readonly DayOfWeek[],
  discipline: CoachingDiscipline,
  windows: readonly TrainingM4CapacityWindow[],
): void {
  if (windows.length === 0) throw new Error('TRAINING_M4_CAPACITY_WINDOWS_REQUIRED');
  for (const window of windows) {
    if (!window || typeof window !== 'object'
        || !availableDays.includes(window.dayOfWeek)
        || typeof window.startTime !== 'string'
        || typeof window.endTime !== 'string'
        || typeof window.timezone !== 'string'
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.startTime)
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.endTime)
        || window.startTime >= window.endTime
        || !window.timezone.trim()
        || !validTimeZone(window.timezone)) {
      throw new Error('TRAINING_M4_CAPACITY_WINDOW_INVALID');
    }
    if (window.allowedDisciplines != null
        && (!Array.isArray(window.allowedDisciplines)
          || !window.allowedDisciplines.every((value) => typeof value === 'string'))) {
      throw new Error('TRAINING_M4_CAPACITY_WINDOW_INVALID');
    }
  }
  if (availableDays.some((day) => !windows.some((window) => window.dayOfWeek === day))) {
    throw new Error('TRAINING_M4_CAPACITY_DAY_UNCOVERED');
  }
  const requiredModalities: CoachingDiscipline[] = discipline === 'triathlon'
    ? ['swimming', 'cycling', 'running']
    : discipline === 'hybrid' ? ['running', 'strength'] : [discipline];
  for (const required of requiredModalities) {
    const supported = windows.some((window) => !window.allowedDisciplines?.length
      || window.allowedDisciplines.includes(required));
    if (!supported) throw new Error(`TRAINING_M4_CAPACITY_${required.toUpperCase()}_REQUIRED`);
  }
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function validateTrainingM4WorkoutCapacity(
  discipline: CoachingDiscipline,
  windows: readonly TrainingM4CapacityWindow[],
  workouts: readonly { dayOfWeek: DayOfWeek; sessionType: string; plannedDurationMinutes: number }[],
): void {
  for (const workout of workouts) {
    const required = requiredCapacityDisciplines(discipline, workout.sessionType);
    if (required.length === 0) continue;
    const supported = windows.some((window) => windowSupportsWorkout(discipline, window, workout));
    if (!supported) throw new Error(`TRAINING_M4_SCHEDULE_CAPACITY_CONFLICT:${workout.dayOfWeek}:${workout.sessionType}`);
  }
}

export function selectTrainingM4CapacityWindow(
  discipline: CoachingDiscipline,
  windows: readonly TrainingM4CapacityWindow[],
  workout: { dayOfWeek: DayOfWeek; sessionType: string; plannedDurationMinutes: number },
): TrainingM4CapacityWindow | null {
  return windows.find((window) => windowSupportsWorkout(discipline, window, workout)) ?? null;
}

export function trainingM4ScheduledWindow(
  scheduledDate: string,
  window: TrainingM4CapacityWindow,
  durationMinutes: number,
): { scheduledStartAt: string; scheduledEndAt: string; scheduleTimeZone: string } {
  const start = DateTime.fromISO(`${scheduledDate}T${window.startTime}`, { zone: window.timezone });
  const end = start.plus({ minutes: durationMinutes });
  if (!start.isValid || !end.isValid || end.toFormat('HH:mm') > window.endTime || end.toISODate() !== scheduledDate) {
    throw new Error('TRAINING_M4_SCHEDULE_WINDOW_INVALID');
  }
  const scheduledStartAt = start.toUTC().toISO();
  const scheduledEndAt = end.toUTC().toISO();
  if (!scheduledStartAt || !scheduledEndAt) throw new Error('TRAINING_M4_SCHEDULE_WINDOW_INVALID');
  return { scheduledStartAt, scheduledEndAt, scheduleTimeZone: window.timezone };
}

function windowSupportsWorkout(
  discipline: CoachingDiscipline,
  window: TrainingM4CapacityWindow,
  workout: { dayOfWeek: DayOfWeek; sessionType: string; plannedDurationMinutes: number },
): boolean {
  if (window.dayOfWeek !== workout.dayOfWeek
      || capacityWindowDurationMinutes(window) < workout.plannedDurationMinutes) return false;
  const required = requiredCapacityDisciplines(discipline, workout.sessionType);
  if (!window.allowedDisciplines?.length) return true;
  return required.every((value) => window.allowedDisciplines!.includes(value)
    || (discipline === 'marathon' && value === 'running' && window.allowedDisciplines!.includes('marathon')));
}

function capacityWindowDurationMinutes(window: TrainingM4CapacityWindow): number {
  const [startHour, startMinute] = window.startTime.split(':').map(Number);
  const [endHour, endMinute] = window.endTime.split(':').map(Number);
  return (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
}

function requiredCapacityDisciplines(
  discipline: CoachingDiscipline,
  sessionType: string,
): CoachingDiscipline[] {
  if (sessionType.endsWith('_run')) return ['running'];
  if (sessionType.endsWith('_ride')) return ['cycling'];
  if (sessionType.endsWith('_swim')) return ['swimming'];
  if (sessionType.startsWith('strength_')) return ['strength'];
  if (sessionType === 'brick') return discipline === 'triathlon'
    ? ['swimming', 'cycling', 'running']
    : ['cycling', 'running'];
  return [];
}

export function trainingM4ConflictSetHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(input))).digest('hex');
}

function parseIsoDate(value: string, code: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(code);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(code);
  return date;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

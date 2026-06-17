// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { CalendarSource } from './unified-calendar';

export type TrainingPlanGoal =
  | 'strength'
  | 'hypertrophy'
  | 'general_fitness'
  | 'hybrid'
  | 'endurance_support';

export type TrainingPlanDaysPerWeek = 2 | 3 | 4 | 5 | 6;

export type TrainingExperienceLevel =
  | 'beginner'
  | 'novice'
  | 'intermediate'
  | 'advanced';

export interface EquipmentProfile {
  label: string;
  equipment: string[];
}

export interface EnduranceKeyDay {
  date: string;
  type: 'long_run' | 'intervals' | 'race' | 'tempo' | 'ride' | 'swim';
  priority: 'low' | 'medium' | 'high' | 'protected';
}

export interface ProgressionModel {
  type: 'double_progression' | 'linear_load' | 'rir_progression' | 'volume_progression';
  weekCount: number;
  deloadPolicy?: {
    enabled: boolean;
    everyNWeeks?: number;
    trigger?: 'readiness_low' | 'performance_drop' | 'soreness_high';
  };
}

export interface TrainingPlanSpec {
  userId: string;
  planId: string;
  goal: TrainingPlanGoal;
  daysPerWeek: TrainingPlanDaysPerWeek;
  startDate: string;
  weekModel: 'rolling_7_day_from_start';
  experienceLevel: TrainingExperienceLevel;
  sessionDurationMinutes?: number;
  equipmentProfile: EquipmentProfile;
  preferredTrainingDays?: string[];
  blockedDays?: string[];
  injuriesOrLimitations?: string[];
  excludedExercises?: string[];
  preferredExercises?: string[];
  enduranceSchedule?: EnduranceKeyDay[];
  progressionModel: ProgressionModel;
  recoveryProfile?: {
    sleepQuality?: 'low' | 'normal' | 'high';
    soreness?: 'low' | 'medium' | 'high';
    readiness?: 'low' | 'normal' | 'high';
  };
  calendarPreference: {
    provider: CalendarSource | 'apple' | 'none';
    calendarId?: string;
  };
}

export interface BuildTrainingPlanSpecInput {
  userId: number | string;
  objective: string;
  goalMode?: string | null;
  trainingPriority?: string | null;
  daysPerWeek: number;
  startDate: string;
  equipmentProfileLabel?: string | null;
  availableEquipment?: unknown;
  fitnessProfile?: Record<string, unknown> | null;
  gymProfile?: Record<string, unknown> | null;
  preferredTrainingDays?: unknown;
  blockedDays?: unknown;
  calendarSource?: CalendarSource | null;
  sessionDurationMinutes?: number;
  enduranceSchedule?: EnduranceKeyDay[];
  durationWeeks?: number;
}

export type TrainingPlanSpecClarificationId =
  | 'equipment_clarification'
  | 'session_duration_clarification'
  | 'modality_priority_clarification'
  | 'recovery_feedback_clarification';

export interface TrainingPlanSpecClarificationIssue {
  id: TrainingPlanSpecClarificationId;
  severity: 'blocker' | 'warning';
  question: string;
  reason: string;
}

export interface TrainingPlanSpecReadinessResult {
  status: 'ready' | 'needs_clarification';
  issues: TrainingPlanSpecClarificationIssue[];
}

const VALID_DAY_NAMES = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

export function buildTrainingPlanSpec(input: BuildTrainingPlanSpecInput): TrainingPlanSpec {
  return {
    userId: String(input.userId),
    planId: 'candidate',
    goal: inferTrainingPlanGoal(input),
    daysPerWeek: clampDaysPerWeek(input.daysPerWeek),
    startDate: input.startDate,
    weekModel: 'rolling_7_day_from_start',
    experienceLevel: inferExperienceLevel(input.fitnessProfile, input.gymProfile),
    ...(typeof input.sessionDurationMinutes === 'number' && input.sessionDurationMinutes > 0
      ? { sessionDurationMinutes: Math.round(input.sessionDurationMinutes) }
      : {}),
    equipmentProfile: {
      label: input.equipmentProfileLabel?.trim() || 'unknown',
      equipment: normalizeEquipmentList(input.availableEquipment),
    },
    preferredTrainingDays: normalizeDayList(input.preferredTrainingDays),
    blockedDays: normalizeDayList(input.blockedDays),
    injuriesOrLimitations: normalizeStringList([
      input.fitnessProfile?.injuries,
      input.fitnessProfile?.limitations,
      input.gymProfile?.injuries,
      input.gymProfile?.limitations,
    ]),
    excludedExercises: normalizeStringList(input.gymProfile?.excluded_exercises),
    preferredExercises: normalizeStringList(input.gymProfile?.preferred_exercises),
    enduranceSchedule: input.enduranceSchedule,
    progressionModel: buildProgressionModel(inferTrainingPlanGoal(input), inferExperienceLevel(input.fitnessProfile, input.gymProfile), input.durationWeeks),
    recoveryProfile: inferRecoveryProfile(input.fitnessProfile),
    calendarPreference: {
      provider: input.calendarSource ?? 'none',
    },
  };
}

export function assessTrainingPlanSpecReadiness(
  spec: TrainingPlanSpec,
): TrainingPlanSpecReadinessResult {
  const issues: TrainingPlanSpecClarificationIssue[] = [];
  const highFrequencyStrength = spec.daysPerWeek >= 4
    && (spec.goal === 'strength' || spec.goal === 'hypertrophy' || spec.goal === 'hybrid');
  const equipmentUnknown = spec.equipmentProfile.label === 'unknown'
    && spec.equipmentProfile.equipment.length === 0;

  if (highFrequencyStrength && equipmentUnknown) {
    issues.push({
      id: 'equipment_clarification',
      severity: 'blocker',
      question: 'What equipment should Nexus build this strength plan around?',
      reason: 'High-frequency strength plans need known equipment so exercise selection is credible and does not fall back to generic fillers.',
    });
  }

  if (highFrequencyStrength && !spec.sessionDurationMinutes) {
    issues.push({
      id: 'session_duration_clarification',
      severity: equipmentUnknown ? 'blocker' : 'warning',
      question: 'How long should each strength session be?',
      reason: equipmentUnknown
        ? 'Unknown equipment plus unknown session length makes a high-frequency split unsafe to generate confidently.'
        : 'Nexus can use conservative duration defaults, but an explicit session length improves volume and exercise selection.',
    });
  }

  if (spec.goal === 'hybrid' && !spec.enduranceSchedule?.length) {
    issues.push({
      id: 'modality_priority_clarification',
      severity: 'warning',
      question: 'Are any endurance sessions protected this week?',
      reason: 'Hybrid plans are safer when lower-body strength can avoid long runs, races, or interval days.',
    });
  }

  if (!spec.recoveryProfile) {
    issues.push({
      id: 'recovery_feedback_clarification',
      severity: 'warning',
      question: 'How are sleep, soreness, and readiness right now?',
      reason: 'Nexus can start conservatively, but recovery context improves first-week load decisions.',
    });
  }

  return {
    status: issues.some((issue) => issue.severity === 'blocker') ? 'needs_clarification' : 'ready',
    issues,
  };
}

function buildProgressionModel(
  goal: TrainingPlanGoal,
  experienceLevel: TrainingExperienceLevel,
  durationWeeks?: number,
): ProgressionModel {
  const weekCount = Math.max(1, Math.round(Number.isFinite(durationWeeks) ? Number(durationWeeks) : 4));
  const beginner = experienceLevel === 'beginner' || experienceLevel === 'novice';
  const deloadCadence = beginner
    ? 5
    : experienceLevel === 'advanced'
      ? 3
      : 4;
  const deloadEnabled = weekCount >= deloadCadence;
  const type: ProgressionModel['type'] = beginner
    ? 'rir_progression'
    : goal === 'strength'
      ? 'linear_load'
      : goal === 'hypertrophy'
        ? 'double_progression'
        : goal === 'hybrid' || goal === 'endurance_support'
          ? 'volume_progression'
          : 'rir_progression';
  return {
    type,
    weekCount,
    deloadPolicy: {
      enabled: deloadEnabled,
      ...(deloadEnabled ? { everyNWeeks: deloadCadence } : {}),
      trigger: beginner ? 'soreness_high' : 'readiness_low',
    },
  };
}

function inferTrainingPlanGoal(input: BuildTrainingPlanSpecInput): TrainingPlanGoal {
  const text = [
    input.objective,
    input.goalMode,
    input.trainingPriority,
  ].join(' ').toLowerCase();
  if (/\b(hypertrophy|muscle|bodybuilding|build muscle|mass)\b/.test(text)) return 'hypertrophy';
  if (/\b(strength|max strength|powerlifting|strong)\b/.test(text)) return 'strength';
  if (/\b(hybrid|concurrent|runner|marathon|triathlon|endurance)\b/.test(text)) return 'hybrid';
  if (/\b(maintenance|support|general|fitness|health)\b/.test(text)) return 'general_fitness';
  return 'hypertrophy';
}

function inferExperienceLevel(
  fitnessProfile?: Record<string, unknown> | null,
  gymProfile?: Record<string, unknown> | null,
): TrainingExperienceLevel {
  const raw = [
    gymProfile?.experience_level,
    gymProfile?.training_experience,
    fitnessProfile?.experience_level,
    fitnessProfile?.fitness_level,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  if (/\b(advanced|expert|experienced)\b/.test(raw)) return 'advanced';
  if (/\b(intermediate)\b/.test(raw)) return 'intermediate';
  if (/\b(beginner|new|first|starting)\b/.test(raw)) return 'beginner';
  return 'novice';
}

function inferRecoveryProfile(
  fitnessProfile?: Record<string, unknown> | null,
): TrainingPlanSpec['recoveryProfile'] | undefined {
  if (!fitnessProfile) return undefined;
  const readiness = normalizeReadiness(fitnessProfile.readiness ?? fitnessProfile.energy_level);
  const soreness = normalizeSoreness(fitnessProfile.soreness ?? fitnessProfile.muscle_soreness);
  const sleepQuality = normalizeSleep(fitnessProfile.sleep_quality ?? fitnessProfile.sleepQuality);
  if (!readiness && !soreness && !sleepQuality) return undefined;
  return {
    ...(readiness ? { readiness } : {}),
    ...(soreness ? { soreness } : {}),
    ...(sleepQuality ? { sleepQuality } : {}),
  };
}

function normalizeReadiness(value: unknown): 'low' | 'normal' | 'high' | undefined {
  const text = String(value || '').toLowerCase();
  if (/\b(low|poor|red|tired|fatigued)\b/.test(text)) return 'low';
  if (/\b(high|green|great|fresh)\b/.test(text)) return 'high';
  if (text.trim()) return 'normal';
  return undefined;
}

function normalizeSoreness(value: unknown): 'low' | 'medium' | 'high' | undefined {
  const text = String(value || '').toLowerCase();
  if (/\b(high|severe|very)\b/.test(text)) return 'high';
  if (/\b(medium|moderate)\b/.test(text)) return 'medium';
  if (/\b(low|none|mild)\b/.test(text)) return 'low';
  return undefined;
}

function normalizeSleep(value: unknown): 'low' | 'normal' | 'high' | undefined {
  const text = String(value || '').toLowerCase();
  if (/\b(low|poor|bad|short)\b/.test(text)) return 'low';
  if (/\b(high|great|excellent)\b/.test(text)) return 'high';
  if (text.trim()) return 'normal';
  return undefined;
}

function clampDaysPerWeek(value: number): TrainingPlanDaysPerWeek {
  const rounded = Math.round(Number.isFinite(value) ? value : 5);
  return Math.min(Math.max(rounded, 2), 6) as TrainingPlanDaysPerWeek;
}

function normalizeEquipmentList(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeStringList(value);
  return normalizeStringList(value);
}

function normalizeStringList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [value];
  const values = source
    .flatMap((item) => String(item || '').split(/[,;\n]/g))
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function normalizeDayList(value: unknown): string[] | undefined {
  const days = normalizeStringList(value)
    .map((day) => day.toLowerCase())
    .filter((day) => VALID_DAY_NAMES.has(day));
  return days.length > 0 ? days : undefined;
}

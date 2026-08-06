// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  CoachingDiscipline,
  Constraint,
  DayOfWeek,
  EquipmentAccess,
  Goals,
  NormalizedTrainingProfile,
  RaceEvent,
  Sport,
  TrainingProfileFollowUpQuestion,
  TrainingProfileMissingData,
  TrainingProfileQuality,
} from './coach-kernel/types';
import { DAY_ORDER } from './coach-kernel/utils';

export interface TrainingProfileExtractionInput {
  userId: number;
  objective: string;
  sessionsPerWeek: number;
  strengthSessionsPerWeek: number;
  preferredTime: string;
  preferredCardioTime: string;
  preferredStrengthTime: string;
  longWorkoutDay?: string | null;
  notes?: string | null;
  fitnessProfile?: Record<string, any> | null;
  gymProfile?: Record<string, any> | null;
  runProfile?: Record<string, any> | null;
  currentReadiness?: {
    score: number;
    sleepHours?: number;
    hrvStatus?: 'low' | 'normal' | 'high';
    energyReserve?: number;
  } | null;
  twoADayPreference?: 'never' | 'optional' | 'preferred' | 'auto' | null;
  recentlyAskedFollowUpIds?: string[] | null;
  resolvedFollowUpIds?: string[] | null;
}

export interface TrainingProfileExtractionContext {
  primaryFocus: CoachingDiscipline;
  priorityOrder: Array<Sport | 'strength'>;
  weeklyTargets: Goals['weeklySessionsTarget'];
  strengthGoal?: NonNullable<Goals['strengthGoal']>;
  raceCalendar: RaceEvent[];
  equipment: EquipmentAccess;
  equipmentSource: 'provided' | 'fallback';
  experienceLevel: NormalizedTrainingProfile['experience']['level'];
  experienceSource: 'provided' | 'fallback';
  constraints: Constraint[];
  maxSessionsPerDay: number;
}

type SourceState = 'provided' | 'inferred' | 'missing';

export function extractNormalizedTrainingProfile(
  input: TrainingProfileExtractionInput,
  context: TrainingProfileExtractionContext,
): NormalizedTrainingProfile {
  const availableDays = resolveAvailableDays(input, context.weeklyTargets);
  const availableSessionDurations = resolveAvailableSessionDurations(input);
  const scheduleDayPreferences = resolveScheduleDayPreferences(input);
  const discomfortFlags = context.constraints
    .filter((constraint) => constraint.type === 'injury')
    .map((constraint) => ({
      area: constraint.description,
      severity: constraint.severity === 'high' ? 'high' as const : constraint.severity === 'medium' ? 'moderate' as const : 'low' as const,
      impact: [constraint.sport as Sport | 'strength'].filter(Boolean),
    }));
  const sourceSummary = buildSourceSummary(input, context, availableSessionDurations);
  const missing = detectMissingProfileData(input, context, availableSessionDurations, sourceSummary);
  const followUpQuestions = buildFollowUpQuestions(missing, input, context);
  const quality = scoreProfileQuality(sourceSummary, missing, followUpQuestions);
  const sexGenderContext = resolveSexGenderContext(input);

  return {
    athleteId: input.userId,
    goals: {
      primaryFocus: context.primaryFocus,
      secondaryFocus: context.weeklyTargets.strength && context.primaryFocus !== 'strength' ? 'strength' : undefined,
      strengthGoal: context.strengthGoal,
      raceCalendar: context.raceCalendar,
    },
    experience: {
      level: context.experienceLevel,
      source: context.experienceSource,
    },
    availableDays,
    availableSessionDurations,
    modalityPreferences: {
      priorityOrder: context.priorityOrder,
      requestedSessions: context.weeklyTargets,
      preferredTimesBySport: {
        running: normalizeTime(input.preferredCardioTime, input.preferredTime),
        cycling: normalizeTime(input.preferredCardioTime, input.preferredTime),
        swimming: normalizeTime(input.preferredCardioTime, input.preferredTime),
        strength: normalizeTime(input.preferredStrengthTime, input.preferredTime),
      },
      twoADayPreference: input.twoADayPreference,
    },
    equipment: {
      ...context.equipment,
      source: context.equipmentSource,
    },
    environment: {
      hasGym: context.equipment.hasGym,
      hasOutdoorRunAccess: context.equipment.hasTrack,
      hasBikeTrainer: context.equipment.hasBikeTrainer,
      hasPool: context.equipment.hasPool,
      notes: context.equipment.notes ?? [],
    },
    scheduleConstraints: {
      preferredLongSessionDay: normalizeDayOfWeek(input.longWorkoutDay) ?? undefined,
      preferredTrainingDays: scheduleDayPreferences.preferredTrainingDays,
      blockedTrainingDays: scheduleDayPreferences.blockedTrainingDays,
      maxSessionsPerDay: context.maxSessionsPerDay,
      declaredConstraints: compact([
        cleanText(input.notes),
        cleanText(input.fitnessProfile?.schedule_constraints),
        cleanText(input.gymProfile?.schedule_constraints),
        cleanText(input.runProfile?.schedule_constraints),
      ]),
    },
    discomfortFlags,
    recoveryBaseline: input.currentReadiness
      ? {
          score: clamp(Math.round(input.currentReadiness.score), 0, 100),
          sleepHours: input.currentReadiness.sleepHours,
          hrvStatus: input.currentReadiness.hrvStatus,
          energyReserve: input.currentReadiness.energyReserve,
          source: 'wearable',
        }
      : { source: 'missing' },
    consistencyTendencies: resolveConsistencyTendencies(input),
    currentMarkers: {
      runningWeeklyMileageKm: numericOrUndefined(input.runProfile?.weekly_mileage_km),
      easyPaceMinPerKm: cleanText(input.runProfile?.easy_pace_min_per_km) ?? undefined,
      cyclingFtpWatts: numericOrUndefined(input.runProfile?.ftp_watts ?? input.runProfile?.cycling_ftp_watts ?? input.fitnessProfile?.ftp_watts),
      cyclingWeeklyHours: cleanText(input.runProfile?.cycling_weekly_hours ?? input.runProfile?.weekly_hours) ?? undefined,
      swimPoolAccess: cleanText(input.runProfile?.swim_pool_access ?? input.runProfile?.pool_access) ?? undefined,
      swimSessionsPerWeek: numericOrUndefined(input.runProfile?.swim_sessions_per_week),
      swim400mFreestyleTime: cleanText(input.runProfile?.swim_400m_freestyle_time) ?? undefined,
      bodyWeightKg: numericOrUndefined(input.fitnessProfile?.weight_kg),
      squat1RmKg: numericOrUndefined(input.gymProfile?.squat_1rm_kg),
      bench1RmKg: numericOrUndefined(input.gymProfile?.bench_1rm_kg),
      deadlift1RmKg: numericOrUndefined(input.gymProfile?.deadlift_1rm_kg),
    },
    sexGenderContext,
    quality,
  };
}

function buildSourceSummary(
  input: TrainingProfileExtractionInput,
  context: TrainingProfileExtractionContext,
  durations: NormalizedTrainingProfile['availableSessionDurations'],
): TrainingProfileQuality['sourceSummary'] {
  return {
    goals: cleanText(input.objective) ? 'provided' : 'missing',
    experience: context.experienceSource === 'provided' ? 'provided' : 'inferred',
    schedule: hasScheduleEvidence(input) ? 'provided' : 'inferred',
    duration: durations.genericMinutes || durations.enduranceMinutes || durations.strengthMinutes ? 'provided' : 'missing',
    modality: context.primaryFocus === 'hybrid' && !hasExplicitModalityPriority(input) ? 'inferred' : 'provided',
    equipment: context.equipmentSource === 'provided' ? 'provided' : 'missing',
    limitations: hasAnyProfileValue(input.fitnessProfile?.injuries, input.runProfile?.injury_history) ? 'provided' : 'missing',
    recovery: input.currentReadiness ? 'provided' : 'missing',
    consistency: hasAnyProfileValue(input.fitnessProfile?.weekly_frequency, input.gymProfile?.sessions_per_week, input.runProfile?.weekly_availability_days, input.notes) ? 'provided' : 'inferred',
    markers: hasAnyProfileValue(input.runProfile?.weekly_mileage_km, input.runProfile?.easy_pace_min_per_km, input.runProfile?.ftp_watts, input.runProfile?.cycling_ftp_watts, input.runProfile?.cycling_weekly_hours, input.runProfile?.swim_pool_access, input.runProfile?.pool_access, input.runProfile?.swim_sessions_per_week, input.gymProfile?.squat_1rm_kg, input.gymProfile?.bench_1rm_kg, input.gymProfile?.deadlift_1rm_kg)
      ? 'provided'
      : 'missing',
    preferences: hasExplicitTrainingPreference(input) ? 'provided' : 'inferred',
    sex_gender: resolveSexGenderContext(input) ? 'provided' : 'missing',
  };
}

function detectMissingProfileData(
  input: TrainingProfileExtractionInput,
  context: TrainingProfileExtractionContext,
  durations: NormalizedTrainingProfile['availableSessionDurations'],
  sources: TrainingProfileQuality['sourceSummary'],
): TrainingProfileMissingData[] {
  const missing: TrainingProfileMissingData[] = [];
  const needsStrength = (context.weeklyTargets.strength ?? 0) > 0 || context.primaryFocus === 'strength';
  const needsRunning = (context.weeklyTargets.running ?? 0) > 0 || context.primaryFocus === 'running' || context.primaryFocus === 'marathon';
  const needsCycling = (context.weeklyTargets.cycling ?? 0) > 0 || context.primaryFocus === 'cycling';
  const needsSwimming = (context.weeklyTargets.swimming ?? 0) > 0 || context.primaryFocus === 'swimming' || context.primaryFocus === 'triathlon';

  if (sources.goals !== 'provided') {
    missing.push({ key: 'primary_goal', category: 'goals', severity: 'critical', reason: 'Primary training objective is missing, so the planner must infer the week shape.' });
  }
  if (sources.experience !== 'provided') {
    missing.push({ key: 'experience_level', category: 'experience', severity: 'important', reason: 'Experience level is missing, so the coach uses a novice-safe fallback instead of calibrated progression.' });
  }
  if (sources.duration !== 'provided') {
    missing.push({ key: 'session_duration', category: 'duration', severity: 'critical', reason: 'Available session length is missing, so the planner falls back to broad default windows.' });
  }
  if (needsStrength && sources.equipment !== 'provided') {
    missing.push({ key: 'equipment', category: 'equipment', severity: 'critical', reason: 'Strength sessions need equipment truth to choose credible exercises and substitutions.' });
  }
  if (sources.limitations !== 'provided') {
    missing.push({ key: 'injury_limitations', category: 'limitations', severity: 'critical', reason: 'The coach needs an explicit limitation answer, even if the answer is none.' });
  }
  if (context.primaryFocus === 'hybrid' && !hasExplicitModalityPriority(input)) {
    missing.push({ key: 'modality_priority', category: 'modality', severity: 'critical', reason: 'Hybrid plans need a declared priority so strength, running, and cycling do not compete blindly.' });
  }
  if (needsRunning && !hasAnyProfileValue(input.runProfile?.weekly_mileage_km, input.runProfile?.easy_pace_min_per_km)) {
    missing.push({ key: 'running_baseline', category: 'markers', severity: 'important', reason: 'Running load and paces are inferred without current mileage or easy pace.' });
  }
  if (needsCycling && !hasAnyProfileValue(input.runProfile?.weekly_hours, input.runProfile?.cycling_weekly_hours, input.runProfile?.ftp_watts, input.runProfile?.cycling_ftp_watts, input.fitnessProfile?.ftp_watts)) {
    missing.push({ key: 'cycling_baseline', category: 'markers', severity: 'important', reason: 'Cycling intensity and load are inferred without FTP or weekly cycling hours.' });
  }
  if (needsSwimming && !hasAnyProfileValue(input.runProfile?.swim_pool_access, input.runProfile?.pool_access, input.runProfile?.swim_sessions_per_week, input.runProfile?.swim_400m_freestyle_time)) {
    missing.push({ key: 'swim_baseline', category: 'markers', severity: 'important', reason: 'Swim frequency, access, and benchmark context are inferred without pool access or recent swim baseline.' });
  }
  if (sources.schedule !== 'provided' && totalTargetSessions(context.weeklyTargets) >= 5) {
    missing.push({ key: 'schedule_priority', category: 'schedule', severity: 'important', reason: 'Higher-frequency weeks need explicit preferred days or priority windows.' });
  }
  if (!durations.strengthMinutes && needsStrength && durations.genericMinutes && durations.genericMinutes < 35) {
    missing.push({ key: 'strength_duration_detail', category: 'duration', severity: 'important', reason: 'Strength duration is inferred from a short generic window; ask if gym sessions can run longer.' });
  }
  if (!input.currentReadiness) {
    missing.push({ key: 'recovery_baseline', category: 'recovery', severity: 'optional', reason: 'Wearable or subjective recovery baseline would improve day-to-day adaptation.' });
  }
  if (sources.preferences !== 'provided') {
    missing.push({ key: 'preferences_dislikes', category: 'preferences', severity: 'optional', reason: 'Preferences and dislikes are unknown, so substitutions may be technically safe but less personally sticky.' });
  }

  return missing;
}

function buildFollowUpQuestions(
  missing: TrainingProfileMissingData[],
  input: TrainingProfileExtractionInput,
  context: TrainingProfileExtractionContext,
): TrainingProfileFollowUpQuestion[] {
  const questions = missing.map((item): TrainingProfileFollowUpQuestion => {
    switch (item.key) {
      case 'equipment':
        return {
          id: 'equipment_clarification',
          category: 'equipment',
          field: 'equipment_access',
          priority: 'high',
          prompt: 'What equipment can you reliably use for strength sessions?',
          reason: item.reason,
          answerType: 'choice',
          options: ['Full commercial gym', 'Garage gym with barbell/rack', 'Home gym with dumbbells', 'Bodyweight/bands only'],
          planningRisk: 'Exercise selection and substitutions can be wrong when equipment access is unknown.',
          resolvesMissingKeys: ['equipment'],
        };
      case 'session_duration':
        return {
          id: 'session_duration_clarification',
          category: 'duration',
          field: 'available_session_duration_minutes',
          priority: 'high',
          prompt: 'How long can your normal training sessions realistically be?',
          reason: item.reason,
          answerType: 'choice',
          options: ['20-30 min', '35-45 min', '50-60 min', '75+ min'],
          planningRisk: 'Session density and weekly volume can be unrealistic when duration is unknown.',
          resolvesMissingKeys: ['session_duration', 'strength_duration_detail'],
        };
      case 'injury_limitations':
        return {
          id: 'injury_limitation_clarification',
          category: 'limitations',
          field: 'injuries',
          priority: 'high',
          prompt: 'Any current pain, injury, or movement limitation the coach must respect?',
          reason: item.reason,
          answerType: 'text',
          planningRisk: 'Movement selection can be unsafe when limitations are not explicitly answered.',
          resolvesMissingKeys: ['injury_limitations'],
        };
      case 'modality_priority':
        return {
          id: 'modality_priority_clarification',
          category: 'modality',
          field: 'priority_order',
          priority: 'high',
          prompt: 'For this block, which modality should win when the week gets crowded?',
          reason: item.reason,
          answerType: 'choice',
          options: ['Strength first', 'Running first', 'Cycling first', 'Balanced hybrid'],
          planningRisk: 'Hybrid plans can over-compete when modality priority is unclear.',
          resolvesMissingKeys: ['modality_priority'],
        };
      case 'race_date':
        return {
          id: 'race_date_clarification',
          category: 'goals',
          field: 'target_race_date',
          priority: 'high',
          prompt: 'What is the date of the marathon you are training for?',
          reason: item.reason,
          answerType: 'text',
          planningRisk: 'Without a race date, marathon progression and taper timing stay conservative and lower confidence.',
          resolvesMissingKeys: ['race_date'],
        };
      case 'schedule_priority':
        return {
          id: 'schedule_priority_clarification',
          category: 'schedule',
          field: 'preferred_training_days',
          priority: 'medium',
          prompt: 'Which days or windows are protected for your most important sessions?',
          reason: item.reason,
          answerType: 'multi_choice',
          options: ['Weekday mornings', 'Weekday lunch', 'Weekday evenings', 'Saturday', 'Sunday'],
          planningRisk: 'Key sessions can land in weak windows when schedule priority is unknown.',
          resolvesMissingKeys: ['schedule_priority'],
        };
      case 'running_baseline':
        return {
          id: 'running_baseline_clarification',
          category: 'markers',
          field: 'running_baseline',
          priority: 'medium',
          prompt: 'What are your current weekly running mileage and comfortable easy pace?',
          reason: item.reason,
          answerType: 'text',
          planningRisk: 'Running volume and paces are less calibrated without a baseline.',
          resolvesMissingKeys: ['running_baseline'],
        };
      case 'cycling_baseline':
        return {
          id: 'cycling_baseline_clarification',
          category: 'markers',
          field: 'cycling_baseline',
          priority: 'medium',
          prompt: 'What are your current weekly cycling hours and FTP or effort benchmark?',
          reason: item.reason,
          answerType: 'text',
          planningRisk: 'Cycling intensity and weekly load are less calibrated without a baseline.',
          resolvesMissingKeys: ['cycling_baseline'],
        };
      case 'swim_baseline':
        return {
          id: 'swim_baseline_clarification',
          category: 'markers',
          field: 'swim_baseline',
          priority: 'medium',
          prompt: 'What swim access, weekly swim frequency, and recent 400m/CSS benchmark should the coach use?',
          reason: item.reason,
          answerType: 'text',
          planningRisk: 'Swim sessions can be unrealistic or unsafe when access and baseline ability are unknown.',
          resolvesMissingKeys: ['swim_baseline'],
        };
      case 'strength_duration_detail':
        return {
          id: 'strength_duration_clarification',
          category: 'duration',
          field: 'strength_session_duration_minutes',
          priority: 'medium',
          prompt: 'Can gym sessions run longer than your generic training window, or should they stay compressed?',
          reason: item.reason,
          answerType: 'choice',
          options: ['Keep gym under 30 min', '35-45 min is possible', '50-60 min is possible'],
          planningRisk: 'Strength prescriptions may be over-compressed without gym-duration truth.',
          resolvesMissingKeys: ['strength_duration_detail'],
        };
      case 'recovery_baseline':
        return {
          id: 'recovery_feedback_clarification',
          category: 'recovery',
          field: 'recovery_feedback',
          priority: 'low',
          prompt: 'How have sleep, soreness, and energy felt over the last week?',
          reason: item.reason,
          answerType: 'choice',
          options: ['Good', 'Mixed', 'Poor', 'Unsure'],
          planningRisk: 'Readiness adaptations are less precise without recovery baseline data.',
          resolvesMissingKeys: ['recovery_baseline'],
        };
      case 'experience_level':
        return {
          id: 'experience_level_clarification',
          category: 'experience',
          field: 'experience_level',
          priority: 'medium',
          prompt: 'How long have you trained consistently in this main modality?',
          reason: item.reason,
          answerType: 'choice',
          options: ['New / under 6 months', '6-18 months', '2-4 years', '5+ years'],
          planningRisk: 'Progression and exercise complexity stay conservative until experience is clear.',
          resolvesMissingKeys: ['experience_level'],
        };
      case 'preferences_dislikes':
        return {
          id: 'preferences_dislikes_clarification',
          category: 'preferences',
          field: 'preferences_dislikes',
          priority: 'low',
          prompt: 'Any exercises, session styles, or training days you strongly prefer or dislike?',
          reason: item.reason,
          answerType: 'text',
          planningRisk: 'Adherence may be weaker when preferences and dislikes are unknown.',
          resolvesMissingKeys: ['preferences_dislikes'],
        };
      default:
        return {
          id: `${item.key}_clarification`,
          category: item.category,
          field: item.key,
          priority: item.severity === 'critical' ? 'high' : item.severity === 'important' ? 'medium' : 'low',
          prompt: `Clarify ${item.key.replace(/_/g, ' ')}.`,
          reason: item.reason,
          answerType: 'text',
          planningRisk: item.reason,
          resolvesMissingKeys: [item.key],
        };
    }
  });

  if (!questions.some((question) => question.id === 'training_feedback_loop') && shouldAskOutcomeFeedback(input, context)) {
    questions.push({
      id: 'training_feedback_loop',
      category: 'consistency',
      field: 'session_outcome_feedback',
      priority: 'low',
      prompt: 'After your next session, should the coach ask whether it felt too easy, too hard, or too long?',
      reason: 'Outcome feedback improves future progression and adherence adjustments.',
      answerType: 'choice',
      options: ['Yes', 'No'],
    });
  }

  return dedupeById(questions)
    .filter((question) => !(input.resolvedFollowUpIds ?? []).includes(question.id))
    .filter((question) => !(input.recentlyAskedFollowUpIds ?? []).includes(question.id));
}

function scoreProfileQuality(
  sources: TrainingProfileQuality['sourceSummary'],
  missing: TrainingProfileMissingData[],
  followUpQuestions: TrainingProfileFollowUpQuestion[],
): TrainingProfileQuality {
  const categories = Object.values(sources);
  const sourcePoints = categories.reduce((sum, source) => sum + (source === 'provided' ? 1 : source === 'inferred' ? 0.55 : 0), 0);
  const completenessScore = clamp(Math.round((sourcePoints / Math.max(1, categories.length)) * 100), 0, 100);
  const criticalCount = missing.filter((item) => item.severity === 'critical').length;
  const importantCount = missing.filter((item) => item.severity === 'important').length;
  const highPriorityCount = followUpQuestions.filter((question) => question.priority === 'high').length;
  const confidenceScore = clamp(Math.round(completenessScore - criticalCount * 12 - importantCount * 5 - highPriorityCount * 3), 0, 100);
  const confidenceBand: TrainingProfileQuality['confidenceBand'] = confidenceScore >= 75
    ? 'high'
    : confidenceScore >= 50
      ? 'medium'
      : 'low';
  const planningRiskFlags = riskFlagsForMissingData(missing, followUpQuestions);
  const planQualityLimited = confidenceBand !== 'high'
    || criticalCount > 0
    || planningRiskFlags.length > 0;

  return {
    completenessScore,
    confidenceScore,
    confidenceBand,
    planQualityLimited,
    planningRiskFlags,
    missingCriticalData: missing.filter((item) => item.severity === 'critical'),
    followUpQuestions,
    sourceSummary: sources,
  };
}

function resolveAvailableDays(
  input: TrainingProfileExtractionInput,
  targets: Goals['weeklySessionsTarget'],
): Partial<Record<Sport, number>> {
  return {
    running: parseDays(input.runProfile?.weekly_availability_days) ?? targets.running,
    cycling: parseDays(input.runProfile?.cycling_weekly_availability_days) ?? parseDays(input.runProfile?.weekly_availability_days) ?? targets.cycling,
    swimming: parseDays(input.runProfile?.swim_sessions_per_week) ?? targets.swimming,
    strength: parseDays(input.gymProfile?.sessions_per_week) ?? parseDays(input.fitnessProfile?.weekly_frequency) ?? targets.strength,
  };
}

function hasScheduleEvidence(input: TrainingProfileExtractionInput): boolean {
  return hasAnyProfileValue(
    input.runProfile?.weekly_availability_days,
    input.runProfile?.cycling_weekly_availability_days,
    input.runProfile?.swim_sessions_per_week,
    input.gymProfile?.sessions_per_week,
    input.fitnessProfile?.weekly_frequency,
    input.longWorkoutDay,
    input.fitnessProfile?.preferred_training_days,
    input.fitnessProfile?.blocked_days,
    input.gymProfile?.preferred_training_days,
    input.gymProfile?.blocked_days,
    input.runProfile?.preferred_training_days,
    input.runProfile?.blocked_days,
  );
}

function resolveScheduleDayPreferences(input: TrainingProfileExtractionInput): {
  preferredTrainingDays: DayOfWeek[];
  blockedTrainingDays: DayOfWeek[];
} {
  const preferredTrainingDays = extractDayList([
    input.longWorkoutDay,
    input.fitnessProfile?.preferred_training_days,
    input.fitnessProfile?.preferred_days,
    input.fitnessProfile?.available_days,
    input.gymProfile?.preferred_training_days,
    input.gymProfile?.preferred_days,
    input.runProfile?.preferred_training_days,
    input.runProfile?.preferred_days,
  ]);
  const blockedTrainingDays = extractDayList([
    input.fitnessProfile?.blocked_days,
    input.fitnessProfile?.avoid_days,
    input.fitnessProfile?.unavailable_days,
    input.gymProfile?.blocked_days,
    input.gymProfile?.avoid_days,
    input.gymProfile?.unavailable_days,
    input.runProfile?.blocked_days,
    input.runProfile?.avoid_days,
    input.runProfile?.unavailable_days,
  ]).filter((day) => !preferredTrainingDays.includes(day));

  return {
    preferredTrainingDays,
    blockedTrainingDays,
  };
}

function resolveAvailableSessionDurations(input: TrainingProfileExtractionInput): NormalizedTrainingProfile['availableSessionDurations'] {
  const genericMinutes = firstDuration(
    input.fitnessProfile?.session_duration_minutes,
    input.fitnessProfile?.available_duration_minutes,
    input.fitnessProfile?.preferred_session_duration,
    input.notes,
  );
  const enduranceMinutes = firstDuration(
    input.runProfile?.session_duration_minutes,
    input.runProfile?.cardio_session_duration_minutes,
    input.runProfile?.run_session_duration_minutes,
    input.runProfile?.ride_session_duration_minutes,
    genericMinutes,
  );
  const strengthMinutes = firstDuration(
    input.gymProfile?.session_duration_minutes,
    input.gymProfile?.strength_session_duration_minutes,
    input.gymProfile?.workout_duration_minutes,
    genericMinutes,
  );

  return {
    genericMinutes,
    enduranceMinutes,
    strengthMinutes,
  };
}

function resolveConsistencyTendencies(input: TrainingProfileExtractionInput): NormalizedTrainingProfile['consistencyTendencies'] {
  const declaredWeeklyFrequency = parseDays(input.fitnessProfile?.weekly_frequency) ?? Math.max(input.sessionsPerWeek, input.strengthSessionsPerWeek);
  const text = [
    input.notes,
    input.fitnessProfile?.consistency,
    input.fitnessProfile?.schedule_constraints,
  ].map((value) => String(value ?? '').toLowerCase()).join(' ');
  const signals = compact([
    /travel|hotel|viagem/i.test(text) ? 'travel_or_hotel_week' : null,
    /inconsistent|miss|falh|busy|ocupad/i.test(text) ? 'inconsistent_schedule' : null,
    declaredWeeklyFrequency <= 2 ? 'low_frequency' : null,
  ]);
  const adherenceRisk = signals.includes('inconsistent_schedule') || signals.includes('travel_or_hotel_week')
    ? 'high'
    : declaredWeeklyFrequency <= 2
      ? 'medium'
      : 'low';
  return { declaredWeeklyFrequency, adherenceRisk, signals };
}

function resolveSexGenderContext(input: TrainingProfileExtractionInput): NormalizedTrainingProfile['sexGenderContext'] | undefined {
  const candidates: Array<{ source: 'fitness_profile' | 'gym_profile' | 'run_profile'; value: unknown }> = [
    { source: 'fitness_profile', value: input.fitnessProfile?.sex_gender ?? input.fitnessProfile?.gender ?? input.fitnessProfile?.sex },
    { source: 'gym_profile', value: input.gymProfile?.sex_gender ?? input.gymProfile?.gender ?? input.gymProfile?.sex },
    { source: 'run_profile', value: input.runProfile?.sex_gender ?? input.runProfile?.gender ?? input.runProfile?.sex },
  ];
  const found = candidates.find((candidate) => cleanText(candidate.value));
  if (!found) return undefined;
  const value = cleanText(found.value)!;
  const lower = value.toLowerCase();
  return {
    value,
    source: found.source,
    planningUse: /pregnan|postpartum|cycle|menstrual|menstr/i.test(lower)
      ? 'relevant_only_with_explicit_context'
      : 'not_used_by_default',
  };
}

export function profileFollowUpNotes(quality: TrainingProfileQuality | undefined): string[] {
  if (!quality || quality.followUpQuestions.length === 0) return [];
  const highQuestions = quality.followUpQuestions
    .filter((question) => question.priority === 'high')
    .slice(0, 3);
  const mediumQuestions = highQuestions.length > 0
    ? []
    : quality.followUpQuestions.filter((question) => question.priority === 'medium').slice(0, 1);
  const topQuestions = [...highQuestions, ...mediumQuestions];
  const missingKeys = quality.missingCriticalData.map((item) => item.key.replace(/_/g, ' '));

  return dedupeText([
    quality.planQualityLimited
      ? `Profile confidence: ${quality.confidenceScore}/100 (${quality.confidenceBand}); plan is conservative until ${missingKeys.length > 0 ? missingKeys.join(', ') : 'missing context'} is clarified.`
      : null,
    ...topQuestions.map((question) => `Profile follow-up: ${question.prompt}`),
  ]);
}

function riskFlagsForMissingData(
  missing: TrainingProfileMissingData[],
  followUpQuestions: TrainingProfileFollowUpQuestion[],
): string[] {
  const flags = [
    ...missing
      .filter((item) => item.severity !== 'optional')
      .map((item) => `${item.category}:${item.key}`),
    ...followUpQuestions
      .filter((question) => question.priority === 'high')
      .map((question) => `followup:${question.id}`),
  ];
  return dedupeText(flags).slice(0, 8);
}

function firstDuration(...values: unknown[]): number | undefined {
  for (const value of values) {
    const duration = parseDurationMinutes(value);
    if (duration !== undefined) return duration;
  }
  return undefined;
}

function parseDurationMinutes(value: unknown): number | undefined {
  const direct = numericOrUndefined(value);
  if (direct !== undefined) return clamp(Math.round(direct), 15, 180);
  if (typeof value !== 'string') return undefined;
  const match = value.toLowerCase().match(/(\d{2,3})\s*-?\s*(min|minute|minutes|m)\b/);
  if (!match) return undefined;
  return clamp(Number(match[1]), 15, 180);
}

function parseDays(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp(Math.round(value), 1, 7);
  if (typeof value !== 'string') return undefined;
  const matches = value.match(/\d+/g);
  if (!matches || matches.length === 0) return undefined;
  const max = Math.max(...matches.map(Number));
  return clamp(max, 1, 7);
}

function extractDayList(values: unknown[]): DayOfWeek[] {
  const tokens = values.flatMap(dayTextCandidates);
  const found: DayOfWeek[] = [];
  const add = (day: DayOfWeek) => {
    if (!found.includes(day)) found.push(day);
  };

  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (!normalized) continue;
    if (/\bweekends?\b|fim de semana/.test(normalized)) {
      add('saturday');
      add('sunday');
    }
    if (/\bweekdays?\b|dias úteis|dias uteis/.test(normalized)) {
      add('monday');
      add('tuesday');
      add('wednesday');
      add('thursday');
      add('friday');
    }
    for (const [day, aliases] of DAY_ALIASES) {
      if (aliases.some((alias) => normalized.includes(alias))) add(day);
    }
  }

  return found;
}

function dayTextCandidates(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(dayTextCandidates);
  if (typeof value === 'string') return [value];
  return [];
}

const DAY_ALIASES: Array<[DayOfWeek, string[]]> = [
  ['monday', ['monday', 'mon', 'segunda']],
  ['tuesday', ['tuesday', 'tue', 'tues', 'terça', 'terca']],
  ['wednesday', ['wednesday', 'wed', 'quarta']],
  ['thursday', ['thursday', 'thu', 'thur', 'quinta']],
  ['friday', ['friday', 'fri', 'sexta']],
  ['saturday', ['saturday', 'sat', 'sábado', 'sabado']],
  ['sunday', ['sunday', 'sun', 'domingo']],
];

function hasExplicitModalityPriority(input: TrainingProfileExtractionInput): boolean {
  const haystack = [
    input.objective,
    input.notes,
    input.fitnessProfile?.training_goals,
    input.gymProfile?.primary_goal,
    input.runProfile?.target_event,
    input.runProfile?.target_race,
  ].map((value) => String(value ?? '').toLowerCase()).join(' ');
  return /strength|força|gym|hypertrophy|running|run|corrida|cycling|bike|ciclismo|ride|triathlon/.test(haystack);
}

function hasExplicitTrainingPreference(input: TrainingProfileExtractionInput): boolean {
  return hasAnyProfileValue(
    input.notes,
    input.longWorkoutDay,
    input.preferredTime,
    input.preferredCardioTime,
    input.preferredStrengthTime,
    input.fitnessProfile?.preferred_training_days,
    input.fitnessProfile?.blocked_days,
    input.fitnessProfile?.preferences,
    input.fitnessProfile?.dislikes,
    input.fitnessProfile?.avoid,
    input.gymProfile?.preferred_training_days,
    input.gymProfile?.blocked_days,
    input.gymProfile?.preferences,
    input.gymProfile?.dislikes,
    input.runProfile?.preferred_training_days,
    input.runProfile?.blocked_days,
    input.runProfile?.preferences,
    input.runProfile?.dislikes,
  );
}

function shouldAskOutcomeFeedback(
  input: TrainingProfileExtractionInput,
  context: TrainingProfileExtractionContext,
): boolean {
  return totalTargetSessions(context.weeklyTargets) >= 3
    && !/too hard|too easy|too long|rpe|rir|sore|dor|difícil|facil/i.test(String(input.notes ?? ''));
}

function totalTargetSessions(targets: Goals['weeklySessionsTarget']): number {
  return Object.values(targets).reduce((sum, value) => sum + (value ?? 0), 0);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function numericOrUndefined(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function normalizeTime(preferredTime: string, fallback: string): string {
  const candidate = typeof preferredTime === 'string' ? preferredTime.trim() : '';
  if (/^\d{2}:\d{2}$/.test(candidate)) return candidate;
  return /^\d{2}:\d{2}$/.test(fallback) ? fallback : '12:00';
}

function normalizeDayOfWeek(value: unknown): DayOfWeek | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return DAY_ORDER.includes(normalized as DayOfWeek) ? normalized as DayOfWeek : null;
}

function hasAnyProfileValue(...values: unknown[]): boolean {
  return values.some((value) => {
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    return value !== null && value !== undefined;
  });
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupeText(values: Array<string | null | undefined | false>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function compact<T>(values: Array<T | null | undefined | false>): T[] {
  return values.filter(Boolean) as T[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

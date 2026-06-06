// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as onboarding from '../../services/onboarding';

export type ObjectiveProfileRequirement = {
  questionnaireId: string;
  title: string;
  missingFields: unknown[];
  message: string;
};

export type ObjectiveProfileSource = {
  getProfile?: (userId: number, questionnaireId: string) => { data?: Record<string, unknown> } | Record<string, unknown> | null | undefined;
  getMissingProfileFields?: (userId: number, questionnaireId: string) => unknown[];
  getQuestionnaire?: (questionnaireId: string) => { title?: string } | null | undefined;
};

export function objectiveNeedsRunningProfile(objective: string): boolean {
  return /(marathon|meia maratona|half marathon|10k|5k|corrida|running|run|trail|ultra)/i.test(objective);
}

export function objectiveNeedsGymProfile(objective: string): boolean {
  return /(hipertrofia|hypertrophy|muscle|strength|gym|massa|bodybuilding|força|muscula)/i.test(objective);
}

export function objectiveNeedsCyclingProfile(objective: string): boolean {
  return /(cycling|cycle|bike|biking|ride|riding|ciclismo|bicicleta|bici|gravel|gran fondo|time trial)/i.test(objective);
}

export function objectiveNeedsSwimProfile(objective: string): boolean {
  return /(swim|swimming|natação|natacao|pool|freestyle|crawl)/i.test(objective);
}

export function objectiveNeedsTriathlonProfiles(objective: string): boolean {
  return /(triathlon|ironman|70\.3|olympic tri|sprint tri|triatlo|tríatlo)/i.test(objective);
}

export function resolveObjectiveProfileRequirement(
  objective: string,
  userId: number,
  profileSource: ObjectiveProfileSource = onboarding,
): ObjectiveProfileRequirement | null {
  const lowerObjective = objective.trim();
  const maybeRequirement = (
    questionnaireId: string,
    message: string,
    criticalFields: readonly string[],
  ): ObjectiveProfileRequirement | null => {
    const profile = profileSource.getProfile?.(userId, questionnaireId);
    const profileData = profile && 'data' in profile ? profile.data : profile;
    const missingFields = profileSource.getMissingProfileFields?.(userId, questionnaireId) || [];
    if (!Array.isArray(missingFields) || missingFields.length === 0) return null;

    const hasStartedProfile =
      profileData && typeof profileData === 'object' && Object.keys(profileData).length > 0;
    if (hasStartedProfile && !hasCriticalMissingField(missingFields, criticalFields)) return null;

    const questionnaire = profileSource.getQuestionnaire?.(questionnaireId);
    return {
      questionnaireId,
      title: questionnaire?.title ?? questionnaireId,
      missingFields,
      message,
    };
  };

  if (objectiveNeedsTriathlonProfiles(lowerObjective)) {
    return maybeRequirement(
      'triathlon-running',
      'Complete your running profile first so triathlon planning can calibrate run load, race context, and availability.',
      ['weekly_mileage_km', 'easy_pace_min_per_km', 'target_race', 'target_race_date', 'weekly_availability_days'],
    ) ?? maybeRequirement(
      'triathlon-cycling',
      'Complete your cycling profile first so triathlon planning can calibrate bike load, FTP or effort, and ride availability.',
      ['ftp_watts', 'weekly_hours', 'weekly_availability_days'],
    ) ?? maybeRequirement(
      'triathlon-swim',
      'Complete your swim profile first so triathlon planning can calibrate pool access, stroke comfort, and swim frequency.',
      ['experience', 'primary_stroke', 'pool_access', 'sessions_per_week'],
    ) ?? maybeRequirement(
      'triathlon-gym',
      'Complete your strength profile first so triathlon planning can add safe strength support instead of generic lifting.',
      ['training_age', 'primary_goal', 'equipment_access', 'sessions_per_week'],
    );
  }

  if (objectiveNeedsRunningProfile(lowerObjective)) {
    return maybeRequirement(
      'triathlon-running',
      'Complete your running profile first so the plan can ask about race date, target event, current mileage, and workout preferences.',
      ['weekly_mileage_km', 'easy_pace_min_per_km', 'target_race', 'target_race_date', 'weekly_availability_days'],
    );
  }

  if (objectiveNeedsCyclingProfile(lowerObjective)) {
    return maybeRequirement(
      'triathlon-cycling',
      'Complete your cycling profile first so the plan can tailor bike volume, FTP or effort, and weekly ride availability.',
      ['ftp_watts', 'weekly_hours', 'weekly_availability_days'],
    );
  }

  if (objectiveNeedsSwimProfile(lowerObjective)) {
    return maybeRequirement(
      'triathlon-swim',
      'Complete your swim profile first so the plan can tailor swim frequency, pool access, and technique progression.',
      ['experience', 'primary_stroke', 'pool_access', 'sessions_per_week'],
    );
  }

  if (objectiveNeedsGymProfile(lowerObjective)) {
    return maybeRequirement(
      'triathlon-gym',
      'Complete your strength profile first so the plan can tailor exercise selection, equipment, and gym progression.',
      ['training_age', 'primary_goal', 'equipment_access', 'sessions_per_week'],
    );
  }

  return null;
}

function hasCriticalMissingField(missingFields: readonly unknown[], criticalFields: readonly string[]): boolean {
  const critical = new Set(criticalFields.map(normalizeFieldKey));
  return missingFields.some((field) => critical.has(normalizeFieldKey(field)));
}

function normalizeFieldKey(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return normalizeFieldKey(record.key ?? record.field ?? record.id ?? record.name);
  }
  return '';
}

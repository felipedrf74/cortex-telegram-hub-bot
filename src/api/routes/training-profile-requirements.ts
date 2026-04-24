// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as onboarding from '../../services/onboarding';

export type ObjectiveProfileRequirement = {
  questionnaireId: string;
  title: string;
  missingFields: unknown[];
  message: string;
};

export type ObjectiveProfileSource = {
  getMissingProfileFields?: (userId: number, questionnaireId: string) => unknown[];
  getQuestionnaire?: (questionnaireId: string) => { title?: string } | null | undefined;
};

export function objectiveNeedsRunningProfile(objective: string): boolean {
  return /(marathon|meia maratona|half marathon|10k|5k|corrida|running|run|trail|ultra)/i.test(objective);
}

export function objectiveNeedsGymProfile(objective: string): boolean {
  return /(hipertrofia|hypertrophy|muscle|strength|gym|massa|bodybuilding|força|muscula)/i.test(objective);
}

export function resolveObjectiveProfileRequirement(
  objective: string,
  userId: number,
  profileSource: ObjectiveProfileSource = onboarding,
): ObjectiveProfileRequirement | null {
  const lowerObjective = objective.trim();
  const maybeRequirement = (questionnaireId: string, message: string): ObjectiveProfileRequirement | null => {
    const missingFields = profileSource.getMissingProfileFields?.(userId, questionnaireId) || [];
    if (!Array.isArray(missingFields) || missingFields.length === 0) return null;
    const questionnaire = profileSource.getQuestionnaire?.(questionnaireId);
    return {
      questionnaireId,
      title: questionnaire?.title ?? questionnaireId,
      missingFields,
      message,
    };
  };

  if (objectiveNeedsRunningProfile(lowerObjective)) {
    return maybeRequirement(
      'triathlon-running',
      'Complete your running profile first so the plan can ask about race date, target event, current mileage, and workout preferences.',
    );
  }

  if (objectiveNeedsGymProfile(lowerObjective)) {
    return maybeRequirement(
      'triathlon-gym',
      'Complete your strength profile first so the plan can tailor exercise selection, equipment, and gym progression.',
    );
  }

  return null;
}

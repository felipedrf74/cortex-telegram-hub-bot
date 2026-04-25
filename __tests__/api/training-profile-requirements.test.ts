// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  objectiveNeedsGymProfile,
  objectiveNeedsRunningProfile,
  resolveObjectiveProfileRequirement,
  type ObjectiveProfileSource,
} from '../../src/api/routes/training-profile-requirements';

function fakeProfileSource(missingFieldsByQuestionnaire: Record<string, unknown[]>): ObjectiveProfileSource {
  return {
    getMissingProfileFields(_userId, questionnaireId) {
      return missingFieldsByQuestionnaire[questionnaireId] ?? [];
    },
    getQuestionnaire(questionnaireId) {
      return { title: `Title for ${questionnaireId}` };
    },
  };
}

describe('training profile requirements', () => {
  it('detects running and gym objectives without route-level coupling', () => {
    expect(objectiveNeedsRunningProfile('half marathon build')).toBe(true);
    expect(objectiveNeedsRunningProfile('trail race')).toBe(true);
    expect(objectiveNeedsRunningProfile('upper body hypertrophy')).toBe(false);

    expect(objectiveNeedsGymProfile('força e hipertrofia')).toBe(true);
    expect(objectiveNeedsGymProfile('gym strength')).toBe(true);
    expect(objectiveNeedsGymProfile('10k running')).toBe(false);
  });

  it('returns the running questionnaire requirement when running profile fields are missing', () => {
    const requirement = resolveObjectiveProfileRequirement(
      'marathon prep',
      7,
      fakeProfileSource({ 'triathlon-running': ['raceDate', 'weeklyMileage'] }),
    );

    expect(requirement).toEqual({
      questionnaireId: 'triathlon-running',
      title: 'Title for triathlon-running',
      missingFields: ['raceDate', 'weeklyMileage'],
      message: 'Complete your running profile first so the plan can ask about race date, target event, current mileage, and workout preferences.',
    });
  });

  it('returns the gym questionnaire requirement when strength profile fields are missing', () => {
    const requirement = resolveObjectiveProfileRequirement(
      'hypertrophy block',
      7,
      fakeProfileSource({ 'triathlon-gym': ['equipment'] }),
    );

    expect(requirement).toEqual({
      questionnaireId: 'triathlon-gym',
      title: 'Title for triathlon-gym',
      missingFields: ['equipment'],
      message: 'Complete your strength profile first so the plan can tailor exercise selection, equipment, and gym progression.',
    });
  });

  it('does not require every sport-profile field once a user has started that profile', () => {
    const requirement = resolveObjectiveProfileRequirement(
      'gym strength',
      7,
      {
        ...fakeProfileSource({ 'triathlon-gym': ['bench_1rm_kg', 'deadlift_1rm_kg'] }),
        getProfile(_userId, questionnaireId) {
          if (questionnaireId === 'triathlon-gym') {
            return { data: { training_age: '1-3 years', equipment_access: 'Full gym' } };
          }
          return null;
        },
      },
    );

    expect(requirement).toBeNull();
  });

  it('does not block plan generation when the objective does not need a missing profile', () => {
    expect(resolveObjectiveProfileRequirement('mobility and recovery', 7, fakeProfileSource({}))).toBeNull();
    expect(resolveObjectiveProfileRequirement('10k running', 7, fakeProfileSource({ 'triathlon-running': [] }))).toBeNull();
  });
});

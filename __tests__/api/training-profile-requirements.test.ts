// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  objectiveNeedsCyclingProfile,
  objectiveNeedsGymProfile,
  objectiveNeedsRunningProfile,
  objectiveNeedsSwimProfile,
  objectiveNeedsTriathlonProfiles,
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

    expect(objectiveNeedsCyclingProfile('gravel cycling base')).toBe(true);
    expect(objectiveNeedsSwimProfile('pool swim technique')).toBe(true);
    expect(objectiveNeedsTriathlonProfiles('Olympic triathlon build')).toBe(true);
  });

  it('returns the running questionnaire requirement when running profile fields are missing', () => {
    const requirement = resolveObjectiveProfileRequirement(
      'marathon prep',
      7,
      fakeProfileSource({ 'triathlon-running': ['weekly_mileage_km'] }),
    );

    expect(requirement).toEqual({
      questionnaireId: 'triathlon-running',
      title: 'Title for triathlon-running',
      missingFields: ['weekly_mileage_km'],
      message: 'Complete your running profile first so the plan can calibrate target context, current mileage, and workout preferences.',
    });
  });

  it('does not require target race date to complete a running profile', () => {
    const requirement = resolveObjectiveProfileRequirement(
      'marathon prep',
      7,
      {
        ...fakeProfileSource({ 'triathlon-running': ['target_race_date'] }),
        getProfile(_userId, questionnaireId) {
          if (questionnaireId === 'triathlon-running') {
            return {
              data: {
                target_race: 'Marathon',
                weekly_mileage_km: '35',
                easy_pace_min_per_km: '5:30',
                weekly_availability_days: '5',
              },
            };
          }
          return null;
        },
      },
    );

    expect(requirement).toBeNull();
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

  it('still requires critical missing fields after a partial sport profile exists', () => {
    const requirement = resolveObjectiveProfileRequirement(
      'gym strength',
      7,
      {
        ...fakeProfileSource({ 'triathlon-gym': ['equipment_access'] }),
        getProfile(_userId, questionnaireId) {
          if (questionnaireId === 'triathlon-gym') {
            return { data: { training_age: '1-3 years' } };
          }
          return null;
        },
      },
    );

    expect(requirement?.questionnaireId).toBe('triathlon-gym');
    expect(requirement?.missingFields).toEqual(['equipment_access']);
  });

  it('returns cycling and swim questionnaire requirements for sport-specific objectives', () => {
    expect(resolveObjectiveProfileRequirement(
      'cycling FTP build',
      7,
      fakeProfileSource({ 'triathlon-cycling': ['ftp_watts', 'weekly_hours'] }),
    )?.questionnaireId).toBe('triathlon-cycling');

    expect(resolveObjectiveProfileRequirement(
      'swim technique plan',
      7,
      fakeProfileSource({ 'triathlon-swim': ['primary_stroke', 'pool_access'] }),
    )?.questionnaireId).toBe('triathlon-swim');
  });

  it('returns the first missing triathlon sport profile requirement in planning order', () => {
    const requirement = resolveObjectiveProfileRequirement(
      'Olympic triathlon build',
      7,
      fakeProfileSource({
        'triathlon-running': [],
        'triathlon-cycling': ['ftp_watts'],
        'triathlon-swim': ['primary_stroke'],
      }),
    );

    expect(requirement?.questionnaireId).toBe('triathlon-cycling');
  });

  it('does not block plan generation when the objective does not need a missing profile', () => {
    expect(resolveObjectiveProfileRequirement('mobility and recovery', 7, fakeProfileSource({}))).toBeNull();
    expect(resolveObjectiveProfileRequirement('10k running', 7, fakeProfileSource({ 'triathlon-running': [] }))).toBeNull();
  });
});

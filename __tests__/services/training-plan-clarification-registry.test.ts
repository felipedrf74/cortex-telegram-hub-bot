// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase 2 (F2) — allowlisted clarification resolution registry.
 *
 * The registry's option constants are deliberately NOT imported from
 * onboarding at runtime (route suites mock that module away), so this suite
 * is the drift-guard: it pins the allowlist against the REAL questionnaire
 * definitions and pins the severity contract the plan requires.
 */

import { describe, expect, it, vi } from 'vitest';

const mockGetProfile = vi.fn();

vi.mock('../../src/services/onboarding', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/onboarding')>(
    '../../src/services/onboarding',
  );
  return {
    ...actual,
    getProfile: (...args: unknown[]) => mockGetProfile(...args),
  };
});

import { QUESTIONNAIRES } from '../../src/services/onboarding';
import {
  GYM_EQUIPMENT_ACCESS_OPTIONS,
  fingerprintTrainingPlanClarificationAnswers,
  parseSessionDurationMinutesAnswer,
  resolveTrainingPlanClarificationResolution,
} from '../../src/services/training-plan-clarification-registry';
import {
  assessTrainingPlanSpecReadiness,
  buildTrainingPlanSpec,
  type TrainingPlanSpecClarificationId,
} from '../../src/services/training-plan-spec';

describe('training-plan-clarification-registry', () => {
  it('keeps the equipment allowlist byte-identical to the canonical questionnaire options', () => {
    const step = QUESTIONNAIRES['triathlon-gym']?.steps.find(
      (candidate) => candidate.key === 'equipment_access',
    );
    expect(step?.options).toEqual([...GYM_EQUIPMENT_ACCESS_OPTIONS]);
  });

  it('resolves every clarification id to an allowlisted target or an explicit null', () => {
    const ids: TrainingPlanSpecClarificationId[] = [
      'equipment_clarification',
      'session_duration_clarification',
      'modality_priority_clarification',
      'recovery_feedback_clarification',
    ];
    for (const id of ids) {
      const resolution = resolveTrainingPlanClarificationResolution(id);
      if (id === 'modality_priority_clarification') {
        // The endurance schedule derives from generated plan content, not a
        // profile field — pointing at a wrong field would be worse than
        // staying informational.
        expect(resolution).toBeNull();
        continue;
      }
      expect(resolution).not.toBeNull();
      expect(resolution!.profileType).toMatch(/^(triathlon-gym|fitness)$/);
      for (const field of resolution!.fields) {
        expect(field.fieldKey).toMatch(/^[a-z_]+$/);
        if (field.answerType === 'choice') {
          expect(field.allowedValues && field.allowedValues.length).toBeGreaterThan(0);
        }
        if (field.answerType === 'number') {
          expect(field.min).toBeGreaterThan(0);
          expect(field.max).toBeGreaterThan(field.min!);
        }
      }
    }
  });

  it('treats out-of-bounds or malformed session duration answers as unanswered', () => {
    expect(parseSessionDurationMinutesAnswer({ session_duration_minutes: 60 })).toBe(60);
    expect(parseSessionDurationMinutesAnswer({ session_duration_minutes: '45' })).toBe(45);
    expect(parseSessionDurationMinutesAnswer({ session_duration_minutes: '45.4' })).toBe(45);
    expect(parseSessionDurationMinutesAnswer({ session_duration_minutes: 19 })).toBeUndefined();
    expect(parseSessionDurationMinutesAnswer({ session_duration_minutes: 181 })).toBeUndefined();
    expect(parseSessionDurationMinutesAnswer({ session_duration_minutes: 'ninety' })).toBeUndefined();
    expect(parseSessionDurationMinutesAnswer({})).toBeUndefined();
    expect(parseSessionDurationMinutesAnswer(null)).toBeUndefined();
  });

  it('changes the answers fingerprint when an allowlisted answer changes and only then', () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'triathlon-gym') return { equipment_access: 'Full commercial gym' };
      if (questionnaireId === 'fitness') return { readiness: 'normal', unrelated_field: 'a' };
      return null;
    });
    const base = fingerprintTrainingPlanClarificationAnswers(12);
    expect(fingerprintTrainingPlanClarificationAnswers(12)).toBe(base);

    // Unrelated profile churn must NOT invalidate the auto-dedupe window.
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'triathlon-gym') return { equipment_access: 'Full commercial gym' };
      if (questionnaireId === 'fitness') return { readiness: 'normal', unrelated_field: 'CHANGED' };
      return null;
    });
    expect(fingerprintTrainingPlanClarificationAnswers(12)).toBe(base);

    // An allowlisted answer change must produce a fresh fingerprint.
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'triathlon-gym') {
        return { equipment_access: 'Full commercial gym', session_duration_minutes: 60 };
      }
      if (questionnaireId === 'fitness') return { readiness: 'normal', unrelated_field: 'a' };
      return null;
    });
    expect(fingerprintTrainingPlanClarificationAnswers(12)).not.toBe(base);
  });

  it('preserves severity: warnings carry resolutions but never gate readiness', () => {
    // Hybrid goal + no endurance schedule + no recovery profile → two
    // warnings; equipment known and duration present → no blockers.
    const spec = buildTrainingPlanSpec({
      userId: 12,
      objective: 'hybrid strength and running',
      daysPerWeek: 5,
      startDate: '2026-08-03',
      equipmentProfileLabel: 'full_gym',
      availableEquipment: ['barbell'],
      sessionDurationMinutes: 60,
      fitnessProfile: { training_goals: 'Strength, Endurance' },
      gymProfile: {},
    });
    const readiness = assessTrainingPlanSpecReadiness(spec);
    expect(readiness.issues.length).toBeGreaterThan(0);
    expect(readiness.issues.every((issue) => issue.severity === 'warning')).toBe(true);
    // The plan's severity contract: warning-only issues never block.
    expect(readiness.status).toBe('ready');
    // Warnings still expose resolution metadata (or an explicit null) so
    // they are answerable refinements, not dead text.
    for (const issue of readiness.issues) {
      expect(issue).toHaveProperty('resolution');
    }
  });

  it('only equipment and session duration can ever block', () => {
    const spec = buildTrainingPlanSpec({
      userId: 12,
      objective: 'strength block',
      daysPerWeek: 5,
      startDate: '2026-08-03',
      equipmentProfileLabel: null,
      availableEquipment: [],
      fitnessProfile: null,
      gymProfile: {},
    });
    const readiness = assessTrainingPlanSpecReadiness(spec);
    expect(readiness.status).toBe('needs_clarification');
    const blockerIds = readiness.issues
      .filter((issue) => issue.severity === 'blocker')
      .map((issue) => issue.id)
      .sort();
    expect(blockerIds).toEqual(['equipment_clarification', 'session_duration_clarification']);
    for (const issue of readiness.issues.filter((candidate) => candidate.severity === 'blocker')) {
      expect(issue.resolution).not.toBeNull();
    }
  });
});

// Phase 13 batch 71 (2026-05-16): training intent detector tests.
//
// Extracted from `src/domains/domain-handler.ts` to the per-skill module.
// These tests pin the broad set of phrasings the detector catches.

import { describe, expect, it } from 'vitest';

import {
  classifyTrainingPrescriptionIntent,
  isTrainingPrescriptionIntent,
} from '../../../src/services/skills/training/intent-detectors';

describe('isTrainingPrescriptionIntent (Phase 13 batch 71)', () => {
  it.each([
    'Create a new training plan',
    'Build me a workout plan',
    'Generate a tempo run for tomorrow',
    'Prescribe a CSS test',
    'Give me a 5x5 strength block',
    'What workout should I do today',
    'How should I train this week',
    'Cria um plano de treino',
    'Faz um treino de bench press',
    'Que treino devo fazer hoje',
    'Como devo treinar nesta semana',
    'Plano de treino para o triathlon',
  ])('detects "%s" as a training-prescription intent', (text) => {
    expect(isTrainingPrescriptionIntent(text)).toBe(true);
  });

  it.each([
    'Hello, how are you?',
    'Schedule a meeting tomorrow',
    'Cancel my dentist appointment',
    'Pay the credit card bill',
  ])('does not falsely flag "%s"', (text) => {
    expect(isTrainingPrescriptionIntent(text)).toBe(false);
  });

  it('returns a typed classification for modality-specific prescription requests', () => {
    const result = classifyTrainingPrescriptionIntent('Build me a triathlon training plan');

    expect(result).toMatchObject({
      isTrainingPrescription: true,
      kind: 'plan_create',
      modality: 'triathlon',
    });
    expect(result.matchedSignals).toContain('triathlon_plan');
  });

  it('marks ambiguous training context for semantic fallback instead of silently routing by regex only', () => {
    const result = classifyTrainingPrescriptionIntent('I am unsure about tomorrow training load');

    expect(result).toMatchObject({
      isTrainingPrescription: false,
      requiresSemanticFallback: true,
    });
  });
});

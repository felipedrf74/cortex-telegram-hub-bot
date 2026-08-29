import { describe, expect, it } from 'vitest';
import { QUESTIONNAIRES } from '../../src/services/onboarding';
import { localizeOnboardingQuestionnaire } from '../../src/services/onboarding-localization';

describe('training questionnaire pt-PT wire copy', () => {
  it('localizes swim prompts and gear labels while preserving canonical values', () => {
    const localized = localizeOnboardingQuestionnaire(
      QUESTIONNAIRES['triathlon-swim'],
      'pt-PT',
    );

    const sessions = localized.steps.find((step) => step.key === 'sessions_per_week');
    expect(sessions?.prompt).toBe('Quantas sessões de natação podes fazer por semana?');

    const gear = localized.steps.find((step) => step.key === 'equipment_access');
    expect(gear?.options).toEqual([
      'Pull buoy', 'Paddles', 'Fins', 'Snorkel', 'Kickboard', 'Tempo trainer', 'None yet',
    ]);
    expect(gear?.optionLabels).toEqual([
      'Flutuador de pernas', 'Palas', 'Barbatanas', 'Tubo frontal',
      'Prancha', 'Metrónomo de natação', 'Ainda nenhum',
    ]);
  });

  it('locks accented fitness copy and leaves English requests unchanged', () => {
    const localized = localizeOnboardingQuestionnaire(QUESTIONNAIRES.fitness, 'pt-PT');
    expect(localized.steps[0].prompt).toBe('Qual é o teu nível de experiência com treino?');
    expect(localized.steps[0].optionLabels).toContain('Intermédio (1-3 anos)');

    const english = localizeOnboardingQuestionnaire(QUESTIONNAIRES.fitness, 'en-US');
    expect(english).toBe(QUESTIONNAIRES.fitness);
  });
});

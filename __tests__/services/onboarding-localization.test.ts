import { describe, expect, it } from 'vitest';
import { QUESTIONNAIRES } from '../../src/services/onboarding';
import { localizeOnboardingQuestionnaire } from '../../src/services/onboarding-localization';

describe('Training onboarding localization', () => {
  it('localizes pt-PT prompts and labels while preserving canonical option values', () => {
    const localized = localizeOnboardingQuestionnaire(QUESTIONNAIRES['triathlon-swim'], 'pt-PT');
    const sessions = localized.steps.find((step) => step.key === 'sessions_per_week');
    const equipment = localized.steps.find((step) => step.key === 'equipment_access');

    expect(sessions?.prompt).toBe('Quantas sessões de natação podes fazer por semana?');
    expect(equipment?.options?.[0]).toBe('Pull buoy');
    expect(equipment?.optionLabels?.[0]).toBe('Flutuador de pernas');
  });

  it('uses Brazilian Portuguese copy independently from European Portuguese', () => {
    const ptBR = localizeOnboardingQuestionnaire(QUESTIONNAIRES.fitness, 'pt-BR');
    const ptPT = localizeOnboardingQuestionnaire(QUESTIONNAIRES.fitness, 'pt-PT');

    expect(ptBR.steps[0].prompt).toBe('Qual é o seu nível de experiência com treino?');
    expect(ptPT.steps[0].prompt).toBe('Qual é o teu nível de experiência com treino?');
    expect(ptBR.steps[0].options).toEqual(QUESTIONNAIRES.fitness.steps[0].options);
  });

  it('returns the canonical definition unchanged for English', () => {
    expect(localizeOnboardingQuestionnaire(QUESTIONNAIRES.fitness, 'en-US'))
      .toBe(QUESTIONNAIRES.fitness);
  });
});

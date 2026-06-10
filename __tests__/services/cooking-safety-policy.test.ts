import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildCookingPreferenceReadModel: vi.fn(() => ({
    profile: {},
    memories: [],
    summary: '',
    skillMemorySummary: '',
  })),
}));

vi.mock('../../src/services/cooking-preferences', () => ({
  buildCookingPreferenceReadModel: (...args: unknown[]) => mocks.buildCookingPreferenceReadModel(...args),
}));

import {
  evaluateCookingSafetyText,
  evaluateCookingSafetyTextForProfile,
  hasCookingSafetyPreferences,
  renderCookingSafetyBlockedResponse,
  renderCookingSafetyPromptBlock,
} from '../../src/services/cooking-safety-policy';

describe('cooking-safety-policy', () => {
  beforeEach(() => {
    mocks.buildCookingPreferenceReadModel.mockReset();
    mocks.buildCookingPreferenceReadModel.mockReturnValue({
      profile: {},
      memories: [],
      summary: '',
      skillMemorySummary: '',
    });
  });

  it('blocks generated legacy advice that mentions a stored Portuguese allergen alias', () => {
    const evaluation = evaluateCookingSafetyTextForProfile(
      { allergies: ['marisco'] },
      'legacy_domain_answer',
      ['Faça um arroz de camarão com legumes.'],
    );

    expect(evaluation.blocked).toBe(true);
    expect(evaluation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ALLERGY_CONFLICT',
        surface: 'legacy_domain_answer',
        term: 'marisco',
        source: 'cooking_preference_profile',
      }),
    ]));
  });

  it.each([
    ['vegetarian', 'grilled chicken bowl'],
    ['vegan', 'omelet with cheese'],
    ['gluten-free', 'wheat pasta'],
    ['dairy-free', 'butter sauce'],
  ])('hard-blocks generated advice for saved dietary restriction %s', (restriction, text) => {
    const evaluation = evaluateCookingSafetyTextForProfile(
      { dietaryRestrictions: [restriction] },
      'chat_core_v2_recipe',
      [text],
    );

    expect(evaluation.blocked).toBe(true);
    expect(evaluation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'DIETARY_RESTRICTION_CONFLICT',
        term: restriction,
      }),
    ]));
  });

  it('allows safe generated advice when no preference conflicts are found', () => {
    const evaluation = evaluateCookingSafetyTextForProfile(
      { allergies: ['peanuts'], dietaryRestrictions: ['vegetarian'] },
      'chat_core_v2_cooking',
      ['Try lentils with rice, olive oil, and roasted vegetables.'],
    );

    expect(evaluation).toEqual({
      blocked: false,
      surface: 'chat_core_v2_cooking',
      issues: [],
    });
  });

  it('blocks compound foods with known hidden-allergen aliases', () => {
    const evaluation = evaluateCookingSafetyTextForProfile(
      { allergies: ['tree nut'] },
      'recipe',
      ['Pasta with pesto and tomatoes.'],
    );

    expect(evaluation.blocked).toBe(true);
    expect(evaluation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ALLERGY_CONFLICT',
        source: 'compound_food_alias',
        term: 'tree nut',
      }),
    ]));
  });

  it('blocks worcestershire sauce when a fish allergy is stored in Portuguese', () => {
    const evaluation = evaluateCookingSafetyTextForProfile(
      { allergies: ['peixe'] },
      'chat_core_v2_cooking',
      ['Use Worcestershire sauce in the dressing.'],
    );

    expect(evaluation.blocked).toBe(true);
    expect(evaluation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ALLERGY_CONFLICT',
        source: 'compound_food_alias',
        term: 'peixe',
      }),
    ]));
  });

  it('fails closed when the scoped cooking safety profile cannot be loaded', () => {
    const evaluation = evaluateCookingSafetyText(
      0,
      0,
      'chat_core_v2_recipe',
      ['Peanut noodles with crushed peanuts.'],
    );

    expect(evaluation.blocked).toBe(true);
    expect(evaluation.issues).toEqual([
      expect.objectContaining({
        code: 'SAFETY_PROFILE_UNAVAILABLE',
        source: 'safety_profile_unavailable',
      }),
    ]);
  });

  it('detects whether a scoped user has cooking safety preferences and fails closed on invalid scope', () => {
    mocks.buildCookingPreferenceReadModel.mockReturnValueOnce({
      profile: { allergies: ['sesame'] },
      memories: [],
      summary: '',
      skillMemorySummary: '',
    });
    expect(hasCookingSafetyPreferences(42, 84)).toBe(true);

    mocks.buildCookingPreferenceReadModel.mockReturnValueOnce({
      profile: { dietaryRestrictions: ['dairy-free'] },
      memories: [],
      summary: '',
      skillMemorySummary: '',
    });
    expect(hasCookingSafetyPreferences(42, 84)).toBe(true);

    mocks.buildCookingPreferenceReadModel.mockReturnValueOnce({
      profile: {},
      memories: [],
      summary: '',
      skillMemorySummary: '',
    });
    expect(hasCookingSafetyPreferences(42, 84)).toBe(false);

    expect(hasCookingSafetyPreferences(0, 84)).toBe(true);
  });

  it('fails closed when cooking safety preference presence cannot be read', () => {
    mocks.buildCookingPreferenceReadModel.mockImplementationOnce(() => {
      throw new Error('db unavailable');
    });

    expect(hasCookingSafetyPreferences(42, 84)).toBe(true);
  });

  it('renders shared prompt and localized refusal copy', () => {
    expect(renderCookingSafetyPromptBlock({
      allergies: ['peanuts'],
      dietaryRestrictions: ['vegan'],
    })).toContain('Treat these as hard constraints');
    expect(renderCookingSafetyBlockedResponse('pt-BR')).toContain('preferência de segurança culinária');
    expect(renderCookingSafetyBlockedResponse('es')).toContain('preferencia de seguridad culinaria');
  });
});

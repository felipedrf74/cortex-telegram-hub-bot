import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCompleteOneShotWithSearch } = vi.hoisted(() => ({
  mockCompleteOneShotWithSearch: vi.fn(),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithSearch: mockCompleteOneShotWithSearch,
}));

import { buildChatInternetResearchAnswer } from '../../src/services/chat-internet-research';

describe('chat internet research', () => {
  beforeEach(() => {
    mockCompleteOneShotWithSearch.mockReset();
  });

  it('uses the existing search-grounded provider path and returns compact source metadata', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Use official food-safety guidance for leftovers.',
      sources: ['https://foodsafety.example/leftovers', 'https://foodsafety.example/leftovers'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'latest safety guidance for chicken leftovers',
      language: 'en',
      skill: 'cooking',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledWith(
      expect.stringContaining('<stable_system_policy>'),
      expect.stringContaining('latest safety guidance for chicken leftovers'),
      'chat_internet_research',
      expect.objectContaining({ userId: 123, tenantId: 456, temperature: 0.35 }),
    );
    expect(result.degraded).toBe(false);
    expect(result.sources).toEqual(['https://foodsafety.example/leftovers']);
    expect(result.context?.cacheablePrefixHash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.text).toContain('Sources consulted: https://foodsafety.example/leftovers');
  });

  it('fails honestly instead of answering current claims without web grounding', async () => {
    mockCompleteOneShotWithSearch.mockRejectedValueOnce(new Error('Gemini unavailable'));

    const result = await buildChatInternetResearchAnswer({
      message: 'qual é o câmbio atual EUR BRL?',
      language: 'pt',
      skill: 'finance',
      expectedResponseShape: 'finance_summary',
      userId: 123,
      tenantId: 456,
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('web_research_unavailable');
    expect(result.sources).toEqual([]);
    expect(result.text).toContain('pesquisa web não está disponível');
  });

  it.each([
    ['secretary' as const, 'show my latest tasks and Lisbon weather', 'Calendar: 09:00 Standup\nTasks: Pay invoice'],
    ['training' as const, 'I have knee pain, should I train today?', 'Readiness: low\nToday workout: intervals'],
  ])('carries scoped local state into local-and-web research prompts for %s', async (skill, message, localContext) => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Use the local facts plus current public sources.',
      sources: ['https://example.com/current'],
    });

    const result = await buildChatInternetResearchAnswer({
      message,
      language: 'en',
      skill,
      expectedResponseShape: skill === 'training' ? 'training_advice' : 'agenda_summary',
      groundingRequired: 'local_and_web',
      localContext,
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledWith(
      expect.stringContaining('combine them with current web sources'),
      expect.stringContaining(localContext),
      'chat_internet_research',
      expect.objectContaining({ userId: 123, tenantId: 456 }),
    );
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[1]).toContain(message);
    expect(result.context?.localContextIncluded).toBe(true);
  });
});

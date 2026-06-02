import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCompleteOneShotWithSearch } = vi.hoisted(() => ({
  mockCompleteOneShotWithSearch: vi.fn(),
}));
const { mockTrackedCreate, mockAnthropicGet } = vi.hoisted(() => ({
  mockTrackedCreate: vi.fn(),
  mockAnthropicGet: vi.fn(),
}));
const { mockCompleteOneShotWithOpenAIWebSearch, mockIsOpenAIConfigured } = vi.hoisted(() => ({
  mockCompleteOneShotWithOpenAIWebSearch: vi.fn(),
  mockIsOpenAIConfigured: vi.fn(),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithSearch: mockCompleteOneShotWithSearch,
}));
vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: mockTrackedCreate,
}));
vi.mock('../../src/services/anthropic-lazy-client', () => ({
  createLazyAnthropicClient: () => ({
    get: mockAnthropicGet,
    peekForTest: vi.fn(),
    resetForTest: vi.fn(),
  }),
}));
vi.mock('../../src/services/openai-provider', () => ({
  completeOneShotWithWebSearch: mockCompleteOneShotWithOpenAIWebSearch,
  isOpenAIConfigured: mockIsOpenAIConfigured,
}));

import {
  buildChatInternetResearchAnswer,
  buildChatInternetResearchSafeQueryPacket,
  isResearchProviderRefusal,
  normalizeResearchAnswerText,
} from '../../src/services/chat-internet-research';

describe('chat internet research', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('CHAT_INTERNET_RESEARCH_RETRY_DELAY_MS', '0');
    mockCompleteOneShotWithSearch.mockReset();
    mockTrackedCreate.mockReset();
    mockAnthropicGet.mockReset();
    mockCompleteOneShotWithOpenAIWebSearch.mockReset();
    mockIsOpenAIConfigured.mockReset();
    mockIsOpenAIConfigured.mockReturnValue(false);
    mockAnthropicGet.mockReturnValue({ messages: { create: vi.fn() } });
  });

  afterEach(() => {
    vi.useRealTimers();
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
      expect.objectContaining({ userId: 123, tenantId: 456, temperature: 0.35, maxTokens: 2400 }),
    );
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[0]).toContain('Keep the answer complete but concise');
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[0]).toContain('Do not trail off mid-sentence');
    expect(result.degraded).toBe(false);
    expect(result.sources).toEqual(['https://foodsafety.example/leftovers']);
    expect(result.context?.cacheablePrefixHash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.context?.safeQueryPolicy).toBe('public_query_only');
    expect(result.text).toContain('Sources consulted: https://foodsafety.example/leftovers');
  });

  it('retries transient web-search failures before returning a grounded answer', async () => {
    mockCompleteOneShotWithSearch
      .mockRejectedValueOnce(new Error('Gemini transient unavailable'))
      .mockResolvedValueOnce({
        text: 'Use current official public guidance for the answer.',
        sources: ['https://example.com/current-guidance'],
      });

    const result = await buildChatInternetResearchAnswer({
      message: 'latest safety guidance for chicken leftovers',
      language: 'en',
      skill: 'cooking',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(2);
    expect(result.degraded).toBe(false);
    expect(result.sources).toEqual(['https://example.com/current-guidance']);
  });

  it('uses bounded exponential spacing between repeated web-search retries', async () => {
    vi.stubEnv('CHAT_INTERNET_RESEARCH_MAX_ATTEMPTS', '3');
    vi.stubEnv('CHAT_INTERNET_RESEARCH_RETRY_DELAY_MS', '5');
    vi.stubEnv('CHAT_INTERNET_RESEARCH_RETRY_BACKOFF_MULTIPLIER', '3');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mockCompleteOneShotWithSearch
      .mockRejectedValueOnce(new Error('Gemini 503 high demand'))
      .mockRejectedValueOnce(new Error('Gemini 503 high demand'))
      .mockResolvedValueOnce({
        text: 'Use current official public guidance for the answer.',
        sources: ['https://example.com/current-guidance'],
      });

    const result = await buildChatInternetResearchAnswer({
      message: 'latest safety guidance for chicken leftovers',
      language: 'en',
      skill: 'cooking',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });
    const retryDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((value): value is number => typeof value === 'number');
    expect(retryDelays).toEqual(expect.arrayContaining([5, 15]));
    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(3);
    expect(result.degraded).toBe(false);
    expect(result.sources).toEqual(['https://example.com/current-guidance']);
    setTimeoutSpy.mockRestore();
  });

  it('fails honestly instead of answering current claims without web grounding', async () => {
    mockCompleteOneShotWithSearch.mockRejectedValue(new Error('Gemini unavailable'));

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
    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(2);
    expect(mockTrackedCreate).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithOpenAIWebSearch).not.toHaveBeenCalled();
  });

  it('falls back to Anthropic web search after the primary search provider exhausts safely', async () => {
    vi.stubEnv('ANTHROPIC_ENABLED', 'true');
    mockCompleteOneShotWithSearch.mockRejectedValue(new Error('Gemini unavailable'));
    mockTrackedCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: 'Public guidance says to stop if pain worsens.',
        citations: [{ url: 'https://example.com/knee-pain-guidance' }],
      }],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'I have knee pain, should I train today?',
      language: 'en',
      skill: 'training',
      expectedResponseShape: 'training_advice',
      groundingRequired: 'local_and_web',
      localContext: 'Private workout: intervals\nReadiness: low',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(2);
    expect(mockTrackedCreate).toHaveBeenCalledTimes(1);
    expect(mockTrackedCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: expect.any(String),
        system: expect.stringContaining('<stable_system_policy>'),
        messages: [expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('public health and training guidance for person has knee pain'),
        })],
        tools: [expect.objectContaining({ type: 'web_search_20250305', name: 'web_search' })],
      }),
      'chat_internet_research_anthropic_web_search',
      expect.objectContaining({ userId: 123, tenantId: 456 }),
    );
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ maxTokens: 3000 }),
    );
    const fallbackPrompt = mockTrackedCreate.mock.calls[0]?.[1]?.messages?.[0]?.content;
    expect(fallbackPrompt).not.toContain('Private workout');
    expect(fallbackPrompt).not.toContain('Readiness');
    expect(result.degraded).toBe(false);
    expect(result.sources).toEqual(['https://example.com/knee-pain-guidance']);
    expect(result.text).toContain('Sources consulted: https://example.com/knee-pain-guidance');
  });

  it('uses the explicit OpenAI web-search fallback without raw local context', async () => {
    vi.stubEnv('CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK', 'true');
    mockIsOpenAIConfigured.mockReturnValue(true);
    mockCompleteOneShotWithSearch.mockRejectedValue(new Error('Gemini unavailable'));
    mockCompleteOneShotWithOpenAIWebSearch.mockResolvedValueOnce({
      text: 'Public sources say to stop if pain worsens.',
      sources: ['https://example.com/public-knee-warning-signs'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'I have knee pain, should I train today?',
      language: 'en',
      skill: 'training',
      expectedResponseShape: 'training_advice',
      groundingRequired: 'local_and_web',
      localContext: 'Private workout: intervals\nReadiness: low',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(2);
    expect(mockTrackedCreate).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledTimes(1);
    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledWith(
      expect.stringContaining('<stable_system_policy>'),
      expect.stringContaining('public health and training guidance for person has knee pain'),
      'chat_internet_research_openai_web_search',
      expect.objectContaining({ userId: 123, tenantId: 456 }),
    );
    const fallbackPrompt = mockCompleteOneShotWithOpenAIWebSearch.mock.calls[0]?.[1];
    expect(fallbackPrompt).not.toContain('Private workout');
    expect(fallbackPrompt).not.toContain('Readiness');
    expect(result.degraded).toBe(false);
    expect(result.sources).toEqual(['https://example.com/public-knee-warning-signs']);
    expect(result.text).toContain('Sources consulted: https://example.com/public-knee-warning-signs');
  });

  it('treats provider safe-answer refusals as failures so configured fallbacks can answer', async () => {
    vi.stubEnv('CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK', 'true');
    mockIsOpenAIConfigured.mockReturnValue(true);
    mockCompleteOneShotWithSearch.mockResolvedValue({
      text: 'I could not produce a safe answer for that request.',
      sources: [],
    });
    mockCompleteOneShotWithOpenAIWebSearch.mockResolvedValueOnce({
      text: 'Public EU guidance summarizes the upcoming obligations.',
      sources: ['https://example.eu/ai-act'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search current sources for the main EU AI Act obligations that start applying in 2026.',
      language: 'en',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(2);
    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(false);
    expect(result.text).toContain('Public EU guidance');
    expect(result.text).toContain('Sources consulted: https://example.eu/ai-act');
  });

  it('treats truncated research answers as failures so configured fallbacks can answer', async () => {
    vi.stubEnv('CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK', 'true');
    mockIsOpenAIConfigured.mockReturnValue(true);
    mockCompleteOneShotWithSearch.mockResolvedValue({
      text: 'Public sources say the requirements include',
      sources: ['https://example.gov/incomplete'],
    });
    mockCompleteOneShotWithOpenAIWebSearch.mockResolvedValueOnce({
      text: 'Official public sources list passport validity, completed forms, and applicable entry permissions.',
      sources: ['https://example.gov/entry-requirements'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search public sources for Portugal visa entry requirements in 2026.',
      language: 'en',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(2);
    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(false);
    expect(result.text).toContain('passport validity');
    expect(result.text).toContain('Sources consulted: https://example.gov/entry-requirements');
  });

  it('treats long clipped research answers without terminal punctuation as failures', async () => {
    vi.stubEnv('CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK', 'true');
    mockIsOpenAIConfigured.mockReturnValue(true);
    mockCompleteOneShotWithSearch.mockResolvedValue({
      text: `${'Official public sources describe the application timeline, required forms, appointment steps, document checklist, and fee categories. '.repeat(7)}The remaining requirement is`,
      sources: ['https://example.gov/incomplete-long'],
    });
    mockCompleteOneShotWithOpenAIWebSearch.mockResolvedValueOnce({
      text: 'Official public sources list passport validity, application forms, appointment steps, fee categories, and applicable entry permissions.',
      sources: ['https://example.gov/entry-requirements'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search public sources for Portugal visa entry requirements in 2026.',
      language: 'en',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(2);
    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(false);
    expect(result.text).toContain('passport validity');
  });

  it('treats bare legal-advice refusals as failures but accepts public-information disclaimers', async () => {
    vi.stubEnv('CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK', 'true');
    mockIsOpenAIConfigured.mockReturnValue(true);
    mockCompleteOneShotWithSearch.mockResolvedValue({
      text: "I can't provide legal advice.",
      sources: [],
    });
    mockCompleteOneShotWithOpenAIWebSearch.mockResolvedValueOnce({
      text: 'I cannot provide legal advice, but official public sources summarize the entry requirements.',
      sources: ['https://example.gov/entry-requirements'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search public sources for Portugal visa entry requirements in 2026.',
      language: 'en',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(2);
    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(false);
    expect(result.text).toContain('official public sources');
    expect(result.text).toContain('Sources consulted: https://example.gov/entry-requirements');
  });

  it('passes a hard Spanish output-language contract to web-search providers', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'La respuesta está en español y resume fuentes públicas actuales.',
      sources: ['https://example.com/fuente-publica'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search noticias recientes sobre inflación en América Latina esta semana.',
      language: 'es',
      skill: 'finance',
      expectedResponseShape: 'finance_summary',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledWith(
      expect.stringContaining('Answer in Spanish. This is a hard contract'),
      expect.stringContaining('Search noticias recientes'),
      'chat_internet_research',
      expect.objectContaining({ userId: 123, tenantId: 456 }),
    );
    const systemPrompt = mockCompleteOneShotWithSearch.mock.calls[0]?.[0];
    expect(systemPrompt).toContain('Output language: Spanish');
    expect(systemPrompt).toContain('do not answer Spanish prompts in Portuguese');
    expect(result.text).toContain('Fuentes consultadas: https://example.com/fuente-publica');
  });

  it('strips provider-emitted Portuguese source footers and appends the Spanish footer', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'La respuesta está en español.\n\nFontes consultadas: https://provider.example/pt-footer',
      sources: ['https://example.com/fuente-publica'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search fuentes públicas sobre el marcador de la Copa Libertadores.',
      language: 'es',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(result.text).not.toContain('Fontes consultadas');
    expect(result.text).toContain('Fuentes consultadas: https://example.com/fuente-publica');
  });

  it('uses a neutral source footer for mixed-language research instead of defaulting to Portuguese', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Respuesta en español con terminos en English.\n\nFontes consultadas: https://provider.example/pt-footer',
      sources: ['https://example.com/source'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search fuentes actuales about SaaS benchmarks, keep mixed language.',
      language: 'mixed',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(result.text).not.toContain('Fontes consultadas');
    expect(result.text).toContain('Sources consulted: https://example.com/source');
  });

  it('tells providers to prefer peer-reviewed or official sources for scientific research', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Zone 2 training has public evidence, but source quality varies.',
      sources: ['https://example.com/science-summary'],
    });

    await buildChatInternetResearchAnswer({
      message: 'Search fontes científicas sobre zone 2 training benefits for endurance athletes.',
      language: 'mixed',
      skill: 'training',
      expectedResponseShape: 'training_advice',
      userId: 123,
      tenantId: 456,
    });

    const systemPrompt = mockCompleteOneShotWithSearch.mock.calls[0]?.[0];
    expect(systemPrompt).toContain('prefer peer-reviewed papers');
    expect(systemPrompt).toContain('official health/science institutions');
    expect(systemPrompt).toContain('at least two independent sources');
    expect(systemPrompt).toContain('Preserve the user message language mix');
  });

  it('explicitly allows public law and visa lookup answers without personalized legal advice', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Official public sources summarize entry requirements.',
      sources: ['https://example.gov/entry-requirements'],
    });

    await buildChatInternetResearchAnswer({
      message: 'Search fuentes públicas sobre requisitos de visa Schengen para mexicanos en 2026.',
      language: 'es',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    const systemPrompt = mockCompleteOneShotWithSearch.mock.calls[0]?.[0];
    expect(systemPrompt).toContain('public law, regulation, visa, entry-requirement');
    expect(systemPrompt).toContain('do not refuse merely because the topic is legal');
    expect(systemPrompt).toContain('do not provide personalized legal advice');
  });

  it('does not attempt OpenAI web search when the flag is on but OpenAI is not configured', async () => {
    vi.stubEnv('CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK', 'true');
    mockIsOpenAIConfigured.mockReturnValue(false);
    mockCompleteOneShotWithSearch.mockRejectedValue(new Error('Gemini unavailable'));

    const result = await buildChatInternetResearchAnswer({
      message: 'latest OpenAI releases this week',
      language: 'en',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('web_research_unavailable');
    expect(mockCompleteOneShotWithOpenAIWebSearch).not.toHaveBeenCalled();
  });

  it('recognizes generic provider refusals and normalizes source-footed answers', () => {
    expect(isResearchProviderRefusal('I could not produce a safe answer for that request.')).toBe(true);
    expect(isResearchProviderRefusal("I can't assist with that.")).toBe(true);
    expect(isResearchProviderRefusal("I can't provide legal advice.")).toBe(true);
    expect(isResearchProviderRefusal(
      "I can't provide legal advice, but official public sources summarize the entry requirements.",
    )).toBe(false);
    expect(isResearchProviderRefusal('No puedo producir una respuesta segura.')).toBe(true);
    expect(isResearchProviderRefusal('Public sources summarize the law.')).toBe(false);
    expect(normalizeResearchAnswerText(
      'Respuesta pública.\n\nFontes consultadas: https://example.com/a',
      'es',
    )).toBe('Respuesta pública.');
  });

  it('refuses to send private scoped Nexus state into web-search prompts', async () => {
    const result = await buildChatInternetResearchAnswer({
      message: 'show my latest tasks and Lisbon weather',
      language: 'en',
      skill: 'secretary',
      expectedResponseShape: 'agenda_summary',
      groundingRequired: 'local_and_web',
      localContext: 'Calendar: 09:00 Standup\nTasks: Pay invoice',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).not.toHaveBeenCalled();
    expect(mockTrackedCreate).not.toHaveBeenCalled();
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('private_context_disallowed_for_web_search');
    expect(result.text).toContain('cannot send private Nexus context');
  });

  it('uses an anonymized public health query instead of raw local training context', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Use the local facts plus current public sources.',
      sources: ['https://example.com/current'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'I have ankle pain after intervals on my marathon plan, should I train today?',
      language: 'en',
      skill: 'training',
      expectedResponseShape: 'training_advice',
      groundingRequired: 'local_and_web',
      localContext: 'Readiness: low\nToday workout: intervals',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledWith(
      expect.stringContaining('current web grounding'),
      expect.stringContaining('public health and training guidance for person has ankle pain after intervals'),
      'chat_internet_research',
      expect.objectContaining({ userId: 123, tenantId: 456 }),
    );
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[1]).not.toContain('Readiness: low');
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[1]).not.toContain('Today workout');
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[1]).not.toContain('marathon plan');
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[1]).not.toContain('I have ankle pain');
    expect(result.context?.localContextIncluded).toBe(false);
  });

  it('builds safe query packets without raw private identifiers', () => {
    expect(buildChatInternetResearchSafeQueryPacket({
      message: 'Tenho dor no joelho, devo treinar hoje?',
      skill: 'training',
      expectedResponseShape: 'training_advice',
      groundingRequired: 'local_and_web',
      localContext: 'Treino: intervalos',
    })).toMatchObject({
      ok: true,
      publicQuery: expect.stringContaining('public health and training guidance'),
    });

    expect(buildChatInternetResearchSafeQueryPacket({
      message: 'Tengo dolor en el tobillo después de series, ¿puedo entrenar hoy?',
      skill: 'training',
      expectedResponseShape: 'training_advice',
      groundingRequired: 'local_and_web',
      localContext: 'Plan privado: series',
    })).toMatchObject({
      ok: true,
      publicQuery: expect.stringContaining('dolor en el tobillo'),
    });

    expect(buildChatInternetResearchSafeQueryPacket({
      message: 'Search my account balance for tax guidance, felipe@example.com',
      skill: 'finance',
      expectedResponseShape: 'finance_summary',
      groundingRequired: 'local_and_web',
      localContext: 'Balance: private',
    })).toMatchObject({
      ok: false,
      denialReason: 'private_context_disallowed_for_web_search',
    });
  });
});

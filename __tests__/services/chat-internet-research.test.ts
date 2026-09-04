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
const { mockIsPaidAiCostControlsEnforcementEnabled } = vi.hoisted(() => ({
  mockIsPaidAiCostControlsEnforcementEnabled: vi.fn(),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithSearch: mockCompleteOneShotWithSearch,
}));
vi.mock('../../src/services/anthropic-hook', () => ({
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
vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: mockIsPaidAiCostControlsEnforcementEnabled,
}));

import {
  buildChatInternetResearchAnswer,
  buildChatInternetResearchSafeQueryPacket,
  isResearchProviderRefusal,
  normalizeResearchAnswerText,
} from '../../src/services/chat-internet-research';
import { assessChatResearchAnswerCompleteness } from '../../src/services/chat-research-answer-quality';

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
    mockIsPaidAiCostControlsEnforcementEnabled.mockReset();
    mockIsPaidAiCostControlsEnforcementEnabled.mockReturnValue(false);
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

  it('keeps account cancellation terminal when a search provider resolves after abort', async () => {
    const controller = new AbortController();
    const accountDeletion = Object.assign(new Error('account deletion started'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    mockCompleteOneShotWithSearch.mockImplementationOnce(async (
      _system: string,
      _prompt: string,
      _category: string,
      options: { abortSignal?: AbortSignal },
    ) => {
      expect(options.abortSignal).toBe(controller.signal);
      controller.abort(accountDeletion);
      return {
        text: 'This answer must not be published.',
        sources: ['https://example.com/not-published'],
      };
    });

    await expect(buildChatInternetResearchAnswer({
      message: 'Search current public guidance.',
      language: 'en',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
      abortSignal: controller.signal,
    })).rejects.toBe(accountDeletion);

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(mockTrackedCreate).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithOpenAIWebSearch).not.toHaveBeenCalled();
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

  it('uses bounded OpenAI search when Gemini maximum cost does not fit even without the optional fallback flag', async () => {
    mockIsOpenAIConfigured.mockReturnValue(true);
    mockCompleteOneShotWithSearch.mockRejectedValueOnce(Object.assign(
      new Error('AI_DAILY_LIMIT_REACHED'),
      {
        name: 'AiBudgetError',
        decision: { code: 'AI_DAILY_LIMIT_REACHED', window: 'daily' },
      },
    ));
    mockCompleteOneShotWithOpenAIWebSearch.mockResolvedValueOnce({
      text: 'A bounded lower-cost search still returns a complete grounded answer.',
      sources: ['https://example.com/bounded-search'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'latest public AI product changes',
      language: 'en',
      skill: 'content',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledTimes(1);
    expect(mockTrackedCreate).not.toHaveBeenCalled();
    expect(result.degraded).toBe(false);
    expect(result.sources).toEqual(['https://example.com/bounded-search']);
  });

  it('uses bounded low-cost OpenAI search before Gemini while enforcement is enabled', async () => {
    mockIsPaidAiCostControlsEnforcementEnabled.mockReturnValue(true);
    mockIsOpenAIConfigured.mockReturnValue(true);
    mockCompleteOneShotWithOpenAIWebSearch.mockResolvedValueOnce({
      text: 'The lower-cost provider returned a complete answer first.',
      sources: ['https://example.com/enforced-first'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'latest public AI product changes',
      language: 'en',
      skill: 'content',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithOpenAIWebSearch).toHaveBeenCalledTimes(1);
    expect(mockCompleteOneShotWithSearch).not.toHaveBeenCalled();
    expect(result.degraded).toBe(false);
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

  it('uses the English fallback contract for Spanish-authored research input', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'The answer summarizes current public sources in English.',
      sources: ['https://example.com/fuente-publica'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search noticias recientes sobre inflación en América Latina esta semana.',
      language: 'en',
      skill: 'finance',
      expectedResponseShape: 'finance_summary',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledWith(
      expect.stringContaining('Answer in English'),
      expect.stringContaining('Search noticias recientes'),
      'chat_internet_research',
      expect.objectContaining({ userId: 123, tenantId: 456 }),
    );
    const systemPrompt = mockCompleteOneShotWithSearch.mock.calls[0]?.[0];
    expect(systemPrompt).toContain('Output language: English');
    expect(systemPrompt).toContain('legacy Spanish-authored input uses English');
    expect(result.text).toContain('Sources consulted: https://example.com/fuente-publica');
  });

  it('strips provider-emitted Portuguese source footers and appends the English footer', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'The answer is in English and uses current public sources.\n\nFontes consultadas: https://provider.example/pt-footer',
      sources: ['https://example.com/fuente-publica'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search fuentes públicas sobre el marcador de la Copa Libertadores.',
      language: 'en',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(result.text).not.toContain('Fontes consultadas');
    expect(result.text).toContain('Sources consulted: https://example.com/fuente-publica');
  });

  it('fails closed without another provider call when a retired Spanish reply leaks through', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'La respuesta está en español y resume fuentes públicas actuales.',
      sources: ['https://example.com/fuente-publica'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search noticias recientes sobre inflación en América Latina esta semana.',
      language: 'en',
      skill: 'finance',
      expectedResponseShape: 'finance_summary',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('response_locale_mismatch');
    expect(result.text).toContain('could not safely present the answer in English');
    expect(result.text).not.toContain('La respuesta');
  });

  it('fails closed when a provider reply is named Spanish with moderate evidence', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValue({
      text: 'La lista muestra tres tareas atrasadas para revisar cuando quieras. No se ha cambiado ningún dato.',
      sources: ['https://example.com/fuente-publica'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search fuentes actuales sobre mis prioridades.',
      language: 'en',
      skill: 'tasks',
      expectedResponseShape: 'task_summary',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      degraded: true,
      degradedReason: 'response_locale_mismatch',
    });
    expect(result.text).not.toContain('La lista muestra');
  });

  it('fails closed without another provider call when Portuguese leaks into the effective English contract', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Aqui está o resumo das fontes públicas atuais e das notícias mais recentes.',
      sources: ['https://example.com/fuente-publica'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search noticias recientes sobre inflación en América Latina esta semana.',
      language: 'en',
      skill: 'finance',
      expectedResponseShape: 'finance_summary',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('response_locale_mismatch');
    expect(result.text).toContain('could not safely present the answer in English');
    expect(result.text).not.toContain('Aqui está');
  });

  it.each([
    {
      language: 'en' as const,
      leakedText: 'Aquí tienes.',
      expectedFallback: 'could not safely present the answer in English',
    },
    {
      language: 'en' as const,
      leakedText: 'Aqui está.',
      expectedFallback: 'could not safely present the answer in English',
    },
    {
      language: 'pt' as const,
      leakedText: 'Here you go.',
      expectedFallback: 'não consegui apresentar a resposta com segurança em português',
    },
  ])(
    'fails closed without retrying a short $language cross-locale provider reply',
    async ({ language, leakedText, expectedFallback }) => {
      mockCompleteOneShotWithSearch.mockResolvedValueOnce({
        text: leakedText,
        sources: ['https://example.com/fuente-publica'],
      });

      const result = await buildChatInternetResearchAnswer({
        message: 'Search current public information about this topic.',
        language,
        skill: 'chat',
        expectedResponseShape: 'direct_answer',
        userId: 123,
        tenantId: 456,
      });

      expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        degraded: true,
        degradedReason: 'response_locale_mismatch',
      });
      expect(result.text).toContain(expectedFallback);
      expect(result.text).not.toContain(leakedText);
    },
  );

  it('uses a neutral source footer for mixed-language research instead of defaulting to Portuguese', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Current SaaS benchmarks vary by segment and source.\n\nFontes consultadas: https://provider.example/pt-footer',
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

  it('blocks Spanish output under a mixed EN/PT research contract without retrying', async () => {
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'La respuesta está en español y resume las fuentes públicas actuales.',
      sources: ['https://example.com/source'],
    });

    const result = await buildChatInternetResearchAnswer({
      message: 'Search current public SaaS benchmarks.',
      language: 'mixed',
      skill: 'chat',
      expectedResponseShape: 'direct_answer',
      userId: 123,
      tenantId: 456,
    });

    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      degraded: true,
      degradedReason: 'response_locale_mismatch',
    });
    expect(result.text).not.toContain('La respuesta');
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
    expect(systemPrompt).toContain('Preserve only the English/Portuguese language mix');
    expect(systemPrompt).toContain('Render Spanish-authored portions in English');
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
    expect(normalizeResearchAnswerText(
      'Public answer.\n\nSources consulted: https://example.com/a, http://example.org/b',
      'en',
    )).toBe('Public answer.');
    expect(normalizeResearchAnswerText(
      'Public answer.\n\nSources: HTTPS://EXAMPLE.COM/A',
      'en',
    )).toBe('Public answer.');
    expect(normalizeResearchAnswerText(
      'Public answer.\n\nSources consulted: not-a-url',
      'en',
    )).toBe('Public answer.\n\nSources consulted: not-a-url');
    expect(normalizeResearchAnswerText(
      'Public answer.\n\nSources consulted: https://',
      'en',
    )).toBe('Public answer.\n\nSources consulted: https://');
    expect(assessChatResearchAnswerCompleteness(
      'A complete public research answer sentence.\n\nSources: https://example.com/source',
    )).toEqual({ ok: true });
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

    expect(buildChatInternetResearchSafeQueryPacket({
      message: `%${'%'.repeat(20_001)}`,
      skill: 'cooking',
      expectedResponseShape: 'direct_answer',
    })).toMatchObject({
      ok: false,
      denialReason: 'empty_public_query',
    });
  });
});

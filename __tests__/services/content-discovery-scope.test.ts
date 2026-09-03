import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const mocks = vi.hoisted(() => ({
  completeOneShotWithSearch: vi.fn(),
  completeOneShotWithWebSearch: vi.fn(),
  isOpenAIConfigured: vi.fn(() => false),
  trackedCreate: vi.fn(),
  withAiBudgetReservation: vi.fn(),
  isDuplicateIdea: vi.fn(async () => ({ isDuplicate: false, confidence: 0 })),
  isDuplicateIdeaInBatch: vi.fn(() => ({ isDuplicate: false, similarTo: null, confidence: 0 })),
  captureDiscoveredIdea: vi.fn(() => ({ replayed: false })),
  invalidateContentDerivedCaches: vi.fn(),
  getUserLanguage: vi.fn(() => 'en-US'),
  getContentCreatorProfile: vi.fn(),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  withAiBudgetReservation: (...args: unknown[]) => mocks.withAiBudgetReservation(...args),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithSearch: (...args: unknown[]) => mocks.completeOneShotWithSearch(...args),
  isGeminiProviderConfigured: vi.fn(() => true),
}));

vi.mock('../../src/services/openai-provider', () => ({
  completeOneShotWithWebSearch: (...args: unknown[]) => mocks.completeOneShotWithWebSearch(...args),
  isOpenAIConfigured: (...args: unknown[]) => mocks.isOpenAIConfigured(...args),
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: (...args: unknown[]) => mocks.trackedCreate(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mocks.getUserLanguage(...args),
}));

vi.mock('../../src/state/content-creator-profile', async () => ({
  ...(await vi.importActual<typeof import('../../src/state/content-creator-profile')>(
    '../../src/state/content-creator-profile',
  )),
  getContentCreatorProfile: (...args: unknown[]) => mocks.getContentCreatorProfile(...args),
}));

vi.mock('../../src/services/content-dedup', () => ({
  isDuplicateIdea: (...args: unknown[]) => mocks.isDuplicateIdea(...args),
  isDuplicateIdeaInBatch: (...args: unknown[]) => mocks.isDuplicateIdeaInBatch(...args),
}));

vi.mock('../../src/services/content-workspace-capture', () => ({
  captureDiscoveredIdea: (...args: unknown[]) => mocks.captureDiscoveredIdea(...args),
}));

vi.mock('../../src/services/cache-coherence-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/cache-coherence-registry')>()),
  invalidateContentDerivedCaches: (...args: unknown[]) => mocks.invalidateContentDerivedCaches(...args),
}));

import { runContentDiscovery } from '../../src/services/content-discovery';

describe('content discovery user scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAiBudgetReservation.mockImplementation(async (_request, providerCall) => providerCall());
    mocks.isOpenAIConfigured.mockReturnValue(false);
    mocks.getUserLanguage.mockReturnValue('en-US');
    mocks.getContentCreatorProfile.mockReturnValue({
      pillars: [],
      niches: [],
      audience: '',
      platforms: [],
      voiceRules: [],
      preferredFormats: [],
      dislikedTopics: [],
      bannedTopics: [],
      trustedSources: [],
      dislikedSources: [],
      contentGoals: [],
      languagePreference: '',
      voiceExamples: [],
    });
  });

  it('rejects missing or invalid user scope before provider calls or saved-idea writes', async () => {
    await expect(runContentDiscovery(undefined as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: 0 } as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: 1.5 } as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: Number.MAX_SAFE_INTEGER + 1 } as any)).rejects.toThrow(/userId required/);
  });

  it('rejects authenticated discovery without validated tenant scope', async () => {
    await expect(runContentDiscovery({ userId: 42 } as any)).rejects.toThrow(/runContentDiscovery requires a validated tenantId/);
  });

  it('reserves the complete interactive provider chain before Gemini or Anthropic can run', async () => {
    const denial = new Error('AI_PLAN_REQUIRED');
    mocks.withAiBudgetReservation.mockRejectedValueOnce(denial);

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toBe(denial);

    expect(mocks.withAiBudgetReservation).toHaveBeenCalledWith({
      userId: 42,
      requestSource: 'interactive',
      baseCategory: 'content_discovery',
      jobName: 'content_discovery',
    }, expect.any(Function));
    expect(mocks.completeOneShotWithSearch).not.toHaveBeenCalled();
    expect(mocks.trackedCreate).not.toHaveBeenCalled();
  });

  it('captures discovery output canonically and never writes the retired shared markdown file', async () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Content Ideas — 2026-07-17',
        '## Idea 1: Canonical discovery workspace',
        '**Why now:** Useful now.',
        '## Quick-Fire Shorts (bonus)',
        '- One-minute creator systems check',
      ].join('\n'),
      sources: ['https://example.test/fresh-source'],
    });

    const result = await runContentDiscovery({ userId: 42, tenantId: 42 });

    expect(result).toMatchObject({
      ideas: ['Canonical discovery workspace', 'One-minute creator systems check'],
      filePath: null,
      storage: 'content_workspace',
      provider: 'gemini',
    });
    expect(mocks.captureDiscoveredIdea).toHaveBeenCalledTimes(2);
    expect(mocks.captureDiscoveredIdea).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 42, userId: 42 },
      title: 'Canonical discovery workspace',
      provider: 'gemini',
    }));
    const providerPrompt = String(mocks.completeOneShotWithSearch.mock.calls[0]?.[1] ?? '');
    const systemPrompt = String(mocks.completeOneShotWithSearch.mock.calls[0]?.[0] ?? '');
    expect(providerPrompt).toContain("setup-safe broad topics that are not the creator's identity");
    expect(providerPrompt).toContain('technology product launch internet culture');
    expect(providerPrompt).toContain('creator economy social media trends');
    expect(providerPrompt).toContain('health wellness science research');
    expect(providerPrompt).toContain('lifestyle hobbies entertainment');
    expect(providerPrompt).toContain('business productivity systems');
    expect(providerPrompt).not.toMatch(/commentary reactions economics politics/i);
    expect(providerPrompt).not.toMatch(/gaming creator internet nostalgia streaming/i);
    expect(systemPrompt).not.toMatch(/politics|gaming|training\/performance/i);
    expect(systemPrompt).toContain('**Opening beat:**');
    expect(systemPrompt).toContain('**Opportunity confidence:**');
    expect(systemPrompt).toContain('reviewable hypothesis');
    expect(systemPrompt).not.toMatch(/Hook \(first 3s\)|Estimated virality|scroll-stopping/i);
    expect(systemPrompt).toContain('up to 8 source-grounded main ideas');
    expect(systemPrompt).not.toMatch(/3-5 bullet points|3 SEO-friendly|8-10 ideas|filmed in <5 minutes/i);
    expect(providerPrompt).toContain('configured 48-hour discovery window');
    expect(providerPrompt).toContain('batch limits, not a publishing cadence');
    expect(mocks.getContentCreatorProfile).toHaveBeenCalledWith(42, 42);
    expect(mocks.completeOneShotWithSearch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'content_discovery',
      expect.objectContaining({ maxRetries: 0, userId: 42, tenantId: 42 }),
    );
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledOnce();
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(42);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('applies explicit bounded discovery batch and freshness controls', async () => {
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: '# Content Ideas — 2026-07-17\n## Idea 1: Bounded discovery plan',
      sources: ['https://example.test/fresh-source'],
    });

    await runContentDiscovery({
      userId: 42,
      tenantId: 42,
      mainIdeaCount: 2,
      quickFireCount: 1,
      freshnessWindowHours: 72,
    });

    const systemPrompt = String(mocks.completeOneShotWithSearch.mock.calls[0]?.[0] ?? '');
    const providerPrompt = String(mocks.completeOneShotWithSearch.mock.calls[0]?.[1] ?? '');
    expect(systemPrompt).toContain('up to 2 source-grounded main ideas');
    expect(systemPrompt).toContain('up to 1 optional one-line Short/Reel ideas');
    expect(providerPrompt).toContain('configured 72-hour discovery window');
    expect(providerPrompt).toContain('Return up to 2 main ideas and 1 optional quick-fire ideas');
  });

  it.each([
    { mainIdeaCount: 0 },
    { mainIdeaCount: 11 },
    { quickFireCount: -1 },
    { quickFireCount: 6 },
    { freshnessWindowHours: 0 },
    { freshnessWindowHours: 169 },
    { freshnessWindowHours: 1.5 },
  ])('rejects invalid discovery run controls before provider work: %j', async (controls) => {
    await expect(runContentDiscovery({ userId: 42, tenantId: 42, ...controls }))
      .rejects.toBeInstanceOf(TypeError);
    expect(mocks.completeOneShotWithSearch).not.toHaveBeenCalled();
  });

  it('uses scoped creator niches before setup-safe discovery fallbacks', async () => {
    mocks.getContentCreatorProfile.mockReturnValue({
      pillars: ['Documentary craft'],
      niches: ['Ocean conservation'],
      audience: 'Independent documentary filmmakers',
      platforms: [],
      voiceRules: ['Evidence first'],
      preferredFormats: ['YouTube'],
      dislikedTopics: ['celebrity gossip'],
      bannedTopics: ['unsourced allegations'],
      trustedSources: [],
      dislikedSources: [],
      contentGoals: ['Teach practical field research'],
      languagePreference: 'en-US',
      voiceExamples: [],
    });
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Content Ideas — 2026-07-17',
        '## Idea 1: A field guide to reef evidence',
        '**Why now:** New conservation data is available.',
      ].join('\n'),
      sources: ['https://example.test/reef-source'],
    });

    await runContentDiscovery({ userId: 42, tenantId: 70 });

    const providerPrompt = String(mocks.completeOneShotWithSearch.mock.calls[0]?.[1] ?? '');
    expect(providerPrompt).toContain("authenticated creator's saved niches and pillars");
    expect(providerPrompt).toContain('Ocean conservation');
    expect(providerPrompt).toContain('Documentary craft');
    expect(providerPrompt).toContain('Independent documentary filmmakers');
    expect(providerPrompt).toContain('unsourced allegations');
    expect(providerPrompt).not.toContain('technology product launch internet culture');
    expect(mocks.getContentCreatorProfile).toHaveBeenCalledWith(42, 70);
  });

  it('rejects mismatched provider output before any discovered idea is persisted or returned', async () => {
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Ideas de contenido — 2026-07-17',
        '## Idea 1: Cómo organizar todas tus tareas',
        '**Por qué ahora:** Muchas personas necesitan una solución clara esta semana.',
        '**Hook:** ¿Quieres transformar tu rutina desde hoy?',
      ].join('\n'),
      sources: ['https://example.test/fresh-source'],
    });

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toMatchObject({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'content-discovery',
    });

    expect(mocks.captureDiscoveredIdea).not.toHaveBeenCalled();
  });

  it('fails before every workspace write when the canonical dedup comparison set is unavailable', async () => {
    const unavailable = Object.assign(new Error('dedup unavailable'), {
      name: 'ContentDedupUnavailableError',
      code: 'CONTENT_DEDUP_UNAVAILABLE',
      status: 503,
      retryable: true,
    });
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Content Ideas — 2026-07-17',
        '## Idea 1: First candidate',
        '**Why now:** Useful now.',
        '## Idea 2: Second candidate',
        '**Why now:** Also useful now.',
      ].join('\n'),
      sources: ['https://example.test/fresh-source'],
    });
    mocks.isDuplicateIdea.mockResolvedValueOnce({ isDuplicate: false, confidence: 0 });
    mocks.isDuplicateIdea.mockRejectedValueOnce(unavailable);

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toBe(unavailable);

    expect(mocks.isDuplicateIdea).toHaveBeenCalledTimes(2);
    expect(mocks.captureDiscoveredIdea).not.toHaveBeenCalled();
    expect(mocks.invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('reports confirmed writes when canonical persistence fails partway through a preflighted batch', async () => {
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Content Ideas — 2026-07-17',
        '## Idea 1: First confirmed candidate',
        '**Why now:** Useful now.',
        '## Idea 2: Persistence failure candidate',
        '**Why now:** Also useful now.',
      ].join('\n'),
      sources: ['https://example.test/fresh-source'],
    });
    mocks.captureDiscoveredIdea
      .mockReturnValueOnce({ replayed: false })
      .mockImplementationOnce(() => { throw new Error('workspace unavailable'); });

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toMatchObject({
      code: 'CONTENT_DISCOVERY_PERSISTENCE_UNAVAILABLE',
      details: { confirmedBeforeFailure: 1, retryable: true },
    });

    expect(mocks.captureDiscoveredIdea).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(42);
  });

  it('rejects a Spanish idea line even when the rest of the discovery document is English', async () => {
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Content Ideas — 2026-07-17',
        'This report explains the current creator landscape in English with grounded context and clear recommendations.',
        '## Idea 1: Cómo organizar tus tareas',
        '**Why now:** Teams need a reliable workflow this week.',
        '**Hook:** Start with one concrete review.',
      ].join('\n'),
      sources: ['https://example.test/fresh-source'],
    });

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toMatchObject({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'content-discovery',
    });
    expect(mocks.captureDiscoveredIdea).not.toHaveBeenCalled();
  });

  it('withholds an oversized provider title before dedupe or workspace persistence', async () => {
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: `# Content Ideas — 2026-07-17\n## Idea 1: ${'x'.repeat(241)}`,
      sources: ['https://example.test/fresh-source'],
    });

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toMatchObject({
      code: 'CONTENT_DISCOVERY_OUTPUT_INVALID',
    });
    expect(mocks.isDuplicateIdea).not.toHaveBeenCalled();
    expect(mocks.captureDiscoveredIdea).not.toHaveBeenCalled();
  });

  it('withholds an overfilled provider idea batch before workspace persistence', async () => {
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Content Ideas — 2026-07-17',
        ...Array.from({ length: 16 }, (_, index) => `## Idea ${index + 1}: Bounded idea ${index + 1}`),
      ].join('\n'),
      sources: ['https://example.test/fresh-source'],
    });

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toMatchObject({
      code: 'CONTENT_DISCOVERY_OUTPUT_INVALID',
    });
    expect(mocks.isDuplicateIdea).not.toHaveBeenCalled();
    expect(mocks.captureDiscoveredIdea).not.toHaveBeenCalled();
  });

  it('does not switch providers after a dispatched discovery failure', async () => {
    const providerFailure = Object.assign(new Error('provider transport failed'), { status: 503 });
    mocks.isOpenAIConfigured.mockReturnValue(true);
    mocks.completeOneShotWithSearch.mockRejectedValueOnce(providerFailure);

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toBe(providerFailure);

    expect(mocks.completeOneShotWithSearch).toHaveBeenCalledTimes(1);
    expect(mocks.completeOneShotWithWebSearch).not.toHaveBeenCalled();
    expect(mocks.trackedCreate).not.toHaveBeenCalled();
    expect(mocks.captureDiscoveredIdea).not.toHaveBeenCalled();
  });

  it('stops before provider dispatch when the caller is already disconnected', async () => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('client disconnected'), { name: 'AbortError' }));

    await expect(runContentDiscovery({
      userId: 42,
      tenantId: 42,
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(mocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(mocks.completeOneShotWithSearch).not.toHaveBeenCalled();
    expect(mocks.captureDiscoveredIdea).not.toHaveBeenCalled();
  });

  it('stops after an in-flight dedupe read when the caller disconnects before persistence', async () => {
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('client disconnected'), { name: 'AbortError' });
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Content Ideas — 2026-07-17',
        '## Idea 1: Cancellation-safe workspace capture',
        '**Why now:** This request disconnected during dedupe.',
      ].join('\n'),
      sources: ['https://example.test/fresh-source'],
    });
    mocks.isDuplicateIdea.mockImplementationOnce(async () => {
      controller.abort(cancellation);
      return { isDuplicate: false, confidence: 0 };
    });

    await expect(runContentDiscovery({
      userId: 42,
      tenantId: 42,
      abortSignal: controller.signal,
    })).rejects.toBe(cancellation);

    expect(mocks.isDuplicateIdea).toHaveBeenCalledOnce();
    expect(mocks.captureDiscoveredIdea).not.toHaveBeenCalled();
    expect(mocks.invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });
});

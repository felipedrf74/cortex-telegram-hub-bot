import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getContentCreatorProfile: vi.fn(),
  prepare: vi.fn(),
  run: vi.fn(),
  writeGovernedSignal: vi.fn(),
  withAiBudgetReservation: vi.fn(),
}));

vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  );
  return {
    ...actual,
    getDb: () => ({ prepare: mocks.prepare }),
  };
});
vi.mock('../../src/services/intelligence-bus', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/intelligence-bus')>(
    '../../src/services/intelligence-bus',
  );
  return {
    ...actual,
    writeGovernedSignal: mocks.writeGovernedSignal,
  };
});
vi.mock('../../src/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/logger')>(
    '../../src/utils/logger',
  );
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});
vi.mock('../../src/utils/request-context', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/request-context')>(
    '../../src/utils/request-context',
  );
  return {
    ...actual,
    getCurrentRequestId: vi.fn(() => 'request-id'),
    generateRequestId: vi.fn(() => 'generated-request-id'),
  };
});
vi.mock('../../src/config', () => ({
  config: { contentEngine: { internalApiSecret: 'test-secret' } },
}));
vi.mock('../../src/services/content-engine', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/content-engine')>(
    '../../src/services/content-engine',
  );
  return {
    ...actual,
    contentEngineApiBaseUrl: () => 'http://content-engine.test',
  };
});
vi.mock('../../src/services/cost-guardrail', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cost-guardrail')>(
    '../../src/services/cost-guardrail',
  );
  return {
    ...actual,
    AiBudgetError: class AiBudgetError extends Error {},
    withAiBudgetReservation: (...args: unknown[]) => mocks.withAiBudgetReservation(...args),
  };
});
vi.mock('../../src/services/internal-attribution', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/internal-attribution')>(
    '../../src/services/internal-attribution',
  );
  return {
    ...actual,
    createInternalAttributionToken: vi.fn(() => 'attribution-token'),
  };
});
vi.mock('../../src/state/content-creator-profile', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/content-creator-profile')>(
    '../../src/state/content-creator-profile',
  );
  return {
    ...actual,
    getContentCreatorProfile: (...args: unknown[]) => mocks.getContentCreatorProfile(...args),
  };
});
vi.mock('../../src/services/content-tenant-scope', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/content-tenant-scope')>(
    '../../src/services/content-tenant-scope',
  );
  return {
    ...actual,
    contentScopeForInsert: vi.fn((userId: number, tenantId?: number) => ({
      tenantId: tenantId ?? userId,
      ownerUserId: userId,
      visibilityScope: 'user_private',
      lifecycleState: 'pending',
      scopeStatus: 'active',
      createdBy: userId,
      updatedBy: userId,
      auditMetadataJson: '{}',
    })),
    contentScopeParams: vi.fn(() => [44, 7]),
    contentScopePredicate: vi.fn(() => "tenant_id = ? AND owner_user_id = ? AND scope_status = 'active'"),
    ensureContentTenantScopeColumns: vi.fn(),
  };
});

import { handleAddBookFromPortal } from '../../src/commands/books';

describe('book extraction creator-profile output language', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.getContentCreatorProfile.mockReset();
    mocks.prepare.mockReset();
    mocks.run.mockReset();
    mocks.writeGovernedSignal.mockReset();
    mocks.withAiBudgetReservation.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);

    mocks.withAiBudgetReservation.mockImplementation(async (_input, run: () => Promise<unknown>) => run());

    mocks.prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT extraction_status')) {
        return { get: () => undefined };
      }
      return { run: mocks.run };
    });
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        duration_ms: 42,
        quality_report: { tier: 'standard', warnings: [] },
        book: {
          title: 'The Law',
          author: 'Frédéric Bastiat',
          core_thesis: 'Liberty',
          key_frameworks: [],
          quotable_ideas: [],
          pillar_mapping: [],
          counter_arguments: [],
          related_thinkers: [],
          personal_notes: [],
        },
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['es-419', 'en-US'],
    ['Spanish', 'en-US'],
    ['Español', 'en-US'],
    ['fr-FR', 'en-US'],
    ['European Portuguese', 'pt-PT'],
    ['Brazilian Portuguese', 'pt-BR'],
  ])('projects stored creator language %s to %s', async (storedLanguage, expectedLanguage) => {
    mocks.getContentCreatorProfile.mockReturnValue({
      languagePreference: storedLanguage,
      audience: 'founders',
      pillars: ['Liberty'],
      niches: [],
      voiceRules: [],
      contentGoals: [],
    });

    await expect(handleAddBookFromPortal(
      'The Law',
      'Frédéric Bastiat',
      { userId: 7, tenantId: 44 },
    )).resolves.toEqual({ ok: true, message: 'The Law extracted successfully' });

    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      language: string;
      creator_profile: string;
    };
    expect(body.language).toBe(expectedLanguage);
    expect(body.creator_profile).toContain(`Primary output language: ${expectedLanguage}.`);
    expect(body.creator_profile).not.toContain(`Primary output language: ${storedLanguage}.`);
  });

  it('does not insert or change a book row when the creator profile is unavailable', async () => {
    mocks.getContentCreatorProfile.mockImplementationOnce(() => {
      throw new Error('profile storage unavailable');
    });

    await expect(handleAddBookFromPortal(
      'The Law',
      'Frédéric Bastiat',
      { userId: 7, tenantId: 44 },
    )).resolves.toMatchObject({
      ok: false,
      code: 'CONTENT_CREATOR_PROFILE_UNAVAILABLE',
      status: 503,
      details: { retryable: true },
    });

    const statements = mocks.prepare.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).not.toContain('INSERT INTO book_library');
    expect(statements).not.toContain("extraction_status = 'pending'");
    expect(statements).not.toContain("extraction_status = 'extracting'");
    expect(statements).not.toContain("extraction_status = 'failed'");
    expect(mocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not insert or change a book row when budget admission is denied', async () => {
    mocks.getContentCreatorProfile.mockReturnValue({
      languagePreference: 'en-US',
      audience: null,
      pillars: [],
      niches: [],
      voiceRules: [],
      contentGoals: [],
    });
    mocks.withAiBudgetReservation.mockRejectedValueOnce(Object.assign(new Error('budget denied'), {
      name: 'AiBudgetError',
    }));

    await expect(handleAddBookFromPortal(
      'The Law',
      'Frédéric Bastiat',
      { userId: 7, tenantId: 44 },
    )).rejects.toMatchObject({ name: 'AiBudgetError' });

    const statements = mocks.prepare.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).not.toContain('INSERT INTO book_library');
    expect(statements).not.toContain("extraction_status = 'pending'");
    expect(statements).not.toContain("extraction_status = 'extracting'");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('aborts the Content Engine extraction request when the caller disconnects', async () => {
    mocks.getContentCreatorProfile.mockReturnValue({
      languagePreference: 'en-US',
      audience: 'founders',
      pillars: [],
      niches: [],
      voiceRules: [],
      contentGoals: [],
    });
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('content client disconnected'), {
      name: 'AbortError',
      code: 'CONTENT_CLIENT_DISCONNECTED',
    });
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    mocks.fetch.mockImplementationOnce(async (_url: string, init?: RequestInit) => (
      new Promise((_resolve, reject) => {
        fetchStarted();
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
    ));

    const extraction = handleAddBookFromPortal(
      'The Law',
      'Frédéric Bastiat',
      { userId: 7, tenantId: 44 },
      { abortSignal: controller.signal },
    );
    await started;
    controller.abort(cancellation);

    await expect(extraction).rejects.toBe(cancellation);
    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(request.signal).toBeDefined();
    expect(request.signal).not.toBe(controller.signal);
    expect(request.signal?.aborted).toBe(true);
    const statements = mocks.prepare.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).not.toContain("extraction_status = 'failed'");
    expect(statements).toContain("SET extraction_status = 'pending'");
    expect(statements).toContain("AND extraction_status = 'extracting'");
  });

  it('stores partial-evidence extraction while surfacing bounded degraded source truth', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        duration_ms: 42,
        quality_report: { tier: 'standard', warnings: ['research_source_unavailable'] },
        book: {
          title: 'The Law',
          author: 'Frédéric Bastiat',
          core_thesis: 'Liberty',
          key_frameworks: [],
          quotable_ideas: [],
          pillar_mapping: [],
          counter_arguments: [],
          related_thinkers: [],
          personal_notes: [],
        },
      }),
    });

    await expect(handleAddBookFromPortal('The Law', 'Frédéric Bastiat'))
      .resolves.toEqual({
        ok: true,
        message: 'The Law extracted successfully',
        degraded: true,
        warnings: ['research_source_unavailable'],
      });

    const statements = mocks.prepare.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain('core_thesis = ?');
    expect(statements).not.toContain("extraction_status = 'failed'");
  });

  it.each([
    ['no_source_data', 'CONTENT_BOOK_SOURCE_UNAVAILABLE'],
    ['provider_output_invalid', 'CONTENT_BOOK_OUTPUT_INVALID'],
    ['unknown_provider_warning', 'CONTENT_BOOK_OUTPUT_INVALID'],
  ])('fails closed before persistence when the engine reports %s', async (warning, code) => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        duration_ms: 42,
        quality_report: { tier: 'standard', warnings: [warning] },
        book: {
          title: 'The Law',
          author: 'Frédéric Bastiat',
          core_thesis: 'Unavailable',
          key_frameworks: [],
          quotable_ideas: [],
          pillar_mapping: [],
          counter_arguments: [],
          related_thinkers: [],
          personal_notes: [],
        },
      }),
    });

    await expect(handleAddBookFromPortal('The Law', 'Frédéric Bastiat'))
      .resolves.toMatchObject({
        ok: false,
        code,
        status: code === 'CONTENT_BOOK_SOURCE_UNAVAILABLE' ? 503 : 502,
        details: { retryable: true },
        message: expect.stringContaining(code === 'CONTENT_BOOK_SOURCE_UNAVAILABLE'
          ? 'requires usable research sources'
          : 'did not match the bounded contract'),
      });

    const statements = mocks.prepare.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).not.toContain('core_thesis = ?');
    expect(statements).toContain("extraction_status = 'failed'");
    expect(mocks.writeGovernedSignal).not.toHaveBeenCalled();
  });

  it('rejects malformed engine output before persistence', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        duration_ms: 1.5,
        quality_report: { warnings: [] },
        book: { title: 'The Law', author: 'Frédéric Bastiat', core_thesis: 'Liberty' },
      }),
    });

    const result = await handleAddBookFromPortal('The Law', 'Frédéric Bastiat');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('CONTENT_BOOK_OUTPUT_INVALID');
    expect(result.message).toContain('bounded contract');
    expect(mocks.prepare.mock.calls.map(([sql]) => String(sql)).join('\n'))
      .not.toContain('core_thesis = ?');
    expect(mocks.writeGovernedSignal).not.toHaveBeenCalled();
  });

  it('does not expose a non-success engine response body', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'private provider response body',
    });

    const result = await handleAddBookFromPortal('The Law', 'Frédéric Bastiat');
    expect(result).toEqual({
      ok: false,
      code: 'CONTENT_BOOK_ENGINE_REQUEST_FAILED',
      status: 503,
      details: { retryable: true },
      message: 'Extraction failed: Content Engine book extraction is temporarily unavailable.',
    });
    expect(result.message).not.toContain('private provider response body');
  });

  it('preserves an allowlisted safety denial without forwarding engine prose', async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({
        detail: {
          error: {
            code: 'CONTENT_HIGH_RISK_REVIEW_REQUIRED',
            message: 'private provider explanation',
          },
        },
      }),
    });

    const result = await handleAddBookFromPortal('The Law', 'Frédéric Bastiat');

    expect(result).toEqual({
      ok: false,
      code: 'CONTENT_HIGH_RISK_REVIEW_REQUIRED',
      status: 422,
      details: { retryable: false },
      message: 'Extraction failed: This request requires reviewer-attested authority before content generation.',
    });
    expect(result.message).not.toContain('private provider explanation');
    expect(mocks.writeGovernedSignal).not.toHaveBeenCalled();
  });
});

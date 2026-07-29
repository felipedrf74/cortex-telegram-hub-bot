import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getContentCreatorProfile: vi.fn(),
  prepare: vi.fn(),
  run: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({ prepare: mocks.prepare }),
}));
vi.mock('../../src/services/intelligence-bus', () => ({
  writeGovernedSignal: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/utils/request-context', () => ({
  getCurrentRequestId: vi.fn(() => 'request-id'),
  generateRequestId: vi.fn(() => 'generated-request-id'),
}));
vi.mock('../../src/config', () => ({
  config: { contentEngine: { internalApiSecret: 'test-secret' } },
}));
vi.mock('../../src/services/content-engine', () => ({
  contentEngineApiBaseUrl: () => 'http://content-engine.test',
  parseForwardedAiBudgetError: vi.fn(),
}));
vi.mock('../../src/services/cost-guardrail', () => ({
  AiBudgetError: class AiBudgetError extends Error {},
  withAiBudgetReservation: vi.fn(async (_input, run: () => Promise<unknown>) => run()),
}));
vi.mock('../../src/services/internal-attribution', () => ({
  createInternalAttributionToken: vi.fn(() => 'attribution-token'),
}));
vi.mock('../../src/state/content-creator-profile', () => ({
  getContentCreatorProfile: (...args: unknown[]) => mocks.getContentCreatorProfile(...args),
}));
vi.mock('../../src/services/content-tenant-scope', () => ({
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
}));

import { handleAddBookFromPortal } from '../../src/commands/books';

describe('book extraction creator-profile output language', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.getContentCreatorProfile.mockReset();
    mocks.prepare.mockReset();
    mocks.run.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);

    mocks.prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT extraction_status')) {
        return { get: () => undefined };
      }
      return { run: mocks.run };
    });
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        book: {
          title: 'The Law',
          author: 'Frédéric Bastiat',
          core_thesis: 'Liberty',
          key_frameworks: [],
          quotable_ideas: [],
          pillar_mapping: [],
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
});

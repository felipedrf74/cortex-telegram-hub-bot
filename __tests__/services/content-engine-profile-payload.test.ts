import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithContext } from '../../src/utils/request-context';
import { verifyInternalAttributionToken } from '../../src/services/internal-attribution';

const mockGetContentCreatorProfile = vi.fn(() => ({
  languagePreference: 'pt-BR',
  audience: 'founders',
  pillars: ['Cost control'],
  niches: ['creator ops'],
  voiceRules: ['proof first'],
  preferredFormats: ['YouTube'],
  dislikedTopics: [],
  bannedTopics: [],
  contentGoals: ['make content viable'],
  voiceExamples: ['Short example'],
}));

vi.mock('../../src/state/content-creator-profile', () => ({
  getContentCreatorProfile: (...args: unknown[]) => mockGetContentCreatorProfile(...args),
}));

describe('content engine profile payload', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockGetContentCreatorProfile.mockClear();
  });

  it('threads tenant-scoped creator profile and signed attribution into Python payloads', async () => {
    vi.stubEnv('INTERNAL_ATTRIBUTION_SECRET', 'payload-secret');
    const { buildCurrentCreatorProfilePayload } = await import('../../src/services/content-engine-profile-payload');

    const payload = await runWithContext(
      { source: 'http', userId: 7, tenantId: 44 },
      () => buildCurrentCreatorProfilePayload('en-US'),
    );

    expect(mockGetContentCreatorProfile).toHaveBeenCalledWith(7, 44);
    expect(payload.user_id).toBe(7);
    expect(payload.tenant_id).toBe(44);
    expect(payload.creator_profile).toContain('Cost control');
    expect(payload.internal_attribution_token).toBeTruthy();
    const claims = verifyInternalAttributionToken(
      payload.internal_attribution_token,
      'content_engine_creator_context',
    );
    expect(claims?.userId).toBe(7);
    expect(claims?.tenantId).toBe(44);
  });

  it('mints attribution tokens for the operation category that will be billed', async () => {
    vi.stubEnv('INTERNAL_ATTRIBUTION_SECRET', 'payload-secret');
    const { buildCurrentCreatorProfilePayload } = await import('../../src/services/content-engine-profile-payload');

    const payload = await runWithContext(
      { source: 'http', userId: 7, tenantId: 44 },
      () => buildCurrentCreatorProfilePayload('en-US', 'content_engine_report'),
    );

    expect(verifyInternalAttributionToken(payload.internal_attribution_token, 'content_engine_creator_context')).toBeNull();
    const claims = verifyInternalAttributionToken(payload.internal_attribution_token, 'content_engine_report');
    expect(claims?.userId).toBe(7);
    expect(claims?.tenantId).toBe(44);
  });

  it.each([
    ['es-419', 'pt-PT', 'en-US'],
    ['Spanish', 'pt-BR', 'en-US'],
    ['fr-FR', 'pt-PT', 'en-US'],
    ['European Portuguese', 'en-US', 'pt-PT'],
    ['Brazilian Portuguese', 'en-US', 'pt-BR'],
  ])(
    'projects stored creator language %s with hint %s to canonical output %s',
    async (storedLanguage, languageHint, expectedLanguage) => {
      mockGetContentCreatorProfile.mockReturnValueOnce({
        languagePreference: storedLanguage,
        audience: 'founders',
        pillars: ['Cost control'],
        niches: ['creator ops'],
        voiceRules: ['proof first'],
        preferredFormats: ['YouTube'],
        dislikedTopics: [],
        bannedTopics: [],
        contentGoals: ['make content viable'],
        voiceExamples: ['Short example'],
      });
      const { buildCurrentCreatorProfilePayload } = await import('../../src/services/content-engine-profile-payload');

      const payload = await runWithContext(
        { source: 'http', userId: 7, tenantId: 44 },
        () => buildCurrentCreatorProfilePayload(languageHint),
      );

      expect(payload.language).toBe(expectedLanguage);
      expect(payload.creator_profile).toContain(`Primary output language: ${expectedLanguage}.`);
      expect(payload.creator_profile).not.toContain(`Primary output language: ${storedLanguage}.`);
    },
  );

  it('projects a legacy Spanish language hint to English without an authenticated profile', async () => {
    const { buildCurrentCreatorProfilePayload } = await import('../../src/services/content-engine-profile-payload');

    const payload = await runWithContext(
      { source: 'http' },
      () => buildCurrentCreatorProfilePayload('es-ES'),
    );

    expect(payload).toEqual({ language: 'en-US' });
  });
});

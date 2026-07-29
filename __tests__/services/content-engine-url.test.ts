import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  getCached: vi.fn(),
  setCache: vi.fn(),
}));

vi.mock('../../src/services/cache-store', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cache-store')>(
    '../../src/services/cache-store',
  );
  return {
    ...actual,
    getCached: (...args: unknown[]) => cacheMocks.getCached(...args),
    setCache: (...args: unknown[]) => cacheMocks.setCache(...args),
  };
});

import {
  buildScriptCacheKey,
  contentEngineApiBaseUrl,
  deepSearch,
  ForwardedAiBudgetError,
  getScript,
  getSources,
} from '../../src/services/content-engine';

beforeEach(() => {
  cacheMocks.getCached.mockReset();
  cacheMocks.getCached.mockReturnValue(null);
  cacheMocks.setCache.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('content-engine client base URL', () => {
  it('projects retired Spanish and unsupported direct script locales to English cache scope', () => {
    const spanishKey = buildScriptCacheKey(
      'safe topic',
      'general',
      8,
      'YouTube',
      null,
      'draft',
      null,
      'es-ES',
    );
    const unsupportedKey = buildScriptCacheKey(
      'safe topic',
      'general',
      8,
      'YouTube',
      null,
      'draft',
      null,
      'de-DE',
    );

    expect(spanishKey).toContain('lang:en-US');
    expect(unsupportedKey).toContain('lang:en-US');
  });

  it('appends the API prefix to Docker service base URLs', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });

  it('does not duplicate the API prefix when callers provide it', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100/api/v1')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });

  it('trims trailing slashes before adding the API prefix', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100///')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });

  it('reconstructs stable quota errors returned by the Python hop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'AI_DAILY_LIMIT_REACHED',
        message: 'Daily AI quota reached.',
        details: { window: 'daily', unblocksAt: '2026-07-10T00:00:00.000Z' },
      },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '123' },
    })));

    await expect(getSources('safe topic')).rejects.toMatchObject({
      name: 'ForwardedAiBudgetError',
      code: 'AI_DAILY_LIMIT_REACHED',
      status: 429,
      publicMessage: 'Daily AI quota reached.',
      details: expect.objectContaining({ retryAfterSeconds: 123 }),
    });
  });

  it('does not retry a stable Content Engine quota denial', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'AI_PLAN_REQUIRED',
        message: 'An active paid plan is required.',
        details: { window: 'plan', unblocksAt: null },
      },
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deepSearch('safe topic')).rejects.toBeInstanceOf(ForwardedAiBudgetError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allowlists forwarded details and clamps oversized Retry-After values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 'AI_MONTHLY_LIMIT_REACHED',
        message: 'Monthly AI quota reached.',
        details: {
          window: 'monthly',
          requiredPlan: 'pro',
          monthlyResetAt: '2026-08-01T00:00:00.000Z',
          costUsd: 999,
          providerRaw: 'secret',
        },
      },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '999999999' },
    })));

    const error = await getSources('safe topic').catch((caught) => caught) as ForwardedAiBudgetError;

    expect(error.details).toEqual({
      window: 'monthly',
      requiredPlan: 'pro',
      monthlyResetAt: '2026-08-01T00:00:00.000Z',
      retryAfterSeconds: 2_678_400,
    });
  });

  it('rejects unsupported provider script language before the result can be returned or cached', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      topic: 'Safe topic',
      script: 'Aquí tienes el guion completo para organizar todas tus tareas.',
      hook: '¿Quieres empezar ahora?',
      title_options: ['Cómo organizar tus tareas'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 100,
      caption: 'Guarda esta guía para mañana.',
      cta: 'Comparte este vídeo con alguien.',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getScript(
      'Safe topic',
      'general',
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'structured',
      42,
      undefined,
      null,
      'detailed',
      false,
      null,
      null,
      42,
    )).rejects.toMatchObject({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'content-engine-script',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cacheMocks.setCache).not.toHaveBeenCalled();
  });

  it('revalidates an unsupported stale cache entry before returning it', async () => {
    cacheMocks.getCached.mockReturnValue({
      topic: 'Safe topic',
      script: 'Aquí tienes el guion completo para organizar todas tus tareas.',
      hook: '¿Quieres empezar ahora?',
      title_options: ['Cómo organizar tus tareas'],
      sources_used: [],
      estimated_duration: '1:00',
      duration_ms: 100,
      caption: 'Guarda esta guía para mañana.',
      cta: 'Comparte este vídeo con alguien.',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getScript(
      'Safe topic',
      'general',
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'structured',
      42,
      undefined,
      null,
      'detailed',
      false,
      null,
      null,
      42,
    )).rejects.toMatchObject({
      code: 'CONTENT_OUTPUT_LOCALE_MISMATCH',
      boundary: 'content-engine-script-cache',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheMocks.setCache).not.toHaveBeenCalled();
  });
});

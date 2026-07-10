import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contentEngineApiBaseUrl,
  deepSearch,
  ForwardedAiBudgetError,
  getSources,
} from '../../src/services/content-engine';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('content-engine client base URL', () => {
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
});

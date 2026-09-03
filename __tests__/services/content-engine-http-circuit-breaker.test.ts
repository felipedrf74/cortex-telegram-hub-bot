import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const START = new Date('2026-08-30T12:00:00.000Z');
const COOLDOWN_MS = 5 * 60_000;

function unavailableResponse(): Response {
  return new Response('unavailable', { status: 503 });
}

function unprocessableResponse(): Response {
  return new Response('invalid request', { status: 422 });
}

function healthyResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function forwardedBudgetResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      code: 'AI_DAILY_LIMIT_REACHED',
      message: 'Daily AI limit reached.',
      details: { window: 'daily', retryable: false },
    },
  }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '120' },
  });
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('Content Engine HTTP circuit breaker', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ now: START });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens after three failures, rejects without HTTP, and admits one successful recovery probe', async () => {
    const recoveryProbe = deferredResponse();
    const fetchMock = vi.fn((): Promise<Response> => Promise.resolve(healthyResponse()));
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => recoveryProbe.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { engineFetch } = await import('../../src/services/content-engine-http');
    const request = () => engineFetch<{ ok: boolean }>('/breaker-test');

    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await expect(request()).rejects.toThrow('circuit breaker OPEN');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date(START.getTime() + COOLDOWN_MS));
    const probe = request();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await expect(request()).rejects.toThrow('circuit breaker OPEN');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    recoveryProbe.resolve(healthyResponse());
    await expect(probe).resolves.toEqual({ ok: true });

    await expect(request()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('reopens from a failed half-open probe and starts a fresh cooldown', async () => {
    const fetchMock = vi.fn((): Promise<Response> => Promise.resolve(healthyResponse()));
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { engineFetch } = await import('../../src/services/content-engine-http');
    const request = () => engineFetch<{ ok: boolean }>('/breaker-test');

    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');

    vi.setSystemTime(new Date(START.getTime() + COOLDOWN_MS));
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    vi.setSystemTime(new Date(START.getTime() + (2 * COOLDOWN_MS) - 1));
    await expect(request()).rejects.toThrow('circuit breaker OPEN');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    vi.setSystemTime(new Date(START.getTime() + (2 * COOLDOWN_MS)));
    await expect(request()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('closes a half-open probe when the engine returns a forwarded policy denial', async () => {
    const fetchMock = vi.fn((): Promise<Response> => Promise.resolve(healthyResponse()));
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(forwardedBudgetResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { engineFetch } = await import('../../src/services/content-engine-http');
    const request = () => engineFetch<{ ok: boolean }>('/breaker-test');

    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');

    vi.setSystemTime(new Date(START.getTime() + COOLDOWN_MS));
    await expect(request()).rejects.toMatchObject({
      name: 'ForwardedAiBudgetError',
      code: 'AI_DAILY_LIMIT_REACHED',
      status: 429,
    });

    await expect(request()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('protects public script generation calls without caller-side breaker composition', async () => {
    const fetchMock = vi.fn((): Promise<Response> => Promise.resolve(unavailableResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { getScript } = await import('../../src/services/content-engine');
    const request = () => getScript(
      'Circuit breaker topic',
      'general',
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'structured',
      undefined,
      undefined,
      null,
      'detailed',
      true,
    );

    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await expect(request()).rejects.toThrow('circuit breaker OPEN');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not automatically replay a cost-bearing deep search after an ambiguous failure', async () => {
    const fetchMock = vi.fn((): Promise<Response> => Promise.resolve(healthyResponse()));
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        query: 'safe topic',
        briefs: [],
        search_count: 1,
        duration_ms: 25,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })));
    vi.stubGlobal('fetch', fetchMock);

    const { deepSearch } = await import('../../src/services/content-engine');
    await expect(deepSearch('safe topic')).rejects.toThrow('Content Engine request failed with HTTP 503.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(deepSearch('safe topic')).resolves.toMatchObject({ query: 'safe topic' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry or open the circuit for repeated stable 422 responses', async () => {
    const fetchMock = vi.fn((): Promise<Response> => Promise.resolve(new Response(JSON.stringify({
      query: 'healthy topic',
      sources: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(unprocessableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unprocessableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unprocessableResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { deepSearch, getSources } = await import('../../src/services/content-engine');

    await expect(deepSearch('invalid topic 1')).rejects.toThrow('Content Engine request failed with HTTP 422.');
    await expect(deepSearch('invalid topic 2')).rejects.toThrow('Content Engine request failed with HTTP 422.');
    await expect(deepSearch('invalid topic 3')).rejects.toThrow('Content Engine request failed with HTTP 422.');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await expect(getSources('healthy topic')).resolves.toMatchObject({ query: 'healthy topic' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('resets the retryable-failure streak when stable 422 responses are interleaved', async () => {
    const fetchMock = vi.fn((): Promise<Response> => Promise.resolve(healthyResponse()));
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unprocessableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unprocessableResponse()))
      .mockImplementationOnce(() => Promise.resolve(unavailableResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { engineFetch } = await import('../../src/services/content-engine-http');
    const request = () => engineFetch<{ ok: boolean }>('/breaker-test');

    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 422.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 422.');
    await expect(request()).rejects.toThrow('Content Engine request failed with HTTP 503.');
    await expect(request()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

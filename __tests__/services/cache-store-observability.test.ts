import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGet = vi.fn();
const mockRun = vi.fn();
const mockExec = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (...args: unknown[]) => mockGet(...args),
      run: (...args: unknown[]) => mockRun(...args),
    }),
    exec: (...args: unknown[]) => mockExec(...args),
  }),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('cache-store observability', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockGet.mockReset();
    mockRun.mockReset();
    mockExec.mockReset();
    const { _resetCacheStoreStatsForTests } = await import('../../src/services/cache-store');
    _resetCacheStoreStatsForTests();
  });

  it('tracks cache hits and misses for standard reads', async () => {
    mockGet
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ value_json: JSON.stringify({ ok: true }) });

    const { getCached, getCacheStoreStats } = await import('../../src/services/cache-store');

    expect(getCached('missing-key')).toBeNull();
    expect(getCached('hit-key')).toEqual({ ok: true });
    expect(getCacheStoreStats()).toMatchObject({
      readCount: 2,
      hitCount: 1,
      missCount: 1,
      parseErrors: 0,
      readErrors: 0,
    });
  });

  it('tracks parse failures separately from misses', async () => {
    mockGet.mockReturnValueOnce({ value_json: '{bad-json' });

    const { getCached, getCacheStoreStats } = await import('../../src/services/cache-store');

    expect(getCached('broken-key')).toBeNull();
    expect(getCacheStoreStats()).toMatchObject({
      readCount: 1,
      hitCount: 0,
      missCount: 0,
      parseErrors: 1,
      lastErrorOperation: 'getCached',
      lastErrorKey: 'broken-key',
    });
  });

  it('tracks writes, clears, stale hits, and expiry sweeps', async () => {
    mockRun.mockReturnValue({ changes: 2 });
    mockGet.mockReturnValueOnce({
      value_json: JSON.stringify({
        __swr: 1,
        value: { cached: true },
        freshUntil: Date.now() - 1000,
      }),
    });

    const {
      setCache,
      setCacheSWR,
      getCachedSWR,
      clearCache,
      clearCacheByPrefix,
      clearExpired,
      getCacheStoreStats,
    } = await import('../../src/services/cache-store');

    setCache('plain-key', { ok: true }, 60);
    setCacheSWR('swr-key', { ok: true }, 30, 60);
    expect(getCachedSWR('swr-key')).toEqual({ value: { cached: true }, fresh: false });
    clearCache('plain-key');
    clearCacheByPrefix('dashboard:42:');
    clearExpired();

    expect(getCacheStoreStats()).toMatchObject({
      writeCount: 2,
      swrReadCount: 1,
      hitCount: 1,
      staleHitCount: 1,
      clearCount: 1,
      clearByPrefixCount: 1,
      expireSweepCount: 1,
      expiredEntriesCleared: 2,
    });
  });
});

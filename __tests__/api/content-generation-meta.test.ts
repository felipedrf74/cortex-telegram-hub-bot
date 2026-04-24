// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGenerationMeta } from '../../src/api/routes/content-generation-meta';

describe('content generation metadata', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults researchUsed based on generation mode', () => {
    vi.setSystemTime(new Date('2026-04-20T12:00:01.000Z'));

    expect(buildGenerationMeta({
      mode: 'quick',
      startMs: new Date('2026-04-20T12:00:00.000Z').getTime(),
      cacheHit: true,
    })).toEqual({
      mode: 'quick',
      cacheHit: true,
      provider: undefined,
      durationMs: 1000,
      researchUsed: false,
    });

    expect(buildGenerationMeta({
      mode: 'standard',
      startMs: new Date('2026-04-20T12:00:00.000Z').getTime(),
      provider: 'claude',
    })).toEqual({
      mode: 'standard',
      cacheHit: false,
      provider: 'claude',
      durationMs: 1000,
      researchUsed: true,
    });
  });

  it('allows callers to override researchUsed explicitly', () => {
    vi.setSystemTime(new Date('2026-04-20T12:00:01.000Z'));

    expect(buildGenerationMeta({
      mode: 'deep',
      startMs: new Date('2026-04-20T12:00:00.000Z').getTime(),
      researchUsed: false,
    }).researchUsed).toBe(false);
  });
});

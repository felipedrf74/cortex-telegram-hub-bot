// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unit tests for the AsyncLocalStorage-based request context (Quarter:
 * distributed tracing). Validates that:
 *
 * - generateRequestId produces unique IDs
 * - runWithContext sets up the store and the values are visible inside
 * - getCurrentContext returns undefined OUTSIDE any runWithContext
 * - Concurrent requests don't bleed into each other (the whole point of
 *   AsyncLocalStorage vs a global)
 * - Promise.all works correctly with multiple parallel contexts
 * - Upstream-provided requestId is honored, otherwise a fresh one is generated
 */

import { describe, it, expect } from 'vitest';
import {
  generateRequestId,
  runWithContext,
  getCurrentContext,
  getCurrentRequestId,
} from '../../src/utils/request-context';

describe('generateRequestId', () => {
  it('returns a non-empty string', () => {
    const id = generateRequestId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('contains a hyphen separator between time and random parts', () => {
    const id = generateRequestId();
    expect(id).toContain('-');
    const [time, rand] = id.split('-');
    expect(time.length).toBeGreaterThan(0);
    expect(rand.length).toBe(5);
  });

  it('produces unique IDs across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRequestId());
    }
    // Allow up to 5 collisions (very unlikely on 1000 samples with 5-char
    // base36 random suffix = 60M possibilities, but we want a stable test)
    expect(ids.size).toBeGreaterThanOrEqual(995);
  });

  it('IDs are lexicographically sortable by time', async () => {
    const a = generateRequestId();
    await new Promise((r) => setTimeout(r, 5));
    const b = generateRequestId();
    // Time prefix is base36-encoded ms since epoch — strictly increasing
    const aTime = a.split('-')[0];
    const bTime = b.split('-')[0];
    expect(bTime >= aTime).toBe(true);
  });
});

describe('runWithContext / getCurrentContext', () => {
  it('returns undefined outside any runWithContext', () => {
    expect(getCurrentContext()).toBeUndefined();
    expect(getCurrentRequestId()).toBeUndefined();
  });

  it('exposes the context inside the callback', async () => {
    await runWithContext(
      { source: 'http', userId: 42 },
      async () => {
        const ctx = getCurrentContext();
        expect(ctx).toBeDefined();
        expect(ctx!.source).toBe('http');
        expect(ctx!.userId).toBe(42);
        expect(typeof ctx!.requestId).toBe('string');
        expect(ctx!.requestId.length).toBeGreaterThan(0);
        expect(typeof ctx!.startedAt).toBe('number');
      },
    );
  });

  it('clears the context after the callback resolves', async () => {
    await runWithContext({ source: 'telegram' }, async () => {
      // Inside: defined
      expect(getCurrentContext()).toBeDefined();
    });
    // Outside again: undefined
    expect(getCurrentContext()).toBeUndefined();
  });

  it('clears the context after the callback throws', async () => {
    await expect(
      runWithContext({ source: 'http' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(getCurrentContext()).toBeUndefined();
  });

  it('honors an explicit requestId from the caller', async () => {
    await runWithContext(
      { requestId: 'upstream-id-123', source: 'http' },
      async () => {
        expect(getCurrentRequestId()).toBe('upstream-id-123');
      },
    );
  });

  it('generates a fresh requestId when not provided', async () => {
    await runWithContext({ source: 'cron:test' }, async () => {
      const id = getCurrentRequestId();
      expect(id).toBeDefined();
      expect(id!.length).toBeGreaterThan(5);
    });
  });

  it('isolates concurrent contexts via Promise.all', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithContext({ requestId: 'A', source: 'http' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(`A=${getCurrentRequestId()}`);
      }),
      runWithContext({ requestId: 'B', source: 'http' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(`B=${getCurrentRequestId()}`);
      }),
      runWithContext({ requestId: 'C', source: 'http' }, async () => {
        seen.push(`C=${getCurrentRequestId()}`);
      }),
    ]);
    // Each context only saw its own ID — none bled across
    expect(seen.sort()).toEqual(['A=A', 'B=B', 'C=C']);
  });

  it('propagates context through deeply nested awaits', async () => {
    async function inner(): Promise<string | undefined> {
      await new Promise((r) => setTimeout(r, 1));
      return getCurrentRequestId();
    }
    async function middle(): Promise<string | undefined> {
      return inner();
    }

    const result = await runWithContext(
      { requestId: 'nested-id', source: 'telegram' },
      async () => middle(),
    );
    expect(result).toBe('nested-id');
  });

  it('supports cron source format with the job name', async () => {
    await runWithContext({ source: 'cron:reminders' }, async () => {
      const ctx = getCurrentContext();
      expect(ctx?.source).toBe('cron:reminders');
    });
  });

  it('preserves context across setImmediate', async () => {
    const id = await new Promise<string | undefined>((resolve) => {
      runWithContext({ requestId: 'immediate-test', source: 'http' }, () => {
        setImmediate(() => resolve(getCurrentRequestId()));
      });
    });
    expect(id).toBe('immediate-test');
  });
});

/**
 * Tests for src/services/graph-request-policy.ts (M6 item 9).
 *
 * Retry-After parsing across the header shapes Graph client errors actually
 * carry, the bounded delay contract, the legacy exponential fallback, and the
 * in-memory 429 counters surfaced through the task sync metrics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  graphRetryAfterMs,
  graphRetryDelayMs,
  recordGraphRateLimitHit,
  getGraphRateLimitCounters,
  _resetGraphRateLimitCountersForTests,
} from '../../src/services/graph-request-policy';

beforeEach(() => {
  _resetGraphRateLimitCountersForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('graphRetryAfterMs', () => {
  it('reads delta-seconds from plain header objects', () => {
    expect(graphRetryAfterMs({ headers: { 'retry-after': '7' } })).toBe(7000);
    expect(graphRetryAfterMs({ headers: { 'Retry-After': '3' } })).toBe(3000);
    expect(graphRetryAfterMs({ response: { headers: { 'retry-after': '2' } } })).toBe(2000);
  });

  it('reads Headers-like objects exposing get()', () => {
    const headers = { get: (name: string) => (name === 'retry-after' ? '5' : null) };
    expect(graphRetryAfterMs({ response: { headers } })).toBe(5000);
  });

  it('parses HTTP-date values relative to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T10:00:00Z'));
    const err = { headers: { 'retry-after': 'Sat, 18 Jul 2026 10:00:08 GMT' } };
    expect(graphRetryAfterMs(err)).toBe(8000);
  });

  it('bounds the delay to [1s, 60s]', () => {
    expect(graphRetryAfterMs({ headers: { 'retry-after': '0' } })).toBe(1000);
    expect(graphRetryAfterMs({ headers: { 'retry-after': '600' } })).toBe(60000);
  });

  it('returns null when no usable header exists', () => {
    expect(graphRetryAfterMs({})).toBeNull();
    expect(graphRetryAfterMs(new Error('429'))).toBeNull();
    expect(graphRetryAfterMs({ headers: { 'retry-after': 'not-a-date' } })).toBeNull();
    expect(graphRetryAfterMs(null)).toBeNull();
  });
});

describe('graphRetryDelayMs', () => {
  it('prefers Retry-After when present', () => {
    expect(graphRetryDelayMs({ headers: { 'retry-after': '4' } }, 0)).toBe(4000);
  });

  it('falls back to the legacy exponential backoff (capped at 10s) without a header', () => {
    expect(graphRetryDelayMs({}, 0)).toBe(1000);
    expect(graphRetryDelayMs({}, 1)).toBe(2000);
    expect(graphRetryDelayMs({}, 2)).toBe(4000);
    expect(graphRetryDelayMs({}, 6)).toBe(10000);
  });
});

describe('graph 429 counters', () => {
  it('accumulates per-source counts with a last-seen timestamp', () => {
    recordGraphRateLimitHit('microsoft-todo');
    recordGraphRateLimitHit('microsoft-todo');
    recordGraphRateLimitHit('microsoft-todo-adapter');

    const counters = getGraphRateLimitCounters();
    expect(counters).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'microsoft-todo', count: 2 }),
      expect.objectContaining({ source: 'microsoft-todo-adapter', count: 1 }),
    ]));
    expect(counters.every((counter) => typeof counter.lastAt === 'string')).toBe(true);
  });

  it('resets cleanly for tests', () => {
    recordGraphRateLimitHit('microsoft-todo');
    _resetGraphRateLimitCountersForTests();
    expect(getGraphRateLimitCounters()).toEqual([]);
  });
});

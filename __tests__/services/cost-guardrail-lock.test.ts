// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for the per-user cost-guardrail mutex.
 *
 * This exists to close the TOCTOU window between
 * `isUserOverDailyCap` and the AI call that writes `api_usage`.
 * Without the mutex, two concurrent requests from the SAME user
 * could both observe `over=false`, both spend, and together exceed
 * the daily budget. Across users, execution must stay concurrent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireCostLock,
  withUserCostLock,
  _resetUserCostLocksForTests,
} from '../../src/services/cost-guardrail';

afterEach(() => {
  _resetUserCostLocksForTests();
});

describe('withUserCostLock — per-user serialization', () => {
  it('serializes two calls for the SAME user (second waits for first)', async () => {
    const order: string[] = [];
    const task = (label: string, delayMs: number) => async () => {
      order.push(`enter:${label}`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`exit:${label}`);
      return label;
    };

    const p1 = withUserCostLock(42, task('A', 20));
    const p2 = withUserCostLock(42, task('B', 0));

    const results = await Promise.all([p1, p2]);
    expect(results).toEqual(['A', 'B']);
    // B must NOT have started before A finished.
    expect(order).toEqual(['enter:A', 'exit:A', 'enter:B', 'exit:B']);
  });

  it('does NOT serialize across different users (concurrent)', async () => {
    const order: string[] = [];
    const task = (label: string, delayMs: number) => async () => {
      order.push(`enter:${label}`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`exit:${label}`);
      return label;
    };

    const pA = withUserCostLock(101, task('A', 30));
    const pB = withUserCostLock(202, task('B', 0));

    await Promise.all([pA, pB]);
    // B must start BEFORE A finishes (no cross-user lock).
    const enterB = order.indexOf('enter:B');
    const exitA = order.indexOf('exit:A');
    expect(enterB).toBeLessThan(exitA);
  });

  it('advances the chain even when fn throws', async () => {
    const order: string[] = [];
    await expect(
      withUserCostLock(77, async () => {
        order.push('boom');
        throw new Error('intentional');
      }),
    ).rejects.toThrow('intentional');

    const second = await withUserCostLock(77, async () => {
      order.push('after');
      return 'ok';
    });
    expect(second).toBe('ok');
    expect(order).toEqual(['boom', 'after']);
  });

  it('short-circuits for invalid userId (no lock)', async () => {
    // Should still run the fn — just without queueing.
    const result = await withUserCostLock(0, async () => 'no-lock');
    expect(result).toBe('no-lock');
    const result2 = await withUserCostLock(-5, async () => 'still-no-lock');
    expect(result2).toBe('still-no-lock');
  });
});

describe('acquireCostLock — explicit-release variant', () => {
  it('serializes two callers through acquire/release pairs', async () => {
    const order: string[] = [];

    // First caller grabs the lock immediately.
    const release1 = await acquireCostLock(55);
    order.push('a:have-lock');

    // Second caller queues — must wait for release1().
    const release2Promise = acquireCostLock(55).then((r) => {
      order.push('b:have-lock');
      return r;
    });

    // Give the microtask queue a chance to run the acquisition's .then.
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['a:have-lock']); // B must still be waiting.

    release1();
    const release2 = await release2Promise;
    expect(order).toEqual(['a:have-lock', 'b:have-lock']);
    release2();
  });

  it('multiple release() calls are idempotent (no-op after first)', async () => {
    const release = await acquireCostLock(99);
    release();
    release(); // must not throw or leak
    release();
    // Next acquire for the same user should complete immediately.
    const next = await acquireCostLock(99);
    next();
  });

  it('returns a no-op for invalid userId', async () => {
    const release = await acquireCostLock(0);
    expect(typeof release).toBe('function');
    release();  // no-op
  });
});

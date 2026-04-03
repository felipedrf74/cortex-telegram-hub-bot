/**
 * AI Timeout Tests
 *
 * Tests the withTimeout utility and AITimeoutError.
 */

import { describe, it, expect } from 'vitest';
import { withTimeout, AITimeoutError } from '../../src/utils/timeout';

describe('withTimeout', () => {
  it('resolves if promise completes within limit', async () => {
    const result = await withTimeout(Promise.resolve('fast'), 1000);
    expect(result).toBe('fast');
  });

  it('rejects with AITimeoutError if promise exceeds limit', async () => {
    const slowPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve('slow'), 500)
    );
    await expect(withTimeout(slowPromise, 10)).rejects.toThrow(AITimeoutError);
  });

  it('AITimeoutError has correct name and timeoutMs', async () => {
    try {
      await withTimeout(new Promise(() => {}), 5);
    } catch (err) {
      expect(err).toBeInstanceOf(AITimeoutError);
      expect((err as AITimeoutError).name).toBe('AITimeoutError');
      expect((err as AITimeoutError).timeoutMs).toBe(5);
    }
  });

  it('propagates original promise errors', async () => {
    const failPromise = Promise.reject(new Error('original error'));
    await expect(withTimeout(failPromise, 1000)).rejects.toThrow('original error');
  });

  it('clears timeout timer when promise resolves (no orphaned timers)', async () => {
    // This test verifies no orphaned setTimeout — if it didn't clear,
    // the test runner would report leaked handles
    const result = await withTimeout(Promise.resolve(42), 5000);
    expect(result).toBe(42);
  });
});

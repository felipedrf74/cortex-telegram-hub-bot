// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * AI call timeout utility — prevents hung API calls from blocking the event loop.
 *
 * Usage:
 *   const result = await withTimeout(client.messages.create({...}), 30_000);
 */

export class AITimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`AI call timed out after ${timeoutMs}ms`);
    this.name = 'AITimeoutError';
  }
}

/**
 * Race a promise against a timeout. If the promise doesn't resolve within `ms`,
 * rejects with AITimeoutError. The original promise continues running in the
 * background (the API call isn't cancelled — just the wait is abandoned).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new AITimeoutError(ms)), ms);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise,
  ]);
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: { waitingQueueDepth: 4 },
}));

import {
  localInferenceScheduler,
} from '../../src/services/local-inference-scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('process-wide local inference scheduler', () => {
  beforeEach(() => localInferenceScheduler.resetForTests());

  it('serializes every generation and gives Max two turns before Pro starvation protection', async () => {
    const first = deferred<string>();
    const order: string[] = [];
    const active = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: async () => {
        order.push('active');
        return first.promise;
      },
    });
    const pro = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: async () => { order.push('pro'); return 'pro'; },
    });
    const maxOne = localInferenceScheduler.schedule({
      weight: 2,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: async () => { order.push('max-1'); return 'max-1'; },
    });
    const maxTwo = localInferenceScheduler.schedule({
      weight: 2,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: async () => { order.push('max-2'); return 'max-2'; },
    });
    const maxThree = localInferenceScheduler.schedule({
      weight: 2,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: async () => { order.push('max-3'); return 'max-3'; },
    });

    expect(localInferenceScheduler.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 4 });
    first.resolve('active');
    await Promise.all([active, pro, maxOne, maxTwo, maxThree]);
    expect(order).toEqual(['active', 'max-1', 'max-2', 'pro', 'max-3']);
  });

  it('leaves a durable background worker out of the in-memory queue when local inference is busy', async () => {
    const first = deferred<string>();
    const active = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: () => first.promise,
    });

    await expect(localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'background',
      deadlineMs: 10_000,
      run: async () => 'background',
    })).rejects.toMatchObject({ code: 'LOCAL_CAPACITY_BUSY' });

    first.resolve('done');
    await active;
  });

  it('expires interactive work before invoking its provider callback', async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<string>();
      const active = localInferenceScheduler.schedule({
        weight: 1,
        executionClass: 'interactive',
        deadlineMs: 10_000,
        run: () => first.promise,
      });
      const run = vi.fn(async () => 'late');
      const queued = localInferenceScheduler.schedule({
        weight: 1,
        executionClass: 'interactive',
        deadlineMs: 50,
        run,
      });
      await vi.advanceTimersByTimeAsync(51);
      const rejection = expect(queued).rejects.toMatchObject({ code: 'LOCAL_QUEUE_DEADLINE' });
      first.resolve('done');
      await active;
      await rejection;
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes cancelled interactive work before it can consume local capacity', async () => {
    const first = deferred<string>();
    const active = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: () => first.promise,
    });
    const controller = new AbortController();
    const run = vi.fn(async () => 'cancelled');
    const queued = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      abortSignal: controller.signal,
      run,
    });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    expect(localInferenceScheduler.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(run).not.toHaveBeenCalled();

    first.resolve('done');
    await active;
  });

  it('preserves a typed account-deletion abort reason for queued work', async () => {
    const first = deferred<string>();
    const active = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: () => first.promise,
    });
    const controller = new AbortController();
    const reason = Object.assign(new Error('account deletion started'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    const queued = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      abortSignal: controller.signal,
      run: vi.fn(async () => 'cancelled'),
    });

    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);

    first.resolve('done');
    await active;
  });

  it('rejects waiting work when runtime routing is switched off without interrupting the active call', async () => {
    const first = deferred<string>();
    const active = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: () => first.promise,
    });
    const queuedRun = vi.fn(async () => 'should-not-run');
    const queued = localInferenceScheduler.schedule({
      weight: 2,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: queuedRun,
    });
    const rejected = expect(queued).rejects.toMatchObject({ code: 'LOCAL_CAPACITY_BUSY' });

    expect(localInferenceScheduler.rejectWaitingForRuntimeOff()).toBe(1);
    expect(localInferenceScheduler.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(queuedRun).not.toHaveBeenCalled();

    first.resolve('active-finished');
    await active;
    await rejected;
  });

  it('recovers when queued work throws synchronously before returning a promise', async () => {
    const first = deferred<string>();
    const active = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: () => first.promise,
    });
    const throwing = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: (() => { throw new Error('sync boom'); }) as () => Promise<string>,
    });
    const after = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 10_000,
      run: async () => 'after',
    });

    first.resolve('first');
    await expect(active).resolves.toMatchObject({ value: 'first' });
    await expect(throwing).rejects.toThrow('sync boom');
    await expect(after).resolves.toMatchObject({ value: 'after' });
    expect(localInferenceScheduler.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0 });
  });
});

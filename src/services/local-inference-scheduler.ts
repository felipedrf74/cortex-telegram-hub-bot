// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { localPrimaryInferenceConfig } from './local-primary-config';
import { getLocalModelManifest } from './ollama-model-policy';

export type LocalInferenceExecutionClass = 'interactive' | 'background';

export class LocalInferenceCapacityError extends Error {
  constructor(
    readonly code: 'LOCAL_CAPACITY_BUSY' | 'LOCAL_QUEUE_FULL' | 'LOCAL_QUEUE_DEADLINE',
    message: string,
  ) {
    super(message);
    this.name = 'LocalInferenceCapacityError';
  }
}

interface ScheduledWork<T> {
  weight: number;
  executionClass: LocalInferenceExecutionClass;
  enqueuedAt: number;
  deadlineAt: number;
  run: () => Promise<T>;
  resolve: (value: { value: T; queueWaitMs: number }) => void;
  reject: (error: unknown) => void;
  deadlineTimer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

function cancelledError(reason?: unknown): Error & { code?: string } {
  if (reason instanceof Error
      && typeof (reason as Error & { code?: unknown }).code === 'string'
      && (reason as Error & { code: string }).code.length > 0) {
    return reason as Error & { code: string };
  }
  return Object.assign(new Error('Local inference request was cancelled.'), {
    name: 'AbortError',
    code: 'ABORT_ERR' as const,
  });
}

export interface LocalInferenceSchedulerSnapshot {
  activeCount: number;
  queuedCount: number;
  interactiveQueuedCount: number;
  backgroundQueuedCount: number;
  maxConcurrency: number;
  maxWaiting: number;
  oldestQueueWaitMs?: number;
}

/**
 * Process-wide admission point for every user-visible local generation.
 * Ollama keeps its final defensive queue, but product scheduling and priority
 * live here so Chat, skills, and Content cannot each consume an independent
 * "single" slot.
 */
class LocalInferenceScheduler {
  private active = false;
  private highWeightBurst = 0;
  private readonly interactive: Array<ScheduledWork<unknown>> = [];
  private readonly background: Array<ScheduledWork<unknown>> = [];
  private readonly idleListeners = new Set<() => void>();

  private capacityLimits(): { maxConcurrency: 1; maxWaiting: number } {
    let envelope: ReturnType<typeof getLocalModelManifest>['productionEnvelope'];
    try {
      envelope = getLocalModelManifest({ fresh: true }).productionEnvelope;
    } catch {
      throw new LocalInferenceCapacityError(
        'LOCAL_CAPACITY_BUSY',
        'Local inference manifest is unavailable; admission is closed.',
      );
    }
    if (envelope.parallelGenerations !== 1 || !Number.isSafeInteger(envelope.waitingQueueDepth)) {
      throw new LocalInferenceCapacityError(
        'LOCAL_CAPACITY_BUSY',
        'Local inference manifest has no supported concurrency envelope.',
      );
    }
    return {
      maxConcurrency: 1,
      maxWaiting: Math.min(envelope.waitingQueueDepth!, localPrimaryInferenceConfig.waitingQueueDepth),
    };
  }

  schedule<T>(input: {
    weight: number;
    executionClass: LocalInferenceExecutionClass;
    deadlineMs: number;
    /** Durable workers must not wait in the in-memory product queue. */
    rejectBackgroundWhenBusy?: boolean;
    abortSignal?: AbortSignal;
    run: () => Promise<T>;
  }): Promise<{ value: T; queueWaitMs: number }> {
    if (input.abortSignal?.aborted) return Promise.reject(cancelledError(input.abortSignal.reason));
    let limits: ReturnType<LocalInferenceScheduler['capacityLimits']>;
    try {
      limits = this.capacityLimits();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.active && this.interactive.length === 0 && this.background.length === 0) {
      this.active = true;
      return Promise.resolve()
        .then(input.run)
        .then((value) => ({ value, queueWaitMs: 0 }))
        .finally(() => {
          this.active = false;
          this.pump();
        });
    }

    if (input.executionClass === 'background' && input.rejectBackgroundWhenBusy !== false) {
      return Promise.reject(new LocalInferenceCapacityError(
        'LOCAL_CAPACITY_BUSY',
        'Local inference is busy; background work must remain durably queued.',
      ));
    }
    if (this.interactive.length + this.background.length >= limits.maxWaiting) {
      return Promise.reject(new LocalInferenceCapacityError('LOCAL_QUEUE_FULL', 'Local inference queue is full.'));
    }

    const enqueuedAt = Date.now();
    const scheduled = new Promise<{ value: T; queueWaitMs: number }>((resolve, reject) => {
      const queue = input.executionClass === 'interactive' ? this.interactive : this.background;
      let work!: ScheduledWork<T>;
      const deadlineTimer = setTimeout(() => {
        const index = queue.indexOf(work as ScheduledWork<unknown>);
        if (index < 0) return;
        queue.splice(index, 1);
        work.removeAbortListener?.();
        reject(new LocalInferenceCapacityError(
          'LOCAL_QUEUE_DEADLINE',
          'Local inference queue deadline elapsed.',
        ));
      }, Math.max(1, input.deadlineMs));
      work = {
        weight: Math.max(1, Math.floor(input.weight)),
        executionClass: input.executionClass,
        enqueuedAt,
        deadlineAt: enqueuedAt + Math.max(1, input.deadlineMs),
        run: input.run,
        resolve,
        reject,
        deadlineTimer,
      };
      if (input.abortSignal) {
        const abort = () => {
          const index = queue.indexOf(work as ScheduledWork<unknown>);
          if (index < 0) return;
          queue.splice(index, 1);
          clearTimeout(work.deadlineTimer);
          work.removeAbortListener?.();
          reject(cancelledError(input.abortSignal?.reason));
        };
        input.abortSignal.addEventListener('abort', abort, { once: true });
        work.removeAbortListener = () => input.abortSignal?.removeEventListener('abort', abort);
        if (input.abortSignal.aborted) {
          queue.push(work as ScheduledWork<unknown>);
          abort();
          return;
        }
      }
      work.deadlineTimer.unref?.();
      queue.push(work as ScheduledWork<unknown>);
      this.pump();
    });
    // A queue deadline can expire before an HTTP layer attaches its handler
    // (notably while fake timers advance). Mark the original promise handled
    // without changing the rejected promise returned to the caller.
    void scheduled.catch(() => undefined);
    return scheduled;
  }

  snapshot(): LocalInferenceSchedulerSnapshot {
    let maxWaiting = 0;
    try {
      maxWaiting = this.capacityLimits().maxWaiting;
    } catch { /* unavailable manifest closes admission */ }
    const oldest = [...this.interactive, ...this.background]
      .reduce<number | undefined>((value, work) => (
        value === undefined || work.enqueuedAt < value ? work.enqueuedAt : value
      ), undefined);
    return {
      activeCount: this.active ? 1 : 0,
      queuedCount: this.interactive.length + this.background.length,
      interactiveQueuedCount: this.interactive.length,
      backgroundQueuedCount: this.background.length,
      maxConcurrency: 1,
      maxWaiting,
      ...(oldest === undefined ? {} : { oldestQueueWaitMs: Math.max(0, Date.now() - oldest) }),
    };
  }

  /**
   * Runtime mode OFF must take effect for work that has not reached Ollama.
   * Rejecting with the normal capacity code lets each request apply its
   * existing cloud-fallback or retry contract without exposing a new error.
   * The one active generation is deliberately not interrupted mid-stream.
   */
  rejectWaitingForRuntimeOff(): number {
    const waiting = [...this.interactive.splice(0), ...this.background.splice(0)];
    for (const work of waiting) {
      clearTimeout(work.deadlineTimer);
      work.removeAbortListener?.();
      work.reject(new LocalInferenceCapacityError(
        'LOCAL_CAPACITY_BUSY',
        'Local inference routing was disabled while the request was waiting.',
      ));
    }
    this.highWeightBurst = 0;
    this.notifyIdleIfNeeded();
    return waiting.length;
  }

  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    if (!this.active && this.interactive.length === 0 && this.background.length === 0) {
      queueMicrotask(() => {
        if (this.idleListeners.has(listener)) listener();
      });
    }
    return () => this.idleListeners.delete(listener);
  }

  resetForTests(): void {
    for (const work of [...this.interactive, ...this.background]) {
      clearTimeout(work.deadlineTimer);
      work.removeAbortListener?.();
    }
    this.active = false;
    this.highWeightBurst = 0;
    this.interactive.length = 0;
    this.background.length = 0;
    this.idleListeners.clear();
  }

  private rejectExpired(queue: Array<ScheduledWork<unknown>>, now: number): void {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].deadlineAt <= now) {
        const [expired] = queue.splice(index, 1);
        clearTimeout(expired.deadlineTimer);
        expired.removeAbortListener?.();
        expired.reject(new LocalInferenceCapacityError(
          'LOCAL_QUEUE_DEADLINE',
          'Local inference queue deadline elapsed.',
        ));
      }
    }
  }

  private next(): ScheduledWork<unknown> | undefined {
    const now = Date.now();
    this.rejectExpired(this.interactive, now);
    this.rejectExpired(this.background, now);

    if (this.interactive.length > 0) {
      const highIndex = this.interactive.findIndex((work) => work.weight >= 2);
      const normalIndex = this.interactive.findIndex((work) => work.weight < 2);
      if (highIndex >= 0 && (normalIndex < 0 || this.highWeightBurst < 2)) {
        this.highWeightBurst += 1;
        const [selected] = this.interactive.splice(highIndex, 1);
        clearTimeout(selected.deadlineTimer);
        selected.removeAbortListener?.();
        return selected;
      }
      this.highWeightBurst = 0;
      const [selected] = this.interactive.splice(normalIndex >= 0 ? normalIndex : 0, 1);
      clearTimeout(selected.deadlineTimer);
      selected.removeAbortListener?.();
      return selected;
    }

    this.highWeightBurst = 0;
    const selected = this.background.shift();
    if (selected) {
      clearTimeout(selected.deadlineTimer);
      selected.removeAbortListener?.();
    }
    return selected;
  }

  private pump(): void {
    if (this.active) return;
    const work = this.next();
    if (!work) {
      this.notifyIdleIfNeeded();
      return;
    }
    this.active = true;
    const queueWaitMs = Math.max(0, Date.now() - work.enqueuedAt);
    void Promise.resolve()
      .then(work.run)
      .then((value) => work.resolve({ value, queueWaitMs }), work.reject)
      .finally(() => {
        this.active = false;
        this.pump();
      });
  }

  private notifyIdleIfNeeded(): void {
    if (this.active || this.interactive.length > 0 || this.background.length > 0) return;
    for (const listener of this.idleListeners) {
      try { listener(); } catch { /* idle callbacks cannot break admission */ }
    }
  }
}

export const localInferenceScheduler = new LocalInferenceScheduler();

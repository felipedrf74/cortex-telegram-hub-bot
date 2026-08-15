// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Bounds the number of concurrent local (Ollama) inference calls made through
 * ChatCoreV2.
 *
 * Why: on a single CPU-only Ollama instance, concurrent inference does not run
 * in parallel — requests queue and per-call latency multiplies. The 2026-05-28
 * full-suite D3 benchmark measured ~3.7s p95 serialized vs ~10-15s p95 under
 * 3-5 in flight (see
 * `docs/ai/benchmarks/chatcore-v2-planner-calibration-2026-05-27.md`). Capping
 * effective concurrency keeps each call at the serialized latency and lets the
 * progress-event UX (`CHAT_CORE_V2_PROGRESS_AFTER_MS`) cover the queue wait,
 * instead of every concurrent caller eating the full multiplied latency.
 *
 * Default is 1 (serialize) for CPU-only hardware. Raise
 * `CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY` when faster hardware or a
 * second inference instance is available. Process-scoped, like other ChatCoreV2
 * runtime helpers; tests must call `_resetLocalInferenceGateForTests()`.
 */

import { localInferenceScheduler } from '../local-inference-scheduler';
import { getLocalInferenceRuntimeControl } from '../local-inference-runtime-control';

// The pre-local-primary ChatCoreV2 rollout has its own independently
// configurable gate and queue telemetry. Keep that state isolated so the
// default-OFF release remains behavior-compatible, while every Ollama call
// made during a local-primary rollout (including shadow evaluation) continues
// through the process-wide scheduler below.
let legacyActiveCount = 0;
const legacyWaiters: Array<{ enqueuedAt: number; resolve: () => void }> = [];

function localPrimarySchedulerOwnsLegacyTraffic(): boolean {
  try {
    const mode = getLocalInferenceRuntimeControl().mode;
    return mode === 'shadow' || mode === 'canary' || mode === 'active';
  } catch {
    return false;
  }
}

export interface LocalInferenceGateSnapshot {
  activeCount: number;
  queuedCount: number;
  maxConcurrency: number;
  estimatedWaitMs?: number;
}

export function resolveLegacyLocalInferenceMaxConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number.parseInt(
    String(env.CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY ?? ''),
    10,
  );
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

export async function runWithLegacyLocalInferenceSlot<T>(
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  // Preserve the pre-existing configurable gate while local-primary is OFF.
  // As soon as governed evaluation or serving begins, every Ollama generation
  // shares the process-wide one-generation scheduler, including non-enrolled
  // legacy turns.
  if (localPrimarySchedulerOwnsLegacyTraffic()) {
    return runWithLocalInferenceSlot(fn, env);
  }
  const max = resolveLegacyLocalInferenceMaxConcurrency(env);
  if (legacyActiveCount >= max) {
    await new Promise<void>((resolve) => {
      legacyWaiters.push({
        enqueuedAt: Date.now(),
        resolve: () => {
          legacyActiveCount += 1;
          resolve();
        },
      });
    });
  } else {
    legacyActiveCount += 1;
  }
  try {
    return await fn();
  } finally {
    legacyActiveCount = Math.max(0, legacyActiveCount - 1);
    const next = legacyWaiters.shift();
    if (next) next.resolve();
  }
}

export function getLegacyLocalInferenceGateSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): LocalInferenceGateSnapshot {
  if (localPrimarySchedulerOwnsLegacyTraffic()) {
    return getLocalInferenceGateSnapshot(env);
  }
  const oldestWaiter = legacyWaiters[0];
  return {
    activeCount: legacyActiveCount,
    queuedCount: legacyWaiters.length,
    maxConcurrency: resolveLegacyLocalInferenceMaxConcurrency(env),
    estimatedWaitMs: oldestWaiter ? Math.max(0, Date.now() - oldestWaiter.enqueuedAt) : undefined,
  };
}

export function resolveLocalInferenceMaxConcurrency(
  _env: NodeJS.ProcessEnv = process.env,
): number {
  return 1;
}

/**
 * Runs `fn` while holding one local-inference slot, waiting if the configured
 * concurrency limit is already reached. The slot is always released, including
 * when `fn` rejects.
 */
export function runWithLocalInferenceSlot<T>(
  fn: () => Promise<T>,
  _env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const result = localInferenceScheduler.schedule({
    weight: 1,
    executionClass: 'interactive',
    deadlineMs: 45_000,
    run: fn,
  }).then((scheduled) => scheduled.value);
  // A caller can attach its rejection handler after the queue deadline fires.
  // Mark this derived promise handled immediately without changing what the
  // caller observes when it later awaits the original promise.
  void result.catch(() => undefined);
  return result;
}

export function getLocalInferenceGateSnapshot(
  _env: NodeJS.ProcessEnv = process.env,
): LocalInferenceGateSnapshot {
  const snapshot = localInferenceScheduler.snapshot();
  return {
    activeCount: snapshot.activeCount,
    queuedCount: snapshot.queuedCount,
    maxConcurrency: snapshot.maxConcurrency,
    estimatedWaitMs: snapshot.oldestQueueWaitMs,
  };
}

/** Test-only: reset module-scoped slot state between tests. */
export function _resetLocalInferenceGateForTests(): void {
  localInferenceScheduler.resetForTests();
  legacyActiveCount = 0;
  legacyWaiters.length = 0;
}

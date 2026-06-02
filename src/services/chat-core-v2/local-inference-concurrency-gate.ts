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

let activeCount = 0;
const waiters: Array<{ enqueuedAt: number; resolve: () => void }> = [];

export interface LocalInferenceGateSnapshot {
  activeCount: number;
  queuedCount: number;
  maxConcurrency: number;
  estimatedWaitMs?: number;
}

export function resolveLocalInferenceMaxConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number.parseInt(
    String(env.CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY ?? ''),
    10,
  );
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

/**
 * Runs `fn` while holding one local-inference slot, waiting if the configured
 * concurrency limit is already reached. The slot is always released, including
 * when `fn` rejects.
 */
export async function runWithLocalInferenceSlot<T>(
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const max = resolveLocalInferenceMaxConcurrency(env);
  await acquireSlot(max);
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

export function getLocalInferenceGateSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): LocalInferenceGateSnapshot {
  const oldestWaiter = waiters[0];
  return {
    activeCount,
    queuedCount: waiters.length,
    maxConcurrency: resolveLocalInferenceMaxConcurrency(env),
    estimatedWaitMs: oldestWaiter ? Math.max(0, Date.now() - oldestWaiter.enqueuedAt) : undefined,
  };
}

function acquireSlot(max: number): Promise<void> {
  if (activeCount < max) {
    activeCount += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push({
      enqueuedAt: Date.now(),
      resolve: () => {
        activeCount += 1;
        resolve();
      },
    });
  });
}

function releaseSlot(): void {
  activeCount = Math.max(0, activeCount - 1);
  const next = waiters.shift();
  if (next) next.resolve();
}

/** Test-only: reset module-scoped slot state between tests. */
export function _resetLocalInferenceGateForTests(): void {
  activeCount = 0;
  waiters.length = 0;
}

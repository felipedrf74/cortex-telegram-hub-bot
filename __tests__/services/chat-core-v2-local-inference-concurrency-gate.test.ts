import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLocalInferenceGateForTests,
  getLocalInferenceGateSnapshot,
  getLegacyLocalInferenceGateSnapshot,
  resolveLocalInferenceMaxConcurrency,
  resolveLegacyLocalInferenceMaxConcurrency,
  runWithLegacyLocalInferenceSlot,
  runWithLocalInferenceSlot,
} from '../../src/services/chat-core-v2/local-inference-concurrency-gate';

function envWith(max?: string): NodeJS.ProcessEnv {
  return (max === undefined ? {} : { CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY: max }) as NodeJS.ProcessEnv;
}

async function trackPeakConcurrency(env: NodeJS.ProcessEnv, taskCount: number): Promise<number> {
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: taskCount }, () =>
    runWithLocalInferenceSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return true;
    }, env));
  await Promise.all(tasks);
  return peak;
}

describe('ChatCoreV2 local inference concurrency gate', () => {
  beforeEach(() => {
    _resetLocalInferenceGateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to serialized execution (max concurrency 1)', () => {
    expect(resolveLocalInferenceMaxConcurrency(envWith())).toBe(1);
    expect(resolveLocalInferenceMaxConcurrency(envWith('0'))).toBe(1);
    expect(resolveLocalInferenceMaxConcurrency(envWith('not-a-number'))).toBe(1);
    expect(resolveLocalInferenceMaxConcurrency(envWith('3'))).toBe(1);
  });

  it('serializes local inference when max concurrency is 1', async () => {
    expect(await trackPeakConcurrency(envWith('1'), 4)).toBe(1);
  });

  it('ignores the retired Chat-only concurrency override and remains globally serialized', async () => {
    expect(await trackPeakConcurrency(envWith('2'), 4)).toBe(1);
  });

  it('preserves the legacy Chat-only gate and queue telemetry while local-primary is off', async () => {
    const env = envWith('3');
    expect(resolveLegacyLocalInferenceMaxConcurrency(env)).toBe(3);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () => runWithLegacyLocalInferenceSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    }, env));
    await Promise.all(tasks);
    expect(peak).toBe(3);
    expect(getLegacyLocalInferenceGateSnapshot(env)).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      maxConcurrency: 3,
    });
  });

  it('releases the slot even when the task throws', async () => {
    const env = envWith('1');
    await expect(
      runWithLocalInferenceSlot(async () => {
        throw new Error('boom');
      }, env),
    ).rejects.toThrow('boom');
    // A subsequent call must still be able to acquire a slot.
    await expect(runWithLocalInferenceSlot(async () => 'ok', env)).resolves.toBe('ok');
  });

  it('exposes a safe queue snapshot for queue-fallback policy decisions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    const env = envWith('1');
    let releaseFirst!: () => void;
    const first = runWithLocalInferenceSlot(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return true;
    }, env);

    const second = runWithLocalInferenceSlot(async () => true, env);
    await Promise.resolve();
    await Promise.resolve();
    vi.setSystemTime(new Date('2026-05-29T12:00:03.000Z'));

    expect(getLocalInferenceGateSnapshot(env)).toEqual({
      activeCount: 1,
      queuedCount: 1,
      maxConcurrency: 1,
      estimatedWaitMs: 3000,
    });

    releaseFirst();
    await Promise.all([first, second]);
    expect(getLocalInferenceGateSnapshot(env)).toEqual({
      activeCount: 0,
      queuedCount: 0,
      maxConcurrency: 1,
      estimatedWaitMs: undefined,
    });
  });
});

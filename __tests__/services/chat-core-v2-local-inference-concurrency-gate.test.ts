import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetLocalInferenceGateForTests,
  resolveLocalInferenceMaxConcurrency,
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

  it('defaults to serialized execution (max concurrency 1)', () => {
    expect(resolveLocalInferenceMaxConcurrency(envWith())).toBe(1);
    expect(resolveLocalInferenceMaxConcurrency(envWith('0'))).toBe(1);
    expect(resolveLocalInferenceMaxConcurrency(envWith('not-a-number'))).toBe(1);
    expect(resolveLocalInferenceMaxConcurrency(envWith('3'))).toBe(3);
  });

  it('serializes local inference when max concurrency is 1', async () => {
    expect(await trackPeakConcurrency(envWith('1'), 4)).toBe(1);
  });

  it('allows the configured concurrency above 1', async () => {
    expect(await trackPeakConcurrency(envWith('2'), 4)).toBe(2);
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
});

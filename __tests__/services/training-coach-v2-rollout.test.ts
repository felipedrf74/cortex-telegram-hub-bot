import { afterEach, describe, expect, it } from 'vitest';
import { isTrainingCoachV2Enabled } from '../../src/services/training-coach-v2-rollout';

describe('Training Coach V2 rollout kill switch', () => {
  afterEach(() => delete process.env.COACH_PERIODIZATION_V2_ENABLED);

  it.each([
    [undefined, false],
    ['', false],
    ['off', false],
    ['malformed', false],
    ['ON', false],
    [' on ', false],
    ['on', true],
  ])('interprets %p as enabled=%p', (raw, enabled) => {
    if (raw === undefined) delete process.env.COACH_PERIODIZATION_V2_ENABLED;
    else process.env.COACH_PERIODIZATION_V2_ENABLED = raw;
    expect(isTrainingCoachV2Enabled()).toBe(enabled);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  findTrainingE2EProfileVisibilityGaps,
  waitForTrainingE2EProfilesVisible,
} from '../../scripts/lib/training-e2e-profile-visibility.mjs';

const expectedProfiles = [
  {
    profileType: 'fitness',
    data: {
      experience_level: 'Intermediate',
      weekly_frequency: '4-5 days',
    },
  },
  {
    profileType: 'triathlon-gym',
    data: {
      equipment_access: 'Full commercial gym',
    },
  },
];

function visiblePayload() {
  return {
    data: {
      profiles: expectedProfiles.map((profile) => ({
        type: profile.profileType,
        data: profile.data,
      })),
    },
  };
}

describe('Training E2E profile visibility barrier', () => {
  it('waits until the backend observes every fixture-seeded profile field', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ status: 200, payload: { data: { profiles: [] } } })
      .mockResolvedValueOnce({ status: 200, payload: visiblePayload() });

    await expect(waitForTrainingE2EProfilesVisible({
      api,
      expectedProfiles,
      timeoutMs: 100,
      pollMs: 0,
      sleep: async () => undefined,
    })).resolves.toEqual({ attempts: 2 });

    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenCalledWith('GET', '/api/v1/onboarding/profile', undefined, [200]);
  });

  it('reports missing and stale field names without leaking profile values', async () => {
    const payload = visiblePayload();
    payload.data.profiles[0].data = {
      experience_level: 'Stale value',
    } as typeof payload.data.profiles[0]['data'];

    expect(findTrainingE2EProfileVisibilityGaps(expectedProfiles, payload)).toEqual([
      'fitness.experience_level:stale',
      'fitness.weekly_frequency:missing',
    ]);

    const api = vi.fn().mockResolvedValue({ status: 200, payload });
    await expect(waitForTrainingE2EProfilesVisible({
      api,
      expectedProfiles,
      timeoutMs: 0,
      pollMs: 0,
      sleep: async () => undefined,
    })).rejects.toThrow(
      /fitness\.experience_level:stale, fitness\.weekly_frequency:missing/,
    );
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Compare seeded profile fixtures with the authenticated backend read model.
 * Separate SQLite connections can observe transaction boundaries at different
 * instants; generation must not race that boundary.
 * Diagnostics intentionally report field names and states, never values.
 *
 * @param {Array<{ profileType: string, data: Record<string, unknown> }>} expectedProfiles
 * @param {unknown} payload
 * @returns {string[]}
 */
export function findTrainingE2EProfileVisibilityGaps(expectedProfiles, payload) {
  const actualProfiles = Array.isArray(payload?.data?.profiles)
    ? payload.data.profiles
    : [];
  const actualByType = new Map(actualProfiles
    .filter((profile) => profile && typeof profile.type === 'string')
    .map((profile) => [profile.type, profile]));
  const gaps = [];

  for (const expected of expectedProfiles) {
    const actual = actualByType.get(expected.profileType);
    if (!actual) {
      gaps.push(`${expected.profileType}:missing`);
      continue;
    }
    const actualData = actual.data && typeof actual.data === 'object' && !Array.isArray(actual.data)
      ? actual.data
      : {};
    for (const [fieldKey, expectedValue] of Object.entries(expected.data)) {
      if (!Object.prototype.hasOwnProperty.call(actualData, fieldKey)) {
        gaps.push(`${expected.profileType}.${fieldKey}:missing`);
        continue;
      }
      if (JSON.stringify(actualData[fieldKey]) !== JSON.stringify(expectedValue)) {
        gaps.push(`${expected.profileType}.${fieldKey}:stale`);
      }
    }
  }
  return gaps;
}

/**
 * Bounded visibility barrier between the fixture writer and the long-lived
 * backend connection in the same Linux lock domain.
 *
 * @param {{
 *   api: (method: string, route: string, body?: unknown, expectedStatuses?: number[]) => Promise<{ status: number, payload: unknown }>,
 *   expectedProfiles: Array<{ profileType: string, data: Record<string, unknown> }>,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   sleep?: (milliseconds: number) => Promise<unknown>,
 * }} input
 * @returns {Promise<{ attempts: number }>}
 */
export async function waitForTrainingE2EProfilesVisible(input) {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const pollMs = input.pollMs ?? 250;
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = Date.now();
  let attempts = 0;
  let lastGaps = [];

  for (;;) {
    const response = await input.api('GET', '/api/v1/onboarding/profile', undefined, [200]);
    attempts += 1;
    lastGaps = findTrainingE2EProfileVisibilityGaps(input.expectedProfiles, response.payload);
    if (lastGaps.length === 0) return { attempts };
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Training E2E profiles did not become visible to the backend within ${timeoutMs}ms `
        + `after ${attempts} attempts; gaps=${lastGaps.join(', ')}`,
      );
    }
    await sleep(pollMs);
  }
}

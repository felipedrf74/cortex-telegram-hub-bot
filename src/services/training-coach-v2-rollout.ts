// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Single dynamic rollout authority for every Coach V2 entry and mutation
 * boundary. Exact `on` enables the staging capability; unset, explicit
 * `off`, and malformed values fail closed. The post-GO default-on change is
 * intentionally a separate release.
 */
export function isTrainingCoachV2Enabled(
  raw = process.env.COACH_PERIODIZATION_V2_ENABLED,
): boolean {
  return raw === 'on';
}

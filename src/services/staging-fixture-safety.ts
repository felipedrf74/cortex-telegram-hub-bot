// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { IosJwtPayload } from './ios-jwt';

export const STAGING_FIXTURE_USER_ID_MIN = 1_000_000;
export const STAGING_FIXTURE_USER_ID_MAX = 1_099_999;
export const STAGING_FIXTURE_CLAIM = 'staging_fixture';

export interface StagingFixtureSafetyResult {
  ok: boolean;
  reason?: 'production_claim' | 'production_reserved_user' | 'claim_without_reserved_user' | 'reserved_user_without_claim';
}

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' && env.STAGING !== 'true';
}

export function isStagingFixtureUserId(userId: unknown): userId is number {
  return typeof userId === 'number'
    && Number.isInteger(userId)
    && userId >= STAGING_FIXTURE_USER_ID_MIN
    && userId <= STAGING_FIXTURE_USER_ID_MAX;
}

export function hasStagingFixtureClaim(payload: IosJwtPayload): boolean {
  return payload[STAGING_FIXTURE_CLAIM] === true;
}

export function validateStagingFixtureJwtPayload(
  payload: IosJwtPayload,
  env: NodeJS.ProcessEnv = process.env,
): StagingFixtureSafetyResult {
  const hasClaim = hasStagingFixtureClaim(payload);
  const isReservedUser = isStagingFixtureUserId(payload.userId);

  if (isProductionRuntime(env)) {
    if (hasClaim) return { ok: false, reason: 'production_claim' };
    if (isReservedUser) return { ok: false, reason: 'production_reserved_user' };
  }

  if (hasClaim && !isReservedUser) {
    return { ok: false, reason: 'claim_without_reserved_user' };
  }

  if (isReservedUser && !hasClaim) {
    return { ok: false, reason: 'reserved_user_without_claim' };
  }

  return { ok: true };
}

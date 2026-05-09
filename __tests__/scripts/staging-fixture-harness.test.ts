import { describe, expect, it } from 'vitest';
import {
  STAGING_FIXTURE_USER_ID_MAX,
  STAGING_FIXTURE_USER_ID_MIN,
  hasStagingFixtureClaim,
  isProductionRuntime,
  isStagingFixtureUserId,
  validateStagingFixtureJwtPayload,
} from '../../src/services/staging-fixture-safety';

describe('staging fixture harness safety boundaries', () => {
  it('refuses production and non-staging hostnames before network work', async () => {
    const { validateStagingTarget, resolveTargetUrl } = await import('../../scripts/staging-fixture-harness.mjs');

    expect(validateStagingTarget('https://api.nexushub.me')).toEqual({
      ok: false,
      reason: 'Refusing production API hostname api.nexushub.me',
    });
    expect(validateStagingTarget('https://example.com')).toEqual({
      ok: false,
      reason: 'Refusing non-staging hostname example.com',
    });
    expect(validateStagingTarget('https://staging-api.nexushub.me').ok).toBe(true);
    expect(resolveTargetUrl({}, { PRODUCTION_URL: 'https://api.nexushub.me' })).toBe('https://api.nexushub.me');
  });

  it('recognizes only the reserved synthetic user-id range', () => {
    expect(isStagingFixtureUserId(STAGING_FIXTURE_USER_ID_MIN)).toBe(true);
    expect(isStagingFixtureUserId(STAGING_FIXTURE_USER_ID_MAX)).toBe(true);
    expect(isStagingFixtureUserId(STAGING_FIXTURE_USER_ID_MIN - 1)).toBe(false);
    expect(isStagingFixtureUserId(STAGING_FIXTURE_USER_ID_MAX + 1)).toBe(false);
    expect(isStagingFixtureUserId('1000000')).toBe(false);
  });

  it('detects production runtime without treating staging as production', () => {
    expect(isProductionRuntime({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: 'production', STAGING: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: 'staging', STAGING: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('requires the staging_fixture claim and reserved user id to travel together', () => {
    expect(hasStagingFixtureClaim({ userId: STAGING_FIXTURE_USER_ID_MIN, staging_fixture: true })).toBe(true);

    expect(validateStagingFixtureJwtPayload({
      userId: STAGING_FIXTURE_USER_ID_MIN,
      staging_fixture: true,
    }, { NODE_ENV: 'staging', STAGING: 'true' } as NodeJS.ProcessEnv)).toEqual({ ok: true });

    expect(validateStagingFixtureJwtPayload({
      userId: STAGING_FIXTURE_USER_ID_MIN,
    }, { NODE_ENV: 'staging', STAGING: 'true' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: 'reserved_user_without_claim',
    });

    expect(validateStagingFixtureJwtPayload({
      userId: 25,
      staging_fixture: true,
    }, { NODE_ENV: 'staging', STAGING: 'true' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: 'claim_without_reserved_user',
    });
  });

  it('rejects staging fixture claims and reserved user IDs in production', () => {
    expect(validateStagingFixtureJwtPayload({
      userId: STAGING_FIXTURE_USER_ID_MIN,
      staging_fixture: true,
    }, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: 'production_claim',
    });

    expect(validateStagingFixtureJwtPayload({
      userId: STAGING_FIXTURE_USER_ID_MIN,
    }, { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: 'production_reserved_user',
    });
  });
});

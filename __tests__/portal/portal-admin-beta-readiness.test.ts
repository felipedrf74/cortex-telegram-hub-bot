import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  logger: {
    fatal: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: hoisted.logger,
}));

import {
  getPortalAdminExposureMode,
  isPortalAdminExposureBetaSafe,
  validatePortalAdminBetaReadiness,
  type PortalAdminExposureConfig,
} from '../../src/portal/security';

function baseConfig(overrides: Partial<PortalAdminExposureConfig> = {}): PortalAdminExposureConfig {
  return {
    adminToken: '',
    token: '',
    allowLegacyFallback: false,
    allowLocalBypass: false,
    sessionSecret: '',
    requireSessionAuth: false,
    adminActorAllowlist: [],
    adminRequireActor: false,
    adminActorSignatureSecret: '',
    betaHardened: false,
    ...overrides,
  };
}

describe('portal admin exposure classification', () => {
  beforeEach(() => {
    hoisted.logger.fatal.mockReset();
    hoisted.logger.warn.mockReset();
    hoisted.logger.info.mockReset();
  });

  it('returns disabled when no admin credentials and no session secret are configured', () => {
    expect(getPortalAdminExposureMode(baseConfig())).toBe('disabled');
  });

  it('returns loopback_only when only loopback bypass is enabled', () => {
    expect(getPortalAdminExposureMode(baseConfig({ allowLocalBypass: true }))).toBe('loopback_only');
  });

  it('returns session_only when session auth is required and the secret is present', () => {
    expect(
      getPortalAdminExposureMode(
        baseConfig({ sessionSecret: 'session-signing-secret', requireSessionAuth: true, adminToken: 'static-admin-token' }),
      ),
    ).toBe('session_only');
  });

  it('returns signed_static when static admin token plus actor signature secret are configured', () => {
    expect(
      getPortalAdminExposureMode(
        baseConfig({ adminToken: 'static-admin-token', adminActorSignatureSecret: 'actor-hmac-secret' }),
      ),
    ).toBe('signed_static');
  });

  it('returns static_allowlisted when static admin token plus an actor allowlist are configured', () => {
    expect(
      getPortalAdminExposureMode(
        baseConfig({
          adminToken: 'static-admin-token',
          adminActorAllowlist: ['operator@nexushub.me'],
        }),
      ),
    ).toBe('static_allowlisted');
  });

  it('returns static_with_actor when static admin token plus require-actor (no allowlist) is configured', () => {
    expect(
      getPortalAdminExposureMode(
        baseConfig({ adminToken: 'static-admin-token', adminRequireActor: true }),
      ),
    ).toBe('static_with_actor');
  });

  it('returns static_open when only a static admin token is configured without actor hardening', () => {
    expect(
      getPortalAdminExposureMode(baseConfig({ adminToken: 'static-admin-token' })),
    ).toBe('static_open');
  });

  it('treats legacy tokens as admin-capable only when the legacy fallback flag is on', () => {
    expect(
      getPortalAdminExposureMode(baseConfig({ token: 'legacy-token', allowLegacyFallback: true })),
    ).toBe('static_open');

    expect(
      getPortalAdminExposureMode(baseConfig({ token: 'legacy-token', allowLegacyFallback: false })),
    ).toBe('disabled');
  });

  it('classifies the beta-safe modes', () => {
    expect(isPortalAdminExposureBetaSafe('disabled')).toBe(true);
    expect(isPortalAdminExposureBetaSafe('loopback_only')).toBe(true);
    expect(isPortalAdminExposureBetaSafe('session_only')).toBe(true);
    expect(isPortalAdminExposureBetaSafe('signed_static')).toBe(true);
    expect(isPortalAdminExposureBetaSafe('static_allowlisted')).toBe(false);
    expect(isPortalAdminExposureBetaSafe('static_with_actor')).toBe(false);
    expect(isPortalAdminExposureBetaSafe('static_open')).toBe(false);
  });
});

describe('portal admin beta readiness preflight', () => {
  beforeEach(() => {
    hoisted.logger.fatal.mockReset();
    hoisted.logger.warn.mockReset();
    hoisted.logger.info.mockReset();
  });

  it('refuses to start when PORTAL_REQUIRE_SESSION_AUTH=true but no session secret is configured', () => {
    expect(() =>
      validatePortalAdminBetaReadiness(
        baseConfig({ requireSessionAuth: true, adminToken: 'static-admin-token' }),
        { nodeEnv: 'production' },
      ),
    ).toThrow(/PORTAL_SESSION_SECRET/);
    expect(hoisted.logger.fatal).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when PORTAL_BETA_HARDENED=true and admin exposure is not beta-safe', () => {
    expect(() =>
      validatePortalAdminBetaReadiness(
        baseConfig({
          betaHardened: true,
          adminToken: 'static-admin-token',
          adminRequireActor: true,
        }),
        { nodeEnv: 'production' },
      ),
    ).toThrow(/PORTAL_BETA_HARDENED/);
    expect(hoisted.logger.fatal).toHaveBeenCalledTimes(1);
  });

  it('allows boot when PORTAL_BETA_HARDENED=true and admin exposure is beta-safe (session_only)', () => {
    const mode = validatePortalAdminBetaReadiness(
      baseConfig({
        betaHardened: true,
        sessionSecret: 'session-signing-secret',
        requireSessionAuth: true,
        adminToken: 'static-admin-token',
      }),
      { nodeEnv: 'production' },
    );
    expect(mode).toBe('session_only');
    expect(hoisted.logger.fatal).not.toHaveBeenCalled();
  });

  it('allows boot when PORTAL_BETA_HARDENED=true and admin exposure is beta-safe (signed_static)', () => {
    const mode = validatePortalAdminBetaReadiness(
      baseConfig({
        betaHardened: true,
        adminToken: 'static-admin-token',
        adminActorSignatureSecret: 'actor-hmac-secret',
      }),
      { nodeEnv: 'production' },
    );
    expect(mode).toBe('signed_static');
    expect(hoisted.logger.fatal).not.toHaveBeenCalled();
  });

  it('warns in production when admin is exposed without signed sessions or actor signatures', () => {
    const mode = validatePortalAdminBetaReadiness(
      baseConfig({ adminToken: 'static-admin-token' }),
      { nodeEnv: 'production' },
    );
    expect(mode).toBe('static_open');
    expect(hoisted.logger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = hoisted.logger.warn.mock.calls[0];
    expect(payload).toMatchObject({ adminExposureMode: 'static_open' });
    expect(String(message)).toContain('signed sessions');
  });

  it('does not warn in production for beta-safe modes', () => {
    validatePortalAdminBetaReadiness(
      baseConfig({ sessionSecret: 'session-signing-secret', requireSessionAuth: true }),
      { nodeEnv: 'production' },
    );
    expect(hoisted.logger.warn).not.toHaveBeenCalled();
    expect(hoisted.logger.info).toHaveBeenCalledTimes(1);
    expect(hoisted.logger.info.mock.calls[0][0]).toMatchObject({ adminExposureMode: 'session_only' });
  });

  it('does not warn in development even when admin is static_open', () => {
    validatePortalAdminBetaReadiness(
      baseConfig({ adminToken: 'static-admin-token' }),
      { nodeEnv: 'development' },
    );
    expect(hoisted.logger.warn).not.toHaveBeenCalled();
    expect(hoisted.logger.info).toHaveBeenCalledTimes(1);
  });
});

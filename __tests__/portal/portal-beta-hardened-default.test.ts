import { afterEach, describe, expect, it, vi } from 'vitest';

// PORTAL_BETA_HARDENED gates the boot preflight that refuses a non-beta-safe
// admin exposure mode. Cookie sessions exist and both deployed environments
// run hardened, so production now defaults to hardened while every other
// NODE_ENV keeps the permissive default that local sandboxes rely on.

const ORIGINAL_ENV = { ...process.env };
// Production boot also demands the finance encryption pair; supply throwaway
// values so only the flag under test varies between cases.
const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  FINANCE_ENCRYPTION_ENABLED: 'true',
  FINANCE_ENCRYPTION_KEY: 'a1'.repeat(32),
  BACKUP_ENABLED: 'false',
  NEXUS_RELEASE_ENVIRONMENT: undefined,
  // STAGING=true keeps the live-production payment and StoreKit preflights
  // out of the way; the beta-hardened default keys off NODE_ENV alone.
  STAGING: 'true',
};

async function loadPortalConfig(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = await import('../../src/config');
  return mod.config.portal;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('PORTAL_BETA_HARDENED default', () => {
  it('defaults to hardened when NODE_ENV=production', async () => {
    const portal = await loadPortalConfig({ ...PRODUCTION_ENV, PORTAL_BETA_HARDENED: undefined });
    expect(portal.betaHardened).toBe(true);
  });

  it('defaults to permissive outside production', async () => {
    const dev = await loadPortalConfig({ NODE_ENV: 'development', PORTAL_BETA_HARDENED: undefined });
    expect(dev.betaHardened).toBe(false);
    const test = await loadPortalConfig({ NODE_ENV: 'test', PORTAL_BETA_HARDENED: undefined });
    expect(test.betaHardened).toBe(false);
  });

  it('an explicit value always wins', async () => {
    const off = await loadPortalConfig({ ...PRODUCTION_ENV, PORTAL_BETA_HARDENED: 'false' });
    expect(off.betaHardened).toBe(false);
    const on = await loadPortalConfig({ NODE_ENV: 'development', PORTAL_BETA_HARDENED: 'true' });
    expect(on.betaHardened).toBe(true);
  });
});

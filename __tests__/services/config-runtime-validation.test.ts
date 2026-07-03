import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadConfigFresh() {
  vi.resetModules();
  return import('../../src/config');
}

function applyMinimalConfigEnv() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('IOS_API_ENABLED', 'false');
  vi.stubEnv('STAGING', 'false');
}

function applySafeProductionEnv() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('STAGING', 'false');
  vi.stubEnv('FINANCE_ENCRYPTION_KEY', 'prod-finance-key-at-least-32-chars');
  vi.stubEnv('BACKUP_ENABLED', 'true');
  vi.stubEnv('BACKUP_ENCRYPT', 'true');
  vi.stubEnv('BACKUP_KEY', 'prod-backup-key-at-least-32-chars');
  vi.stubEnv('NOTIFICATION_DELIVERY_MODE', 'apns');
  vi.stubEnv('APNS_ENABLED', 'false');
  vi.stubEnv('OPERATOR_ALERT_WEBHOOK_URL', 'https://example.test/operator-alerts');
  vi.stubEnv('SENTRY_DSN', 'https://public@example.test/1');
}

describe('runtime config validation', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllEnvs();
    applyMinimalConfigEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it('fails fast on invalid integer env values instead of silently producing NaN', async () => {
    vi.stubEnv('AI_CB_FAILURE_THRESHOLD', 'not-a-number');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Invalid numeric environment variable: AI_CB_FAILURE_THRESHOLD="not-a-number"',
    );
  });

  it('fails fast on invalid float env values instead of silently producing NaN', async () => {
    vi.stubEnv('COST_ALERT_THRESHOLD', 'oops');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Invalid numeric environment variable: COST_ALERT_THRESHOLD="oops"',
    );
  });

  it('respects explicit test env values instead of letting dotenv override them', async () => {
    vi.stubEnv('PORTAL_PORT', '9999');

    const { config } = await loadConfigFresh();

    expect(config.portal.port).toBe(9999);
  });

  it('parses valid bounded numeric env values normally', async () => {
    vi.stubEnv('CONTENT_ENGINE_PORT', '9100');
    vi.stubEnv('INVOICE_MIN_CONFIDENCE', '0.9');

    const { config } = await loadConfigFresh();

    expect(config.contentEngine.port).toBe(9100);
    expect(config.contentEngine.baseUrl).toBe('http://localhost:9100');
    expect(config.invoices.minConfidence).toBe(0.9);
  });

  it('allows Docker service discovery to override the content-engine base URL', async () => {
    vi.stubEnv('CONTENT_ENGINE_BASE_URL', 'http://content-engine:8100');

    const { config } = await loadConfigFresh();

    expect(config.contentEngine.baseUrl).toBe('http://content-engine:8100');
  });

  it('defaults generic chat routing to OpenAI nano with Gemini fallback', async () => {
    vi.stubEnv('AI_CHAT_PRIMARY', '');
    vi.stubEnv('AI_CHAT_FALLBACK', '');

    const { config } = await loadConfigFresh();

    expect(config.providerRouting.chat).toEqual({ primary: 'openai', fallback: 'gemini' });
  });

  it('exposes public waitlist IP salt through central config', async () => {
    vi.stubEnv('WAITLIST_IP_SALT', 'stable-waitlist-secret');

    const { config } = await loadConfigFresh();

    expect(config.waitlist.ipSalt).toBe('stable-waitlist-secret');
    expect(config.waitlist.warnOnEphemeralIpSalt).toBe(false);
  });

  it('fails fast when production tries to boot with PAYWALL_ENABLED=false', async () => {
    applySafeProductionEnv();
    vi.stubEnv('PAYWALL_ENABLED', 'false');

    await expect(loadConfigFresh()).rejects.toThrow(
      'PAYWALL_ENABLED=false is only allowed in test, development, or staging environments. Refusing unsafe startup.',
    );
  });

  it('allows PAYWALL_ENABLED=false in development-like runtimes for local testing', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STAGING', 'false');
    vi.stubEnv('PAYWALL_ENABLED', 'false');

    const { config } = await loadConfigFresh();

    expect(config.billing.paywallEnabled).toBe(false);
    expect(config.billing.allowUnsafePaywallBypass).toBe(true);
  });

  it('fails fast in production when finance encryption is missing FINANCE_ENCRYPTION_KEY', async () => {
    applySafeProductionEnv();
    vi.stubEnv('FINANCE_ENCRYPTION_ENABLED', 'true');
    vi.stubEnv('FINANCE_ENCRYPTION_KEY', '');

    await expect(loadConfigFresh()).rejects.toThrow(
      'FINANCE_ENCRYPTION_ENABLED=true and FINANCE_ENCRYPTION_KEY are required in production.',
    );
  });

  it('fails fast in production when finance encryption is disabled', async () => {
    applySafeProductionEnv();
    vi.stubEnv('FINANCE_ENCRYPTION_ENABLED', 'false');

    await expect(loadConfigFresh()).rejects.toThrow(
      'FINANCE_ENCRYPTION_ENABLED=true and FINANCE_ENCRYPTION_KEY are required in production.',
    );
  });

  it('fails fast in production when database backups are not encrypted', async () => {
    applySafeProductionEnv();
    vi.stubEnv('BACKUP_ENABLED', 'true');
    vi.stubEnv('BACKUP_ENCRYPT', 'false');
    vi.stubEnv('BACKUP_KEY', '');

    await expect(loadConfigFresh()).rejects.toThrow(
      'BACKUP_ENABLED=true requires BACKUP_ENCRYPT=true and BACKUP_KEY in production.',
    );
  });

  it('requires an explicit apns notification delivery mode when production APNs credentials are configured', async () => {
    applySafeProductionEnv();
    vi.stubEnv('NOTIFICATION_DELIVERY_MODE', '');
    vi.stubEnv('APNS_ENABLED', 'true');
    vi.stubEnv('APNS_TEAM_ID', 'TEAMID1234');
    vi.stubEnv('APNS_KEY_ID', 'KEYID12345');
    vi.stubEnv('APNS_AUTH_KEY_P8', '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----');
    vi.stubEnv('APNS_BUNDLE_ID', 'me.nexushub.app');

    await expect(loadConfigFresh()).rejects.toThrow(
      'NOTIFICATION_DELIVERY_MODE=apns is required in production when APNs credentials are configured.',
    );
  });

  it('defaults notification delivery to mock outside production and accepts explicit apns in production', async () => {
    vi.stubEnv('NOTIFICATION_DELIVERY_MODE', '');

    const local = await loadConfigFresh();
    expect(local.config.notificationDelivery.mode).toBe('mock');

    applySafeProductionEnv();
    const production = await loadConfigFresh();
    expect(production.config.notificationDelivery.mode).toBe('apns');
  });

  it('fails fast on invalid notification delivery modes', async () => {
    vi.stubEnv('NOTIFICATION_DELIVERY_MODE', 'invalid-mode');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Invalid NOTIFICATION_DELIVERY_MODE="invalid-mode". Expected one of: mock, apns.',
    );
  });

  it('warns loudly in production when operator alert webhook or Sentry DSN is missing', async () => {
    applySafeProductionEnv();
    vi.stubEnv('OPERATOR_ALERT_WEBHOOK_URL', '');
    vi.stubEnv('SENTRY_DSN', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await loadConfigFresh();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OPERATOR_ALERT_WEBHOOK_URL is not set'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SENTRY_DSN is not set'));
    warnSpy.mockRestore();
  });

  it('fails fast when iOS API is enabled with a weak JWT secret', async () => {
    vi.stubEnv('IOS_API_ENABLED', 'true');
    vi.stubEnv('IOS_API_JWT_SECRET', 'change-me');
    vi.stubEnv('IOS_INVITE_CODE', 'invite');

    await expect(loadConfigFresh()).rejects.toThrow(
      'IOS_API_JWT_SECRET must be at least 32 bytes and cannot contain known placeholder text.',
    );
  });

  it('fails fast when production binds the portal to a wildcard address without explicit acknowledgement', async () => {
    applySafeProductionEnv();
    vi.stubEnv('PORTAL_BIND', '0.0.0.0');
    vi.stubEnv('PORTAL_PUBLIC_BIND_ACK', '');

    await expect(loadConfigFresh()).rejects.toThrow(
      'PORTAL_BIND=0.0.0.0 exposes the portal on every interface. Use 127.0.0.1 behind a tunnel/reverse proxy or set PORTAL_PUBLIC_BIND_ACK=production-public-host-reviewed.',
    );
  });

  it('allows Stripe Nexus Points to stay disabled without point price ids', async () => {
    vi.stubEnv('STRIPE_NEXUS_POINTS_ENABLED', 'false');
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');

    const { config } = await loadConfigFresh();

    expect(config.stripe.nexusPoints.enabled).toBe(false);
    expect(config.stripe.nexusPoints.priceIds.small).toBe('');
  });

  it('fails fast when Stripe Nexus Points are enabled without required env vars', async () => {
    vi.stubEnv('STRIPE_NEXUS_POINTS_ENABLED', 'true');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_SMALL', 'price_small');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_MEDIUM', '');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_LARGE', 'price_large');
    vi.stubEnv('PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET', 'signed-actors');

    await expect(loadConfigFresh()).rejects.toThrow(
      'STRIPE_NEXUS_POINTS_ENABLED=true but required env vars are missing: STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID_POINTS_MEDIUM',
    );
  });

  it('requires signed portal actor attribution when Stripe Nexus Points are enabled', async () => {
    vi.stubEnv('STRIPE_NEXUS_POINTS_ENABLED', 'true');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_SMALL', 'price_small');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_MEDIUM', 'price_medium');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_LARGE', 'price_large');
    vi.stubEnv('PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET', '');

    await expect(loadConfigFresh()).rejects.toThrow(
      'STRIPE_NEXUS_POINTS_ENABLED requires PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET to be set so admin-issued purchases have signed attribution.',
    );
  });

  it('refuses live Stripe secret keys outside production when Nexus Points are enabled', async () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('STRIPE_NEXUS_POINTS_ENABLED', 'true');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_accidental');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_SMALL', 'price_small');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_MEDIUM', 'price_medium');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_LARGE', 'price_large');
    vi.stubEnv('PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET', 'signed-actors');

    await expect(loadConfigFresh()).rejects.toThrow(
      'STRIPE_SECRET_KEY appears to be a live key (sk_live_*) but NODE_ENV is not production.',
    );
  });
});

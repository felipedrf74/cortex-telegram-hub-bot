import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadConfigFresh() {
  vi.resetModules();
  return import('../../src/config');
}

function applyMinimalConfigEnv() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_ALLOWED_USER_IDS', '123456');
  vi.stubEnv('IOS_API_ENABLED', 'false');
  vi.stubEnv('STAGING', 'false');
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
    expect(config.invoices.minConfidence).toBe(0.9);
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
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('STAGING', 'false');
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

    await expect(loadConfigFresh()).rejects.toThrow(
      'STRIPE_NEXUS_POINTS_ENABLED=true but required env vars are missing: STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID_POINTS_MEDIUM',
    );
  });
});

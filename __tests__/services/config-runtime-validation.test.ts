import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const FULL_TRAINING_M4_ALLOWLIST = ['event_based', 'continuous', 'maintenance', 'return_to_training']
  .flatMap((mode) => ['running', 'cycling', 'swimming', 'strength', 'triathlon', 'hybrid', 'marathon']
    .map((discipline) => `${mode}:${discipline}`))
  .join(',');

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

function applyCompleteTrainingPublicBetaEnv() {
  vi.stubEnv('TRAINING_PUBLIC_BETA_V1_ENABLED', 'true');
  vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'active');
  vi.stubEnv('TRAINING_TYPED_WORKOUT_V1_ENABLED', 'true');
  vi.stubEnv('TRAINING_ADAPTATION_V1_MODE', 'active');
  vi.stubEnv('TRAINING_EXERCISE_IDENTITY_V1_MODE', 'active');
  vi.stubEnv('TRAINING_EXERCISE_MEDIA_V1_ENABLED', 'true');
  vi.stubEnv('TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED', 'true');
  vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED', 'false');
  vi.stubEnv('TRAINING_PLAN_M4_ALLOWLIST', FULL_TRAINING_M4_ALLOWLIST);
  vi.stubEnv('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY', 'training-public-beta-key-00000001');
  vi.stubEnv('TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED', 'false');
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

  it('centralizes fail-closed Content workspace rollout defaults', async () => {
    vi.stubEnv('CONTENT_WORKSPACE_V1_MODE', 'unexpected');
    vi.stubEnv('CONTENT_WORKSPACE_V1_GLOBAL_WRITE', 'yes');
    vi.stubEnv('CONTENT_WORKSPACE_V1_CORE_WRITES', 'invalid');
    vi.stubEnv('CONTENT_WORKSPACE_V1_REVISION_WRITES', 'on');

    const { config } = await loadConfigFresh();

    expect(config.contentWorkspaceRollout).toMatchObject({
      mode: 'read_only',
      globalWrite: true,
      slices: {
        core: false,
        revisions: true,
      },
    });
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

  it('preserves staging-only validation when a container uses NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('STAGING', 'true');
    vi.stubEnv('PAYWALL_ENABLED', 'false');
    vi.stubEnv('FINANCE_ENCRYPTION_ENABLED', 'true');
    vi.stubEnv('FINANCE_ENCRYPTION_KEY', 'staging-finance-key-at-least-32-chars');
    vi.stubEnv('BACKUP_ENABLED', 'false');
    vi.stubEnv('BACKUP_ENCRYPT', 'false');
    vi.stubEnv('BACKUP_KEY', '');
    vi.stubEnv('TRAINING_PUBLIC_BETA_V1_ENABLED', 'false');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'active');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE', 'active');
    vi.stubEnv('TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED', 'true');
    vi.stubEnv('TRAINING_PLAN_M4_ALLOWLIST', FULL_TRAINING_M4_ALLOWLIST);
    vi.stubEnv('APNS_ENABLED', 'true');
    vi.stubEnv('APNS_TEAM_ID', 'TEAMID1234');
    vi.stubEnv('APNS_KEY_ID', 'KEYID12345');
    vi.stubEnv('APNS_AUTH_KEY_P8', '<redacted-test-apns-key>');
    vi.stubEnv('APNS_BUNDLE_ID', 'me.nexushub.app');
    vi.stubEnv('NOTIFICATION_DELIVERY_MODE', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { config } = await loadConfigFresh();

    expect(config.billing.allowUnsafePaywallBypass).toBe(true);
    expect(config.notificationDelivery.mode).toBe('mock');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('keeps encryption requirements production-grade in container staging', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('STAGING', 'true');
    vi.stubEnv('FINANCE_ENCRYPTION_ENABLED', 'true');
    vi.stubEnv('FINANCE_ENCRYPTION_KEY', '');
    vi.stubEnv('BACKUP_ENABLED', 'false');

    await expect(loadConfigFresh()).rejects.toThrow(
      'FINANCE_ENCRYPTION_ENABLED=true and FINANCE_ENCRYPTION_KEY are required in production.',
    );

    vi.stubEnv('FINANCE_ENCRYPTION_KEY', 'staging-finance-key-at-least-32-chars');
    vi.stubEnv('BACKUP_ENABLED', 'true');
    vi.stubEnv('BACKUP_ENCRYPT', 'false');
    vi.stubEnv('BACKUP_KEY', '');

    await expect(loadConfigFresh()).rejects.toThrow(
      'BACKUP_ENABLED=true requires BACKUP_ENCRYPT=true and BACKUP_KEY in production.',
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

  it('keeps Managed Payments preview mode disabled by default', async () => {
    vi.stubEnv('STRIPE_MANAGED_PAYMENTS_SANDBOX_ENABLED', '');

    const { config } = await loadConfigFresh();

    expect(config.stripe.managedPaymentsSandboxEnabled).toBe(false);
  });

  it('requires a Stripe test key when Managed Payments sandbox mode is enabled', async () => {
    vi.stubEnv('STRIPE_MANAGED_PAYMENTS_SANDBOX_ENABLED', 'true');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_accidental');

    await expect(loadConfigFresh()).rejects.toThrow(
      'STRIPE_MANAGED_PAYMENTS_SANDBOX_ENABLED=true requires STRIPE_SECRET_KEY to be a Stripe test key (sk_test_*).',
    );
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

  it.each([
    { nodeEnv: 'staging', staging: 'false' },
    { nodeEnv: 'production', staging: 'true' },
  ])('refuses live Stripe secret keys outside live production ($nodeEnv, STAGING=$staging)', async ({
    nodeEnv, staging,
  }) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('STAGING', staging);
    vi.stubEnv('FINANCE_ENCRYPTION_ENABLED', 'true');
    vi.stubEnv('FINANCE_ENCRYPTION_KEY', 'staging-finance-key-at-least-32-chars');
    vi.stubEnv('BACKUP_ENABLED', 'false');
    vi.stubEnv('STRIPE_NEXUS_POINTS_ENABLED', 'true');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_accidental');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_SMALL', 'price_small');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_MEDIUM', 'price_medium');
    vi.stubEnv('STRIPE_PRICE_ID_POINTS_LARGE', 'price_large');
    vi.stubEnv('PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET', 'signed-actors');

    await expect(loadConfigFresh()).rejects.toThrow(
      'STRIPE_SECRET_KEY appears to be a live key (sk_live_*) outside live production.',
    );
  });

  it('forbids global Training adaptation activation in production', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE', 'active');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Global TRAINING_ADAPTATION_V1_MODE=active is forbidden in production',
    );
  });

  it('accepts only the complete global Training public-beta bundle without changing global Decision enforcement', async () => {
    applySafeProductionEnv();
    applyCompleteTrainingPublicBetaEnv();

    await expect(loadConfigFresh()).resolves.toHaveProperty('config');
    expect(process.env.DECISION_FLOW_V1_ENFORCE_ENABLED).toBe('false');
  });

  it('fails closed on a partial, wildcard, or malformed Training public-beta bundle', async () => {
    applySafeProductionEnv();
    applyCompleteTrainingPublicBetaEnv();
    vi.stubEnv('TRAINING_EXERCISE_MEDIA_V1_ENABLED', 'false');
    await expect(loadConfigFresh()).rejects.toThrow(
      'TRAINING_PUBLIC_BETA_V1_ENABLED=true requires the complete global Training v1 bundle',
    );

    applyCompleteTrainingPublicBetaEnv();
    vi.stubEnv('TRAINING_PLAN_M4_ALLOWLIST', FULL_TRAINING_M4_ALLOWLIST.split(',').slice(0, -1).join(','));
    await expect(loadConfigFresh()).rejects.toThrow(
      'TRAINING_PUBLIC_BETA_V1_ENABLED=true requires the complete global Training v1 bundle',
    );

    applyCompleteTrainingPublicBetaEnv();
    vi.stubEnv('TRAINING_PLAN_M4_ALLOWLIST', '*');
    await expect(loadConfigFresh()).rejects.toThrow(
      'TRAINING_PUBLIC_BETA_V1_ENABLED=true requires the complete global Training v1 bundle',
    );

    vi.stubEnv('TRAINING_PUBLIC_BETA_V1_ENABLED', 'yes');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_PLAN_M4_ALLOWLIST', '');
    vi.stubEnv('TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED', 'false');
    await expect(loadConfigFresh()).rejects.toThrow(
      'TRAINING_PUBLIC_BETA_V1_ENABLED must be exactly true or false in production.',
    );
  });

  it('preserves the legacy global-rollout prohibition when the public-beta master is off', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PUBLIC_BETA_V1_ENABLED', 'false');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'active');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Global TRAINING_PLAN_REVISION_V1_MODE=active is forbidden in production; enroll explicit personal accounts with scoped USER or TENANT overrides.',
    );
  });

  it('forbids the global Training-only Decision gate without the complete public-beta master', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PUBLIC_BETA_V1_ENABLED', 'false');
    vi.stubEnv('TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED', 'true');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Global TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED=true is forbidden in production unless the complete Training public-beta bundle is enabled.',
    );
  });

  it('requires scoped revision, typed workout, and Decision dependencies for scoped adaptation activation', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE_USER_7', 'active');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE_USER_7', 'off');
    vi.stubEnv('TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7', 'false');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED', 'false');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Each scoped TRAINING_ADAPTATION_V1_MODE=active enrollment requires Training revision, typed-workout, and Decision Flow enablement for the same scope.',
    );
  });

  it('does not satisfy adaptation dependencies with another account scope', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE_USER_7', 'active');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE_USER_8', 'active');
    vi.stubEnv('TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_8', 'true');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED', 'true');
    vi.stubEnv('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY', 'training-revision-production-key-00000001');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Each scoped TRAINING_ADAPTATION_V1_MODE=active enrollment requires Training revision, typed-workout, and Decision Flow enablement for the same scope.',
    );
  });

  it('accepts exact user-scoped Decision Flow dependencies without global rollout blast', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE_USER_7', 'active');
    vi.stubEnv('TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE_USER_7', 'active');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED', 'false');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY', 'training-revision-production-key-00000001');

    await expect(loadConfigFresh()).resolves.toHaveProperty('config');
  });

  it('accepts the Training-specific Decision dependency for an exact scoped enrollment', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE_USER_7', 'active');
    vi.stubEnv('TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_ADAPTATION_V1_MODE_USER_7', 'active');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED', 'false');
    vi.stubEnv('TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY', 'training-revision-production-key-00000001');

    await expect(loadConfigFresh()).resolves.toHaveProperty('config');
  });

  it('does not satisfy a scoped revision dependency with another account Decision Flow enrollment', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE_USER_7', 'active');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED', 'false');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED_USER_8', 'true');
    vi.stubEnv('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY', 'training-revision-production-key-00000001');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Each scoped TRAINING_PLAN_REVISION_V1_MODE=active enrollment requires Decision Flow enablement for the same scope in production.',
    );
  });

  it('requires every scoped M4 allowlist to carry exact rollout dependencies', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE', 'off');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE_USER_7', 'active');
    vi.stubEnv('TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_PLAN_M4_ALLOWLIST_USER_8', 'event_based:marathon');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY', 'training-revision-production-key-00000001');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Each scoped TRAINING_PLAN_M4_ALLOWLIST requires Training revision, typed-workout, and Decision Flow enablement for the same scope.',
    );
  });

  it('forbids global provisional explicit-user M4 capacity in production', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED', 'true');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Global TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED=true is forbidden in production',
    );
  });

  it('requires every scoped provisional M4 capacity enrollment to carry the same-scope dependencies', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE_USER_8', 'active');
    vi.stubEnv('TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_8', 'true');
    vi.stubEnv('TRAINING_PLAN_M4_ALLOWLIST_USER_8', 'event_based:marathon');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED_USER_8', 'true');
    vi.stubEnv('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY', 'training-revision-production-key-00000001');

    await expect(loadConfigFresh()).rejects.toThrow(
      'Each scoped TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED enrollment requires an exact M4 allowlist, Training revision, typed-workout, and Decision Flow enablement for the same scope.',
    );
  });

  it('accepts provisional M4 capacity only with exact same-scope production dependencies', async () => {
    applySafeProductionEnv();
    vi.stubEnv('TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_PLAN_REVISION_V1_MODE_USER_7', 'active');
    vi.stubEnv('TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_PLAN_M4_ALLOWLIST_USER_7', 'event_based:marathon');
    vi.stubEnv('DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7', 'true');
    vi.stubEnv('TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY', 'training-revision-production-key-00000001');

    await expect(loadConfigFresh()).resolves.toHaveProperty('config');
  });
});

describe('hybrid flag live getters (QA P2-13)', () => {
  beforeEach(() => {
    applyMinimalConfigEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...ORIGINAL_ENV };
  });

  it('re-reads activation and kill switches on every access without a restart', async () => {
    const { config } = await loadConfigFresh();

    // Credits admission: enable, then kill mid-process.
    vi.stubEnv('HYBRID_AI_CREDITS_ENABLED', 'true');
    vi.stubEnv('HYBRID_AI_CREDITS_KILL_SWITCH', 'false');
    expect(config.hybridCredits.enabled).toBe(true);
    vi.stubEnv('HYBRID_AI_CREDITS_KILL_SWITCH', 'true');
    expect(config.hybridCredits.enabled).toBe(false);
    vi.stubEnv('HYBRID_AI_CREDITS_ENABLED', 'false');
    vi.stubEnv('HYBRID_AI_CREDITS_KILL_SWITCH', 'false');
    expect(config.hybridCredits.enabled).toBe(false);

    // Points cutover flips live too.
    expect(config.hybridCredits.pointsCutover).toBe(false);
    vi.stubEnv('HYBRID_CREDITS_POINTS_CUTOVER', 'true');
    expect(config.hybridCredits.pointsCutover).toBe(true);

    // Apple pack fulfillment: default OFF, enable, then kill.
    expect(config.hybridCommerce.applePackFulfillmentEnabled).toBe(false);
    vi.stubEnv('APPLE_PACK_FULFILLMENT_ENABLED', 'true');
    expect(config.hybridCommerce.applePackFulfillmentEnabled).toBe(true);
    vi.stubEnv('APPLE_PACK_FULFILLMENT_KILL_SWITCH', 'true');
    expect(config.hybridCommerce.applePackFulfillmentEnabled).toBe(false);

    // Stripe pack sales: same shape.
    expect(config.hybridCommerce.stripePackFulfillmentEnabled).toBe(false);
    vi.stubEnv('STRIPE_PACK_FULFILLMENT_ENABLED', 'true');
    expect(config.hybridCommerce.stripePackFulfillmentEnabled).toBe(true);
    vi.stubEnv('STRIPE_PACK_FULFILLMENT_KILL_SWITCH', 'true');
    expect(config.hybridCommerce.stripePackFulfillmentEnabled).toBe(false);
  });
});

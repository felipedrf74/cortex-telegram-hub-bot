// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';

export interface PortalCredential {
  label: string;
  value: string;
}

export interface PortalCredentialConfig {
  token: string;
  readToken: string;
  writeToken: string;
  adminToken: string;
}

export interface PortalAdminExposureConfig {
  adminToken: string;
  token: string;
  allowLegacyFallback: boolean;
  allowLocalBypass: boolean;
  sessionSecret: string;
  requireSessionAuth: boolean;
  adminActorAllowlist: readonly string[];
  adminRequireActor: boolean;
  adminActorSignatureSecret: string;
  betaHardened: boolean;
}

export type PortalAdminExposureMode =
  | 'disabled'
  | 'loopback_only'
  | 'session_only'
  | 'signed_static'
  | 'static_allowlisted'
  | 'static_with_actor'
  | 'static_open';

const WEAK_PORTAL_TOKENS = new Set([
  'changeme', 'change-me', 'changeme123', 'admin', 'administrator',
  'password', 'password1', 'passw0rd', 'nexushub', 'nexus-hub',
  'dev', 'develop', 'development', 'test', 'testing', 'local',
  '1234', '12345', '123456', '1234567', '12345678', '123456789',
]);

export function getConfiguredPortalCredentials(config: PortalCredentialConfig): PortalCredential[] {
  return [
    { label: 'PORTAL_TOKEN', value: config.token },
    { label: 'PORTAL_READ_TOKEN', value: config.readToken },
    { label: 'PORTAL_WRITE_TOKEN', value: config.writeToken },
    { label: 'PORTAL_ADMIN_TOKEN', value: config.adminToken },
  ].filter((entry) => entry.value);
}

export function isWeakPortalCredentialValue(value: string): boolean {
  return (
    value.length < 12 ||
    WEAK_PORTAL_TOKENS.has(value.toLowerCase()) ||
    /^(.)\1+$/.test(value)
  );
}

export function validatePortalCredentialStrength(credentials: readonly PortalCredential[]): void {
  for (const credential of credentials) {
    if (!isWeakPortalCredentialValue(credential.value)) continue;

    const msg = `${credential.label} is too weak (length=${credential.value.length}, must be >=12 chars and not a well-known default). Refusing to start the admin portal with a guessable token. Generate a random one: \`openssl rand -hex 32\``;
    logger.fatal(
      { tokenLength: credential.value.length, tokenLabel: credential.label },
      msg,
    );
    throw new Error(msg);
  }
}

// Beta admin exposure classification. Emits a single readable string that the
// operator portal, runbook, and audit telemetry can all agree on.
//
// Exposure modes, safest to least safe:
//   - disabled:          no admin token, no session secret, no loopback bypass.
//                        Admin mutations cannot pass the secret-guards layer at all.
//   - loopback_only:     admin access only via loopback bypass (dev/tests).
//   - session_only:      PORTAL_REQUIRE_SESSION_AUTH=true AND session secret set.
//                        Static admin tokens rejected even if configured.
//   - signed_static:     static admin token + signed actor headers (HMAC).
//   - static_allowlisted:static admin token + actor allowlist (no signature).
//   - static_with_actor: static admin token + PORTAL_ADMIN_REQUIRE_ACTOR=true.
//                        Captures actor identity in audit but not cryptographically.
//   - static_open:       static admin token only. Beta-unsafe if exposed broadly.
export function getPortalAdminExposureMode(
  portalConfig: PortalAdminExposureConfig,
): PortalAdminExposureMode {
  const hasAdminToken = Boolean(portalConfig.adminToken);
  const legacyAdminCapable = Boolean(portalConfig.token) && portalConfig.allowLegacyFallback;
  const anyStaticAdmin = hasAdminToken || legacyAdminCapable;
  const hasSessionSecret = Boolean(portalConfig.sessionSecret);

  if (!anyStaticAdmin && !hasSessionSecret) {
    return portalConfig.allowLocalBypass ? 'loopback_only' : 'disabled';
  }

  if (portalConfig.requireSessionAuth && hasSessionSecret) {
    return 'session_only';
  }

  if (anyStaticAdmin && portalConfig.adminActorSignatureSecret) {
    return 'signed_static';
  }

  if (anyStaticAdmin && portalConfig.adminActorAllowlist.length > 0) {
    return 'static_allowlisted';
  }

  if (anyStaticAdmin && portalConfig.adminRequireActor) {
    return 'static_with_actor';
  }

  return 'static_open';
}

export function isPortalAdminExposureBetaSafe(mode: PortalAdminExposureMode): boolean {
  return (
    mode === 'disabled'
    || mode === 'loopback_only'
    || mode === 'session_only'
    || mode === 'signed_static'
  );
}

// Beta readiness preflight for the admin surface.
//
// We refuse to boot in two situations:
//   1. PORTAL_REQUIRE_SESSION_AUTH=true but PORTAL_SESSION_SECRET is empty.
//      The policy asks for signed sessions but the secret is missing, which
//      silently rejects every admin request — worse than failing closed here.
//   2. PORTAL_BETA_HARDENED=true and the resolved exposure mode is not
//      beta-safe (disabled / loopback / session_only / signed_static).
//      This is the single-flag beta gate the runbook points at.
//
// In all other cases we log a warning so the operator portal and on-call
// runbook can see the current exposure mode. Non-beta-safe modes in
// production emit a fatal-level log but do not throw, preserving the
// existing permissive-by-default behavior for single-owner deployments
// that predate the beta hardening flag.
export function validatePortalAdminBetaReadiness(
  portalConfig: PortalAdminExposureConfig,
  options: { nodeEnv?: string } = {},
): PortalAdminExposureMode {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const mode = getPortalAdminExposureMode(portalConfig);

  if (portalConfig.requireSessionAuth && !portalConfig.sessionSecret) {
    const msg = 'PORTAL_REQUIRE_SESSION_AUTH=true but PORTAL_SESSION_SECRET is empty. Every admin request would be rejected. Refusing to start — set PORTAL_SESSION_SECRET or disable PORTAL_REQUIRE_SESSION_AUTH.';
    logger.fatal({ adminExposureMode: mode }, msg);
    throw new Error(msg);
  }

  if (portalConfig.betaHardened && !isPortalAdminExposureBetaSafe(mode)) {
    const msg = `PORTAL_BETA_HARDENED=true but admin exposure mode is '${mode}'. Beta-safe modes are: disabled, loopback_only, session_only, signed_static. Enable PORTAL_REQUIRE_SESSION_AUTH with PORTAL_SESSION_SECRET, or add PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET, before exposing the admin surface.`;
    logger.fatal({ adminExposureMode: mode }, msg);
    throw new Error(msg);
  }

  if (!isPortalAdminExposureBetaSafe(mode) && nodeEnv === 'production') {
    logger.warn(
      {
        adminExposureMode: mode,
        dedicatedAdminConfigured: Boolean(portalConfig.adminToken),
        sessionAuthRequired: portalConfig.requireSessionAuth,
        actorSignatureConfigured: Boolean(portalConfig.adminActorSignatureSecret),
        actorAllowlistCount: portalConfig.adminActorAllowlist.length,
      },
      'Portal admin surface is exposed without signed sessions or actor signatures. Beta rollouts should set PORTAL_BETA_HARDENED=true after configuring PORTAL_SESSION_SECRET + PORTAL_REQUIRE_SESSION_AUTH.',
    );
  } else {
    logger.info({ adminExposureMode: mode }, 'Portal admin exposure mode');
  }

  return mode;
}

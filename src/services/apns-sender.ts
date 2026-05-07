// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Apple Push Notification Service sender — zero external deps.
//
// Talks to APNs (api.push.apple.com or sandbox equivalent) directly via
// Node's built-in http2 module + the already-installed jsonwebtoken for
// ES256 provider JWT signing. No @parse/node-apn, no apn, no firebase —
// the backend's minimal-dependency philosophy is preserved.
//
// ## How APNs auth works (for future-you debugging this at 2am)
//
// Apple accepts two auth modes: .p12 certificates (legacy) and .p8
// token-based (modern). We use token-based because:
//   - One key covers all environments and all apps by bundle id
//   - Keys don't expire; the provider JWT is cached for ~55 minutes
//   - No TLS client cert plumbing in http2 — just an Authorization header
//
// The provider JWT is:
//   Header:  { alg: 'ES256', kid: <key id from Apple Developer portal> }
//   Payload: { iss: <team id>, iat: <unix seconds> }
//   Signed:  ECDSA P-256 + SHA-256 via the .p8 private key
//
// Apple expects each JWT to live AT LEAST 20 minutes and AT MOST 60 minutes.
// Re-signing on every request is rate-limited by Apple (you get 429s), so
// we cache one JWT per 55 minutes and re-sign on demand.
//
// ## How the device token gets here
//
// iOS calls registerForRemoteNotifications() → Apple returns a device token
// via didRegisterForRemoteNotificationsWithDeviceToken → iOS converts it to
// hex (no dashes, no brackets, no whitespace) → iOS POSTs to
// /api/v1/settings/push-token → stored in ios_devices.push_token. This file
// reads tokens from that table and dispatches.
//
// ## What happens when APNs isn't configured
//
// The four env vars (APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID,
// APNS_AUTH_KEY_P8) might not all be set in every environment — staging
// won't have them, local dev won't, and production won't have them until
// the user follows the handoff doc. In all those cases:
//
//   - sendPushNotification() logs ONE warn per process lifetime ("APNs not
//     configured — first call skipped; subsequent calls will no-op silently")
//     and then returns { sent: 0, failed: 0, skipped: N } forever.
//   - The cron jobs that call it will continue working (Telegram still
//     fires), they just won't send iOS pushes.
//
// This is a conscious choice: the crons are high-frequency and we don't
// want a missing env var to crash nexus-hub or spam the logs.

import http2 from 'node:http2';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getDb } from './database';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface PushNotificationPayload {
  /** Short headline shown on lock screen / banner. Keep under 50 chars. */
  title: string;
  /** Body text. Keep under 150 chars — APNs will truncate. */
  body: string;
  /** Optional subtitle (smaller, below title). */
  subtitle?: string;
  /** Badge count to display on the app icon. Pass 0 to clear. */
  badge?: number;
  /** Sound file name. 'default' plays the system sound. Omit for silent. */
  sound?: string;
  /** Arbitrary JSON payload delivered to didReceiveRemoteNotification. */
  data?: Record<string, unknown>;
  /** Thread identifier so iOS groups related notifications. */
  threadId?: string;
  /** Notification category — maps to iOS UNNotificationCategory actions. */
  category?: string;
  /** APNs interruption level. Keep critical out until entitlement/product policy is explicit. */
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
}

export interface SendResult {
  /** Push tokens that APNs accepted (2xx). */
  sent: number;
  /** Push tokens APNs rejected permanently (4xx other than 429). */
  failed: number;
  /** Tokens skipped because APNs isn't configured. */
  skipped: number;
  /** Tokens that got a transient error (429, 500, network) and will be retried by Apple. */
  retriable: number;
  /** Push tokens that APNs reported as unregistered (410) — caller should delete. */
  unregistered: string[];
}

// ────────────────────────────────────────────────────────────────────
// JWT provider token cache
// ────────────────────────────────────────────────────────────────────

interface CachedJwt {
  token: string;
  /** Unix milliseconds when this token should be re-signed. */
  refreshAt: number;
}

let cachedJwt: CachedJwt | null = null;
/** Apple allows at most one JWT per 20 minutes. We refresh at 55 to be safe. */
const JWT_TTL_MS = 55 * 60 * 1000;

/**
 * Build or return a cached ES256-signed JWT for APNs provider authentication.
 *
 * Apple's docs: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
 */
function getProviderJwt(): string {
  const now = Date.now();
  if (cachedJwt && cachedJwt.refreshAt > now) {
    return cachedJwt.token;
  }

  const { teamId, keyId, authKey } = config.apns;
  if (!teamId || !keyId || !authKey) {
    throw new Error(
      `[apns-sender] getProviderJwt called with missing config: ` +
        `teamId=${!!teamId}, keyId=${!!keyId}, authKey=${!!authKey}. ` +
        `isApnsConfigured() should have been checked first.`,
    );
  }

  // authKey can be either the raw .p8 contents or a path on disk. Paths are
  // more convenient for prod (mount a secrets volume) while inline strings
  // work for docker-compose/.env deployments.
  let pem: string;
  if (authKey.startsWith('-----BEGIN')) {
    pem = authKey;
  } else if (fs.existsSync(authKey)) {
    pem = fs.readFileSync(authKey, 'utf8');
  } else {
    // Last try — maybe the env var is a single-line .p8 with escaped newlines
    pem = authKey.replace(/\\n/g, '\n');
    if (!pem.includes('-----BEGIN')) {
      throw new Error(
        `[apns-sender] APNS_AUTH_KEY_P8 is neither a valid file path nor a ` +
          `raw .p8 string. Got ${authKey.length} chars starting with ` +
          `"${authKey.slice(0, 20)}". Expected either a path to an ` +
          `AuthKey_XXXXXXXXXX.p8 file or the full contents of that file.`,
      );
    }
  }

  const token = jwt.sign({ iss: teamId, iat: Math.floor(now / 1000) }, pem, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: keyId },
  });

  cachedJwt = { token, refreshAt: now + JWT_TTL_MS };
  return token;
}

// ────────────────────────────────────────────────────────────────────
// Config check (single warn per process, then silent no-op)
// ────────────────────────────────────────────────────────────────────

let warnedMissingConfig = false;

/**
 * Returns true only when ALL required APNs env vars are present AND
 * APNS_ENABLED=true. Used as a gate at the top of sendPushNotification.
 *
 * Splitting teamId/keyId/authKey checks out so the warn log can tell the
 * user exactly which one is missing — debugging a silent no-op without
 * this diagnostic is miserable.
 */
export function isApnsConfigured(): boolean {
  const { enabled, teamId, keyId, authKey, bundleId } = config.apns;
  return enabled && !!teamId && !!keyId && !!authKey && !!bundleId;
}

/**
 * Explain which APNs env vars are missing, for a one-time startup warning.
 * Never includes the actual key contents.
 */
function describeMissingConfig(): string {
  const { enabled, teamId, keyId, authKey, bundleId } = config.apns;
  const missing: string[] = [];
  if (!enabled) missing.push('APNS_ENABLED=true (currently false or unset)');
  if (!teamId) missing.push('APNS_TEAM_ID');
  if (!keyId) missing.push('APNS_KEY_ID');
  if (!authKey) missing.push('APNS_AUTH_KEY_P8 (path or inline .p8 contents)');
  if (!bundleId) missing.push('APNS_BUNDLE_ID');
  return missing.join(', ');
}

// ────────────────────────────────────────────────────────────────────
// Push token lookup (from ios_devices table)
// ────────────────────────────────────────────────────────────────────

/**
 * Returns all non-null, non-empty push tokens for a user's registered
 * iOS devices. A user may have multiple devices (iPhone + iPad), so this
 * is plural by design. Each token is sent a push independently.
 */
export function getPushTokensForUser(userId: number): string[] {
  if (!isValidTenantUserId(userId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'get_push_tokens_for_user',
      reason: userId == null ? 'missing_user_scope' : 'invalid_user_scope',
      userId: userId ?? null,
    });
    return [];
  }

  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT DISTINCT push_token FROM ios_devices
         WHERE user_id = ? AND push_token IS NOT NULL AND push_token != ''`,
      )
      .all(userId) as Array<{ push_token: string }>;
    return rows.map((r) => r.push_token);
  } catch (err) {
    logger.error({ err, userId }, '[apns-sender] Failed to load push tokens for user');
    return [];
  }
}

/**
 * Mark a push token as unregistered so the next cron doesn't keep pinging
 * a dead device. Called when APNs returns 410 Gone.
 */
export function deleteDeadPushToken(token: string): void {
  try {
    const db = getDb();
    db.prepare(`UPDATE ios_devices SET push_token = NULL WHERE push_token = ?`).run(token);
    logger.info({ tokenSuffix: token.slice(-8) }, '[apns-sender] Cleared dead push token');
  } catch (err) {
    logger.error({ err }, '[apns-sender] Failed to clear dead push token');
  }
}

// ────────────────────────────────────────────────────────────────────
// HTTP/2 client (one persistent session, lazily opened)
// ────────────────────────────────────────────────────────────────────

let http2Clients: Partial<Record<'sandbox' | 'production', http2.ClientHttp2Session>> = {};

function hostForEnvironment(environment: 'sandbox' | 'production'): string {
  return environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com:443'
    : 'https://api.push.apple.com:443';
}

function getAlternateEnvironment(environment: 'sandbox' | 'production'): 'sandbox' | 'production' {
  return environment === 'sandbox' ? 'production' : 'sandbox';
}

function getHttp2Client(
  environment: 'sandbox' | 'production' = config.apns.environment,
): http2.ClientHttp2Session {
  const existing = http2Clients[environment];
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }

  const client = http2.connect(hostForEnvironment(environment));
  client.on('error', (err) => {
    logger.warn({ err, environment }, '[apns-sender] HTTP/2 session error, will reconnect on next send');
    delete http2Clients[environment];
  });
  client.on('close', () => {
    delete http2Clients[environment];
  });

  http2Clients[environment] = client;
  return client;
}

/**
 * Close the persistent HTTP/2 client. Useful for tests and graceful shutdown.
 */
export function closeApnsClient(): void {
  for (const environment of Object.keys(http2Clients) as Array<'sandbox' | 'production'>) {
    const client = http2Clients[environment];
    if (!client) continue;
    try {
      client.close();
    } catch {
      // best-effort
    }
  }
  http2Clients = {};
}

/**
 * Reset all module-level singletons. TEST-ONLY — production code should
 * never call this. Without it, test cases interact through the cachedJwt
 * (one test populates the cache, the next observes stale state) and
 * warnedMissingConfig (first test that triggers the warn suppresses it
 * for every subsequent test). Exported so the vitest suite can call it
 * from beforeEach without needing vi.resetModules + dynamic imports.
 */
export function _resetForTests(): void {
  cachedJwt = null;
  warnedMissingConfig = false;
  closeApnsClient();
}

// ────────────────────────────────────────────────────────────────────
// Send one notification to one device token
// ────────────────────────────────────────────────────────────────────

interface SingleSendOutcome {
  status: number;
  reason?: string;
  environment: 'sandbox' | 'production';
}

/**
 * Dispatches a single request to APNs for a single device token. Separated
 * from the higher-level fan-out so tests can mock this function in isolation.
 */
async function dispatchOne(
  deviceToken: string,
  payload: PushNotificationPayload,
  environment: 'sandbox' | 'production' = config.apns.environment,
): Promise<SingleSendOutcome> {
  const client = getHttp2Client(environment);
  const jwtToken = getProviderJwt();

  const apsPayload: Record<string, unknown> = {
    alert: payload.subtitle
      ? { title: payload.title, subtitle: payload.subtitle, body: payload.body }
      : { title: payload.title, body: payload.body },
  };
  if (payload.badge !== undefined) apsPayload.badge = payload.badge;
  if (payload.sound !== undefined) apsPayload.sound = payload.sound;
  if (payload.threadId) apsPayload['thread-id'] = payload.threadId;
  if (payload.category) apsPayload.category = payload.category;
  if (payload.interruptionLevel) apsPayload['interruption-level'] = payload.interruptionLevel;

  const body: Record<string, unknown> = { aps: apsPayload };
  if (payload.data) Object.assign(body, payload.data);

  const bodyStr = JSON.stringify(body);

  return new Promise<SingleSendOutcome>((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwtToken}`,
      'apns-topic': config.apns.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bodyStr).toString(),
    });

    let responseBody = '';
    let statusCode = 0;

    req.on('response', (headers) => {
      statusCode = Number(headers[':status'] || 0);
    });
    req.on('data', (chunk: Buffer) => {
      responseBody += chunk.toString();
    });
    req.on('end', () => {
      if (statusCode === 200) {
        resolve({ status: 200, environment });
      } else {
        let reason = '';
        try {
          reason = JSON.parse(responseBody).reason || '';
        } catch {
          reason = responseBody.slice(0, 200);
        }
        resolve({ status: statusCode, reason, environment });
      }
      req.close();
    });
    req.on('error', (err) => {
      logger.warn(
        { err, tokenSuffix: deviceToken.slice(-8), environment },
        '[apns-sender] Request error',
      );
      resolve({ status: 0, reason: err.message, environment });
    });

    req.setEncoding('utf8');
    req.end(bodyStr);
  });
}

function shouldRetryInAlternateEnvironment(outcome: SingleSendOutcome): boolean {
  return (
    outcome.status === 400 &&
    (outcome.reason === 'BadDeviceToken' || outcome.reason === 'DeviceTokenNotForTopic')
  );
}

// ────────────────────────────────────────────────────────────────────
// Public API — send a push to a user (fan out to all their devices)
// ────────────────────────────────────────────────────────────────────

/**
 * Send a push notification to every registered iOS device for a user.
 *
 * No-ops (with a one-time warn log) when APNs isn't configured. Returns
 * a detailed breakdown so callers can log success rates without having
 * to parse anything.
 */
export async function sendPushNotification(
  userId: number,
  payload: PushNotificationPayload,
): Promise<SendResult> {
  if (!isValidTenantUserId(userId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'send_push_notification',
      reason: userId == null ? 'missing_user_scope' : 'invalid_user_scope',
      userId: userId ?? null,
      details: {
        category: payload.category ?? null,
        threadId: payload.threadId ?? null,
      },
    });
    return { sent: 0, failed: 0, skipped: 0, retriable: 0, unregistered: [] };
  }

  if (!isApnsConfigured()) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      logger.warn(
        { missing: describeMissingConfig() },
        '[apns-sender] APNs not configured — push notifications will silently no-op. ' +
          'See specs/09-APNS-SETUP.md or the deploy handoff doc for setup steps.',
      );
    }
    const tokens = getPushTokensForUser(userId);
    return { sent: 0, failed: 0, skipped: tokens.length, retriable: 0, unregistered: [] };
  }

  const tokens = getPushTokensForUser(userId);
  if (tokens.length === 0) {
    return { sent: 0, failed: 0, skipped: 0, retriable: 0, unregistered: [] };
  }

  const result: SendResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    retriable: 0,
    unregistered: [],
  };

  // Dispatch in parallel — APNs handles concurrent HTTP/2 streams natively
  // over a single connection, so there's no benefit to serializing. A user
  // usually has 1-3 devices, so the fan-out is small.
  const outcomes = await Promise.all(tokens.map(async (token) => {
    const primary = await dispatchOne(token, payload, config.apns.environment);
    if (!shouldRetryInAlternateEnvironment(primary)) {
      return { token, outcome: primary };
    }

    const alternateEnvironment = getAlternateEnvironment(primary.environment);
    logger.warn(
      {
        configuredEnvironment: primary.environment,
        alternateEnvironment,
        reason: primary.reason,
        tokenSuffix: token.slice(-8),
      },
      '[apns-sender] Retrying APNs send against alternate environment after token mismatch',
    );
    const retried = await dispatchOne(token, payload, alternateEnvironment);
    return { token, outcome: retried };
  }));

  for (const { token, outcome } of outcomes) {
    if (outcome.status === 200) {
      result.sent += 1;
    } else if (outcome.status === 410) {
      // 410 Gone = device unregistered (app uninstalled or token rotated).
      // Clear it so we don't keep pinging.
      result.unregistered.push(token);
      deleteDeadPushToken(token);
    } else if (outcome.status === 429 || outcome.status >= 500 || outcome.status === 0) {
      // Transient — Apple will try again on its own for well-formed messages.
      result.retriable += 1;
      logger.warn(
        { status: outcome.status, reason: outcome.reason, tokenSuffix: token.slice(-8) },
        '[apns-sender] Transient APNs error',
      );
    } else {
      // 400, 403, 404, 413, 415… caller bug (bad payload, bad cert, bad topic).
      // These won't resolve without code changes, so log loudly.
      result.failed += 1;
      logger.error(
        { status: outcome.status, reason: outcome.reason, userId, tokenSuffix: token.slice(-8) },
        '[apns-sender] Permanent APNs error',
      );
    }
  }

  return result;
}

/**
 * Convenience: send the same payload to many users in parallel.
 * Used by cron jobs that iterate over getActiveUserIds().
 */
export async function sendPushToUsers(
  userIds: number[],
  payload: PushNotificationPayload,
): Promise<SendResult> {
  const results = await Promise.all(userIds.map((uid) => sendPushNotification(uid, payload)));
  return results.reduce<SendResult>(
    (acc, r) => ({
      sent: acc.sent + r.sent,
      failed: acc.failed + r.failed,
      skipped: acc.skipped + r.skipped,
      retriable: acc.retriable + r.retriable,
      unregistered: [...acc.unregistered, ...r.unregistered],
    }),
    { sent: 0, failed: 0, skipped: 0, retriable: 0, unregistered: [] },
  );
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Sign in with Apple token revocation — App Store Review Guideline 5.1.1(v).
 *
 * Apple requires an app that offers Sign in with Apple to revoke the user's
 * Apple token when the account is deleted. Revocation needs a REFRESH token,
 * which only exists if the `authorizationCode` returned alongside the identity
 * token is exchanged at `https://appleid.apple.com/auth/token`. This module
 * owns both halves:
 *
 *   1. `storeAppleRefreshTokenForUser` — exchange the authorization code and
 *      persist the resulting refresh token, encrypted at rest.
 *   2. `revokeAppleSignInTokenForUser` — POST that refresh token to
 *      `https://appleid.apple.com/auth/revoke` before local erasure.
 *
 * Both calls authenticate with an ES256 client-secret JWT built from the Apple
 * team id, key id, and a "Sign in with Apple" .p8 private key (a different key
 * from the APNs one), so `config.appleSignIn` is deliberately separate from
 * `config.apns`.
 *
 * EVERYTHING here degrades cleanly when unconfigured. If the env vars are
 * unset, if the client never sent an authorization code, or if Apple is
 * unreachable, the caller gets a `local_only` / `failed` outcome — never an
 * exception that could block GDPR Article 17 erasure.
 */

import fs from 'fs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { encryptValue, decryptValue } from '../utils/encryption';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_CLIENT_SECRET_AUDIENCE = 'https://appleid.apple.com';
/** Apple caps client-secret JWTs at 6 months; short-lived is safer and free. */
const CLIENT_SECRET_TTL_SECONDS = 15 * 60;
/**
 * A hung appleid.apple.com must never turn account deletion into an HTTP 500,
 * and must never stall an interactive sign-in either.
 */
export const APPLE_ID_REQUEST_TIMEOUT_MS = 5000;

const APPLE_REFRESH_TOKEN_TABLE = 'apple_sign_in_refresh_tokens';

export type AppleRefreshTokenPersistResult =
  | 'stored'
  | 'no_authorization_code'
  | 'not_configured'
  | 'failed';

export interface AppleTokenRevocationOutcome {
  attempted: boolean;
  status: 'revoked' | 'already_revoked' | 'failed' | 'local_only';
  statusCode?: number;
}

interface AppleSignInSettings {
  teamId: string;
  keyId: string;
  privateKey: string;
  clientId: string;
}

// The Apple refresh token is exactly as valuable as a Google/Outlook refresh
// token, and the SQLite file ships inside the weekly backup tarball, so it
// gets the same per-user AES-256-GCM treatment and the same key resolution
// order as `user_oauth_tokens`. See src/services/oauth-store.ts.
function getEncryptionKey(): string {
  return process.env.OAUTH_ENCRYPTION_KEY
    || config.financeEncryption?.masterKey
    || process.env.FINANCE_ENCRYPTION_KEY
    || '';
}

function appleSignInSettings(): AppleSignInSettings {
  // Optional chaining rather than destructuring: unit suites mock `../config`
  // with a partial object, and an unconfigured runtime must behave the same
  // way a partially-mocked one does.
  const settings = config.appleSignIn;
  return {
    teamId: settings?.teamId || '',
    keyId: settings?.keyId || '',
    privateKey: settings?.privateKey || '',
    clientId: settings?.clientId || '',
  };
}

/**
 * True only when team id, key id, and private key are all present. Callers
 * treat false as "record local_only and move on", never as an error.
 */
export function appleSignInRevocationConfigured(): boolean {
  const { teamId, keyId, privateKey } = appleSignInSettings();
  return Boolean(teamId && keyId && privateKey);
}

/**
 * Resolve APPLE_SIGN_IN_PRIVATE_KEY_P8 into PEM. Accepts the same three
 * shapes as APNS_AUTH_KEY_P8 (raw contents, path on disk, escaped newlines)
 * so operators can use one convention for both Apple keys.
 */
function resolveApplePrivateKeyPem(rawKey: string): string {
  if (rawKey.startsWith('-----BEGIN')) return rawKey;
  if (!rawKey.includes('\n') && fs.existsSync(rawKey)) return fs.readFileSync(rawKey, 'utf8');
  const pem = rawKey.replace(/\\n/g, '\n');
  if (!pem.includes('-----BEGIN')) {
    throw new Error(
      'APPLE_SIGN_IN_PRIVATE_KEY_P8 is neither a valid file path nor a raw .p8 string. '
      + 'Expected either a path to an AuthKey_XXXXXXXXXX.p8 file or the full contents of that file.',
    );
  }
  return pem;
}

/**
 * Build the ES256 client-secret JWT Apple requires on both /auth/token and
 * /auth/revoke. Throws when unconfigured — every caller checks
 * `appleSignInRevocationConfigured()` first.
 */
export function buildAppleClientSecret(clientId: string): string {
  const { teamId, keyId, privateKey } = appleSignInSettings();
  if (!teamId || !keyId || !privateKey) {
    throw new Error('Apple sign-in revocation credentials are not configured');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: teamId,
      iat: issuedAt,
      exp: issuedAt + CLIENT_SECRET_TTL_SECONDS,
      aud: APPLE_CLIENT_SECRET_AUDIENCE,
      sub: clientId,
    },
    resolveApplePrivateKeyPem(privateKey),
    { algorithm: 'ES256', header: { alg: 'ES256', kid: keyId } },
  );
}

async function postAppleForm(
  url: string,
  body: URLSearchParams,
): Promise<{ statusCode: number; ok: boolean; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(APPLE_ID_REQUEST_TIMEOUT_MS),
  });
  let text = '';
  try { text = await response.text(); } catch { /* empty body is normal on revoke */ }
  return { statusCode: response.status, ok: response.ok, text };
}

/**
 * Pull Apple's OAuth `error` code out of a NON-2xx body.
 *
 * Only ever called on a failed response, so the body cannot carry a token.
 * Apple answers with `{"error":"invalid_client"}`-shaped JSON; anything else
 * (empty body, an edge error page) resolves to null and the caller keeps its
 * status-code-only behaviour.
 */
function appleErrorCode(text: string): string | null {
  if (!text) return null;
  try {
    const code = (JSON.parse(text) as { error?: unknown }).error;
    return typeof code === 'string' && code ? code : null;
  } catch {
    return null;
  }
}

/** Bound what reaches the log line; Apple error bodies are tiny in practice. */
function truncateAppleErrorBody(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function appleRefreshTokenTableExists(db: any): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(APPLE_REFRESH_TOKEN_TABLE);
}

/**
 * True when the user signed in with Apple at least once, whether or not a
 * revocable refresh token was ever captured. Account deletion uses this to
 * record an explicit `apple` outcome instead of silently omitting the
 * provider — an omitted provider is indistinguishable from a skipped one.
 */
export function appleSignInIdentityExistsForUser(userId: number): boolean {
  const db = getDb();
  if (appleRefreshTokenTableExists(db)) {
    const tokenRow = db.prepare(
      `SELECT 1 FROM ${APPLE_REFRESH_TOKEN_TABLE} WHERE user_id = ?`,
    ).get(userId);
    if (tokenRow) return true;
  }
  try {
    const userRow = db.prepare(
      'SELECT 1 FROM users WHERE (id = ? OR telegram_id = ?) AND apple_user_id IS NOT NULL',
    ).get(userId, userId);
    return !!userRow;
  } catch {
    // Older local test databases may predate the apple_user_id column.
    return false;
  }
}

/**
 * Exchange the Sign in with Apple authorization code for a refresh token and
 * persist it encrypted.
 *
 * `authorizationCode` is OPTIONAL by contract: clients shipped before this
 * feature never send one and must keep working, so a missing code is a normal
 * outcome, not a failure. This never throws.
 */
export async function storeAppleRefreshTokenForUser(input: {
  userId: number;
  appleUserId: string;
  authorizationCode?: unknown;
  clientId?: string;
}): Promise<AppleRefreshTokenPersistResult> {
  const authorizationCode = typeof input.authorizationCode === 'string'
    ? input.authorizationCode.trim()
    : '';
  if (!authorizationCode) {
    // The single most important signal that revocation is non-functional:
    // if EVERY Apple sign-in lands here, no refresh token is ever captured
    // and `revokeAppleSignInTokenForUser` can only ever answer `local_only`.
    logger.info(
      { userId: input.userId, event: 'apple_revocation.capture', outcome: 'no_authorization_code' },
      'Apple sign-in sent no authorization code — no revocable refresh token will exist',
    );
    return 'no_authorization_code';
  }

  const settings = appleSignInSettings();
  const clientId = input.clientId || settings.clientId;
  if (!appleSignInRevocationConfigured() || !clientId) {
    logger.debug(
      { userId: input.userId },
      'Apple authorization code received but Apple revocation credentials are not configured',
    );
    return 'not_configured';
  }

  try {
    const result = await postAppleForm(APPLE_TOKEN_URL, new URLSearchParams({
      client_id: clientId,
      client_secret: buildAppleClientSecret(clientId),
      code: authorizationCode,
      grant_type: 'authorization_code',
    }));
    if (!result.ok) {
      // `appleError` is the first place a wrong team id, wrong key id, or a
      // stale .p8 becomes visible: Apple answers `invalid_client`.
      logger.warn(
        {
          userId: input.userId,
          statusCode: result.statusCode,
          appleError: appleErrorCode(result.text),
          appleBody: truncateAppleErrorBody(result.text),
          event: 'apple_revocation.capture',
        },
        'Apple authorization code exchange rejected',
      );
      return 'failed';
    }

    const refreshToken = String((JSON.parse(result.text || '{}') as { refresh_token?: unknown }).refresh_token || '');
    if (!refreshToken) {
      logger.warn({ userId: input.userId }, 'Apple token exchange returned no refresh token');
      return 'failed';
    }

    const key = getEncryptionKey();
    if (!key) {
      logger.warn({ userId: input.userId }, 'Apple refresh token dropped — no encryption key configured');
      return 'failed';
    }

    const db = getDb();
    if (!appleRefreshTokenTableExists(db)) {
      logger.warn({ userId: input.userId }, 'Apple refresh token dropped — migration 263 has not run');
      return 'failed';
    }
    db.prepare(`
      INSERT INTO ${APPLE_REFRESH_TOKEN_TABLE} (user_id, apple_user_id, client_id, encrypted_refresh_token, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        apple_user_id = excluded.apple_user_id,
        client_id = excluded.client_id,
        encrypted_refresh_token = excluded.encrypted_refresh_token,
        updated_at = datetime('now')
    `).run(
      input.userId,
      input.appleUserId,
      clientId,
      encryptValue(refreshToken, key, input.userId),
    );
    logger.info({ userId: input.userId }, 'Apple refresh token stored for account-deletion revocation');
    return 'stored';
  } catch (err) {
    // Sign-in must never fail because Apple's token endpoint misbehaved.
    logger.warn({ err, userId: input.userId }, 'Apple authorization code exchange failed');
    return 'failed';
  }
}

/**
 * Revoke the user's Apple token at Apple. Called BEFORE local erasure.
 *
 * `local_only` means "nothing revocable existed" — no stored refresh token
 * (older client), no configured credentials, or no usable encryption key.
 * Network/HTTP failures throw so the shared revocation error boundary in
 * `user-data-export.ts` records `failed` the same way it does for Google and
 * Outlook.
 */
export async function revokeAppleSignInTokenForUser(userId: number): Promise<AppleTokenRevocationOutcome> {
  const db = getDb();
  if (!appleRefreshTokenTableExists(db)) {
    logger.warn(
      { userId, event: 'apple_revocation.revoke', outcome: 'local_only', reason: 'table_missing' },
      'Apple revocation skipped — migration 263 has not run',
    );
    return { attempted: false, status: 'local_only' };
  }

  const row = db.prepare(
    `SELECT apple_user_id, client_id, encrypted_refresh_token FROM ${APPLE_REFRESH_TOKEN_TABLE} WHERE user_id = ?`,
  ).get(userId) as { apple_user_id: string; client_id: string; encrypted_refresh_token: string } | undefined;
  if (!row) {
    // Expected for any account created by a client that never sent an
    // authorization code. Logged anyway: "no row" and "revoked fine" must not
    // look the same in the logs, because the live call cannot be tested.
    logger.info(
      { userId, event: 'apple_revocation.revoke', outcome: 'local_only', reason: 'no_stored_refresh_token' },
      'Apple revocation skipped — no stored refresh token for this user',
    );
    return { attempted: false, status: 'local_only' };
  }

  if (!appleSignInRevocationConfigured()) {
    logger.warn(
      { userId },
      'Apple refresh token present but revocation credentials are unset — recording local_only',
    );
    return { attempted: false, status: 'local_only' };
  }

  const key = getEncryptionKey();
  if (!key) {
    logger.warn({ userId }, 'Apple refresh token present but no encryption key — recording local_only');
    return { attempted: false, status: 'local_only' };
  }

  let refreshToken: string;
  try {
    refreshToken = decryptValue(row.encrypted_refresh_token, key, userId);
  } catch {
    logger.warn({ userId }, 'Apple refresh token could not be decrypted — recording local_only');
    return { attempted: false, status: 'local_only' };
  }

  const clientId = row.client_id || appleSignInSettings().clientId;
  const result = await postAppleForm(APPLE_REVOKE_URL, new URLSearchParams({
    client_id: clientId,
    client_secret: buildAppleClientSecret(clientId),
    token: refreshToken,
    token_type_hint: 'refresh_token',
  }));

  if (result.ok) {
    // Apple answers 200 with an empty body. Without this line a working
    // revocation and a completely non-functional one look identical in the
    // logs, and the live call cannot be exercised from a test.
    logger.info(
      { userId, statusCode: result.statusCode, event: 'apple_revocation.revoke', outcome: 'revoked' },
      'Apple token revoked at appleid.apple.com before account deletion',
    );
    return { attempted: true, status: 'revoked', statusCode: result.statusCode };
  }

  // A 4xx is ambiguous by status code alone: Apple returns 400 both for a
  // token it no longer accepts AND for `invalid_client` (wrong team id, wrong
  // key id, expired or malformed .p8). Mapping every 4xx to already_revoked
  // would report the most likely first-deploy misconfiguration as success, so
  // the documented error codes decide.
  const appleError = appleErrorCode(result.text);
  const tokenRejected = appleError === 'invalid_grant' || appleError === 'invalid_token';
  const misconfigured = appleError === 'invalid_client' || appleError === 'invalid_request';
  const alreadyRevoked = result.statusCode >= 400 && result.statusCode < 500
    && !misconfigured
    // An unparsed 4xx body keeps the historical already-revoked reading; the
    // warn line below still carries the raw response for the operator.
    && (tokenRejected || appleError === null);

  logger.warn(
    {
      userId,
      statusCode: result.statusCode,
      appleError,
      appleBody: truncateAppleErrorBody(result.text),
      event: 'apple_revocation.revoke',
      outcome: alreadyRevoked ? 'already_revoked' : 'failed',
    },
    'Apple token revocation returned a non-2xx response',
  );

  return {
    attempted: true,
    status: alreadyRevoked ? 'already_revoked' : 'failed',
    statusCode: result.statusCode,
  };
}

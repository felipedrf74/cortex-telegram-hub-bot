// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { config } from '../../config';
import { getDb } from '../../services/database';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { authMiddleware as verifyJwt } from '../auth-middleware';
import type { AuthenticatedRequest } from '../auth-middleware';
import { logAudit } from '../../services/audit-trail';
import {
  getUserByAppleId, getUserByEmail, getUserById,
  createAppleUser, createEmailUser,
  resolveIosInviteRegistrationTarget,
} from '../../services/user-service';
import { createAuthSessionAndRegisterDevice, grantBetaSandboxAccess } from '../../services/ios-auth-session';
import { createGoogleAuthPendingSession, consumeGoogleAuthCompletion } from '../../services/google-auth-session-store';
import { consumeAppleSignInNonce, AppleSignInNonceError } from '../../services/apple-sign-in-nonce';
import {
  resolveGoogleIdentityUser,
  verifyGoogleIdentityToken,
  GoogleAccountLinkRequiresVerificationError,
  GoogleEmailNotVerifiedError,
} from '../../services/google-sign-in';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import type { Lang } from '../../utils/i18n';

// Apple JWKS cache
let appleJwksCache: { keys: any[]; fetchedAt: number } | null = null;
const APPLE_JWKS_TTL = 24 * 60 * 60 * 1000; // 24h
// Closed-beta-auth-hardening (2026-05-04): when Apple rotates a key,
// the new `kid` won't be in our 24h-cached JWKS for up to 24h. The
// previous code 401'd every Apple sign-in attempt during that window.
// We now allow a one-shot force-refresh (`forceRefresh=true`) when a
// `kid` lookup misses, with a 60-second min gap so a flood of bogus
// `kid`s can't DoS our outbound bandwidth to Apple.
const APPLE_JWKS_FORCE_REFRESH_MIN_GAP_MS = 60 * 1000;
let appleJwksLastForceRefresh = 0;

const MAX_EMAIL_VERIFICATION_ATTEMPTS = 5;

function resolveAuthLanguage(req: Pick<Request, 'header'>): Lang {
  return normalizeLangHeader(req.header?.('x-language')) ?? 'en-US';
}

function authCopy(language: Lang, ptPT: string, ptBR: string, enUS: string): string {
  if (language === 'pt-BR') return ptBR;
  if (language === 'pt-PT') return ptPT;
  return enUS;
}

async function getAppleJwks(forceRefresh = false): Promise<any[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    appleJwksCache &&
    now - appleJwksCache.fetchedAt < APPLE_JWKS_TTL
  ) {
    return appleJwksCache.keys;
  }
  if (forceRefresh && now - appleJwksLastForceRefresh < APPLE_JWKS_FORCE_REFRESH_MIN_GAP_MS) {
    // Avoid a refresh storm if many bogus `kid`s arrive in succession.
    return appleJwksCache?.keys ?? [];
  }
  const res = await fetch('https://appleid.apple.com/auth/keys');
  const data = await res.json() as { keys: any[] };
  appleJwksCache = { keys: data.keys, fetchedAt: now };
  if (forceRefresh) appleJwksLastForceRefresh = now;
  return data.keys;
}

function generateEmailVerificationCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Common helper: register device + issue JWT + return auth response.
 * Used by all auth routes after the user is identified/created.
 */
function issueTokensAndRegisterDevice(
  req: Request, res: Response, userId: number,
  deviceId: string, deviceName: string | null,
  pushToken: string | null, user: { first_name?: string | null; last_name?: string | null; language?: string },
): void {
  const payload = createAuthSessionAndRegisterDevice({
    userId,
    deviceId,
    deviceName,
    pushToken,
    user,
    ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
  });

  logger.info(
    {
      event: 'auth',
      action: req.path || 'issue_session',
      outcome: 'success',
      userId,
      deviceId,
      hasPushToken: Boolean(pushToken),
    },
    'iOS auth session issued',
  );
  sendSuccess(res, payload, { status: 201 });
}

export function authRoutes(): Router {
  const router = Router();

  /**
   * POST /api/v1/auth/register
   * Device registration. Creates or retrieves a user session.
   */
  router.post('/register', asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const { deviceId, deviceName, pushToken, inviteCode } = req.body;

    if (!deviceId || !inviteCode) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'deviceId e inviteCode são obrigatórios',
        'deviceId e inviteCode são obrigatórios',
        'deviceId and inviteCode are required'));
      return;
    }

    const inviteTarget = resolveIosInviteRegistrationTarget(inviteCode, deviceId);
    if (inviteTarget.kind === 'invalid') {
      sendError(res, 'INVALID_INVITE', authCopy(language,
        'Código de convite inválido',
        'Código de convite inválido',
        'Invalid invite code'), 403);
      return;
    }
    if (inviteTarget.kind === 'owner_unavailable') {
      sendError(res, 'NO_USER', authCopy(language,
        'Não existem utilizadores configurados',
        'Não há usuários configurados',
        'No users configured'), 500);
      return;
    }

    if (inviteTarget.kind === 'sandbox') {
      // Beta/reviewer users must be able to exercise the full AI surface.
      // Provision them with a local Max-tier subscription so app review and
      // closed-beta QA do not hit the paywall immediately after sign-in.
      grantBetaSandboxAccess(inviteTarget.user.id);
    }

    issueTokensAndRegisterDevice(
      req,
      res,
      inviteTarget.user.id,
      deviceId,
      deviceName || null,
      pushToken || null,
      inviteTarget.user,
    );
  }));

  /**
   * POST /api/v1/auth/refresh
   * Refresh an expired access token. Rotates the refresh token on success.
   */
  router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const { refreshToken } = req.body;
    if (!refreshToken) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'refreshToken é obrigatório',
        'refreshToken é obrigatório',
        'refreshToken is required'));
      return;
    }

    const db = getDb();
    const device = db.prepare(
      'SELECT user_id, device_id FROM ios_devices WHERE refresh_token = ?',
    ).get(refreshToken) as { user_id: number; device_id: string } | undefined;

    if (!device) {
      sendError(res, 'UNAUTHORIZED', authCopy(language,
        'Refresh token inválido',
        'Refresh token inválido',
        'Invalid refresh token'), 401);
      return;
    }

    const accessToken = jwt.sign(
      { userId: device.user_id, deviceId: device.device_id },
      config.ios.jwtSecret,
      { expiresIn: '7d' as any },
    );

    // Rotate refresh token — invalidate old one, issue new one
    const newRefreshToken = crypto.randomBytes(64).toString('hex');
    db.prepare('UPDATE ios_devices SET refresh_token = ?, last_active_at = datetime(\'now\') WHERE device_id = ?')
      .run(newRefreshToken, device.device_id);

    // Audit P0-10: refresh token rotation. Sensitive because it extends a
    // session — if a leaked refresh token is used, the resulting refresh+
    // rotation will show up here as a new audit row.
    logAudit({
      userId: device.user_id,
      actorId: device.user_id,
      action: 'access',
      resource: 'auth.refresh',
      details: { deviceId: device.device_id },
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });

    logger.info(
      {
        event: 'auth',
        action: 'refresh',
        outcome: 'success',
        userId: device.user_id,
        deviceId: device.device_id,
      },
      'iOS auth refresh succeeded',
    );
    sendSuccess(res, { accessToken, refreshToken: newRefreshToken, expiresIn: 604800 });
  }));

  router.get('/me', verifyJwt, asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const userId = (req as AuthenticatedRequest).userId;
    const user = getUserById(userId);
    if (!user) {
      sendError(res, 'UNAUTHORIZED', authCopy(language,
        'Utilizador não encontrado',
        'Usuário não encontrado',
        'User not found'), 401);
      return;
    }

    sendSuccess(res, {
      id: user.id,
      firstName: user.first_name || 'User',
      lastName: user.last_name || undefined,
      language: user.language || 'en',
    });
  }));

  // ── Sign in with Apple ─────────────────────────────────────────────
  router.post('/register/apple', asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const { identityToken, rawNonce, deviceId, deviceName, firstName, lastName } = req.body;
    if (!identityToken || !rawNonce || !deviceId) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'identityToken, rawNonce e deviceId são obrigatórios',
        'identityToken, rawNonce e deviceId são obrigatórios',
        'identityToken, rawNonce, and deviceId are required'));
      return;
    }

    try {
      // Decode JWT header to find the key ID (kid)
      const header = JSON.parse(Buffer.from(identityToken.split('.')[0], 'base64url').toString());
      // Closed-beta-auth-hardening (2026-05-04): if the cached JWKS
      // doesn't have a key matching the token's `kid`, do ONE forced
      // re-fetch (debounced 60s) before giving up. Apple key rotation
      // would otherwise 401 every Apple sign-in for up to 24h until
      // the cache TTL expires.
      let keys = await getAppleJwks();
      let key = keys.find((k: any) => k.kid === header.kid);
      if (!key) {
        keys = await getAppleJwks(true);
        key = keys.find((k: any) => k.kid === header.kid);
      }
      if (!key) {
        sendError(res, 'INVALID_TOKEN', authCopy(language,
          'Chave Apple não encontrada',
          'Chave Apple não encontrada',
          'Apple key not found'), 401);
        return;
      }

      // Convert JWK to PEM for verification.
      // Closed-beta-auth-hardening (2026-05-04): pass `maxAge: '5m'`
      // and `clockTolerance: 30` so a captured Apple identity_token
      // cannot be replayed for the full 10-minute Apple TTL window
      // (combined with the missing nonce contract documented in
      // `docs/release/auth-readiness-report.md`, this narrows the
      // replay surface significantly).
      const jwkToPem = (await import('crypto')).createPublicKey({ key, format: 'jwk' });
      const payload = jwt.verify(identityToken, jwkToPem, {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: config.apns.bundleId, // me.nexushub.app
        maxAge: '5m',
        clockTolerance: 30,
      }) as any;

      const appleUserId = payload.sub;
      const email = payload.email;
      consumeAppleSignInNonce({
        rawNonce,
        tokenNonce: payload.nonce,
        appleUserId,
      });

      // Find or create user
      let user = getUserByAppleId(appleUserId);
      if (!user) {
        user = createAppleUser(appleUserId, { email, firstName, lastName });
      }

      issueTokensAndRegisterDevice(req, res, user.id, deviceId, deviceName || null, null, user);
    } catch (err: any) {
      if (err instanceof AppleSignInNonceError) {
        logger.warn(
          { event: 'auth', action: 'apple_sign_in', outcome: 'rejected', reason: 'nonce_failed', errorName: err.name },
          'Apple sign-in nonce verification failed',
        );
        sendError(res, 'INVALID_NONCE', authCopy(language,
          'A validação Apple expirou. Tenta novamente.',
          'A validação Apple expirou. Tente novamente.',
          'Apple validation expired. Please try again.'), 401);
        return;
      }
      logger.warn(
        { event: 'auth', action: 'apple_sign_in', outcome: 'rejected', reason: 'verification_failed', errorName: err?.name || 'Error' },
        'Apple sign-in verification failed',
      );
      sendError(res, 'AUTH_FAILED', authCopy(language,
        'A autenticação Apple falhou',
        'A autenticação Apple falhou',
        'Apple authentication failed'), 401);
    }
  }));

  // ── Google sign-in start/finish (web OAuth via backend callback) ─────

  router.post('/register/google/start', asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const { deviceId, deviceName } = req.body;
    if (!deviceId) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'deviceId é obrigatório',
        'deviceId é obrigatório',
        'deviceId is required'));
      return;
    }
    if (!config.google.clientId || !config.google.clientSecret) {
      sendError(res, 'NOT_CONFIGURED', authCopy(language,
        'O início de sessão Google não está configurado',
        'O login com Google não está configurado',
        'Google sign-in is not configured'), 503);
      return;
    }

    const nonce = createGoogleAuthPendingSession(deviceId, deviceName || null);
    const redirectBase = process.env.OAUTH_REDIRECT_BASE || 'https://nexushub.me';
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: `${redirectBase}/oauth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
      state: `ios-auth:${nonce}`,
    });

    sendSuccess(res, {
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      provider: 'google',
    });
  }));

  router.post('/register/google/finish', asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const { authCode } = req.body;
    if (!authCode) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'authCode é obrigatório',
        'authCode é obrigatório',
        'authCode is required'));
      return;
    }

    const payload = consumeGoogleAuthCompletion(authCode);
    if (!payload) {
      sendError(res, 'INVALID_AUTH_CODE', authCopy(language,
        'A sessão de início de sessão Google expirou. Tenta novamente.',
        'A sessão de login com Google expirou. Tente novamente.',
        'Google sign-in session expired. Please try again.'), 401);
      return;
    }

    sendSuccess(res, payload, { status: 201 });
  }));

  // ── Sign in with Google (PKCE) ────────────────────────────────────
  //
  // Supports two flows for backward compatibility:
  //   1. PKCE (recommended): iOS sends { code, codeVerifier, redirectURI }
  //      Backend exchanges the code for an id_token with Google server-side
  //   2. Legacy implicit: iOS sends { idToken }
  //      Backend verifies the id_token directly (deprecated, kept for compat)
  //
  router.post('/register/google', asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const { code, codeVerifier, redirectURI, idToken, deviceId, deviceName } = req.body;
    if (!deviceId) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'deviceId é obrigatório',
        'deviceId é obrigatório',
        'deviceId is required'));
      return;
    }

    try {
      let payload: any;

      if (code && codeVerifier && redirectURI) {
        const exchangeClientId = config.google.iosClientId || config.google.clientId;
        if (!exchangeClientId) {
          sendError(res, 'NOT_CONFIGURED', authCopy(language,
            'O início de sessão Google não está configurado',
            'O login com Google não está configurado',
            'Google sign-in is not configured'), 503);
          return;
        }

        const isIosClient = config.google.iosClientId && exchangeClientId === config.google.iosClientId;
        const tokenParams: Record<string, string> = {
          code,
          client_id: exchangeClientId,
          redirect_uri: redirectURI,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        };
        if (!isIosClient && config.google.clientSecret) {
          tokenParams.client_secret = config.google.clientSecret;
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(tokenParams).toString(),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          logger.warn(
            { event: 'auth', action: 'google_pkce_exchange', outcome: 'rejected', status: tokenRes.status, responseBytes: errBody.length },
            'Google PKCE token exchange failed',
          );
          sendError(res, 'INVALID_TOKEN', authCopy(language,
            'A troca do token Google falhou',
            'A troca do token Google falhou',
            'Google token exchange failed'), 401);
          return;
        }

        const tokens = await tokenRes.json() as { id_token?: string };
        if (!tokens.id_token) {
          sendError(res, 'INVALID_TOKEN', authCopy(language,
            'A resposta do Google não trouxe id_token',
            'A resposta do Google não trouxe id_token',
            'No id_token in Google response'), 401);
          return;
        }

        payload = await verifyGoogleIdentityToken(tokens.id_token);

      } else if (idToken) {
        payload = await verifyGoogleIdentityToken(idToken);

      } else {
        sendError(res, 'BAD_REQUEST', authCopy(language,
          'É obrigatório enviar code+codeVerifier+redirectURI (PKCE) ou idToken (legado)',
          'É obrigatório enviar code+codeVerifier+redirectURI (PKCE) ou idToken (legado)',
          'Either code+codeVerifier+redirectURI (PKCE) or idToken (legacy) is required'));
        return;
      }
      const user = resolveGoogleIdentityUser(payload);

      issueTokensAndRegisterDevice(req, res, user.id, deviceId, deviceName || null, null, user);
    } catch (err: any) {
      // Closed-beta-auth-hardening (2026-05-04): the
      // GoogleAccountLinkRequiresVerificationError path is a
      // distinct 409 status so iOS can render "An account with this
      // email exists. Sign in with the existing method to link
      // Google" rather than a generic AUTH_FAILED. The legitimate
      // owner of the email gets actionable guidance; an attacker
      // attempting takeover is blocked at the 409.
      if (err instanceof GoogleAccountLinkRequiresVerificationError) {
        logger.warn(
          { event: 'auth', action: 'google_sign_in', outcome: 'rejected', reason: 'link_requires_verification' },
          'Google sign-in refused: link requires verification',
        );
        sendError(res, 'ACCOUNT_LINK_REQUIRES_VERIFICATION', authCopy(language,
          'Já existe uma conta com este email. Inicia sessão com o método existente para ligar a conta Google.',
          'Já existe uma conta com este e-mail. Faça login com o método existente para vincular a conta Google.',
          'An account with this email already exists. Sign in with the existing method to link Google.'), 409);
        return;
      }
      if (err instanceof GoogleEmailNotVerifiedError) {
        logger.warn(
          { event: 'auth', action: 'google_sign_in', outcome: 'rejected', reason: 'email_not_verified' },
          'Google sign-in refused: Google email is not verified',
        );
        sendError(res, 'GOOGLE_EMAIL_NOT_VERIFIED', authCopy(language,
          'A Google ainda não verificou este email.',
          'O Google ainda não verificou este e-mail.',
          'Google has not verified this email.'), 403);
        return;
      }
      logger.warn(
        { event: 'auth', action: 'google_sign_in', outcome: 'rejected', reason: 'verification_failed', errorName: err?.name || 'Error' },
        'Google sign-in verification failed',
      );
      sendError(res, 'AUTH_FAILED', authCopy(language,
        'A autenticação Google falhou',
        'A autenticação Google falhou',
        'Google authentication failed'), 401);
    }
  }));

  // ── Register with Email + Password ────────────────────────────────
  router.post('/register/email', asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const { email, password, firstName, deviceId, deviceName } = req.body;
    if (!email || !password || !firstName || !deviceId) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'email, password, firstName e deviceId são obrigatórios',
        'email, password, firstName e deviceId são obrigatórios',
        'email, password, firstName, and deviceId are required'));
      return;
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendError(res, 'INVALID_EMAIL', authCopy(language,
        'Formato de email inválido',
        'Formato de email inválido',
        'Invalid email format'), 400);
      return;
    }

    // Validate password strength
    if (password.length < 8) {
      sendError(res, 'WEAK_PASSWORD', authCopy(language,
        'A palavra-passe tem de ter pelo menos 8 caracteres',
        'A senha deve ter pelo menos 8 caracteres',
        'Password must be at least 8 characters'), 400);
      return;
    }

    // Closed-beta-auth-hardening (2026-05-04): account-existence
    // enumeration mitigation. The previous code returned a distinct
    // `EMAIL_EXISTS 409` status when the email was already registered,
    // which let any unauthenticated caller probe the user database
    // by submitting candidate emails to /register/email.
    //
    // Post-fix: the duplicate-email path returns a generic 400
    // BAD_REQUEST with copy that does NOT confirm whether the email
    // is taken. Legitimate users who really do already have an
    // account get actionable guidance ("Could not create account.
    // Please verify your details and sign in if you already have
    // one"); an enumeration attacker gets the same status code as
    // a malformed-request response. The duplicate IS still logged
    // server-side at info level so ops have visibility.
    const existing = getUserByEmail(email);
    if (existing) {
      logger.info(
        {
          event: 'auth',
          action: 'register_email',
          outcome: 'rejected',
          reason: 'email_already_registered',
          existingUserId: existing.id,
        },
        'Email registration refused: email already in use',
      );
      sendError(res, 'REGISTRATION_REJECTED', authCopy(language,
        'Não foi possível criar a conta. Verifica os dados e inicia sessão se já tens uma conta.',
        'Não foi possível criar a conta. Verifique os dados e faça login se já tem uma conta.',
        'Could not create account. Please verify your details and sign in if you already have one.'), 400);
      return;
    }

    // Hash password with bcrypt (cost factor 12)
    const passwordHash = await bcrypt.hash(password, 12);
    const user = createEmailUser(email, passwordHash, { firstName });

    // Auto-send verification code after registration
    try {
      const { sendVerificationCode, isEmailConfigured } = require('../../services/email-sender');
      if (isEmailConfigured()) {
        const code = generateEmailVerificationCode();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const db = getDb();
        db.prepare(`
          INSERT INTO email_verification_codes (user_id, email, code, expires_at, attempt_count)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            code = excluded.code,
            email = excluded.email,
            expires_at = excluded.expires_at,
            attempt_count = 0,
            created_at = datetime('now')
        `).run(user.id, email.toLowerCase(), code, expiresAt, 0);
        // Fire-and-forget — don't block registration on email delivery
        sendVerificationCode(email, code, firstName).catch(() => {});
      }
    } catch { /* email service not available — non-fatal */ }

    issueTokensAndRegisterDevice(req, res, user.id, deviceId, deviceName || null, null, user);
  }));

  // ── Login with Email + Password ───────────────────────────────────
  router.post('/login/email', asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const { email, password, deviceId, deviceName } = req.body;
    if (!email || !password || !deviceId) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'email, password e deviceId são obrigatórios',
        'email, password e deviceId são obrigatórios',
        'email, password, and deviceId are required'));
      return;
    }

    // Vague error on all failures (never reveal if email exists)
    const user = getUserByEmail(email);
    if (!user || !user.password_hash) {
      // Closed-beta-auth-hardening (2026-05-04): audit log for failed
      // login. Email is hashed so log aggregation does not leak the
      // attempted address. The pino warn captures the vague reason
      // ("user_not_found") while the audit row records the outcome
      // for ops review. Successful logins also get an audit row
      // below.
      const emailHash = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
      logAudit({
        userId: 0,
        actorId: 0,
        action: 'access',
        resource: 'auth.login_email',
        details: { outcome: 'failure', reason: 'user_not_found_or_no_password', emailHash, deviceId },
        ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
      });
      sendError(res, 'AUTH_FAILED', authCopy(language,
        'Email ou palavra-passe inválidos',
        'E-mail ou senha inválidos',
        'Invalid email or password'), 401);
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logAudit({
        userId: user.id,
        actorId: user.id,
        action: 'access',
        resource: 'auth.login_email',
        details: { outcome: 'failure', reason: 'invalid_password', deviceId },
        ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
      });
      sendError(res, 'AUTH_FAILED', authCopy(language,
        'Email ou palavra-passe inválidos',
        'E-mail ou senha inválidos',
        'Invalid email or password'), 401);
      return;
    }

    if (user.status !== 'active') {
      logAudit({
        userId: user.id,
        actorId: user.id,
        action: 'access',
        resource: 'auth.login_email',
        details: { outcome: 'failure', reason: 'account_not_active', status: user.status, deviceId },
        ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
      });
      sendError(res, 'ACCOUNT_SUSPENDED', authCopy(language,
        'A tua conta foi suspensa',
        'Sua conta foi suspensa',
        'Your account has been suspended'), 403);
      return;
    }

    logAudit({
      userId: user.id,
      actorId: user.id,
      action: 'access',
      resource: 'auth.login_email',
      details: { outcome: 'success', deviceId },
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });
    issueTokensAndRegisterDevice(req, res, user.id, deviceId, deviceName || null, null, user);
  }));

  // ── Send Verification Code ─────────────────────────────────────────
  // These verification routes need JWT auth but live in the public auth
  // router. We inline the auth check via the authMiddleware import.
  router.post('/send-verification', verifyJwt, asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const userId = (req as any).userId;

    const db = getDb();
    const user = getUserById(userId);
    if (!user?.email) {
      sendError(res, 'NO_EMAIL', authCopy(language,
        'Não existe um endereço de email nesta conta',
        'Não há um endereço de e-mail nesta conta',
        'No email address on this account'));
      return;
    }

    if (user.email_verified) {
      sendSuccess(res, { verified: true, message: authCopy(language,
        'Email já verificado',
        'E-mail já verificado',
        'Email already verified') });
      return;
    }

    // Generate 6-digit code
    const code = generateEmailVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Store code (UPSERT — one active code per user)
    db.prepare(`
      INSERT INTO email_verification_codes (user_id, email, code, expires_at, attempt_count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        code = excluded.code,
        email = excluded.email,
        expires_at = excluded.expires_at,
        attempt_count = 0,
        created_at = datetime('now')
    `).run(userId, user.email, code, expiresAt);

    // Send email
    try {
      const { sendVerificationCode, isEmailConfigured } = require('../../services/email-sender');
      if (!isEmailConfigured()) {
        logger.warn('Email not configured — verification code not sent');
        // In dev, return the code so testing works
        sendSuccess(res, { sent: false, message: authCopy(language,
          'O serviço de email não está configurado',
          'O serviço de e-mail não está configurado',
          'Email service not configured'), devCode: code });
        return;
      }
      const sent = await sendVerificationCode(user.email, code, user.first_name || 'User');
      sendSuccess(res, {
        sent,
        message: sent
          ? authCopy(language, 'Código de verificação enviado', 'Código de verificação enviado', 'Verification code sent')
          : authCopy(language, 'Falha ao enviar o email', 'Falha ao enviar o e-mail', 'Failed to send email'),
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'Failed to send verification email');
      sendError(res, 'EMAIL_FAILED', authCopy(language,
        'Falha ao enviar o email de verificação',
        'Falha ao enviar o e-mail de verificação',
        'Failed to send verification email'), 500);
    }
  }));

  // ── Verify Email Code ─────────────────────────────────────────────
  router.post('/verify-email', verifyJwt, asyncHandler(async (req: Request, res: Response) => {
    const language = resolveAuthLanguage(req);
    const userId = (req as any).userId;
    const { code } = req.body;

    if (!userId || !code) {
      sendError(res, 'BAD_REQUEST', authCopy(language,
        'Autenticação e código são obrigatórios',
        'Autenticação e código são obrigatórios',
        'Authentication and code are required'));
      return;
    }

    const db = getDb();
    const record = db.prepare(
      'SELECT * FROM email_verification_codes WHERE user_id = ?'
    ).get(userId) as any;

    if (!record) {
      sendError(res, 'INVALID_CODE', authCopy(language,
        'Código de verificação inválido',
        'Código de verificação inválido',
        'Invalid verification code'), 400);
      return;
    }

    if (Number(record.attempt_count ?? 0) >= MAX_EMAIL_VERIFICATION_ATTEMPTS) {
      sendError(res, 'TOO_MANY_ATTEMPTS', authCopy(language,
        'Foram feitas demasiadas tentativas. Pede um novo código.',
        'Muitas tentativas. Solicite um novo código.',
        'Too many attempts. Request a new code.'), 429);
      return;
    }

    // Check expiry
    if (new Date(record.expires_at) < new Date()) {
      sendError(res, 'CODE_EXPIRED', authCopy(language,
        'O código de verificação expirou. Pede um novo.',
        'O código de verificação expirou. Solicite um novo.',
        'Verification code has expired. Request a new one.'), 400);
      return;
    }

    if (String(record.code) !== String(code)) {
      const attempts = Number(record.attempt_count ?? 0) + 1;
      db.prepare('UPDATE email_verification_codes SET attempt_count = ? WHERE user_id = ?')
        .run(attempts, userId);
      sendError(res, attempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS ? 'TOO_MANY_ATTEMPTS' : 'INVALID_CODE', authCopy(language,
        attempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS
          ? 'Foram feitas demasiadas tentativas. Pede um novo código.'
          : 'Código de verificação inválido',
        attempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS
          ? 'Muitas tentativas. Solicite um novo código.'
          : 'Código de verificação inválido',
        attempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS
          ? 'Too many attempts. Request a new code.'
          : 'Invalid verification code'), attempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS ? 429 : 400);
      return;
    }

    // Mark email as verified
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);

    // Clean up the code
    db.prepare('DELETE FROM email_verification_codes WHERE user_id = ?').run(userId);

    logAudit({
      userId, actorId: userId, action: 'access', resource: 'auth.verify_email',
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });

    logger.info({ userId }, 'Email verified successfully');
    sendSuccess(res, { verified: true });
  }));

  // ── Sign Out ─────────────────────────────────────────────────────
  //
  // Beta gap 3 (2026-04-24): there was previously NO server-side way
  // for iOS to invalidate its session. Sign-out on the client just
  // discarded the tokens locally, but the refresh token stayed valid
  // in `ios_devices` indefinitely — if the token leaked or the user
  // switched accounts on the same device, the prior session could still
  // be resurrected by anyone with the refresh token. These two routes
  // close that loophole:
  //
  //   POST /auth/logout      — revoke THIS device's refresh token.
  //                            Called on "Sign out" / account switch.
  //                            authMiddleware will also reject future
  //                            calls bearing the now-orphaned access
  //                            token (see auth-middleware.ts — device
  //                            row existence check).
  //
  //   POST /auth/logout-all  — revoke every device for the user.
  //                            Used for "sign out all devices",
  //                            account deletion, or a suspected
  //                            credential leak.
  //
  // Both return 200 even when no matching device row exists, so iOS
  // can retry safely and does not need branching logic on the client.
  router.post('/logout', verifyJwt, asyncHandler(async (req: Request, res: Response) => {
    const { userId, deviceId } = req as AuthenticatedRequest;
    const db = getDb();

    const result = db.prepare(
      'DELETE FROM ios_devices WHERE user_id = ? AND device_id = ?',
    ).run(userId, deviceId);

    logAudit({
      userId,
      actorId: userId,
      action: 'access',
      resource: 'auth.logout',
      details: { deviceId, devicesRevoked: result.changes },
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });

    logger.info(
      {
        event: 'account_switching',
        action: 'logout',
        outcome: 'success',
        surface: 'ios',
        userId,
        deviceId,
        devicesRevoked: result.changes,
      },
      'iOS session signed out',
    );
    sendSuccess(res, { signedOut: true, devicesRevoked: result.changes });
  }));

  router.post('/logout-all', verifyJwt, asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const db = getDb();

    const result = db.prepare('DELETE FROM ios_devices WHERE user_id = ?').run(userId);

    logAudit({
      userId,
      actorId: userId,
      action: 'access',
      resource: 'auth.logout_all',
      details: { devicesRevoked: result.changes },
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });

    logger.info(
      {
        event: 'account_switching',
        action: 'logout_all',
        outcome: 'success',
        surface: 'ios',
        userId,
        devicesRevoked: result.changes,
      },
      'iOS sessions signed out across all devices',
    );
    sendSuccess(res, { signedOut: true, devicesRevoked: result.changes });
  }));

  return router;
}

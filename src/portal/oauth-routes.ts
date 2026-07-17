// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import express from 'express';
import { logger as defaultLogger } from '../utils/logger';

type OAuthProvider = 'google' | 'outlook' | 'strava' | 'whoop' | 'fitbit' | 'todoist' | 'notion';

interface PortalOAuthLogger {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface PortalOAuthServices {
  exchangeCode: (provider: string, code: string, userId: number) => Promise<unknown>;
  storeTokens: (userId: number, provider: string, tokens: unknown) => void;
  getUserLanguage: (userId: number) => string;
  t: (key: string, lang: string, params?: Record<string, string>) => string;
  isIOSState: (state: string) => boolean;
  parseIOSState: (state: string) => { userId: number; nonce: string } | null;
  consumeNonce: (nonce: string) => { userId: number; provider: string } | null | undefined;
  isIOSGoogleAuthState: (state: string) => boolean;
  parseIOSGoogleAuthState: (state: string) => { nonce: string } | null;
  isWebGoogleAuthState: (state: string) => boolean;
  parseWebGoogleAuthState: (state: string) => { nonce: string } | null;
  consumeGoogleAuthPendingSession: (nonce: string) => { deviceId: string; deviceName?: string | null; inviteCode?: unknown } | null | undefined;
  storeGoogleAuthCompletion: (payload: unknown) => string;
  exchangeGoogleCodeForIdentity: (code: string, redirectUri: string) => Promise<unknown>;
  resolveGoogleIdentityUser: (payload: unknown, options?: { inviteCode?: unknown }) => { id: number };
  isWebAppleAuthState: (state: string) => boolean;
  parseWebAppleAuthState: (state: string) => { nonce: string } | null;
  consumeAppleWebAuthPendingSession: (nonce: string) => { nonceHash: string; deviceId: string; deviceName?: string | null; inviteCode?: unknown } | null | undefined;
  storeAppleWebAuthCompletion: (payload: unknown) => string;
  verifyAppleWebIdentityToken: (identityToken: string, expectedNonceHash: string) => Promise<unknown>;
  parseAppleUserHint: (rawUser: unknown) => unknown;
  resolveAppleWebIdentityUser: (payload: unknown, profileHint?: unknown, inviteCode?: unknown) => { id: number };
  createAuthSessionAndRegisterDevice: (params: {
    userId: number;
    deviceId: string;
    deviceName?: string | null;
    pushToken: string | null;
    user: { id: number };
    ipAddress?: string;
  }) => unknown;
  resetGoogleClients?: () => void;
  resetMicrosoftClients?: () => void;
  syncProvider?: (userId: number, provider: string) => Promise<unknown>;
  runTaskMutationSyncBatch?: (options?: { userId?: number }) => Promise<unknown>;
  /**
   * M6: coordinator-mediated connect sync (push then pull as ONE serialized
   * run). Preferred over the raw syncProvider/runTaskMutationSyncBatch pair —
   * routing through the coordinator is what stops the connect pull from
   * interleaving with the task_sync cron (the provider_missing false-mark race).
   */
  requestTaskProviderConnectSync?: (userId: number, provider: string) => Promise<unknown>;
  invalidateIntegrationDerivedCaches?: (userId: number, provider: string) => void;
}

interface PortalOAuthRouteDeps {
  logger?: PortalOAuthLogger;
  env?: NodeJS.ProcessEnv;
  loadServices?: () => PortalOAuthServices;
}

function loadDefaultOAuthServices(): PortalOAuthServices {
  const { exchangeCode } = require('../services/oauth-flow');
  const { storeTokens } = require('../services/oauth-store');
  const { getUserLanguage } = require('../services/user-service');
  const { t } = require('../utils/i18n');
  const { isIOSState, parseIOSState, consumeNonce } = require('../api/routes/oauth-initiate');
  const {
    isIOSGoogleAuthState,
    parseIOSGoogleAuthState,
    isWebGoogleAuthState,
    parseWebGoogleAuthState,
    consumeGoogleAuthPendingSession,
    storeGoogleAuthCompletion,
  } = require('../services/google-auth-session-store');
  const { exchangeGoogleCodeForIdentity, resolveGoogleIdentityUser } = require('../services/google-sign-in');
  const {
    isWebAppleAuthState,
    parseWebAppleAuthState,
    consumeAppleWebAuthPendingSession,
    storeAppleWebAuthCompletion,
    verifyAppleWebIdentityToken,
    parseAppleUserHint,
    resolveAppleWebIdentityUser,
  } = require('../services/apple-web-sign-in');
  const { createAuthSessionAndRegisterDevice } = require('../services/ios-auth-session');

  let resetGoogleClients: (() => void) | undefined;
  try {
    resetGoogleClients = require('../services/google-auth').resetGoogleClients;
  } catch { /* optional integration reset */ }

  let resetMicrosoftClients: (() => void) | undefined;
  try {
    resetMicrosoftClients = require('../services/microsoft-auth').resetMicrosoftClients;
  } catch { /* optional integration reset */ }

  let syncProvider: ((userId: number, provider: string) => Promise<unknown>) | undefined;
  try {
    syncProvider = require('../services/task-store/sync-engine').syncProvider;
  } catch { /* optional sync engine */ }

  let runTaskMutationSyncBatch: ((options?: { userId?: number }) => Promise<unknown>) | undefined;
  try {
    runTaskMutationSyncBatch = require('../services/task-store/task-mutation-sync-worker').runTaskMutationSyncBatch;
  } catch { /* optional mutation worker */ }

  let requestTaskProviderConnectSync: ((userId: number, provider: string) => Promise<unknown>) | undefined;
  try {
    const { requestTaskSync } = require('../services/task-store/task-sync-coordinator');
    requestTaskProviderConnectSync = (userId: number, provider: string) =>
      requestTaskSync(
        { tenantId: userId, userId },
        'connect',
        { push: true, pull: [provider] },
      ).completion;
  } catch { /* optional sync coordinator */ }

  let invalidateIntegrationDerivedCaches: ((userId: number, provider: string) => void) | undefined;
  try {
    invalidateIntegrationDerivedCaches = require('../services/cache-coherence-registry').invalidateIntegrationDerivedCaches;
  } catch { /* optional cache invalidator */ }

  return {
    exchangeCode,
    storeTokens,
    getUserLanguage,
    t,
    isIOSState,
    parseIOSState,
    consumeNonce,
    isIOSGoogleAuthState,
    parseIOSGoogleAuthState,
    isWebGoogleAuthState,
    parseWebGoogleAuthState,
    consumeGoogleAuthPendingSession,
    storeGoogleAuthCompletion,
    exchangeGoogleCodeForIdentity,
    resolveGoogleIdentityUser,
    isWebAppleAuthState,
    parseWebAppleAuthState,
    consumeAppleWebAuthPendingSession,
    storeAppleWebAuthCompletion,
    verifyAppleWebIdentityToken,
    parseAppleUserHint,
    resolveAppleWebIdentityUser,
    createAuthSessionAndRegisterDevice,
    resetGoogleClients,
    resetMicrosoftClients,
    syncProvider,
    runTaskMutationSyncBatch,
    requestTaskProviderConnectSync,
    invalidateIntegrationDerivedCaches,
  };
}

function htmlConnected(provider: string, message?: string): string {
  return `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>✅ Connected!</h1><p>${message ?? `${provider} account linked. You can close this window and return to Nexus Hub.`}</p></body></html>`;
}

function htmlConnectionFailed(provider: string): string {
  return `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>❌ Connection Failed</h1><p>Please return to Nexus Hub and try connecting ${provider.toLowerCase()} again.</p></body></html>`;
}

function htmlOAuthFragmentRecovery(provider: string): string {
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${providerLabel} connection</title>
</head>
<body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;color:#111">
  <p id="message">Finishing ${providerLabel} connection...</p>
  <script>
    (function () {
      var hash = window.location.hash ? window.location.hash.slice(1) : '';
      if (!hash) {
        document.getElementById('message').textContent = 'The ${providerLabel} sign-in response was incomplete. Return to Nexus Hub and try again.';
        return;
      }
      var params = new URLSearchParams(hash);
      if (!params.has('code') && !params.has('error')) {
        document.getElementById('message').textContent = 'The ${providerLabel} sign-in response was incomplete. Return to Nexus Hub and try again.';
        return;
      }
      window.location.replace(window.location.pathname + '?' + params.toString());
    })();
  </script>
  <noscript>The ${providerLabel} sign-in response was incomplete. Return to Nexus Hub and try again.</noscript>
</body>
</html>`;
}

function redirectIOSOAuth(provider: OAuthProvider, res: Response, status: 'success' | 'error', message?: string): void {
  const suffix = message ? `&message=${encodeURIComponent(message)}` : '';
  res.redirect(`me.nexushub.app://oauth/${provider}?status=${status}${suffix}`);
}

function queryStringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function oauthErrorMessage(error: string, description: string): string {
  const normalized = (description || error || 'Connection failed')
    .replace(/\+/g, ' ')
    .trim();
  return normalized || 'Connection failed';
}

function parseNonceState(state: string, prefix: 'ios' | 'tg'): { userId: number; nonce: string } | null {
  const parts = state.split(':');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const userId = parseInt(parts[1], 10);
  const nonce = parts[2];
  if (!Number.isFinite(userId) || userId <= 0 || !nonce) return null;
  return { userId, nonce };
}

function resolveOAuthUser(
  state: string,
  provider: OAuthProvider,
  services: PortalOAuthServices,
  logger: PortalOAuthLogger,
): { userId: number; isIOS: boolean } | { error: string } {
  const isIOS = services.isIOSState(state);
  const parsed = isIOS ? services.parseIOSState(state) : parseNonceState(state, 'tg');
  if (!parsed) {
    return { error: 'Invalid OAuth state' };
  }
  const nonceData = services.consumeNonce(parsed.nonce);
  if (!nonceData || nonceData.userId !== parsed.userId || nonceData.provider !== provider) {
    logger.warn(
      {
        flow: 'oauth_callback_nonce_mismatch',
        provider,
        origin: isIOS ? 'ios' : 'telegram',
        parsedUserId: parsed.userId,
        noncePrefix: parsed.nonce.slice(0, 8),
        nonceFound: Boolean(nonceData),
        nonceUserId: nonceData?.userId,
        nonceProvider: nonceData?.provider,
      },
      'OAuth callback rejected due to missing or mismatched nonce session',
    );
    return { error: 'Expired or invalid OAuth session' };
  }
  return { userId: parsed.userId, isIOS };
}

function invalidateProviderConnectionCaches(
  userId: number,
  provider: string,
  services: PortalOAuthServices,
  logger: PortalOAuthLogger,
): void {
  try {
    services.invalidateIntegrationDerivedCaches?.(userId, provider);
  } catch (err) {
    logger.warn({ err, userId, provider }, 'OAuth callback cache invalidation failed');
  }
}

function startInitialTaskProviderSync(
  userId: number,
  provider: 'ms_todo' | 'todoist' | 'notion',
  providerLabel: string,
  services: PortalOAuthServices,
  logger: PortalOAuthLogger,
): void {
  // M6: prefer the coordinator-mediated connect sync — ONE single-flight run
  // (push before pull, preserving the NEX-03 ordering) that can never
  // interleave with the task_sync cron or a force-sync for this user.
  if (typeof services.requestTaskProviderConnectSync === 'function') {
    try {
      Promise.resolve(services.requestTaskProviderConnectSync(userId, provider)).catch((err: unknown) =>
        logger.warn({ err, userId }, `Initial ${providerLabel} coordinated sync failed (non-fatal)`),
      );
      return;
    } catch (err) {
      logger.warn({ err, userId }, `Initial ${providerLabel} coordinated sync failed to start; using legacy path`);
    }
  }

  // Legacy path (stubbed service providers in tests / partial deployments).
  // Push BEFORE the initial pull: the mutation batch re-arms auth-parked
  // mutations for the freshly reconnected provider and delivers them, so the
  // pull that follows sees the pushed state instead of overwriting or
  // masking edits made while the provider was disconnected (NEX-03).
  const pull = () => {
    try {
      services.syncProvider?.(userId, provider).catch((err: unknown) =>
        logger.warn({ err, userId }, `Initial ${providerLabel} sync failed (non-fatal)`),
      );
    } catch { /* sync engine optional */ }
  };
  try {
    const push = services.runTaskMutationSyncBatch?.({ userId });
    if (push && typeof (push as Promise<unknown>).then === 'function') {
      (push as Promise<unknown>)
        .catch((err: unknown) =>
          logger.warn({ err, userId }, `Post-reconnect ${providerLabel} mutation push failed (non-fatal)`),
        )
        .finally(pull);
      return;
    }
  } catch { /* mutation worker optional */ }
  pull();
}

async function handleIOSAwareOAuthCallback(
  provider: OAuthProvider,
  providerLabel: string,
  req: Request,
  res: Response,
  loadServices: () => PortalOAuthServices,
  logger: PortalOAuthLogger,
  afterStore?: (userId: number, services: PortalOAuthServices) => void,
): Promise<void> {
  const code = queryStringValue(req.query.code);
  const state = queryStringValue(req.query.state);
  const providerError = queryStringValue(req.query.error);
  const providerErrorDescription = queryStringValue(req.query.error_description);

  if (providerError) {
    const message = oauthErrorMessage(providerError, providerErrorDescription);
    if (state.startsWith('ios:')) {
      redirectIOSOAuth(provider, res, 'error', message);
      return;
    }
    res.status(400).send(htmlConnectionFailed(provider));
    return;
  }

  if (!code || !state) {
    logger.warn(
      {
        provider,
        hasCode: Boolean(code),
        hasState: Boolean(state),
        hasProviderError: Boolean(providerError),
        flow: 'oauth_callback_missing_query',
      },
      'OAuth callback missing query parameters; serving fragment recovery page',
    );
    res.status(200).send(htmlOAuthFragmentRecovery(providerLabel));
    return;
  }

  try {
    const services = loadServices();
    const resolved = resolveOAuthUser(state, provider, services, logger);
    if ('error' in resolved) {
      if (state.startsWith('ios:')) {
        redirectIOSOAuth(provider, res, 'error', resolved.error);
        return;
      }
      res.status(400).send(htmlConnectionFailed(provider));
      return;
    }

    const tokens = await services.exchangeCode(provider, code, resolved.userId);
    services.storeTokens(resolved.userId, provider, tokens);
    invalidateProviderConnectionCaches(resolved.userId, provider, services, logger);
    afterStore?.(resolved.userId, services);

    if (resolved.isIOS) {
      redirectIOSOAuth(provider, res, 'success');
      return;
    }

    res.send(htmlConnected(providerLabel));
  } catch (err) {
    logger.error({ err }, `${providerLabel} OAuth callback failed`);
    if (state.startsWith('ios:')) {
      redirectIOSOAuth(provider, res, 'error', 'Connection failed');
    } else {
      res.status(500).send(htmlConnectionFailed(provider));
    }
  }
}

export function registerPortalOAuthRoutes(app: Express, deps: PortalOAuthRouteDeps = {}): void {
  const logger = deps.logger ?? defaultLogger;
  const env = deps.env ?? process.env;
  const loadServices = deps.loadServices ?? loadDefaultOAuthServices;

  app.get('/oauth/google/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }

    try {
      const services = loadServices();
      const redirectBase = env.OAUTH_REDIRECT_BASE || 'https://api.nexushub.me';

      if (services.isIOSGoogleAuthState(state)) {
        const parsed = services.parseIOSGoogleAuthState(state);
        if (!parsed) {
          res.redirect(`me.nexushub.app://auth/google?status=error&message=${encodeURIComponent('Invalid Google sign-in state')}`);
          return;
        }

        const pending = services.consumeGoogleAuthPendingSession(parsed.nonce);
        if (!pending) {
          res.redirect(`me.nexushub.app://auth/google?status=error&message=${encodeURIComponent('Google sign-in session expired')}`);
          return;
        }

        const payload = await services.exchangeGoogleCodeForIdentity(code, `${redirectBase}/oauth/google/callback`);
        const user = services.resolveGoogleIdentityUser(payload, { inviteCode: pending.inviteCode });
        const authPayload = services.createAuthSessionAndRegisterDevice({
          userId: user.id,
          deviceId: pending.deviceId,
          deviceName: pending.deviceName,
          pushToken: null,
          user,
          ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
        });
        const authCode = services.storeGoogleAuthCompletion(authPayload);
        res.redirect(`me.nexushub.app://auth/google?status=success&authCode=${encodeURIComponent(authCode)}`);
        return;
      }

      if (services.isWebGoogleAuthState(state)) {
        const parsed = services.parseWebGoogleAuthState(state);
        if (!parsed) {
          res.redirect(`/user?error=${encodeURIComponent('Invalid Google sign-in state')}`);
          return;
        }

        const pending = services.consumeGoogleAuthPendingSession(parsed.nonce);
        if (!pending) {
          res.redirect(`/user?error=${encodeURIComponent('Google sign-in session expired')}`);
          return;
        }

        const payload = await services.exchangeGoogleCodeForIdentity(code, `${redirectBase}/oauth/google/callback`);
        const user = services.resolveGoogleIdentityUser(payload, { inviteCode: pending.inviteCode });
        const authPayload = services.createAuthSessionAndRegisterDevice({
          userId: user.id,
          deviceId: pending.deviceId,
          deviceName: pending.deviceName,
          pushToken: null,
          user,
          ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
        });
        const authCode = services.storeGoogleAuthCompletion(authPayload);
        res.redirect(`/user?googleAuthCode=${encodeURIComponent(authCode)}`);
        return;
      }

      await handleIOSAwareOAuthCallback(
        'google',
        'Google',
        req,
        res,
        () => services,
        logger,
        (_userId, oauthServices) => oauthServices.resetGoogleClients?.(),
      );
    } catch (err) {
      logger.error({ err }, 'Google OAuth callback failed');
      if (state.startsWith('ios-auth:')) {
        res.redirect(`me.nexushub.app://auth/google?status=error&message=${encodeURIComponent('Google sign-in failed')}`);
      } else if (state.startsWith('web-auth:')) {
        res.redirect(`/user?error=${encodeURIComponent('Google sign-in failed')}`);
      } else if (state.startsWith('ios:')) {
        redirectIOSOAuth('google', res, 'error', 'Connection failed');
      } else {
        res.status(500).send(htmlConnectionFailed('google'));
      }
    }
  });

  app.post(
    '/oauth/apple/callback',
    express.urlencoded({ extended: false, limit: '16kb' }),
    async (req: Request, res: Response) => {
      const state = typeof req.body?.state === 'string' ? req.body.state : '';
      const idToken = typeof req.body?.id_token === 'string' ? req.body.id_token : '';
      const appleError = typeof req.body?.error === 'string' ? req.body.error : '';

      if (appleError) {
        res.redirect(`/user?error=${encodeURIComponent(appleError === 'user_cancelled_authorize'
          ? 'Apple sign-in was cancelled'
          : 'Apple sign-in failed')}`);
        return;
      }

      if (!state || !idToken) {
        res.redirect(`/user?error=${encodeURIComponent('Missing Apple sign-in response')}`);
        return;
      }

      try {
        const services = loadServices();
        if (!services.isWebAppleAuthState(state)) {
          res.redirect(`/user?error=${encodeURIComponent('Invalid Apple sign-in state')}`);
          return;
        }

        const parsed = services.parseWebAppleAuthState(state);
        if (!parsed) {
          res.redirect(`/user?error=${encodeURIComponent('Invalid Apple sign-in state')}`);
          return;
        }

        const pending = services.consumeAppleWebAuthPendingSession(parsed.nonce);
        if (!pending) {
          res.redirect(`/user?error=${encodeURIComponent('Apple sign-in session expired')}`);
          return;
        }

        const payload = await services.verifyAppleWebIdentityToken(idToken, pending.nonceHash);
        const profileHint = services.parseAppleUserHint(req.body?.user);
        const user = services.resolveAppleWebIdentityUser(payload, profileHint, pending.inviteCode);
        const authPayload = services.createAuthSessionAndRegisterDevice({
          userId: user.id,
          deviceId: pending.deviceId,
          deviceName: pending.deviceName,
          pushToken: null,
          user,
          ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
        });
        const authCode = services.storeAppleWebAuthCompletion(authPayload);
        res.redirect(`/user?appleAuthCode=${encodeURIComponent(authCode)}`);
      } catch (err) {
        logger.error({ err }, 'Apple web sign-in callback failed');
        res.redirect(`/user?error=${encodeURIComponent('Apple sign-in failed')}`);
      }
    },
  );

  app.get('/oauth/outlook/callback', async (req: Request, res: Response) => {
    await handleIOSAwareOAuthCallback(
      'outlook',
      'Outlook',
      req,
      res,
      loadServices,
      logger,
      (userId, oauthServices) => {
        oauthServices.resetMicrosoftClients?.();
        startInitialTaskProviderSync(userId, 'ms_todo', 'Microsoft To Do', oauthServices, logger);
      },
    );
  });

  app.get('/oauth/strava/callback', async (req: Request, res: Response) => {
    await handleIOSAwareOAuthCallback('strava', 'Strava', req, res, loadServices, logger);
  });

  app.get('/oauth/whoop/callback', async (req: Request, res: Response) => {
    await handleIOSAwareOAuthCallback('whoop', 'Whoop', req, res, loadServices, logger);
  });

  app.get('/oauth/fitbit/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }

    try {
      const services = loadServices();
      const resolved = resolveOAuthUser(state, 'fitbit', services, logger);
      if ('error' in resolved) {
        res.status(400).send(htmlConnectionFailed('fitbit'));
        return;
      }
      const userId = resolved.userId;
      const tokens = await services.exchangeCode('fitbit', code, userId);
      services.storeTokens(userId, 'fitbit', tokens);
      invalidateProviderConnectionCaches(userId, 'fitbit', services, logger);
      res.send(htmlConnected('Fitbit'));
    } catch (err) {
      logger.error({ err }, 'Fitbit OAuth callback failed');
      res.status(500).send(htmlConnectionFailed('fitbit'));
    }
  });

  app.get('/oauth/todoist/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }

    try {
      const services = loadServices();
      const resolved = resolveOAuthUser(state, 'todoist', services, logger);
      if ('error' in resolved) {
        res.status(400).send(htmlConnectionFailed('todoist'));
        return;
      }
      const userId = resolved.userId;
      const tokens = await services.exchangeCode('todoist', code, userId);
      services.storeTokens(userId, 'todoist', tokens);
      invalidateProviderConnectionCaches(userId, 'todoist', services, logger);

      startInitialTaskProviderSync(userId, 'todoist', 'Todoist', services, logger);

      res.send(htmlConnected('Todoist', 'Todoist account linked. Your first sync is starting now. Return to Nexus Hub to continue.'));
    } catch (err) {
      logger.error({ err }, 'Todoist OAuth callback failed');
      res.status(500).send(htmlConnectionFailed('todoist'));
    }
  });

  app.get('/oauth/notion/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }

    try {
      const services = loadServices();
      const resolved = resolveOAuthUser(state, 'notion', services, logger);
      if ('error' in resolved) {
        res.status(400).send(htmlConnectionFailed('notion'));
        return;
      }
      const userId = resolved.userId;
      const tokens = await services.exchangeCode('notion', code, userId);
      services.storeTokens(userId, 'notion', tokens);
      invalidateProviderConnectionCaches(userId, 'notion', services, logger);
      startInitialTaskProviderSync(userId, 'notion', 'Notion', services, logger);

      res.send(htmlConnected('Notion', 'Notion account linked. Return to Nexus Hub to finish setup.'));
    } catch (err) {
      logger.error({ err }, 'Notion OAuth callback failed');
      res.status(500).send(htmlConnectionFailed('notion'));
    }
  });
}

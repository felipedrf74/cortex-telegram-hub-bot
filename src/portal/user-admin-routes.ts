// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * User lifecycle routes for the operator portal (no impersonation).
 *
 *   GET  /api/users/funnel                                   signup / onboarding / activation funnel
 *   GET  /api/users/:userId/sessions                        iOS devices + push tokens (never token values)
 *   POST /api/users/:userId/sessions/:deviceId/revoke       sign out one device            (admin, audited)
 *   POST /api/users/:userId/sessions/revoke-all             sign out every device          (admin, audited)
 *   POST /api/users/:userId/push-tokens/:tokenId/revoke     revoke one APNs token          (admin, audited)
 *   GET  /api/users/:userId/lockout                         failed-login window / lockout
 *   POST /api/users/:userId/lockout/clear                   clear the lockout              (admin, audited)
 *   GET  /api/users/:userId/integrations                    provider connection matrix (no tokens)
 *
 * Every :userId route chains requirePortalAdminToken + requireOperatorTargetUser.
 */

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { getLockoutState, recordSuccessfulLogin } from '../services/account-lockout';
import { revokeAllDeviceSessions, revokeDeviceSession } from '../services/ios-auth-session';
import { getIntegrationSummary } from '../services/integration-status';
import { revokeNotificationDeviceToken } from '../services/notification-orchestrator';
import { logPortalAdminMutation } from './admin-audit';
import { requireOperatorTargetUser } from './admin-target-user';
import { sendPortalInternalError } from './http';

function failed(res: Response, err: unknown, what: string): void {
  sendPortalInternalError(res, err, 'Portal request failed', `Portal: ${what} request failed`);
}

function userIdParam(req: Request): number {
  return Number(req.params.userId);
}

export interface UserFunnel {
  usersByStatus: Record<string, number>;
  usersByAuthProvider: Record<string, number>;
  signupsByWeek: Array<{ week: string; count: number }>;
  active7d: number;
  active30d: number;
  withActiveDevice: number;
  withActivePushToken: number;
  withAnyOauthProvider: number;
  onboarding: Array<{ questionnaire: string; status: string; count: number }>;
  inviteCodesRedeemed: number;
  total: number;
}

export function buildUserFunnel(): UserFunnel {
  const db = getDb();
  const count = (sql: string, ...params: unknown[]): number => {
    try { return Number((db.prepare(sql).get(...params) as { c?: number } | undefined)?.c ?? 0); } catch { return 0; }
  };
  const group = (sql: string): Array<Record<string, unknown>> => {
    try { return db.prepare(sql).all() as Array<Record<string, unknown>>; } catch { return []; }
  };
  const usersByStatus: Record<string, number> = {};
  for (const row of group('SELECT status, COUNT(*) AS c FROM users GROUP BY status')) usersByStatus[String(row.status)] = Number(row.c);
  const usersByAuthProvider: Record<string, number> = {};
  for (const row of group("SELECT COALESCE(auth_provider, 'unknown') AS p, COUNT(*) AS c FROM users GROUP BY p")) usersByAuthProvider[String(row.p)] = Number(row.c);
  const since12w = new Date(Date.now() - 12 * 7 * 86_400_000).toISOString();
  const signupsByWeek = group(`SELECT strftime('%Y-W%W', created_at) AS week, COUNT(*) AS c FROM users WHERE created_at >= '${since12w}' GROUP BY week ORDER BY week ASC`)
    .map((row) => ({ week: String(row.week), count: Number(row.c) }));
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  return {
    total: count('SELECT COUNT(*) AS c FROM users'),
    usersByStatus,
    usersByAuthProvider,
    signupsByWeek,
    active7d: count('SELECT COUNT(*) AS c FROM users WHERE last_active_at >= ?', since7d),
    active30d: count('SELECT COUNT(*) AS c FROM users WHERE last_active_at >= ?', since30d),
    withActiveDevice: count('SELECT COUNT(DISTINCT user_id) AS c FROM ios_devices'),
    withActivePushToken: count('SELECT COUNT(DISTINCT user_id) AS c FROM notification_device_tokens WHERE revoked_at IS NULL'),
    withAnyOauthProvider: count('SELECT COUNT(DISTINCT user_id) AS c FROM user_oauth_tokens'),
    onboarding: group('SELECT questionnaire, status, COUNT(*) AS c FROM onboarding_sessions GROUP BY questionnaire, status ORDER BY questionnaire, status')
      .map((row) => ({ questionnaire: String(row.questionnaire), status: String(row.status), count: Number(row.c) })),
    inviteCodesRedeemed: count("SELECT COUNT(*) AS c FROM users WHERE invite_code IS NOT NULL AND invite_code <> ''"),
  };
}

export function listUserSessions(userId: number): {
  devices: Array<{ deviceId: string; deviceName: string | null; lastActiveAt: string | null; createdAt: string | null; hasRefreshToken: boolean; hasLegacyPushToken: boolean }>;
  pushTokens: Array<{ tokenId: string; platform: string; environment: string; tokenSuffix: string; deviceId: string | null; appVersion: string | null; lastSeenAt: string; revokedAt: string | null }>;
} {
  const db = getDb();
  const devices = (db.prepare(
    'SELECT device_id, device_name, last_active_at, created_at, refresh_token_hash, refresh_token, push_token FROM ios_devices WHERE user_id = ? ORDER BY last_active_at DESC',
  ).all(userId) as Array<Record<string, unknown>>).map((row) => ({
    deviceId: String(row.device_id),
    deviceName: (row.device_name as string | null) ?? null,
    lastActiveAt: (row.last_active_at as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    hasRefreshToken: Boolean(row.refresh_token_hash || row.refresh_token),
    hasLegacyPushToken: Boolean(row.push_token),
  }));
  let pushTokens: ReturnType<typeof listUserSessions>['pushTokens'] = [];
  try {
    pushTokens = (db.prepare(
      'SELECT token_id, platform, environment, token_suffix, device_id, app_version, last_seen_at, revoked_at FROM notification_device_tokens WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50',
    ).all(userId) as Array<Record<string, unknown>>).map((row) => ({
      tokenId: String(row.token_id),
      platform: String(row.platform),
      environment: String(row.environment),
      tokenSuffix: String(row.token_suffix),
      deviceId: (row.device_id as string | null) ?? null,
      appVersion: (row.app_version as string | null) ?? null,
      lastSeenAt: String(row.last_seen_at),
      revokedAt: (row.revoked_at as string | null) ?? null,
    }));
  } catch {
    pushTokens = [];
  }
  return { devices, pushTokens };
}

export function getUserLockoutView(userId: number): {
  state: ReturnType<typeof getLockoutState>;
  row: { attemptCount: number; firstFailedAt: string | null; lastFailedAt: string | null; lockedUntil: string | null } | null;
} {
  const state = getLockoutState(userId);
  let row: ReturnType<typeof getUserLockoutView>['row'] = null;
  try {
    const raw = getDb().prepare('SELECT attempt_count, first_failed_at, last_failed_at, locked_until FROM failed_login_attempts WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;
    if (raw) {
      row = {
        attemptCount: Number(raw.attempt_count),
        firstFailedAt: (raw.first_failed_at as string | null) ?? null,
        lastFailedAt: (raw.last_failed_at as string | null) ?? null,
        lockedUntil: (raw.locked_until as string | null) ?? null,
      };
    }
  } catch {
    row = null;
  }
  return { state, row };
}

export function getUserIntegrationsView(userId: number): {
  summary: ReturnType<typeof getIntegrationSummary>;
  connections: Array<{ provider: string; expiresAt: string | null; scopes: string | null; updatedAt: string | null }>;
} {
  const summary = getIntegrationSummary(userId);
  let connections: ReturnType<typeof getUserIntegrationsView>['connections'] = [];
  try {
    connections = (getDb().prepare(
      'SELECT provider, expires_at, scopes, updated_at FROM user_oauth_tokens WHERE user_id = ? ORDER BY provider',
    ).all(userId) as Array<Record<string, unknown>>).map((row) => ({
      provider: String(row.provider),
      expiresAt: (row.expires_at as string | null) ?? null,
      scopes: (row.scopes as string | null) ?? null,
      updatedAt: (row.updated_at as string | null) ?? null,
    }));
  } catch {
    connections = [];
  }
  return { summary, connections };
}

export function registerPortalUserAdminRoutes(app: Express): void {
  app.get('/api/users/funnel', requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, funnel: buildUserFunnel() });
    } catch (err) {
      failed(res, err, 'user funnel');
    }
  });

  app.get('/api/users/:userId/sessions', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...listUserSessions(userIdParam(req)) });
    } catch (err) {
      failed(res, err, 'user sessions');
    }
  });

  app.post('/api/users/:userId/sessions/:deviceId/revoke', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = userIdParam(req);
      const deviceId = String(req.params.deviceId || '').trim().slice(0, 256);
      if (!deviceId) { res.status(400).json({ ok: false, message: 'Invalid device id' }); return; }
      const result = revokeDeviceSession(userId, deviceId);
      logPortalAdminMutation(req, userId, 'user.session.revoke', { deviceId, ...result });
      res.status(result.devicesRevoked > 0 || result.notificationTokensRevoked > 0 ? 200 : 404).json({ ok: result.devicesRevoked > 0 || result.notificationTokensRevoked > 0, ...result });
    } catch (err) {
      failed(res, err, 'user session revoke');
    }
  });

  app.post('/api/users/:userId/sessions/revoke-all', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = userIdParam(req);
      const result = revokeAllDeviceSessions(userId);
      logPortalAdminMutation(req, userId, 'user.session.revoke_all', { ...result });
      res.json({ ok: true, ...result });
    } catch (err) {
      failed(res, err, 'user session revoke-all');
    }
  });

  app.post('/api/users/:userId/push-tokens/:tokenId/revoke', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = userIdParam(req);
      const tokenId = String(req.params.tokenId || '').trim().slice(0, 128);
      if (!tokenId) { res.status(400).json({ ok: false, message: 'Invalid token id' }); return; }
      const ok = revokeNotificationDeviceToken(tokenId, userId);
      if (ok) logPortalAdminMutation(req, userId, 'user.push_token.revoke', { tokenId });
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      failed(res, err, 'user push token revoke');
    }
  });

  app.get('/api/users/:userId/lockout', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const view = getUserLockoutView(userIdParam(req));
      res.json({
        ok: true,
        state: view.state.kind,
        attemptsInWindow: view.state.attemptsInWindow,
        lockedUntil: view.state.kind === 'locked' ? view.state.until.toISOString() : null,
        row: view.row,
      });
    } catch (err) {
      failed(res, err, 'user lockout');
    }
  });

  app.post('/api/users/:userId/lockout/clear', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = userIdParam(req);
      recordSuccessfulLogin(userId);
      logPortalAdminMutation(req, userId, 'user.lockout.clear', {});
      res.json({ ok: true });
    } catch (err) {
      failed(res, err, 'user lockout clear');
    }
  });

  app.get('/api/users/:userId/integrations', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...getUserIntegrationsView(userIdParam(req)) });
    } catch (err) {
      failed(res, err, 'user integrations');
    }
  });
}

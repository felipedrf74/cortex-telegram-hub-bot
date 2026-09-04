import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  requirePortalAdminToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  requireOperatorTargetUser: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
  revokeNotificationDeviceToken: vi.fn(() => true),
  getIntegrationSummary: vi.fn(() => ({ providers: [{ provider: 'google', state: 'connected' }], counts: { connected: 1, degraded: 0, revoked: 0, pending: 0, disconnected: 0 }, capabilities: {} })),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => hoisted.db }));
vi.mock('../../src/api/secret-guards', () => ({ requirePortalAdminToken: hoisted.requirePortalAdminToken }));
vi.mock('../../src/portal/admin-target-user', () => ({ requireOperatorTargetUser: hoisted.requireOperatorTargetUser }));
vi.mock('../../src/portal/admin-audit', () => ({ logPortalAdminMutation: hoisted.logPortalAdminMutation }));
vi.mock('../../src/portal/http', () => ({ sendPortalInternalError: hoisted.sendPortalInternalError }));
vi.mock('../../src/services/notification-orchestrator', () => ({ revokeNotificationDeviceToken: hoisted.revokeNotificationDeviceToken }));
vi.mock('../../src/services/integration-status', () => ({ getIntegrationSummary: hoisted.getIntegrationSummary }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalUserAdminRoutes, buildUserFunnel } from '../../src/portal/user-admin-routes';

type Handler = (req: any, res: any) => void;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  const reg = (method: string) => vi.fn((p: string, ...h: Handler[]) => { routes.set(`${method} ${p}`, h); });
  const app = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), put: reg('PUT'), delete: reg('DELETE') };
  registerPortalUserAdminRoutes(app as any);
  return { routes };
}

function call(routes: Map<string, Handler[]>, key: string, req: any = {}) {
  const handlers = routes.get(key)!;
  const payload: { statusCode: number; body?: any } = { statusCode: 200 };
  const res: any = { status: (c: number) => { payload.statusCode = c; return res; }, json: (b: unknown) => { payload.body = b; return res; } };
  handlers[handlers.length - 1]({ query: {}, params: {}, body: {}, ...req }, res);
  return payload;
}

beforeEach(() => {
  hoisted.db = createMigratedTestDatabase();
  const db = hoisted.db;
  db.prepare("INSERT INTO users (id, telegram_id, email, auth_provider, status, invite_code, created_at, last_active_at) VALUES (1, NULL, 'a@x.io', 'apple', 'active', 'INV1', datetime('now'), datetime('now'))").run();
  db.prepare("INSERT INTO users (id, telegram_id, email, auth_provider, status, created_at, last_active_at) VALUES (2, NULL, 'b@x.io', 'email', 'suspended', datetime('now', '-40 days'), datetime('now', '-20 days'))").run();
  db.prepare("INSERT INTO ios_devices (user_id, device_id, device_name, refresh_token_hash) VALUES (1, 'dev-a', 'iPhone', 'hash-a')").run();
  db.prepare("INSERT INTO ios_devices (user_id, device_id, device_name, refresh_token_hash) VALUES (1, 'dev-b', 'iPad', 'hash-b')").run();
  db.prepare("INSERT INTO notification_device_tokens (token_id, user_id, tenant_id, token_hash, token_suffix, environment, device_id) VALUES ('tok-1', 1, 1, 'h', 'abcd', 'production', 'dev-a')").run();
  db.prepare("INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, scopes, expires_at) VALUES (1, 'google', 'SECRET-ACCESS', 'SECRET-REFRESH', 'calendar', '2026-12-01T00:00:00Z')").run();
  db.prepare("INSERT INTO onboarding_sessions (user_id, questionnaire, status) VALUES (1, 'fitness', 'completed')").run();
  const nowIso = new Date().toISOString();
  const lockedUntilIso = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare('INSERT INTO failed_login_attempts (user_id, attempt_count, first_failed_at, last_failed_at, locked_until) VALUES (1, 10, ?, ?, ?)').run(nowIso, nowIso, lockedUntilIso);
  hoisted.logPortalAdminMutation.mockClear();
});

afterEach(() => {
  hoisted.db?.close();
  hoisted.db = null;
});

describe('portal user admin routes', () => {
  it('chains the admin token and operator target-user guards on every :userId route', () => {
    const { routes } = makeApp();
    for (const [key, handlers] of routes.entries()) {
      expect(handlers[0]).toBe(hoisted.requirePortalAdminToken);
      if (key.includes(':userId')) expect(handlers).toHaveLength(3);
    }
    expect(Array.from(routes.keys())).toEqual(expect.arrayContaining([
      'GET /api/users/funnel', 'GET /api/users/:userId/sessions', 'POST /api/users/:userId/sessions/:deviceId/revoke',
      'POST /api/users/:userId/sessions/revoke-all', 'POST /api/users/:userId/push-tokens/:tokenId/revoke',
      'GET /api/users/:userId/lockout', 'POST /api/users/:userId/lockout/clear', 'GET /api/users/:userId/integrations',
    ]));
  });

  it('lists sessions without token values and revokes one device or all devices with audit rows', () => {
    const { routes } = makeApp();
    const sessions = call(routes, 'GET /api/users/:userId/sessions', { params: { userId: '1' } }).body;
    expect(sessions.devices).toHaveLength(2);
    expect(sessions.devices[0]).toMatchObject({ hasRefreshToken: true });
    expect(sessions.pushTokens[0]).toMatchObject({ tokenId: 'tok-1', tokenSuffix: 'abcd', environment: 'production' });
    expect(JSON.stringify(sessions)).not.toContain('hash-a');

    const one = call(routes, 'POST /api/users/:userId/sessions/:deviceId/revoke', { params: { userId: '1', deviceId: 'dev-a' } });
    expect(one.body).toMatchObject({ ok: true, devicesRevoked: 1, notificationTokensRevoked: 1 });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 1, 'user.session.revoke', expect.objectContaining({ deviceId: 'dev-a' }));
    expect(call(routes, 'POST /api/users/:userId/sessions/:deviceId/revoke', { params: { userId: '1', deviceId: 'nope' } }).statusCode).toBe(404);

    const all = call(routes, 'POST /api/users/:userId/sessions/revoke-all', { params: { userId: '1' } });
    expect(all.body).toMatchObject({ ok: true, devicesRevoked: 1 });
    expect(hoisted.db!.prepare('SELECT COUNT(*) AS c FROM ios_devices WHERE user_id = 1').get()).toEqual({ c: 0 });
  });

  it('revokes push tokens through the orchestrator', () => {
    const { routes } = makeApp();
    expect(call(routes, 'POST /api/users/:userId/push-tokens/:tokenId/revoke', { params: { userId: '1', tokenId: 'tok-1' } }).body).toEqual({ ok: true });
    expect(hoisted.revokeNotificationDeviceToken).toHaveBeenCalledWith('tok-1', 1);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 1, 'user.push_token.revoke', { tokenId: 'tok-1' });
  });

  it('reports and clears the lockout state', () => {
    const { routes } = makeApp();
    const locked = call(routes, 'GET /api/users/:userId/lockout', { params: { userId: '1' } }).body;
    expect(locked.state).toBe('locked');
    expect(locked.row.attemptCount).toBe(10);
    expect(call(routes, 'POST /api/users/:userId/lockout/clear', { params: { userId: '1' } }).body).toEqual({ ok: true });
    expect(call(routes, 'GET /api/users/:userId/lockout', { params: { userId: '1' } }).body).toMatchObject({ state: 'unlocked', row: null });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 1, 'user.lockout.clear', {});
  });

  it('shows the integration matrix without OAuth token material', () => {
    const { routes } = makeApp();
    const view = call(routes, 'GET /api/users/:userId/integrations', { params: { userId: '1' } }).body;
    expect(view.summary.counts.connected).toBe(1);
    expect(view.connections).toEqual([{ provider: 'google', expiresAt: '2026-12-01T00:00:00Z', scopes: 'calendar', updatedAt: expect.any(String) }]);
    expect(JSON.stringify(view)).not.toContain('SECRET');
  });

  it('builds the signup and activation funnel', () => {
    const funnel = buildUserFunnel();
    expect(funnel).toMatchObject({ total: 2, usersByStatus: { active: 1, suspended: 1 }, usersByAuthProvider: { apple: 1, email: 1 }, active7d: 1, active30d: 2, withActiveDevice: 1, withActivePushToken: 1, withAnyOauthProvider: 1, inviteCodesRedeemed: 1 });
    expect(funnel.onboarding).toEqual([{ questionnaire: 'fitness', status: 'completed', count: 1 }]);
    expect(funnel.signupsByWeek.length).toBeGreaterThan(0);
    const { routes } = makeApp();
    expect(call(routes, 'GET /api/users/funnel').body.funnel.total).toBe(2);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request } from 'express';

async function getTenantScopeModule() {
  return import('../../src/services/tenant-scope-observability');
}

let testDb: Database.Database;

async function seedCanonicalContentItem(input: {
  tenantId: number;
  userId: number;
  title: string;
}): Promise<number> {
  const { createContentWorkspaceItem } = await import('../../src/services/content-workspace');
  return createContentWorkspaceItem({
    scope: { tenantId: input.tenantId, userId: input.userId },
    itemType: 'content_item',
    title: input.title,
    idempotencyKey: `settings-fixture:${input.tenantId}:${input.userId}:${input.title}`,
  }, testDb).value.id;
}


interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, number | string | readonly string[]>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  send(body?: any): MockRes;
  setHeader(name: string, value: number | string | readonly string[]): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; return res; },
    send(body?: any) { res.body = body ?? null; return res; },
    setHeader(name: string, value: number | string | readonly string[]) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
  };
  return res;
}

function mockReq(userId: number, body: any): Request {
  return {
    userId,
    deviceId: 'test-device-id',
    body,
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatchLanguage(userId: number, language: string): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, { language });
  (req as any).method = 'POST';
  (req as any).url = '/language';
  (req as any).originalUrl = '/language';
  (req as any).baseUrl = '';
  (req as any).path = '/language';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function dispatchPushToken(userId: number, token: string, deviceId = 'test-device-id'): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, { token });
  (req as any).deviceId = deviceId;
  (req as any).method = 'POST';
  (req as any).url = '/push-token';
  (req as any).originalUrl = '/push-token';
  (req as any).baseUrl = '';
  (req as any).path = '/push-token';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function dispatchDeletePushToken(
  userId: number,
  deviceId = 'test-device-id',
  routerOverride?: any,
): Promise<MockRes> {
  const router = routerOverride ?? (await import('../../src/api/routes/settings')).settingsRoutes();
  const req = mockReq(userId, {});
  (req as any).deviceId = deviceId;
  (req as any).method = 'DELETE';
  (req as any).url = '/push-token';
  (req as any).originalUrl = '/push-token';
  (req as any).baseUrl = '';
  (req as any).path = '/push-token';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function dispatchAccountExport(userId: number, tenantId = userId): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, {});
  (req as any).tenantId = tenantId;
  (req as any).ip = '203.0.113.10';
  (req as any).method = 'POST';
  (req as any).url = '/export';
  (req as any).originalUrl = '/export';
  (req as any).baseUrl = '';
  (req as any).path = '/export';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function dispatchAccountDelete(userId: number): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, {});
  (req as any).ip = '203.0.113.10';
  (req as any).method = 'DELETE';
  (req as any).url = '/account';
  (req as any).originalUrl = '/account';
  (req as any).baseUrl = '';
  (req as any).path = '/account';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function dispatchPushPreferencesGet(userId: number): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, {});
  (req as any).method = 'GET';
  (req as any).url = '/push-preferences';
  (req as any).originalUrl = '/push-preferences';
  (req as any).baseUrl = '';
  (req as any).path = '/push-preferences';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function dispatchPushPreferencesSet(userId: number, category: string, enabled: boolean): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, { category, enabled });
  (req as any).method = 'PUT';
  (req as any).url = '/push-preferences';
  (req as any).originalUrl = '/push-preferences';
  (req as any).baseUrl = '';
  (req as any).path = '/push-preferences';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Settings language route', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    testDb.prepare(`
      INSERT INTO users (id, first_name, language, status, auth_provider)
      VALUES (1, 'Beta Tester', 'pt-BR', 'active', 'invite_code')
    `).run();

    vi.resetModules();
    vi.doMock('../../src/services/database', () => ({
      getDb: () => testDb,
    }));
    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }));
    vi.doMock('../../src/services/user-service', () => ({
      setUserLanguage: (userId: number, language: string) => {
        testDb.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, userId);
      },
    }));
    return getTenantScopeModule().then(({ clearTenantScopeAnomaliesForTests }) => {
      clearTenantScopeAnomaliesForTests();
    });
  });

  it('accepts iOS short english code and stores canonical english', async () => {
    const res = await dispatchLanguage(1, 'en');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.language).toBe('en-US');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('en-US');
  });

  it('accepts portuguese from portugal and preserves pt-PT', async () => {
    const res = await dispatchLanguage(1, 'pt-PT');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.language).toBe('pt-PT');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('pt-PT');
  });

  it('accepts generic portuguese alias and stores canonical pt-BR', async () => {
    const res = await dispatchLanguage(1, 'pt');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.language).toBe('pt-BR');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('pt-BR');
  });

  it('upserts the push token even when the ios_devices row is missing', async () => {
    const res = await dispatchPushToken(1, 'abc123token', 'fresh-device');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = testDb.prepare(
      'SELECT user_id, device_id, push_token FROM ios_devices WHERE device_id = ?',
    ).get('fresh-device') as { user_id: number; device_id: string; push_token: string };

    expect(row.user_id).toBe(1);
    expect(row.push_token).toBe('abc123token');
  });

  it('revokes the authenticated device push token idempotently on sign-out', async () => {
    await dispatchPushToken(1, 'abc123token', 'signout-device');

    const res = await dispatchDeletePushToken(1, 'signout-device');
    const second = await dispatchDeletePushToken(1, 'signout-device');

    expect(res.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    const row = testDb.prepare(
      'SELECT push_token FROM ios_devices WHERE user_id = ? AND device_id = ?',
    ).get(1, 'signout-device') as { push_token: string | null };
    expect(row.push_token).toBeNull();
  });

  it('rate-limits repeated push-token revocations before additional database work', async () => {
    const { config } = await import('../../src/config');
    const originalLimit = config.ios.rateLimit;
    config.ios.rateLimit = 2;
    testDb.prepare(`
      INSERT INTO users (id, first_name, language, status, auth_provider)
      VALUES (2, 'Other Tester', 'en-US', 'active', 'invite_code')
    `).run();
    await dispatchPushToken(1, 'abc123token', 'rate-limited-device');
    await dispatchPushToken(2, 'other-token', 'other-device');
    const { settingsRoutes } = await import('../../src/api/routes/settings');
    const router = settingsRoutes();

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const allowed = await dispatchDeletePushToken(1, 'rate-limited-device', router);
        expect(allowed.statusCode).toBe(204);
      }

      testDb.prepare(`
        UPDATE ios_devices SET push_token = 'must-survive-rate-limit'
        WHERE user_id = ? AND device_id = ?
      `).run(1, 'rate-limited-device');

      const blocked = await dispatchDeletePushToken(1, 'rate-limited-device', router);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.body.error).toEqual({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Slow down.',
        retryAfter: 60,
      });
      expect(blocked.headers['retry-after']).toBe(60);

      const otherUser = await dispatchDeletePushToken(2, 'other-device', router);
      expect(otherUser.statusCode).toBe(204);

      const rows = testDb.prepare(`
        SELECT user_id, push_token FROM ios_devices WHERE device_id IN (?, ?) ORDER BY user_id
      `).all('rate-limited-device', 'other-device') as Array<{ user_id: number; push_token: string | null }>;
      expect(rows).toEqual([
        { user_id: 1, push_token: 'must-survive-rate-limit' },
        { user_id: 2, push_token: null },
      ]);
    } finally {
      config.ios.rateLimit = originalLimit;
    }
  });

  it('rejects invalid push-token revoke scope before touching another user device', async () => {
    await dispatchPushToken(1, 'protected-token', 'protected-device');
    const res = await dispatchDeletePushToken(0, 'protected-device');

    expect(res.statusCode).toBe(401);
    const row = testDb.prepare(`
      SELECT push_token FROM ios_devices WHERE user_id = ? AND device_id = ?
    `).get(1, 'protected-device') as { push_token: string | null };
    expect(row.push_token).toBe('protected-token');

    const { getTenantScopeAnomalies } = await getTenantScopeModule();
    expect(getTenantScopeAnomalies()).toContainEqual(expect.objectContaining({
      operation: 'settings_route_delete_push_token',
      reason: 'invalid_user_scope',
      userId: 0,
    }));
  });

  it('audit-logs account export with table counts', async () => {
    const res = await dispatchAccountExport(1);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    const audit = testDb.prepare(`
      SELECT action, resource, details, ip_address
      FROM audit_trail
      WHERE user_id = ? AND action = 'export' AND resource = 'account'
    `).get(1) as { action: string; resource: string; details: string; ip_address: string };
    expect(audit).toBeTruthy();
    expect(audit.ip_address).toBe('203.0.113.10');
    expect(JSON.parse(audit.details).tableCounts).toBeDefined();
  });

  it('exports governed learning cases only from the authenticated tenant and user scope', async () => {
    const insert = testDb.prepare(`
      INSERT INTO product_learning_cases (
        case_id, tenant_id, user_id, owner, lifecycle, privacy_class,
        redacted_input_json, expected_contract_json, evidence_references_json,
        producer_version, confidence, observed_at, expires_at
      ) VALUES (?, ?, 1, 'training', 'observed', 'redacted-product', ?, ?, ?,
        'training-learning.v1', 1, '2026-07-15T00:00:00.000Z', '2099-01-11T00:00:00.000Z')
    `);
    const input = JSON.stringify({ kind: 'capacity_conflict_accuracy', outcomeCode: 'confirmed' });
    const contract = JSON.stringify({ contractId: 'training.capacity_conflict.v1' });
    insert.run('case-tenant-44', 44, input, contract, JSON.stringify(['ci://run/44/case/1']));
    insert.run('case-tenant-55', 55, input, contract, JSON.stringify(['ci://run/55/case/1']));

    const res = await dispatchAccountExport(1, 44);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.productLearningCases).toEqual([
      expect.objectContaining({
        caseId: 'case-tenant-44',
        tenantId: 44,
        userId: 1,
        redactedInput: { kind: 'capacity_conflict_accuracy', outcomeCode: 'confirmed' },
        expectedContract: { contractId: 'training.capacity_conflict.v1' },
      }),
    ]);
    expect(res.body.data.productLearningCaseTransitions).toEqual([
      expect.objectContaining({
        tenantId: 44,
        userId: 1,
        caseId: 'case-tenant-44',
        fromLifecycle: null,
        toLifecycle: 'observed',
      }),
    ]);
  });

  it('exports owner-scoped Content workspace tables only for the authenticated tenant', async () => {
    await seedCanonicalContentItem({ tenantId: 44, userId: 1, title: 'Tenant 44 idea' });
    await seedCanonicalContentItem({ tenantId: 55, userId: 1, title: 'Tenant 55 idea' });
    testDb.prepare(`
      INSERT INTO content_reference_registry (
        tenant_id, owner_user_id, reference_type, source_identifier,
        title, created_by, updated_by
      ) VALUES
        (44, 1, 'url', 'https://example.test/tenant-44', 'Tenant 44 source', 1, 1),
        (55, 1, 'url', 'https://example.test/tenant-55', 'Tenant 55 source', 1, 1)
    `).run();

    const res = await dispatchAccountExport(1, 44);
    expect(res.statusCode).toBe(200);
    const tables = res.body.data.contentWorkspace.tables as Array<{
      name: string;
      records: Array<Record<string, unknown>>;
    }>;
    const records = (name: string) => tables.find((table) => table.name === name)?.records;

    expect(records('content_domain_objects')).toEqual([
      expect.objectContaining({ title: 'Tenant 44 idea', tenant_id: 44, owner_user_id: 1 }),
    ]);
    expect(records('content_reference_registry')).toEqual([
      expect.objectContaining({ title: 'Tenant 44 source', tenant_id: 44, owner_user_id: 1 }),
    ]);
    expect(JSON.stringify(res.body.data.contentWorkspace)).not.toContain('Tenant 55');
  });

  it('keeps the legacy contentNotifications export alias inside the authenticated tenant', async () => {
    testDb.prepare(`
      INSERT INTO content_notifications (
        user_id, type, title, body, tenant_id, owner_user_id,
        visibility_scope, lifecycle_state, scope_status, created_by, updated_by
      ) VALUES
        (1, 'script_ready', 'Tenant 44 notification', 'Visible', 44, 1,
         'user_private', 'unread', 'active', 1, 1),
        (1, 'script_ready', 'Tenant 55 notification', 'Private to another tenant', 55, 1,
         'user_private', 'unread', 'active', 1, 1)
    `).run();

    const res = await dispatchAccountExport(1, 44);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.contentNotifications).toEqual([
      expect.objectContaining({ title: 'Tenant 44 notification', tenant_id: 44 }),
    ]);
    expect(JSON.stringify(res.body.data.contentNotifications)).not.toContain('Tenant 55');
  });

  it('audit-logs account deletion after cascade so the row survives erasure', async () => {
    const res = await dispatchAccountDelete(1);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    const user = testDb.prepare('SELECT id FROM users WHERE id = ?').get(1);
    expect(user).toBeUndefined();
    const audit = testDb.prepare(`
      SELECT action, resource, details, ip_address
      FROM audit_trail
      WHERE user_id = ? AND action = 'delete' AND resource = 'account'
    `).get(1) as { action: string; resource: string; details: string; ip_address: string };
    expect(audit).toBeTruthy();
    expect(audit.ip_address).toBe('203.0.113.10');
    expect(JSON.parse(audit.details).tableCounts).toBeDefined();
  });

  it('returns store-subscription guidance alongside the deletion result', async () => {
    const res = await dispatchAccountDelete(1);

    expect(res.statusCode).toBe(200);
    // The existing contract must not shift — older clients read these two.
    expect(res.body.data.deleted).toBe(true);
    expect(res.body.data.message).toBe('All data has been permanently deleted.');
    // Deleting the account destroys the local subscriptions row but cannot
    // cancel a store-managed subscription, so the API says so itself instead
    // of relying on every client to know.
    expect(res.body.data.subscriptionNotice).toEqual({
      code: 'STORE_SUBSCRIPTION_NOT_CANCELLED',
      message: expect.stringContaining('does not cancel'),
      managementUrl: 'https://apps.apple.com/account/subscriptions',
    });
  });

  it('completes account deletion when a third-party revocation call fails', async () => {
    testDb.prepare(`
      INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, token_type, scopes)
      VALUES (1, 'google', 'google-access', 'google-refresh', 'Bearer', '[]')
    `).run();
    testDb.prepare('UPDATE users SET apple_user_id = ? WHERE id = 1').run('apple-sub-1');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));

    try {
      const res = await dispatchAccountDelete(1);

      expect(res.statusCode).toBe(200);
      expect(res.body.data.deleted).toBe(true);
      expect(testDb.prepare('SELECT id FROM users WHERE id = 1').get()).toBeUndefined();
      expect(testDb.prepare('SELECT 1 FROM user_oauth_tokens WHERE user_id = 1').get()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not report account deletion success when a Content delete fails', async () => {
    await seedCanonicalContentItem({ tenantId: 1, userId: 1, title: 'Deletion must roll back' });
    testDb.exec(`
      CREATE TRIGGER fail_settings_content_delete
      BEFORE DELETE ON content_domain_objects
      WHEN OLD.owner_user_id = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected settings Content deletion failure');
      END
    `);

    const res = await dispatchAccountDelete(1);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.data?.deleted).not.toBe(true);
    expect(testDb.prepare('SELECT id FROM users WHERE id = 1').get()).toBeTruthy();
    expect(testDb.prepare('SELECT title FROM content_domain_objects WHERE owner_user_id = 1').get())
      .toMatchObject({ title: 'Deletion must roll back' });
  });

  it('fails closed on invalid tenant scope for push preferences read', async () => {
    const res = await dispatchPushPreferencesGet(0);
    const { getTenantScopeAnomalies } = await getTenantScopeModule();

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'settings_route_get_push_preferences',
          reason: 'invalid_user_scope',
          userId: 0,
        }),
      ]),
    );
  });

  it('reads and writes push preferences for a valid tenant scope', async () => {
    const setRes = await dispatchPushPreferencesSet(1, 'coach_briefing', false);

    expect(setRes.statusCode).toBe(200);
    expect(setRes.body.ok).toBe(true);
    expect(setRes.body.data).toEqual({ category: 'coach_briefing', enabled: false });

    const getRes = await dispatchPushPreferencesGet(1);

    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.ok).toBe(true);
    expect(getRes.body.data.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'coach_briefing', enabled: false }),
      ]),
    );
  });
});

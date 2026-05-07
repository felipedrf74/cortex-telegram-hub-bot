import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPortalDocumentRoutes } from '../../src/portal/document-routes';
import { getAllNotifications } from '../../src/services/content-notification-store';
import {
  getAllNotificationCenterItemsForPortal,
  getNotificationProfileSummariesForPortal,
} from '../../src/services/notification-orchestrator';

vi.mock('../../src/services/content-notification-store', () => ({
  getAllNotifications: vi.fn(),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getAllReports: vi.fn(() => []),
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  getAllNotificationCenterItemsForPortal: vi.fn(),
  getNotificationProfileSummariesForPortal: vi.fn(),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: vi.fn((res: any) => {
    res.status(500).json({ ok: false, error: 'Portal request failed' });
  }),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: vi.fn((req: any, res: any, next: () => void) => {
    if (req.headers?.authorization === 'Bearer admin-token') {
      next();
      return;
    }
    res.status(403).json({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'admin portal token required' },
    });
  }),
}));

type CapturedRoutes = Record<string, (req: any, res: any) => void>;

function makeApp(): CapturedRoutes {
  const routes: CapturedRoutes = {};
  const app = {
    get: vi.fn((path: string, ...handlers: Array<(req: any, res: any, next: () => void) => void>) => {
      routes[`GET ${path}`] = (req: any, res: any) => {
        let index = 0;
        const next = (): void => {
          const handler = handlers[index++];
          if (handler) handler(req, res, next);
        };
        next();
      };
    }),
  } as unknown as Express;
  registerPortalDocumentRoutes(app);
  return routes;
}

function makeResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

const adminScopeHeaders = {
  authorization: 'Bearer admin-token',
  'x-nexus-user-id': '42',
  'x-nexus-tenant-id': '42',
};

describe('portal Notification Decision Center behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllNotifications).mockReturnValue([]);
    vi.mocked(getAllNotificationCenterItemsForPortal).mockReturnValue([]);
    vi.mocked(getNotificationProfileSummariesForPortal).mockReturnValue([]);
  });

  it('rejects notification center reads without an admin token', () => {
    const routes = makeApp();
    const res = makeResponse();

    routes['GET /api/notifications']({
      headers: {
        authorization: 'Bearer read-token',
        'x-nexus-user-id': '42',
        'x-nexus-tenant-id': '42',
      },
      query: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getAllNotifications).not.toHaveBeenCalled();
    expect(getAllNotificationCenterItemsForPortal).not.toHaveBeenCalled();
  });

  it('rejects first-paint notification reads until explicit user and tenant scope is supplied', () => {
    const routes = makeApp();
    const res = makeResponse();

    routes['GET /api/notifications']({
      headers: { authorization: 'Bearer admin-token' },
      query: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'INVALID_TENANT_SCOPE', message: 'notification tenant scope required' },
    });
    expect(getAllNotifications).not.toHaveBeenCalled();
    expect(getAllNotificationCenterItemsForPortal).not.toHaveBeenCalled();
  });

  it('loads only scoped portal-safe notification payloads', () => {
    const routes = makeApp();
    const res = makeResponse();
    vi.mocked(getAllNotifications).mockReturnValue([
      {
        id: 8,
        userId: 42,
        type: 'script_ready',
        title: 'Script ready',
        body: 'Portal-safe content notification copy',
        status: 'unread',
        pushSent: false,
        createdAt: '2026-05-07T10:00:00.000Z',
        tenantId: 99,
        secret: 'do-not-serialize',
      },
    ] as any);
    vi.mocked(getAllNotificationCenterItemsForPortal).mockReturnValue([
      {
        itemId: 'nc_finance',
        intentId: 'ni_finance',
        decisionLogId: 'ndl_finance',
        userId: 42,
        tenantId: 42,
        sourceSkill: 'finance',
        type: 'reminder',
        priority: 'time_sensitive',
        status: 'unread',
        title: 'Finance reminder',
        body: 'Raw invoice amount $2,400 should not reach portal preview',
        safeBody: 'Finance reminder needs review.',
        sensitiveBody: 'Raw invoice amount $2,400 should stay behind auth detail',
        deeplink: 'nexus://finance/reminder/1',
        actions: [{ id: 'mark_paid', label: 'Mark paid', style: 'primary' }],
        dedupeKey: 'finance:1',
        createdAt: '2026-05-07T10:00:00.000Z',
        expiresAt: null,
      },
    ] as any);

    routes['GET /api/notifications']({
      headers: adminScopeHeaders,
      query: { limit: '20' },
    }, res);

    expect(getAllNotifications).toHaveBeenCalledWith(20, { userId: 42, tenantId: 42 });
    expect(getAllNotificationCenterItemsForPortal).toHaveBeenCalledWith(20, { userId: 42, tenantId: 42 });
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      count: 2,
      notifications: [{
        id: 8,
        userId: 42,
        type: 'script_ready',
        title: 'Script ready',
        body: 'Portal-safe content notification copy',
        status: 'unread',
        pushSent: false,
        createdAt: '2026-05-07T10:00:00.000Z',
      }],
      decisionCenterItems: [{
        itemId: 'nc_finance',
        userId: 42,
        tenantId: 42,
        sourceSkill: 'finance',
        type: 'reminder',
        priority: 'time_sensitive',
        status: 'unread',
        title: 'Finance reminder',
        body: 'Finance reminder needs review.',
        deeplink: 'nexus://finance/reminder/1',
        actions: [{ id: 'mark_paid', label: 'Mark paid' }],
        createdAt: '2026-05-07T10:00:00.000Z',
        expiresAt: null,
      }],
    });
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('$2,400');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('sensitiveBody');
  });

  it('loads notification preferences through the same tenant-scoped portal boundary', () => {
    const routes = makeApp();
    const res = makeResponse();
    vi.mocked(getNotificationProfileSummariesForPortal).mockReturnValue([
      {
        userId: 42,
        tenantId: 42,
        pushEnabled: true,
        inAppEnabled: true,
        portalEnabled: true,
        allowTimeSensitive: true,
        digestPassiveItems: true,
        updatedAt: '2026-05-07T10:05:00.000Z',
      },
    ]);

    routes['GET /api/notification-preferences']({
      headers: adminScopeHeaders,
      query: { limit: '5' },
    }, res);

    expect(getNotificationProfileSummariesForPortal).toHaveBeenCalledWith(5, { userId: 42, tenantId: 42 });
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      count: 1,
      profiles: [{
        userId: 42,
        tenantId: 42,
        pushEnabled: true,
        inAppEnabled: true,
        portalEnabled: true,
        allowTimeSensitive: true,
        digestPassiveItems: true,
        updatedAt: '2026-05-07T10:05:00.000Z',
      }],
    });
  });
});

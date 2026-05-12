import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPortalDocumentRoutes } from '../../src/portal/document-routes';
import { getAllNotifications } from '../../src/services/content-notification-store';
import { getAllReports } from '../../src/services/report-document-store';
import {
  getAllNotificationCenterItemsForPortal,
  getNotificationProfileSummariesForPortal,
} from '../../src/services/notification-orchestrator';
import { sendPortalInternalError } from '../../src/portal/http';

vi.mock('../../src/services/content-notification-store', () => ({
  getAllNotifications: vi.fn(),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getAllReports: vi.fn(),
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

function makeApp(): { app: Express; routes: CapturedRoutes } {
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
  return { app, routes };
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

describe('portal document routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllNotifications).mockReturnValue([]);
    vi.mocked(getAllReports).mockReturnValue([]);
    vi.mocked(getAllNotificationCenterItemsForPortal).mockReturnValue([]);
    vi.mocked(getNotificationProfileSummariesForPortal).mockReturnValue([]);
  });

  it('registers notification and report document routes', () => {
    const { app } = makeApp();

    registerPortalDocumentRoutes(app);

    expect(app.get).toHaveBeenCalledWith('/api/notifications', expect.any(Function), expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/notification-preferences', expect.any(Function), expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/reports', expect.any(Function));
  });

  it('maps content notifications and Decision Center items into the portal-safe admin payload', () => {
    const { app, routes } = makeApp();
    registerPortalDocumentRoutes(app);
    vi.mocked(getAllNotifications).mockReturnValue([
      {
        id: 7,
        userId: 42,
        type: 'script_ready',
        title: 'Script ready',
        body: 'Review it',
        status: 'unread',
        pushSent: true,
        createdAt: '2026-04-22T10:00:00Z',
        internalDebug: 'do-not-serialize',
      },
    ] as any);
    vi.mocked(getAllNotificationCenterItemsForPortal).mockReturnValue([
      {
        itemId: 'nc_1',
        intentId: 'ni_1',
        decisionLogId: 'ndl_1',
        userId: 42,
        tenantId: 42,
        sourceSkill: 'finance',
        type: 'reminder',
        priority: 'time_sensitive',
        status: 'unread',
        title: 'Pay $4,200 to Therapy Center',
        body: 'Raw invoice amount should not be serialized',
        safeBody: 'Finance reminder needs review.',
        deeplink: 'nexus://finance/reminder/1',
        actions: [{ id: 'mark_paid', label: 'Mark paid', style: 'primary' }],
        dedupeKey: 'finance:1',
        createdAt: '2026-04-22T10:05:00Z',
        expiresAt: null,
      },
    ] as any);
    const res = makeResponse();

    routes['GET /api/notifications']({ headers: adminScopeHeaders, query: { limit: '12' } }, res);

    expect(getAllNotifications).toHaveBeenCalledWith(12, { userId: 42, tenantId: 42 });
    expect(getAllNotificationCenterItemsForPortal).toHaveBeenCalledWith(12, { userId: 42, tenantId: 42 });
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      count: 2,
      notifications: [{
        id: 7,
        userId: 42,
        type: 'script_ready',
        title: 'Script ready',
        body: 'Review it',
        status: 'unread',
        pushSent: true,
        createdAt: '2026-04-22T10:00:00Z',
      }],
      decisionCenterItems: [{
        itemId: 'nc_1',
        userId: 42,
        tenantId: 42,
        sourceSkill: 'finance',
        type: 'reminder',
        priority: 'time_sensitive',
        status: 'unread',
        title: 'Finance decision',
        body: 'Finance reminder needs review.',
        deeplink: 'nexus://finance/reminder/1',
        actions: [{ id: 'mark_paid', label: 'Mark paid' }],
        createdAt: '2026-04-22T10:05:00Z',
        expiresAt: null,
      }],
    });
    expect(JSON.stringify((res.json as any).mock.calls[0][0])).not.toContain('Therapy Center');
    expect(JSON.stringify((res.json as any).mock.calls[0][0])).not.toContain('$4,200');
  });

  it('maps notification preference summaries for portal operators', () => {
    const { app, routes } = makeApp();
    registerPortalDocumentRoutes(app);
    vi.mocked(getNotificationProfileSummariesForPortal).mockReturnValue([
      {
        userId: 42,
        tenantId: 42,
        pushEnabled: true,
        inAppEnabled: true,
        portalEnabled: true,
        allowTimeSensitive: true,
        digestPassiveItems: true,
        updatedAt: '2026-04-22T12:00:00Z',
      },
    ]);
    const res = makeResponse();

    routes['GET /api/notification-preferences']({ headers: adminScopeHeaders, query: { limit: '8' } }, res);

    expect(getNotificationProfileSummariesForPortal).toHaveBeenCalledWith(8, { userId: 42, tenantId: 42 });
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
        updatedAt: '2026-04-22T12:00:00Z',
      }],
    });
  });

  it('filters Decision Center portal payloads by explicit user and tenant scope', () => {
    const { app, routes } = makeApp();
    registerPortalDocumentRoutes(app);
    const res = makeResponse();

    routes['GET /api/notifications']({
      headers: adminScopeHeaders,
      query: { limit: '10' },
    }, res);

    expect(getAllNotifications).toHaveBeenCalledWith(10, { userId: 42, tenantId: 42 });
    expect(getAllNotificationCenterItemsForPortal).toHaveBeenCalledWith(10, { userId: 42, tenantId: 42 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('rejects notification portal reads with no explicit user and tenant scope', () => {
    const { app, routes } = makeApp();
    registerPortalDocumentRoutes(app);
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

  it('requires an admin portal token for notification portal reads', () => {
    const { app, routes } = makeApp();
    registerPortalDocumentRoutes(app);
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
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'admin portal token required' },
    });
    expect(getAllNotifications).not.toHaveBeenCalled();
    expect(getAllNotificationCenterItemsForPortal).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant notification portal scopes at the route boundary', () => {
    const { app, routes } = makeApp();
    registerPortalDocumentRoutes(app);
    const res = makeResponse();

    routes['GET /api/notification-preferences']({
      headers: {
        authorization: 'Bearer admin-token',
        'x-nexus-user-id': '42',
        'x-nexus-tenant-id': '99',
      },
      query: {},
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'invalid tenant scope' },
    });
    expect(getNotificationProfileSummariesForPortal).not.toHaveBeenCalled();
  });

  it('maps durable reports into the portal-safe admin payload', () => {
    const { app, routes } = makeApp();
    registerPortalDocumentRoutes(app);
    vi.mocked(getAllReports).mockReturnValue([
      {
        id: 9,
        userId: 42,
        type: 'coach_briefing',
        title: 'Coach report',
        summary: 'Ready',
        status: 'unread',
        sourceJob: 'garmin_coach',
        createdAt: '2026-04-22T11:00:00Z',
        documentJson: { hidden: true },
      },
    ] as any);
    const res = makeResponse();

    routes['GET /api/reports']({ query: {} }, res);

    expect(getAllReports).toHaveBeenCalledWith(50);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      count: 1,
      reports: [{
        id: 9,
        userId: 42,
        type: 'coach_briefing',
        title: 'Coach report',
        summary: 'Ready',
        status: 'unread',
        sourceJob: 'garmin_coach',
        createdAt: '2026-04-22T11:00:00Z',
      }],
    });
  });

  it('uses shared safe portal errors when the backing stores fail', () => {
    const { app, routes } = makeApp();
    registerPortalDocumentRoutes(app);
    vi.mocked(getAllReports).mockImplementation(() => {
      throw new Error('raw store failure');
    });
    const res = makeResponse();

    routes['GET /api/reports']({ query: {} }, res);

    expect(sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Portal request failed',
      'Portal: request failed',
    );
  });
});

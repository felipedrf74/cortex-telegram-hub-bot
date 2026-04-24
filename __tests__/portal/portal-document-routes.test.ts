import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPortalDocumentRoutes } from '../../src/portal/document-routes';
import { getAllNotifications } from '../../src/services/content-notification-store';
import { getAllReports } from '../../src/services/report-document-store';
import { sendPortalInternalError } from '../../src/portal/http';

vi.mock('../../src/services/content-notification-store', () => ({
  getAllNotifications: vi.fn(),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getAllReports: vi.fn(),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: vi.fn((res: any) => {
    res.status(500).json({ ok: false, error: 'Portal request failed' });
  }),
}));

type CapturedRoutes = Record<string, (req: any, res: any) => void>;

function makeApp(): { app: Express; routes: CapturedRoutes } {
  const routes: CapturedRoutes = {};
  const app = {
    get: vi.fn((path: string, handler: (req: any, res: any) => void) => {
      routes[`GET ${path}`] = handler;
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

describe('portal document routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers notification and report document routes', () => {
    const { app } = makeApp();

    registerPortalDocumentRoutes(app);

    expect(app.get).toHaveBeenCalledWith('/api/notifications', expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/reports', expect.any(Function));
  });

  it('maps content notifications into the portal-safe admin payload', () => {
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
    const res = makeResponse();

    routes['GET /api/notifications']({ query: { limit: '12' } }, res);

    expect(getAllNotifications).toHaveBeenCalledWith(12);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      count: 1,
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
    });
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

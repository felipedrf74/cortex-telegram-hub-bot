import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetNotifications = vi.fn();
const mockGetUnreadCount = vi.fn();
const mockGetRecentReports = vi.fn();
const mockGetUnreadReportCount = vi.fn();
const mockIsConnected = vi.fn();
const mockGetUnreadEmailsForUser = vi.fn();
const mockReadOutlookEmailForUser = vi.fn();
const mockSearchEmailsForUser = vi.fn();
const mockCountEmailsForUser = vi.fn();
const mockReadGmailEmailForUser = vi.fn();
const mockGetOutlookEvents = vi.fn();
const mockGetGoogleEvents = vi.fn();
const mockResolveTaskProvider = vi.fn();
const mockGetAllPendingTasks = vi.fn();

vi.mock('../../src/services/content-notification-store', () => ({
  getNotifications: (...args: unknown[]) => mockGetNotifications(...args),
  getUnreadCount: (...args: unknown[]) => mockGetUnreadCount(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getRecentReports: (...args: unknown[]) => mockGetRecentReports(...args),
  getUnreadReportCount: (...args: unknown[]) => mockGetUnreadReportCount(...args),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mockIsConnected(...args),
}));

vi.mock('../../src/services/outlook-mail', () => ({
  getUnreadEmailsForUser: (...args: unknown[]) => mockGetUnreadEmailsForUser(...args),
  readEmailForUser: (...args: unknown[]) => mockReadOutlookEmailForUser(...args),
}));

vi.mock('../../src/services/google-gmail', () => ({
  searchEmailsForUser: (...args: unknown[]) => mockSearchEmailsForUser(...args),
  countEmailsForUser: (...args: unknown[]) => mockCountEmailsForUser(...args),
  readEmailForUser: (...args: unknown[]) => mockReadGmailEmailForUser(...args),
}));

vi.mock('../../src/services/outlook-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetOutlookEvents(...args),
}));

vi.mock('../../src/services/google-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetGoogleEvents(...args),
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  resolveTaskProvider: (...args: unknown[]) => mockResolveTaskProvider(...args),
  getTaskProviderForUser: () => ({
    getAllPendingTasks: (...args: unknown[]) => mockGetAllPendingTasks(...args),
  }),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { notificationRoutes } from '../../src/api/routes/notifications';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): MockRes;
  end(): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    end() { return r; },
  };
  return r;
}

function mockReq(method: string, path: string, query: Record<string, any> = {}, userId = 7): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    headers: {},
    userId,
  } as any;
}

async function dispatch(method: string, path: string, query: Record<string, any> = {}, userId = 7): Promise<MockRes> {
  const router = notificationRoutes();
  const req = mockReq(method, path, query, userId);
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

describe('Notification inbox routes', () => {
  beforeEach(() => {
    mockGetNotifications.mockReset();
    mockGetUnreadCount.mockReset();
    mockGetRecentReports.mockReset();
    mockGetUnreadReportCount.mockReset();
    mockIsConnected.mockReset();
    mockGetUnreadEmailsForUser.mockReset();
    mockReadOutlookEmailForUser.mockReset();
    mockSearchEmailsForUser.mockReset();
    mockCountEmailsForUser.mockReset();
    mockReadGmailEmailForUser.mockReset();
    mockGetOutlookEvents.mockReset();
    mockGetGoogleEvents.mockReset();
    mockResolveTaskProvider.mockReset();
    mockGetAllPendingTasks.mockReset();
    clearTenantScopeAnomaliesForTests();

    mockGetNotifications.mockReturnValue([]);
    mockGetUnreadCount.mockReturnValue(0);
    mockGetRecentReports.mockReturnValue([]);
    mockGetUnreadReportCount.mockReturnValue(0);
    mockIsConnected.mockReturnValue(false);
    mockGetUnreadEmailsForUser.mockResolvedValue({ count: 0, emails: [] });
    mockReadOutlookEmailForUser.mockResolvedValue(null);
    mockSearchEmailsForUser.mockResolvedValue([]);
    mockCountEmailsForUser.mockResolvedValue(0);
    mockReadGmailEmailForUser.mockResolvedValue(null);
    mockGetOutlookEvents.mockResolvedValue([]);
    mockGetGoogleEvents.mockResolvedValue([]);
    mockResolveTaskProvider.mockReturnValue('ms_todo');
    mockGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });
  });

  it('returns a unified secretary inbox with urgency ordering and degraded state on partial source failure', async () => {
    const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString();

    mockGetNotifications.mockReturnValue([
      {
        id: 9,
        type: 'script_ready',
        title: 'Script ready',
        body: 'Your weekly package is ready.',
        status: 'unread',
        createdAt: '2026-04-13T11:00:00Z',
        data: {},
      },
    ]);
    mockGetUnreadCount.mockReturnValue(1);
    mockGetRecentReports.mockReturnValue([
      {
        id: 3,
        type: 'morning_briefing',
        title: 'Morning Briefing',
        summary: 'Your day looks calm before 2pm.',
        status: 'unread',
        createdAt: '2026-04-14T06:00:00Z',
        sourceJob: 'scheduler:morning',
      },
    ]);
    mockGetUnreadReportCount.mockReturnValue(1);
    mockIsConnected.mockImplementation((_userId: number, provider: string) => provider === 'outlook');
    mockGetUnreadEmailsForUser.mockResolvedValue({
      count: 2,
      emails: [
        {
          id: 'msg-1',
          subject: 'Investor update needed',
          snippet: 'Can you send the latest numbers?',
          date: '2026-04-14T08:30:00Z',
          isRead: false,
          importance: 'high',
          from: 'board@example.com',
          to: 'felipe@nexushub.me',
        },
      ],
    });
    mockGetOutlookEvents.mockRejectedValue(new Error('calendar unavailable'));
    mockGetAllPendingTasks.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'task-1',
          title: 'Pay IVA',
          body: 'Submit this month before noon.',
          importance: 'high',
          dueDateTime: yesterday,
          listName: 'Admin',
          listId: 'list-1',
        },
      ],
    });

    const res = await dispatch('GET', '/inbox', { limit: '10' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.warningCodes).toContain('OUTLOOK_CALENDAR_UNAVAILABLE');
    expect(res.body.data.totalUnread).toBe(4);
    expect(res.body.data.items[0]).toMatchObject({
      kind: 'task',
      title: 'Pay IVA',
      type: 'task_overdue',
      action: 'open_tasks',
    });
    expect(res.body.data.items.map((item: any) => item.kind)).toEqual(
      expect.arrayContaining(['task', 'email', 'report', 'notification']),
    );
    expect(mockGetUnreadEmailsForUser).toHaveBeenCalledWith(7, expect.any(Number));
  });

  it('surfaces missing mail and calendar integrations honestly when neither provider is connected', async () => {
    mockGetNotifications.mockReturnValue([
      {
        id: 9,
        type: 'script_ready',
        title: 'Script ready',
        body: 'Your weekly package is ready.',
        status: 'unread',
        createdAt: '2026-04-13T11:00:00Z',
        data: {},
      },
    ]);
    mockGetUnreadCount.mockReturnValue(1);
    mockGetRecentReports.mockReturnValue([]);
    mockGetUnreadReportCount.mockReturnValue(0);
    mockGetAllPendingTasks.mockResolvedValue({ success: true, data: [] });

    const res = await dispatch('GET', '/inbox', { limit: '10' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.warningCodes).toEqual(
      expect.arrayContaining(['MAIL_INTEGRATION_MISSING', 'CALENDAR_INTEGRATION_MISSING']),
    );
    expect(res.body.data.warningCodes).not.toEqual(
      expect.arrayContaining(['OUTLOOK_MAIL_UNAVAILABLE', 'GMAIL_UNAVAILABLE', 'OUTLOOK_CALENDAR_UNAVAILABLE', 'GOOGLE_CALENDAR_UNAVAILABLE']),
    );
  });

  it('returns read-only email detail for the unified inbox', async () => {
    mockReadOutlookEmailForUser.mockResolvedValue({
      subject: 'Board notes',
      from: 'board@example.com',
      to: 'felipe@nexushub.me',
      snippet: 'Please review before 5pm.',
      body: 'Please review before 5pm. We need your confirmation.',
      date: '2026-04-14T09:00:00Z',
    });

    const res = await dispatch('GET', '/inbox/email', { provider: 'outlook', id: 'msg-123' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.email).toMatchObject({
      provider: 'outlook',
      id: 'msg-123',
      subject: 'Board notes',
      from: 'board@example.com',
    });
    expect(mockReadOutlookEmailForUser).toHaveBeenCalledWith(7, 'msg-123');
  });

  it('rejects malformed inbox email detail requests', async () => {
    const res = await dispatch('GET', '/inbox/email', { provider: 'slack' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INBOX_EMAIL_REQUEST');
  });

  it('returns unified unread count for the home badge', async () => {
    mockIsConnected.mockImplementation((_userId: number, provider: string) =>
      provider === 'google'
    );
    mockGetUnreadCount.mockReturnValue(2);
    mockGetUnreadReportCount.mockReturnValue(1);
    mockCountEmailsForUser.mockResolvedValue(4);

    const res = await dispatch('GET', '/unread-count');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unreadCount).toBe(7);
    expect(mockCountEmailsForUser).toHaveBeenCalledWith(7, 'in:inbox is:unread newer_than:14d');
  });

  it('keeps unread count honest about missing mail integrations when no provider is connected', async () => {
    mockGetUnreadCount.mockReturnValue(2);
    mockGetUnreadReportCount.mockReturnValue(1);

    const res = await dispatch('GET', '/unread-count');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unreadCount).toBe(3);
    expect(res.body.data.warningCodes).toEqual(
      expect.arrayContaining(['MAIL_INTEGRATION_MISSING', 'CALENDAR_INTEGRATION_MISSING']),
    );
  });

  it('uses the authenticated user for Google Calendar inbox events', async () => {
    mockIsConnected.mockImplementation((_userId: number, provider: string) =>
      provider === 'google'
    );

    await dispatch('GET', '/inbox', { limit: '10' });

    expect(mockGetGoogleEvents).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      7,
    );
  });

  it('fails closed on invalid tenant scope before loading inbox state', async () => {
    const res = await dispatch('GET', '/inbox', { limit: '10' }, 0);

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetNotifications).not.toHaveBeenCalled();
    expect(mockGetRecentReports).not.toHaveBeenCalled();
    expect(mockGetAllPendingTasks).not.toHaveBeenCalled();
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'notifications_route_inbox',
          reason: 'invalid_user_scope',
          userId: 0,
        }),
      ]),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetNotifications = vi.fn();
const mockGetUnreadCount = vi.fn();
const mockGetRecentReports = vi.fn();
const mockGetUnreadReportCount = vi.fn();
const mockCreateNotificationIntent = vi.fn();
const mockBuildSkillNotificationFixtureIntent = vi.fn();
const mockListNotificationCenterItems = vi.fn();
const mockGetOrCreateNotificationProfile = vi.fn();
const mockUpdateNotificationProfile = vi.fn();
const mockRegisterNotificationDeviceToken = vi.fn();
const mockRevokeNotificationDeviceToken = vi.fn();
const mockGetNotificationDecisionLog = vi.fn();
const mockMarkNotificationCenterItemRead = vi.fn();
const mockDismissNotificationCenterItem = vi.fn();
const mockPerformNotificationAction = vi.fn();
const mockIsConnected = vi.fn();
const mockGetUnreadEmailsForUser = vi.fn();
const mockReadOutlookEmailForUser = vi.fn();
const mockSearchEmailsForUser = vi.fn();
const mockCountEmailsForUser = vi.fn();
const mockReadGmailEmailForUser = vi.fn();
const mockGetOutlookEvents = vi.fn();
const mockGetGoogleEvents = vi.fn();
const mockListTasks = vi.fn();

vi.mock('../../src/services/content-notification-store', () => ({
  getNotifications: (...args: unknown[]) => mockGetNotifications(...args),
  getUnreadCount: (...args: unknown[]) => mockGetUnreadCount(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getRecentReports: (...args: unknown[]) => mockGetRecentReports(...args),
  getUnreadReportCount: (...args: unknown[]) => mockGetUnreadReportCount(...args),
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  createNotificationIntent: (...args: unknown[]) => mockCreateNotificationIntent(...args),
  buildSkillNotificationFixtureIntent: (...args: unknown[]) => mockBuildSkillNotificationFixtureIntent(...args),
  listNotificationCenterItems: (...args: unknown[]) => mockListNotificationCenterItems(...args),
  getOrCreateNotificationProfile: (...args: unknown[]) => mockGetOrCreateNotificationProfile(...args),
  updateNotificationProfile: (...args: unknown[]) => mockUpdateNotificationProfile(...args),
  registerNotificationDeviceToken: (...args: unknown[]) => mockRegisterNotificationDeviceToken(...args),
  revokeNotificationDeviceToken: (...args: unknown[]) => mockRevokeNotificationDeviceToken(...args),
  getNotificationDecisionLog: (...args: unknown[]) => mockGetNotificationDecisionLog(...args),
  markNotificationCenterItemRead: (...args: unknown[]) => mockMarkNotificationCenterItemRead(...args),
  dismissNotificationCenterItem: (...args: unknown[]) => mockDismissNotificationCenterItem(...args),
  performNotificationAction: (...args: unknown[]) => mockPerformNotificationAction(...args),
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

vi.mock('../../src/services/task-store/task-service', () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
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
  LOGGER_REDACTION_PATHS: [],
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

function mockRes(onSend?: () => void): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; onSend?.(); return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    end() { onSend?.(); return r; },
  };
  return r;
}

function mockReq(
  method: string,
  path: string,
  query: Record<string, any> = {},
  userId = 7,
  body: Record<string, any> = {},
  headers: Record<string, string> = {},
): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
    userId,
    tenantId: userId,
    deviceId: 'iphone-test',
  } as any;
}

async function dispatch(
  method: string,
  path: string,
  query: Record<string, any> = {},
  userId = 7,
  body: Record<string, any> = {},
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const router = notificationRoutes();
  const req = mockReq(method, path, query, userId, body, headers);
  let resolveResponse!: () => void;
  let rejectResponse!: (err: Error) => void;
  const responseDone = new Promise<void>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const res = mockRes(resolveResponse);

  (router as any).handle(req, res, (err: any) => {
    if (err) {
      rejectResponse(err);
      return;
    }
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    responseDone,
    new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${method} ${path} did not send a response`)), 1_000);
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });

  return res;
}

describe('Notification inbox routes', () => {
  beforeEach(() => {
    delete process.env.UNIFIED_INBOX_SOURCE_TIMEOUT_MS;
    delete process.env.UNIFIED_INBOX_SUMMARY_SOURCE_TIMEOUT_MS;
    delete process.env.INTERNAL_API_SECRET;

    mockGetNotifications.mockReset();
    mockGetUnreadCount.mockReset();
    mockGetRecentReports.mockReset();
    mockGetUnreadReportCount.mockReset();
    mockCreateNotificationIntent.mockReset();
    mockBuildSkillNotificationFixtureIntent.mockReset();
    mockListNotificationCenterItems.mockReset();
    mockGetOrCreateNotificationProfile.mockReset();
    mockUpdateNotificationProfile.mockReset();
    mockRegisterNotificationDeviceToken.mockReset();
    mockRevokeNotificationDeviceToken.mockReset();
    mockGetNotificationDecisionLog.mockReset();
    mockMarkNotificationCenterItemRead.mockReset();
    mockDismissNotificationCenterItem.mockReset();
    mockPerformNotificationAction.mockReset();
    mockIsConnected.mockReset();
    mockGetUnreadEmailsForUser.mockReset();
    mockReadOutlookEmailForUser.mockReset();
    mockSearchEmailsForUser.mockReset();
    mockCountEmailsForUser.mockReset();
    mockReadGmailEmailForUser.mockReset();
    mockGetOutlookEvents.mockReset();
    mockGetGoogleEvents.mockReset();
    mockListTasks.mockReset();
    clearTenantScopeAnomaliesForTests();

    mockGetNotifications.mockReturnValue([]);
    mockGetUnreadCount.mockReturnValue(0);
    mockGetRecentReports.mockReturnValue([]);
    mockGetUnreadReportCount.mockReturnValue(0);
    mockListNotificationCenterItems.mockReturnValue([]);
    mockGetOrCreateNotificationProfile.mockReturnValue({ pushEnabled: true });
    mockUpdateNotificationProfile.mockImplementation((_userId, _tenantId, patch) => ({ ...patch }));
    mockRegisterNotificationDeviceToken.mockReturnValue({
      tokenId: 'dt_test',
      platform: 'ios',
      environment: 'sandbox',
      tokenSuffix: '12345678',
      deviceId: 'device-test',
      lastSeenAt: '2026-05-07T10:00:00.000Z',
    });
    mockRevokeNotificationDeviceToken.mockReturnValue(true);
    mockGetNotificationDecisionLog.mockReturnValue(null);
    mockIsConnected.mockReturnValue(false);
    mockGetUnreadEmailsForUser.mockResolvedValue({ count: 0, emails: [] });
    mockReadOutlookEmailForUser.mockResolvedValue(null);
    mockSearchEmailsForUser.mockResolvedValue([]);
    mockCountEmailsForUser.mockResolvedValue(0);
    mockReadGmailEmailForUser.mockResolvedValue(null);
    mockGetOutlookEvents.mockResolvedValue([]);
    mockGetGoogleEvents.mockResolvedValue([]);
    mockListTasks.mockReturnValue([]);
  });

  it('rejects arbitrary client-created notification intents without internal skill context', async () => {
    const res = await dispatch('POST', '/intents', {}, 7, {
      userId: 999,
      tenantId: 999,
      sourceSkill: 'security',
      type: 'security_account',
      priority: 'critical',
      title: 'Fake security alert',
      body: 'Fake alert',
    });

    expect(res.statusCode).toBe(403);
    expect(mockCreateNotificationIntent).not.toHaveBeenCalled();
  });

  it('creates internal notification intents using authenticated scope, ignoring forged body scope', async () => {
    process.env.INTERNAL_API_SECRET = 'test-internal-secret';
    mockCreateNotificationIntent.mockResolvedValue({
      intent: {
        intentId: 'ni_route',
        sourceSkill: 'finance',
        type: 'reminder',
        priority: 'active',
        dedupeKey: 'finance:route',
        createdAt: '2026-05-07T10:00:00.000Z',
      },
      item: null,
      decisionLog: {
        decisionLogId: 'ndl_route',
        decision: 'blocked_missing_device_token',
        reason: 'no active device token',
        scheduledFor: null,
        sentAt: null,
      },
      deliveryAttempts: [],
      pushPayload: null,
    });

    const res = await dispatch(
      'POST',
      '/intents',
      {},
      7,
      {
        userId: 999,
        tenantId: 999,
        sourceSkill: 'finance',
        type: 'reminder',
        priority: 'active',
        title: 'Finance reminder',
        body: 'Finance reminder due tomorrow.',
      },
      { 'x-internal-secret': 'test-internal-secret' },
    );

    expect(res.statusCode).toBe(200);
    expect(mockCreateNotificationIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      tenantId: 7,
      sourceSkill: 'finance',
    }));
    expect(res.body.data.decisionLog.decision).toBe('blocked_missing_device_token');
  });

  it('returns decision center sections and notification preferences', async () => {
    mockListNotificationCenterItems.mockReturnValue([
      {
        itemId: 'nc_1',
        intentId: 'ni_1',
        decisionLogId: 'ndl_1',
        userId: 7,
        tenantId: 7,
        title: 'Decision needed',
        body: 'Open Nexus for details.',
        safeBody: 'Decision needed.',
        sourceSkill: 'secretary',
        type: 'decision_required',
        priority: 'time_sensitive',
        status: 'unread',
        deeplink: 'nexus://notifications/nc_1',
        actions: [{ id: 'open_detail', label: 'Open' }],
        dedupeKey: 'decision',
        createdAt: '2026-05-07T10:00:00.000Z',
        expiresAt: null,
      },
    ]);
    mockGetOrCreateNotificationProfile.mockReturnValue({
      userId: 7,
      tenantId: 7,
      pushEnabled: true,
      skillPreferences: { secretary: true },
    });

    const center = await dispatch('GET', '/decision-center');
    expect(center.statusCode).toBe(200);
    expect(center.body.data.unreadCount).toBe(1);
    expect(center.body.data.sections.needsDecision).toHaveLength(1);

    const prefs = await dispatch('GET', '/preferences');
    expect(prefs.statusCode).toBe(200);
    expect(prefs.body.data.profile.pushEnabled).toBe(true);
  });

  it('registers, revokes, and actions notification center items through scoped routes', async () => {
    mockPerformNotificationAction.mockReturnValue({
      actionId: 'open_detail',
      idempotent: false,
      item: {
        itemId: 'nc_action',
        intentId: 'ni_action',
        decisionLogId: 'ndl_action',
        userId: 7,
        tenantId: 7,
        title: 'Open me',
        body: 'Open Nexus.',
        safeBody: 'Open Nexus.',
        sourceSkill: 'system',
        type: 'insight',
        priority: 'active',
        status: 'actioned',
        deeplink: 'nexus://notifications/nc_action',
        actions: [{ id: 'open_detail', label: 'Open' }],
        dedupeKey: 'action',
        createdAt: '2026-05-07T10:00:00.000Z',
        expiresAt: null,
      },
    });

    const token = await dispatch('POST', '/device-tokens', {}, 7, {
      token: 'abcdef1234567890',
      deviceId: 'iphone-7',
    });
    expect(token.statusCode).toBe(200);
    expect(mockRegisterNotificationDeviceToken).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      tenantId: 7,
      token: 'abcdef1234567890',
    }));

    const action = await dispatch('POST', '/nc_action/actions', {}, 7, { actionId: 'open_detail' });
    expect(action.statusCode).toBe(200);
    expect(action.body.data.item.status).toBe('actioned');

    const revoke = await dispatch('DELETE', '/device-tokens/dt_test');
    expect(revoke.statusCode).toBe(200);
    expect(revoke.body.data.revoked).toBe(true);
  });

  it('binds legacy /notifications/device-tokens registration to authenticated scope despite body injection', async () => {
    const token = await dispatch('POST', '/device-tokens', {}, 7, {
      token: 'abcdef1234567890',
      userId: 999,
      tenantId: 999,
      deviceId: 'forged-device',
    });

    expect(token.statusCode).toBe(200);
    expect(mockRegisterNotificationDeviceToken).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      tenantId: 7,
      token: 'abcdef1234567890',
    }));
    expect(mockRegisterNotificationDeviceToken).not.toHaveBeenCalledWith(expect.objectContaining({
      userId: 999,
    }));
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
    mockListTasks.mockReturnValue([
      {
        id: 1,
        externalId: 'task-1',
        provider: 'ms_todo',
        title: 'Pay IVA',
        description: 'Submit this month before noon.',
        status: 'pending',
        priority: 3,
        dueDate: yesterday,
        projectName: 'Admin',
        projectId: 11,
      },
    ]);

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
    expect(mockListTasks).toHaveBeenCalledWith(7, { status: 'pending' });
  });

  it('bounds slow inbox sources so a cold Home-to-Inbox load returns degraded data quickly', async () => {
    process.env.UNIFIED_INBOX_SOURCE_TIMEOUT_MS = '5';

    mockIsConnected.mockImplementation((_userId: number, provider: string) =>
      provider === 'google'
    );
    mockGetRecentReports.mockReturnValue([
      {
        id: 44,
        type: 'morning_briefing',
        title: 'Morning Briefing',
        summary: 'Plan is ready.',
        status: 'unread',
        createdAt: '2026-04-14T06:00:00Z',
        sourceJob: 'scheduler:morning',
      },
    ]);
    mockGetUnreadReportCount.mockReturnValue(1);
    mockSearchEmailsForUser.mockImplementation(() => new Promise(() => {}));
    mockGetGoogleEvents.mockResolvedValue([]);

    const startedAt = Date.now();
    const res = await dispatch('GET', '/inbox', { limit: '19' }, 77);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.warningCodes).toContain('GMAIL_UNAVAILABLE');
    expect(res.body.data.items.map((item: any) => item.kind)).toContain('report');
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
    mockListTasks.mockReturnValue([]);

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

  it('bounds slow unread provider counts so the Home badge can still use local counts', async () => {
    process.env.UNIFIED_INBOX_SUMMARY_SOURCE_TIMEOUT_MS = '5';

    mockIsConnected.mockImplementation((_userId: number, provider: string) =>
      provider === 'google'
    );
    mockGetUnreadCount.mockReturnValue(2);
    mockGetUnreadReportCount.mockReturnValue(1);
    mockCountEmailsForUser.mockImplementation(() => new Promise(() => {}));

    const startedAt = Date.now();
    const res = await dispatch('GET', '/unread-count', {}, 78);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unreadCount).toBe(3);
    expect(res.body.data.warningCodes).toContain('GMAIL_UNAVAILABLE');
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
    expect(mockListTasks).not.toHaveBeenCalled();
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

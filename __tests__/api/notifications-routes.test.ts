import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetNotifications = vi.fn();
const mockGetUnreadCount = vi.fn();
const mockGetUnreadCountExcludingNotificationIds = vi.fn();
const mockGetRecentReports = vi.fn();
const mockGetUnreadReportCount = vi.fn();
const mockGetUnreadReportCountExcludingIds = vi.fn();
const mockCreateNotificationIntent = vi.fn();
const mockBuildSkillNotificationFixtureIntent = vi.fn();
const mockCountUnreadNotificationCenterItems = vi.fn();
const mockListNotificationBridgeEntityIds = vi.fn();
const mockListNotificationCenterItems = vi.fn();
const mockGetOrCreateNotificationProfile = vi.fn();
const mockUpdateNotificationProfile = vi.fn();
const mockRegisterNotificationDeviceToken = vi.fn();
const mockRevokeNotificationDeviceToken = vi.fn();
const mockGetNotificationDecisionLog = vi.fn();
const mockGetNotificationReliabilityDashboard = vi.fn();
const mockMarkNotificationCenterItemRead = vi.fn();
const mockDismissNotificationCenterItem = vi.fn();
const mockPerformNotificationAction = vi.fn();
const mockRecordNotificationReliabilityEvent = vi.fn();
const mockGetDecisionItem = vi.fn();
const mockPerformDecisionAction = vi.fn();
const mockIsConnected = vi.fn();
const mockGetUnreadEmailsForUser = vi.fn();
const mockReadOutlookEmailForUser = vi.fn();
const mockSearchEmailsForUser = vi.fn();
const mockCountEmailsForUser = vi.fn();
const mockReadGmailEmailForUser = vi.fn();
const mockGetOutlookEvents = vi.fn();
const mockGetGoogleEvents = vi.fn();
const mockListTasks = vi.fn();
const mockCacheStore = vi.hoisted(() => ({
  clearCacheByPrefix: vi.fn(),
}));

const decisionCenterMockTypes = vi.hoisted(() => {
  class DecisionActionError extends Error {
    code: string;
    status: number;
    details?: Record<string, unknown>;

    constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
      super(message);
      this.name = 'DecisionActionError';
      this.code = code;
      this.status = status;
      this.details = details;
    }
  }

  return { DecisionActionError };
});

vi.mock('../../src/services/content-notification-store', () => ({
  getNotifications: (...args: unknown[]) => mockGetNotifications(...args),
  getUnreadCount: (...args: unknown[]) => mockGetUnreadCount(...args),
  getUnreadCountExcludingNotificationIds: (...args: unknown[]) => mockGetUnreadCountExcludingNotificationIds(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getRecentReports: (...args: unknown[]) => mockGetRecentReports(...args),
  getUnreadReportCount: (...args: unknown[]) => mockGetUnreadReportCount(...args),
  getUnreadReportCountExcludingIds: (...args: unknown[]) => mockGetUnreadReportCountExcludingIds(...args),
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  createNotificationIntent: (...args: unknown[]) => mockCreateNotificationIntent(...args),
  buildSkillNotificationFixtureIntent: (...args: unknown[]) => mockBuildSkillNotificationFixtureIntent(...args),
  countUnreadNotificationCenterItems: (...args: unknown[]) => mockCountUnreadNotificationCenterItems(...args),
  listNotificationBridgeEntityIds: (...args: unknown[]) => mockListNotificationBridgeEntityIds(...args),
  listNotificationCenterItems: (...args: unknown[]) => mockListNotificationCenterItems(...args),
  getOrCreateNotificationProfile: (...args: unknown[]) => mockGetOrCreateNotificationProfile(...args),
  updateNotificationProfile: (...args: unknown[]) => mockUpdateNotificationProfile(...args),
  registerNotificationDeviceToken: (...args: unknown[]) => mockRegisterNotificationDeviceToken(...args),
  revokeNotificationDeviceToken: (...args: unknown[]) => mockRevokeNotificationDeviceToken(...args),
  getNotificationDecisionLog: (...args: unknown[]) => mockGetNotificationDecisionLog(...args),
  getNotificationReliabilityDashboard: (...args: unknown[]) => mockGetNotificationReliabilityDashboard(...args),
  markNotificationCenterItemRead: (...args: unknown[]) => mockMarkNotificationCenterItemRead(...args),
  dismissNotificationCenterItem: (...args: unknown[]) => mockDismissNotificationCenterItem(...args),
  performNotificationAction: (...args: unknown[]) => mockPerformNotificationAction(...args),
  recordNotificationReliabilityEvent: (...args: unknown[]) => mockRecordNotificationReliabilityEvent(...args),
}));

vi.mock('../../src/services/decision-center', () => ({
  DecisionActionError: decisionCenterMockTypes.DecisionActionError,
  getDecisionItem: (...args: unknown[]) => mockGetDecisionItem(...args),
  performDecisionAction: (...args: unknown[]) => mockPerformDecisionAction(...args),
}));

const DecisionActionError = decisionCenterMockTypes.DecisionActionError;

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

vi.mock('../../src/services/cache-store', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cache-store')>('../../src/services/cache-store');
  return {
    ...actual,
    clearCacheByPrefix: (...args: unknown[]) => mockCacheStore.clearCacheByPrefix(...args),
  };
});

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
  tenantId = userId,
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
    tenantId,
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
  tenantId = userId,
): Promise<MockRes> {
  const router = notificationRoutes();
  const req = mockReq(method, path, query, userId, body, headers, tenantId);
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
    mockGetUnreadCountExcludingNotificationIds.mockReset();
    mockGetRecentReports.mockReset();
    mockGetUnreadReportCount.mockReset();
    mockGetUnreadReportCountExcludingIds.mockReset();
    mockCreateNotificationIntent.mockReset();
    mockBuildSkillNotificationFixtureIntent.mockReset();
    mockCountUnreadNotificationCenterItems.mockReset();
    mockListNotificationBridgeEntityIds.mockReset();
    mockListNotificationCenterItems.mockReset();
    mockGetOrCreateNotificationProfile.mockReset();
    mockUpdateNotificationProfile.mockReset();
    mockRegisterNotificationDeviceToken.mockReset();
    mockRevokeNotificationDeviceToken.mockReset();
    mockGetNotificationDecisionLog.mockReset();
    mockGetNotificationReliabilityDashboard.mockReset();
    mockMarkNotificationCenterItemRead.mockReset();
    mockDismissNotificationCenterItem.mockReset();
    mockPerformNotificationAction.mockReset();
    mockRecordNotificationReliabilityEvent.mockReset();
    mockGetDecisionItem.mockReset();
    mockPerformDecisionAction.mockReset();
    mockIsConnected.mockReset();
    mockGetUnreadEmailsForUser.mockReset();
    mockReadOutlookEmailForUser.mockReset();
    mockSearchEmailsForUser.mockReset();
    mockCountEmailsForUser.mockReset();
    mockReadGmailEmailForUser.mockReset();
    mockGetOutlookEvents.mockReset();
    mockGetGoogleEvents.mockReset();
    mockListTasks.mockReset();
    mockCacheStore.clearCacheByPrefix.mockReset();
    clearTenantScopeAnomaliesForTests();

    mockGetNotifications.mockReturnValue([]);
    mockGetUnreadCount.mockReturnValue(0);
    mockGetUnreadCountExcludingNotificationIds.mockImplementation((userId: number) => mockGetUnreadCount(userId));
    mockGetRecentReports.mockReturnValue([]);
    mockGetUnreadReportCount.mockReturnValue(0);
    mockGetUnreadReportCountExcludingIds.mockImplementation((userId: number) => mockGetUnreadReportCount(userId));
    mockCountUnreadNotificationCenterItems.mockReturnValue(0);
    mockListNotificationBridgeEntityIds.mockReturnValue([]);
    mockListNotificationCenterItems.mockReturnValue([]);
    mockGetOrCreateNotificationProfile.mockReturnValue({ pushEnabled: true });
    mockGetNotificationReliabilityDashboard.mockReturnValue({
      badge: { expectedBadgeCount: 0, canonicalUnreadCount: 0, clientReportedBadgeCount: null, drift: null },
      readState: { serverReadFailureCount: 0, clientReportedReadFailureCount: 0 },
      quality: {
        suppressedOrGatedCount: 0,
        unsupportedActionBlockedCount: 0,
        actionFailureCount: 0,
        deadDeeplinkCount: 0,
        genericMutatingActionSuccessCount: 0,
        byTopic: [],
      },
    });
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
    mockGetDecisionItem.mockReturnValue(null);
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

  it('invalidates unified inbox caches after successful internal intent and fixture creation', async () => {
    process.env.INTERNAL_API_SECRET = 'test-internal-secret';
    const item = {
      itemId: 'nc_created',
      intentId: 'ni_created',
      decisionLogId: 'ndl_created',
      userId: 7,
      tenantId: 17,
      title: 'Created',
      body: 'Created body',
      safeBody: 'Created safe body',
      sourceSkill: 'finance',
      type: 'reminder',
      priority: 'active',
      status: 'unread',
      deeplink: 'nexus://notifications/nc_created',
      actions: [{ id: 'open_detail', label: 'Open' }],
      dedupeKey: 'finance:created',
      createdAt: '2026-05-07T10:00:00.000Z',
      expiresAt: null,
    };
    mockCreateNotificationIntent.mockResolvedValue({
      intent: {
        intentId: 'ni_created',
        sourceSkill: 'finance',
        type: 'reminder',
        priority: 'active',
        dedupeKey: 'finance:created',
        createdAt: '2026-05-07T10:00:00.000Z',
      },
      item,
      decisionLog: {
        decisionLogId: 'ndl_created',
        decision: 'send_now',
        reason: 'eligible for immediate delivery',
        scheduledFor: null,
        sentAt: '2026-05-07T10:00:00.000Z',
      },
      deliveryAttempts: [],
      pushPayload: null,
    });
    mockBuildSkillNotificationFixtureIntent.mockReturnValue({
      userId: 7,
      tenantId: 17,
      sourceSkill: 'finance',
      type: 'reminder',
      priority: 'active',
      title: 'Created',
      body: 'Created body',
    });

    await dispatch(
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
        title: 'Created',
        body: 'Created body',
      },
      { 'x-internal-secret': 'test-internal-secret' },
      17,
    );
    await dispatch('POST', '/intents/fixtures/finance', {}, 7, {}, {}, 17);

    expect(mockCacheStore.clearCacheByPrefix).toHaveBeenCalledTimes(2);
    expect(mockCacheStore.clearCacheByPrefix).toHaveBeenCalledWith([
      'unified-inbox:7:tenant:17',
      'unified-inbox-unread:7:tenant:17',
    ]);
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

  it('records scoped notification reliability telemetry and exposes dashboard data', async () => {
    mockGetNotificationReliabilityDashboard.mockReturnValue({
      badge: { expectedBadgeCount: 4, canonicalUnreadCount: 6, clientReportedBadgeCount: 5, drift: 1 },
      readState: { serverReadFailureCount: 0, clientReportedReadFailureCount: 2 },
      quality: {
        suppressedOrGatedCount: 1,
        unsupportedActionBlockedCount: 0,
        actionFailureCount: 0,
        deadDeeplinkCount: 0,
        genericMutatingActionSuccessCount: 0,
        byTopic: [],
      },
    });
    mockCountUnreadNotificationCenterItems.mockReturnValue(4);
    mockGetUnreadCountExcludingNotificationIds.mockReturnValue(2);
    mockGetUnreadReportCountExcludingIds.mockReturnValue(0);

    const recorded = await dispatch('POST', '/reliability-events', {}, 7, {
      eventType: 'badge_reconciled',
      badgeCount: 5,
      source: 'ios_dashboard',
    }, {}, 17);

    expect(recorded.statusCode).toBe(200);
    expect(mockRecordNotificationReliabilityEvent).toHaveBeenCalledWith({
      userId: 7,
      tenantId: 17,
      eventType: 'badge_reconciled',
      badgeCount: 5,
      source: 'ios_dashboard',
      errorCode: null,
    });

    const dashboard = await dispatch('GET', '/reliability-dashboard', {}, 7, {}, {}, 17);
    expect(dashboard.statusCode).toBe(200);
    expect(mockGetNotificationReliabilityDashboard).toHaveBeenCalledWith(7, 17, {
      expectedBadgeCount: 6,
      canonicalUnreadCount: 6,
    });
    expect(dashboard.body.data.dashboard.badge.drift).toBe(1);
  });

  it('rejects unknown notification reliability event types', async () => {
    const res = await dispatch('POST', '/reliability-events', {}, 7, {
      eventType: 'raw_error_blob',
      errorCode: 'too_much',
    });

    expect(res.statusCode).toBe(400);
    expect(mockRecordNotificationReliabilityEvent).not.toHaveBeenCalled();
  });

  it('uses the central center item as the only notification unread-count owner', async () => {
    mockGetNotifications.mockReturnValue([
      {
        id: 9,
        type: 'script_ready',
        title: 'Script ready',
        body: 'Your weekly package is ready.',
        status: 'unread',
        createdAt: '2026-04-13T11:00:00Z',
        data: {
          notificationId: 9,
          taskId: 123,
          rawCount: 7,
        },
      },
    ]);
    mockListNotificationCenterItems.mockReturnValue([
      {
        itemId: 'nc_content',
        intentId: 'ni_content',
        decisionLogId: null,
        userId: 7,
        tenantId: 7,
        title: 'Script ready',
        body: 'Open Nexus.',
        safeBody: 'Content item is ready for review.',
        sensitiveBody: null,
        sourceSkill: 'content',
        type: 'approval_required',
        priority: 'active',
        status: 'unread',
        deeplink: 'nexus://content/script/9',
        actions: [],
        dedupeKey: 'content:script_ready:9',
        createdAt: '2026-05-07T10:00:00.000Z',
        expiresAt: null,
      },
    ]);
    mockCountUnreadNotificationCenterItems.mockReturnValue(1);
    mockGetUnreadCountExcludingNotificationIds.mockReturnValue(3);

    const res = await dispatch('GET', '/', { limit: '20' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unreadCount).toBe(1);
    expect(res.body.data.notifications).toHaveLength(1);
    expect(res.body.data.items).toHaveLength(1);
    expect(mockGetUnreadCountExcludingNotificationIds).not.toHaveBeenCalled();
    expect(mockCountUnreadNotificationCenterItems).toHaveBeenCalledWith(7, 7);
  });

  it('keeps the root notifications list available when the center unread count is degraded', async () => {
    mockGetNotifications.mockReturnValue([
      {
        id: 9,
        type: 'script_ready',
        title: 'Script ready',
        body: 'Your weekly package is ready.',
        status: 'unread',
        createdAt: '2026-04-13T11:00:00Z',
        data: {
          notificationId: 9,
          taskId: 123,
          rawCount: 7,
        },
      },
    ]);
    mockListNotificationCenterItems.mockReturnValue([
      {
        itemId: 'nc_content',
        intentId: 'ni_content',
        decisionLogId: null,
        userId: 7,
        tenantId: 7,
        title: 'Script ready',
        body: 'Open Nexus.',
        safeBody: 'Content item is ready for review.',
        sensitiveBody: null,
        sourceSkill: 'content',
        type: 'approval_required',
        priority: 'active',
        status: 'unread',
        deeplink: 'nexus://content/script/9',
        actions: [],
        dedupeKey: 'content:script_ready:9',
        createdAt: '2026-05-07T10:00:00.000Z',
        expiresAt: null,
      },
    ]);
    mockCountUnreadNotificationCenterItems.mockImplementation(() => {
      throw new Error('center count unavailable');
    });

    const res = await dispatch('GET', '/', { limit: '20' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unreadCount).toBe(0);
    expect(res.body.data.notifications).toHaveLength(1);
    expect(res.body.data.warnings).toEqual([
      expect.objectContaining({ code: 'DECISION_CENTER_UNAVAILABLE' }),
    ]);
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

  it('invalidates unified inbox caches after notification center mutations', async () => {
    const item = {
      itemId: 'nc_action',
      intentId: 'ni_action',
      decisionLogId: 'ndl_action',
      userId: 7,
      tenantId: 17,
      title: 'Open me',
      body: 'Open Nexus.',
      safeBody: 'Open Nexus.',
      sourceSkill: 'system',
      type: 'insight',
      priority: 'active',
      status: 'read',
      deeplink: 'nexus://notifications/nc_action',
      actions: [{ id: 'open_detail', label: 'Open' }],
      dedupeKey: 'action',
      createdAt: '2026-05-07T10:00:00.000Z',
      expiresAt: null,
    };
    mockMarkNotificationCenterItemRead.mockReturnValue(item);
    mockDismissNotificationCenterItem.mockReturnValue({ ...item, status: 'dismissed' });
    mockPerformNotificationAction.mockReturnValue({
      actionId: 'open_detail',
      idempotent: false,
      item: { ...item, status: 'actioned' },
    });

    await dispatch('PATCH', '/nc_action/read', {}, 7, {}, {}, 17);
    await dispatch('PATCH', '/nc_action/dismiss', {}, 7, {}, {}, 17);
    await dispatch('POST', '/nc_action/actions', {}, 7, { actionId: 'open_detail' }, {}, 17);

    expect(mockCacheStore.clearCacheByPrefix).toHaveBeenCalledTimes(3);
    expect(mockCacheStore.clearCacheByPrefix).toHaveBeenCalledWith([
      'unified-inbox:7:tenant:17',
      'unified-inbox-unread:7:tenant:17',
    ]);
  });

  it('forwards decision notification actions through the canonical Decision API path', async () => {
    mockGetDecisionItem.mockReturnValue({
      decisionId: 'nc_decision',
      itemId: 'nc_decision',
      status: 'unread',
    });
    mockPerformDecisionAction.mockResolvedValue({
      actionId: 'approve_script',
      status: 'succeeded',
      idempotent: false,
      item: { decisionId: 'nc_decision', status: 'actioned' },
      verification: { readBackOk: true },
    });

    const action = await dispatch('POST', '/nc_decision/actions', {}, 7, {
      actionId: 'approve_script',
      idempotencyKey: 'tap-decision-1',
      payload: { source: 'notification' },
      channel: 'apns',
    });

    expect(action.statusCode).toBe(200);
    expect(action.body.data.status).toBe('succeeded');
    expect(mockPerformDecisionAction).toHaveBeenCalledWith(
      'nc_decision',
      'approve_script',
      7,
      7,
      {
        idempotencyKey: 'tap-decision-1',
        payload: { source: 'notification' },
        channel: 'apns',
      },
    );
    expect(mockPerformNotificationAction).not.toHaveBeenCalled();
  });

  it('preserves Decision API error semantics on the legacy notification action route', async () => {
    mockGetDecisionItem.mockReturnValue({
      decisionId: 'nc_decision',
      itemId: 'nc_decision',
      status: 'unread',
    });
    mockPerformDecisionAction.mockRejectedValue(new DecisionActionError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Decision actions require an idempotency key',
      400,
    ));

    const action = await dispatch('POST', '/nc_decision/actions', {}, 7, {
      actionId: 'approve_script',
    });

    expect(action.statusCode).toBe(400);
    expect(action.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(mockPerformNotificationAction).not.toHaveBeenCalled();
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
        data: {
          notificationId: 9,
          taskId: 123,
          rawCount: 7,
        },
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
    const taskItem = res.body.data.items.find((item: any) => item.kind === 'task');
    expect(taskItem.metadata).toMatchObject({
      taskId: '1',
      listId: '11',
    });
    const notificationItem = res.body.data.items.find((item: any) => item.id === 'notification:9');
    expect(notificationItem.metadata).toMatchObject({
      notificationId: '9',
      taskId: '123',
      rawCount: 7,
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

  it('uses authenticated tenant scope for inbox and unread Decision Center reads', async () => {
    mockIsConnected.mockReturnValue(false);

    await dispatch('GET', '/inbox', { limit: '5' }, 42, {}, {}, 84);
    expect(mockListNotificationCenterItems).toHaveBeenCalledWith(42, 84, {
      status: 'all',
      limit: 5,
    });
    expect(mockCountUnreadNotificationCenterItems).toHaveBeenCalledWith(42, 84);
    expect(mockListNotificationBridgeEntityIds).toHaveBeenCalledWith(42, 84, 'content');
    expect(mockListNotificationBridgeEntityIds).toHaveBeenCalledWith(42, 84, 'report');

    mockListNotificationCenterItems.mockClear();
    mockCountUnreadNotificationCenterItems.mockClear();
    mockListNotificationBridgeEntityIds.mockClear();
    await dispatch('GET', '/unread-count', {}, 42, {}, {}, 84);
    expect(mockListNotificationCenterItems).not.toHaveBeenCalled();
    expect(mockCountUnreadNotificationCenterItems).toHaveBeenCalledWith(42, 84);
    expect(mockListNotificationBridgeEntityIds).toHaveBeenCalledWith(42, 84, 'content');
    expect(mockListNotificationBridgeEntityIds).toHaveBeenCalledWith(42, 84, 'report');
  });

  it('does not double-count bridged content and report rows in canonical unread counts', async () => {
    mockIsConnected.mockReturnValue(false);
    mockListNotificationCenterItems.mockReturnValue([
      {
        itemId: 'nc_content',
        intentId: 'ni_content',
        decisionLogId: null,
        userId: 7,
        tenantId: 7,
        title: 'Script ready',
        body: 'Open Nexus.',
        safeBody: 'Content item is ready for review.',
        sensitiveBody: null,
        sourceSkill: 'content',
        type: 'approval_required',
        priority: 'active',
        status: 'unread',
        deeplink: 'nexus://content/script/9',
        actions: [],
        dedupeKey: 'content:script_ready:9',
        createdAt: '2026-05-07T10:00:00.000Z',
        expiresAt: null,
      },
      {
        itemId: 'nc_report',
        intentId: 'ni_report',
        decisionLogId: null,
        userId: 7,
        tenantId: 7,
        title: 'Morning Briefing',
        body: 'Open Nexus.',
        safeBody: 'Secretary decision — open Nexus to review the recommendation.',
        sensitiveBody: null,
        sourceSkill: 'secretary',
        type: 'daily_digest',
        priority: 'passive',
        status: 'read',
        deeplink: 'nexus://notifications/report-3',
        actions: [],
        dedupeKey: 'report:morning_briefing:3',
        createdAt: '2026-05-07T09:00:00.000Z',
        expiresAt: null,
      },
    ]);
    mockCountUnreadNotificationCenterItems.mockReturnValue(1);
    mockListNotificationBridgeEntityIds.mockImplementation((_userId: number, _tenantId: number, bridgePrefix: string) =>
      bridgePrefix === 'content' ? [9] : [3]
    );
    mockGetUnreadCountExcludingNotificationIds.mockReturnValue(2);
    mockGetUnreadReportCountExcludingIds.mockReturnValue(1);

    const res = await dispatch('GET', '/unread-count');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unreadCount).toBe(4);
    expect(mockGetUnreadCountExcludingNotificationIds).toHaveBeenCalledWith(7, [9]);
    expect(mockGetUnreadReportCountExcludingIds).toHaveBeenCalledWith(7, [3]);
  });

  it('excludes bridged content and report rows from the unified inbox list', async () => {
    mockIsConnected.mockReturnValue(false);
    mockListNotificationCenterItems.mockReturnValue([
      {
        itemId: 'nc_content',
        intentId: 'ni_content',
        decisionLogId: null,
        userId: 7,
        tenantId: 7,
        title: 'Script ready',
        body: 'Open Nexus.',
        safeBody: 'Content item is ready for review.',
        sensitiveBody: null,
        sourceSkill: 'content',
        type: 'approval_required',
        priority: 'active',
        status: 'unread',
        deeplink: 'nexus://content/script/9',
        actions: [],
        dedupeKey: 'content:script_ready:9',
        createdAt: '2026-05-07T10:00:00.000Z',
        expiresAt: null,
      },
      {
        itemId: 'nc_report',
        intentId: 'ni_report',
        decisionLogId: null,
        userId: 7,
        tenantId: 7,
        title: 'Morning Briefing',
        body: 'Open Nexus.',
        safeBody: 'Secretary decision — open Nexus to review the recommendation.',
        sensitiveBody: null,
        sourceSkill: 'secretary',
        type: 'daily_digest',
        priority: 'passive',
        status: 'read',
        deeplink: 'nexus://notifications/report-3',
        actions: [],
        dedupeKey: 'report:morning_briefing:3',
        createdAt: '2026-05-07T09:00:00.000Z',
        expiresAt: null,
      },
    ]);
    mockListNotificationBridgeEntityIds.mockImplementation((_userId: number, _tenantId: number, bridgePrefix: string) =>
      bridgePrefix === 'content' ? [9] : [3]
    );
    mockGetNotifications.mockReturnValue([
      { id: 9, type: 'script_ready', title: 'Bridged script', body: 'Duplicate', status: 'unread', createdAt: '2026-05-07T10:00:00.000Z', data: {} },
      { id: 10, type: 'script_ready', title: 'Legacy script', body: 'Only legacy', status: 'unread', createdAt: '2026-05-07T09:30:00.000Z', data: {} },
    ]);
    mockGetRecentReports.mockReturnValue([
      { id: 3, type: 'morning_briefing', title: 'Bridged briefing', summary: 'Duplicate', status: 'unread', createdAt: '2026-05-07T09:00:00.000Z', sourceJob: 'scheduler:morning' },
      { id: 4, type: 'morning_briefing', title: 'Legacy briefing', summary: 'Only legacy', status: 'unread', createdAt: '2026-05-07T08:00:00.000Z', sourceJob: 'scheduler:morning' },
    ]);

    const res = await dispatch('GET', '/inbox', { limit: '10' });

    expect(res.statusCode).toBe(200);
    const ids = res.body.data.items.map((item: any) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['decision:nc_content', 'decision:nc_report', 'notification:10', 'report:4']));
    expect(ids).not.toEqual(expect.arrayContaining(['notification:9', 'report:3']));
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

  describe('report schedule preferences', () => {
    function profileWithSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        userId: 7,
        tenantId: 7,
        pushEnabled: true,
        skillPreferences: { secretary: true },
        morningBriefingTime: null,
        coachBriefingTime: null,
        endOfDayTime: null,
        weeklyReviewReportDay: null,
        weeklyReviewReportTime: null,
        ...overrides,
      };
    }

    it('passes the profile object through unchanged next to reportSchedule (old-client decode safety)', async () => {
      const profile = profileWithSchedule({ quietHours: { start: '22:00', end: '07:00' } });
      mockGetOrCreateNotificationProfile.mockReturnValue(profile);

      const res = await dispatch('GET', '/preferences', {}, 7, {}, {}, 17);

      expect(res.statusCode).toBe(200);
      // Backend-only change: reportSchedule is a SIBLING of profile, and the
      // profile payload old iOS clients decode is byte-identical to what the
      // orchestrator returned (additive fields only, nothing moved/renamed).
      expect(res.body.data.profile).toEqual(profile);
      expect(res.body.data.reportSchedule).toBeDefined();
    });

    it('returns null raw fields and global-default effective values for a fresh profile', async () => {
      mockGetOrCreateNotificationProfile.mockReturnValue(profileWithSchedule());

      const res = await dispatch('GET', '/preferences', {}, 7, {}, {}, 17);

      expect(res.statusCode).toBe(200);
      expect(mockGetOrCreateNotificationProfile).toHaveBeenCalledWith(7, 17);
      expect(res.body.data.reportSchedule).toEqual({
        morningBriefingTime: null,
        coachBriefingTime: null,
        endOfDayTime: null,
        weeklyReviewReportDay: null,
        weeklyReviewReportTime: null,
        effective: {
          morningBriefingTime: '06:00', // config.todo.digestTime default
          coachBriefingTime: '21:00', // config.garmin.coachTime default
          endOfDayTime: '21:00',
          weeklyReviewReportDay: 5, // Friday
          weeklyReviewReportTime: '17:00',
        },
      });
    });

    it('passes report schedule overrides through PUT and reflects raw plus effective values on GET', async () => {
      mockUpdateNotificationProfile.mockImplementation((_userId, _tenantId, patch: any) =>
        profileWithSchedule({
          morningBriefingTime: patch.morningBriefingTime ?? null,
          weeklyReviewReportDay: patch.weeklyReviewReportDay ?? null,
        }));

      const put = await dispatch('PUT', '/preferences', {}, 7, {
        morningBriefingTime: '07:15',
        weeklyReviewReportDay: 0,
      }, {}, 17);

      expect(put.statusCode).toBe(200);
      expect(mockUpdateNotificationProfile).toHaveBeenCalledWith(7, 17, expect.objectContaining({
        morningBriefingTime: '07:15',
        weeklyReviewReportDay: 0,
      }));
      expect(put.body.data.reportSchedule).toMatchObject({
        morningBriefingTime: '07:15',
        weeklyReviewReportDay: 0,
        coachBriefingTime: null,
        effective: expect.objectContaining({
          morningBriefingTime: '07:15',
          weeklyReviewReportDay: 0, // Sunday must survive ?? (not be clobbered as falsy)
          coachBriefingTime: '21:00',
        }),
      });

      mockGetOrCreateNotificationProfile.mockReturnValue(profileWithSchedule({
        morningBriefingTime: '07:15',
        weeklyReviewReportDay: 0,
      }));
      const get = await dispatch('GET', '/preferences', {}, 7, {}, {}, 17);
      expect(get.statusCode).toBe(200);
      expect(get.body.data.reportSchedule.morningBriefingTime).toBe('07:15');
      expect(get.body.data.reportSchedule.weeklyReviewReportDay).toBe(0);
      expect(get.body.data.reportSchedule.effective.morningBriefingTime).toBe('07:15');
      expect(get.body.data.reportSchedule.effective.weeklyReviewReportDay).toBe(0);
      expect(get.body.data.reportSchedule.effective.endOfDayTime).toBe('21:00');
    });

    it('clears report schedule overrides back to global defaults on explicit null', async () => {
      mockUpdateNotificationProfile.mockImplementation(() => profileWithSchedule());

      const res = await dispatch('PUT', '/preferences', {}, 7, {
        morningBriefingTime: null,
        coachBriefingTime: null,
        endOfDayTime: null,
        weeklyReviewReportDay: null,
        weeklyReviewReportTime: null,
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateNotificationProfile).toHaveBeenCalledWith(7, 7, expect.objectContaining({
        morningBriefingTime: null,
        coachBriefingTime: null,
        endOfDayTime: null,
        weeklyReviewReportDay: null,
        weeklyReviewReportTime: null,
      }));
      expect(res.body.data.reportSchedule.morningBriefingTime).toBeNull();
      expect(res.body.data.reportSchedule.effective).toEqual({
        morningBriefingTime: '06:00',
        coachBriefingTime: '21:00',
        endOfDayTime: '21:00',
        weeklyReviewReportDay: 5,
        weeklyReviewReportTime: '17:00',
      });
    });

    it('maps report schedule validation failures to the existing 400 preferences error', async () => {
      // The real normalizers live in the orchestrator (covered by
      // notification-orchestrator.test.ts); the route contract is that a
      // thrown normalization error becomes INVALID_NOTIFICATION_PREFERENCES.
      mockUpdateNotificationProfile.mockImplementation(() => {
        throw new Error("invalid schedule time '25:99' — expected HH:MM");
      });
      const badTime = await dispatch('PUT', '/preferences', {}, 7, { endOfDayTime: '25:99' });
      expect(badTime.statusCode).toBe(400);
      expect(badTime.body.error.code).toBe('INVALID_NOTIFICATION_PREFERENCES');

      mockUpdateNotificationProfile.mockImplementation(() => {
        throw new Error("invalid schedule day '9' — expected 0 (Sunday) through 6 (Saturday)");
      });
      const badDay = await dispatch('PUT', '/preferences', {}, 7, { weeklyReviewReportDay: 9 });
      expect(badDay.statusCode).toBe(400);
      expect(badDay.body.error.code).toBe('INVALID_NOTIFICATION_PREFERENCES');
    });

    it('fails closed on invalid tenant scope for both preferences routes', async () => {
      const get = await dispatch('GET', '/preferences', {}, 0);
      expect(get.statusCode).toBe(401);
      expect(get.body.error.code).toBe('UNAUTHORIZED');
      expect(mockGetOrCreateNotificationProfile).not.toHaveBeenCalled();

      const put = await dispatch('PUT', '/preferences', {}, 0, { morningBriefingTime: '07:15' });
      expect(put.statusCode).toBe(401);
      expect(put.body.error.code).toBe('UNAUTHORIZED');
      expect(mockUpdateNotificationProfile).not.toHaveBeenCalled();

      expect(getTenantScopeAnomalies()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'delivery',
            operation: 'notifications_route_get_preferences',
            reason: 'invalid_user_scope',
            userId: 0,
          }),
          expect.objectContaining({
            layer: 'delivery',
            operation: 'notifications_route_update_preferences',
            reason: 'invalid_user_scope',
            userId: 0,
          }),
        ]),
      );
    });
  });
});

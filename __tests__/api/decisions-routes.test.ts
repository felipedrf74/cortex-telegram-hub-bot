import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockGetDecisionSummary = vi.fn();
const mockGetDecisionOverview = vi.fn();
const mockListDecisionItems = vi.fn();
const mockListHandledByNexusItems = vi.fn();
const mockGetDecisionItem = vi.fn();
const mockPerformDecisionAction = vi.fn();
const mockCreateDecisionIntent = vi.fn();
const mockBuildSkillDecisionFixtureIntent = vi.fn();
const mockSnoozeDecision = vi.fn();
const mockDismissDecision = vi.fn();
const mockMarkDecisionViewed = vi.fn();
const mockGetDecisionPreferences = vi.fn();
const mockUpdateDecisionPreferences = vi.fn();
const mockCountOpenUrgentDecisionsForUser = vi.fn();
const mockRegisterNotificationDeviceToken = vi.fn();
const mockRevokeNotificationDeviceToken = vi.fn();

vi.mock('../../src/services/decision-center', () => ({
  DecisionActionError: class DecisionActionError extends Error {
    code: string;
    status: number;
    details?: Record<string, unknown>;
    constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.status = status;
      this.details = details;
    }
  },
  addDecisionDependency: vi.fn(),
  countOpenUrgentDecisionsForUser: (...args: unknown[]) => mockCountOpenUrgentDecisionsForUser(...args),
  findDecisionByRelatedEntity: vi.fn(),
  getDecisionSummary: (...args: unknown[]) => mockGetDecisionSummary(...args),
  getDecisionOverview: (...args: unknown[]) => mockGetDecisionOverview(...args),
  listDecisionItems: (...args: unknown[]) => mockListDecisionItems(...args),
  listHandledByNexusItems: (...args: unknown[]) => mockListHandledByNexusItems(...args),
  listDecisionDependencies: vi.fn(),
  runDecisionSourceStateSupersessionJob: vi.fn(),
  getDecisionItem: (...args: unknown[]) => mockGetDecisionItem(...args),
  performDecisionAction: (...args: unknown[]) => mockPerformDecisionAction(...args),
  createDecisionIntent: (...args: unknown[]) => mockCreateDecisionIntent(...args),
  buildSkillDecisionFixtureIntent: (...args: unknown[]) => mockBuildSkillDecisionFixtureIntent(...args),
  ensureDecisionCenterTables: vi.fn(),
  evaluateDecisionEligibility: vi.fn(),
  snoozeDecision: (...args: unknown[]) => mockSnoozeDecision(...args),
  dismissDecision: (...args: unknown[]) => mockDismissDecision(...args),
  markDecisionViewed: (...args: unknown[]) => mockMarkDecisionViewed(...args),
  getDecisionPreferences: (...args: unknown[]) => mockGetDecisionPreferences(...args),
  updateDecisionPreferences: (...args: unknown[]) => mockUpdateDecisionPreferences(...args),
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  registerNotificationDeviceToken: (...args: unknown[]) => mockRegisterNotificationDeviceToken(...args),
  revokeNotificationDeviceToken: (...args: unknown[]) => mockRevokeNotificationDeviceToken(...args),
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

import { decisionRoutes, deviceTokenRoutes } from '../../src/api/routes/decisions';
import { DecisionActionError } from '../../src/services/decision-center';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

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
  scope: { tenantId?: number } = {},
): Request {
  const tenantId = Object.prototype.hasOwnProperty.call(scope, 'tenantId') ? scope.tenantId : userId;
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
  router: ReturnType<typeof decisionRoutes>,
  method: string,
  path: string,
  query = {},
  body = {},
  headers = {},
  scope: { tenantId?: number } = {},
): Promise<MockRes> {
  const req = mockReq(method, path, query, 7, body, headers, scope);
  let resolveResponse!: () => void;
  let rejectResponse!: (err: Error) => void;
  const responseDone = new Promise<void>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const res = mockRes(resolveResponse);
  (router as any).handle(req, res, (err: any) => {
    if (err) rejectResponse(err);
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

describe('Decision routes', () => {
  beforeEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    delete process.env.INTERNAL_API_SECRET;
    mockGetDecisionSummary.mockReset();
    mockGetDecisionOverview.mockReset();
    mockListDecisionItems.mockReset();
    mockListHandledByNexusItems.mockReset();
    mockGetDecisionItem.mockReset();
    mockPerformDecisionAction.mockReset();
    mockCreateDecisionIntent.mockReset();
    mockBuildSkillDecisionFixtureIntent.mockReset();
    mockSnoozeDecision.mockReset();
    mockDismissDecision.mockReset();
    mockMarkDecisionViewed.mockReset();
    mockGetDecisionPreferences.mockReset();
    mockUpdateDecisionPreferences.mockReset();
    mockRegisterNotificationDeviceToken.mockReset();
    mockRevokeNotificationDeviceToken.mockReset();

    mockGetDecisionSummary.mockReturnValue({ openCount: 1, urgentCount: 0, todayCount: 1, ctaLabel: '1 Decision', previewItems: [], badgeCount: 1 });
    mockGetDecisionOverview.mockReturnValue({
      count: 1,
      openCount: 1,
      handledCount: 1,
      staleCount: 0,
      supersededCount: 0,
      generatedAt: '2026-05-19T10:00:00.000Z',
      summary: { openCount: 1, urgentCount: 0, todayCount: 1, ctaLabel: '1 Decision', previewItems: [], badgeCount: 1 },
      topSuggestion: { decisionId: 'nc_1', title: 'Schedule decision', actionLabel: 'Accept' },
      partial: { items: true, handled: true, summary: true },
      items: [{ decisionId: 'nc_1', status: 'unread' }],
      handled: [{ itemId: 'hbn_1', title: 'Handled sync', sourceSkill: 'secretary' }],
    });
    mockListDecisionItems.mockReturnValue([{ decisionId: 'nc_1', status: 'unread' }]);
    mockListHandledByNexusItems.mockReturnValue([{ itemId: 'hbn_1', title: 'Handled sync', sourceSkill: 'secretary' }]);
    mockGetDecisionItem.mockReturnValue({ decisionId: 'nc_1', status: 'unread' });
    mockPerformDecisionAction.mockResolvedValue({ actionId: 'open_detail', idempotent: false, status: 'succeeded', item: { decisionId: 'nc_1', status: 'read' } });
    mockSnoozeDecision.mockReturnValue({ decisionId: 'nc_1', status: 'snoozed' });
    mockDismissDecision.mockReturnValue({ decisionId: 'nc_1', status: 'dismissed' });
    mockMarkDecisionViewed.mockReturnValue({ decisionId: 'nc_1', status: 'read' });
    mockGetDecisionPreferences.mockReturnValue({ decisionPreferences: { pushEnabled: true } });
    mockUpdateDecisionPreferences.mockReturnValue({ profile: { pushEnabled: true } });
    mockRegisterNotificationDeviceToken.mockReturnValue({ tokenId: 'dt_1', platform: 'ios', environment: 'sandbox', tokenSuffix: '12345678', deviceId: 'iphone-test', lastSeenAt: 'now' });
    mockRevokeNotificationDeviceToken.mockReturnValue(true);
  });

  it('serves summary, list, detail, and actions from authenticated user/tenant scope', async () => {
    const router = decisionRoutes();

    const summary = await dispatch(router, 'GET', '/summary');
    expect(summary.statusCode).toBe(200);
    expect(summary.body.data.ctaLabel).toBe('1 Decision');
    expect(mockGetDecisionSummary).toHaveBeenCalledWith(7, 7, 3);

    const overview = await dispatch(router, 'GET', '/overview', { limit: 20, handledLimit: 4 });
    expect(overview.statusCode).toBe(200);
    expect(overview.body.data.topSuggestion.title).toBe('Schedule decision');
    expect(mockGetDecisionOverview).toHaveBeenCalledWith(7, 7, { limit: 20, handledLimit: 4 });

    const list = await dispatch(router, 'GET', '/', { limit: 10, status: 'all' });
    expect(list.statusCode).toBe(200);
    expect(list.body.data.count).toBe(1);
    expect(mockListDecisionItems).toHaveBeenCalledWith(7, 7, expect.objectContaining({ status: 'all', limit: 10 }));

    mockListDecisionItems.mockClear();
    const activeList = await dispatch(router, 'GET', '/', { limit: 10 });
    expect(activeList.statusCode).toBe(200);
    expect(mockListDecisionItems).toHaveBeenCalledWith(7, 7, expect.objectContaining({ status: undefined, limit: 10 }));

    const detail = await dispatch(router, 'GET', '/nc_1');
    expect(detail.statusCode).toBe(200);
    expect(detail.body.data.item.decisionId).toBe('nc_1');

    const action = await dispatch(router, 'POST', '/nc_1/actions', {}, { actionId: 'open_detail', idempotencyKey: 'tap-1' });
    expect(action.statusCode).toBe(200);
    expect(mockPerformDecisionAction).toHaveBeenCalledWith('nc_1', 'open_detail', 7, 7, expect.objectContaining({ idempotencyKey: 'tap-1' }));

    const handled = await dispatch(router, 'GET', '/handled', { limit: 5 });
    expect(handled.statusCode).toBe(200);
    expect(handled.body.data.items[0].itemId).toBe('hbn_1');
    expect(mockListHandledByNexusItems).toHaveBeenCalledWith(7, 7, 5);
  });

  it('validates overview pagination before calling the service', async () => {
    const router = decisionRoutes();

    const invalidLimit = await dispatch(router, 'GET', '/overview', { limit: 'many' });
    expect(invalidLimit.statusCode).toBe(400);
    expect(invalidLimit.body.error.code).toBe('VALIDATION');
    expect(mockGetDecisionOverview).not.toHaveBeenCalled();

    const partialNumericLimit = await dispatch(router, 'GET', '/overview', { limit: '20abc' });
    expect(partialNumericLimit.statusCode).toBe(400);
    expect(partialNumericLimit.body.error.code).toBe('VALIDATION');
    expect(mockGetDecisionOverview).not.toHaveBeenCalled();

    const invalidHandledLimit = await dispatch(router, 'GET', '/overview', { handledLimit: '-1' });
    expect(invalidHandledLimit.statusCode).toBe(400);
    expect(invalidHandledLimit.body.error.code).toBe('VALIDATION');
    expect(mockGetDecisionOverview).not.toHaveBeenCalled();

    const clamped = await dispatch(router, 'GET', '/overview', { limit: '500', handledLimit: '500' });
    expect(clamped.statusCode).toBe(200);
    expect(mockGetDecisionOverview).toHaveBeenCalledWith(7, 7, { limit: 100, handledLimit: 25 });
  });

  it('rejects decision routes that arrive without authenticated tenant scope', async () => {
    const router = decisionRoutes();

    const response = await dispatch(router, 'GET', '/summary', {}, {}, {}, { tenantId: undefined });

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetDecisionSummary).not.toHaveBeenCalled();
  });

  it('keeps public fixture creation gated in every environment unless internal secret is present', async () => {
    const router = decisionRoutes();
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_API_SECRET = 'secret';

    const rejected = await dispatch(router, 'POST', '/intents/fixtures/secretary');
    expect(rejected.statusCode).toBe(403);

    mockBuildSkillDecisionFixtureIntent.mockReturnValue({ sourceSkill: 'secretary' });
    mockCreateDecisionIntent.mockResolvedValue({ item: { decisionId: 'nc_fixture' }, eligibility: { classification: 'decision' } });
    const accepted = await dispatch(router, 'POST', '/intents/fixtures/secretary', {}, {
      userId: 999,
      tenantId: 999,
    }, { 'x-internal-secret': 'secret' });
    expect(accepted.statusCode).toBe(201);
    expect(mockBuildSkillDecisionFixtureIntent).toHaveBeenCalledWith('secretary', 7, expect.objectContaining({
      userId: 7,
      tenantId: 7,
    }));
  });

  it('exposes /device-tokens aliases without raw token echo', async () => {
    const router = deviceTokenRoutes();
    const registered = await dispatch(router, 'POST', '/', {}, { token: 'abcdef12345678' });
    expect(registered.statusCode).toBe(200);
    expect(registered.body.data.token.tokenSuffix).toBe('12345678');
    expect(JSON.stringify(registered.body)).not.toContain('abcdef12345678');

    const revoked = await dispatch(router, 'DELETE', '/dt_1');
    expect(revoked.statusCode).toBe(200);
    expect(revoked.body.data.revoked).toBe(true);
  });

  it('binds /device-tokens registration to JWT-derived user and tenant even when the body injects scope', async () => {
    const router = deviceTokenRoutes();
    const registered = await dispatch(router, 'POST', '/', {}, {
      token: 'abcdef12345678',
      userId: 999,
      tenantId: 999,
    });

    expect(registered.statusCode).toBe(200);
    expect(mockRegisterNotificationDeviceToken).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      tenantId: 7,
      token: 'abcdef12345678',
    }));
    expect(mockRegisterNotificationDeviceToken).not.toHaveBeenCalledWith(expect.objectContaining({
      userId: 999,
    }));
  });

  it('returns 404 for wrong-user notification action attempts without revealing existence', async () => {
    const router = decisionRoutes();
    mockPerformDecisionAction.mockRejectedValueOnce(new DecisionActionError(
      'DECISION_NOT_FOUND',
      'Decision not found for authenticated user',
      404,
    ));

    const response = await dispatch(router, 'POST', '/user-a-decision/actions', {}, {
      actionId: 'approve_script',
      idempotencyKey: 'wrong-user-notification-tap',
    });

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('DECISION_NOT_FOUND');
    expect(mockPerformDecisionAction).toHaveBeenCalledWith('user-a-decision', 'approve_script', 7, 7, expect.objectContaining({
      idempotencyKey: 'wrong-user-notification-tap',
    }));
  });
});

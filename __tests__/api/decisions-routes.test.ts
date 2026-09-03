import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockGetDecisionSummary = vi.fn();
const mockGetDecisionOverview = vi.fn();
const mockListDecisionItems = vi.fn();
const mockRecordDecisionItemExposures = vi.fn();
const mockRecordDecisionItemExposuresByIds = vi.fn();
const mockDecisionRefreshSupportedForDecision = vi.fn();
const mockListHandledByNexusItems = vi.fn();
const mockGetDecisionItem = vi.fn();
const mockGetDecisionItemForCommand = vi.fn();
const mockEvaluateDecisionApnsActionRequest = vi.fn();
const mockIsDecisionActionAttemptReplay = vi.fn();
const mockPerformDecisionAction = vi.fn();
const mockReviewDecision = vi.fn();
const mockReviseDecisionProposal = vi.fn();
const mockGetDecisionLifecycleEvents = vi.fn();
const mockGetDecisionAuditHistory = vi.fn();
const mockRefreshDecisionItem = vi.fn();
const mockCreateDecisionIntent = vi.fn();
const mockBuildSkillDecisionFixtureIntent = vi.fn();
const mockSnoozeDecision = vi.fn();
const mockDismissDecision = vi.fn();
const mockMarkDecisionViewed = vi.fn();
const mockGetDecisionPreferences = vi.fn();
const mockUpdateDecisionPreferencesViaCommand = vi.fn();
const mockCountOpenUrgentDecisionsForUser = vi.fn();
const mockRegisterNotificationDeviceToken = vi.fn();
const mockRevokeNotificationDeviceToken = vi.fn();
const mockApplyDecisionTypeSuppression = vi.fn();
const mockListDecisionTypeSuppressions = vi.fn();
const mockSuppressDecisionType = vi.fn();
const mockUnsuppressDecisionType = vi.fn();
const mockMaterializeDecisionCenterDailyAttention = vi.fn();
const mockReadDecisionRankSnapshotPage = vi.fn();
const mockCaptureError = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/decision-center', () => ({
  DECISION_RANKING_VERSION: 1,
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
  recordDecisionItemExposures: (...args: unknown[]) => mockRecordDecisionItemExposures(...args),
  recordDecisionItemExposuresByIds: (...args: unknown[]) => mockRecordDecisionItemExposuresByIds(...args),
  decisionRefreshSupportedForDecision: (...args: unknown[]) => mockDecisionRefreshSupportedForDecision(...args),
  listHandledByNexusItems: (...args: unknown[]) => mockListHandledByNexusItems(...args),
  listDecisionDependencies: vi.fn(),
  runDecisionSourceStateSupersessionJob: vi.fn(),
  getDecisionItem: (...args: unknown[]) => mockGetDecisionItem(...args),
  getDecisionItemForCommand: (...args: unknown[]) => mockGetDecisionItemForCommand(...args),
  evaluateDecisionApnsActionRequest: (...args: unknown[]) => mockEvaluateDecisionApnsActionRequest(...args),
  isDecisionActionAttemptReplay: (...args: unknown[]) => mockIsDecisionActionAttemptReplay(...args),
  performDecisionAction: (...args: unknown[]) => mockPerformDecisionAction(...args),
  reviewDecision: (...args: unknown[]) => mockReviewDecision(...args),
  reviseDecisionProposal: (...args: unknown[]) => mockReviseDecisionProposal(...args),
  getDecisionLifecycleEvents: (...args: unknown[]) => mockGetDecisionLifecycleEvents(...args),
  getDecisionAuditHistory: (...args: unknown[]) => mockGetDecisionAuditHistory(...args),
  refreshDecisionItem: (...args: unknown[]) => mockRefreshDecisionItem(...args),
  createDecisionIntent: (...args: unknown[]) => mockCreateDecisionIntent(...args),
  buildSkillDecisionFixtureIntent: (...args: unknown[]) => mockBuildSkillDecisionFixtureIntent(...args),
  ensureDecisionCenterTables: vi.fn(),
  evaluateDecisionEligibility: vi.fn(),
  snoozeDecision: (...args: unknown[]) => mockSnoozeDecision(...args),
  dismissDecision: (...args: unknown[]) => mockDismissDecision(...args),
  markDecisionViewed: (...args: unknown[]) => mockMarkDecisionViewed(...args),
  getDecisionPreferences: (...args: unknown[]) => mockGetDecisionPreferences(...args),
  updateDecisionPreferencesViaCommand: (...args: unknown[]) => mockUpdateDecisionPreferencesViaCommand(...args),
  applyDecisionTypeSuppression: (...args: unknown[]) => mockApplyDecisionTypeSuppression(...args),
  listDecisionTypeSuppressions: (...args: unknown[]) => mockListDecisionTypeSuppressions(...args),
  suppressDecisionType: (...args: unknown[]) => mockSuppressDecisionType(...args),
  unsuppressDecisionType: (...args: unknown[]) => mockUnsuppressDecisionType(...args),
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  registerNotificationDeviceToken: (...args: unknown[]) => mockRegisterNotificationDeviceToken(...args),
  revokeNotificationDeviceToken: (...args: unknown[]) => mockRevokeNotificationDeviceToken(...args),
}));

const mockNotificationCacheInvalidation = vi.hoisted(() => ({
  invalidateNotificationInboxCaches: vi.fn(),
}));

vi.mock('../../src/services/notification-cache-invalidation', () => ({
  invalidateNotificationInboxCaches: (...args: unknown[]) => mockNotificationCacheInvalidation.invalidateNotificationInboxCaches(...args),
}));

vi.mock('../../src/services/decision-center-daily-attention', () => ({
  materializeDecisionCenterDailyAttention: (...args: unknown[]) => mockMaterializeDecisionCenterDailyAttention(...args),
}));

vi.mock('../../src/services/decision-center/rank-snapshot-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/decision-center/rank-snapshot-service')>()),
  readDecisionRankSnapshotPageFromCurrentDatabase: (...args: unknown[]) => mockReadDecisionRankSnapshotPage(...args),
}));

vi.mock('../../src/services/decision-center/command-receipts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/decision-center/command-receipts')>()),
  executeDecisionMutationWithReceipt: (_command: unknown, mutate: () => unknown) => ({
    result: mutate(),
    idempotent: false,
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
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/error-monitor', () => ({
  captureError: (...args: unknown[]) => mockCaptureError(...args),
}));

import { decisionRoutes, deviceTokenRoutes } from '../../src/api/routes/decisions';
import { DecisionActionError } from '../../src/services/decision-center';
import { decodeDecisionCursorToken } from '../../src/services/decision-center/cursor';

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
    delete process.env.DECISION_API_V2_ENABLED;
    mockGetDecisionSummary.mockReset();
    mockGetDecisionOverview.mockReset();
    mockListDecisionItems.mockReset();
    mockRecordDecisionItemExposures.mockReset();
    mockRecordDecisionItemExposuresByIds.mockReset();
    mockDecisionRefreshSupportedForDecision.mockReset();
    mockListHandledByNexusItems.mockReset();
    mockGetDecisionItem.mockReset();
    mockGetDecisionItemForCommand.mockReset();
    mockEvaluateDecisionApnsActionRequest.mockReset();
    mockIsDecisionActionAttemptReplay.mockReset();
    mockPerformDecisionAction.mockReset();
    mockReviewDecision.mockReset();
    mockReviseDecisionProposal.mockReset();
    mockGetDecisionLifecycleEvents.mockReset();
    mockCreateDecisionIntent.mockReset();
    mockBuildSkillDecisionFixtureIntent.mockReset();
    mockSnoozeDecision.mockReset();
    mockDismissDecision.mockReset();
    mockMarkDecisionViewed.mockReset();
    mockGetDecisionPreferences.mockReset();
    mockUpdateDecisionPreferencesViaCommand.mockReset();
    mockRegisterNotificationDeviceToken.mockReset();
    mockRevokeNotificationDeviceToken.mockReset();
    mockApplyDecisionTypeSuppression.mockReset();
    mockListDecisionTypeSuppressions.mockReset();
    mockSuppressDecisionType.mockReset();
    mockUnsuppressDecisionType.mockReset();
    mockMaterializeDecisionCenterDailyAttention.mockReset();
    mockReadDecisionRankSnapshotPage.mockReset();
    mockCaptureError.mockReset();
    mockNotificationCacheInvalidation.invalidateNotificationInboxCaches.mockReset();
    mockDecisionRefreshSupportedForDecision.mockReturnValue(true);
    mockRecordDecisionItemExposuresByIds.mockReturnValue({ recordedCount: 0 });
    mockIsDecisionActionAttemptReplay.mockReturnValue(false);

    // Type-suppression is a presentation post-filter; by default it passes the list through unchanged
    // (flag OFF semantics) so the existing list assertions stay byte-identical.
    mockApplyDecisionTypeSuppression.mockImplementation((items: unknown) => items);
    mockListDecisionTypeSuppressions.mockReturnValue([]);
    mockMaterializeDecisionCenterDailyAttention.mockResolvedValue({
      status: 'skipped',
      reason: 'no_task_attention_needed',
      localDate: '2026-05-19',
      timezone: 'Europe/Lisbon',
      counts: { pending: 0, overdue: 0, dueToday: 0, highPriority: 0 },
      dedupeKey: null,
      decisionId: null,
    });
    mockReadDecisionRankSnapshotPage.mockImplementation((input: { cursorRaw?: string }) => {
      if (input.cursorRaw === undefined) return { kind: 'unavailable' };
      const cursor = decodeDecisionCursorToken(input.cursorRaw);
      return cursor.kind === 'legacy'
        ? { kind: 'legacy', cursor }
        : { kind: 'snapshot', snapshotId: cursor.snapshotId, rankingAsOf: cursor.rankingAsOf, rankingVersion: cursor.rankingVersion, cards: [], nextCursor: null };
    });

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
    mockGetDecisionItem.mockReturnValue({
      decisionId: 'nc_1',
      status: 'unread',
      effectiveStatus: 'needs_action',
      decisionKind: 'action_proposal',
      actionability: 'confirmation_required',
      recordVersion: 4,
      contextVersion: 'ctx-current-4',
      recommendedStartAt: '2026-05-20T10:00:00.000Z',
      recommendedEndAt: '2026-05-20T11:00:00.000Z',
      snoozedUntil: null,
      analysis: {
        whyNow: 'The schedule conflict is today.',
        costOfDelay: 'Waiting will remove the safe option.',
      },
      recommendedAction: { id: 'open_detail', label: 'Review decision', style: 'primary' },
      alternativeActions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
    });
    mockGetDecisionItemForCommand.mockImplementation((...args: unknown[]) => mockGetDecisionItem(...args));
    mockPerformDecisionAction.mockResolvedValue({ actionId: 'open_detail', idempotent: false, status: 'succeeded', item: { decisionId: 'nc_1', status: 'read' } });
    mockReviewDecision.mockReturnValue({ decisionId: 'nc_1', status: 'read', recordVersion: 2, decisionState: 'approved' });
    mockReviseDecisionProposal.mockReturnValue({
      decisionId: 'nc_1',
      status: 'read',
      recordVersion: 2,
      decisionState: 'ready_for_review',
      recommendedStartAt: '2026-05-20T10:00:00.000Z',
      recommendedEndAt: '2026-05-20T11:00:00.000Z',
      snoozedUntil: null,
    });
    mockGetDecisionLifecycleEvents.mockReturnValue([{ event: 'created', createdAt: '2026-05-19T10:00:00.000Z' }]);
    mockGetDecisionAuditHistory.mockReturnValue({
      events: [{ event: 'created', createdAt: '2026-05-19T10:00:00.000Z' }],
      conflicts: [],
      executions: [],
    });
    mockRefreshDecisionItem.mockReturnValue({
      item: { decisionId: 'nc_1', status: 'read', recordVersion: 2 },
      refreshedAt: '2026-05-19T10:05:00.000Z',
    });
    mockSnoozeDecision.mockReturnValue({ decisionId: 'nc_1', status: 'snoozed' });
    mockDismissDecision.mockReturnValue({ decisionId: 'nc_1', status: 'dismissed' });
    mockMarkDecisionViewed.mockReturnValue({ decisionId: 'nc_1', status: 'read' });
    mockGetDecisionPreferences.mockReturnValue({ decisionPreferences: { pushEnabled: true } });
    mockUpdateDecisionPreferencesViaCommand.mockReturnValue({
      preferences: { profile: { pushEnabled: true } },
      idempotent: false,
    });
    mockRegisterNotificationDeviceToken.mockReturnValue({ tokenId: 'dt_1', platform: 'ios', environment: 'sandbox', tokenSuffix: '12345678', deviceId: 'iphone-test', lastSeenAt: 'now' });
    mockRevokeNotificationDeviceToken.mockReturnValue(true);
  });

  it('serves summary, list, detail, and actions from authenticated user/tenant scope', async () => {
    const router = decisionRoutes();

    const summary = await dispatch(router, 'GET', '/summary');
    expect(summary.statusCode).toBe(200);
    expect(summary.body.data.ctaLabel).toBe('1 Decision');
    expect(summary.body.data.schemaVersion).toBeUndefined();
    expect(mockGetDecisionSummary).toHaveBeenCalledWith(7, 7, 3);
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();

    const overview = await dispatch(router, 'GET', '/overview', { limit: 20, handledLimit: 4 });
    expect(overview.statusCode).toBe(200);
    expect(overview.body.data.topSuggestion.title).toBe('Schedule decision');
    expect(overview.body.data.schemaVersion).toBeUndefined();
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();
    expect(mockGetDecisionOverview).toHaveBeenCalledWith(7, 7, { limit: 20, handledLimit: 4 });

    const list = await dispatch(router, 'GET', '/', { limit: 10, status: 'all' });
    expect(list.statusCode).toBe(200);
    expect(list.body.data.count).toBe(1);
    expect(list.body.data.schemaVersion).toBeUndefined();
    expect(mockListDecisionItems).toHaveBeenCalledWith(7, 7, expect.objectContaining({ status: 'all', limit: 10 }));

    mockListDecisionItems.mockClear();
    const activeList = await dispatch(router, 'GET', '/', { limit: 10 });
    expect(activeList.statusCode).toBe(200);
    expect(mockListDecisionItems).toHaveBeenCalledWith(7, 7, expect.objectContaining({ status: undefined, limit: 10 }));
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();

    const detail = await dispatch(router, 'GET', '/nc_1');
    expect(detail.statusCode).toBe(200);
    expect(detail.body.data.item.decisionId).toBe('nc_1');
    expect(detail.body.data.item).toMatchObject({
      recommendedStartAt: '2026-05-20T10:00:00.000Z',
      recommendedEndAt: '2026-05-20T11:00:00.000Z',
      snoozedUntil: null,
    });
    expect(detail.body.data.schemaVersion).toBeUndefined();

    process.env.DECISION_API_V2_ENABLED = 'true';
    const detailV2 = await dispatch(router, 'GET', '/nc_1', {}, {}, { 'x-nexus-api-version': 'v2' });
    expect(detailV2.statusCode).toBe(200);
    expect(detailV2.body.data.schemaVersion).toBe('decision-center.v2');
    expect(detailV2.body.data.item.decisionId).toBe('nc_1');
    expect(detailV2.body.data.item.analysis).toMatchObject({
      whyNow: 'The schedule conflict is today.',
      costOfDelay: 'Waiting will remove the safe option.',
    });
    expect(detailV2.body.data.item.recommendedAction).toMatchObject({ id: 'open_detail', label: 'Review decision' });
    delete process.env.DECISION_API_V2_ENABLED;

    const action = await dispatch(router, 'POST', '/nc_1/actions', {}, { actionId: 'open_detail', idempotencyKey: 'tap-1', channel: 'rest' });
    expect(action.statusCode).toBe(200);
    expect(mockPerformDecisionAction).toHaveBeenCalledWith('nc_1', 'open_detail', 7, 7, expect.objectContaining({
      idempotencyKey: 'tap-1',
      channel: 'rest',
    }));

    const review = await dispatch(router, 'POST', '/nc_1/review', {}, {
      outcome: 'approve', expectedVersion: 1, idempotencyKey: 'review-1', reasonCode: 'user_confirmed',
      replacementChoiceId: 'replace_with_candidate', strongConfirmationText: 'CONFIRM',
    });
    expect(review.statusCode).toBe(200);
    expect(mockReviewDecision).toHaveBeenCalledWith('nc_1', 7, 7, expect.objectContaining({
      outcome: 'approve', expectedVersion: 1, idempotencyKey: 'review-1',
      replacementChoiceId: 'replace_with_candidate', strongConfirmationText: 'CONFIRM',
    }));

    const revised = await dispatch(router, 'PATCH', '/nc_1/proposal', {}, {
      expectedVersion: 1,
      idempotencyKey: 'proposal-edit-1',
      recommendedStartAt: '2026-05-20T10:00:00.000Z',
      recommendedEndAt: '2026-05-20T11:00:00.000Z',
    });
    expect(revised.statusCode).toBe(200);
    expect(revised.body.data.item).toMatchObject({
      recommendedStartAt: '2026-05-20T10:00:00.000Z',
      recommendedEndAt: '2026-05-20T11:00:00.000Z',
      snoozedUntil: null,
    });
    expect(mockReviseDecisionProposal).toHaveBeenCalledWith('nc_1', 7, 7, expect.objectContaining({
      expectedVersion: 1,
      idempotencyKey: 'proposal-edit-1',
    }));

    const history = await dispatch(router, 'GET', '/nc_1/history');
    expect(history.statusCode).toBe(200);
    expect(history.body.data.events).toHaveLength(1);
    expect(mockGetDecisionAuditHistory).toHaveBeenCalledWith('nc_1', 7, 7);

    const handled = await dispatch(router, 'GET', '/handled', { limit: 5 });
    expect(handled.statusCode).toBe(200);
    expect(handled.body.data.items[0].itemId).toBe('hbn_1');
    expect(mockListHandledByNexusItems).toHaveBeenCalledWith(7, 7, 5);
  });

  it('keeps overview and list reads pure when daily task attention is flag-disabled upstream', async () => {
    mockMaterializeDecisionCenterDailyAttention.mockResolvedValue({
      status: 'skipped',
      reason: 'flag_disabled',
      localDate: '2026-05-19',
      timezone: 'Europe/Lisbon',
      counts: { pending: 0, overdue: 0, dueToday: 0, highPriority: 0 },
      dedupeKey: null,
      decisionId: null,
    });
    const router = decisionRoutes();

    const overview = await dispatch(router, 'GET', '/overview');
    const list = await dispatch(router, 'GET', '/');

    expect(overview.statusCode).toBe(200);
    expect(overview.body.data.topSuggestion.title).toBe('Schedule decision');
    expect(list.statusCode).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();
    expect(mockGetDecisionOverview).toHaveBeenCalledWith(7, 7, { limit: 80, handledLimit: 10 });
    expect(mockListDecisionItems).toHaveBeenCalledWith(7, 7, expect.objectContaining({ limit: 80 }));
  });

  it('does not materialize daily attention during repeated Decision Center reads', async () => {
    mockMaterializeDecisionCenterDailyAttention.mockResolvedValue({
      status: 'materialized',
      reason: undefined,
      localDate: '2026-05-19',
      timezone: 'Europe/Lisbon',
      counts: { pending: 3, overdue: 1, dueToday: 1, highPriority: 1 },
      dedupeKey: 'secretary:daily-attention:tasks:7:7:2026-05-19',
      decisionId: 'dc_task_attention',
    });
    const router = decisionRoutes();

    const first = await dispatch(router, 'GET', '/overview');
    const second = await dispatch(router, 'GET', '/overview');
    const list = await dispatch(router, 'GET', '/');

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(list.statusCode).toBe(200);
    expect(first.body.data.items).toHaveLength(1);
    expect(second.body.data.items).toHaveLength(1);
    expect(list.body.data.items).toHaveLength(1);
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();
  });

  it('keeps overview and list reads independent from daily task attention failures', async () => {
    mockMaterializeDecisionCenterDailyAttention.mockRejectedValue(new Error('daily attention unavailable'));
    const router = decisionRoutes();

    const overview = await dispatch(router, 'GET', '/overview');
    const list = await dispatch(router, 'GET', '/');

    expect(overview.statusCode).toBe(200);
    expect(overview.body.data.topSuggestion.title).toBe('Schedule decision');
    expect(list.statusCode).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();
    expect(mockGetDecisionOverview).toHaveBeenCalledWith(7, 7, { limit: 80, handledLimit: 10 });
    expect(mockListDecisionItems).toHaveBeenCalledWith(7, 7, expect.objectContaining({ limit: 80 }));
  });

  it('keeps v2 schema fields opt-in and reads the full cursor universe through the service cap override', async () => {
    const router = decisionRoutes();
    process.env.DECISION_API_V2_ENABLED = 'true';
    mockListDecisionItems.mockReturnValue([
      { decisionId: 'nc_1', status: 'unread', priorityScore: 90, createdAt: '2026-05-19T10:00:00.000Z', alternativeActions: [], analysis: {} },
      { decisionId: 'nc_2', status: 'read', priorityScore: 80, createdAt: '2026-05-19T09:00:00.000Z', alternativeActions: [], analysis: {} },
      { decisionId: 'nc_3', status: 'failed', priorityScore: 70, createdAt: '2026-05-19T08:00:00.000Z', alternativeActions: [], analysis: {} },
    ]);

    const response = await dispatch(router, 'GET', '/', { pageSize: '2' }, {}, { 'x-nexus-api-version': 'v2' });

    expect(response.statusCode, JSON.stringify(mockCaptureError.mock.calls)).toBe(200);
    expect(response.body.data.schemaVersion).toBe('decision-center.v2');
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.nextCursor).toEqual(expect.any(String));
    expect(mockListDecisionItems).toHaveBeenCalledWith(7, 7, expect.objectContaining({
      limit: 50_000,
      maxLimit: 50_000,
      recordExposure: false,
    }));
    expect(mockRecordDecisionItemExposures).not.toHaveBeenCalled();
  });

  it('paginates every fallback card beyond item 500 while rank snapshots are unavailable', async () => {
    const router = decisionRoutes();
    process.env.DECISION_API_V2_ENABLED = 'true';
    mockListDecisionItems.mockReturnValue(Array.from({ length: 525 }, (_, index) => ({
      decisionId: `nc_${String(index).padStart(4, '0')}`,
      status: 'unread',
      priorityScore: 10_000 - index,
      createdAt: new Date(Date.UTC(2026, 4, 19, 10, 0, 0) - index * 1_000).toISOString(),
      alternativeActions: [],
      analysis: {},
    })));

    let cursor: string | undefined;
    const seenIds = new Set<string>();
    do {
      const response = await dispatch(
        router,
        'GET',
        '/',
        { pageSize: '100', ...(cursor ? { cursor } : {}) },
        {},
        { 'x-nexus-api-version': 'v2' },
      );
      expect(response.statusCode).toBe(200);
      for (const item of response.body.data.items) seenIds.add(item.decisionId);
      cursor = response.body.data.nextCursor;
    } while (cursor);

    expect(seenIds.size).toBe(525);
    expect(mockListDecisionItems).toHaveBeenCalledTimes(6);
    expect(mockListDecisionItems).toHaveBeenLastCalledWith(7, 7, expect.objectContaining({
      limit: 50_000,
      maxLimit: 50_000,
      recordExposure: false,
    }));
  });

  it('serves immutable v2 snapshot cards without invoking the live Decision list read', async () => {
    const router = decisionRoutes();
    process.env.DECISION_API_V2_ENABLED = 'true';
    mockListDecisionItems.mockClear();
    mockReadDecisionRankSnapshotPage.mockReturnValue({
      kind: 'snapshot',
      snapshotId: 'dcrs_1',
      rankingAsOf: '2026-05-19T10:00:00.000Z',
      rankingVersion: 1,
      cards: [{ decisionId: 'nc_snapshot', status: 'unread', schemaVersion: 'decision-center.v2' }],
      nextCursor: 'snapshot-cursor',
    });

    const response = await dispatch(router, 'GET', '/', { pageSize: '20' }, {}, { 'x-nexus-api-version': 'v2' });

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({
      snapshotId: 'dcrs_1',
      rankingAsOf: '2026-05-19T10:00:00.000Z',
      rankingVersion: 1,
      nextCursor: 'snapshot-cursor',
      count: 1,
      openCount: 1,
    });
    expect(response.body.data.items).toEqual([
      { decisionId: 'nc_snapshot', status: 'unread', schemaVersion: 'decision-center.v2' },
    ]);
    expect(mockListDecisionItems).not.toHaveBeenCalled();
  });

  it('returns typed errors for malformed and stale v2 cursors instead of restarting page one', async () => {
    const router = decisionRoutes();
    process.env.DECISION_API_V2_ENABLED = 'true';
    mockListDecisionItems.mockReturnValue([
      { decisionId: 'nc_1', status: 'unread', priorityScore: 90, createdAt: '2026-05-19T10:00:00.000Z', alternativeActions: [], analysis: {} },
    ]);

    const malformed = await dispatch(router, 'GET', '/', {
      pageSize: '2',
      cursor: 'not-base64-$$$',
    }, {}, { 'x-nexus-api-version': 'v2' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body.error.code).toBe('DECISION_CURSOR_MALFORMED');

    const staleToken = Buffer.from(JSON.stringify({
      ps: 90,
      ca: '2026-05-19T10:00:00.000Z',
      id: 'nc_1',
      rv: 999,
    })).toString('base64url');
    const stale = await dispatch(router, 'GET', '/', {
      pageSize: '2',
      cursor: staleToken,
    }, {}, { 'x-nexus-api-version': 'v2' });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.code).toBe('DECISION_CURSOR_STALE');
  });

  it('records only explicit authenticated card exposures and validates the bounded ID list', async () => {
    const router = decisionRoutes();
    mockRecordDecisionItemExposuresByIds.mockReturnValue({ recordedCount: 2 });

    const accepted = await dispatch(router, 'POST', '/exposures', {}, {
      decisionIds: ['nc_1', 'nc_2', 'nc_1'],
    }, {}, { tenantId: 17 });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.data).toEqual({ recordedCount: 2 });
    expect(mockRecordDecisionItemExposuresByIds).toHaveBeenCalledWith(
      ['nc_1', 'nc_2', 'nc_1'],
      7,
      17,
    );

    const invalid = await dispatch(router, 'POST', '/exposures', {}, { decisionIds: [] }, {}, { tenantId: 17 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION');

    mockRecordDecisionItemExposuresByIds.mockClear();
    const missingScope = await dispatch(router, 'POST', '/exposures', {}, {
      decisionIds: ['nc_1'],
    }, {}, { tenantId: undefined });
    expect(missingScope.statusCode).toBe(401);
    expect(mockRecordDecisionItemExposuresByIds).not.toHaveBeenCalled();
  });

  it('invalidates notification inbox caches after decision mutations and successful intent creation', async () => {
    const router = decisionRoutes();
    process.env.INTERNAL_API_SECRET = 'secret';
    mockCreateDecisionIntent.mockResolvedValue({ item: { decisionId: 'nc_created' }, eligibility: { classification: 'decision' } });

    await dispatch(router, 'PATCH', '/nc_1/viewed', {}, {}, {}, { tenantId: 17 });
    await dispatch(router, 'PATCH', '/nc_1/snooze', {}, { minutes: 30 }, {}, { tenantId: 17 });
    await dispatch(router, 'PATCH', '/nc_1/dismiss', {}, { reason: 'not_relevant' }, {}, { tenantId: 17 });
    await dispatch(router, 'POST', '/nc_1/actions', {}, { actionId: 'open_detail', idempotencyKey: 'tap-1' }, {}, { tenantId: 17 });
    await dispatch(router, 'POST', '/intents', {}, { sourceSkill: 'secretary' }, { 'x-internal-secret': 'secret' }, { tenantId: 17 });

    expect(mockNotificationCacheInvalidation.invalidateNotificationInboxCaches).toHaveBeenCalledTimes(5);
    expect(mockNotificationCacheInvalidation.invalidateNotificationInboxCaches).toHaveBeenCalledWith(7, 17);
  });

  it('forwards a scoped stable idempotency key for internal Decision proposals', async () => {
    const router = decisionRoutes();
    process.env.INTERNAL_API_SECRET = 'secret';
    mockCreateDecisionIntent.mockResolvedValue({
      item: { decisionId: 'nc_created' },
      eligibility: { classification: 'decision' },
    });

    const response = await dispatch(router, 'POST', '/intents', {}, {
      idempotencyKey: 'producer-proposal-1',
      intentId: 'caller-visible-intent',
      userId: 999,
      tenantId: 999,
      sourceSkill: 'secretary',
      type: 'conflict_detected',
    }, { 'x-internal-secret': 'secret' }, { tenantId: 17 });

    expect(response.statusCode).toBe(201);
    expect(mockCreateDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'producer-proposal-1',
      intentId: 'caller-visible-intent',
      proposalRequestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      userId: 7,
      tenantId: 17,
    }));
  });

  it('rejects malformed proposal idempotency keys before calling the service', async () => {
    const router = decisionRoutes();
    process.env.INTERNAL_API_SECRET = 'secret';

    const response = await dispatch(router, 'POST', '/intents', {}, {
      idempotencyKey: '   ',
      sourceSkill: 'secretary',
    }, { 'x-internal-secret': 'secret' });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(mockCreateDecisionIntent).not.toHaveBeenCalled();
  });

  it('keeps fixture replay fingerprints stable across server-generated defaults', async () => {
    const router = decisionRoutes();
    process.env.INTERNAL_API_SECRET = 'secret';
    mockBuildSkillDecisionFixtureIntent
      .mockReturnValueOnce({
        sourceSkill: 'secretary', userId: 7, tenantId: 7,
        decisionDeadline: '2026-08-31T10:00:00.000Z',
      })
      .mockReturnValueOnce({
        sourceSkill: 'secretary', userId: 7, tenantId: 7,
        decisionDeadline: '2026-08-31T10:00:01.000Z',
      });
    mockCreateDecisionIntent.mockResolvedValue({
      item: { decisionId: 'nc_fixture' },
      eligibility: { classification: 'decision' },
    });

    await dispatch(router, 'POST', '/intents/fixtures/secretary', {}, {
      idempotencyKey: 'fixture-replay-1',
    }, { 'x-internal-secret': 'secret' });
    await dispatch(router, 'POST', '/intents/fixtures/secretary', {}, {
      idempotencyKey: 'fixture-replay-1',
    }, { 'x-internal-secret': 'secret' });

    const first = mockCreateDecisionIntent.mock.calls[0]?.[0] as Record<string, unknown>;
    const second = mockCreateDecisionIntent.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(first.decisionDeadline).not.toBe(second.decisionDeadline);
    expect(first.proposalRequestFingerprint).toBe(second.proposalRequestFingerprint);
  });

  it('binds viewed acknowledgements to an idempotency key and optional record version', async () => {
    const router = decisionRoutes();
    const response = await dispatch(router, 'PATCH', '/nc_1/viewed', {}, {
      idempotencyKey: 'view-journal-1',
      expectedVersion: 4,
    }, {}, { tenantId: 17 });

    expect(response.statusCode).toBe(200);
    expect(mockMarkDecisionViewed).toHaveBeenCalledWith('nc_1', 7, 17, {
      idempotencyKey: 'view-journal-1',
      expectedVersion: 4,
      channel: 'rest',
    });
  });

  it('derives version-bound replay keys for old review and proposal clients', async () => {
    const router = decisionRoutes();

    expect((await dispatch(router, 'POST', '/nc_1/review', {}, {
      outcome: 'reject',
      expectedVersion: 3,
    })).statusCode).toBe(200);
    expect(mockReviewDecision).toHaveBeenCalledWith('nc_1', 7, 7, expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^legacy-rest:review:reject:nc_1:v3:[a-f0-9]{24}$/),
    }));

    expect((await dispatch(router, 'PATCH', '/nc_1/proposal', {}, {
      expectedVersion: 3,
      recommendedStartAt: '2026-05-20T10:00:00.000Z',
      recommendedEndAt: '2026-05-20T11:00:00.000Z',
    })).statusCode).toBe(200);
    expect(mockReviseDecisionProposal).toHaveBeenCalledWith('nc_1', 7, 7, expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^legacy-rest:edit_proposal:nc_1:v3:[a-f0-9]{24}$/),
    }));

    expect((await dispatch(router, 'POST', '/nc_1/actions', {}, {
      actionId: 'open_detail',
      expectedVersion: 3,
    })).statusCode).toBe(200);
    expect(mockPerformDecisionAction).toHaveBeenCalledWith(
      'nc_1',
      'open_detail',
      7,
      7,
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^legacy-rest:open_detail:nc_1:v3:[a-f0-9]{24}$/),
      }),
    );
  });

  it('reconciles an existing APNs ledger attempt before applying fresh-action policy', async () => {
    const router = decisionRoutes();
    mockIsDecisionActionAttemptReplay.mockReturnValueOnce(true);
    mockPerformDecisionAction.mockResolvedValueOnce({
      actionId: 'accept_reflow',
      idempotent: true,
      status: 'idempotent',
      item: { decisionId: 'nc_1', status: 'actioned', recordVersion: 5 },
    });

    const response = await dispatch(router, 'POST', '/nc_1/actions', {}, {
      actionId: 'accept_reflow',
      idempotencyKey: 'apns-outcome-unknown-1',
      expectedVersion: 4,
      contextVersion: 'ctx-current-4',
      channel: 'apns',
    });

    expect(response.statusCode).toBe(200);
    expect(mockEvaluateDecisionApnsActionRequest).not.toHaveBeenCalled();
    expect(mockPerformDecisionAction).toHaveBeenCalledWith(
      'nc_1',
      'accept_reflow',
      7,
      7,
      expect.objectContaining({ idempotencyKey: 'apns-outcome-unknown-1', channel: 'apns' }),
    );
  });

  it('routes snooze through the idempotent command contract and maps refresh errors', async () => {
    const router = decisionRoutes();
    mockPerformDecisionAction.mockResolvedValueOnce({
      actionId: 'snooze',
      idempotent: false,
      status: 'succeeded',
      item: {
        decisionId: 'nc_1',
        status: 'snoozed',
        snoozedUntil: '2026-09-03T11:00:00.000Z',
      },
    });
    const snoozed = await dispatch(router, 'PATCH', '/nc_1/snooze', {}, { minutes: 30, expectedVersion: 4 }, {}, { tenantId: 17 });
    expect(snoozed.body.data.item.snoozedUntil).toBe('2026-09-03T11:00:00.000Z');
    mockGetDecisionItem.mockReturnValueOnce({
      decisionId: 'nc_1',
      status: 'snoozed',
      snoozedUntil: '2026-09-03T11:00:00.000Z',
    });
    const exactReadback = await dispatch(router, 'GET', '/nc_1', {}, {}, {}, { tenantId: 17 });
    expect(exactReadback.body.data.item.snoozedUntil).toBe(snoozed.body.data.item.snoozedUntil);
    expect(mockPerformDecisionAction).toHaveBeenCalledWith('nc_1', 'snooze', 7, 17, {
      idempotencyKey: expect.stringMatching(/^legacy-rest:snooze:nc_1:v4:[a-f0-9]{24}$/),
      expectedVersion: 4,
      contextVersion: undefined,
      channel: 'rest',
      payload: { minutes: 30 },
    });

    mockPerformDecisionAction.mockClear();
    await dispatch(router, 'PATCH', '/nc_1/snooze', {}, {
      deferUntil: '2026-09-07T09:00:00+01:00',
      expectedVersion: 4,
      idempotencyKey: 'journal-snooze-1',
    }, {}, { tenantId: 17 });
    expect(mockPerformDecisionAction).toHaveBeenCalledWith('nc_1', 'snooze', 7, 17, expect.objectContaining({
      idempotencyKey: 'journal-snooze-1',
      payload: { deferUntil: '2026-09-07T09:00:00+01:00' },
    }));

    const invalid = await dispatch(router, 'PATCH', '/nc_1/snooze', {}, { minutes: '30' }, {}, { tenantId: 17 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION');

    process.env.DECISION_REFRESH_ENABLED_USER_7 = 'true';
    mockRefreshDecisionItem.mockImplementationOnce(() => {
      throw new DecisionActionError('DECISION_VERSION_CONFLICT', 'Decision changed.', 409, {
        currentVersion: 5,
        currentItem: { decisionId: 'nc_1', recordVersion: 5 },
      });
    });
    try {
      const response = await dispatch(router, 'POST', '/nc_1/refresh', {}, {}, {}, { tenantId: 17 });
      expect(response.statusCode).toBe(409);
      expect(mockDecisionRefreshSupportedForDecision).toHaveBeenCalledWith('nc_1', 7, 17);
      expect(mockRefreshDecisionItem).toHaveBeenCalledWith('nc_1', 7, 17, {
        idempotencyKey: expect.stringMatching(/^legacy-rest:refresh:nc_1:v4:[a-f0-9]{24}$/),
        expectedVersion: 4,
        contextVersion: 'ctx-current-4',
        channel: 'rest',
      });
      expect(response.body.error).toMatchObject({
        code: 'DECISION_VERSION_CONFLICT',
        details: {
          currentVersion: 5,
          currentItem: { decisionId: 'nc_1', recordVersion: 5 },
        },
      });
    } finally {
      delete process.env.DECISION_REFRESH_ENABLED_USER_7;
    }
  });

  it('maps unexpected decision service failures to a privacy-safe 500', async () => {
    const router = decisionRoutes();
    mockPerformDecisionAction.mockRejectedValueOnce(new Error('database password should not escape'));

    const response = await dispatch(router, 'POST', '/nc_1/actions', {}, {
      actionId: 'open_detail',
      idempotencyKey: 'tap-internal-error',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body.error.code).toBe('INVALID_DECISION_ACTION');
    expect(response.body.error.message).toBe('Decision Center could not complete the request.');
    expect(JSON.stringify(response.body)).not.toContain('password');
  });

  it('validates overview pagination before calling the service', async () => {
    const router = decisionRoutes();

    const invalidLimit = await dispatch(router, 'GET', '/overview', { limit: 'many' });
    expect(invalidLimit.statusCode).toBe(400);
    expect(invalidLimit.body.error.code).toBe('VALIDATION');
    expect(mockGetDecisionOverview).not.toHaveBeenCalled();
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();

    const partialNumericLimit = await dispatch(router, 'GET', '/overview', { limit: '20abc' });
    expect(partialNumericLimit.statusCode).toBe(400);
    expect(partialNumericLimit.body.error.code).toBe('VALIDATION');
    expect(mockGetDecisionOverview).not.toHaveBeenCalled();
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();

    const invalidHandledLimit = await dispatch(router, 'GET', '/overview', { handledLimit: '-1' });
    expect(invalidHandledLimit.statusCode).toBe(400);
    expect(invalidHandledLimit.body.error.code).toBe('VALIDATION');
    expect(mockGetDecisionOverview).not.toHaveBeenCalled();
    expect(mockMaterializeDecisionCenterDailyAttention).not.toHaveBeenCalled();

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

    mockBuildSkillDecisionFixtureIntent.mockReturnValue({ sourceSkill: 'secretary', userId: 7, tenantId: 7 });
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
    expect(mockCreateDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^legacy-rest:create_fixture_intent:secretary:/),
      proposalRequestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
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
      deviceId: 'forged-device',
    });

    expect(registered.statusCode).toBe(200);
    expect(mockRegisterNotificationDeviceToken).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      tenantId: 7,
      token: 'abcdef12345678',
      deviceId: 'iphone-test',
    }));
    expect(mockRegisterNotificationDeviceToken).not.toHaveBeenCalledWith(expect.objectContaining({
      userId: 999,
    }));
    expect(mockRegisterNotificationDeviceToken).not.toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'forged-device',
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

  it.each([
    {
      code: 'TRAINING_OPERATION_LOCKED',
      message: 'Another training operation is in progress. Please try again shortly.',
      status: 409,
      retryAfterSeconds: 30,
    },
    {
      code: 'TRAINING_OPERATION_LOCK_UNAVAILABLE',
      message: 'Training operations are temporarily unavailable. Please try again shortly.',
      status: 503,
      retryAfterSeconds: 5,
    },
  ])('preserves the retry contract for Decision-backed Training activation: $code', async ({
    code,
    message,
    status,
    retryAfterSeconds,
  }) => {
    const router = decisionRoutes();
    mockPerformDecisionAction.mockRejectedValueOnce(new DecisionActionError(
      code,
      message,
      status,
      { operation: 'plan_activate', retryAfterSeconds },
    ));

    const response = await dispatch(router, 'POST', '/training-activation/actions', {}, {
      actionId: 'activate_training_plan_revision',
      idempotencyKey: `f35-${code.toLowerCase()}`,
    });

    expect(response.statusCode).toBe(status);
    expect(response.headers['Retry-After']).toBe(String(retryAfterSeconds));
    expect(response.body.error).toMatchObject({ code, message });
    // Pin an allowlist, not just the absence of today's known lock key, so
    // scope-bearing fields added later cannot silently cross the HTTP seam.
    expect(response.body.error.details).toEqual({
      operation: 'plan_activate',
      retryAfterSeconds,
    });
  });

  it('C3: lists, creates (dont_show_type + snooze_type), and removes type suppressions from authenticated scope', async () => {
    const router = decisionRoutes();
    mockListDecisionTypeSuppressions.mockReturnValue([
      { sourceSkill: 'cooking', type: 'decision_required', mode: 'dont_show_type', until: null, createdAt: '2026-05-20T10:00:00.000Z' },
    ]);

    const listed = await dispatch(router, 'GET', '/preferences/suppressions');
    expect(listed.statusCode).toBe(200);
    expect(listed.body.data.suppressions[0].sourceSkill).toBe('cooking');
    expect(mockListDecisionTypeSuppressions).toHaveBeenCalledWith(7, 7);

    const dontShow = await dispatch(router, 'POST', '/preferences/suppress-type', {}, { sourceSkill: 'cooking', type: 'decision_required', mode: 'dont_show_type' });
    expect(dontShow.statusCode).toBe(201);
    // dont_show_type never carries an `until`.
    expect(mockSuppressDecisionType).toHaveBeenCalledWith(7, 7, 'cooking', 'decision_required', 'dont_show_type', null, null);

    const snooze = await dispatch(router, 'POST', '/preferences/suppress-type', {}, { sourceSkill: 'training', type: 'reminder', mode: 'snooze_type', untilDays: 3 });
    expect(snooze.statusCode).toBe(201);
    // snooze_type computes a forward `until` ISO timestamp from untilDays.
    expect(mockSuppressDecisionType).toHaveBeenLastCalledWith(7, 7, 'training', 'reminder', 'snooze_type', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), null);

    const recipe = await dispatch(router, 'POST', '/preferences/suppress-type', {}, {
      sourceSkill: 'cooking',
      type: 'decision_required',
      mode: 'dont_show_type',
      recipe: 'cooking:meal_plan:abc',
    });
    expect(recipe.statusCode).toBe(201);
    expect(mockSuppressDecisionType).toHaveBeenLastCalledWith(7, 7, 'cooking', 'decision_required', 'dont_show_type', null, 'cooking:meal_plan:abc');

    const removed = await dispatch(router, 'DELETE', '/preferences/suppress-type', { sourceSkill: 'cooking', type: 'decision_required', recipe: 'cooking:meal_plan:abc' });
    expect(removed.statusCode).toBe(200);
    expect(mockUnsuppressDecisionType).toHaveBeenCalledWith(7, 7, 'cooking', 'decision_required', 'cooking:meal_plan:abc');
  });

  it('C3: rejects suppress/unsuppress requests with missing fields before touching the store', async () => {
    const router = decisionRoutes();

    const badMode = await dispatch(router, 'POST', '/preferences/suppress-type', {}, { sourceSkill: 'cooking', type: 'decision_required', mode: 'nope' });
    expect(badMode.statusCode).toBe(400);
    expect(badMode.body.error.code).toBe('VALIDATION');

    const missingType = await dispatch(router, 'POST', '/preferences/suppress-type', {}, { sourceSkill: 'cooking', mode: 'dont_show_type' });
    expect(missingType.statusCode).toBe(400);

    // snooze_type with a non-positive untilDays is rejected by positiveIntQuery before any store write.
    const badSnoozeWindow = await dispatch(router, 'POST', '/preferences/suppress-type', {}, { sourceSkill: 'training', type: 'reminder', mode: 'snooze_type', untilDays: -1 });
    expect(badSnoozeWindow.statusCode).toBe(400);

    const missingDeleteParams = await dispatch(router, 'DELETE', '/preferences/suppress-type', {});
    expect(missingDeleteParams.statusCode).toBe(400);

    expect(mockSuppressDecisionType).not.toHaveBeenCalled();
    expect(mockUnsuppressDecisionType).not.toHaveBeenCalled();
  });

  it('C3: maps a service DecisionActionError from suppress/unsuppress to its 4xx status (not a 500)', async () => {
    const router = decisionRoutes();

    mockSuppressDecisionType.mockImplementation(() => { throw new DecisionActionError('VALIDATION', 'bad until', 422); });
    const suppressRes = await dispatch(router, 'POST', '/preferences/suppress-type', {}, { sourceSkill: 'cooking', type: 'decision_required', mode: 'dont_show_type' });
    expect(suppressRes.statusCode).toBe(422); // mapped by decisionError, NOT asyncHandler's 500
    expect(suppressRes.body.error.code).toBe('VALIDATION');

    mockUnsuppressDecisionType.mockImplementation(() => { throw new DecisionActionError('INVALID_SCOPE', 'nope', 403); });
    const deleteRes = await dispatch(router, 'DELETE', '/preferences/suppress-type', { sourceSkill: 'cooking', type: 'decision_required' });
    expect(deleteRes.statusCode).toBe(403);
    expect(deleteRes.body.error.code).toBe('INVALID_SCOPE');
  });
});

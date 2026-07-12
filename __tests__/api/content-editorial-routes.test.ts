import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

let testDb: Database.Database;
const mockInvalidateContentDerivedCaches = vi.hoisted(() => vi.fn());
const mockLoadLiveCalendarBusyWindows = vi.hoisted(() => vi.fn());
const MIGRATION_083 = path.resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql');
const MIGRATION_098 = path.resolve(__dirname, '../../migrations/098_secretary_decision_explanation.sql');

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateContentDerivedCaches: (...args: unknown[]) => mockInvalidateContentDerivedCaches(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/secretary-live-calendar-busy', () => ({
  loadLiveCalendarBusyWindowsForSecretaryIntent: (...args: unknown[]) => mockLoadLiveCalendarBusyWindows(...args),
}));

import { registerContentEditorialRoutes } from '../../src/api/routes/content-editorial-routes';
import {
  createContentWorkflowObject,
  getContentWorkflowObject,
  listContentApprovalRecords,
} from '../../src/services/content-editorial-workflow';
import {
  listSecretaryAgendaItems,
} from '../../src/services/secretary-scheduling-arbitrator';
import type { ContentRegisteredReference } from '../../src/services/content-reference-provenance';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(
  method: string,
  path: string,
  userId: number | undefined = 501,
  tenantId = 101,
  body: Record<string, unknown> = {},
): Request {
  return {
    userId,
    tenantId,
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    body,
    headers: {},
    header: () => undefined,
  } as any;
}

function makeEnsureValidScope() {
  return vi.fn((
    res: Response,
    userId: number | undefined,
  ): userId is number => {
    if (typeof userId === 'number' && userId > 0) return true;
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid authenticated user scope' } });
    return false;
  });
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = 501,
  tenantId = 101,
  ensureValidScope = makeEnsureValidScope(),
): Promise<{ response: MockRes; ensureValidScope: ReturnType<typeof makeEnsureValidScope> }> {
  const router = Router();
  registerContentEditorialRoutes(router, ensureValidScope);
  const req = mockReq(method, path, userId, tenantId, body);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });

  return { response: res, ensureValidScope };
}

function createDraft(overrides: Partial<Parameters<typeof createContentWorkflowObject>[0]> = {}) {
  return createContentWorkflowObject({
    userId: 501,
    tenantId: 101,
    objectType: 'script',
    title: 'Founder operating system script',
    editorialState: 'drafted',
    metadata: { contentGoal: 'teach one workflow' },
    ...overrides,
  });
}

function reference(overrides: Partial<ContentRegisteredReference> = {}): ContentRegisteredReference {
  return {
    id: 1,
    referenceId: 'link:1',
    tenantId: 101,
    ownerUserId: 501,
    visibilityScope: 'user_private',
    referenceType: 'link',
    sourceTable: 'content_reference_links',
    sourcePk: '1',
    sourceIdentifier: 'https://example.test/source',
    title: 'Grounded source',
    url: 'https://example.test/source',
    authorSource: 'Example',
    extractionStatus: 'ready',
    freshnessScore: 0.9,
    trustLevel: 'verified',
    qualityScore: 0.9,
    confidenceScore: 0.9,
    topicTags: ['workflow'],
    relatedOutputIds: [],
    lastUsedAt: null,
    brokenStatus: 'ok',
    staleStatus: 'fresh',
    sourceSummary: 'Supports the core claim.',
    sourceSnippets: ['Evidence snippet'],
    usableForGeneration: true,
    reviewRequired: false,
    rejectionReasons: [],
    ...overrides,
  };
}

describe('content editorial mutation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadLiveCalendarBusyWindows.mockResolvedValue({
      windows: [],
      degraded: false,
      warningCodes: [],
      warnings: [],
    });
    testDb = new Database(':memory:');
    testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
    testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
    testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  });

  afterEach(() => {
    testDb?.close();
  });

  it('reviews sources, records provenance, and moves a draft into reviewed state', async () => {
    const draft = createDraft();

    const { response } = await dispatch('POST', `/workflow/${draft.id}/source-review`, {
      decision: 'approved',
      references: [reference()],
      claims: [{ id: 'claim_1', text: 'Nexus improves creator workflow.', supportedBy: ['link:1'] }],
      sourceSummaries: ['Grounded source summary'],
    });

    const updated = getContentWorkflowObject(501, draft.id, 101);
    const provenance = response.body.data.provenance;

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.sourceReview.status).toBe('reviewed');
    expect(provenance).toMatchObject({
      outputObjectType: 'script',
      outputId: String(draft.id),
      groundingStatus: 'grounded',
      reviewRequired: false,
    });
    expect(updated?.editorialState).toBe('reviewed');
    expect(updated?.reviewRequired).toBe(false);
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledWith(501);
  });

  it('rejects source review attempts that submit references outside the active tenant scope', async () => {
    const draft = createDraft();

    const { response } = await dispatch('POST', `/workflow/${draft.id}/source-review`, {
      decision: 'approved',
      references: [reference({ tenantId: 202, ownerUserId: 999, referenceId: 'link:tenant-b' })],
      claims: [{ id: 'claim_1', text: 'Do not allow tenant B source.', supportedBy: ['link:tenant-b'] }],
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.details.reasonCodes).toContain('unauthorized_reference_for_source_review');
  });

  it('surfaces publish approval as an explicit mutation gate and can approve that gate', async () => {
    const draft = createDraft();
    await dispatch('POST', `/workflow/${draft.id}/actions`, { action: 'approve_draft' });

    const blocked = await dispatch('POST', `/workflow/${draft.id}/actions`, { action: 'mark_published' });
    expect(blocked.response.statusCode).toBe(202);
    expect(blocked.response.body.data.workflow.status).toBe('approval_required');
    expect(blocked.response.body.data.workflow.reasonCodes).toContain('publish_requires_human_approval');

    const approved = await dispatch('POST', `/workflow/${draft.id}/approval`, {
      decision: 'approved',
      approvalType: 'publish',
    });

    expect(approved.response.statusCode).toBe(200);
    expect(approved.response.body.data.approval.status).toBe('approved');
    expect(listContentApprovalRecords({ userId: 501, tenantId: 101, objectType: 'script', objectId: draft.id }))
      .toEqual([expect.objectContaining({ approval_type: 'publish', approval_state: 'approved', approved_by: 501 })]);
  });

  it('creates a repurposed target object with tenant-scoped reuse lineage', async () => {
    const source = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      objectType: 'script',
      title: 'Long-form launch script',
      editorialState: 'approved',
      metadata: { platformId: 'youtube_long_form' },
    });

    const { response } = await dispatch('POST', `/workflow/${source.id}/repurpose`, {
      title: 'Launch script as a short',
      targetObjectType: 'script',
      transformationType: 'youtube_to_shorts',
      fromPlatformId: 'youtube_long_form',
      toPlatformId: 'youtube_shorts',
      referencesPreserved: ['link:1'],
      referencesChanged: ['link:2'],
      noveltyScore: 0.74,
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.data.sourceObject).toMatchObject({ id: source.id, editorialState: 'repurposed' });
    expect(response.body.data.reusedObject).toMatchObject({
      title: 'Launch script as a short',
      objectType: 'script',
      editorialState: 'drafted',
    });
    expect(response.body.data.reuseRecord).toMatchObject({
      tenantId: 101,
      ownerUserId: 501,
      originalContentId: String(source.id),
      reusedContentId: String(response.body.data.reusedObject.id),
      transformationType: 'youtube_to_shorts',
      fromPlatformId: 'youtube_long_form',
      toPlatformId: 'youtube_shorts',
    });
  });

  it('schedules approved Content through Secretary from the live editorial action route', async () => {
    const item = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      objectType: 'content_calendar_item',
      title: 'Write launch post',
      editorialState: 'approved',
    });

    const { response } = await dispatch('POST', `/workflow/${item.id}/actions`, {
      action: 'schedule_content',
      durationMinutes: 75,
      preferredWindows: [
        { start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T12:00:00.000Z', label: 'deep work' },
      ],
      priority: 'high',
      reason: 'Schedule approved editorial production block.',
    });
    const updated = getContentWorkflowObject(501, item.id, 101);
    const agendaItems = listSecretaryAgendaItems({ ownerUserId: 501, tenantId: 101 });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.workflow.status).toBe('scheduled');
    expect(response.body.data.scheduling).toMatchObject({
      status: 'scheduled',
      selectedSlot: {
        start: '2026-05-01T10:00:00.000Z',
        end: '2026-05-01T11:15:00.000Z',
        label: 'deep work',
      },
      feedback: {
        sourceSkill: 'content',
        status: 'scheduled',
        shouldRefreshSource: false,
      },
    });
    expect(response.body.data.agendaItem).toMatchObject({
      sourceSkill: 'content',
      sourceIntentId: `content:${item.id}:schedule`,
      sourceEntityId: String(item.id),
      lifecycleState: 'scheduled',
      decisionAction: 'scheduled',
    });
    expect(updated).toMatchObject({
      editorialState: 'scheduled',
      secretaryIntentId: `content:${item.id}:schedule`,
      secretaryAgendaItemId: response.body.data.agendaItem.agendaItemId,
    });
    expect(agendaItems).toHaveLength(1);
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledWith(501);
  });

  it('rejects live Content scheduling actions from invalid editorial states', async () => {
    const draft = createDraft();

    const { response } = await dispatch('POST', `/workflow/${draft.id}/actions`, {
      action: 'schedule_content',
      durationMinutes: 60,
      preferredWindows: [
        { start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T12:00:00.000Z', label: 'draft window' },
      ],
    });

    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(response.body.error.details).toMatchObject({
      fromState: 'drafted',
      toState: 'scheduled',
      reasonCodes: ['invalid_lifecycle_transition'],
    });
    expect(listSecretaryAgendaItems({ ownerUserId: 501, tenantId: 101 })).toEqual([]);
  });

  it('fails closed when live Content scheduling cannot verify connected calendar availability', async () => {
    const item = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      objectType: 'content_calendar_item',
      title: 'Write launch post',
      editorialState: 'approved',
    });
    mockLoadLiveCalendarBusyWindows.mockResolvedValueOnce({
      windows: [],
      degraded: true,
      providerConfigured: true,
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      warnings: ['Google Calendar is unavailable right now.'],
    });

    const { response } = await dispatch('POST', `/workflow/${item.id}/actions`, {
      action: 'schedule_content',
      durationMinutes: 75,
      preferredWindows: [
        { start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T12:00:00.000Z', label: 'deep work' },
      ],
      priority: 'high',
    });

    expect(response.statusCode).toBe(503);
    expect(response.body.error.code).toBe('CONTENT_SECRETARY_CALENDAR_UNAVAILABLE');
    expect(response.body.error.details.warningCodes).toEqual(['GOOGLE_CALENDAR_UNAVAILABLE']);
    expect(getContentWorkflowObject(501, item.id, 101)).toMatchObject({
      editorialState: 'approved',
      secretaryAgendaItemId: null,
    });
    expect(listSecretaryAgendaItems({ ownerUserId: 501, tenantId: 101 })).toEqual([]);
  });

  it('reflows Content scheduling when Secretary detects a new hard conflict', async () => {
    const item = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      objectType: 'content_calendar_item',
      title: 'Edit sponsor segment',
      editorialState: 'approved',
    });

    const first = await dispatch('POST', `/workflow/${item.id}/actions`, {
      action: 'schedule_content',
      durationMinutes: 60,
      preferredWindows: [
        { start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T12:00:00.000Z', label: 'content window' },
      ],
    });
    const second = await dispatch('POST', `/workflow/${item.id}/actions`, {
      action: 'schedule_content',
      durationMinutes: 60,
      preferredWindows: [
        { start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T12:00:00.000Z', label: 'content window' },
      ],
      unavailableWindows: [
        { start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T11:00:00.000Z', label: 'new meeting' },
      ],
    });
    const allContentAgenda = listSecretaryAgendaItems({
      ownerUserId: 501,
      tenantId: 101,
      includeInactive: true,
    }).filter((agendaItem) => agendaItem.sourceSkill === 'content');

    expect(first.response.body.data.scheduling.status).toBe('scheduled');
    expect(second.response.statusCode).toBe(200);
    expect(second.response.body.data.scheduling.status).toBe('reflowed');
    expect(second.response.body.data.scheduling.selectedSlot).toEqual({
      start: '2026-05-01T11:00:00.000Z',
      end: '2026-05-01T12:00:00.000Z',
      label: 'content window',
    });
    expect(second.response.body.data.scheduling.reasonCodes).toContain('reflowed_to_available_window');
    expect(second.response.body.data.feedback.shouldRefreshSource).toBe(true);
    expect(allContentAgenda.map((agendaItem) => agendaItem.lifecycleState)).toEqual(['superseded', 'reflowed']);
  });

  it('keeps tenant-shared Content scheduling behind an approval gate before Secretary placement', async () => {
    const item = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      visibilityScope: 'tenant_shared',
      objectType: 'content_calendar_item',
      title: 'Shared campaign review',
      editorialState: 'approved',
    });

    const blocked = await dispatch('POST', `/workflow/${item.id}/actions`, {
      action: 'schedule_content',
      durationMinutes: 45,
      preferredWindows: [
        { start: '2026-05-01T13:00:00.000Z', end: '2026-05-01T15:00:00.000Z', label: 'team window' },
      ],
    });
    expect(blocked.response.statusCode).toBe(202);
    expect(blocked.response.body.data.workflow.status).toBe('approval_required');
    expect(blocked.response.body.data.workflow.reasonCodes).toContain('tenant_shared_scheduling_requires_approval');
    expect(listSecretaryAgendaItems({ ownerUserId: 501, tenantId: 101 })).toEqual([]);

    const approved = await dispatch('POST', `/workflow/${item.id}/actions`, {
      action: 'schedule_content',
      approvalConfirmed: true,
      durationMinutes: 45,
      preferredWindows: [
        { start: '2026-05-01T13:00:00.000Z', end: '2026-05-01T15:00:00.000Z', label: 'team window' },
      ],
    });

    expect(approved.response.statusCode).toBe(200);
    expect(approved.response.body.data.scheduling.status).toBe('scheduled');
    expect(getContentWorkflowObject(501, item.id, 101)).toMatchObject({
      editorialState: 'scheduled',
      approvalState: 'approved',
      reviewRequired: false,
    });
    expect(listContentApprovalRecords({ userId: 501, tenantId: 101, objectType: 'content_calendar_item', objectId: item.id }))
      .toEqual([expect.objectContaining({ approval_type: 'schedule_tenant_shared', approval_state: 'approved', approved_by: 501 })]);
  });

  it('does not mutate a user-private workflow object outside owner scope', async () => {
    const draft = createDraft();

    const { response } = await dispatch('POST', `/workflow/${draft.id}/actions`, {
      action: 'approve_draft',
    }, 999, 101);

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(getContentWorkflowObject(501, draft.id, 101)?.editorialState).toBe('drafted');
  });
});

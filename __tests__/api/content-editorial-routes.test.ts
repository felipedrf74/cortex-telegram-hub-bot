import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Router, type Request, type Response } from 'express';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidateContentDerivedCaches: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { registerContentEditorialRoutes } from '../../src/api/routes/content-editorial-routes';
import {
  createContentWorkflowObject,
  getContentWorkflowObject,
} from '../../src/services/content-editorial-workflow';
import { invalidateContentDerivedCaches } from '../../src/services/cache-coherence-registry';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

const OWNER = { userId: 501, tenantId: 501 };

describe('deprecated content editorial HTTP compatibility routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => testDb.close());

  it('serves a presentation-safe canonical read with explicit deprecation and historical-ledger labels', async () => {
    const draft = createDraft('route-read-create-001');
    const response = await dispatch('GET', `/workflow/${draft.id}`);

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({
      schemaVersion: 'content-editorial-compatibility-v1',
      compatibility: {
        lifecycle: 'deprecated',
        publicationExecution: 'not_performed',
        canonicalRoutes: { item: `/api/v1/content/workspace/items/${draft.id}` },
      },
      object: {
        id: draft.id,
        productionState: 'active',
        secretaryIntentId: null,
        secretaryAgendaItemId: null,
      },
      approvals: [],
      historicalApprovals: [],
    });
    expect(response.body.data.object).not.toHaveProperty('metadata');
    expect(response.body.data.object).not.toHaveProperty('tenantId');
    expect(response.body.data.object).not.toHaveProperty('ownerUserId');
    expect(response.body.data.events[0]).not.toHaveProperty('actor_user_id');
    expect(response.body.data.events[0]).not.toHaveProperty('metadata_json');
  });

  it('returns a typed replacement for single-step scheduling and creates no agenda or schedule binding', async () => {
    const draft = createDraft('route-schedule-create-001');
    const response = await dispatch('POST', `/workflow/${draft.id}/actions`, {
      action: 'schedule_content',
      expectedWorkflowVersion: draft.workflowVersion,
      idempotencyKey: 'route-schedule-action-001',
      preferredWindows: [{ start: '2031-01-01T10:00:00.000Z', end: '2031-01-01T11:00:00.000Z' }],
    });

    expect(response.statusCode).toBe(426);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_WORKFLOW_SCHEDULING_MOVED',
      details: {
        deprecated: true,
        publicationExecution: 'not_performed',
        canonicalRoutes: {
          schedulePreview: '/api/v1/content/workspace/items/:itemId/schedule-previews',
          scheduleConfirm: '/api/v1/content/workspace/schedule-previews/:previewKey/confirm',
        },
      },
    });
    expect(getContentWorkflowObject(OWNER.userId, draft.id, OWNER.tenantId)?.productionState).toBe('active');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE source_skill = ?').get('content'))
      .toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings WHERE item_id = ?').get(draft.id))
      .toEqual({ count: 0 });
    expect(invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('never treats approvalConfirmed as publication confirmation', async () => {
    const review = createReview('route-publish-create-001');
    const approved = await dispatch('POST', `/workflow/${review.id}/approval`, {
      approvalType: 'content_review',
      decision: 'approved',
      expectedWorkflowVersion: review.workflowVersion,
      idempotencyKey: 'route-review-approval-001',
    });
    expect(approved.statusCode).toBe(200);
    const approvedItem = getContentWorkflowObject(OWNER.userId, review.id, OWNER.tenantId)!;

    const publish = await dispatch('POST', `/workflow/${review.id}/actions`, {
      action: 'mark_published',
      approvalConfirmed: true,
      expectedWorkflowVersion: approvedItem.workflowVersion,
      idempotencyKey: 'route-publish-action-001',
    });
    expect(publish.statusCode).toBe(409);
    expect(publish.body.error).toMatchObject({
      code: 'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED',
      details: {
        publicationExecution: 'not_performed',
        recovery: 'confirm_external_publication_in_a_dedicated_tracking_flow',
      },
    });
    expect(getContentWorkflowObject(OWNER.userId, review.id, OWNER.tenantId)?.productionState).toBe('approved');
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM content_workflow_events WHERE to_state = 'published'").get())
      .toEqual({ count: 0 });
  });

  it('requires confirmation, current workflow version, and idempotency before a safe legacy archive adapter mutates', async () => {
    const draft = createDraft('route-archive-create-001');
    const unconfirmed = await dispatch('POST', `/workflow/${draft.id}/actions`, {
      action: 'archive',
      expectedWorkflowVersion: draft.workflowVersion,
      idempotencyKey: 'route-archive-unconfirmed-001',
    });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.body.error.code).toBe('CONTENT_APPROVAL_REQUIRED');

    const noConcurrency = await dispatch('POST', `/workflow/${draft.id}/actions`, {
      action: 'archive',
      approvalConfirmed: true,
    });
    expect(noConcurrency.statusCode).toBe(409);
    expect(noConcurrency.body.error.code).toBe('CONTENT_WORKFLOW_CANONICAL_CONCURRENCY_REQUIRED');

    const archived = await dispatch('POST', `/workflow/${draft.id}/actions`, {
      action: 'archive',
      approvalConfirmed: true,
      expectedWorkflowVersion: draft.workflowVersion,
      idempotencyKey: 'route-archive-confirmed-001',
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.body.data.object).toMatchObject({ productionState: 'archived', editorialState: 'archived' });
    expect(invalidateContentDerivedCaches).toHaveBeenCalledWith(OWNER.userId);
  });

  it('requires an explicit content_review approval type and preserves canonical lineage policy', async () => {
    const review = createReview('route-explicit-approval-create-001');
    const ambiguous = await dispatch('POST', `/workflow/${review.id}/approval`, {
      decision: 'approved',
      expectedWorkflowVersion: review.workflowVersion,
      idempotencyKey: 'route-ambiguous-approval-001',
    });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.body.error.code).toBe('CONTENT_APPROVAL_TYPE_REQUIRED');

    const publish = await dispatch('POST', `/workflow/${review.id}/approval`, {
      approvalType: 'publish',
      decision: 'approved',
      expectedWorkflowVersion: review.workflowVersion,
      idempotencyKey: 'route-publish-approval-001',
    });
    expect(publish.statusCode).toBe(409);
    expect(publish.body.error.code).toBe('CONTENT_PUBLICATION_CONFIRMATION_REQUIRED');

    const approved = await dispatch('POST', `/workflow/${review.id}/approval`, {
      approvalType: 'content_review',
      decision: 'approved',
      expectedWorkflowVersion: review.workflowVersion,
      idempotencyKey: 'route-explicit-approval-001',
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.body.data.object).toMatchObject({ productionState: 'approved', approvalState: 'approved' });
    expect(approved.body.data.historicalApprovalRecords).toEqual([]);
  });

  it('moves raw source review to revision-pinned lineage and rejects cross-scope references before guidance', async () => {
    const draft = createDraft('route-source-review-create-001');
    const moved = await dispatch('POST', `/workflow/${draft.id}/source-review`, {
      references: [],
      claims: [{ id: 'claim-1', text: 'A claim' }],
    });
    expect(moved.statusCode).toBe(426);
    expect(moved.body.error).toMatchObject({
      code: 'CONTENT_SOURCE_REVIEW_MOVED',
      details: {
        canonicalRoutes: {
          sources: '/api/v1/content/workspace/sources',
          lineage: '/api/v1/content/workspace/revisions/:revisionId/lineage',
        },
      },
    });

    const forbidden = await dispatch('POST', `/workflow/${draft.id}/source-review`, {
      references: [{ tenantId: 777, ownerUserId: 777, visibilityScope: 'user_private' }],
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body.error.code).toBe('CONTENT_SOURCE_SCOPE_FORBIDDEN');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_source_review_records').get()).toEqual({ count: 0 });
  });

  it('moves repurpose to explicit canonical target creation and relationship recording with no inferred copy', async () => {
    const draft = createDraft('route-repurpose-create-001');
    const response = await dispatch('POST', `/workflow/${draft.id}/repurpose`, {
      title: 'Inferred unsafe variant',
      transformationType: 'shorten',
    });
    expect(response.statusCode).toBe(426);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_REPURPOSE_MOVED',
      details: {
        recovery: 'create_target_item_then_record_relationship',
        publicationExecution: 'not_performed',
      },
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_domain_objects').get()).toEqual({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_item_relationships').get()).toEqual({ count: 0 });
  });

  it('fails every compatibility read and mutation closed outside tenant/owner scope', async () => {
    const draft = createDraft('route-scope-create-001');
    const otherUser = await dispatch('GET', `/workflow/${draft.id}`, {}, 777, OWNER.tenantId);
    const otherTenant = await dispatch('POST', `/workflow/${draft.id}/actions`, {
      action: 'reject',
      expectedWorkflowVersion: draft.workflowVersion,
      idempotencyKey: 'route-cross-tenant-reject-001',
    }, OWNER.userId, 777);
    expect(otherUser.statusCode).toBe(404);
    expect(otherTenant.statusCode).toBe(404);
    expect(getContentWorkflowObject(OWNER.userId, draft.id, OWNER.tenantId)?.productionState).toBe('active');
  });
});

function createDraft(idempotencyKey: string) {
  return createContentWorkflowObject({
    ...OWNER,
    objectType: 'script',
    title: idempotencyKey,
    editorialState: 'drafted',
    content: { format: 'plain_text', text: 'Saved user-authored draft.' },
    idempotencyKey,
  });
}

function createReview(idempotencyKey: string) {
  return createContentWorkflowObject({
    ...OWNER,
    objectType: 'script',
    title: idempotencyKey,
    editorialState: 'reviewed',
    content: { format: 'plain_text', text: 'Saved user-authored review candidate.' },
    idempotencyKey,
  });
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

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = OWNER.userId,
  tenantId = OWNER.tenantId,
): Promise<MockRes> {
  const router = Router();
  registerContentEditorialRoutes(router, (res, candidate): candidate is number => {
    if (typeof candidate === 'number' && candidate > 0) return true;
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return false;
  });
  const req = {
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
    header: (name: string) => name.toLowerCase() === 'x-idempotency-key' && typeof body.idempotencyKey === 'string'
      ? body.idempotencyKey
      : undefined,
  } as unknown as Request;
  const res = mockRes();
  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (error: unknown) => error ? reject(error) : resolve());
    setImmediate(resolve);
  });
  return res;
}

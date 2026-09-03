// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { Router, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;
const mockInvalidateContentDerivedCaches = vi.hoisted(() => vi.fn());
const mockDismissContentFilmingSignalsForItem = vi.hoisted(() => vi.fn());
const scheduleRouteFaults = vi.hoisted(() => ({ failEventEnqueue: false }));

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return { ...actual, getDb: () => testDb };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cache-coherence-registry', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/cache-coherence-registry')>(
    '../../src/services/cache-coherence-registry',
  )),
  invalidateContentDerivedCaches: mockInvalidateContentDerivedCaches,
}));

vi.mock('../../src/services/content-schedule-signal-reconciliation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/content-schedule-signal-reconciliation')>()),
  dismissContentFilmingSignalsForItem: mockDismissContentFilmingSignalsForItem,
}));

vi.mock('../../src/services/event-outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/event-outbox')>();
  return {
    ...actual,
    emitDomainEvent: (...args: Parameters<typeof actual.emitDomainEvent>) => {
      if (scheduleRouteFaults.failEventEnqueue) throw new Error('event outbox unavailable');
      return actual.emitDomainEvent(...args);
    },
  };
});

import { registerContentWorkspaceScheduleRoutes } from '../../src/api/routes/content-workspace-schedule-routes';
import { registerContentWorkspaceRoutes } from '../../src/api/routes/content-workspace-routes';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  saveContentRevision,
  transitionContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { ContentScheduleSignalReconciliationError } from '../../src/services/content-schedule-signal-reconciliation';
import { logger } from '../../src/utils/logger';

const OWNER: ContentWorkspaceScope = { tenantId: 501, userId: 501 };
const WINDOW = { start: '2032-07-18T09:00:00.000Z', end: '2032-07-18T11:00:00.000Z' };

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
}

describe('canonical Content schedule routes', () => {
  beforeEach(() => {
    scheduleRouteFaults.failEventEnqueue = false;
    mockInvalidateContentDerivedCaches.mockReset();
    mockDismissContentFilmingSignalsForItem.mockReset();
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => testDb.close());

  it('fails closed before scheduling when tenant scope is absent or mismatched', async () => {
    const fixture = seedApproved('scope');
    const body = {
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'route-schedule-scope-001',
    };
    const absent = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, body, 501, 0);
    const mismatch = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, body, 501, 777);

    expect(absent.statusCode).toBe(401);
    expect(absent.body.error.code).toBe('CONTENT_TENANT_SCOPE_REQUIRED');
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.body.error.code).toBe('CONTENT_TENANT_SCOPE_MISMATCH');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_schedule_previews').get()).toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE source_skill = ?').get('content'))
      .toEqual({ count: 0 });
  });

  it('rejects invalid or conflicting schedule idempotency before any preview mutation', async () => {
    const fixture = seedApproved('idempotency-contract');
    const validRequest = {
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
    };
    const cases: Array<{
      body: Record<string, unknown>;
      headers?: Record<string, string>;
      expectedCode: string;
    }> = [
      { body: validRequest, expectedCode: 'CONTENT_IDEMPOTENCY_KEY_REQUIRED' },
      {
        body: { ...validRequest, idempotencyKey: 123 },
        expectedCode: 'CONTENT_VALIDATION_FAILED',
      },
      {
        body: { ...validRequest, idempotencyKey: 'short' },
        expectedCode: 'CONTENT_VALIDATION_FAILED',
      },
      {
        body: validRequest,
        headers: { 'x-idempotency-key': 'x'.repeat(201) },
        expectedCode: 'CONTENT_VALIDATION_FAILED',
      },
      {
        body: { ...validRequest, idempotencyKey: 'route-schedule-body-001' },
        headers: { 'x-idempotency-key': 'route-schedule-header-001' },
        expectedCode: 'CONTENT_IDEMPOTENCY_KEY_CONFLICT',
      },
    ];

    for (const testCase of cases) {
      const response = await dispatch(
        'POST',
        `/workspace/items/${fixture.itemId}/schedule-previews`,
        testCase.body,
        OWNER.userId,
        OWNER.tenantId,
        testCase.headers,
      );
      expect(response.statusCode).toBe(testCase.expectedCode === 'CONTENT_IDEMPOTENCY_KEY_CONFLICT' ? 409 : 400);
      expect(response.body.error.code).toBe(testCase.expectedCode);
    }

    for (const body of [
      { workKind: 'record', preferredWindows: [WINDOW], idempotencyKey: 'route-schedule-no-duration-001' },
      { workKind: 'record', durationMinutes: 14, preferredWindows: [WINDOW], idempotencyKey: 'route-schedule-duration-low-001' },
      { workKind: 'record', durationMinutes: 481, preferredWindows: [WINDOW], idempotencyKey: 'route-schedule-duration-high-001' },
      { workKind: 'record', durationMinutes: 60, idempotencyKey: 'route-schedule-no-windows-001' },
    ]) {
      const response = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, body);
      expect(response.statusCode).toBe(400);
      expect(response.body.error.code).toBe('CONTENT_VALIDATION_FAILED');
    }

    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_schedule_previews').get()).toEqual({ count: 0 });
  });

  it('supports preview, explicit confirmation, read, and truthful cancellation', async () => {
    const fixture = seedApproved('journey');
    const created = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, {
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      priority: 'high',
      idempotencyKey: 'route-schedule-preview-journey-001',
    });
    const replay = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, {
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      priority: 'high',
    }, OWNER.userId, OWNER.tenantId, {
      'x-idempotency-key': 'route-schedule-preview-journey-001',
    });

    expect(created.statusCode).toBe(201);
    expect(created.body.data).toMatchObject({
      schemaVersion: 'content-schedule-v1',
      preview: {
        status: 'ready',
        visibleTitle: 'Content work: Record',
        titleDisclosure: 'generic',
        publicationExecution: 'not_performed',
      },
      mutation: { replayed: false, changed: true },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data.mutation).toEqual({ replayed: true, changed: false });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE source_skill = ?').get('content'))
      .toEqual({ count: 0 });

    const previewKey = created.body.data.preview.previewKey;
    const confirmed = await dispatch('POST', `/workspace/schedule-previews/${previewKey}/confirm`, undefined, OWNER.userId, OWNER.tenantId, {
      'x-idempotency-key': 'route-schedule-confirm-journey-001',
    });
    const read = await dispatch('GET', `/workspace/items/${fixture.itemId}/schedule`);

    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.body.data.schedule).toMatchObject({
      state: 'scheduled',
      providerSyncState: 'pending',
      publicationExecution: 'not_performed',
    });
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledTimes(1);
    expect(mockInvalidateContentDerivedCaches).toHaveBeenLastCalledWith(OWNER.userId);
    expect(read.body.data.schedule).toMatchObject({
      localAgendaState: 'scheduled',
      contentChangedSinceScheduling: false,
    });
    const list = await dispatch('GET', '/workspace/items');
    const detail = await dispatch('GET', `/workspace/items/${fixture.itemId}`);
    expect(list.body.data.items).toEqual([
      expect.objectContaining({
        id: fixture.itemId,
        productionState: 'approved',
        nextAction: { action: 'prepare_scheduled_work', label: 'Prepare for work block', reason: expect.any(String) },
        workSchedule: expect.objectContaining({
          schemaVersion: 'content-work-schedule-summary-v1',
          state: 'scheduled',
          workKind: 'record',
          authority: 'secretary',
          authorityStatus: 'current',
          publicationExecution: 'not_performed',
        }),
      }),
    ]);
    expect(detail.body.data.item).toMatchObject({
      id: fixture.itemId,
      nextAction: { action: 'prepare_scheduled_work' },
      workSchedule: { state: 'scheduled', providerSyncState: 'pending' },
    });
    const serialized = JSON.stringify(read.body.data);
    expect(serialized).not.toContain('secretaryAgendaItemId');
    expect(serialized).not.toContain('contentHash');
    expect(serialized).not.toContain(fixture.privateTitle);
    const serializedWorkspace = JSON.stringify({ list: list.body.data, detail: detail.body.data });
    expect(serializedWorkspace).not.toContain('agendaItemId');
    expect(serializedWorkspace).not.toContain('sourceIntentId');
    expect(serializedWorkspace).not.toContain('providerEventId');
    expect(serializedWorkspace).not.toContain('bindingId');
    expect(serializedWorkspace).not.toContain('previewKey');

    const cancelled = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-cancel`, undefined, OWNER.userId, OWNER.tenantId, {
      'x-idempotency-key': 'route-schedule-cancel-journey-001',
    });
    expect(cancelled.body.data.schedule).toMatchObject({
      state: 'cancelled',
      localAgendaState: 'cancelled',
      publicationExecution: 'not_performed',
    });
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledTimes(2);
    expect(mockInvalidateContentDerivedCaches).toHaveBeenLastCalledWith(OWNER.userId);
    expect(mockDismissContentFilmingSignalsForItem).toHaveBeenCalledWith(OWNER, fixture.itemId);
    const afterCancellation = await dispatch('GET', `/workspace/items/${fixture.itemId}`);
    expect(afterCancellation.body.data.item).toMatchObject({
      productionState: 'approved',
      workSchedule: null,
      nextAction: { action: 'schedule_work' },
    });
  });

  it('reports derived-signal reconciliation failure after cancellation and retries it idempotently', async () => {
    const fixture = seedApproved('signal-reconciliation-retry');
    const preview = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, {
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'route-schedule-preview-signal-retry-001',
    });
    await dispatch('POST', `/workspace/schedule-previews/${preview.body.data.preview.previewKey}/confirm`, undefined, OWNER.userId, OWNER.tenantId, {
      'x-idempotency-key': 'route-schedule-confirm-signal-retry-001',
    });
    mockInvalidateContentDerivedCaches.mockClear();
    mockDismissContentFilmingSignalsForItem.mockImplementationOnce(() => {
      throw new ContentScheduleSignalReconciliationError();
    });

    const first = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-cancel`, undefined, OWNER.userId, OWNER.tenantId, {
      'x-idempotency-key': 'route-schedule-cancel-signal-retry-001',
    });
    expect(first.statusCode).toBe(503);
    expect(first.body.error).toMatchObject({
      code: 'CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_UNAVAILABLE',
      details: {
        canonicalCancellationCommitted: true,
        durableReconciliationQueued: true,
        recovery: 'retry_cancellation',
        retryable: true,
      },
    });
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledOnce();
    expect(mockInvalidateContentDerivedCaches).toHaveBeenLastCalledWith(OWNER.userId);

    const replay = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-cancel`, undefined, OWNER.userId, OWNER.tenantId, {
      'x-idempotency-key': 'route-schedule-cancel-signal-retry-001',
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data).toMatchObject({
      schedule: { state: 'cancelled', localAgendaState: 'cancelled' },
      mutation: { replayed: true, changed: false },
    });
    expect(mockDismissContentFilmingSignalsForItem).toHaveBeenCalledTimes(2);
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledTimes(2);
    expect(mockInvalidateContentDerivedCaches).toHaveBeenLastCalledWith(OWNER.userId);
  });

  it('invalidates plan caches when event enqueue fails after Secretary may have cancelled', async () => {
    const fixture = seedApproved('signal-enqueue-failure');
    const preview = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, {
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'route-schedule-preview-enqueue-failure-001',
    });
    await dispatch('POST', `/workspace/schedule-previews/${preview.body.data.preview.previewKey}/confirm`, undefined, OWNER.userId, OWNER.tenantId, {
      'x-idempotency-key': 'route-schedule-confirm-enqueue-failure-001',
    });
    mockInvalidateContentDerivedCaches.mockClear();
    scheduleRouteFaults.failEventEnqueue = true;

    const response = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-cancel`, undefined, OWNER.userId, OWNER.tenantId, {
      'x-idempotency-key': 'route-schedule-cancel-enqueue-failure-001',
    });

    expect(response.statusCode).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_QUEUE_UNAVAILABLE',
      details: {
        recovery: 'retry_cancellation',
        secretaryCancellationMayBeCommitted: true,
        publicationExecution: 'not_performed',
      },
    });
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledOnce();
    expect(mockInvalidateContentDerivedCaches).toHaveBeenCalledWith(OWNER.userId);
    expect(mockDismissContentFilmingSignalsForItem).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: 'Error',
        errorFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        bindingId: expect.any(Number),
      }),
      'Content schedule signal reconciliation enqueue failed',
    );
  });

  it('projects provider failure and tenant-safe recovery through workspace list and detail APIs', async () => {
    const fixture = seedApproved('provider-failure');
    const created = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, {
      workKind: 'edit',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'route-schedule-preview-provider-failure-001',
    });
    await dispatch('POST', `/workspace/schedule-previews/${created.body.data.preview.previewKey}/confirm`, {
      idempotencyKey: 'route-schedule-confirm-provider-failure-001',
    });
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'failed_sync', provider_sync_state = 'create_failed'
       WHERE source_skill = 'content' AND owner_user_id = ? AND tenant_id = ?
    `).run(OWNER.userId, String(OWNER.tenantId));

    const list = await dispatch('GET', '/workspace/items');
    const detail = await dispatch('GET', `/workspace/items/${fixture.itemId}`);
    const foreignList = await dispatch('GET', '/workspace/items', {}, 777, 777);
    const foreignDetail = await dispatch('GET', `/workspace/items/${fixture.itemId}`, {}, 777, 777);

    expect(list.body.data.items[0]).toMatchObject({
      id: fixture.itemId,
      productionState: 'approved',
      workSchedule: {
        state: 'sync_failed',
        providerSyncState: 'failed',
        recoverable: true,
        publicationExecution: 'not_performed',
      },
      nextAction: {
        action: 'recover_work_schedule',
        label: 'Recover work block',
        reason: 'The private work block is confirmed in Secretary, but provider sync needs attention.',
      },
    });
    expect(detail.body.data.item).toMatchObject({
      id: fixture.itemId,
      workSchedule: { state: 'sync_failed' },
      nextAction: { action: 'recover_work_schedule' },
    });
    expect(foreignList.body.data.items).toEqual([]);
    expect(foreignDetail.statusCode).toBe(404);
    expect(JSON.stringify(foreignDetail.body)).not.toContain(fixture.privateTitle);
  });

  it('returns a recoverable stale conflict and never submits the obsolete preview', async () => {
    const fixture = seedApproved('stale');
    const created = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-previews`, {
      workKind: 'revise',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'route-schedule-preview-stale-001',
    });
    saveContentRevision({
      scope: OWNER,
      artifactId: fixture.artifactId,
      baseRevision: 1,
      content: { format: 'markdown', text: '# New user content\nPreserve this edit.' },
      idempotencyKey: 'route-schedule-stale-user-edit-001',
    }, testDb);

    const stale = await dispatch('POST', `/workspace/schedule-previews/${created.body.data.preview.previewKey}/confirm`, {
      idempotencyKey: 'route-schedule-confirm-stale-001',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'CONTENT_SCHEDULE_PREVIEW_STALE',
      message: expect.stringContaining('edits were preserved'),
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings').get()).toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE source_skill = ?').get('content'))
      .toEqual({ count: 0 });
  });
});

function seedApproved(suffix: string): { itemId: number; artifactId: number; privateTitle: string } {
  const privateTitle = `Private content title ${suffix}`;
  const created = createContentWorkspaceItem({
    scope: OWNER,
    itemType: 'content_item',
    title: privateTitle,
    idempotencyKey: `route-schedule-item-${suffix}-001`,
  }, testDb).value;
  const artifact = createContentArtifact({
    scope: OWNER,
    itemId: created.id,
    expectedWorkflowVersion: created.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `# Script ${suffix}\nPrivate draft.` },
    idempotencyKey: `route-schedule-artifact-${suffix}-001`,
  }, testDb).value;
  let item = getContentWorkspaceItem(OWNER, created.id, testDb)!;
  item = transitionContentWorkspaceItem({
    scope: OWNER,
    itemId: item.id,
    targetState: 'review',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `route-schedule-review-${suffix}-001`,
  }, testDb).value;
  transitionContentWorkspaceItem({
    scope: OWNER,
    itemId: item.id,
    targetState: 'approved',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `route-schedule-approve-${suffix}-001`,
  }, testDb);
  return { itemId: created.id, artifactId: artifact.id, privateTitle };
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined = {},
  userId: number | undefined = OWNER.userId,
  tenantId: number | undefined = OWNER.tenantId,
  headers: Record<string, string> = {},
): Promise<MockResponse> {
  const router = Router();
  registerContentWorkspaceScheduleRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
    if (Number.isInteger(authenticatedUserId) && Number(authenticatedUserId) > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return false;
  });
  registerContentWorkspaceRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
    if (Number.isInteger(authenticatedUserId) && Number(authenticatedUserId) > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return false;
  });
  const parsedUrl = new URL(path, 'https://nexus.invalid');
  const request = {
    method,
    url: `${parsedUrl.pathname}${parsedUrl.search}`,
    originalUrl: path,
    baseUrl: '',
    path: parsedUrl.pathname,
    query: Object.fromEntries(parsedUrl.searchParams.entries()),
    params: {},
    body,
    userId,
    tenantId,
    headers,
    header(name: string) { return (this.headers as Record<string, string>)[name.toLowerCase()]; },
  } as unknown as Request;
  const response = mockResponse();
  await new Promise<void>((resolvePromise, reject) => {
    (router as any).handle(request, response, (error: unknown) => error ? reject(error) : resolvePromise());
    setImmediate(resolvePromise);
  });
  return response;
}

function mockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { response.statusCode = code; return response; },
    json(body) { response.body = body; return response; },
    setHeader(name, value) { response.headers[name.toLowerCase()] = String(value); },
    getHeader(name) { return response.headers[name.toLowerCase()]; },
  };
  return response;
}

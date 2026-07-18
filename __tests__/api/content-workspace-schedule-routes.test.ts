// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { Router, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return { ...actual, getDb: () => testDb };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

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
      idempotencyKey: 'route-schedule-preview-journey-001',
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
    const confirmed = await dispatch('POST', `/workspace/schedule-previews/${previewKey}/confirm`, {
      idempotencyKey: 'route-schedule-confirm-journey-001',
    });
    const read = await dispatch('GET', `/workspace/items/${fixture.itemId}/schedule`);

    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.body.data.schedule).toMatchObject({
      state: 'scheduled',
      providerSyncState: 'pending',
      publicationExecution: 'not_performed',
    });
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

    const cancelled = await dispatch('POST', `/workspace/items/${fixture.itemId}/schedule-cancel`, {
      idempotencyKey: 'route-schedule-cancel-journey-001',
    });
    expect(cancelled.body.data.schedule).toMatchObject({
      state: 'cancelled',
      localAgendaState: 'cancelled',
      publicationExecution: 'not_performed',
    });
    const afterCancellation = await dispatch('GET', `/workspace/items/${fixture.itemId}`);
    expect(afterCancellation.body.data.item).toMatchObject({
      productionState: 'approved',
      workSchedule: null,
      nextAction: { action: 'schedule_work' },
    });
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
      nextAction: { action: 'recover_work_schedule', label: 'Recover work block' },
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
  body: Record<string, unknown> = {},
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

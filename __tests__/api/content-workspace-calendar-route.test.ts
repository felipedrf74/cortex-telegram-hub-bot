// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { Router, type Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return { ...actual, getDb: () => testDb };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerContentWorkspaceScheduleRoutes } from '../../src/api/routes/content-workspace-schedule-routes';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  transitionContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';
import {
  confirmContentSchedulePreview,
  createContentSchedulePreview,
} from '../../src/services/content-workspace-scheduling';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const OWNER: ContentWorkspaceScope = { tenantId: 501, userId: 501 };
const WINDOW = { start: '2032-07-18T09:00:00.000Z', end: '2032-07-18T10:00:00.000Z' };

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
}

describe('canonical Content calendar route', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    if (testDb.open) testDb.close();
  });

  it('returns the presentation-safe calendar contract without publishing or raw schedule internals', async () => {
    const fixture = seedApproved('calendar-route', '2032-07-19T16:00:00.000Z');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.itemId,
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'calendar-route-preview-001',
      now: '2032-07-17T08:00:00.000Z',
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'calendar-route-confirm-001',
      now: '2032-07-17T08:00:00.000Z',
    }, testDb);

    const response = await dispatch(
      'GET',
      '/workspace/calendar?from=2032-07-18T00%3A00%3A00.000Z&to=2032-07-20T00%3A00%3A00.000Z&limit=20',
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({
      schemaVersion: 'content-calendar-v1',
      calendar: {
        schemaVersion: 'content-calendar-v1',
        publicationExecution: 'not_performed',
        entries: [
          {
            kind: 'work_block',
            meaning: 'private_work_time_not_publication',
            item: { id: fixture.itemId, title: fixture.title, status: 'approved' },
            schedule: { authority: 'secretary', authorityStatus: 'current' },
          },
          {
            kind: 'deadline',
            meaning: 'target_date_not_publication',
            item: { id: fixture.itemId, title: fixture.title, status: 'approved' },
          },
        ],
      },
    });
    const serialized = JSON.stringify(response.body.data);
    expect(serialized).not.toContain('agendaItemId');
    expect(serialized).not.toContain('secretaryAgendaItemId');
    expect(serialized).not.toContain('bindingId');
    expect(serialized).not.toContain('providerEventId');
    expect(serialized).not.toContain('Private draft body');
  });

  it('fails closed for missing or mismatched tenant scope and invalid filters', async () => {
    const path = '/workspace/calendar?from=2032-07-18T00%3A00%3A00.000Z&to=2032-07-20T00%3A00%3A00.000Z';
    const absent = await dispatch('GET', path, {}, OWNER.userId, 0);
    const mismatch = await dispatch('GET', path, {}, OWNER.userId, 777);
    const missingRange = await dispatch('GET', '/workspace/calendar');
    const invalidLimit = await dispatch('GET', `${path}&limit=lots`);

    expect(absent.statusCode).toBe(401);
    expect(absent.body.error.code).toBe('CONTENT_TENANT_SCOPE_REQUIRED');
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.body.error.code).toBe('CONTENT_TENANT_SCOPE_MISMATCH');
    expect(missingRange.statusCode).toBe(400);
    expect(missingRange.body.error).toMatchObject({ code: 'CONTENT_VALIDATION_FAILED' });
    expect(invalidLimit.statusCode).toBe(400);
    expect(invalidLimit.body.error).toMatchObject({ code: 'CONTENT_VALIDATION_FAILED' });
  });

  it('surfaces unavailable Secretary authority as recoverable instead of claiming the block is current', async () => {
    const fixture = seedApproved('calendar-route-authority');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.itemId,
      workKind: 'review',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'calendar-route-authority-preview-001',
      now: '2032-07-17T08:00:00.000Z',
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'calendar-route-authority-confirm-001',
      now: '2032-07-17T08:00:00.000Z',
    }, testDb);
    const binding = testDb.prepare(`
      SELECT secretary_agenda_item_id FROM content_schedule_bindings WHERE item_id = ?
    `).get(fixture.itemId) as { secretary_agenda_item_id: string };
    testDb.prepare('DELETE FROM secretary_agenda_items WHERE agenda_item_id = ?')
      .run(binding.secretary_agenda_item_id);

    const response = await dispatch(
      'GET',
      '/workspace/calendar?from=2032-07-18T00%3A00%3A00.000Z&to=2032-07-19T00%3A00%3A00.000Z',
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.data.calendar).toMatchObject({
      scheduleAuthority: {
        authority: 'secretary',
        status: 'partially_unavailable',
        unavailableEntryCount: 1,
      },
      entries: [
        expect.objectContaining({
          kind: 'work_block',
          schedule: expect.objectContaining({
            state: 'stale',
            authorityStatus: 'unavailable',
            recoverable: true,
            nextAction: 'reload_schedule',
          }),
        }),
      ],
    });
  });

  it('returns a stable safe error when the calendar store is unavailable', async () => {
    testDb.close();
    const response = await dispatch(
      'GET',
      '/workspace/calendar?from=2032-07-18T00%3A00%3A00.000Z&to=2032-07-19T00%3A00%3A00.000Z',
    );

    expect(response.statusCode).toBe(500);
    expect(response.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Content scheduling is temporarily unavailable. No publication was performed.',
    });
    expect(JSON.stringify(response.body)).not.toContain('database connection is not open');
  });
});

function seedApproved(suffix: string, deadlineAt?: string): { itemId: number; title: string } {
  const title = `Private content title ${suffix}`;
  const created = createContentWorkspaceItem({
    scope: OWNER,
    itemType: 'content_item',
    title,
    deadlineAt,
    idempotencyKey: `calendar-route-item-${suffix}-001`,
  }, testDb).value;
  createContentArtifact({
    scope: OWNER,
    itemId: created.id,
    expectedWorkflowVersion: created.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: '# Script\nPrivate draft body.' },
    idempotencyKey: `calendar-route-artifact-${suffix}-001`,
  }, testDb);
  let item = getContentWorkspaceItem(OWNER, created.id, testDb)!;
  item = transitionContentWorkspaceItem({
    scope: OWNER,
    itemId: item.id,
    targetState: 'review',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `calendar-route-review-${suffix}-001`,
  }, testDb).value;
  transitionContentWorkspaceItem({
    scope: OWNER,
    itemId: item.id,
    targetState: 'approved',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `calendar-route-approve-${suffix}-001`,
  }, testDb);
  return { itemId: created.id, title };
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = OWNER.userId,
  tenantId: number | undefined = OWNER.tenantId,
): Promise<MockResponse> {
  const router = Router();
  registerContentWorkspaceScheduleRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
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
    headers: {},
    header() { return undefined; },
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

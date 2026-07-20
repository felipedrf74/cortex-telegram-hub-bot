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

import { registerContentWorkspaceDecisionRoutes } from '../../src/api/routes/content-workspace-decision-routes';
import { registerContentWorkspaceRoutes } from '../../src/api/routes/content-workspace-routes';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  transitionContentWorkspaceItem,
} from '../../src/services/content-workspace';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const OWNER = { tenantId: 501, userId: 501 };

describe('Content workspace Decision Center projection route', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => testDb.close());

  it('projects and idempotently reconciles a saved review request', async () => {
    const item = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Review route candidate',
      idempotencyKey: 'decision-route-item-001',
    }, testDb).value;
    createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Private saved draft body.' },
      actorType: 'user',
      idempotencyKey: 'decision-route-artifact-001',
    }, testDb);
    const saved = getContentWorkspaceItem(OWNER, item.id, testDb)!;
    transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: item.id,
      targetState: 'review',
      expectedWorkflowVersion: saved.workflowVersion,
      idempotencyKey: 'decision-route-review-001',
    }, testDb);

    const first = await dispatch('POST', `/workspace/items/${item.id}/review-decision`);
    const replay = await dispatch('POST', `/workspace/items/${item.id}/review-decision`);

    expect(first.statusCode).toBe(200);
    expect(first.body.data).toMatchObject({
      schemaVersion: 'content-review-decision-projection-v1',
      decisionProjection: { status: 'projected', itemId: item.id, retryable: false },
    });
    expect(replay.body.data.decisionProjection).toMatchObject({
      status: 'already_projected',
      decisionId: first.body.data.decisionProjection.decisionId,
    });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM notification_center_items WHERE source_skill = 'content'").get())
      .toEqual({ count: 1 });
    expect(JSON.stringify(first.body)).not.toContain('Private saved draft body');
  });

  it('automatically projects the exact saved version when the item enters review', async () => {
    const item = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Automatic review candidate',
      idempotencyKey: 'decision-route-auto-item-001',
    }, testDb).value;
    createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Never expose this saved body.' },
      actorType: 'user',
      idempotencyKey: 'decision-route-auto-artifact-001',
    }, testDb);
    const saved = getContentWorkspaceItem(OWNER, item.id, testDb)!;

    const response = await dispatch(
      'POST',
      `/workspace/items/${item.id}/state`,
      OWNER.userId,
      OWNER.tenantId,
      {
        targetState: 'review',
        expectedWorkflowVersion: saved.workflowVersion,
        idempotencyKey: 'decision-route-auto-review-001',
      },
      true,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toMatchObject({
      item: { id: item.id, productionState: 'review' },
      decisionProjection: {
        status: 'projected',
        itemId: item.id,
        workflowVersion: saved.workflowVersion + 1,
        retryable: false,
      },
    });
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM notification_center_items WHERE source_skill = 'content'").get())
      .toEqual({ count: 1 });
    expect(JSON.stringify(response.body)).not.toContain('Never expose this saved body');
  });

  it('fails closed for a mismatched tenant and invalid item id', async () => {
    const mismatched = await dispatch('POST', '/workspace/items/7/review-decision', 501, 999);
    const invalid = await dispatch('POST', '/workspace/items/nope/review-decision');
    expect(mismatched).toMatchObject({ statusCode: 403, body: { error: { code: 'CONTENT_TENANT_SCOPE_MISMATCH' } } });
    expect(invalid).toMatchObject({ statusCode: 400, body: { error: { code: 'CONTENT_ITEM_ID_INVALID' } } });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM notification_center_items').get()).toEqual({ count: 0 });
  });
});

async function dispatch(
  method: string,
  path: string,
  userId: number | undefined = OWNER.userId,
  tenantId: number | undefined = OWNER.tenantId,
  body: Record<string, unknown> = {},
  includeWorkspaceRoutes = false,
): Promise<any> {
  const router = Router();
  registerContentWorkspaceDecisionRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
    if (Number.isSafeInteger(authenticatedUserId) && Number(authenticatedUserId) > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return false;
  });
  if (includeWorkspaceRoutes) {
    registerContentWorkspaceRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
      if (Number.isSafeInteger(authenticatedUserId) && Number(authenticatedUserId) > 0) return true;
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
      return false;
    });
  }
  const request = {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    body,
    userId,
    tenantId,
    headers: {},
    header() { return undefined; },
  } as unknown as Request;
  const response = mockResponse();
  await new Promise<void>((resolve, reject) => {
    (router as any).handle(request, response, (error: unknown) => error ? reject(error) : resolve());
    setImmediate(resolve);
  });
  return response;
}

function mockResponse(): any {
  const response: any = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { response.statusCode = code; return response; },
    json(body: unknown) { response.body = body; return response; },
    setHeader(name: string, value: string) { response.headers[name.toLowerCase()] = String(value); },
    getHeader(name: string) { return response.headers[name.toLowerCase()]; },
  };
  return response;
}

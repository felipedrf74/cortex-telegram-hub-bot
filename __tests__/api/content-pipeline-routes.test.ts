import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import Database from 'better-sqlite3';
import type { Request } from 'express';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerContentPipelineRoutes } from '../../src/api/routes/content-pipeline-routes';
import {
  createContentArtifact,
  createContentWorkspaceItem,
} from '../../src/services/content-workspace';
import { readContentHomeIdeas, readContentHomePipeline } from '../../src/api/routes/content-home-route-utils';
import {
  _resetContentWorkspaceObservabilityForTests,
  getContentWorkspaceObservabilitySnapshot,
} from '../../src/services/content-workspace-observability';

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
    setHeader(name: string, value: string) { response.headers[name.toLowerCase()] = value; },
    getHeader(name: string) { return response.headers[name.toLowerCase()]; },
  };
  return response;
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = 41,
  tenantId: number | undefined = 7,
): Promise<MockRes> {
  const router = Router();
  registerContentPipelineRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
    if (Number.isInteger(authenticatedUserId) && Number(authenticatedUserId) > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
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
    header: () => undefined,
  } as unknown as Request;
  const res = mockRes();
  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: unknown) => err ? reject(err) : resolve());
    setImmediate(resolve);
  });
  return res;
}

function seedWorkspaceItem(input: {
  title: string;
  userId?: number;
  tenantId?: number;
  artifactType?: 'brief' | 'outline' | 'script';
  published?: boolean;
}): number {
  const scope = { userId: input.userId ?? 41, tenantId: input.tenantId ?? 7 };
  const created = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: input.title,
    idempotencyKey: `item-${scope.tenantId}-${scope.userId}-${input.title}`,
  }, testDb).value;
  if (input.artifactType) {
    createContentArtifact({
      scope,
      itemId: created.id,
      expectedWorkflowVersion: created.workflowVersion,
      artifactType: input.artifactType,
      initialContent: { format: 'plain_text', text: `${input.title} body` },
      idempotencyKey: `artifact-${scope.tenantId}-${scope.userId}-${input.title}`,
    }, testDb);
  }
  if (input.published) {
    testDb.prepare(`
      UPDATE content_domain_objects
         SET production_state = 'published', lifecycle_state = 'published'
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).run(created.id, scope.tenantId, scope.userId);
    testDb.prepare(`
      INSERT INTO content_workflow_events (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, action, from_state, to_state,
        approval_state, review_required, reason_codes_json, actor_user_id, metadata_json
      ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?,
        'workspace_state_changed', 'scheduled', 'published', 'not_required', 0, '[]', ?, '{}')
    `).run(scope.tenantId, scope.userId, String(created.id), scope.userId);
  }
  return created.id;
}

describe('canonical Content pipeline compatibility routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = createMigratedTestDatabase();
    _resetContentWorkspaceObservabilityForTests();
    expect(testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='content_ideas'").get())
      .toBeUndefined();
  });

  afterEach(() => testDb?.close());

  it('projects canonical phases truthfully and marks unmodeled legacy stages', async () => {
    seedWorkspaceItem({ title: 'Inbox idea' });
    seedWorkspaceItem({ title: 'Brief in progress', artifactType: 'brief' });
    seedWorkspaceItem({ title: 'Script ready', artifactType: 'script' });
    seedWorkspaceItem({ title: 'Published script', artifactType: 'script', published: true });

    const response = await dispatch('GET', '/pipeline');

    expect(response.statusCode).toBe(200);
    expect(response.body.data.stages.ideas.map((item: any) => item.title)).toEqual(expect.arrayContaining([
      'Inbox idea',
      'Brief in progress',
    ]));
    expect(response.body.data.stages.scripted.map((item: any) => item.title)).toEqual(['Script ready']);
    expect(response.body.data.stages.published.map((item: any) => item.title)).toEqual(['Published script']);
    expect(response.body.data.stages.filmed).toEqual([]);
    expect(response.body.data.stages.editing).toEqual([]);
    expect(response.body.data.compatibility.stages).toMatchObject({
      filmed: { tracking: 'not_tracked', reasonCode: 'CONTENT_FILMING_STATE_NOT_MODELED' },
      editing: { tracking: 'not_tracked', reasonCode: 'CONTENT_EDITING_STATE_NOT_MODELED' },
    });
    expect(response.body.data.stages.ideas[0]).toMatchObject({
      nextAction: { action: expect.any(String), label: expect.any(String), reason: expect.any(String) },
      workspace: { productionState: expect.any(String), artifactPhase: expect.any(String), workflowVersion: expect.any(Number) },
    });
    expect(response.body.data.stats.publishedThisMonth).toBe(1);
    expect(response.body.data.stats.publishedThisMonthStatus.source).toBe('content_workflow_events');
  });

  it('isolates both tenant and canonical owner in pipeline, ideas, and home projections', async () => {
    seedWorkspaceItem({ title: 'Owned idea' });
    seedWorkspaceItem({ title: 'Foreign tenant', tenantId: 8 });
    seedWorkspaceItem({ title: 'Foreign owner', userId: 99 });

    const pipeline = await dispatch('GET', '/pipeline');
    const ideas = await dispatch('GET', '/ideas');
    const serialized = JSON.stringify([pipeline.body.data, ideas.body.data]);

    expect(serialized).toContain('Owned idea');
    expect(serialized).not.toContain('Foreign tenant');
    expect(serialized).not.toContain('Foreign owner');
    expect(readContentHomeIdeas(testDb as any, 41, 7).map((item) => item.title)).toEqual(['Owned idea']);
    expect(JSON.stringify(readContentHomePipeline(testDb as any, 41, 7))).not.toContain('Foreign');
  });

  it('requires a valid tenant before reading the workspace', async () => {
    const response = await dispatch('GET', '/pipeline', {}, 41, 0);
    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('CONTENT_TENANT_SCOPE_REQUIRED');
    expect(getContentWorkspaceObservabilitySnapshot().product.legacy_pipeline_compatibility_read).toBe(0);
  });

  it('records aggregate-only compatibility use after valid scope resolution', async () => {
    const id = seedWorkspaceItem({ title: 'Compatibility counter target' });

    await dispatch('GET', '/pipeline');
    await dispatch('GET', '/ideas');
    await dispatch('POST', `/pipeline/${id}/advance`);

    expect(getContentWorkspaceObservabilitySnapshot().product).toMatchObject({
      legacy_pipeline_compatibility_read: 1,
      legacy_ideas_compatibility_read: 1,
      legacy_pipeline_compatibility_mutation: 1,
    });
  });

  it('returns truthful 503 errors when the canonical root is unavailable', async () => {
    testDb.pragma('foreign_keys = OFF');
    testDb.exec('DROP TABLE content_domain_objects');

    const pipeline = await dispatch('GET', '/pipeline');
    const ideas = await dispatch('GET', '/ideas');

    expect(pipeline.statusCode).toBe(503);
    expect(pipeline.body.error.code).toBe('CONTENT_PIPELINE_UNAVAILABLE');
    expect(ideas.statusCode).toBe(503);
    expect(ideas.body.error.code).toBe('CONTENT_IDEAS_UNAVAILABLE');
  });

  it('rejects implicit advancement with the current explicit next action and no mutation', async () => {
    const id = seedWorkspaceItem({ title: 'Needs explicit development' });
    const before = testDb.prepare('SELECT production_state, workflow_version FROM content_domain_objects WHERE id = ?').get(id);

    const response = await dispatch('POST', `/pipeline/${id}/advance`);

    expect(response.statusCode).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_PIPELINE_ADVANCE_DEPRECATED',
      details: {
        itemId: String(id),
        workflowVersion: expect.any(Number),
        nextAction: { action: 'develop_brief' },
        replacement: { requiresExpectedWorkflowVersion: true, requiresIdempotencyKey: true },
      },
    });
    expect(testDb.prepare('SELECT production_state, workflow_version FROM content_domain_objects WHERE id = ?').get(id))
      .toEqual(before);
  });

  it('makes foreign and nonexistent legacy advance IDs indistinguishable', async () => {
    const foreignId = seedWorkspaceItem({ title: 'Foreign advance target', userId: 99 });

    const foreign = await dispatch('POST', `/pipeline/${foreignId}/advance`);
    const missing = await dispatch('POST', '/pipeline/999999/advance');

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
  });
});

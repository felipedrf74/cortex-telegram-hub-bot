import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request } from 'express';

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

vi.mock('../../src/portal/telemetry', () => ({ getJobStatuses: () => [] }));

import { contentRoutes } from '../../src/api/routes/content';
import { createContentWorkspaceItem } from '../../src/services/content-workspace';
import { saveGeneratedScriptToWorkspace } from '../../src/services/content-workspace-capture';

function mockRes(): any {
  const response: any = {
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

async function dispatch(userId: number, tenantId: number, path = '/ideas'): Promise<any> {
  const router = contentRoutes();
  const req = {
    userId,
    tenantId,
    method: 'GET',
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
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

describe('Content API — canonical ideas compatibility contract', () => {
  beforeEach(() => { testDb = createMigratedTestDatabase(); });
  afterEach(() => testDb?.close());

  it('returns canonical workspace items with count and next-action metadata', async () => {
    createContentWorkspaceItem({
      scope: { userId: 41, tenantId: 7 },
      itemType: 'content_item',
      title: 'Hybrid athlete workflow',
      idempotencyKey: 'ideas-route-canonical-001',
    }, testDb);

    const response = await dispatch(41, 7);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.count).toBe(1);
    expect(response.body.data.ideas[0]).toMatchObject({
      title: 'Hybrid athlete workflow',
      stage: 'ideas',
      nextAction: { action: 'develop_brief' },
      workspace: { productionState: 'inbox', artifactPhase: 'idea' },
    });
    expect(response.body.data.workspace).toEqual({ source: 'content_workspace', canonical: true });
  });

  it('does not convert a canonical read failure into a successful empty list', async () => {
    testDb.pragma('foreign_keys = OFF');
    testDb.exec('DROP TABLE content_domain_objects');

    const response = await dispatch(41, 7);

    expect(response.statusCode).toBe(503);
    expect(response.body.error.code).toBe('CONTENT_IDEAS_UNAVAILABLE');
  });

  it('shows a canonically saved generated script through the explicit ideas library route', async () => {
    const saved = saveGeneratedScriptToWorkspace({
      scope: { userId: 41, tenantId: 7 },
      topic: 'Saved route script',
      format: 'YouTube',
      scriptText: 'First line\n\nExact saved body.',
      idempotencyKey: 'ideas-library-script-001',
      captureOrigin: 'script_generation',
    }, testDb);

    const response = await dispatch(41, 7, '/ideas/library');

    expect(response.statusCode).toBe(200);
    expect(response.body.data.count).toBe(1);
    expect(response.body.data.ideas).toContainEqual(expect.objectContaining({
      id: String(saved.item.id),
      title: 'Saved route script',
      stage: 'scripted',
      workspace: expect.objectContaining({ artifactPhase: 'draft' }),
    }));
  });
});

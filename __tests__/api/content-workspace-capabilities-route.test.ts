import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentRoutes } from '../../src/api/routes/content';

describe('Content workspace capability route', () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    mode: process.env.CONTENT_WORKSPACE_V1_MODE,
    global: process.env.CONTENT_WORKSPACE_V1_GLOBAL_WRITE,
    core: process.env.CONTENT_WORKSPACE_V1_CORE_WRITES,
    lineage: process.env.CONTENT_WORKSPACE_V1_LINEAGE_WRITES,
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.CONTENT_WORKSPACE_V1_MODE = 'read_only';
    delete process.env.CONTENT_WORKSPACE_V1_GLOBAL_WRITE;
  });

  afterEach(() => {
    restore('NODE_ENV', original.NODE_ENV);
    restore('CONTENT_WORKSPACE_V1_MODE', original.mode);
    restore('CONTENT_WORKSPACE_V1_GLOBAL_WRITE', original.global);
    restore('CONTENT_WORKSPACE_V1_CORE_WRITES', original.core);
    restore('CONTENT_WORKSPACE_V1_LINEAGE_WRITES', original.lineage);
  });

  it('returns the authenticated fail-closed capability contract without internal cohort configuration', async () => {
    const response = await dispatch('GET', '/workspace/capabilities');

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 'content-workspace-capabilities-v1',
        available: true,
        mode: 'read_only',
        reasonCode: 'read_only',
        writes: {
          core: false,
          revisions: false,
          lineage: false,
          agents: false,
          scheduling: false,
          restore_deleted_items: false,
        },
        publicationExecution: 'not_supported',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('CONTENT_WORKSPACE_V1_USER_IDS');
    expect(JSON.stringify(response.body)).not.toContain('CONTENT_WORKSPACE_V1_TENANT_IDS');
  });

  it('blocks a core write before route execution', async () => {
    const write = await dispatch('POST', '/workspace/items');

    expect(write.statusCode).toBe(503);
    expect(write.body).toMatchObject({
      ok: false,
      error: {
        code: 'CONTENT_WORKSPACE_WRITE_DISABLED',
        details: { writeSlice: 'core', mode: 'read_only' },
      },
    });
  });

  it('routes source assessment through the lineage slice when core writes are disabled', async () => {
    process.env.CONTENT_WORKSPACE_V1_MODE = 'write';
    process.env.CONTENT_WORKSPACE_V1_GLOBAL_WRITE = 'true';
    process.env.CONTENT_WORKSPACE_V1_CORE_WRITES = 'false';
    process.env.CONTENT_WORKSPACE_V1_LINEAGE_WRITES = 'true';

    const response = await dispatch('POST', '/workspace/sources/999999/assessment', {
      assessment: 'reviewed',
      expectedUpdatedAt: '2026-07-17T00:00:00.000Z',
      evidenceSummary: 'Reviewed for the scoped route test.',
      idempotencyKey: 'source-assessment-slice-001',
    });

    // The lightweight router harness does not install a migrated database, so
    // the handler itself may fail. Reaching it (instead of the capability
    // middleware's 503) proves this path is governed by the enabled lineage
    // slice and not the disabled core slice.
    expect(response.statusCode).not.toBe(503);
    expect(response.body?.error?.code).not.toBe('CONTENT_WORKSPACE_WRITE_DISABLED');
  });

  it.each([
    ['/topics', { title: 'Compatibility capture' }, 'core'],
    ['/topics/7', { title: 'Compatibility edit' }, 'core'],
    ['/agency/projects/pkg-7/handoff', {}, 'core'],
    ['/workflow/7/source-review', { decision: 'approved' }, 'lineage'],
    ['/workspace/sources/7/assessment', {
      assessment: 'reviewed',
      expectedUpdatedAt: '2026-07-17T00:00:00.000Z',
      idempotencyKey: 'blocked-source-assessment-001',
    }, 'lineage'],
    ['/workflow/7/approval', { decision: 'approved' }, 'core'],
    ['/discover', {}, 'core'],
    ['/radar/workspace-actions', {
      signalId: 'blocked-radar-action',
      action: 'save',
      signalTopic: 'Must stay read-only',
    }, 'core'],
    ['/script', { topic: 'Blocked save', saveToIdeas: true }, 'core'],
    ['/variant-feedback', {
      topic: 'Blocked approved script',
      variantText: 'No durable delta is allowed.',
      variantKind: 'script',
      sentiment: 'approved',
    }, 'core'],
  ])('blocks canonical-store writes through the older %s route', async (path, body, slice) => {
    const method = path === '/topics/7' ? 'PATCH' : 'POST';
    const response = await dispatch(method, path, body);

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'CONTENT_WORKSPACE_WRITE_DISABLED',
        details: { writeSlice: slice, mode: 'read_only' },
      },
    });
  });
});

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  response: Response;
}

async function dispatch(method: string, path: string, body: Record<string, unknown> = {
  itemType: 'content_item',
  title: 'Must not write',
}): Promise<MockResponse> {
  const state = mockResponse();
  const req = {
    method,
    url: path,
    originalUrl: `/api/v1/content${path}`,
    baseUrl: '/api/v1/content',
    path,
    query: {},
    params: {},
    headers: {},
    body,
    userId: 51,
    tenantId: 51,
    header() { return undefined; },
  } as unknown as Request;

  await new Promise<void>((resolve, reject) => {
    (contentRoutes() as any).handle(req, state.response, (error: unknown) => {
      if (error) reject(error);
      else resolve();
    });
    setImmediate(resolve);
  });
  return state;
}

function mockResponse(): MockResponse {
  const state = {
    statusCode: 200,
    body: null as any,
    headers: {} as Record<string, string>,
    response: null as unknown as Response,
  };
  state.response = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    send(body: unknown) { state.body = body; return this; },
    end() { return this; },
    setHeader(name: string, value: string) { state.headers[name.toLowerCase()] = String(value); },
    getHeader(name: string) { return state.headers[name.toLowerCase()]; },
  } as unknown as Response;
  return state;
}

function restore(key: string, value: string | undefined): void {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

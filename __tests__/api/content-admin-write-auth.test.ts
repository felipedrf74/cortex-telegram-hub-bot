import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';

let portalTokenValue = '';
let portalReadTokenValue = '';
let portalWriteTokenValue = '';
let portalAllowLegacyFallback = false;
let portalAllowLocalBypass = false;
const mockDbAll = vi.fn();
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();

vi.mock('../../src/config', () => ({
  config: {
    get portal() {
      return {
        token: portalTokenValue,
        readToken: portalReadTokenValue,
        writeToken: portalWriteTokenValue,
        allowLegacyFallback: portalAllowLegacyFallback,
        allowLocalBypass: portalAllowLocalBypass,
      };
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      all: (...args: unknown[]) => mockDbAll(...args),
      get: (...args: unknown[]) => mockDbGet(...args),
      run: (...args: unknown[]) => mockDbRun(...args),
    }),
  }),
}));

async function fetchJson(
  app: express.Express,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to start test server'));
        return;
      }

      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: url,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
            ...(headers || {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode || 0,
              body: data ? JSON.parse(data) : null,
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('content admin write auth scopes', () => {
  beforeEach(() => {
    portalTokenValue = '';
    portalReadTokenValue = '';
    portalWriteTokenValue = '';
    portalAllowLegacyFallback = false;
    portalAllowLocalBypass = false;
    mockDbAll.mockReset();
    mockDbGet.mockReset();
    mockDbRun.mockReset();
    mockDbAll.mockReturnValue([]);
    mockDbGet.mockReturnValue(undefined);
    mockDbRun.mockReturnValue({ changes: 0, lastInsertRowid: 1 });
  });

  it('accepts a read token on GET routes but rejects it on mutations', async () => {
    portalReadTokenValue = 'portal-read-token';
    portalWriteTokenValue = 'portal-write-token';

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const readRes = await fetchJson(app, 'GET', '/api/v1/admin/content/pillars', undefined, {
      Authorization: 'Bearer portal-read-token',
    });
    expect(readRes.status).toBe(200);
    expect(readRes.body.ok).toBe(true);

    const rejectedMutation = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/channels',
      {},
      { Authorization: 'Bearer portal-read-token' },
    );
    expect(rejectedMutation.status).toBe(401);
    expect(rejectedMutation.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal write token',
      },
    });

    const writeRes = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/channels',
      {},
      { Authorization: 'Bearer portal-write-token' },
    );
    expect(writeRes.status).toBe(400);
    expect(writeRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'url is required',
      },
    });
  });

  it('keeps the legacy full-access portal token backward compatible when no scoped tokens are configured', async () => {
    portalTokenValue = 'legacy-portal-token';

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/channels',
      {},
      { Authorization: 'Bearer legacy-portal-token' },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects the legacy full-access portal token on mutations once scoped tokens are configured', async () => {
    portalTokenValue = 'legacy-portal-token';
    portalReadTokenValue = 'portal-read-token';
    portalWriteTokenValue = 'portal-write-token';

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/channels',
      {},
      { Authorization: 'Bearer legacy-portal-token' },
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid portal write token',
      },
    });
  });

  it('allows the legacy full-access portal token during scoped-token migration only when fallback is enabled', async () => {
    portalTokenValue = 'legacy-portal-token';
    portalReadTokenValue = 'portal-read-token';
    portalWriteTokenValue = 'portal-write-token';
    portalAllowLegacyFallback = true;

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/channels',
      {},
      { Authorization: 'Bearer legacy-portal-token' },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('sanitizes portal admin write failures instead of leaking internals', async () => {
    portalWriteTokenValue = 'portal-write-token';
    mockDbAll.mockImplementationOnce(() => {
      throw new Error('content admin sqlite exploded');
    });

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/content/pillars',
      undefined,
      { Authorization: 'Bearer portal-write-token' },
    );
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to list pillars');
    expect(JSON.stringify(res.body)).not.toContain('sqlite exploded');
  });
});

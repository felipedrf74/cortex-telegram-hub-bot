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
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({
      all: (...args: unknown[]) => mockDbAll(...args),
      get: (...args: unknown[]) => mockDbGet(...args),
      run: (...args: unknown[]) => mockDbRun(...args),
    }),
  }),
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

// AUTH-O12 (closed-beta-auth-hardening, 2026-05-04): the portal token
// enforcement now emits `portal.auth` audit rows on every branch
// (success / failure with typed reasons). Without this stub, those
// audit-trail INSERTs would route into the same generic `mockDbRun`
// spy below and pollute the route-level scope assertions. Stubbing
// `logAudit` keeps the spy focused on actual route DB writes.
vi.mock('../../src/services/audit-trail', () => ({
  logAudit: vi.fn(),
}));

async function fetchJson(
  app: express.Express,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

    const readRes = await fetchJson(app, 'GET', '/api/v1/admin/content/pillars?userId=1&tenantId=1', undefined, {
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
        message: 'userId is required for tenant-scoped Content portal writes',
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

  it('rejects portal attempts to mark reference channels as creator-owned without server-verified OAuth', async () => {
    portalWriteTokenValue = 'portal-write-token';

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/channels',
      {
        userId: 7,
        tenantId: 7,
        url: 'https://youtube.com/@owner-claim',
        addedVia: 'youtube_oauth',
      },
      { Authorization: 'Bearer portal-write-token' },
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'OWNED_CHANNEL_REQUIRES_OAUTH',
      },
    });
    expect(mockDbRun).not.toHaveBeenCalled();
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
      '/api/v1/admin/content/pillars?userId=7&tenantId=7',
      undefined,
      { Authorization: 'Bearer portal-write-token' },
    );
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Failed to list pillars');
    expect(JSON.stringify(res.body)).not.toContain('sqlite exploded');
  });

  it('requires explicit user scope for portal content link management', async () => {
    portalReadTokenValue = 'portal-read-token';

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/content/links',
      undefined,
      { Authorization: 'Bearer portal-read-token' },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'userId is required for tenant-scoped Content portal writes',
    });
    expect(mockDbAll).not.toHaveBeenCalled();
  });

  it('lists portal content links through tenant/user scoped predicates', async () => {
    portalReadTokenValue = 'portal-read-token';
    mockDbAll.mockReturnValueOnce([{ id: 12, title: 'Scoped link', url: 'https://example.test' }]);

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/content/links?userId=7&tenantId=70',
      undefined,
      { Authorization: 'Bearer portal-read-token' },
    );

    expect(res.status).toBe(200);
    expect(res.body.links).toEqual([{ id: 12, title: 'Scoped link', url: 'https://example.test' }]);
    expect(mockDbAll).toHaveBeenCalledWith(70, 7, 70);
  });

  it('upserts portal content links with tenant/user ownership metadata', async () => {
    portalWriteTokenValue = 'portal-write-token';
    mockDbRun.mockReturnValueOnce({ changes: 1, lastInsertRowid: 99 });

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/links',
      {
        userId: 7,
        tenantId: 70,
        title: 'Scoped research link',
        url: 'https://example.test/research',
        topicTags: ['training', 'content'],
      },
      { Authorization: 'Bearer portal-write-token' },
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(99);
    const args = mockDbRun.mock.calls[0];
    expect(args[0]).toBe(70);
    expect(args[1]).toBe(7);
    expect(args[2]).toBe('user_private');
    expect(args[3]).toBe('active');
    expect(args[4]).toBe('https://example.test/research');
    expect(args[5]).toBe('Scoped research link');
    expect(args[13]).toBe(JSON.stringify(['training', 'content']));
  });

  it('deletes portal content links only inside the requested tenant/user scope', async () => {
    portalWriteTokenValue = 'portal-write-token';
    mockDbRun.mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'DELETE',
      '/api/v1/admin/content/links/123?userId=7&tenantId=70',
      undefined,
      { Authorization: 'Bearer portal-write-token' },
    );

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Link not found in requested scope');
    expect(mockDbRun).toHaveBeenCalledWith(123, 70, 7, 70);
  });

  it('lists portal provenance only through tenant/user scoped predicates', async () => {
    portalReadTokenValue = 'portal-read-token';
    mockDbAll.mockReturnValueOnce([{
      id: 1,
      tenant_id: 70,
      owner_user_id: 7,
      output_object_type: 'script',
      output_id: 'draft-1',
      grounding_status: 'grounded',
      references_used_json: '[{"referenceId":"book:12"}]',
      claims_json: '[]',
      unsupported_claims_json: '[]',
      review_required: 0,
      generated_from_radar_signal_id: null,
      reused_from_content_id: null,
    }]);

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/content/provenance?userId=7&tenantId=70&objectType=script&objectId=draft-1',
      undefined,
      { Authorization: 'Bearer portal-read-token' },
    );

    expect(res.status).toBe(200);
    expect(res.body.provenance[0]).toMatchObject({
      tenantId: 70,
      ownerUserId: 7,
      outputObjectType: 'script',
      outputId: 'draft-1',
      groundingStatus: 'grounded',
    });
    expect(mockDbAll).toHaveBeenCalledWith(70, 7, 70, 'script', 'draft-1', 10);
  });

  it('builds a scoped portal provenance review pack with source links and reuse lineage', async () => {
    portalReadTokenValue = 'portal-read-token';
    mockDbAll
      .mockReturnValueOnce([{
        id: 1,
        tenant_id: 70,
        owner_user_id: 7,
        output_object_type: 'script',
        output_id: 'draft-1',
        grounding_status: 'partially_grounded',
        references_used_json: '[]',
        claims_json: '[]',
        unsupported_claims_json: '[{"id":"claim-1"}]',
        review_required: 1,
        generated_from_radar_signal_id: null,
        reused_from_content_id: null,
      }])
      .mockReturnValueOnce([{
        id: 2,
        tenant_id: 70,
        owner_user_id: 7,
        source_type: 'book',
        source_id: 'book:12',
        output_object_type: 'script',
        output_id: 'draft-1',
        usage_type: 'evidence',
        attribution_text: 'Scoped book',
        claim_ids_json: '["claim-1"]',
        evidence_ids_json: '["quote-1"]',
        confidence: 0.8,
        created_at: '2026-04-29T00:00:00Z',
      }])
      .mockReturnValueOnce([{
        id: 3,
        reuse_id: 'reuse-1',
        tenant_id: 70,
        owner_user_id: 7,
        original_content_id: 'draft-1',
        reused_content_id: 'short-1',
        original_artifact_type: 'script',
        reused_artifact_type: 'short',
        transformation_type: 'youtube_to_shorts',
        from_platform_id: 'youtube_long',
        to_platform_id: 'youtube_shorts',
        references_preserved_json: '["book:12"]',
        references_changed_json: '[]',
        novelty_score: 0.72,
        reason_codes_json: '["intentional_repurpose"]',
        status: 'created',
        created_at: '2026-04-29T00:00:00Z',
        updated_at: '2026-04-29T00:00:00Z',
      }]);

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/content/provenance/review-pack?userId=7&tenantId=70&objectType=script&objectId=draft-1',
      undefined,
      { Authorization: 'Bearer portal-read-token' },
    );

    expect(res.status).toBe(200);
    expect(res.body.reviewPack.requiresHumanReview).toBe(true);
    expect(res.body.reviewPack.sourceLinks[0]).toMatchObject({ sourceId: 'book:12', usageType: 'evidence' });
    expect(res.body.reviewPack.reuseLineage[0]).toMatchObject({ originalContentId: 'draft-1', reusedContentId: 'short-1' });
    expect(mockDbAll).toHaveBeenNthCalledWith(1, 70, 7, 70, 'script', 'draft-1', 10);
    expect(mockDbAll).toHaveBeenNthCalledWith(2, 70, 7, 70, 'script', 'draft-1', 100);
    expect(mockDbAll).toHaveBeenNthCalledWith(3, 70, 7, 70, 'draft-1', 'draft-1', 50);
  });

  it('lists scoped reuse lineage by original or reused content id', async () => {
    portalReadTokenValue = 'portal-read-token';
    mockDbAll.mockReturnValueOnce([{
      id: 3,
      reuse_id: 'reuse-1',
      tenant_id: 70,
      owner_user_id: 7,
      original_content_id: 'draft-1',
      reused_content_id: 'short-1',
      original_artifact_type: 'script',
      reused_artifact_type: 'short',
      transformation_type: 'youtube_to_shorts',
      from_platform_id: 'youtube_long',
      to_platform_id: 'youtube_shorts',
      references_preserved_json: '["book:12"]',
      references_changed_json: '[]',
      novelty_score: 0.72,
      reason_codes_json: '[]',
      status: 'created',
      created_at: '2026-04-29T00:00:00Z',
      updated_at: '2026-04-29T00:00:00Z',
    }]);

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'GET',
      '/api/v1/admin/content/reuse-history?userId=7&tenantId=70&objectId=short-1',
      undefined,
      { Authorization: 'Bearer portal-read-token' },
    );

    expect(res.status).toBe(200);
    expect(res.body.reuseHistory[0]).toMatchObject({ originalContentId: 'draft-1', reusedContentId: 'short-1' });
    expect(mockDbAll).toHaveBeenCalledWith(70, 7, 70, 'short-1', 'short-1', 50);
  });

  it('compares a portal candidate against scoped historical content without recording by default', async () => {
    portalWriteTokenValue = 'portal-write-token';
    mockDbAll.mockReturnValueOnce([{
      id: 9,
      candidate_id: 'content_candidate_existing',
      tenant_id: 70,
      owner_user_id: 7,
      visibility_scope: 'user_private',
      artifact_type: 'idea',
      title: 'Build discipline through consistent training',
      body: null,
      hook: 'Discipline is built in boring repeats',
      caption: null,
      topic: 'training consistency',
      angle: 'discipline from repetition',
      platform_id: 'linkedin',
      format_id: 'post',
      audience: 'creators',
      content_pillar: 'training',
      reference_ids_json: '["book:12"]',
      source_radar_signal_id: null,
      series_id: null,
      reuse_intent: 'none',
      original_content_id: null,
      transformation_type: null,
      novelty_score: 0.5,
      duplication_risk_score: 0.4,
      lifecycle_state: 'active',
      reason_codes_json: '[]',
      review_warnings_json: '[]',
      created_at: '2026-04-29T00:00:00Z',
      updated_at: '2026-04-29T00:00:00Z',
    }]);

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/historical-comparison',
      {
        userId: 7,
        tenantId: 70,
        artifactType: 'idea',
        title: 'Build discipline through consistent training',
        topic: 'training consistency',
        platformId: 'linkedin',
        formatId: 'post',
        referenceIds: ['book:12'],
      },
      { Authorization: 'Bearer portal-write-token' },
    );

    expect(res.status).toBe(200);
    expect(res.body.comparison.decision.status).toBe('near_duplicate');
    expect(res.body.comparison.recordedCandidate).toBeNull();
    expect(res.body.comparison.portalHints).toContain('Portal action: request a new angle before approval or scheduling.');
    expect(mockDbAll).toHaveBeenCalledWith(70, 7, 70);
    expect(mockDbRun).not.toHaveBeenCalled();
  });

  it('deletes portal content channels only inside the requested tenant/user scope', async () => {
    portalWriteTokenValue = 'portal-write-token';
    mockDbRun
      .mockReturnValueOnce({ changes: 2, lastInsertRowid: 0 })
      .mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'DELETE',
      '/api/v1/admin/content/channels/44?userId=7&tenantId=70',
      undefined,
      { Authorization: 'Bearer portal-write-token' },
    );

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Channel not found in requested scope');
    expect(mockDbRun).toHaveBeenNthCalledWith(1, 44, 70, 7, 70);
    expect(mockDbRun).toHaveBeenNthCalledWith(2, 44, 70, 7, 70);
  });

  it('deletes portal content books only inside the requested tenant/user scope', async () => {
    portalWriteTokenValue = 'portal-write-token';
    mockDbRun.mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'DELETE',
      '/api/v1/admin/content/books/55?userId=7&tenantId=70',
      undefined,
      { Authorization: 'Bearer portal-write-token' },
    );

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Book not found in requested scope');
    expect(mockDbRun).toHaveBeenCalledWith(55, 70, 7, 70);
  });

  it('updates portal voice DNA only inside the requested tenant/user scope', async () => {
    portalWriteTokenValue = 'portal-write-token';
    mockDbRun.mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'PATCH',
      '/api/v1/admin/content/voice-dna/66?userId=7&tenantId=70',
      { payload: 'More direct and specific.' },
      { Authorization: 'Bearer portal-write-token' },
    );

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Voice DNA entry not found in requested scope');
    expect(mockDbRun).toHaveBeenCalledWith('More direct and specific.', 66, 70, 7, 70);
  });

  it('blocks tenant-scoped portal voice synthesis until the agent accepts explicit scope', async () => {
    portalWriteTokenValue = 'portal-write-token';

    const { contentAdminWriteRoutes } = await import('../../src/api/routes/content-admin-write');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/admin/content', contentAdminWriteRoutes());

    const res = await fetchJson(
      app,
      'POST',
      '/api/v1/admin/content/voice-dna/synthesize',
      { userId: 7, tenantId: 70 },
      { Authorization: 'Bearer portal-write-token' },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'UNSUPPORTED_SCOPE',
      message: 'Tenant-scoped portal voice synthesis is disabled until the voice evolution agent accepts explicit tenant/user scope',
    });
    expect(mockDbRun).not.toHaveBeenCalled();
  });
});

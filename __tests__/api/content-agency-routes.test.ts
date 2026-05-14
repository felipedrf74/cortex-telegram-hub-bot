import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerContentAgencyRoutes } from '../../src/api/routes/content-agency-routes';
import { ensureContentAgencyTables } from '../../src/services/content-agency';

interface MockRes {
  statusCode: number;
  body: any;
  headersSent: boolean;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; response.headersSent = true; return response; },
  };
  return response;
}

function mockReq(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = 501,
  tenantId: number | undefined = 101,
): Request {
  return {
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
    header(name: string) {
      return (this.headers as any)[name.toLowerCase()] ?? (this.headers as any)[name];
    },
  } as any;
}

function makeEnsureValidScope() {
  return vi.fn((
    res: Response,
    userId: number | undefined,
  ): userId is number => {
    if (typeof userId === 'number' && userId > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid authenticated user scope' } });
    return false;
  });
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = 501,
  tenantId: number | undefined = 101,
  ensureValidScope = makeEnsureValidScope(),
): Promise<{ response: MockRes; ensureValidScope: ReturnType<typeof makeEnsureValidScope> }> {
  const router = Router();
  registerContentAgencyRoutes(router, ensureValidScope);
  const req = mockReq(method, path, body, userId, tenantId);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });

  return { response: res, ensureValidScope };
}

function expectAgencyContract(contract: any, overrides: Record<string, unknown> = {}) {
  expect(contract).toMatchObject({
    tenantId: expect.any(Number),
    userId: expect.any(Number),
    visibilityScope: expect.any(String),
    platform: expect.any(String),
    format: expect.any(String),
    objective: expect.any(String),
    sourceTrace: expect.any(Array),
    referenceIds: expect.any(Array),
    confidence: expect.any(Number),
    warnings: expect.any(Array),
    blockers: expect.any(Array),
    reviewRequired: expect.any(Boolean),
    nextBestActions: expect.any(Array),
    ...overrides,
  });
  expect(contract.confidence).toBeGreaterThanOrEqual(0);
  expect(contract.confidence).toBeLessThanOrEqual(1);
}

describe('content agency routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    ensureContentAgencyTables(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns the scoped reference registry readiness contract', async () => {
    const { response, ensureValidScope } = await dispatch('GET', '/agency/rules');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.coverage.valid).toBe(true);
    expect(response.body.data.runtimeCoverage.valid).toBe(true);
    expect(response.body.data.runtimeCoverage.missingCategories).toEqual([]);
    expect(response.body.data.readiness.valid).toBe(true);
    expect(response.body.data.rules.length).toBeGreaterThanOrEqual(10);
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 501, 'content_agency_rules_read');
  });

  it('creates a scoped brief and persists it without leaking to another tenant', async () => {
    const { response } = await dispatch('POST', '/agency/brief', {
      goal: 'build a YouTube content system',
      audience: 'technical founders',
      offer: 'download an operator checklist',
      platform: 'YouTube',
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.brief).toMatchObject({
      tenantId: 101,
      userId: 501,
      platform: 'youtube',
    });
    expectAgencyContract(response.body.data.contract, {
      tenantId: 101,
      userId: 501,
      platform: 'youtube',
      objective: 'build a YouTube content system',
    });
    const rows = testDb.prepare('SELECT user_id, tenant_id, agency_id FROM content_agency_briefs').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 501, tenant_id: 101, agency_id: response.body.data.brief.id });
  });

  it('creates an agency package, scores it, and reads it back only for the owning scope', async () => {
    const create = await dispatch('POST', '/agency/package', {
      brief: {
        goal: 'create a TikTok concept for creator operations',
        audience: 'solo operators who publish educational content',
        offer: 'join a workshop',
        platform: 'TikTok',
      },
      competitors: [
        {
          title: 'Why creators stall',
          transcript: 'Creators stall because the intro has no tension. Here are 3 fixes and a proof example. Save this.',
          url: 'https://example.test/creator-stall',
        },
      ],
      transcript: 'Creators stall because the intro has no tension. But one proof beat before the midpoint changes retention. Save this checklist.',
    });

    expect(create.response.statusCode).toBe(201);
    expect(create.response.body.ok).toBe(true);
    const pkg = create.response.body.data.package;
    expectAgencyContract(create.response.body.data.contract, {
      tenantId: 101,
      userId: 501,
      platform: 'tiktok',
      objective: 'create a TikTok concept for creator operations',
      qualityScore: pkg.quality.score,
    });
    expect(pkg.tenantId).toBe(101);
    expect(pkg.userId).toBe(501);
    expect(pkg.platform).toBe('tiktok');
    expect(pkg.blockers).toEqual([]);
    expect(pkg.quality.score).toBeGreaterThanOrEqual(75);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_agency_packages').get()).toMatchObject({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_compliance_reviews').get()).toMatchObject({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_experiment_runs').get()).toMatchObject({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_agency_quality_reviews').get()).toMatchObject({ count: 1 });

    const score = await dispatch('POST', '/agency/score', { package: pkg });
    expect(score.response.statusCode).toBe(200);
    expect(score.response.body.data.quality.status).not.toBe('blocked');
    expectAgencyContract(score.response.body.data.contract, {
      tenantId: 101,
      userId: 501,
      platform: 'tiktok',
      qualityScore: score.response.body.data.quality.score,
    });

    const owned = await dispatch('GET', `/agency/projects/${pkg.id}`);
    const wrongTenant = await dispatch('GET', `/agency/projects/${pkg.id}`, {}, 501, 202);

    expect(owned.response.statusCode).toBe(200);
    expect(owned.response.body.data.kind).toBe('package');
    expect(owned.response.body.data.artifact.id).toBe(pkg.id);
    expectAgencyContract(owned.response.body.data.contract, {
      tenantId: 101,
      userId: 501,
      platform: 'tiktok',
      qualityScore: pkg.quality.score,
    });
    expect(wrongTenant.response.statusCode).toBe(404);
  });

  it('returns shared response contracts for competitor and transcript studies', async () => {
    const brief = {
      goal: 'study creator retention patterns',
      audience: 'B2B creator founders',
      offer: 'download the planning worksheet',
      platform: 'YouTube Shorts',
    };

    const competitor = await dispatch('POST', '/agency/competitor-study', {
      brief,
      competitors: [{
        title: 'Retention repair',
        transcript: 'The first mistake is a slow intro. Here are 3 fixes with proof.',
        url: 'https://example.test/retention',
      }],
    });
    expect(competitor.response.statusCode).toBe(201);
    expect(competitor.response.body.data.study.patterns.length).toBeGreaterThan(0);
    expectAgencyContract(competitor.response.body.data.contract, {
      tenantId: 101,
      userId: 501,
      platform: 'youtube_shorts',
      objective: 'study creator retention patterns',
    });

    const transcript = await dispatch('POST', '/agency/transcript-study', {
      brief,
      title: 'Proof-first short',
      transcript: 'Why does retention drop? Because the intro delays proof. Show the result first, then ask people to save it.',
    });
    expect(transcript.response.statusCode).toBe(201);
    expect(transcript.response.body.data.study.retentionDevices.length).toBeGreaterThan(0);
    expectAgencyContract(transcript.response.body.data.contract, {
      tenantId: 101,
      userId: 501,
      platform: 'youtube_shorts',
      objective: 'study creator retention patterns',
    });
  });

  it('moves an approved agency package into the existing content pipeline once and with scope', async () => {
    const create = await dispatch('POST', '/agency/package', {
      brief: {
        goal: 'create a YouTube series for founder operations',
        audience: 'technical founders building solo teams',
        offer: 'join the operator workshop',
        platform: 'YouTube',
      },
      competitors: [
        {
          title: 'Founder operating system',
          transcript: 'The hook names a pain, shows proof, and closes with one workshop action.',
        },
      ],
    });
    const pkg = create.response.body.data.package;
    expect(pkg.blockers).toEqual([]);

    const handoff = await dispatch('POST', `/agency/projects/${pkg.id}/handoff`);
    expect(handoff.response.statusCode).toBe(201);
    expect(handoff.response.body.data.handoff).toMatchObject({
      status: 'created',
      packageId: pkg.id,
      blockers: [],
    });
    expectAgencyContract(handoff.response.body.data.contract, {
      tenantId: 101,
      userId: 501,
      reviewRequired: false,
    });
    expect(handoff.response.body.data.handoff.pipelineId).toEqual(expect.any(Number));
    expect(handoff.response.body.data.handoff.sourceTrace).toContain('content_pipeline read-back verified');

    const rows = testDb.prepare(`
      SELECT topic_title, user_id, tenant_id, owner_user_id, visibility_scope, approval_state, source_agency_package_id
        FROM content_pipeline
    `).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 501,
      tenant_id: 101,
      owner_user_id: 501,
      visibility_scope: 'user_private',
      approval_state: 'approved',
      source_agency_package_id: pkg.id,
    });
    expect(rows[0].topic_title).toContain('Agency:');

    const again = await dispatch('POST', `/agency/projects/${pkg.id}/handoff`);
    expect(again.response.statusCode).toBe(200);
    expect(again.response.body.data.handoff).toMatchObject({
      status: 'already_exists',
      pipelineId: handoff.response.body.data.handoff.pipelineId,
    });
  });

  it('blocks pipeline handoff when compliance blockers remain', async () => {
    const create = await dispatch('POST', '/agency/package', {
      brief: {
        goal: 'sell a sponsored tool with a TikTok concept',
        audience: 'solo creators',
        offer: 'sponsored download',
        platform: 'TikTok',
      },
      brandedContent: true,
    });
    const pkg = create.response.body.data.package;
    expect(pkg.blockers).toContain('sponsored_or_branded_content_requires_clear_disclosure');

    const handoff = await dispatch('POST', `/agency/projects/${pkg.id}/handoff`);
    expect(handoff.response.statusCode).toBe(409);
    expect(handoff.response.body.error.code).toBe('CONTENT_AGENCY_HANDOFF_BLOCKED');
    expectAgencyContract(handoff.response.body.error.details.contract, {
      tenantId: 101,
      userId: 501,
      reviewRequired: true,
    });
    expect(handoff.response.body.error.details.contract.blockers).toContain('sponsored_or_branded_content_requires_clear_disclosure');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_pipeline').get()).toMatchObject({ count: 0 });
  });
});

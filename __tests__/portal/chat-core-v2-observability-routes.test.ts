import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  getDb: vi.fn(),
  decideChatV2HumanReview: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', () => ({
  recordPortalAuthAudit: vi.fn(),
  allowLocalHealthBypass: vi.fn(),
  allowLocalPortalBypass: vi.fn(),
  bearerTokenMatches: vi.fn(),
  computePortalActorSignature: vi.fn(),
  createPortalSessionToken: vi.fn(),
  extractBearerToken: vi.fn(),
  extractPortalActorHint: vi.fn(),
  getPortalAuthContext: vi.fn(),
  isLoopbackRequest: vi.fn(),
  requirePortalAdminToken: mocks.requirePortalAdminToken,
  requirePortalToken: vi.fn(),
  requirePortalTokenByMethod: vi.fn(),
  requirePortalWriteToken: vi.fn(),
  secureSecretMatches: vi.fn(),
  verifyPortalActorSignature: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mocks.getDb(...args),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/chat-core-v2/human-review-queue', () => ({
  decideChatV2HumanReview: (...args: unknown[]) => mocks.decideChatV2HumanReview(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mocks.sendPortalInternalError(...args),
}));

import Database from 'better-sqlite3';
import {
  registerPortalChatCoreV2ObservabilityRoutes,
  scrubFailureSummary,
  CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE,
  CHAT_CORE_V2_FAILURE_EVENTS_ROUTE,
  CHAT_CORE_V2_EVAL_SAMPLES_ROUTE,
  CHAT_CORE_V2_HUMAN_REVIEW_DECIDE_ROUTE,
} from '../../src/portal/chat-core-v2-observability-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;

function makeApp() {
  const getRoutes = new Map<string, Handler[]>();
  const postRoutes = new Map<string, Handler[]>();
  return {
    getRoutes,
    postRoutes,
    app: {
      get: vi.fn((route: string, ...handlers: Handler[]) => {
        getRoutes.set(route, handlers);
      }),
      post: vi.fn((route: string, ...handlers: Handler[]) => {
        postRoutes.set(route, handlers);
      }),
    },
  };
}

function makeResponse() {
  const payload = { statusCode: 200, body: undefined as unknown };
  const res: any = {
    status: vi.fn((code: number) => {
      payload.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      payload.body = body;
      return res;
    }),
  };
  return { payload, res };
}

/** Build a fresh in-memory DB with the three observability tables. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chat_v2_auto_revert_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      actions_json TEXT NOT NULL DEFAULT '[]',
      affected_languages_json TEXT NOT NULL DEFAULT '[]',
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      metrics_snapshot_json TEXT NOT NULL DEFAULT '{}',
      decided_at TEXT NOT NULL
    );
    CREATE TABLE chat_v2_trace_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_span_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      parent_span_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      retention_policy TEXT NOT NULL,
      redacted_summary TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT
    );
    CREATE TABLE chat_v2_online_eval_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      replay_bundle_id TEXT,
      route_method TEXT NOT NULL,
      domain TEXT,
      risk TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      reason TEXT NOT NULL,
      sample_rate REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function registerOn(env: Record<string, string>) {
  const harness = makeApp();
  registerPortalChatCoreV2ObservabilityRoutes(harness.app as any, env as any);
  return harness;
}

function getHandler(routes: Map<string, Handler[]>, route: string): Handler {
  const handlers = routes.get(route);
  if (!handlers) throw new Error(`route not registered: ${route}`);
  return handlers.at(-1)!;
}

describe('portal chat-core-v2 observability routes (WP-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePortalAdminToken.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
  });

  // --- KILL-SWITCH (default-off) ------------------------------------------

  it('does NOT register any route when mode=off (requests 404)', () => {
    const { app, getRoutes, postRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off' });
    expect(app.get).not.toHaveBeenCalled();
    expect(app.post).not.toHaveBeenCalled();
    expect(getRoutes.size).toBe(0);
    expect(postRoutes.size).toBe(0);
  });

  it('does NOT register any route when the mode env var is absent (default-off)', () => {
    const { app } = registerOn({});
    expect(app.get).not.toHaveBeenCalled();
    expect(app.post).not.toHaveBeenCalled();
  });

  it('registers all four admin-protected routes when mode != off', () => {
    const { app, getRoutes, postRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow' });

    for (const route of [
      CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE,
      CHAT_CORE_V2_FAILURE_EVENTS_ROUTE,
      CHAT_CORE_V2_EVAL_SAMPLES_ROUTE,
    ]) {
      expect(getRoutes.get(route)?.[0]).toBe(mocks.requirePortalAdminToken);
    }
    expect(postRoutes.get(CHAT_CORE_V2_HUMAN_REVIEW_DECIDE_ROUTE)?.[0]).toBe(mocks.requirePortalAdminToken);
    expect(app.get).toHaveBeenCalledTimes(3);
    expect(app.post).toHaveBeenCalledTimes(1);
  });

  // --- ZERO-ROW HONEST EMPTY ENVELOPES ------------------------------------

  it('returns 200 honest empty envelopes when tables exist but are empty', () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db);
    const { getRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' });

    for (const route of [
      CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE,
      CHAT_CORE_V2_FAILURE_EVENTS_ROUTE,
      CHAT_CORE_V2_EVAL_SAMPLES_ROUTE,
    ]) {
      const { payload, res } = makeResponse();
      getHandler(getRoutes, route)({ query: {} }, res);
      expect(payload.statusCode).toBe(200);
      expect(payload.body).toEqual({ ok: true, rows: [] });
    }
  });

  it('returns 200 honest empty envelopes (no 500) when a table does not exist', () => {
    const db = new Database(':memory:'); // NO tables created
    mocks.getDb.mockReturnValue(db);
    const { getRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on' });

    for (const route of [
      CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE,
      CHAT_CORE_V2_FAILURE_EVENTS_ROUTE,
      CHAT_CORE_V2_EVAL_SAMPLES_ROUTE,
    ]) {
      const { payload, res } = makeResponse();
      getHandler(getRoutes, route)({ query: {} }, res);
      expect(payload.statusCode).toBe(200);
      expect(payload.body).toEqual({ ok: true, rows: [] });
    }
    expect(mocks.sendPortalInternalError).not.toHaveBeenCalled();
  });

  // --- SEEDED-ROW PROJECTIONS ---------------------------------------------

  it('projects auto-revert decisions with tenant_id + safe scalar fields', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO chat_v2_auto_revert_decisions
        (tenant_id, actions_json, affected_languages_json, reason_codes_json, metrics_snapshot_json, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'tenant-7',
      JSON.stringify([{ type: 'force_shadow' }]),
      JSON.stringify(['en', 'pt']),
      JSON.stringify(['recall_drop']),
      JSON.stringify({ recallAt8: 0.71, failures: 4 }),
      '2026-05-30T10:00:00.000Z',
    );
    mocks.getDb.mockReturnValue(db);
    const { getRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' });

    const { payload, res } = makeResponse();
    getHandler(getRoutes, CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE)({ query: {} }, res);

    expect(payload.statusCode).toBe(200);
    const body = payload.body as any;
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toEqual({
      id: 1,
      tenantId: 'tenant-7',
      actions: [{ type: 'force_shadow' }],
      affectedLanguages: ['en', 'pt'],
      reasonCodes: ['recall_drop'],
      metricsSnapshot: { recallAt8: 0.71, failures: 4 },
      decidedAt: '2026-05-30T10:00:00.000Z',
    });
  });

  it('projects only failed trace spans with the safe column whitelist', () => {
    const db = makeDb();
    const insert = db.prepare(
      `INSERT INTO chat_v2_trace_spans
        (trace_span_id, turn_id, tenant_id, user_id, kind, name, status, sensitivity,
         retention_policy, redacted_summary, attributes_json, started_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A success span that must be EXCLUDED.
    insert.run('span-ok', 'turn-1', 'tenant-1', 'user-1', 'model', 'composer', 'success',
      'normal', '30d', 'status:success', '{"secret":"x"}', '2026-05-30T10:00:00.000Z', '2026-05-30T10:00:01.000Z', 1000);
    // A failed span that must be INCLUDED.
    insert.run('span-fail', 'turn-2', 'tenant-2', 'user-2', 'model', 'planner', 'failed',
      'normal', '30d', 'status:failed kind:model timeout', '{"raw":"leak"}', '2026-05-30T10:01:00.000Z', null, 5000);
    mocks.getDb.mockReturnValue(db);
    const { getRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow' });

    const { payload, res } = makeResponse();
    getHandler(getRoutes, CHAT_CORE_V2_FAILURE_EVENTS_ROUTE)({ query: {} }, res);

    const body = payload.body as any;
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].traceSpanId).toBe('span-fail');
    expect(body.rows[0].status).toBe('failed');
    expect(body.rows[0].tenantId).toBe('tenant-2');
    // attributes_json is never projected (no key, and the leaked value is absent).
    expect(body.rows[0]).not.toHaveProperty('attributes');
    expect(body.rows[0]).not.toHaveProperty('attributesJson');
    expect(JSON.stringify(body)).not.toContain('leak');
    // user_id is not projected either.
    expect(body.rows[0]).not.toHaveProperty('userId');
  });

  it('projects sampled eval samples and omits metadata_json', () => {
    const db = makeDb();
    const insert = db.prepare(
      `INSERT INTO chat_v2_online_eval_samples
        (sample_id, turn_id, tenant_id, user_id, route_method, domain, risk, sensitivity,
         reason, sample_rate, status, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('s-1', 'turn-1', 'tenant-9', 'user-1', 'orchestrated', 'training', 'low', 'normal',
      'rate_sample', 0.1, 'sampled', '{"prompt":"do my secret thing"}', '2026-05-30T10:00:00.000Z');
    insert.run('s-2', 'turn-2', 'tenant-9', 'user-1', 'orchestrated', 'finance', 'high', 'financial',
      'not_eligible', 0, 'not_sampled', '{"prompt":"other"}', '2026-05-30T10:01:00.000Z');
    mocks.getDb.mockReturnValue(db);
    const { getRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' });

    const { payload, res } = makeResponse();
    getHandler(getRoutes, CHAT_CORE_V2_EVAL_SAMPLES_ROUTE)({ query: {} }, res);

    const body = payload.body as any;
    expect(body.rows).toHaveLength(1); // only the 'sampled' row
    expect(body.rows[0].sampleId).toBe('s-1');
    expect(body.rows[0].status).toBe('sampled');
    expect(body.rows[0].tenantId).toBe('tenant-9');
    expect(body.rows[0]).not.toHaveProperty('metadata');
    expect(body.rows[0]).not.toHaveProperty('metadataJson');
    expect(JSON.stringify(body)).not.toContain('secret thing');
    expect(body.rows[0]).not.toHaveProperty('userId');
  });

  // --- AUTH (handler never runs) ------------------------------------------

  it('401s on every route when the admin guard rejects (data handler never runs)', () => {
    const db = makeDb();
    mocks.getDb.mockReturnValue(db);
    const { getRoutes, postRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow' });

    mocks.requirePortalAdminToken.mockImplementation((_req: unknown, res: any) => {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } });
    });

    for (const route of [
      CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE,
      CHAT_CORE_V2_FAILURE_EVENTS_ROUTE,
      CHAT_CORE_V2_EVAL_SAMPLES_ROUTE,
    ]) {
      const handlers = getRoutes.get(route)!;
      expect(handlers[0]).toBe(mocks.requirePortalAdminToken);
      const { payload, res } = makeResponse();
      let nextCalled = false;
      handlers[0]({ query: {} }, res, () => {
        nextCalled = true;
      });
      expect(payload.statusCode).toBe(401);
      expect(nextCalled).toBe(false);
    }

    const postHandlers = postRoutes.get(CHAT_CORE_V2_HUMAN_REVIEW_DECIDE_ROUTE)!;
    expect(postHandlers[0]).toBe(mocks.requirePortalAdminToken);
    const { payload, res } = makeResponse();
    let nextCalled = false;
    postHandlers[0]({ params: { id: 'hvr:c1' }, body: { decision: 'approve' } }, res, () => {
      nextCalled = true;
    });
    expect(payload.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
    expect(mocks.decideChatV2HumanReview).not.toHaveBeenCalled();
  });

  // --- PRIVACY: redacted_summary scrubbing on FAILED spans ----------------

  it('scrubs a FAILED span redacted_summary that would otherwise leak a message fragment', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO chat_v2_trace_spans
        (trace_span_id, turn_id, tenant_id, user_id, kind, name, status, sensitivity,
         retention_policy, redacted_summary, attributes_json, started_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'span-leak',
      'turn-3',
      'tenant-3',
      'user-3',
      'model',
      'planner',
      'failed',
      'personal',
      '30d',
      // A summary that mixes a safe diagnostic token with a raw user message
      // fragment that ordinary redaction failed to strip.
      'status:failed Please email john.doe@example.com about my divorce settlement and bank PIN 4821',
      '{}',
      '2026-05-30T10:02:00.000Z',
      null,
      5000,
    );
    mocks.getDb.mockReturnValue(db);
    const { getRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on' });

    const { payload, res } = makeResponse();
    getHandler(getRoutes, CHAT_CORE_V2_FAILURE_EVENTS_ROUTE)({ query: {} }, res);

    const body = payload.body as any;
    const serialized = JSON.stringify(body);
    // The raw message fragments must be scrubbed out entirely.
    expect(serialized).not.toContain('divorce');
    expect(serialized).not.toContain('settlement');
    expect(serialized).not.toContain('PIN');
    expect(serialized).not.toContain('4821');
    expect(serialized).not.toContain('john.doe@example.com');
    // The safe structured diagnostic token survives.
    expect(body.rows[0].redactedSummary).toBe('status:failed');
  });

  it('scrubFailureSummary keeps safe diagnostic tokens and drops free text / PII shapes', () => {
    expect(scrubFailureSummary('status:failed kind:model timeout error_class=ETIMEDOUT')).toBe(
      'status:failed kind:model timeout error_class=ETIMEDOUT',
    );
    // Sentences / emails / paths / quotes are dropped.
    expect(scrubFailureSummary('the user asked about their salary')).toBe('[redacted]');
    expect(scrubFailureSummary('contact me at jane@example.com please')).toBe('[redacted]');
    expect(scrubFailureSummary('GET /api/v1/secret?token=abc')).toBe('[redacted]');
    expect(scrubFailureSummary('"raw message text here"')).toBe('[redacted]');
    expect(scrubFailureSummary('')).toBe('[redacted]');
    expect(scrubFailureSummary(null)).toBe('[redacted]');
    // Mixed: only the safe token survives.
    expect(scrubFailureSummary('status:failed call my mother now')).toBe('status:failed');
  });

  // --- REVIEW-DECIDE ACTION ------------------------------------------------

  it('resolves a seeded human review via decideChatV2HumanReview and returns safe fields only', () => {
    mocks.getDb.mockReturnValue({ __db: true });
    mocks.decideChatV2HumanReview.mockReturnValue({
      id: 11,
      reviewId: 'hvr:c1',
      turnId: 'turn-1',
      commandId: 'c1',
      tenantId: 'tenant-1',
      userId: 'user-1', // must NOT be projected
      domain: 'finance',
      reason: 'restricted_finance',
      status: 'approved',
      sensitivity: 'financial',
      redactedSummary: 'restricted_finance command c1', // must NOT be projected
      reviewerUserId: 'admin-9',
      decisionNote: 'looks fine', // must NOT be projected
      metadata: { sensitive: 'do not leak' }, // must NOT be projected
      requestedAt: '2026-05-30T10:00:00.000Z',
      decidedAt: '2026-05-30T10:05:00.000Z',
      expiresAt: '2026-05-31T10:00:00.000Z',
    });
    const { postRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' });

    const { payload, res } = makeResponse();
    getHandler(postRoutes, CHAT_CORE_V2_HUMAN_REVIEW_DECIDE_ROUTE)(
      { params: { id: 'hvr:c1' }, body: { decision: 'approve', reviewerUserId: 'admin-9', decisionNote: 'looks fine' } },
      res,
    );

    expect(mocks.decideChatV2HumanReview).toHaveBeenCalledWith(
      { reviewId: 'hvr:c1', reviewerUserId: 'admin-9', decision: 'approve', decisionNote: 'looks fine' },
      { __db: true },
    );
    expect(payload.statusCode).toBe(200);
    const body = payload.body as any;
    expect(body.ok).toBe(true);
    expect(body.review.status).toBe('approved');
    expect(body.review.tenantId).toBe('tenant-1');
    // Safe-fields-only projection.
    expect(body.review).not.toHaveProperty('userId');
    expect(body.review).not.toHaveProperty('redactedSummary');
    expect(body.review).not.toHaveProperty('decisionNote');
    expect(body.review).not.toHaveProperty('metadata');
    expect(JSON.stringify(body)).not.toContain('do not leak');
  });

  it('400s on an invalid decision input (handler validates before calling the store)', () => {
    mocks.getDb.mockReturnValue({ __db: true });
    const { postRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on' });
    const handler = getHandler(postRoutes, CHAT_CORE_V2_HUMAN_REVIEW_DECIDE_ROUTE);

    const cases: any[] = [
      { params: { id: 'hvr:c1' }, body: { decision: 'nope', reviewerUserId: 'admin-9' } },
      { params: { id: 'hvr:c1' }, body: { reviewerUserId: 'admin-9' } },
      { params: { id: 'hvr:c1' }, body: { decision: 'approve' } }, // missing reviewer
      { params: { id: '   ' }, body: { decision: 'approve', reviewerUserId: 'admin-9' } }, // blank id
    ];
    for (const req of cases) {
      const { payload, res } = makeResponse();
      handler(req, res);
      expect(payload.statusCode).toBe(400);
    }
    expect(mocks.decideChatV2HumanReview).not.toHaveBeenCalled();
  });

  it('409s (not 500) when the store rejects a non-resolvable review', () => {
    mocks.getDb.mockReturnValue({ __db: true });
    mocks.decideChatV2HumanReview.mockImplementation(() => {
      throw new Error('Human review is not pending: hvr:c1');
    });
    const { postRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on' });

    const { payload, res } = makeResponse();
    getHandler(postRoutes, CHAT_CORE_V2_HUMAN_REVIEW_DECIDE_ROUTE)(
      { params: { id: 'hvr:c1' }, body: { decision: 'approve', reviewerUserId: 'admin-9' } },
      res,
    );

    expect(payload.statusCode).toBe(409);
    expect((payload.body as any).error.code).toBe('REVIEW_NOT_RESOLVABLE');
    expect(mocks.sendPortalInternalError).not.toHaveBeenCalled();
  });

  // --- 200-ROW CAP ---------------------------------------------------------

  it('caps each list endpoint at 200 rows', () => {
    const db = makeDb();
    const insertRevert = db.prepare(
      `INSERT INTO chat_v2_auto_revert_decisions (tenant_id, decided_at) VALUES (?, ?)`,
    );
    const insertSpan = db.prepare(
      `INSERT INTO chat_v2_trace_spans
        (trace_span_id, turn_id, tenant_id, user_id, kind, name, status, sensitivity,
         retention_policy, redacted_summary, started_at, duration_ms)
       VALUES (?, ?, ?, ?, 'model', 'planner', 'failed', 'normal', '30d', 'status:failed', ?, 0)`,
    );
    const insertSample = db.prepare(
      `INSERT INTO chat_v2_online_eval_samples
        (sample_id, turn_id, tenant_id, user_id, route_method, risk, sensitivity, reason, status, created_at)
       VALUES (?, ?, 't', 'u', 'orchestrated', 'low', 'normal', 'r', 'sampled', ?)`,
    );
    for (let i = 0; i < 250; i += 1) {
      insertRevert.run('t', `2026-05-30T10:00:00.${String(i).padStart(3, '0')}Z`);
      insertSpan.run(`span-${i}`, `turn-${i}`, 't', 'u', `2026-05-30T10:00:00.${String(i).padStart(3, '0')}Z`);
      insertSample.run(`s-${i}`, `turn-${i}`, `2026-05-30T10:00:00.${String(i).padStart(3, '0')}Z`);
    }
    mocks.getDb.mockReturnValue(db);
    const { getRoutes } = registerOn({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' });

    for (const route of [
      CHAT_CORE_V2_AUTO_REVERT_DECISIONS_ROUTE,
      CHAT_CORE_V2_FAILURE_EVENTS_ROUTE,
      CHAT_CORE_V2_EVAL_SAMPLES_ROUTE,
    ]) {
      const { payload, res } = makeResponse();
      getHandler(getRoutes, route)({ query: {} }, res);
      expect((payload.body as any).rows).toHaveLength(200);
    }
  });
});

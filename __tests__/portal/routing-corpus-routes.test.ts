import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  getDb: vi.fn(),
  getNextPendingRoutingCorpusItem: vi.fn(),
  getRoutingCorpusProgress: vi.fn(),
  getRoutingLabelCandidates: vi.fn(),
  getRoutingCorpusItemById: vi.fn(),
  isCheckedInSyntheticRoutingCorpusItem: vi.fn(),
  labelRoutingCorpusItem: vi.fn(),
  logPortalAdminMutation: vi.fn(),
  insertPortalAdminMutationAuditStrict: vi.fn(),
  getPortalAuthContext: vi.fn(),
  getOwnerBootstrapTarget: vi.fn(),
  isOperatorScopedToUser: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', async () => ({
  ...await vi.importActual<typeof import('../../src/api/secret-guards')>('../../src/api/secret-guards'),
  requirePortalAdminToken: mocks.requirePortalAdminToken,
  getPortalAuthContext: (...args: unknown[]) => mocks.getPortalAuthContext(...args),
}));

vi.mock('../../src/services/database', async () => ({
  ...await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database'),
  getDb: (...args: unknown[]) => mocks.getDb(...args),
}));

vi.mock('../../src/services/routing-corpus', async () => ({
  ...await vi.importActual<typeof import('../../src/services/routing-corpus')>('../../src/services/routing-corpus'),
  getNextPendingRoutingCorpusItem: (...args: unknown[]) => mocks.getNextPendingRoutingCorpusItem(...args),
  getRoutingCorpusProgress: (...args: unknown[]) => mocks.getRoutingCorpusProgress(...args),
  getRoutingLabelCandidates: (...args: unknown[]) => mocks.getRoutingLabelCandidates(...args),
  getRoutingCorpusItemById: (...args: unknown[]) => mocks.getRoutingCorpusItemById(...args),
  isCheckedInSyntheticRoutingCorpusItem: (...args: unknown[]) =>
    mocks.isCheckedInSyntheticRoutingCorpusItem(...args),
  isValidRoutingLabelDomain: (labelDomain: string, candidates: { domains: string[]; specialLabels: string[] }) =>
    candidates.domains.includes(labelDomain) || candidates.specialLabels.includes(labelDomain),
  labelRoutingCorpusItem: (...args: unknown[]) => mocks.labelRoutingCorpusItem(...args),
}));

vi.mock('../../src/services/user-service', async () => ({
  ...await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service'),
  getOwnerBootstrapTarget: (...args: unknown[]) => mocks.getOwnerBootstrapTarget(...args),
}));

vi.mock('../../src/portal/admin-target-user', async () => ({
  ...await vi.importActual<typeof import('../../src/portal/admin-target-user')>('../../src/portal/admin-target-user'),
  isOperatorScopedToUser: (...args: unknown[]) => mocks.isOperatorScopedToUser(...args),
}));

vi.mock('../../src/portal/admin-audit', async () => ({
  ...await vi.importActual<typeof import('../../src/portal/admin-audit')>('../../src/portal/admin-audit'),
  logPortalAdminMutation: (...args: unknown[]) => mocks.logPortalAdminMutation(...args),
  insertPortalAdminMutationAuditStrict: (...args: unknown[]) =>
    mocks.insertPortalAdminMutationAuditStrict(...args),
}));

vi.mock('../../src/portal/http', async () => ({
  ...await vi.importActual<typeof import('../../src/portal/http')>('../../src/portal/http'),
  sendPortalInternalError: (...args: unknown[]) => mocks.sendPortalInternalError(...args),
}));

import { registerPortalRoutingCorpusRoutes } from '../../src/portal/routing-corpus-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;
type TestDb = { __db: true; transaction: ReturnType<typeof vi.fn> };

let routeDb: TestDb;

function makeTestDb(): TestDb {
  return {
    __db: true,
    transaction: vi.fn((work: () => unknown) => ({
      immediate: work,
    })),
  };
}

const CANDIDATES = {
  domains: ['secretary', 'triathlon', 'finance'],
  skills: ['secretary_calendar', 'secretary_reminders', 'mail', 'tasks', 'training', 'finance'],
  skillsByDomain: {
    secretary: ['secretary_calendar', 'secretary_reminders', 'mail', 'tasks'],
    triathlon: ['training'],
    finance: ['finance'],
  },
  specialLabels: ['clarify', 'none'],
};

function makeApp() {
  const routes = new Map<string, Handler[]>();
  return {
    routes,
    app: {
      get: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`GET ${route}`, handlers);
      }),
      post: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`POST ${route}`, handlers);
      }),
    },
  };
}

function makeResponse() {
  const payload = {
    statusCode: 200,
    body: undefined as unknown,
    sent: undefined as unknown,
    contentType: undefined as unknown,
  };
  const res: any = {
    status: vi.fn((code: number) => {
      payload.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      payload.body = body;
      return res;
    }),
    type: vi.fn((contentType: string) => {
      payload.contentType = contentType;
      return res;
    }),
    send: vi.fn((body: unknown) => {
      payload.sent = body;
      return res;
    }),
    setHeader: vi.fn(),
  };
  return { payload, res };
}

describe('portal routing corpus routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePortalAdminToken.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
    routeDb = makeTestDb();
    mocks.getDb.mockReturnValue(routeDb);
    mocks.getPortalAuthContext.mockReturnValue({
      actorHint: 'felipe@nexushub.me',
      matchedCredential: 'admin',
      actorSignatureVerified: true,
    });
    mocks.getOwnerBootstrapTarget.mockReturnValue({ tenantId: 7, telegramId: null });
    mocks.isOperatorScopedToUser.mockReturnValue(true);
    mocks.isCheckedInSyntheticRoutingCorpusItem.mockReturnValue(true);
    mocks.getRoutingCorpusItemById.mockReturnValue({
      id: 12,
      tenantId: 0,
      userId: null,
      source: 'bilingual_fixture',
      labelStatus: 'pending',
      labelDomain: null,
      labelSkill: null,
    });
    mocks.getRoutingLabelCandidates.mockReturnValue(CANDIDATES);
    mocks.getRoutingCorpusProgress.mockReturnValue({
      total: 3,
      pending: 2,
      labeled: 1,
      skipped: 0,
      bySource: {},
      byDomain: { secretary: 1 },
      bySkill: { tasks: 1 },
    });
  });

  it('rate-limits JSON routes before admin authorization and serves the labeling page', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);

    expect(routes.get('GET /api/portal/routing-corpus/next')?.[1]).toBe(mocks.requirePortalAdminToken);
    expect(routes.get('POST /api/portal/routing-corpus/label')?.[1]).toBe(mocks.requirePortalAdminToken);
    expect(routes.get('GET /api/portal/routing-corpus/progress')?.[1]).toBe(mocks.requirePortalAdminToken);
    expect(routes.get('GET /routing-corpus')).toBeDefined();
  });

  it('serves the next pending item with candidate labels including clarify/none', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    const item = { id: 12, utteranceText: 'Mostra o meu dia', labelStatus: 'pending' };
    mocks.getNextPendingRoutingCorpusItem.mockReturnValue(item);

    const { payload, res } = makeResponse();
    routes.get('GET /api/portal/routing-corpus/next')!.at(-1)!({ query: {} }, res);

    expect(mocks.getNextPendingRoutingCorpusItem).toHaveBeenCalledWith(routeDb, {
      tenantId: 0,
      syntheticOnly: true,
    });
    expect(mocks.getRoutingCorpusProgress).toHaveBeenCalledWith(routeDb, {
      tenantId: 0,
      syntheticOnly: true,
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0, must-revalidate',
    );
    expect(payload.body).toEqual({
      ok: true,
      item,
      candidates: CANDIDATES,
      progress: {
        total: 3,
        pending: 2,
        labeled: 1,
        skipped: 0,
        bySource: {},
        byDomain: { secretary: 1 },
        bySkill: { tasks: 1 },
      },
    });
    const candidates = (payload.body as { candidates: typeof CANDIDATES }).candidates;
    expect(candidates.specialLabels).toEqual(['clarify', 'none']);
  });

  it('scopes next and progress lookups to the requested tenant', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    mocks.getNextPendingRoutingCorpusItem.mockReturnValue(null);

    const next = makeResponse();
    routes.get('GET /api/portal/routing-corpus/next')!.at(-1)!({ query: { tenantId: '7' } }, next.res);
    expect(mocks.getNextPendingRoutingCorpusItem).toHaveBeenCalledWith(routeDb, {
      tenantId: 7,
      syntheticOnly: false,
    });
    expect(mocks.getRoutingCorpusProgress).toHaveBeenCalledWith(routeDb, {
      tenantId: 7,
      syntheticOnly: false,
    });

    const progress = makeResponse();
    routes.get('GET /api/portal/routing-corpus/progress')!.at(-1)!({ query: { tenantId: '7' } }, progress.res);
    expect(mocks.getRoutingCorpusProgress).toHaveBeenLastCalledWith(routeDb, {
      tenantId: 7,
      syntheticOnly: false,
    });
    expect(progress.payload.body).toEqual({
      ok: true,
      progress: {
        total: 3,
        pending: 2,
        labeled: 1,
        skipped: 0,
        bySource: {},
        byDomain: { secretary: 1 },
        bySkill: { tasks: 1 },
      },
    });
  });

  it('fails closed on malformed or non-owner tenant scopes', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);

    const malformed = makeResponse();
    routes.get('GET /api/portal/routing-corpus/next')!.at(-1)!({
      query: { tenantId: '7oops' },
    }, malformed.res);
    expect(malformed.payload.statusCode).toBe(400);
    expect(mocks.getNextPendingRoutingCorpusItem).not.toHaveBeenCalled();

    const forbidden = makeResponse();
    routes.get('GET /api/portal/routing-corpus/next')!.at(-1)!({
      query: { tenantId: '99' },
    }, forbidden.res);
    expect(forbidden.payload.statusCode).toBe(403);
    expect(mocks.getNextPendingRoutingCorpusItem).not.toHaveBeenCalled();

    mocks.getPortalAuthContext.mockReturnValue({ actorHint: undefined, matchedCredential: 'admin' });
    const missingActor = makeResponse();
    routes.get('GET /api/portal/routing-corpus/next')!.at(-1)!({
      query: { tenantId: '7' },
    }, missingActor.res);
    expect(missingActor.payload.statusCode).toBe(403);

    mocks.getPortalAuthContext.mockReturnValue({
      actorHint: 'felipe@nexushub.me',
      matchedCredential: 'admin',
      actorSignatureVerified: false,
      sessionSignatureVerified: false,
    });
    const unsignedActor = makeResponse();
    routes.get('GET /api/portal/routing-corpus/next')!.at(-1)!({
      query: { tenantId: '7' },
    }, unsignedActor.res);
    expect(unsignedActor.payload.statusCode).toBe(403);
  });

  it('labels an item with a valid manifest domain', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    const labeled = {
      id: 12,
      tenantId: 3,
      userId: 41,
      source: 'manual',
      labelStatus: 'labeled',
      labelDomain: 'secretary',
      labelSkill: 'tasks',
    };
    mocks.labelRoutingCorpusItem.mockReturnValue(labeled);
    mocks.getOwnerBootstrapTarget.mockReturnValue({ tenantId: 3, telegramId: null });
    mocks.isCheckedInSyntheticRoutingCorpusItem.mockReturnValue(false);
    mocks.getRoutingCorpusItemById.mockReturnValue({
      ...labeled,
      labelStatus: 'pending',
      labelDomain: null,
      labelSkill: null,
    });

    const req = {
      body: { id: 12, action: 'label', labelDomain: 'secretary', labelSkill: 'tasks' },
    };
    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!(req, res);

    expect(mocks.labelRoutingCorpusItem).toHaveBeenCalledWith(
      { id: 12, action: 'label', labelDomain: 'secretary', labelSkill: 'tasks' },
      routeDb,
    );
    expect(routeDb.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.insertPortalAdminMutationAuditStrict).toHaveBeenCalledWith(
      routeDb,
      req,
      {
        userId: 41,
        tenantId: 3,
        resource: 'portal.routing_corpus.label',
        details: {
          itemId: 12,
          tenantId: 3,
          source: 'manual',
          action: 'label',
          labelDomain: 'secretary',
          labelSkill: 'tasks',
        },
      },
    );
    expect(JSON.stringify(mocks.insertPortalAdminMutationAuditStrict.mock.calls)).not.toContain('utteranceText');
    expect(mocks.logPortalAdminMutation).not.toHaveBeenCalled();
    expect(payload.body).toEqual({ ok: true, item: labeled });
  });

  it('accepts domain-only, special clarify, and skip actions', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    mocks.labelRoutingCorpusItem.mockReturnValue({
      id: 12,
      tenantId: 0,
      userId: null,
      source: 'bilingual_fixture',
      labelStatus: 'labeled',
      labelDomain: 'secretary',
      labelSkill: null,
    });

    const domainOnly = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 12, action: 'label', labelDomain: 'secretary' },
    }, domainOnly.res);
    expect(domainOnly.payload.statusCode).toBe(200);

    mocks.labelRoutingCorpusItem.mockReturnValue({
      id: 13,
      tenantId: 0,
      userId: null,
      source: 'bilingual_fixture',
      labelStatus: 'labeled',
      labelDomain: 'clarify',
      labelSkill: null,
    });

    const clarify = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 13, action: 'label', labelDomain: 'clarify' },
    }, clarify.res);
    expect(clarify.payload.statusCode).toBe(200);

    mocks.labelRoutingCorpusItem.mockReturnValue({
      id: 14,
      tenantId: 0,
      userId: null,
      source: 'bilingual_fixture',
      labelStatus: 'skipped',
      labelDomain: null,
      labelSkill: null,
    });
    const skip = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({ body: { id: 14, action: 'skip' } }, skip.res);
    expect(mocks.labelRoutingCorpusItem).toHaveBeenLastCalledWith(
      { id: 14, action: 'skip', labelDomain: undefined, labelSkill: undefined },
      routeDb,
    );
    expect(routeDb.transaction).toHaveBeenCalledTimes(3);
    expect(mocks.insertPortalAdminMutationAuditStrict).toHaveBeenCalledTimes(3);
    expect(mocks.logPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('rejects unknown domains, cross-domain skills, skills on special labels, and malformed requests', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);

    const badDomain = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 12, action: 'label', labelDomain: 'not-a-domain' },
    }, badDomain.res);
    expect(badDomain.payload.statusCode).toBe(400);
    expect((badDomain.payload.body as { error: { code: string } }).error.code).toBe('INVALID_LABEL_DOMAIN');

    const badSkill = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 12, action: 'label', labelDomain: 'secretary', labelSkill: 'finance' },
    }, badSkill.res);
    expect(badSkill.payload.statusCode).toBe(400);
    expect((badSkill.payload.body as { error: { code: string } }).error.code).toBe('INVALID_LABEL_SKILL');

    const specialWithSkill = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 12, action: 'label', labelDomain: 'clarify', labelSkill: 'tasks' },
    }, specialWithSkill.res);
    expect(specialWithSkill.payload.statusCode).toBe(400);
    expect((specialWithSkill.payload.body as { error: { code: string } }).error.code).toBe('INVALID_LABEL_SKILL');

    const badAction = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({ body: { id: 12, action: 'delete' } }, badAction.res);
    expect(badAction.payload.statusCode).toBe(400);
    expect((badAction.payload.body as { error: { code: string } }).error.code).toBe('INVALID_LABEL_REQUEST');

    const badId = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({ body: { id: 'x', action: 'skip' } }, badId.res);
    expect(badId.payload.statusCode).toBe(400);
    expect(mocks.labelRoutingCorpusItem).not.toHaveBeenCalled();
  });

  it('returns a stale-write conflict when an item is no longer pending', async () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    const { RoutingCorpusLabelConflictError } = await import('../../src/services/routing-corpus');
    mocks.labelRoutingCorpusItem.mockImplementation(() => {
      throw new RoutingCorpusLabelConflictError(12, 'labeled');
    });

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 12, action: 'skip' },
    }, res);

    expect(payload.statusCode).toBe(409);
    expect((payload.body as { error: { code: string } }).error.code).toBe('ITEM_NOT_PENDING');
    expect(mocks.insertPortalAdminMutationAuditStrict).not.toHaveBeenCalled();
    expect(mocks.logPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('returns 404 when labeling a missing item', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    mocks.getRoutingCorpusItemById.mockReturnValue(null);

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 999, action: 'skip' },
    }, res);
    expect(payload.statusCode).toBe(404);
    expect((payload.body as { error: { code: string } }).error.code).toBe('ITEM_NOT_FOUND');
    expect(mocks.insertPortalAdminMutationAuditStrict).not.toHaveBeenCalled();
  });

  it('refuses label-by-id access outside the owner tenant before mutation', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    mocks.isCheckedInSyntheticRoutingCorpusItem.mockReturnValue(false);
    mocks.getRoutingCorpusItemById.mockReturnValue({
      id: 77,
      tenantId: 99,
      userId: 99,
      labelStatus: 'pending',
      labelDomain: null,
      labelSkill: null,
    });

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 77, action: 'skip' },
    }, res);

    expect(payload.statusCode).toBe(403);
    expect(mocks.labelRoutingCorpusItem).not.toHaveBeenCalled();
    expect(mocks.insertPortalAdminMutationAuditStrict).not.toHaveBeenCalled();
  });

  it('refuses a tenant-0 private row that is not an exact checked-in synthetic control', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    mocks.isCheckedInSyntheticRoutingCorpusItem.mockReturnValue(false);
    mocks.getOwnerBootstrapTarget.mockReturnValue({ tenantId: 7, telegramId: null });
    mocks.getRoutingCorpusItemById.mockReturnValue({
      id: 78,
      tenantId: 0,
      userId: 55,
      source: 'classify_shadow_disagreement',
      utteranceHash: 'd'.repeat(64),
      utteranceText: 'private tenant-zero utterance',
      labelStatus: 'pending',
      labelDomain: null,
      labelSkill: null,
    });

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 78, action: 'skip' },
    }, res);

    expect(payload.statusCode).toBe(403);
    expect(mocks.labelRoutingCorpusItem).not.toHaveBeenCalled();
    expect(mocks.insertPortalAdminMutationAuditStrict).not.toHaveBeenCalled();
  });

  it('commits successful label and skip mutations with redacted audit rows in the same transaction', async () => {
    const db = new Database(':memory:');
    try {
      const routing = await vi.importActual<typeof import('../../src/services/routing-corpus')>(
        '../../src/services/routing-corpus',
      );
      routing.ensureRoutingCorpusTables(db);
      db.exec(`
        CREATE TABLE audit_trail (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL DEFAULT (datetime('now')),
          tenant_id INTEGER NOT NULL DEFAULT 0,
          user_id INTEGER NOT NULL,
          actor_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          resource TEXT NOT NULL,
          details TEXT,
          ip_address TEXT
        );
      `);
      const insertItem = db.prepare(`
        INSERT INTO routing_corpus_items (
          tenant_id, user_id, utterance_hash, utterance_text, source
        ) VALUES (?, ?, ?, ?, 'manual')
      `);
      insertItem.run(0, null, 'a'.repeat(64), 'synthetic label utterance');
      insertItem.run(0, null, 'b'.repeat(64), 'synthetic skip utterance');

      mocks.getDb.mockReturnValue(db);
      mocks.getRoutingCorpusItemById.mockImplementation((id, targetDb) =>
        routing.getRoutingCorpusItemById(id, targetDb));
      mocks.labelRoutingCorpusItem.mockImplementation((input, targetDb) =>
        routing.labelRoutingCorpusItem(input, targetDb));
      mocks.insertPortalAdminMutationAuditStrict.mockImplementation((targetDb, _req, input) => {
        targetDb.prepare(`
          INSERT INTO audit_trail (
            tenant_id, user_id, actor_id, action, resource, details, ip_address
          ) VALUES (?, ?, 99, 'admin_mutation', ?, ?, NULL)
        `).run(input.tenantId, input.userId, input.resource, JSON.stringify(input.details));
      });

      const { app, routes } = makeApp();
      registerPortalRoutingCorpusRoutes(app as any);
      const handler = routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!;

      const labelResponse = makeResponse();
      handler({
        body: { id: 1, action: 'label', labelDomain: 'secretary', labelSkill: 'tasks' },
      }, labelResponse.res);
      const skipResponse = makeResponse();
      handler({ body: { id: 2, action: 'skip' } }, skipResponse.res);

      expect(labelResponse.payload.statusCode).toBe(200);
      expect(skipResponse.payload.statusCode).toBe(200);
      expect(db.prepare(`
        SELECT id, label_status AS labelStatus
        FROM routing_corpus_items ORDER BY id
      `).all()).toEqual([
        { id: 1, labelStatus: 'labeled' },
        { id: 2, labelStatus: 'skipped' },
      ]);
      const auditRows = db.prepare(
        'SELECT resource, details FROM audit_trail ORDER BY id',
      ).all() as Array<{ resource: string; details: string }>;
      expect(auditRows.map((row) => row.resource)).toEqual([
        'portal.routing_corpus.label',
        'portal.routing_corpus.skip',
      ]);
      expect(JSON.stringify(auditRows)).not.toContain('synthetic label utterance');
      expect(JSON.stringify(auditRows)).not.toContain('synthetic skip utterance');
      expect(JSON.stringify(auditRows)).not.toContain('utteranceText');
    } finally {
      db.close();
    }
  });

  it('rolls back the corpus mutation and returns no success when strict audit insertion fails', async () => {
    const db = new Database(':memory:');
    try {
      const routing = await vi.importActual<typeof import('../../src/services/routing-corpus')>(
        '../../src/services/routing-corpus',
      );
      routing.ensureRoutingCorpusTables(db);
      db.exec(`
        CREATE TABLE audit_trail (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL DEFAULT 0,
          user_id INTEGER NOT NULL,
          actor_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          resource TEXT NOT NULL,
          details TEXT,
          ip_address TEXT
        );
        INSERT INTO routing_corpus_items (
          tenant_id, user_id, utterance_hash, utterance_text, source
        ) VALUES (0, NULL, '${'c'.repeat(64)}', 'must remain pending', 'manual');
      `);
      mocks.getDb.mockReturnValue(db);
      mocks.getRoutingCorpusItemById.mockImplementation((id, targetDb) =>
        routing.getRoutingCorpusItemById(id, targetDb));
      mocks.labelRoutingCorpusItem.mockImplementation((input, targetDb) =>
        routing.labelRoutingCorpusItem(input, targetDb));
      const auditError = new Error('strict audit insert failed');
      mocks.insertPortalAdminMutationAuditStrict.mockImplementation(() => {
        throw auditError;
      });

      const { app, routes } = makeApp();
      registerPortalRoutingCorpusRoutes(app as any);
      const { res } = makeResponse();
      routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
        body: { id: 1, action: 'label', labelDomain: 'secretary', labelSkill: 'tasks' },
      }, res);

      expect(db.prepare(`
        SELECT label_status AS labelStatus, label_domain AS labelDomain, label_skill AS labelSkill
        FROM routing_corpus_items WHERE id = 1
      `).get()).toEqual({
        labelStatus: 'pending',
        labelDomain: null,
        labelSkill: null,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM audit_trail').get()).toEqual({ count: 0 });
      expect(res.json).not.toHaveBeenCalled();
      expect(mocks.sendPortalInternalError).toHaveBeenCalledWith(
        res,
        auditError,
        'Portal request failed',
        'Portal: routing corpus label request failed',
      );
    } finally {
      db.close();
    }
  });

  it('serves the minimal labeling page as HTML', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);

    const { payload, res } = makeResponse();
    routes.get('GET /routing-corpus')!.at(-1)!({}, res);
    expect(payload.contentType).toBe('html');
    expect(String(payload.sent)).toContain('Routing Corpus Labeling');
    expect(String(payload.sent)).toContain('/api/portal/routing-corpus/next');
    expect(String(payload.sent)).toContain('new URLSearchParams(window.location.search)');
    expect(String(payload.sent)).toContain("encodeURIComponent(tenantId)");
    expect(String(payload.sent)).toContain('Domain only / skill unsure');
    expect(String(payload.sent)).toContain('labelSkill: labelSkill');
  });

  it('delegates unexpected failures to the portal error helper', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    const err = new Error('db unavailable');
    mocks.getNextPendingRoutingCorpusItem.mockImplementation(() => {
      throw err;
    });

    const { res } = makeResponse();
    routes.get('GET /api/portal/routing-corpus/next')!.at(-1)!({ query: {} }, res);
    expect(mocks.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      err,
      'Portal request failed',
      'Portal: routing corpus next request failed',
    );
  });
});

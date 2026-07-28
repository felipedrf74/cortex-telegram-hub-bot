import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  getDb: vi.fn(),
  getNextPendingRoutingCorpusItem: vi.fn(),
  getRoutingCorpusProgress: vi.fn(),
  getRoutingLabelCandidates: vi.fn(),
  labelRoutingCorpusItem: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', async () => ({
  ...await vi.importActual<typeof import('../../src/api/secret-guards')>('../../src/api/secret-guards'),
  requirePortalAdminToken: mocks.requirePortalAdminToken,
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
  isValidRoutingLabelDomain: (labelDomain: string, candidates: { domains: string[]; specialLabels: string[] }) =>
    candidates.domains.includes(labelDomain) || candidates.specialLabels.includes(labelDomain),
  labelRoutingCorpusItem: (...args: unknown[]) => mocks.labelRoutingCorpusItem(...args),
}));

vi.mock('../../src/portal/http', async () => ({
  ...await vi.importActual<typeof import('../../src/portal/http')>('../../src/portal/http'),
  sendPortalInternalError: (...args: unknown[]) => mocks.sendPortalInternalError(...args),
}));

import { registerPortalRoutingCorpusRoutes } from '../../src/portal/routing-corpus-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;

const CANDIDATES = {
  domains: ['secretary', 'triathlon', 'finance'],
  skillsByDomain: { secretary: ['secretary', 'tasks'], triathlon: ['training'], finance: ['finance'] },
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
  };
  return { payload, res };
}

describe('portal routing corpus routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePortalAdminToken.mockImplementation((_req: unknown, _res: unknown, next: () => void) => next());
    mocks.getDb.mockReturnValue({ __db: true });
    mocks.getRoutingLabelCandidates.mockReturnValue(CANDIDATES);
    mocks.getRoutingCorpusProgress.mockReturnValue({ total: 3, pending: 2, labeled: 1, skipped: 0, bySource: {} });
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

    expect(mocks.getNextPendingRoutingCorpusItem).toHaveBeenCalledWith({ __db: true }, {});
    expect(payload.body).toEqual({
      ok: true,
      item,
      candidates: CANDIDATES,
      progress: { total: 3, pending: 2, labeled: 1, skipped: 0, bySource: {} },
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
    expect(mocks.getNextPendingRoutingCorpusItem).toHaveBeenCalledWith({ __db: true }, { tenantId: 7 });
    expect(mocks.getRoutingCorpusProgress).toHaveBeenCalledWith({ __db: true }, { tenantId: 7 });

    const progress = makeResponse();
    routes.get('GET /api/portal/routing-corpus/progress')!.at(-1)!({ query: { tenantId: '7' } }, progress.res);
    expect(mocks.getRoutingCorpusProgress).toHaveBeenLastCalledWith({ __db: true }, { tenantId: 7 });
    expect(progress.payload.body).toEqual({
      ok: true,
      progress: { total: 3, pending: 2, labeled: 1, skipped: 0, bySource: {} },
    });
  });

  it('labels an item with a valid manifest domain', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    const labeled = { id: 12, labelStatus: 'labeled', labelDomain: 'secretary', labelSkill: 'tasks' };
    mocks.labelRoutingCorpusItem.mockReturnValue(labeled);

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 12, action: 'label', labelDomain: 'secretary', labelSkill: 'tasks' },
    }, res);

    expect(mocks.labelRoutingCorpusItem).toHaveBeenCalledWith(
      { id: 12, action: 'label', labelDomain: 'secretary', labelSkill: 'tasks' },
      { __db: true },
    );
    expect(payload.body).toEqual({ ok: true, item: labeled });
  });

  it('accepts the special clarify label and skip actions', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    mocks.labelRoutingCorpusItem.mockReturnValue({ id: 13, labelStatus: 'labeled', labelDomain: 'clarify' });

    const clarify = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 13, action: 'label', labelDomain: 'clarify' },
    }, clarify.res);
    expect(clarify.payload.statusCode).toBe(200);

    mocks.labelRoutingCorpusItem.mockReturnValue({ id: 14, labelStatus: 'skipped' });
    const skip = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({ body: { id: 14, action: 'skip' } }, skip.res);
    expect(mocks.labelRoutingCorpusItem).toHaveBeenLastCalledWith(
      { id: 14, action: 'skip', labelDomain: undefined, labelSkill: undefined },
      { __db: true },
    );
  });

  it('rejects unknown label domains and malformed requests', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);

    const badDomain = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 12, action: 'label', labelDomain: 'not-a-domain' },
    }, badDomain.res);
    expect(badDomain.payload.statusCode).toBe(400);
    expect((badDomain.payload.body as { error: { code: string } }).error.code).toBe('INVALID_LABEL_DOMAIN');

    const badAction = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({ body: { id: 12, action: 'delete' } }, badAction.res);
    expect(badAction.payload.statusCode).toBe(400);
    expect((badAction.payload.body as { error: { code: string } }).error.code).toBe('INVALID_LABEL_REQUEST');

    const badId = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({ body: { id: 'x', action: 'skip' } }, badId.res);
    expect(badId.payload.statusCode).toBe(400);
    expect(mocks.labelRoutingCorpusItem).not.toHaveBeenCalled();
  });

  it('returns 404 when labeling a missing item', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);
    mocks.labelRoutingCorpusItem.mockReturnValue(null);

    const { payload, res } = makeResponse();
    routes.get('POST /api/portal/routing-corpus/label')!.at(-1)!({
      body: { id: 999, action: 'skip' },
    }, res);
    expect(payload.statusCode).toBe(404);
    expect((payload.body as { error: { code: string } }).error.code).toBe('ITEM_NOT_FOUND');
  });

  it('serves the minimal labeling page as HTML', () => {
    const { app, routes } = makeApp();
    registerPortalRoutingCorpusRoutes(app as any);

    const { payload, res } = makeResponse();
    routes.get('GET /routing-corpus')!.at(-1)!({}, res);
    expect(payload.contentType).toBe('html');
    expect(String(payload.sent)).toContain('Routing Corpus Labeling');
    expect(String(payload.sent)).toContain('/api/portal/routing-corpus/next');
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

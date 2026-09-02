import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSendPortalInternalError = vi.fn();

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mockSendPortalInternalError(...args),
}));

import { registerPortalProviderRoutes } from '../../src/portal/provider-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface CapturedRoute {
  method: Method;
  path: string;
  handlers: Handler[];
}

interface RouteDeps {
  domainRouter?: any;
  modelConfig?: any;
  getDb?: () => any;
  computeCostBreakdown?: (...args: unknown[]) => unknown;
  getActiveProvider?: () => any;
  isGeminiProviderConfigured?: () => boolean;
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function captureRoutes(deps: RouteDeps = {}): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const app = {
    get(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'GET', path, handlers });
    },
    post(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'POST', path, handlers });
    },
    put(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'PUT', path, handlers });
    },
    delete(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'DELETE', path, handlers });
    },
  };
  registerPortalProviderRoutes(app as any, deps);
  return routes;
}

function findRoute(routes: CapturedRoute[], method: Method, path: string): CapturedRoute {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);
  return route;
}

function invoke(route: CapturedRoute, req: Record<string, unknown> = {}) {
  const res = createRes();
  const handler = route.handlers.at(-1);
  if (!handler) throw new Error(`Route has no handler: ${route.method} ${route.path}`);
  handler({ body: {}, query: {}, ...req }, res);
  return res;
}

function createDomainRouter(overrides: Record<string, unknown> = {}) {
  return {
    getDomainProviderConfig: vi.fn(() => [
      { domain: 'content', provider: 'gemini' },
      { domain: 'finance', provider: 'openai' },
    ]),
    isGeminiRoutingEnabled: vi.fn(() => true),
    isSecretaryPrimaryRouteEnabled: vi.fn(() => false),
    setGeminiRoutingEnabled: vi.fn(),
    setSecretaryPrimaryRouteEnabled: vi.fn(),
    setGeminiDomains: vi.fn(),
    ...overrides,
  };
}

function createModelConfig(overrides: Record<string, unknown> = {}) {
  return {
    MODEL_OPTIONS: {
      anthropic: { chat: ['claude-sonnet'], classifier: ['claude-haiku'] },
      openai: { chat: ['gpt-5.4'], classifier: ['gpt-5-mini'] },
      gemini: { chat: ['gemini-2.5-flash'], classifier: ['gemini-2.5-flash-lite'] },
    },
    getAllModelStates: vi.fn(() => ({ chat: { provider: 'openai', model: 'gpt-5.4' } })),
    getEffectiveDomainModel: vi.fn((_provider: string, domain: string) => `${domain}-model`),
    setActiveModel: vi.fn(),
    clearModelOverride: vi.fn(),
    ...overrides,
  };
}

describe('portal provider and model routes', () => {
  beforeEach(() => {
    mockSendPortalInternalError.mockReset();
  });

  it('registers the provider/model operations route family', () => {
    const routes = captureRoutes().map((route) => `${route.method} ${route.path}`);

    expect(routes).toEqual([
      'GET /api/domain-routing',
      'POST /api/domain-routing/toggle',
      'GET /api/model-config',
      'PUT /api/model-config',
      'DELETE /api/model-config',
      'GET /api/model-intelligence',
      'GET /api/cost-by-domain',
      'GET /api/provider-stats',
    ]);
  });

  it('returns enriched domain routing state and preserves degraded fallback', () => {
    const domainRouter = createDomainRouter();
    const modelConfig = createModelConfig();
    const routes = captureRoutes({
      domainRouter,
      modelConfig,
      isGeminiProviderConfigured: () => true,
    });

    expect(invoke(findRoute(routes, 'GET', '/api/domain-routing')).body).toEqual({
      domains: [
        { domain: 'content', provider: 'gemini', model: 'content-model' },
        { domain: 'finance', provider: 'openai', model: 'finance-model' },
      ],
      geminiRoutingEnabled: true,
      secretaryPrimaryRouteEnabled: false,
      geminiIncludeSecretary: false,
      geminiConfigured: true,
    });

    const degradedRoutes = captureRoutes({
      domainRouter: createDomainRouter({
        getDomainProviderConfig: vi.fn(() => {
          throw new Error('router unavailable');
        }),
      }),
      modelConfig,
    });
    expect(invoke(findRoute(degradedRoutes, 'GET', '/api/domain-routing')).body).toEqual({
      domains: [],
      geminiRoutingEnabled: false,
      secretaryPrimaryRouteEnabled: false,
      geminiIncludeSecretary: false,
      geminiConfigured: false,
    });
  });

  it('updates domain routing flags, filters invalid domains, and clears provider cache', () => {
    const domainRouter = createDomainRouter();
    const clearDomainPairCache = vi.fn();
    const routes = captureRoutes({
      domainRouter,
      modelConfig: createModelConfig(),
      getActiveProvider: () => ({ clearDomainPairCache }),
    });

    const res = invoke(findRoute(routes, 'POST', '/api/domain-routing/toggle'), {
      body: {
        enabled: false,
        secretaryPrimaryRouteEnabled: true,
        domains: ['content', 'unknown', 'finance', 123],
      },
    });

    expect(domainRouter.setGeminiRoutingEnabled).toHaveBeenCalledWith(false);
    expect(domainRouter.setSecretaryPrimaryRouteEnabled).toHaveBeenCalledWith(true);
    expect(domainRouter.setGeminiDomains).toHaveBeenCalledWith(['content', 'finance']);
    expect(clearDomainPairCache).toHaveBeenCalled();
    expect(res.body).toEqual({
      ok: true,
      config: [
        { domain: 'content', provider: 'gemini' },
        { domain: 'finance', provider: 'openai' },
      ],
      geminiRoutingEnabled: true,
      secretaryPrimaryRouteEnabled: false,
      geminiIncludeSecretary: false,
    });
  });

  it('returns, updates, and clears model configuration with input validation', () => {
    const modelConfig = createModelConfig();
    const routes = captureRoutes({
      domainRouter: createDomainRouter(),
      modelConfig,
    });

    expect(invoke(findRoute(routes, 'GET', '/api/model-config')).body).toEqual({
      states: { chat: { provider: 'openai', model: 'gpt-5.4' } },
      options: {
        anthropic: { chat: ['claude-sonnet'], classifier: ['claude-haiku'] },
        openai: { chat: ['gpt-5.4'], classifier: ['gpt-5-mini'] },
        gemini: { chat: ['gemini-2.5-flash'], classifier: ['gemini-2.5-flash-lite'] },
      },
    });

    const badPut = invoke(findRoute(routes, 'PUT', '/api/model-config'), {
      body: { provider: 'bad', role: 'chat', model: 'x' },
    });
    expect(badPut.statusCode).toBe(400);
    expect(badPut.body).toEqual({ error: 'Invalid provider, role, or model' });

    expect(invoke(findRoute(routes, 'PUT', '/api/model-config'), {
      body: { provider: 'openai', role: 'chat', model: 'gpt-5.4' },
    }).body).toEqual({
      ok: true,
      provider: 'openai',
      role: 'chat',
      model: 'gpt-5.4',
      message: 'Model updated. Active immediately — no restart needed.',
    });
    expect(modelConfig.setActiveModel).toHaveBeenCalledWith('openai', 'chat', 'gpt-5.4');

    const badModel = invoke(findRoute(routes, 'PUT', '/api/model-config'), {
      body: { provider: 'openai', role: 'chat', model: 'not-a-real-openai-model' },
    });
    expect(badModel.statusCode).toBe(400);
    expect(badModel.body).toEqual({ error: 'Invalid provider, role, or model' });
    expect(modelConfig.setActiveModel).not.toHaveBeenCalledWith('openai', 'chat', 'not-a-real-openai-model');

    expect(invoke(findRoute(routes, 'PUT', '/api/model-config'), {
      body: { provider: 'gemini', role: 'content', model: 'gemini-2.5-flash-lite' },
    }).body).toEqual({
      ok: true,
      provider: 'gemini',
      role: 'content',
      model: 'gemini-2.5-flash-lite',
      message: 'Model updated. Active immediately — no restart needed.',
    });
    expect(modelConfig.setActiveModel).toHaveBeenCalledWith('gemini', 'content', 'gemini-2.5-flash-lite');

    const wrongTierModel = invoke(findRoute(routes, 'PUT', '/api/model-config'), {
      body: { provider: 'gemini', role: 'content', model: 'gemini-2.5-flash' },
    });
    expect(wrongTierModel.statusCode).toBe(400);
    expect(wrongTierModel.body).toEqual({ error: 'Invalid provider, role, or model' });
    expect(modelConfig.setActiveModel).not.toHaveBeenCalledWith('gemini', 'content', 'gemini-2.5-flash');

    const badDelete = invoke(findRoute(routes, 'DELETE', '/api/model-config'), {
      body: { provider: 'openai' },
    });
    expect(badDelete.statusCode).toBe(400);
    expect(badDelete.body).toEqual({ error: 'provider and role required' });

    expect(invoke(findRoute(routes, 'DELETE', '/api/model-config'), {
      body: { provider: 'openai', role: 'chat' },
    }).body).toEqual({
      ok: true,
      states: { chat: { provider: 'openai', model: 'gpt-5.4' } },
    });
    expect(modelConfig.clearModelOverride).toHaveBeenCalledWith('openai', 'chat');
  });

  it('builds model intelligence insight payloads from usage data', () => {
    const getDb = () => ({
      prepare(sql: string) {
        if (sql.includes('GROUP BY provider, model')) {
          return {
            all: () => [
              { provider: 'anthropic', model: 'claude-sonnet', calls: 4, total_cost: 0.6, avg_cost: 0.15, total_tokens: 12000 },
              { provider: 'openai', model: 'gpt-5.4-nano', calls: 10, total_cost: 0.1, avg_cost: 0.01, total_tokens: 3000 },
            ],
          };
        }
        return {
          get: () => ({ cost: 0.12, calls: 8 }),
        };
      },
    });
    const routes = captureRoutes({
      domainRouter: createDomainRouter(),
      modelConfig: createModelConfig(),
      getDb,
    });

    const res = invoke(findRoute(routes, 'GET', '/api/model-intelligence'));

    expect(res.body).toEqual({
      ok: true,
      spending: [
        { provider: 'anthropic', model: 'claude-sonnet', calls: 4, total_cost: 0.6, avg_cost: 0.15, total_tokens: 12000 },
        { provider: 'openai', model: 'gpt-5.4-nano', calls: 10, total_cost: 0.1, avg_cost: 0.01, total_tokens: 3000 },
      ],
      insights: expect.arrayContaining([
        expect.objectContaining({ type: 'cost', title: 'Anthropic fallback active' }),
        expect.objectContaining({ type: 'info', title: 'Secretary domain cost' }),
        expect.objectContaining({ type: 'summary', title: 'Weekly AI spend' }),
      ]),
    });
  });

  it('delegates cost aggregation to the shared cost breakdown helper with clamped days', () => {
    const rows = [{ category: 'secretary', provider: 'openai', cost_usd: 0.03 }];
    const computeCostBreakdown = vi.fn(() => ({ byDomain: [{ category: 'secretary' }] }));
    const getDb = () => ({
      prepare: () => ({ all: vi.fn(() => rows) }),
    });
    const routes = captureRoutes({
      domainRouter: createDomainRouter(),
      modelConfig: createModelConfig(),
      getDb,
      computeCostBreakdown,
    });

    const res = invoke(findRoute(routes, 'GET', '/api/cost-by-domain'), {
      query: { days: '200' },
    });

    expect(computeCostBreakdown).toHaveBeenCalledWith(rows, 90);
    expect(res.body).toEqual({ ok: true, byDomain: [{ category: 'secretary' }] });
  });

  it('returns provider stats from usage rows and circuit state', () => {
    const getDb = () => ({
      prepare(sql: string) {
        if (sql.includes("WHERE ts >= date('now')")) {
          return {
            all: () => [
              { provider: 'openai', calls: 3, cost: 0.12, tokens: 4000, lastCallAt: '2026-04-23T09:00:00.000Z' },
            ],
          };
        }
        return {
          all: () => [
            { provider: 'anthropic', calls: 2, cost: 0.4 },
            { provider: 'openai', calls: 9, cost: 0.3 },
          ],
        };
      },
    });
    const routes = captureRoutes({
      domainRouter: createDomainRouter(),
      modelConfig: createModelConfig(),
      getDb,
      getActiveProvider: () => ({
        getAllCircuitStates: () => ({ anthropic: { state: 'OPEN', failures: 2 } }),
      }),
    });

    const res = invoke(findRoute(routes, 'GET', '/api/provider-stats'));

    expect(res.body).toEqual({
      ok: true,
      providers: [
        {
          name: 'openai',
          today: { calls: 3, cost: 0.12, tokens: 4000, lastCallAt: '2026-04-23T09:00:00.000Z' },
          week: { calls: 9, cost: 0.3 },
          circuit: { state: 'CLOSED', failures: 0 },
        },
        {
          name: 'anthropic',
          today: { calls: 0, cost: 0, tokens: 0, lastCallAt: null },
          week: { calls: 2, cost: 0.4 },
          circuit: { state: 'OPEN', failures: 2 },
        },
        {
          name: 'gemini',
          today: { calls: 0, cost: 0, tokens: 0, lastCallAt: null },
          week: { calls: 0, cost: 0 },
          circuit: { state: 'CLOSED', failures: 0 },
        },
      ],
    });
  });

  it('uses shared sanitized errors for failing non-degraded routes', () => {
    const routes = captureRoutes({
      domainRouter: createDomainRouter(),
      modelConfig: createModelConfig({
        getAllModelStates: vi.fn(() => {
          throw new Error('raw model config failure');
        }),
      }),
    });

    const res = invoke(findRoute(routes, 'GET', '/api/model-config'));

    expect(mockSendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Portal request failed',
      'Portal: request failed',
    );
  });
});

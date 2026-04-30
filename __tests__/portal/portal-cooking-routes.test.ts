import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const targetUserGuard = ((_req: unknown, _res: unknown, next: () => void) => next()) as unknown as ReturnType<typeof vi.fn>;
  return {
    requirePortalAdminToken: vi.fn(),
    getPortalAuthContext: vi.fn(),
    targetUserGuard,
    requireOperatorTargetUser: vi.fn(() => targetUserGuard),
    buildCookingPreferenceReadModel: vi.fn(),
    isCookingPreferenceKind: vi.fn(),
    setCookingPreferenceMemory: vi.fn(),
    getPantryItems: vi.fn(),
    upsertPantryItem: vi.fn(),
    deletePantryItem: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    logAudit: vi.fn(),
    buildPortalAdminAuditDetails: vi.fn(),
    logPortalAdminMutation: vi.fn(),
    sendPortalInternalError: vi.fn(),
  };
});

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
  getPortalAuthContext: (...args: unknown[]) => hoisted.getPortalAuthContext(...args),
}));

vi.mock('../../src/portal/admin-target-user', () => ({
  requireOperatorTargetUser: (...args: unknown[]) => hoisted.requireOperatorTargetUser(...args),
}));

vi.mock('../../src/services/cooking-preferences', () => ({
  buildCookingPreferenceReadModel: (...args: unknown[]) => hoisted.buildCookingPreferenceReadModel(...args),
  isCookingPreferenceKind: (...args: unknown[]) => hoisted.isCookingPreferenceKind(...args),
  setCookingPreferenceMemory: (...args: unknown[]) => hoisted.setCookingPreferenceMemory(...args),
}));

vi.mock('../../src/services/cooking-chef', () => ({
  getPantryItems: (...args: unknown[]) => hoisted.getPantryItems(...args),
  upsertPantryItem: (...args: unknown[]) => hoisted.upsertPantryItem(...args),
  deletePantryItem: (...args: unknown[]) => hoisted.deletePantryItem(...args),
}));

vi.mock('../../src/services/cooking-cache-invalidator', () => ({
  invalidateCookingDerivedCaches: (...args: unknown[]) => hoisted.invalidateCookingDerivedCaches(...args),
}));

vi.mock('../../src/services/audit-trail', () => ({
  logAudit: (...args: unknown[]) => hoisted.logAudit(...args),
}));

vi.mock('../../src/portal/admin-audit', () => ({
  buildPortalAdminAuditDetails: (...args: unknown[]) => hoisted.buildPortalAdminAuditDetails(...args),
  logPortalAdminMutation: (...args: unknown[]) => hoisted.logPortalAdminMutation(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => hoisted.sendPortalInternalError(...args),
}));

import { registerPortalCookingRoutes } from '../../src/portal/cooking-routes';

type Handler = (req: any, res: any) => unknown;

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
      delete: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`DELETE ${route}`, handlers);
      }),
    },
  };
}

function makeResponse() {
  const payload = {
    statusCode: 200,
    body: undefined as unknown,
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
  };
  return { payload, res };
}

const memory = {
  id: 1,
  memoryId: 'mem_cooking_1',
  tenantId: 42,
  userId: 42,
  skillId: 'cooking',
  memoryType: 'cooking_preference',
  scope: 'user_private',
  memoryKey: 'allergy.peanut',
  memoryValue: 'peanut',
  source: 'portal',
  confidence: 0.92,
  freshnessStatus: 'fresh',
  status: 'active',
  createdAt: '2026-04-30T18:00:00Z',
  updatedAt: '2026-04-30T18:00:00Z',
  expiresAt: null,
  stalenessPolicy: null,
  schemaVersion: 'cooking-memory-v1',
  relatedSkillVersion: '1.1.0-rc.1',
  supersededByMemoryId: null,
  correctionParentMemoryId: null,
  correctionHistory: [],
  auditMetadata: {},
  lastUsedAt: null,
  useCount: 0,
};

const pantryItem = {
  id: 7,
  tenant_id: 42,
  user_id: 42,
  owner_user_id: 42,
  visibility_scope: 'user_private',
  lifecycle_state: 'available',
  scope_status: 'available',
  name: 'Rice',
  normalized_name: 'rice',
  quantity: '1',
  unit: 'kg',
  category: 'pantry',
  expires_at: null,
  freshness_status: 'fresh',
  availability_status: 'available',
  source: 'portal',
  confidence: 0.9,
  notes: null,
  created_at: '2026-04-30T18:00:00Z',
  updated_at: '2026-04-30T18:00:00Z',
};

describe('portal cooking routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getPortalAuthContext.mockReturnValue({ actorHint: 'ops', matchedCredential: 'admin' });
    hoisted.buildPortalAdminAuditDetails.mockReturnValue({ portalActorHint: 'ops' });
    hoisted.buildCookingPreferenceReadModel.mockReturnValue({
      profile: { allergies: ['peanut'] },
      memories: [memory],
      summary: 'Allergies: peanut',
      skillMemorySummary: 'Cooking preference memory summary',
    });
    hoisted.isCookingPreferenceKind.mockReturnValue(true);
    hoisted.setCookingPreferenceMemory.mockReturnValue(memory);
    hoisted.getPantryItems.mockReturnValue([pantryItem]);
    hoisted.upsertPantryItem.mockReturnValue(pantryItem);
    hoisted.deletePantryItem.mockReturnValue(true);
  });

  it('registers Cooking portal routes behind admin and target-user guards', () => {
    const { app, routes } = makeApp();

    registerPortalCookingRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/users/:userId/cooking/preferences', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/users/:userId/cooking/preferences', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/users/:userId/cooking/pantry', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/users/:userId/cooking/pantry', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(app.delete).toHaveBeenCalledWith('/api/users/:userId/cooking/pantry/:itemId', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(routes.get('GET /api/users/:userId/cooking/preferences')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('GET /api/users/:userId/cooking/preferences')?.[1]).toBe(hoisted.targetUserGuard);
  });

  it('reads Cooking preferences without returning raw private memory values', () => {
    const { app, routes } = makeApp();
    registerPortalCookingRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/cooking/preferences')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' }, query: { tenantId: '42' }, ip: '127.0.0.1' }, res);

    expect(hoisted.buildCookingPreferenceReadModel).toHaveBeenCalledWith(42, 42);
    expect(hoisted.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      tenantId: 42,
      action: 'access',
      resource: 'portal.cooking.preferences.read',
    }));
    expect(payload.body).toMatchObject({
      ok: true,
      tenantId: 42,
      preferences: {
        profile: { allergies: ['peanut'] },
        summary: 'Allergies: peanut',
      },
    });
    expect(JSON.stringify(payload.body)).not.toContain('"memoryValue"');
    expect(JSON.stringify(payload.body)).not.toContain('"peanut","source"');
  });

  it('rejects cross-tenant Cooking portal reads before service access', () => {
    const { app, routes } = makeApp();
    registerPortalCookingRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/cooking/preferences')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' }, query: { tenantId: '99' } }, res);

    expect(payload.statusCode).toBe(403);
    expect(payload.body).toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN_TENANT_SCOPE',
        message: 'operator is not scoped to this Cooking tenant',
      },
    });
    expect(hoisted.buildCookingPreferenceReadModel).not.toHaveBeenCalled();
    expect(hoisted.getPantryItems).not.toHaveBeenCalled();
  });

  it('writes Cooking preferences through scoped memory and records admin audit', () => {
    const req = {
      params: { userId: '42' },
      body: {
        tenantId: 42,
        kind: 'allergy',
        value: 'peanut',
        correction: true,
      },
    };
    const { app, routes } = makeApp();
    registerPortalCookingRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/cooking/preferences')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.setCookingPreferenceMemory).toHaveBeenCalledWith(42, expect.objectContaining({
      kind: 'allergy',
      value: 'peanut',
      source: 'portal',
      correction: true,
    }), 42);
    expect(hoisted.invalidateCookingDerivedCaches).toHaveBeenCalledWith(42);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 42, 'portal.cooking.preferences.write', expect.objectContaining({
      tenantId: 42,
      kind: 'allergy',
      correction: true,
      memoryId: 'mem_cooking_1',
    }));
    expect(payload.statusCode).toBe(201);
    expect(JSON.stringify(payload.body)).not.toContain('"memoryValue"');
  });

  it('reads pantry through scoped Cooking services and audits access', () => {
    const { app, routes } = makeApp();
    registerPortalCookingRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/cooking/pantry')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' }, query: { tenantId: '42', includeExpired: 'true', limit: '20' } }, res);

    expect(hoisted.getPantryItems).toHaveBeenCalledWith(42, expect.objectContaining({
      tenantId: 42,
      includeExpired: true,
      limit: 20,
    }));
    expect(hoisted.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      resource: 'portal.cooking.pantry.read',
      details: expect.objectContaining({ itemCount: 1 }),
    }));
    expect(payload.body).toMatchObject({
      ok: true,
      tenantId: 42,
      count: 1,
      items: [{ id: 7, name: 'Rice' }],
    });
  });

  it('upserts and deletes pantry items through tenant-scoped services', () => {
    const { app, routes } = makeApp();
    registerPortalCookingRoutes(app as any);
    const upsert = routes.get('POST /api/users/:userId/cooking/pantry')?.[2]!;
    const remove = routes.get('DELETE /api/users/:userId/cooking/pantry/:itemId')?.[2]!;
    const upsertResponse = makeResponse();
    const deleteResponse = makeResponse();

    upsert({ params: { userId: '42' }, body: { tenantId: 42, name: 'Rice', quantity: '1', unit: 'kg' } }, upsertResponse.res);
    remove({ params: { userId: '42', itemId: '7' }, body: { tenantId: 42 } }, deleteResponse.res);

    expect(hoisted.upsertPantryItem).toHaveBeenCalledWith(42, expect.objectContaining({
      name: 'Rice',
      quantity: '1',
      unit: 'kg',
      source: 'portal',
    }), 42);
    expect(hoisted.deletePantryItem).toHaveBeenCalledWith(42, 7, 42);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 42, 'portal.cooking.pantry.upsert', expect.objectContaining({
      tenantId: 42,
      pantryItemId: 7,
    }));
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 42, 'portal.cooking.pantry.delete', expect.objectContaining({
      tenantId: 42,
      pantryItemId: 7,
    }));
    expect(upsertResponse.payload.statusCode).toBe(201);
    expect(deleteResponse.payload.body).toEqual({ ok: true, tenantId: 42, deleted: true, itemId: 7 });
  });
});

import type { Request, Response, Router } from 'express';
import { describe, expect, it, vi } from 'vitest';

const serviceSentinels = vi.hoisted(() => ({
  getDb: vi.fn(() => {
    throw new Error('Content route reached durable service access before rejecting missing scope');
  }),
  recordTenantScopeAnomaly: vi.fn(),
}));

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return {
    ...actual,
    getDb: serviceSentinels.getDb,
  };
});

vi.mock('../../src/services/tenant-scope-observability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/tenant-scope-observability')>();
  return {
    ...actual,
    recordTenantScopeAnomaly: serviceSentinels.recordTenantScopeAnomaly,
  };
});

import { contentRoutes } from '../../src/api/routes/content';

interface ExpressRouteLayer {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
}

interface RouteCase {
  method: string;
  registeredPath: string;
  requestPath: string;
  cameFromArrayPath: boolean;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

const router = contentRoutes();
const routeCases = enumerateRouteCases(router);

describe('Content route internal authentication matrix', () => {
  it('rejects every registered route with the canonical 401 before durable service access', async () => {
    // Module initialization may perform unrelated boot-readiness probes. Only
    // calls made while dispatching the route matrix are part of this contract.
    serviceSentinels.getDb.mockClear();
    serviceSentinels.recordTenantScopeAnomaly.mockClear();

    expect(routeCases.length).toBeGreaterThan(0);
    expect(routeCases.some((routeCase) => routeCase.registeredPath.includes(':'))).toBe(true);

    const arrayPathCases = routeCases.filter((routeCase) => routeCase.cameFromArrayPath);
    expect(arrayPathCases.map((routeCase) => routeCase.registeredPath).sort()).toEqual([
      '/ideas',
      '/ideas/library',
    ]);

    const failures: string[] = [];
    for (const routeCase of routeCases) {
      const anomalyCallsBefore = serviceSentinels.recordTenantScopeAnomaly.mock.calls.length;
      const response = await dispatchWithoutOuterAuthentication(routeCase.method, routeCase.requestPath);
      const anomalyCallsAfter = serviceSentinels.recordTenantScopeAnomaly.mock.calls.length;
      const routeLabel = `${routeCase.method} ${routeCase.registeredPath}`;
      if (
        response.status !== 401
        || JSON.stringify(response.body) !== JSON.stringify({
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid authenticated user scope',
          },
        })
      ) {
        failures.push(
          `${routeLabel} -> ${response.status} ${JSON.stringify(response.body)}`,
        );
      }
      if (anomalyCallsAfter !== anomalyCallsBefore + 1) {
        failures.push(`${routeLabel} recorded ${anomalyCallsAfter - anomalyCallsBefore} scope anomalies`);
        continue;
      }
      const anomaly = serviceSentinels.recordTenantScopeAnomaly.mock.calls[anomalyCallsBefore]?.[0];
      if (
        anomaly?.layer !== 'delivery'
        || anomaly?.reason !== 'invalid_user_scope'
        || anomaly?.userId !== null
        || typeof anomaly?.operation !== 'string'
        || !anomaly.operation.startsWith('content')
      ) {
        failures.push(`${routeLabel} recorded invalid anomaly metadata: ${JSON.stringify(anomaly)}`);
      }
    }

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(failures, failures.join('\n')).toEqual([]);
    expect(serviceSentinels.recordTenantScopeAnomaly).toHaveBeenCalledTimes(routeCases.length);
    expect(serviceSentinels.getDb).not.toHaveBeenCalled();
  }, 20_000);
});

function enumerateRouteCases(contentRouter: Router): RouteCase[] {
  const layers = (contentRouter as unknown as { stack: ExpressRouteLayer[] }).stack;
  return layers.flatMap((layer) => {
    if (!layer.route) return [];

    const registeredPaths = Array.isArray(layer.route.path)
      ? layer.route.path
      : [layer.route.path];
    const methods = Object.entries(layer.route.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => method.toUpperCase());

    return registeredPaths.flatMap((registeredPath) => methods.map((method) => ({
      method,
      registeredPath,
      requestPath: materializePath(registeredPath),
      cameFromArrayPath: Array.isArray(layer.route?.path),
    })));
  });
}

function materializePath(registeredPath: string): string {
  return registeredPath.replace(/:([A-Za-z0-9_]+)/g, (_match, parameterName: string) => {
    if (/id$/i.test(parameterName)) return '7';
    return `test-${parameterName.toLowerCase()}`;
  });
}

async function dispatchWithoutOuterAuthentication(method: string, path: string): Promise<JsonResponse> {
  return new Promise<JsonResponse>((resolve, reject) => {
    let status = 200;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error(`${method} ${path} did not produce a response`));
    }, 1_000);
    const settle = (body: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, body });
    };
    const response = {
      status(code: number) { status = code; return this; },
      json(body: unknown) { settle(body); return this; },
      send(body: unknown) { settle(body); return this; },
      end() { settle(null); return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
    } as unknown as Response;
    const request = {
      path,
      method,
      url: path,
      originalUrl: `/content${path}`,
      baseUrl: '/content',
      query: {},
      params: {},
      headers: {},
      body: {},
      header() { return undefined; },
      get() { return undefined; },
    } as unknown as Request;

    // Deliberately dispatch directly through contentRoutes(), omitting the
    // composition root's authMiddleware so Content's internal guards execute.
    (router as unknown as {
      handle(req: Request, res: Response, next: (error?: unknown) => void): void;
    }).handle(request, response, (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error ?? new Error(`${method} ${path} fell through the Content router`));
    });
  });
}

import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import type { Router } from 'express';

import { createApiRouter } from '../../src/api/router';
import { authMiddleware } from '../../src/api/auth-middleware';
import { dashboardRoutes } from '../../src/api/routes/dashboard';
import { planRoutes } from '../../src/api/routes/plan';
import { connectionRoutes } from '../../src/api/routes/connections';
import { trainingRoutes } from '../../src/api/routes/training';
import { contentRoutes } from '../../src/api/routes/content';
import { cookingRoutes } from '../../src/api/routes/cooking';
import { financeRoutes } from '../../src/api/routes/finance';
import { invoicesRoutes } from '../../src/api/routes/invoices';
import { calendarRoutes } from '../../src/api/routes/calendar';
import { taskRoutes } from '../../src/api/routes/tasks';
import { settingsRoutes } from '../../src/api/routes/settings';
import { notificationRoutes } from '../../src/api/routes/notifications';
import { reportRoutes } from '../../src/api/routes/reports';

type HttpMethod = 'GET' | 'POST';

async function fetchJson(
  app: express.Express,
  method: HttpMethod,
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

function protectedApp(mountPath: string, router: Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(mountPath, router);
  return app;
}

describe('app-facing router smoke', () => {
  it('serves the public API index without JWT auth', async () => {
    const app = express();
    app.use('/api/v1', express.json(), createApiRouter());

    const res = await fetchJson(app, 'GET', '/api/v1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Nexus Hub iOS API',
      version: 'v1',
      status: 'online',
    });
    expect(res.body.endpoints).toHaveProperty('dashboard');
    expect(res.body.endpoints).toHaveProperty('plan');
  });

  const protectedGetCases: Array<{ label: string; app: express.Express; path: string }> = [
    { label: 'dashboard', app: protectedApp('/dashboard', dashboardRoutes()), path: '/dashboard' },
    { label: 'plan today', app: protectedApp('/plan', planRoutes()), path: '/plan/today' },
    { label: 'connections', app: protectedApp('/connections', connectionRoutes()), path: '/connections' },
    { label: 'training home', app: protectedApp('/training', trainingRoutes()), path: '/training/home' },
    { label: 'content pipeline', app: protectedApp('/content', contentRoutes()), path: '/content/pipeline' },
    { label: 'cooking meal plan', app: protectedApp('/cooking', cookingRoutes()), path: '/cooking/meal-plan' },
    { label: 'finance monthly summary', app: protectedApp('/finance', financeRoutes()), path: '/finance/monthly-summary' },
    { label: 'invoices vendors', app: protectedApp('/invoices', invoicesRoutes()), path: '/invoices/vendors' },
    { label: 'calendar today', app: protectedApp('/calendar', calendarRoutes()), path: '/calendar/today' },
    { label: 'settings status', app: protectedApp('/settings', settingsRoutes()), path: '/settings/status' },
    { label: 'notifications list', app: protectedApp('/notifications', notificationRoutes()), path: '/notifications' },
    { label: 'notifications inbox', app: protectedApp('/notifications', notificationRoutes()), path: '/notifications/inbox' },
    { label: 'reports list', app: protectedApp('/reports', reportRoutes()), path: '/reports' },
    { label: 'reports latest', app: protectedApp('/reports', reportRoutes()), path: '/reports/latest?type=morning_briefing' },
  ];

  it.each(protectedGetCases)('rejects unauthenticated access to $label with the canonical 401 envelope', async ({ app, path }) => {
    const res = await fetchJson(app, 'GET', path);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing token',
      },
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  const protectedMutationCases: Array<{ label: string; app: express.Express; path: string; body?: unknown }> = [
    { label: 'tasks create', app: protectedApp('/tasks', taskRoutes()), path: '/tasks', body: { title: 'test' } },
    { label: 'calendar create', app: protectedApp('/calendar', calendarRoutes()), path: '/calendar/events', body: { title: 'focus' } },
    { label: 'plan recompute', app: protectedApp('/plan', planRoutes()), path: '/plan/recompute', body: {} },
    { label: 'notifications mark read', app: protectedApp('/notifications', notificationRoutes()), path: '/notifications/123/read', body: {} },
    { label: 'notifications read all', app: protectedApp('/notifications', notificationRoutes()), path: '/notifications/read-all', body: {} },
    { label: 'reports mark read', app: protectedApp('/reports', reportRoutes()), path: '/reports/123/read', body: {} },
  ];

  it.each(protectedMutationCases)('rejects unauthenticated mutations on $label with the canonical 401 envelope', async ({ app, path, body }) => {
    const res = await fetchJson(app, 'POST', path, body);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing token',
      },
    });
    expect(typeof res.body.timestamp).toBe('string');
  });
});

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { config } from '../config';
import { allowLocalHealthBypass } from '../api/secret-guards';
import { getCacheStoreStats } from '../services/cache-store';
import { getDashboardCacheInvalidationStats } from '../services/dashboard-cache-invalidator';
import { getRuntimeStatus } from '../services/runtime-status';
import { getJobStatuses, getRecentEvents } from './telemetry';
import { humanUptime } from './formatters';

type HealthSnapshotIntegration = {
  name: string;
  configured: boolean;
  status?: string;
  tokenHealth?: string;
};

type HealthSnapshot = {
  integrations: HealthSnapshotIntegration[];
};

type HealthRoutesOptions = {
  startedAt: number;
  buildSnapshot: () => HealthSnapshot;
};

function uptimeSeconds(startedAt: number): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function memoryMb(): { rss: number; heapUsed: number; heapTotal: number; external: number } {
  const mem = process.memoryUsage();

  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
  };
}

function providerHealthSnapshot(): Record<string, unknown> {
  try {
    const { getActiveProvider } = require('../services/provider-registry');
    const activeProvider = getActiveProvider();
    if (activeProvider) {
      return activeProvider.getProviderHealth();
    }
  } catch { /* provider not initialized yet */ }
  return {};
}

export function registerPortalHealthRoutes(app: Express, options: HealthRoutesOptions): void {
  // GET /health — public, lightweight service readiness.
  app.get('/health', (_req: Request, res: Response) => {
    const uptimeSec = uptimeSeconds(options.startedAt);
    const runtime = getRuntimeStatus();
    const status = runtime.serviceStatus === 'online' ? 'healthy' : 'degraded';

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      uptime: uptimeSec,
      uptimeHuman: humanUptime(uptimeSec),
      server: {
        status: runtime.serviceStatus,
        database: runtime.databaseStatus,
      },
      bot: {
        polling: runtime.botPolling,
        restarting: runtime.botRestarting,
        lastMessageAt: runtime.lastMessageAt,
      },
      database: runtime.databaseStatus,
      memory: memoryMb(),
      timestamp: new Date().toISOString(),
    });
  });

  // GET /health/detailed — operational diagnostics, protected outside local development.
  app.get('/health/detailed', (req: Request, res: Response) => {
    const healthToken = config.health.token;
    if (!healthToken) {
      if (!allowLocalHealthBypass(req)) {
        res.status(401).json({ error: 'HEALTH_TOKEN not configured for /health/detailed' });
        return;
      }
    } else {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${healthToken}`) {
        res.status(401).json({ error: 'Unauthorized — provide Authorization: Bearer <HEALTH_TOKEN>' });
        return;
      }
    }

    const uptimeSec = uptimeSeconds(options.startedAt);
    const runtime = getRuntimeStatus();

    const jobs = getJobStatuses().map(j => ({
      name: j.name,
      label: j.label,
      cronExpression: j.cronExpression,
      domain: j.domain,
      lastRunAt: j.lastRunAt,
      lastResult: j.lastResult,
      lastDurationMs: j.lastDurationMs,
      lastError: j.lastError,
    }));

    const recentEvents = getRecentEvents();
    const errorCount = recentEvents.filter(e => e.type === 'error').length;
    const errorsLast1h = recentEvents.filter(e => {
      if (e.type !== 'error') return false;
      const ageMs = Date.now() - new Date(e.ts).getTime();
      return ageMs < 3_600_000;
    }).length;

    let integrationHealth: { name: string; status: string; configured: boolean; tokenHealth: string }[] = [];
    try {
      const snap = options.buildSnapshot();
      integrationHealth = snap.integrations.map(i => ({
        name: i.name,
        status: i.status ?? 'unknown',
        configured: i.configured,
        tokenHealth: i.tokenHealth ?? 'unknown',
      }));
    } catch { /* snapshot build may fail during startup */ }

    const cache = {
      store: getCacheStoreStats(),
      dashboardInvalidation: getDashboardCacheInvalidationStats(),
    };

    const status = runtime.serviceStatus === 'online' ? 'healthy' : 'degraded';

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      uptime: uptimeSec,
      uptimeHuman: humanUptime(uptimeSec),
      server: {
        status: runtime.serviceStatus,
        database: runtime.databaseStatus,
      },
      bot: {
        polling: runtime.botPolling,
        restarting: runtime.botRestarting,
        lastMessageAt: runtime.lastMessageAt,
      },
      database: runtime.databaseStatus,
      memory: memoryMb(),
      crons: jobs,
      integrations: integrationHealth,
      providers: providerHealthSnapshot(),
      cache,
      errors: {
        total: errorCount,
        lastHour: errorsLast1h,
      },
      timestamp: new Date().toISOString(),
    });
  });
}

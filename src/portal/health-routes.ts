// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { config } from '../config';
import { allowLocalHealthBypass } from '../api/secret-guards';
import { getCacheStoreStats } from '../services/cache-store';
import { getDashboardCacheInvalidationStats } from '../services/dashboard-cache-invalidator';
import { getStatus as getSentryStatus } from '../services/error-tracker';
import { getRuntimeStatus } from '../services/runtime-status';
import { getDb } from '../services/database';
import { getPm2SupervisorHealth, recordPm2SupervisorAlerts } from '../services/pm2-health';
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

type DatabaseProbe = {
  status: 'connected' | 'disconnected';
  checkedAt: string;
  latencyMs: number;
  errorCode?: 'DB_PROBE_FAILED';
};

function probeDatabaseHealth(): DatabaseProbe {
  const startedAt = Date.now();
  try {
    const row = getDb().prepare('SELECT 1 as ok').get() as { ok?: number } | undefined;
    if (row?.ok !== 1) {
      return {
        status: 'disconnected',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        errorCode: 'DB_PROBE_FAILED',
      };
    }
    return {
      status: 'connected',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return {
      status: 'disconnected',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      errorCode: 'DB_PROBE_FAILED',
    };
  }
}

function overallHealthStatus(
  runtime: ReturnType<typeof getRuntimeStatus>,
  databaseProbe: DatabaseProbe,
): 'healthy' | 'degraded' {
  return runtime.serviceStatus === 'online' && databaseProbe.status === 'connected'
    ? 'healthy'
    : 'degraded';
}

export function registerPortalHealthRoutes(app: Express, options: HealthRoutesOptions): void {
  // GET /health — public, lightweight service readiness.
  app.get('/health', (_req: Request, res: Response) => {
    const uptimeSec = uptimeSeconds(options.startedAt);
    const runtime = getRuntimeStatus();
    const databaseProbe = probeDatabaseHealth();
    const status = overallHealthStatus(runtime, databaseProbe);

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      uptime: uptimeSec,
      uptimeHuman: humanUptime(uptimeSec),
      server: {
        status: runtime.serviceStatus,
        database: databaseProbe.status,
      },
      bot: {
        polling: runtime.botPolling,
        restarting: runtime.botRestarting,
        lastMessageAt: runtime.lastMessageAt,
      },
      database: databaseProbe.status,
      databaseProbe,
      memory: memoryMb(),
      timestamp: new Date().toISOString(),
    });
  });

  // GET /health/detailed — operational diagnostics, protected outside local development.
  app.get('/health/detailed', async (req: Request, res: Response) => {
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
    const databaseProbe = probeDatabaseHealth();

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

    const pm2 = await getPm2SupervisorHealth();
    const pm2AlertsRecorded = recordPm2SupervisorAlerts(pm2);
    const status = overallHealthStatus(runtime, databaseProbe);

    res.status(status === 'healthy' ? 200 : 503).json({
      status,
      uptime: uptimeSec,
      uptimeHuman: humanUptime(uptimeSec),
      server: {
        status: runtime.serviceStatus,
        database: databaseProbe.status,
      },
      bot: {
        polling: runtime.botPolling,
        restarting: runtime.botRestarting,
        lastMessageAt: runtime.lastMessageAt,
      },
      database: databaseProbe.status,
      databaseProbe,
      memory: memoryMb(),
      crons: jobs,
      integrations: integrationHealth,
      providers: providerHealthSnapshot(),
      pm2: {
        ...pm2,
        alertsRecorded: pm2AlertsRecorded,
      },
      sentry: getSentryStatus(config.sentry?.environment ?? 'unknown'),
      cache,
      errors: {
        total: errorCount,
        lastHour: errorsLast1h,
      },
      timestamp: new Date().toISOString(),
    });
  });
}

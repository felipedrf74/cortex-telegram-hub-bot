// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { getErrorTrends } from '../services/error-monitor';
import { getErrorDistribution } from '../services/error-categorizer';
import { getSpendByProvider } from '../services/cost-guardrail';
import { getFastpathMetrics, getFastpathPatterns } from '../services/secretary-fastpath';
import { getQualityByAgent } from '../services/quality-scorer';
import { getRecentExecutions, getTaskExecutionSummary } from '../services/task-metrics';
import { sendPortalInternalError } from './http';

interface PortalOperationsRouteDeps {
  getActiveProvider?: () => { getProviderHealth: () => unknown } | null;
}

function getActiveProviderForRoute(deps: PortalOperationsRouteDeps): { getProviderHealth: () => unknown } | null {
  if (deps.getActiveProvider) return deps.getActiveProvider();
  const { getActiveProvider } = require('../services/provider-registry');
  return getActiveProvider();
}

export function registerPortalOperationsRoutes(app: Express, deps: PortalOperationsRouteDeps = {}): void {
  app.get('/api/errors', (_req: Request, res: Response) => {
    try {
      const trends = getErrorTrends();
      res.json({ ok: true, ...trends });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/error-distribution', (_req: Request, res: Response) => {
    try {
      const distribution = getErrorDistribution(7);
      res.json({ ok: true, distribution });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/provider-health', (_req: Request, res: Response) => {
    try {
      const active = getActiveProviderForRoute(deps);
      res.json({ providers: active ? active.getProviderHealth() : {} });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/spend-by-provider', (_req: Request, res: Response) => {
    try {
      res.json(getSpendByProvider());
    } catch {
      res.json({ anthropic: 0, openai: 0, gemini: 0 });
    }
  });

  app.get('/api/secretary-metrics', (_req: Request, res: Response) => {
    try {
      const metrics = getFastpathMetrics();
      res.json({
        ok: true,
        fastpath: {
          totalAttempts: metrics.totalAttempts,
          totalHits: metrics.totalHits,
          hitRate: metrics.hitRate,
          avgLatencyMs: metrics.avgLatencyMs,
          hitsByPattern: metrics.hitsByPattern,
          registeredPatterns: getFastpathPatterns(),
        },
      });
    } catch (err) {
      logger.error({ err }, 'Portal: secretary metrics failed');
      res.json({
        ok: false,
        message: 'Secretary metrics unavailable',
        fastpath: {
          totalAttempts: 0,
          totalHits: 0,
          hitRate: 0,
          avgLatencyMs: 0,
          hitsByPattern: {},
          registeredPatterns: [],
        },
      });
    }
  });

  app.get('/api/quality-scores', (_req: Request, res: Response) => {
    try {
      const byAgent = getQualityByAgent(30);
      res.json({ ok: true, byAgent });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/task-metrics', (_req: Request, res: Response) => {
    try {
      const summary = getTaskExecutionSummary(7);
      const recent = getRecentExecutions(20);
      res.json({ ok: true, summary, recent });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}

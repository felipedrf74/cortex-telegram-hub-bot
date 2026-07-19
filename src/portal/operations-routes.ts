// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { getErrorTrends } from '../services/error-monitor';
import { getErrorDistribution } from '../services/error-categorizer';
import { getSpendByProvider } from '../services/cost-guardrail';
import { getFastpathMetrics, getFastpathPatterns } from '../services/secretary-fastpath';
import { getQualityByAgent } from '../services/quality-scorer';
import { getRecentExecutions, getTaskExecutionSummary } from '../services/task-metrics';
import { getTrainingGenerationObservabilitySnapshot } from '../services/training-generation-observability';
import { getContentWorkspaceObservabilitySnapshot } from '../services/content-workspace-observability';
import {
  acknowledgeOperatorAlert,
  getOperatorAlertDeliverySummary,
  listOperatorAlerts,
  retryOperatorAlertDelivery,
  resolveOperatorAlert,
  type OperatorAlertStatus,
} from '../services/operator-alerts';
import {
  extractPortalActorHint,
  getPortalAuthContext,
  requirePortalAdminToken,
} from '../api/secret-guards';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

interface PortalOperationsRouteDeps {
  getActiveProvider?: () => { getProviderHealth: () => unknown } | null;
}

function getActiveProviderForRoute(deps: PortalOperationsRouteDeps): { getProviderHealth: () => unknown } | null {
  if (deps.getActiveProvider) return deps.getActiveProvider();
  const { getActiveProvider } = require('../services/provider-registry');
  return getActiveProvider();
}

function parseAlertStatus(value: unknown): OperatorAlertStatus | 'all' | undefined {
  if (value === 'open' || value === 'acknowledged' || value === 'resolved' || value === 'all') {
    return value;
  }
  return undefined;
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function portalActor(req: Request): string | undefined {
  return getPortalAuthContext(req)?.actorHint ?? extractPortalActorHint(req);
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

  app.get('/api/spend-by-provider', (req: Request, res: Response) => {
    try {
      const userId = parsePositiveInteger(req.query.userId);
      const tenantId = parsePositiveInteger(req.query.tenantId);
      res.json(getSpendByProvider(undefined, { userId, tenantId }));
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

  app.get('/api/training-generation-metrics', (_req: Request, res: Response) => {
    try {
      res.json({
        ok: true,
        training: getTrainingGenerationObservabilitySnapshot(),
      });
    } catch (err) {
      logger.error({ err }, 'Portal: training generation metrics failed');
      res.json({
        ok: false,
        message: 'Training generation metrics unavailable',
        training: {
          counters: {},
          progression_state_counts: {},
        },
      });
    }
  });

  // The portal composition root rate-limits /api before registering this route family.
  // codeql[js/missing-rate-limiting]
  app.get('/api/content-workspace-metrics', requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      res.json({
        ok: true,
        contentWorkspace: getContentWorkspaceObservabilitySnapshot(),
      });
    } catch (err) {
      sendPortalInternalError(
        res,
        err,
        'Content workspace metrics unavailable',
        'Portal: content workspace metrics failed',
      );
    }
  });

  app.get('/api/operator-alerts', (req: Request, res: Response) => {
    try {
      const status = parseAlertStatus(req.query?.status);
      const limit = parsePositiveInteger(req.query?.limit) ?? 50;
      res.json({
        ok: true,
        alerts: listOperatorAlerts({ status, limit }),
        delivery: getOperatorAlertDeliverySummary(),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/operator-alerts/:id/ack', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = parsePositiveInteger(req.params?.id);
      if (!id) {
        res.status(400).json({ ok: false, message: 'Invalid alert id' });
        return;
      }
      const ok = acknowledgeOperatorAlert(id, portalActor(req));
      if (ok) {
        logPortalAdminMutation(req, 0, 'operator_alert.ack', { alertId: id });
      }
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/operator-alerts/:id/resolve', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = parsePositiveInteger(req.params?.id);
      if (!id) {
        res.status(400).json({ ok: false, message: 'Invalid alert id' });
        return;
      }
      const ok = resolveOperatorAlert(id, portalActor(req));
      if (ok) {
        logPortalAdminMutation(req, 0, 'operator_alert.resolve', { alertId: id });
      }
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/operator-alerts/:id/retry-delivery', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = parsePositiveInteger(req.params?.id);
      if (!id) {
        res.status(400).json({ ok: false, message: 'Invalid alert id' });
        return;
      }
      const ok = retryOperatorAlertDelivery(id);
      if (ok) {
        logPortalAdminMutation(req, 0, 'operator_alert.retry_delivery', { alertId: id });
      }
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}

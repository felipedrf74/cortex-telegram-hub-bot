// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../api/rate-limiter';
import { logger } from '../utils/logger';
import { getErrorTrends } from '../services/error-monitor';
import { getErrorDistribution } from '../services/error-categorizer';
import { getFastpathMetrics, getFastpathPatterns } from '../services/secretary-fastpath';
import { getQualityByAgent } from '../services/quality-scorer';
import {
  getTrainingCoachV2SoakSnapshot,
  recordTrainingCoachV2RuleReview,
  TrainingCoachV2SoakMetricError,
} from '../services/training-coach-v2-soak-metrics';
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
  // The portal composition root already rate-limits every /api request. Keep
  // these sensitive soak controls self-contained as well so a future direct
  // mount cannot put authorization or metric storage ahead of abuse control.
  const configuredLimit = Number.parseInt(process.env.PORTAL_API_RATE_LIMIT ?? '', 10);
  const coachV2SoakRateLimitMiddleware = rateLimit({
    windowMs: 60 * 1000,
    limit: Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 180,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil(options.windowMs / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(options.statusCode).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many portal requests from this IP. Slow down.',
          retryAfter,
        },
      });
    },
  });
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

  app.get('/api/training-coach-v2-soak', coachV2SoakRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      res.json({
        ok: true,
        coachV2Soak: getTrainingCoachV2SoakSnapshot({
          from: typeof req.query?.from === 'string' ? req.query.from : undefined,
          to: typeof req.query?.to === 'string' ? req.query.to : undefined,
        }),
      });
    } catch (err) {
      if (err instanceof TrainingCoachV2SoakMetricError) {
        res.status(400).json({ ok: false, code: err.code, message: err.message });
        return;
      }
      sendPortalInternalError(res, err, 'Coach V2 soak metrics unavailable', 'Portal: Coach V2 soak metrics failed');
    }
  });

  app.post('/api/training-coach-v2-soak/reviews', coachV2SoakRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const tenantId = Number(req.body?.tenantId);
      const userId = Number(req.body?.userId);
      const proposalId = typeof req.body?.proposalId === 'string' ? req.body.proposalId.trim() : '';
      const ruleId = typeof req.body?.ruleId === 'string' ? req.body.ruleId : '';
      const outcome = req.body?.outcome;
      const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : '';
      if (!Number.isSafeInteger(tenantId) || tenantId <= 0
          || !Number.isSafeInteger(userId) || userId <= 0
          || !proposalId || proposalId.length > 160
          || (outcome !== 'correct' && outcome !== 'incorrect')) {
        res.status(400).json({ ok: false, code: 'BAD_REVIEW', message: 'A scoped proposal, rule, outcome, and idempotency key are required.' });
        return;
      }
      const result = recordTrainingCoachV2RuleReview({
        tenantId,
        userId,
        proposalId,
        ruleId,
        outcome,
        idempotencyKey,
      });
      logPortalAdminMutation(req, userId, 'training_coach_v2.rule_review', {
        tenantId,
        proposalId,
        ruleId: ruleId.trim().toLowerCase(),
        outcome,
        replayed: result.replayed,
      });
      res.status(result.replayed ? 200 : 201).json({ ok: true, replayed: result.replayed });
    } catch (err) {
      if (err instanceof TrainingCoachV2SoakMetricError) {
        const status = err.code === 'RULE_FIRING_NOT_FOUND' ? 404 : 409;
        res.status(status).json({ ok: false, code: err.code, message: err.message });
        return;
      }
      sendPortalInternalError(res, err, 'Coach V2 rule review failed', 'Portal: Coach V2 rule review failed');
    }
  });

  // The portal composition root rate-limits /api before registering this route family.
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

  // The portal composition root applies the shared /api limiter before registering this route family.
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

  // The portal composition root applies the shared /api limiter before registering this route family.
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

  // The portal composition root applies the shared /api limiter before registering this route family.
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

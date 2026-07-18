// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import {
  getActiveSignalCount,
  getSignalLog,
  getAgentStats,
  dismissSignal,
  readRankedSignals,
  type SignalType,
} from '../services/intelligence-bus';
import {
  getPipelineStats,
  getPipelineOperationalMetrics,
} from '../agents/pipeline-agent';
import { sendPortalInternalError } from './http';
import { clearPortalSnapshotCache } from './snapshot-cache';

const DEFAULT_RANKED_SIGNAL_TYPES: SignalType[] = [
  'hook_effectiveness',
  'pillar_performance',
  'retention_pattern',
  'voice_pattern',
  'content_formula',
  'keyword_opportunity',
];

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRequiredSignalScope(req: Request, res: Response): { userId: number; tenantId: number } | null {
  const headers = req.headers ?? {};
  const tenantId = parseOptionalPositiveInt(req.query.tenantId ?? headers['x-nexus-tenant-id']);
  const userId = parseOptionalPositiveInt(req.query.userId ?? headers['x-nexus-user-id']) ?? tenantId;
  if (!tenantId || !userId) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'TENANT_SCOPE_REQUIRED',
        message: 'tenantId is required for scoped signal reads',
      },
    });
    return null;
  }
  return { userId, tenantId };
}

export function registerPortalIntelligenceRoutes(app: Express): void {
  app.get('/api/agents', (_req: Request, res: Response) => {
    try {
      const stats = getAgentStats();
      res.json({ ok: true, agents: stats });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/signals', (req: Request, res: Response) => {
    try {
      const scope = parseRequiredSignalScope(req, res);
      if (!scope) return;
      const limit = parsePositiveInt(req.query.limit, 50, 200);
      const typeFilter = req.query.type ? String(req.query.type) : undefined;
      let signals = getSignalLog(limit, scope.userId, scope.tenantId);
      if (typeFilter) {
        signals = signals.filter((signal) => signal.signal_type === typeFilter);
      }
      res.json({ ok: true, signals, activeCount: getActiveSignalCount(scope.userId, scope.tenantId) });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/signals/:id/dismiss', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (Number.isNaN(id)) {
        res.status(400).json({ ok: false, message: 'Invalid ID' });
        return;
      }
      const scope = parseRequiredSignalScope(req, res);
      if (!scope) return;
      const changes = dismissSignal(id, scope.userId, scope.tenantId);
      if (changes === 0) {
        res.status(404).json({ ok: false, message: 'Signal not found in requested scope' });
        return;
      }
      clearPortalSnapshotCache();
      res.json({ ok: true, message: 'Signal dismissed' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/pipeline', (req: Request, res: Response) => {
    try {
      const scope = parseRequiredSignalScope(req, res);
      if (!scope) return;
      const stats = getPipelineStats(scope);
      res.json({ ok: true, ...stats });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/pipeline/metrics', (req: Request, res: Response) => {
    try {
      const scope = parseRequiredSignalScope(req, res);
      if (!scope) return;
      const metrics = getPipelineOperationalMetrics(scope);
      res.json({ ok: true, ...metrics });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/signals/ranked', (req: Request, res: Response) => {
    try {
      const scope = parseRequiredSignalScope(req, res);
      if (!scope) return;
      const types = String(req.query.types || '')
        .split(',')
        .map((type) => type.trim())
        .filter(Boolean);
      const requestedTypes = (types.length > 0 ? types : DEFAULT_RANKED_SIGNAL_TYPES) as SignalType[];
      const ranked = readRankedSignals('portal-inspector', requestedTypes, {
        limit: parsePositiveInt(req.query.limit, 20, 200),
        userId: scope.userId,
        tenantId: scope.tenantId,
        pillar: (req.query.pillar as string) || undefined,
        format: (req.query.format as string) || undefined,
        minConfidence: parseFloat(String(req.query.minConfidence || '0.1')),
      });

      res.json({
        ok: true,
        count: ranked.length,
        signals: ranked.map((signal: any) => ({
          id: signal.id,
          type: signal.signal_type,
          source: signal.source_agent,
          confidence: signal.confidence,
          relevanceScore: signal.relevanceScore,
          ageHours: signal.ageHours,
          priority: signal.priority,
          pillar: signal.pillar_tag,
          format: signal.format_tag,
          evidenceCount: signal.evidence_count,
          payload: signal.payload,
          createdAt: signal.created_at,
        })),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}

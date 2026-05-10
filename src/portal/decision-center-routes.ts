// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import {
  DecisionActionError,
  getDecisionItem,
  getDecisionSummary,
  listDecisionItems,
  performDecisionAction,
  type DecisionApiItem,
  type DecisionUrgency,
} from '../services/decision-center';
import type { NotificationIntentType, NotificationSourceSkill } from '../services/notification-orchestrator';
import { requireOperatorTargetUser } from './admin-target-user';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveTenantId(req: Request, userId: number): number | null {
  const rawTenant = req.body?.tenantId ?? req.query.tenantId;
  const tenantId = rawTenant === undefined || rawTenant === null || rawTenant === ''
    ? userId
    : parsePositiveInteger(rawTenant);
  if (!tenantId) return null;
  return tenantId === userId ? tenantId : null;
}

function sendBadRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ ok: false, error: { code, message } });
}

function sendForbiddenTenant(res: Response): void {
  res.status(403).json({
    ok: false,
    error: {
      code: 'FORBIDDEN_TENANT_SCOPE',
      message: 'operator is not scoped to this Decision Center tenant',
    },
  });
}

function sendDecisionError(res: Response, err: unknown): void {
  if (err instanceof DecisionActionError) {
    res.status(err.status).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }
  sendPortalInternalError(res, err, 'Portal Decision Center request failed', 'Portal: decision center request failed');
}

function sanitizePortalDecisionItem(item: DecisionApiItem): Record<string, unknown> {
  return {
    decisionId: item.decisionId,
    userId: item.userId,
    tenantId: item.tenantId,
    sourceSkill: item.sourceSkill,
    type: item.type,
    status: item.status,
    urgency: item.urgency,
    priorityScore: item.priorityScore,
    title: item.safePreviewTitle,
    summary: item.safePreviewBody,
    recommendedActionLabel: item.recommendedActionLabel,
    whySummary: item.whySummary,
    whyDetails: item.whyDetails,
    deadlineAt: item.deadlineAt,
    expiresAt: item.expiresAt,
    privacyClassification: item.privacyClassification,
    visibilityScope: item.visibilityScope,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    actions: item.actions.map((action) => ({
      id: action.id,
      label: action.label,
      style: action.style,
      destructive: action.style === 'destructive',
    })),
  };
}

export function registerPortalDecisionCenterRoutes(app: Express): void {
  const guards = [requirePortalAdminToken, requireOperatorTargetUser('userId')] as const;

  app.get('/api/users/:userId/decision-center/summary', ...guards, (req: Request, res: Response) => {
    try {
      const userId = parsePositiveInteger(req.params.userId);
      if (!userId) {
        sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
        return;
      }
      const tenantId = resolveTenantId(req, userId);
      if (!tenantId) {
        sendForbiddenTenant(res);
        return;
      }
      const summary = getDecisionSummary(userId, tenantId, Number(req.query.limit ?? 3));
      res.json({
        ok: true,
        tenantId,
        summary: {
          ...summary,
          previewItems: summary.previewItems.map(sanitizePortalDecisionItem),
        },
      });
    } catch (err) {
      sendDecisionError(res, err);
    }
  });

  app.get('/api/users/:userId/decision-center/decisions', ...guards, (req: Request, res: Response) => {
    try {
      const userId = parsePositiveInteger(req.params.userId);
      if (!userId) {
        sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
        return;
      }
      const tenantId = resolveTenantId(req, userId);
      if (!tenantId) {
        sendForbiddenTenant(res);
        return;
      }
      const items = listDecisionItems(userId, tenantId, {
        status: typeof req.query.status === 'string' ? req.query.status : 'all',
        sourceSkill: typeof req.query.sourceSkill === 'string' ? req.query.sourceSkill as NotificationSourceSkill : undefined,
        type: typeof req.query.type === 'string' ? req.query.type as NotificationIntentType : undefined,
        urgency: typeof req.query.urgency === 'string' ? req.query.urgency as DecisionUrgency : undefined,
        limit: Number(req.query.limit ?? 80),
      });
      res.json({
        ok: true,
        tenantId,
        count: items.length,
        items: items.map(sanitizePortalDecisionItem),
      });
    } catch (err) {
      sendDecisionError(res, err);
    }
  });

  app.get('/api/users/:userId/decision-center/decisions/:decisionId', ...guards, (req: Request, res: Response) => {
    try {
      const userId = parsePositiveInteger(req.params.userId);
      if (!userId) {
        sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
        return;
      }
      const tenantId = resolveTenantId(req, userId);
      if (!tenantId) {
        sendForbiddenTenant(res);
        return;
      }
      const item = getDecisionItem(String(req.params.decisionId || ''), userId, tenantId);
      if (!item) {
        res.status(404).json({ ok: false, error: { code: 'DECISION_NOT_FOUND', message: 'Decision not found' } });
        return;
      }
      res.json({ ok: true, tenantId, item: sanitizePortalDecisionItem(item) });
    } catch (err) {
      sendDecisionError(res, err);
    }
  });

  app.post('/api/users/:userId/decision-center/decisions/:decisionId/actions', ...guards, (req: Request, res: Response) => {
    void (async () => {
      try {
        const userId = parsePositiveInteger(req.params.userId);
        if (!userId) {
          sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
          return;
        }
        const tenantId = resolveTenantId(req, userId);
        if (!tenantId) {
          sendForbiddenTenant(res);
          return;
        }
        const result = await performDecisionAction(
          String(req.params.decisionId || ''),
          String(req.body?.actionId || ''),
          userId,
          tenantId,
          {
            idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
            payload: typeof req.body?.payload === 'object' && req.body.payload ? req.body.payload : {},
          },
        );
        logPortalAdminMutation(req, userId, 'portal.decision_center.action', {
          tenantId,
          decisionId: req.params.decisionId,
          actionId: req.body?.actionId,
        });
        res.json({
          ok: true,
          actionId: result.actionId,
          status: result.status,
          idempotent: result.idempotent,
          item: sanitizePortalDecisionItem(result.item),
          verification: result.verification,
        });
      } catch (err) {
        sendDecisionError(res, err);
      }
    })();
  });
}

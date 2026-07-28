// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Request, Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import {
  isExplicitLocalChatEvalDockerBridgeRequest,
  isLoopbackRequest,
} from '../secret-guards';
import { getDb } from '../../services/database';
import { getUserById } from '../../services/user-service';
import {
  CHAT_LIVE_EVAL_SCENARIO_IDS,
  ChatLiveEvalContractError,
  readChatLiveEvalRunEvidence,
  resolveChatLiveEvalRequest,
  type ChatLiveEvalPhase,
  type ChatLiveEvalRequestContext,
} from '../../services/chat-live-evaluation-contract';
import {
  CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
  prepareChatLiveEvalScenario,
} from '../../services/chat-live-evaluation-state';

type ChatRouteScopeGuard = (
  res: Response,
  userId: number | undefined,
  tenantId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Authorization');
}

function resolveRequest(
  req: Request,
  phase: ChatLiveEvalPhase,
  userId: number,
  tenantId: number,
): ChatLiveEvalRequestContext {
  const context = resolveChatLiveEvalRequest({
    readHeader: (name) => req.header(name),
    phase,
    userId,
    tenantId,
    principalEmail: getUserById(userId)?.email ?? null,
    isLoopback: (
      isLoopbackRequest(req)
      || isExplicitLocalChatEvalDockerBridgeRequest(req)
    ),
  });
  if (!context) {
    throw new ChatLiveEvalContractError(
      'CHAT_LIVE_EVAL_INVALID',
      'Chat live-evaluation contract headers are required.',
      400,
    );
  }
  return context;
}

function sendContractError(res: Response, error: unknown): boolean {
  if (!(error instanceof ChatLiveEvalContractError)) return false;
  res.status(error.status).json({ error: { code: error.code, message: error.message } });
  return true;
}

export function registerChatEvalRoutes(
  router: Router,
  ensureValidChatRouteScope: ChatRouteScopeGuard,
): void {
  router.get('/eval/preflight', (req, res: Response) => {
    noStore(res);
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_live_eval_preflight')) return;
    try {
      const context = resolveRequest(req, 'preflight', userId, tenantId);
      res.json({
        ok: true,
        data: {
          contractVersion: context.version,
          mode: context.mode,
          runId: context.runId,
          budget: context.budget,
          targetBaseCategory: context.targetBaseCategory,
          providerPolicy: context.providerPolicy,
          productionDataUsed: false,
          seedProfileVersion: CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
          supportedScenarioIds: CHAT_LIVE_EVAL_SCENARIO_IDS,
        },
      });
    } catch (error) {
      if (!sendContractError(res, error)) throw error;
    }
  });

  router.post('/eval/scenario/reset', (req, res: Response) => {
    noStore(res);
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_live_eval_scenario_reset')) return;
    try {
      const context = resolveRequest(req, 'reset', userId, tenantId);
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      if (
        Object.keys(body).some((key) => key !== 'scenarioId')
        || body.scenarioId !== context.scenarioId
      ) {
        throw new ChatLiveEvalContractError(
          'CHAT_LIVE_EVAL_INVALID',
          'Scenario preparation accepts only the allowlisted scenario identity from the signed run contract.',
          400,
        );
      }
      const preparation = prepareChatLiveEvalScenario(getDb(), context);
      res.json({ ok: true, data: { ...preparation, productionDataUsed: false } });
    } catch (error) {
      if (!sendContractError(res, error)) throw error;
    }
  });

  router.get('/eval/evidence', (req, res: Response) => {
    noStore(res);
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_live_eval_evidence')) return;
    try {
      const context = resolveRequest(req, 'evidence', userId, tenantId);
      res.json({ ok: true, data: readChatLiveEvalRunEvidence(getDb(), context) });
    } catch (error) {
      if (!sendContractError(res, error)) throw error;
    }
  });
}

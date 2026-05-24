// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { type Express, type Request, type Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import {
  listChatEvalRuns,
  persistChatEvalRun,
  type PersistChatEvalRunOptions,
} from '../services/chat-eval-history';
import type { ChatEvaluationSuiteResult } from '../services/chat-evaluation-harness';
import { sendPortalInternalError } from './http';

interface EvalHistoryRequestBody {
  result?: ChatEvaluationSuiteResult;
  runId?: string;
  packageVersion?: string;
  gitBranch?: string;
  gitCommit?: string;
  jsonReportPath?: string;
  markdownReportPath?: string;
  budgetUsd?: number;
  productionDataUsed?: boolean;
  realProviderCalls?: boolean | number;
}

export function registerPortalEvalHistoryRoutes(app: Express): void {
  app.get('/api/portal/eval-history', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit);
      const mode = parseMode(req.query.mode);
      const runs = listChatEvalRuns(getDb(), { limit, mode });
      res.json({ ok: true, runs });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: eval history request failed');
    }
  });

  app.post('/api/portal/eval-history', requirePortalAdminToken, express.json({ limit: '2mb' }), (req: Request, res: Response) => {
    try {
      const body = normalizeBody(req.body);
      if (!body || !isChatEvaluationSuiteResult(body.result)) {
        res.status(400).json({
          ok: false,
          error: {
            code: 'INVALID_EVAL_RESULT',
            message: 'result must be a chat evaluation suite result',
          },
        });
        return;
      }

      const options: PersistChatEvalRunOptions = {
        db: getDb(),
        runId: stringOrUndefined(body.runId),
        packageVersion: stringOrUndefined(body.packageVersion),
        gitBranch: stringOrUndefined(body.gitBranch),
        gitCommit: stringOrUndefined(body.gitCommit),
        jsonReportPath: stringOrUndefined(body.jsonReportPath),
        markdownReportPath: stringOrUndefined(body.markdownReportPath),
        budgetUsd: typeof body.budgetUsd === 'number' && Number.isFinite(body.budgetUsd) ? body.budgetUsd : null,
        productionDataUsed: body.productionDataUsed === true,
        realProviderCalls: normalizeRealProviderCalls(body.realProviderCalls),
      };
      const persisted = persistChatEvalRun(body.result, options);
      res.json({
        ok: true,
        runId: persisted.runId,
        runRowId: persisted.runRowId,
        scenarioCount: persisted.scenarioCount,
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: eval history persist failed');
    }
  });
}

function normalizeBody(body: unknown): EvalHistoryRequestBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (isChatEvaluationSuiteResult(candidate)) {
    return { result: candidate as unknown as ChatEvaluationSuiteResult };
  }
  return candidate as unknown as EvalHistoryRequestBody;
}

function isChatEvaluationSuiteResult(value: unknown): value is ChatEvaluationSuiteResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.generatedAt === 'string'
    && (candidate.mode === 'fixture' || candidate.mode === 'local_engine' || candidate.mode === 'real_provider')
    && typeof candidate.passed === 'boolean'
    && typeof candidate.averageScore === 'number'
    && typeof candidate.scenarioCount === 'number'
    && candidate.statusCounts !== null
    && typeof candidate.statusCounts === 'object'
    && Array.isArray(candidate.qualityMetrics)
    && candidate.dayToDay !== null
    && typeof candidate.dayToDay === 'object'
    && Array.isArray(candidate.scenarios);
}

function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseMode(raw: unknown): 'fixture' | 'local_engine' | 'real_provider' | undefined {
  return raw === 'fixture' || raw === 'local_engine' || raw === 'real_provider' ? raw : undefined;
}

function normalizeRealProviderCalls(value: unknown): boolean | number | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

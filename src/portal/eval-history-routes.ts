// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { type Express, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../api/rate-limiter';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import {
  acceptFrozenRealProviderBaseline,
  ChatEvalBaselineAcceptanceError,
  listChatEvalRuns,
  persistChatEvalRun,
  readFrozenRealProviderBaselineState,
  type PersistChatEvalRunOptions,
  type ChatEvalRunCostAttestation,
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
  costAttestation?: ChatEvalRunCostAttestation | null;
  preflightAttestation?: Record<string, unknown> | null;
}

export function registerPortalEvalHistoryRoutes(app: Express): void {
  const routeRateLimitMiddleware = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil(options.windowMs / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(options.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many chat-eval history requests. Slow down.', retryAfter },
      });
    },
  });

  app.get('/api/portal/eval-history', routeRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const limit = parseLimit(req.query.limit);
      const mode = parseMode(req.query.mode);
      const db = getDb();
      const runs = listChatEvalRuns(db, { limit, mode });
      const frozenBaseline = readFrozenRealProviderBaselineState(db);
      res.json({ ok: true, runs, frozenBaseline });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: eval history request failed');
    }
  });

  app.post('/api/portal/eval-history', routeRateLimitMiddleware, requirePortalAdminToken, express.json({ limit: '2mb' }), (req: Request, res: Response) => {
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
        costAttestation: normalizeCostAttestation(body.costAttestation),
        preflightAttestation: normalizePreflightAttestation(body.preflightAttestation),
      };
      if (body.result.mode !== 'fixture' && (
        !options.costAttestation?.attested
        || !options.preflightAttestation
      )) {
        res.status(400).json({
          ok: false,
          error: {
            code: 'INVALID_EVAL_EVIDENCE',
            message: 'live eval results require attested cost and authenticated preflight evidence',
          },
        });
        return;
      }
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

  app.post(
    '/api/portal/eval-history/frozen-baseline',
    routeRateLimitMiddleware,
    requirePortalAdminToken,
    express.json({ limit: '32kb' }),
    (req: Request, res: Response) => {
      try {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? req.body as Record<string, unknown>
          : {};
        const accepted = acceptFrozenRealProviderBaseline(getDb(), {
          runId: stringValue(body.runId),
          evidenceJsonPath: stringValue(body.evidenceJsonPath),
          evidenceMarkdownPath: stringValue(body.evidenceMarkdownPath),
          evidenceJsonSha256: stringValue(body.evidenceJsonSha256),
          evidenceMarkdownSha256: stringValue(body.evidenceMarkdownSha256),
          acknowledgeOperatorCheckoutProvenance:
            body.acknowledgeOperatorCheckoutProvenance === true,
          runtime: {
            nodeEnv: process.env.NODE_ENV,
            nexusEnv: process.env.NEXUS_ENV,
            staging: process.env.STAGING,
          },
        });
        res.json({ ok: true, ...accepted });
      } catch (err) {
        if (err instanceof ChatEvalBaselineAcceptanceError) {
          res.status(err.status).json({
            ok: false,
            error: { code: err.code, message: err.message },
          });
          return;
        }
        sendPortalInternalError(res, err, 'Portal request failed', 'Portal: frozen eval baseline acceptance failed');
      }
    },
  );
}

function normalizeCostAttestation(value: unknown): ChatEvalRunCostAttestation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const numericKeys = [
    'totalCeilingUsd', 'targetCeilingUsd', 'judgeCeilingUsd',
    'targetActualSpendUsd', 'targetReservedAttemptCeilingUsd', 'targetCommittedCeilingUsd',
    'judgeEstimatedSpendUsd', 'judgeActualSpendUsd', 'judgeReservedAttemptCeilingUsd',
    'judgeCommittedCeilingUsd', 'judgeUsageCallCount', 'judgeProviderAttemptCount',
    'judgeUnresolvedPricingCount', 'totalActualSpendUsd',
    'totalEstimatedActualSpendUsd', 'totalConservativeCommitmentUsd',
    'targetUsageCallCount', 'targetProviderAttemptCount', 'unresolvedPricingCount',
  ];
  if (
    candidate.contractVersion !== 'chat-live-eval-v1'
    || typeof candidate.attested !== 'boolean'
    || !isStringArray(candidate.reasons)
    || !isStringArray(candidate.targetProviders)
    || !isStringArray(candidate.judgeProviders)
    || !isStringArray(candidate.judgeModels)
    || (
      candidate.judgeUsageDatabaseSha256 !== null
      && typeof candidate.judgeUsageDatabaseSha256 !== 'string'
    )
    || !candidate.preparation
    || typeof candidate.preparation !== 'object'
    || numericKeys.some((key) => typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key]) || Number(candidate[key]) < 0)
  ) return null;
  return candidate as unknown as ChatEvalRunCostAttestation;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizePreflightAttestation(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.contractVersion !== 'chat-live-eval-v1'
    || (candidate.mode !== 'local_engine' && candidate.mode !== 'real_provider')
    || typeof candidate.runId !== 'string'
    || typeof candidate.providerPolicy !== 'string'
    || candidate.productionDataUsed !== false
    || typeof candidate.seedProfileVersion !== 'string'
    || !Array.isArray(candidate.supportedScenarioIds)
  ) return null;
  return {
    contractVersion: candidate.contractVersion,
    mode: candidate.mode,
    runId: candidate.runId.slice(0, 160),
    budget: candidate.budget,
    targetBaseCategory: candidate.targetBaseCategory,
    providerPolicy: candidate.providerPolicy,
    productionDataUsed: false,
    seedProfileVersion: candidate.seedProfileVersion,
    supportedScenarioIds: candidate.supportedScenarioIds
      .filter((item): item is string => typeof item === 'string')
      .slice(0, 32),
    // This normalizer rebuilds the attestation from an explicit field list, so
    // the server-attested deployed identity must be carried through here or the
    // run's provenance is silently reduced back to the operator's checkout.
    deployedRelease: normalizeDeployedRelease(candidate.deployedRelease),
  };
}

function normalizeDeployedRelease(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const runtimeSha = typeof candidate.runtimeSha === 'string' ? candidate.runtimeSha : '';
  const artifactDigest = typeof candidate.artifactDigest === 'string' ? candidate.artifactDigest : '';
  const role = candidate.role;
  if (
    !/^[a-f0-9]{40}$/.test(runtimeSha)
    || !/^[a-f0-9]{64}$/.test(artifactDigest)
    || (role !== 'staging' && role !== 'production')
  ) return null;
  return { runtimeSha, artifactDigest, role };
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

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

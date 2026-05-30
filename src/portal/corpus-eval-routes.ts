// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-19 — admin-scoped, read-only portal surface for the corpus-eval run
 * history (`chat_v2_gate_eval_runs`, migration 176).
 *
 *   GET …/eval-runs — the per-run recall@k history (eval_type, recall, k,
 *                      corpus item counts, corpus content-HASH, synthetic-seed
 *                      flag, persisted flag, recorded_at). Newest first, capped.
 *
 * Default-off: registered ONLY when
 * `resolveChatCoreV2ActivationConfig(process.env).mode !== 'off'` — the SINGLE
 * canonical parser, never an inline toLowerCase().trim() (§5.A). When the
 * orchestrator is off, the route is absent and a request 404s (Express
 * default), so the surface leaks nothing while the feature is dark. Matches the
 * WP-12 observability routes and the WP-13 gate-readiness route exactly.
 *
 * Admin auth: `requirePortalAdminToken` (operator-only), running BEFORE the data
 * handler, so a rejected request never touches the DB.
 *
 * Privacy (§1.3 / §5.F): responses carry ONLY safe scalars — an eval-type enum,
 * a numeric recall, integer counts, a corpus CONTENT-HASH (a digest, never the
 * corpus text), and timestamps. There is NO message text, user input, tenant
 * identity, candidate/expected capability label, or any salted token in this
 * surface — the run-history table never persisted any of those. The read uses
 * the typed store reader (`listChatCoreV2GateEvalRuns`), not a SELECT *.
 *
 * Graceful no-such-table: the store reader returns [] when the table does not
 * exist yet (fresh DB / migration 176 not applied), so a fresh DB yields a 200
 * honest empty envelope rather than a 500.
 */

import { type Express, type Request, type Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { listChatCoreV2GateEvalRuns } from '../services/chat-core-v2/corpus-eval-runner';
import { resolveChatCoreV2ActivationConfig } from '../services/chat-core-v2/activation-flags';
import { sendPortalInternalError } from './http';

export const CHAT_CORE_V2_CORPUS_EVAL_RUNS_ROUTE = '/api/v1/internal/chat-core-v2/eval-runs';

/**
 * Registers the corpus-eval run-history route, but ONLY when the orchestrator
 * mode is not 'off' (default-off). The mode is resolved through the single
 * canonical parser; `env` is injectable for tests.
 */
export function registerPortalChatCoreV2CorpusEvalRoutes(
  app: Express,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resolveChatCoreV2ActivationConfig(env).mode === 'off') {
    return;
  }

  app.get(CHAT_CORE_V2_CORPUS_EVAL_RUNS_ROUTE, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const rows = listChatCoreV2GateEvalRuns(getDb(), parseLimit(req.query.limit));
      res.json({ ok: true, rows });
    } catch (err) {
      sendPortalInternalError(
        res,
        err,
        'Portal request failed',
        'Portal: chat-core-v2 corpus eval-runs request failed',
      );
    }
  });
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 50;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50;
}

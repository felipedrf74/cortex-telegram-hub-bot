// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-13 — admin-scoped portal endpoint exposing the composed, HONEST Phase 2→3
 * shadow gate-readiness report (shadow readiness base + persisted recall@8 +
 * `gateCanPromote`).
 *
 * Default-off: the route is registered ONLY when
 * `resolveChatCoreV2ActivationConfig(process.env).mode !== 'off'` (a single
 * parser — never an inline toLowerCase). When the orchestrator is off, the
 * route is absent and a request 404s (Express default), so the gate surface
 * leaks nothing while the feature is dark.
 *
 * Admin auth: `requirePortalAdminToken` (operator-only), matching the other
 * admin-scoped portal routes. No PII — the report carries only counts/metrics
 * (row counts, schema-valid %, a recall scalar, a corpus content-HASH), never
 * message text, user input, or tenant identity.
 *
 * Graceful no-such-table: `measureChatCoreV2ShadowGateReadiness` already
 * returns an honest empty/false envelope when the gate tables do not exist yet
 * (the store reads return null/[] rather than throwing), so a fresh DB yields a
 * 200 honest report, not a 500.
 */

import { type Express, type Request, type Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import {
  measureChatCoreV2ShadowGateReadiness,
  listChatCoreV2GateCheckLog,
} from '../services/chat-core-v2/gate-metrics-store';
import { resolveChatCoreV2ActivationConfig } from '../services/chat-core-v2/activation-flags';
import { sendPortalInternalError } from './http';

export const CHAT_CORE_V2_GATE_READINESS_ROUTE = '/api/v1/internal/chat-core-v2/shadow-gate-readiness';

/**
 * Registers the gate-readiness route, but ONLY when the orchestrator mode is
 * not 'off' (default-off). The mode is resolved through the single canonical
 * parser; `env` is injectable for tests.
 */
export function registerPortalChatCoreV2GateRoutes(
  app: Express,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resolveChatCoreV2ActivationConfig(env).mode === 'off') {
    return;
  }

  app.get(CHAT_CORE_V2_GATE_READINESS_ROUTE, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const report = measureChatCoreV2ShadowGateReadiness(db);
      const recentChecks = listChatCoreV2GateCheckLog(db, parseLimit(req.query.limit));
      res.json({ ok: true, report, recentChecks });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: chat-core-v2 gate readiness request failed');
    }
  });
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 20;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 20;
}

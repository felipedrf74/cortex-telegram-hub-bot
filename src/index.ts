// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

// MUST be first: installs process error handlers BEFORE config validation
// can throw at module load. Without this, boot-time crashes (missing env
// vars, EADDRINUSE, etc.) bypass the error_log table — see audit P0-6.
import './boot';

import { config } from './config';
import { logger } from './utils/logger';
import { initDatabase, closeDatabase, getDb } from './services/database';
import { createBot } from './bot';
import { startScheduler } from './services/scheduler';
import { setBotRef, setBotPollingActive, setDbProvider } from './portal/telemetry';
import {
  setDbProvider as setBusDbProvider,
  setCacheInvalidator as setBusCacheInvalidator,
  setPlanningInvalidator as setBusPlanningInvalidator,
  setScopeAnomalyReporter,
} from './services/intelligence-bus';
import { createPortalServer } from './portal/server';
import { clearCacheByPrefix } from './services/cache-store';
import { invalidatePlanningCaches } from './services/plan-cache-invalidator';
import { recordTenantScopeAnomaly } from './services/tenant-scope-observability';
import {
  setDbProvider as setErrorDbProvider,
  setAlertCallback,
  setShutdownCallback,
} from './services/error-monitor';
import { init as initSentry, flush as flushSentry } from './services/error-tracker';
import { escapeHtml } from './utils/telegram-formatter';
import type http from 'http';

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 45_000; // 45s — enough for Telegram to release the polling lock

async function main(): Promise<void> {
  logger.info('Starting Nexus Hub...');

  // Initialize Sentry FIRST — must be before any other init so it can
  // capture startup errors (DB open failure, missing env vars, etc.).
  // No-ops gracefully if SENTRY_DSN is empty, so local/staging work.
  initSentry({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    release: config.sentry.release || undefined,
    tracesSampleRate: config.sentry.tracesSampleRate,
  });

  // Initialize database
  initDatabase();

  // Wire up DB providers for telemetry and intelligence bus
  setDbProvider(() => getDb());
  setBusDbProvider(() => getDb() as any);
  setBusCacheInvalidator(clearCacheByPrefix);
  setBusPlanningInvalidator(invalidatePlanningCaches);
  setScopeAnomalyReporter(recordTenantScopeAnomaly);
  setErrorDbProvider(() => getDb());

  // Hardening 2026-04-21: hydrate the in-memory per-plan cost-cap
  // overrides from the `plan_configs` DB table (migration 075).
  // Without this, any admin edits made through the portal's
  // PUT /api/plans/:planId would be lost on process restart until
  // the admin re-applies them. Best-effort — if the migration hasn't
  // run yet (older environment) we silently continue with compiled-in
  // defaults.
  try {
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT plan_id, daily_cost_usd, allowed_skills_json FROM plan_configs WHERE active = 1',
      )
      .all() as Array<{
        plan_id: string;
        daily_cost_usd: number;
        allowed_skills_json: string | null;
      }>;
    const { applyPlanConfigRows } = require('./services/plan-quotas');
    applyPlanConfigRows(rows);
    logger.info({ planCount: rows.length }, 'Plan config overrides loaded from DB (caps + allowed_skills)');
  } catch (err) {
    logger.warn({ err }, 'Plan config hydration skipped (plan_configs table may be missing)');
  }

  // Register task provider adapters (TASK-16b).
  // Adapters self-register into the sync engine's in-memory registry; the
  // 15-minute task_sync cron and the webhook router both look them up here.
  // Wrapped in try/catch so a broken adapter never blocks app boot.
  try {
    const { registerAdapter } = require('./services/task-store/sync-engine');
    const { TodoistAdapter } = require('./services/task-store/todoist-adapter');
    const { NotionAdapter } = require('./services/task-store/notion-adapter');
    registerAdapter(new TodoistAdapter());
    registerAdapter(new NotionAdapter());
    logger.info('Task provider adapters registered: todoist, notion');
  } catch (err) {
    logger.warn({ err }, 'Task provider adapter registration failed');
  }

  // Phase 3 Slice D — Validate that every sub-skill's declared
  // `promptFile` in skill-config.ts actually exists on disk. This is
  // a fail-soft check: a missing persona prompt logs loudly but does
  // NOT block boot (the runtime fallback in getDomainSystemPrompt
  // handles it gracefully by loading the generic domain prompt).
  // Runs here so the error is visible at startup rather than at the
  // moment a user sends a triathlon message and silently falls back.
  try {
    const { runStartupPromptValidation } = require('./skills/prompt-validator');
    runStartupPromptValidation();
  } catch (err) {
    logger.warn({ err }, 'Prompt validation check threw — continuing boot');
  }

  // Process-level error handlers were installed by ./boot at module load
  // (must run BEFORE config import). The error-monitor's boot buffer has
  // already accumulated any boot-phase errors and setErrorDbProvider() above
  // flushed them to error_log.

  // ── Telegram is DEPRECATED (April 2026) ─────────────────────────
  // The iOS app is the primary user experience. Telegram bot startup,
  // polling, and webhook registration are disabled. All delivery now
  // goes through durable reports, notifications/inbox, and APNs push.
  //
  // To re-enable Telegram temporarily: set TELEGRAM_LEGACY_DELIVERY=true
  // in .env and restart. The scheduler's safeSend() gates all sends.
  let bot: any = null;
  if (process.env.TELEGRAM_LEGACY_DELIVERY === 'true' && config.telegram.botToken) {
    try {
      bot = createBot();
      setBotRef(bot);
      logger.info('Telegram bot created (LEGACY mode — TELEGRAM_LEGACY_DELIVERY=true)');
    } catch (err) {
      logger.warn({ err }, 'Telegram bot creation failed — continuing without it');
    }
  }

  // Alert callbacks — log to portal telemetry (no more Telegram alerts by default)
  setAlertCallback(async (message: string) => {
    logger.warn({ alert: message.slice(0, 200) }, 'System alert (Telegram delivery disabled)');
  });
  const { setCostAlertCallback } = require('./services/cost-guardrail');
  setCostAlertCallback(async (message: string) => {
    logger.warn({ alert: message.slice(0, 200) }, 'Cost alert (Telegram delivery disabled)');
  });

  // Start scheduler — bot parameter is optional (null when Telegram disabled)
  startScheduler(bot);

  // Start status portal (Express on :8200)
  let portalServer: http.Server | undefined;
  if (config.portal.enabled) {
    portalServer = createPortalServer(bot);
  }

  // Graceful shutdown — stop polling and release port before exiting so the next instance starts clean
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    try {
      if (bot) bot.stop();
    } catch { /* already stopped or no bot */ }
    if (portalServer) {
      await new Promise<void>((resolve) => portalServer!.close(() => resolve()));
    }
    // Drain Sentry's event queue before the process exits so in-flight
    // error reports aren't lost. 2s timeout — beyond that we move on.
    // No-ops if Sentry was never initialized (empty DSN).
    try { await flushSentry(2000); } catch { /* best effort */ }
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Wire the same graceful shutdown into the error-monitor's process error
  // handlers. Without this, an unhandledRejection or uncaughtException
  // would skip portalServer.close() and leave port 8200 in TIME_WAIT,
  // causing EADDRINUSE on the next deploy. See audit P0-4.
  setShutdownCallback(() => shutdown('error-handler'));

  // ── Telegram polling/webhook is DISABLED ──────────────────────────
  // The process stays alive via portalServer (Express on port 8200).
  // All iOS API routes, scheduled jobs, and portal are served normally.
  // Telegram long-polling and webhook registration are skipped entirely.
  if (!bot) {
    logger.info('✅ Nexus Hub started (Telegram disabled — iOS + Portal + API active)');
    return; // Process stays alive via portalServer
  }

  // Legacy: if TELEGRAM_LEGACY_DELIVERY is true AND bot was created,
  // skip polling anyway — the bot is only used for outbound sends.
  logger.info('✅ Nexus Hub started (Telegram legacy mode — outbound only, no polling)');
  return;

  // ── DEPRECATED: Telegram webhook + polling removed April 2026 ──
  // The code below was the Telegram webhook registration and long-polling
  // loop. It has been removed as part of the Telegram deprecation.
  // If you need to re-enable Telegram for debugging, set
  // TELEGRAM_LEGACY_DELIVERY=true and use the bot instance for outbound
  // sends only (no polling, no webhook).
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error starting Nexus Hub');
  process.exit(1);
});

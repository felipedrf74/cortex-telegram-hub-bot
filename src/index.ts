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
import { setDbProvider as setBusDbProvider } from './services/intelligence-bus';
import { createPortalServer } from './portal/server';
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
  logger.info('Starting Telegram Hub Bot...');

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
  setErrorDbProvider(() => getDb());

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

  // Process-level error handlers were installed by ./boot at module load
  // (must run BEFORE config import). The error-monitor's boot buffer has
  // already accumulated any boot-phase errors and setErrorDbProvider() above
  // flushed them to error_log.

  // Create bot
  const bot = createBot();

  // Store bot reference for portal restart action
  setBotRef(bot);

  // Wire Telegram alerting for critical errors (owner-only — never send internals to regular users)
  const { getOwnerUserIds } = require('./services/scheduler');
  const ownerAlert = async (message: string) => {
    for (const userId of getOwnerUserIds()) {
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: 'HTML' });
      } catch { /* swallow — don't cascade alert failures */ }
    }
  };
  setAlertCallback(ownerAlert);

  // Wire same Telegram alerting for cost guardrail tier crossings (50/80/100%)
  const { setCostAlertCallback } = require('./services/cost-guardrail');
  setCostAlertCallback(ownerAlert);

  // Start scheduler (reminders, daily briefing, weekly review)
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
      bot.stop();
    } catch { /* already stopped */ }
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

  // Staging install without a bot token: skip bot.start() entirely.
  // Everything ELSE (the portal, content-engine integration, scheduled
  // jobs, the iOS API, AI calls) runs normally — only Telegram message
  // ingestion is disabled. This lets staging test 95% of the system
  // without the operator having to provision a second @BotFather bot.
  // Quarter audit item: staging environment.
  if (!config.telegram.botToken && config.isStaging) {
    logger.warn(
      'STAGING mode without TELEGRAM_BOT_TOKEN — skipping Telegram bot.start(). ' +
      'Portal + content-engine + crons will run normally.',
    );
    return; // Returning here keeps the process alive via portalServer
  }

  // Webhook mode (Month 2 audit item).
  //
  // When TELEGRAM_WEBHOOK_URL is set, we register the URL with Telegram
  // and skip the long-polling loop entirely. The webhook route is already
  // mounted by createPortalServer → createWebhookRouter(bot) above. From
  // this point on, Telegram POSTs every update to /webhooks/telegram and
  // grammy's webhookCallback dispatches it through the same middleware
  // chain that long-polling would have used.
  //
  // Why this is the lowest-risk possible migration:
  //   - Default state is unchanged: no env var → long-polling (current)
  //   - Webhook is opt-in via env var only — no code path is silently
  //     activated
  //   - Reverting is a one-line .env change + restart — no code rollback
  //   - The setWebhook call is wrapped in try/catch so a Telegram API
  //     blip during boot doesn't take the whole bot down
  //   - We deleteWebhook first so any stale registration from a previous
  //     attempt is cleaned up before we set the new one
  //   - drop_pending_updates: false because we DON'T want to lose
  //     messages that came in during deploy / restart
  if (config.telegram.webhookUrl) {
    try {
      logger.info(
        { url: config.telegram.webhookUrl, hasSecret: !!config.telegram.webhookSecret },
        'Registering Telegram webhook...',
      );
      // Clean up any stale webhook from a previous run / a different URL.
      // No-op if none registered.
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      // Register the new one. Telegram immediately starts posting updates
      // to this URL.
      await bot.api.setWebhook(config.telegram.webhookUrl, {
        secret_token: config.telegram.webhookSecret || undefined,
        drop_pending_updates: false,
        // We don't restrict allowed_updates here — same as long polling,
        // we accept everything Telegram sends and let grammy filter.
      });
      logger.info({ url: config.telegram.webhookUrl }, '✅ Telegram webhook registered — running in WEBHOOK mode');
      setBotPollingActive(true); // The bot IS now serving updates, just via HTTP not polling
      return; // Skip the polling loop — process stays alive via portalServer
    } catch (err) {
      logger.error({ err }, 'Failed to register Telegram webhook — falling back to long-polling');
      // Fall through to the polling loop below
    }
  }

  // Start bot with retry logic for 409 Conflict (multiple polling instances).
  // Uses exponential backoff: 45s → 90s → 180s to give Telegram time to release the lock.
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info({ attempt }, 'Bot starting with long polling...');
      // Drop pending updates on retry to clear stale getUpdates lock faster
      const startOpts: Parameters<typeof bot.start>[0] = {
        onStart: () => {
          logger.info('Bot is running!');
          setBotPollingActive(true);
          console.log('🤖 Telegram Hub Bot is online!');
        },
      };
      if (attempt > 1) {
        startOpts.drop_pending_updates = true;
      }
      await bot.start(startOpts);
      return; // bot.start() resolved — should not normally happen unless stopped
    } catch (err: any) {
      const is409 = err?.error_code === 409 || err?.message?.includes('409');
      if (is409 && attempt < MAX_RETRIES) {
        // Exponential backoff: 45s, 90s, 180s, 360s
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn({ attempt, maxRetries: MAX_RETRIES, delaySec: delay / 1000 },
          `Telegram 409 conflict — another instance may still be polling. Retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err; // non-409 or exhausted retries — let it crash
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error starting bot');
  process.exit(1);
});

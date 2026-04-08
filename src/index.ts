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
import { escapeHtml } from './utils/telegram-formatter';
import type http from 'http';

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 45_000; // 45s — enough for Telegram to release the polling lock

async function main(): Promise<void> {
  logger.info('Starting Telegram Hub Bot...');

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

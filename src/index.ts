// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

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
  installProcessHandlers,
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

  // Install process-level error handlers (unhandledRejection, uncaughtException)
  installProcessHandlers();

  // Create bot
  const bot = createBot();

  // Store bot reference for portal restart action
  setBotRef(bot);

  // Wire Telegram alerting for critical errors (owner-only — never send internals to regular users)
  const { getOwnerUserIds } = require('./services/scheduler');
  setAlertCallback(async (message: string) => {
    for (const userId of getOwnerUserIds()) {
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: 'HTML' });
      } catch { /* swallow — don't cascade alert failures */ }
    }
  });

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

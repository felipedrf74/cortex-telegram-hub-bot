import { config } from './config';
import { logger } from './utils/logger';
import { initDatabase, closeDatabase } from './services/database';
import { createBot } from './bot';
import { startScheduler } from './services/scheduler';
import { setBotRef, setBotPollingActive } from './portal/telemetry';
import { createPortalServer } from './portal/server';
import type http from 'http';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 40_000; // 40s — enough for Telegram to release the polling lock

async function main(): Promise<void> {
  logger.info('Starting Telegram Hub Bot...');

  // Initialize database
  initDatabase();

  // Create bot
  const bot = createBot();

  // Store bot reference for portal restart action
  setBotRef(bot);

  // Start scheduler (reminders, daily briefing, weekly review)
  startScheduler(bot);

  // Start status portal (Express on :8200)
  let portalServer: http.Server | undefined;
  if (config.portal.enabled) {
    portalServer = createPortalServer(bot);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    bot.stop();
    if (portalServer) {
      portalServer.close();
    }
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start bot with retry logic for 409 Conflict (multiple polling instances)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info({ attempt }, 'Bot starting with long polling...');
      await bot.start({
        onStart: () => {
          logger.info('Bot is running!');
          setBotPollingActive(true);
          console.log('🤖 Telegram Hub Bot is online!');
        },
      });
      return; // bot.start() resolved — should not normally happen unless stopped
    } catch (err: any) {
      const is409 = err?.error_code === 409 || err?.message?.includes('409');
      if (is409 && attempt < MAX_RETRIES) {
        logger.warn({ attempt, maxRetries: MAX_RETRIES }, `Telegram 409 conflict — another instance may still be polling. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
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

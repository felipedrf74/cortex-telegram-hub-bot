import { config } from './config';
import { logger } from './utils/logger';
import { initDatabase, closeDatabase } from './services/database';
import { createBot } from './bot';
import { startScheduler } from './services/scheduler';

async function main(): Promise<void> {
  logger.info('Starting Telegram Hub Bot...');

  // Initialize database
  initDatabase();

  // Create bot
  const bot = createBot();

  // Start scheduler (reminders, daily briefing, weekly review)
  startScheduler(bot);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    bot.stop();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start bot (long polling)
  logger.info('Bot starting with long polling...');
  await bot.start({
    onStart: () => {
      logger.info('Bot is running!');
      console.log('🤖 Telegram Hub Bot is online!');
    },
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error starting bot');
  process.exit(1);
});

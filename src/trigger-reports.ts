// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * One-off script to manually trigger reports.
 * Usage: npx tsx src/trigger-reports.ts [content] [coach] [evening] [briefing]
 * If no args, triggers all four: content, coach, evening, briefing.
 */
import 'dotenv/config';
import { Bot } from 'grammy';
import { config } from './config';
import { isGarminConfigured } from './services/garmin';
import { initDatabase } from './services/database';
import {
  dispatchCoachReports,
  dispatchContentReports,
  dispatchDailyBriefings,
  dispatchEveningReports,
} from './services/manual-report-triggers';

const bot = new Bot(config.telegram.botToken);

async function sendToTelegramTarget(telegramId: number, msg: string, parseMode: 'HTML' | 'MarkdownV2' = 'HTML') {
  await bot.api.sendMessage(telegramId, msg, { parse_mode: parseMode });
}

async function triggerContent() {
  console.log('📝 Running content discovery...');
  await dispatchContentReports(sendToTelegramTarget);
  console.log('✅ Content discovery sent');
}

async function triggerCoach() {
  if (!isGarminConfigured()) {
    console.log('⚠️ Garmin not configured, skipping coach');
    return;
  }
  console.log('🏋️ Running coach briefing...');
  await dispatchCoachReports(sendToTelegramTarget);
  console.log('✅ Coach briefing sent');
}

async function triggerEvening() {
  console.log('🌙 Running evening report...');
  await dispatchEveningReports(sendToTelegramTarget);
  console.log('✅ Evening report sent');
}

async function main() {
  initDatabase();
  const args = process.argv.slice(2);
  const all = args.length === 0;

  if (all || args.includes('content')) await triggerContent();
  if (all || args.includes('coach')) await triggerCoach();
  if (all || args.includes('evening')) await triggerEvening();
  if (all || args.includes('briefing')) {
    console.log('🌅 Running morning briefing...');
    await dispatchDailyBriefings(bot);
    console.log('✅ Morning briefing sent');
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});

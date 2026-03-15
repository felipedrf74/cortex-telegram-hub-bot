/**
 * One-off script to manually trigger reports.
 * Usage: npx tsx src/trigger-reports.ts [content] [coach] [evening] [briefing]
 * If no args, triggers all four: content, coach, evening, briefing.
 */
import 'dotenv/config';
import { Bot } from 'grammy';
import { config } from './config';
import { runContentDiscovery } from './services/content-discovery';
import { generateCoachBriefing } from './services/garmin-coach';
import { isGarminConfigured } from './services/garmin';
import * as msTodo from './services/microsoft-todo';
import { isAnyCalendarConfigured } from './services/unified-calendar';
import { getEvents } from './services/unified-calendar';
import { isOutlookMailConfigured, getUnreadCount } from './services/outlook-mail';
import { getRemindersForToday } from './state/reminders';
import { initDatabase } from './services/database';
import { escapeHtml, splitMessage, formatDailyBriefing, DailyBriefingData } from './utils/telegram-formatter';
import { now, startOfDay, endOfDay, formatTime, formatDateTime } from './utils/date-parser';
import { sendDailyBriefing } from './services/scheduler';

const bot = new Bot(config.telegram.botToken);
const userIds = config.telegram.allowedUserIds;

async function sendToAll(msg: string, parseMode: 'HTML' | 'MarkdownV2' = 'HTML') {
  const chunks = splitMessage(msg);
  for (const userId of userIds) {
    for (const chunk of chunks) {
      await bot.api.sendMessage(userId, chunk, { parse_mode: parseMode });
    }
  }
}

async function triggerContent() {
  console.log('📝 Running content discovery...');
  const result = await runContentDiscovery();
  let msg = `🎬 <b>Daily Content Ideas Ready</b>\n\n`;
  if (result.ideas.length > 0) {
    for (let i = 0; i < result.ideas.length; i++) {
      msg += `${i + 1}. ${escapeHtml(result.ideas[i])}\n`;
    }
  } else {
    msg += `Ideas generated but couldn't parse titles — check the file.\n`;
  }
  msg += `\n📁 <code>${escapeHtml(result.filePath)}</code>`;
  msg += `\n🔍 ${result.searchCount} web searches used`;
  await sendToAll(msg);
  console.log('✅ Content discovery sent');
}

async function triggerCoach() {
  if (!isGarminConfigured()) {
    console.log('⚠️ Garmin not configured, skipping coach');
    return;
  }
  console.log('🏋️ Running coach briefing...');
  const result = await generateCoachBriefing();
  await sendToAll(result.message);
  console.log('✅ Coach briefing sent');
}

async function triggerEvening() {
  if (!msTodo.isOutlookTodoConfigured()) {
    console.log('⚠️ MS Todo not configured, skipping evening report');
    return;
  }
  console.log('🌙 Running evening report...');
  const pendingResult = await msTodo.getAllPendingTasks();
  if (!pendingResult.success) {
    console.log('⚠️ Failed to fetch tasks');
    return;
  }

  const tasks = pendingResult.data;
  const todayStart = new Date(startOfDay()).getTime();
  const todayEnd = new Date(endOfDay()).getTime();

  const dueToday = tasks.filter((t) => {
    if (!t.dueDateTime) return false;
    const due = new Date(t.dueDateTime).getTime();
    return due >= todayStart && due <= todayEnd;
  });

  const overdue = tasks.filter((t) => t.dueDateTime && new Date(t.dueDateTime).getTime() < todayStart);

  if (dueToday.length === 0 && overdue.length === 0) {
    await sendToAll('🌙 <b>End-of-Day Summary</b>\n\nNo tasks due today or overdue. 🎉');
    console.log('✅ Evening report sent (nothing due)');
    return;
  }

  let msg = `🌙 <b>End-of-Day Task Summary</b>\n\n`;
  if (dueToday.length > 0) {
    msg += `📅 <b>Due today (${dueToday.length}):</b>\n`;
    for (const t of dueToday) {
      msg += `• ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
    msg += '\n';
  }
  if (overdue.length > 0) {
    msg += `⚠️ <b>Overdue (${overdue.length}):</b>\n`;
    for (const t of overdue) {
      const daysLate = Math.ceil((todayStart - new Date(t.dueDateTime!).getTime()) / (1000 * 60 * 60 * 24));
      msg += `• ${escapeHtml(t.title)} — ${daysLate}d late <i>[${escapeHtml(t.listName)}]</i>\n`;
    }
  }
  await sendToAll(msg.trim());
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
    await sendDailyBriefing(bot);
    console.log('✅ Morning briefing sent');
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});

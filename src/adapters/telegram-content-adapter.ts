// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Telegram Content Adapter — legacy transport layer for content workflow.
 *
 * This adapter is the ONLY place grammy/Telegram is used for content
 * delivery. The core content-workflow.ts is transport-agnostic — it
 * returns structured data and writes to the notification store.
 *
 * This file will be removed when Telegram is fully deprecated.
 * New content delivery goes through:
 *   1. content_notifications table (durable inbox)
 *   2. APNs push (delivery adapter)
 *   3. iOS GET /api/v1/notifications (read path)
 *
 * @deprecated — use content-notification-store.ts instead.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { escapeHtml } from '../utils/telegram-formatter';
import {
  generateAndStoreTopicCandidates,
  generateWeeklyPackage,
} from '../services/content-workflow';

/**
 * @deprecated Send topic candidates via Telegram.
 * New callers should use generateAndStoreTopicCandidates() +
 * createAndPushNotification() from content-notification-store.ts.
 */
export async function sendTopicCandidatesTelegram(
  bot: Bot,
  userId: number,
  format: 'reel' | 'youtube',
  sourceJob: string,
): Promise<void> {
  const headerEmoji = format === 'reel' ? '🎬' : '🔥';

  const result = await generateAndStoreTopicCandidates(userId, format, sourceJob);

  if (result.candidates.length === 0) {
    await bot.api.sendMessage(userId,
      '❌ Could not generate topic candidates. Try again with /contenttopic.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i];
    const msg = `${headerEmoji} <b>Topic ${i + 1} of ${result.candidates.length}</b>\n\n` +
      `📌 <b>${escapeHtml(c.title)}</b>\n` +
      `🎯 Pillar: ${escapeHtml(c.niche)}\n` +
      `🎣 Hook: <i>"${escapeHtml(c.hookIdea)}"</i>\n` +
      `⏰ Why now: ${escapeHtml(c.whyNow)}`;

    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `cw:approve:${c.feedbackId}`)
      .text('⏭ Skip', `cw:skip:${c.feedbackId}`)
      .text('👎 Not my vibe', `cw:reject:${c.feedbackId}`);

    await bot.api.sendMessage(userId, msg, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  await bot.api.sendMessage(userId,
    `💡 Tap ✅ to generate full scripts. 👎 helps me learn your taste.`,
    { parse_mode: 'HTML' },
  );
}

/**
 * @deprecated Send weekly content package via Telegram.
 * New callers should use generateWeeklyPackage() +
 * createAndPushNotification() from content-notification-store.ts.
 */
export async function sendWeeklyPackageTelegram(
  bot: Bot,
  userId: number,
): Promise<void> {
  await bot.api.sendMessage(userId,
    `📋 <b>WEEKLY CONTENT PACKAGE — Sexta-feira</b>\n\n⏳ Generating evergreen topics for next week...`,
    { parse_mode: 'HTML' },
  );

  const result = await generateWeeklyPackage(userId);

  if (result.youtube.length === 0 && result.reels.length === 0) {
    await bot.api.sendMessage(userId,
      '❌ Could not generate weekly topics. Try again with /contentretro.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const sendGroup = async (items: typeof result.youtube, label: string, emoji: string) => {
    if (items.length === 0) return;
    await bot.api.sendMessage(userId, `${emoji} <b>${label} (${items.length})</b>`, { parse_mode: 'HTML' });
    for (const c of items) {
      const msg = `📌 <b>${escapeHtml(c.title)}</b>\n` +
        `🎯 ${escapeHtml(c.niche)}\n` +
        `🎣 <i>"${escapeHtml(c.hookIdea)}"</i>`;
      const keyboard = new InlineKeyboard()
        .text('✅ Approve', `cw:approve:${c.feedbackId}`)
        .text('⏭ Skip', `cw:skip:${c.feedbackId}`)
        .text('👎 Not my vibe', `cw:reject:${c.feedbackId}`);
      await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  };

  await sendGroup(result.youtube, 'YOUTUBE EVERGREEN', '🎥');
  await sendGroup(result.reels, 'REELS EVERGREEN', '🎬');

  await bot.api.sendMessage(userId,
    `✅ Approve the topics you want scripted. Scripts will be saved to <code>~/Desktop/IDEAS/weekly/</code>`,
    { parse_mode: 'HTML' },
  );
}

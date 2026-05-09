// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { getOwnerBootstrapTarget } from './user-service';
import { splitMessage, escapeHtml } from '../utils/telegram-formatter';
import { runContentDiscovery } from './content-discovery';
import { generateCoachBriefing } from './garmin-coach';
import { buildEndOfDaySummaryForUser, sendDailyBriefing } from './scheduler';

export interface ManualReportTarget {
  userId: number;
  tenantId: number;
  telegramId: number;
}

export type TelegramSend = (
  telegramId: number,
  message: string,
  parseMode?: 'HTML' | 'MarkdownV2',
) => Promise<void>;

export function getManualReportTargets(): ManualReportTarget[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, telegram_id FROM users WHERE status = 'active' AND telegram_id IS NOT NULL"
    ).all() as { id: number; telegram_id: number | null }[];
    if (rows.length > 0) {
      return rows
        .filter((row) => row.telegram_id != null)
        .map((row) => ({
          userId: row.id,
          tenantId: row.id,
          telegramId: row.telegram_id as number,
        }));
    }
  } catch {
    // users table may not exist yet — fall back to the explicit owner target
  }

  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget?.telegramId != null ? [{
    userId: ownerTarget.tenantId,
    tenantId: ownerTarget.tenantId,
    telegramId: ownerTarget.telegramId,
  }] : [];
}

async function sendChunked(
  target: ManualReportTarget,
  message: string,
  send: TelegramSend,
  parseMode: 'HTML' | 'MarkdownV2' = 'HTML',
): Promise<void> {
  const chunks = splitMessage(message);
  for (const chunk of chunks) {
    await send(target.telegramId, chunk, parseMode);
  }
}

export async function dispatchContentReports(send: TelegramSend): Promise<void> {
  for (const target of getManualReportTargets()) {
    const result = await runContentDiscovery({ userId: target.userId, tenantId: target.tenantId });
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
    await sendChunked(target, msg, send, 'HTML');
  }
}

export async function dispatchCoachReports(send: TelegramSend): Promise<void> {
  for (const target of getManualReportTargets()) {
    const result = await generateCoachBriefing(target.tenantId, { garminSilent: true });
    await sendChunked(target, result.message, send, 'HTML');
  }
}

export async function dispatchEveningReports(send: TelegramSend): Promise<void> {
  for (const target of getManualReportTargets()) {
    const report = await buildEndOfDaySummaryForUser(target.tenantId);
    const message = report?.message ?? '🌙 <b>End-of-Day Summary</b>\n\nNo tasks due today or overdue. 🎉';
    await sendChunked(target, message, send, 'HTML');
  }
}

export async function dispatchDailyBriefings(bot?: any): Promise<void> {
  await sendDailyBriefing(bot);
}

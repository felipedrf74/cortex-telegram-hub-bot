// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Telegram file download helper — shared across callback and command handlers.
 */

import { Bot } from 'grammy';
import { config } from '../config';

/** Re-download a photo from Telegram by file_id. Returns { base64, mediaType }. */
export async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  const file = await bot.api.getFile(fileId);
  // SECURITY: fileUrl contains bot token — never log this variable
  const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'jpg';
  const mediaType = (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp';
  return { base64: buffer.toString('base64'), mediaType };
}

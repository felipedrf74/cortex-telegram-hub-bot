// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Telegram legacy factory.
 *
 * Telegram inbound handlers were removed after their app/API replacements
 * landed. This factory is intentionally outbound-only: scheduler and portal
 * code can still receive a Grammy Bot instance for legacy safeSend paths when
 * TELEGRAM_LEGACY_DELIVERY=true, but the process never registers commands,
 * message handlers, callback queries, polling, or webhooks.
 */

import { Bot } from 'grammy';
import { config } from './config';

// ─── Bot Factory ────────────────────────────────────────────────────

export function createBot(): Bot {
  // Staging installs may not have a Telegram token. A placeholder keeps the
  // legacy outbound object constructible without enabling inbound delivery.
  const token = config.telegram.botToken || 'staging-no-bot-token-placeholder';
  return new Bot(token);
}

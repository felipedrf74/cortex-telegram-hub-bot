// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Bot composition root — creates and configures the Grammy bot.
 *
 * This file is intentionally thin (~200 lines). All command handlers,
 * callback queries, and media handlers are in src/handlers/.
 *
 * Phase 1: shared-state.ts, help-text.ts
 * Phase 2: message.ts, photo.ts, onboarding.ts, secretary-helpers.ts
 * Phase 3: commands/secretary.ts
 * Phase 4: commands/system.ts, content.ts, finance.ts, triathlon.ts, skills-commands.ts
 * Phase 5: callback-query.ts, media.ts, text.ts (this file — composition root)
 */

import { Bot, GrammyError, HttpError } from 'grammy';
import { config } from './config';
import { logger } from './utils/logger';
import { runWithContext, generateRequestId } from './utils/request-context';
import { DomainName } from './domains/types';

// ── Domain Handlers ──
import { handleSecretary } from './domains/secretary';
import { handleTriathlon } from './domains/triathlon';
import { handleContent } from './domains/content-creator';
import { handleFinance } from './domains/finance';
import { handleCooking } from './domains/cooking';

// ── Middleware dependencies ──
import { isRateLimited } from './handlers/shared-state';
import { recordMessageProcessed } from './portal/telemetry';
import { isAnyCalendarConfigured } from './services/unified-calendar';
import { getMasterCategories } from './services/outlook-calendar';
import { setMfaNotifier } from './services/garmin';

// ── Command & handler registration ──
import { registerSystemCommands } from './handlers/commands/system';
import { registerSkillCommands } from './handlers/commands/skills-commands';
import { registerSecretaryCommands } from './handlers/commands/secretary';
import { registerContentCommands } from './handlers/commands/content';
import { registerFinanceCommands } from './handlers/commands/finance';
import { registerTriathlonCommands } from './handlers/commands/triathlon';
import { registerCallbackQueries } from './handlers/callback-query';
import { registerMediaHandlers } from './handlers/media';
import { registerTextHandler } from './handlers/text';

// ── Re-exports (backward compatibility for scheduler.ts and other modules) ──
export { setLastActiveDomain } from './handlers/shared-state';

// ─── Domain Handler Registry ────────────────────────────────────────

const DOMAIN_HANDLERS: Record<string, (message: string, userId?: number) => Promise<{ text: string; domain: DomainName }>> = {
  secretary: handleSecretary,
  triathlon: handleTriathlon,
  content: handleContent,
  finance: handleFinance,
  cooking: handleCooking,
};

// ─── Bot Factory ────────────────────────────────────────────────────

export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  // ── Tracing Middleware (Quarter: distributed tracing) ──
  // FIRST in the chain — every other middleware (auth, rate limit,
  // telemetry, command handlers) runs inside this AsyncLocalStorage
  // store, so all log lines emitted during the message lifecycle
  // automatically pick up `reqId`, `src`, and `userId` via the pino
  // mixin in src/utils/logger.ts.
  //
  // Each Telegram update gets a fresh requestId; we don't honor any
  // upstream ID (Telegram doesn't propagate one). The userId comes
  // straight from ctx.from.id when present.
  bot.use(async (ctx, next) => {
    const requestId = generateRequestId();
    return runWithContext(
      { requestId, source: 'telegram', userId: ctx.from?.id },
      () => next(),
    );
  });

  // ── Auth Middleware (DB-backed with legacy whitelist fallback) ──
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Allow /start through for unregistered users (registration flow)
    const text = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') ?? '';
    if (text.startsWith('/start')) {
      await next();
      return;
    }

    // Check DB-registered user
    let authorized = false;
    try {
      const { getUserByTelegramId, touchUser: touch } = require('./services/user-service');
      const { t } = require('./utils/i18n');
      const user = getUserByTelegramId(userId);

      if (user) {
        if (user.status !== 'active') {
          await ctx.reply(t('suspended', user.language));
          return;
        }
        authorized = true;
        touch(userId);
      }
    } catch {
      // user-service not loaded yet (startup race) — fall through to legacy
    }

    // Legacy fallback: TELEGRAM_ALLOWED_USER_IDS still works
    if (!authorized && config.telegram.allowedUserIds.includes(userId)) {
      authorized = true;
    }

    if (!authorized) {
      const { t, detectLanguageFromTelegram } = require('./utils/i18n');
      const lang = detectLanguageFromTelegram(ctx.from?.language_code);
      await ctx.reply(t('need_invite', lang));
      return;
    }

    await next();
  });

  // ── Rate Limit Middleware ──
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && isRateLimited(userId)) {
      await ctx.reply('⚠️ Slow down! Max 30 messages per minute.');
      return;
    }
    await next();
  });

  // ── Telemetry Middleware ──
  bot.use(async (ctx, next) => {
    recordMessageProcessed();
    await next();
  });

  // ── Garmin MFA notifier (owner-only — Garmin credentials are admin-level) ──
  setMfaNotifier(async (message: string) => {
    const { getOwnerUserIds } = require('./services/scheduler');
    for (const userId of getOwnerUserIds()) {
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId }, 'Failed to send Garmin MFA notification');
      }
    }
  });

  // ── Register command handler modules (order matters for Grammy) ──
  registerSystemCommands(bot);
  registerSkillCommands(bot);
  registerSecretaryCommands(bot, DOMAIN_HANDLERS);
  registerContentCommands(bot);
  registerFinanceCommands(bot);
  registerTriathlonCommands(bot);

  // ── Callback query handlers ──
  registerCallbackQueries(bot);

  // ── Media handlers (photo, voice, video, document, sticker) ──
  registerMediaHandlers(bot, DOMAIN_HANDLERS);

  // ── Natural language catch-all (MUST be registered last) ──
  registerTextHandler(bot, DOMAIN_HANDLERS);

  // ── Error Handler ──
  bot.catch((err) => {
    const ctx = err.ctx;
    logger.error({ err: err.error }, 'Bot error');

    if (err.error instanceof GrammyError) {
      logger.error({ code: err.error.error_code }, 'Telegram API error');
    } else if (err.error instanceof HttpError) {
      logger.error('Network error');
    }

    ctx.reply('⚠️ Something went wrong. Please try again.').catch(() => {});
  });

  // ── Pre-load Outlook master categories (for calendar event colors) ──
  if (isAnyCalendarConfigured()) {
    getMasterCategories().catch((err) => logger.warn({ err }, 'Failed to pre-load master categories'));
  }

  return bot;
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Natural language text handler — extracted from bot.ts Phase 5.
 *
 * Catches all text messages that didn't match a command:
 * 1. Check for pending 2FA replies (Amazon/Uber scraper)
 * 2. Check for pending inline edits (ToDo field edits)
 * 3. Check for pending onboarding text input
 * 4. Route to domain handler (classify → domain → tool loop → response)
 */

import { Bot, Context } from 'grammy';
import * as onboarding from '../services/onboarding';
import { escapeHtml } from '../utils/telegram-formatter';
import {
  pendingEdits, pendingOnboarding, enqueue,
} from './shared-state';
import { handlePendingEdit } from './commands/secretary-helpers';
import { sendOnboardingStep } from './onboarding';
import { handleDomainMessage } from './message';
import {
  resolveReply as resolveAmazonReply,
} from '../services/amazon-collector';
import {
  resolveReply as resolveUberReply,
} from '../services/uber-collector';
import type { DomainHandlerFn } from './photo';

/**
 * Register the catch-all text message handler on the bot.
 * MUST be registered LAST — after all command handlers.
 *
 * @param bot - The Grammy bot instance
 * @param domainHandlers - The DOMAIN_HANDLERS map (injected for domain routing)
 */
export function registerTextHandler(
  bot: Bot,
  domainHandlers: Record<string, DomainHandlerFn>,
): void {
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (!text) return;

    // Check for pending scraper 2FA reply (OTP code or CAPTCHA answer)
    if (resolveAmazonReply(ctx.chat.id, text)) return;
    if (resolveUberReply(ctx.chat.id, text)) return;

    // Check for pending inline edit (td:ef flow)
    const userId = ctx.from.id;
    const pending = pendingEdits.get(userId);
    if (pending && Date.now() < pending.expires) {
      pendingEdits.delete(userId);
      enqueue(userId, async () => {
        await handlePendingEdit(ctx, pending, text);
      });
      return;
    }
    pendingEdits.delete(userId); // clean up expired

    // Check for pending onboarding text input
    const pendingOb = pendingOnboarding.get(userId);
    if (pendingOb && Date.now() < pendingOb.expires) {
      pendingOnboarding.delete(userId);
      enqueue(userId, async () => {
        try {
          const result = onboarding.answerStep(userId, pendingOb.questionnaire, text);
          if (!result.nextStep) {
            const profile = onboarding.getProfile(userId, pendingOb.questionnaire);
            const entries = profile ? Object.entries(profile.data).map(([k, v]) =>
              `  <code>${k}</code>: ${escapeHtml(String(v))}`
            ).join('\n') : '';
            await ctx.reply(
              `✅ <b>Profile Complete!</b>\n\n${entries}\n\nYour ${pendingOb.questionnaire} profile is saved.`,
              { parse_mode: 'HTML' },
            );
          } else {
            await ctx.reply('✅ Got it!');
            const def = onboarding.getQuestionnaire(pendingOb.questionnaire)!;
            await sendOnboardingStep(ctx, pendingOb.questionnaire, result.nextStep, result.session.current_step, def.steps.length);
          }
        } catch (err: any) {
          await ctx.reply(`⚠️ ${escapeHtml(err.message)}. Please try again.`);
          // Re-set pending so user can retry
          pendingOnboarding.set(userId, pendingOb);
        }
      });
      return;
    }
    pendingOnboarding.delete(userId);

    enqueue(userId, async () => {
      await handleDomainMessage(ctx, text, domainHandlers);
    });
  });
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Domain message router — extracted from bot.ts Phase 2.
 *
 * Routes non-command text messages through classify → domain → tool loop → response.
 */

import { Context } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getCallback } from '../utils/callback-store';
import { routeMessage, isSystemCommand } from '../router';
import { DomainName } from '../domains/types';
import { getLastAssistantMessage } from '../state/conversation';
import { createEvent as createCalendarEvent } from '../services/unified-calendar';
import { splitMessage, escapeHtml } from '../utils/telegram-formatter';
import {
  lastActiveDomain, pendingCalendarRef, CONTINUITY_WINDOW_MS, isHtmlParseError,
} from './shared-state';
import type { DomainHandlerFn } from './photo';

/**
 * The core natural language handler — routes non-command messages through
 * classify → domain handler → tool loop → response.
 *
 * @param domainHandlers - The DOMAIN_HANDLERS map from bot.ts (injected to avoid circular deps)
 */
export async function handleDomainMessage(
  ctx: Context,
  text: string,
  domainHandlers: Record<string, DomainHandlerFn>,
): Promise<void> {
  const systemCmd = isSystemCommand(text);
  if (systemCmd) return; // Already handled by command handlers

  try {
    await ctx.replyWithChatAction('typing');

    const userId = ctx.from?.id;

    // ── Calendar follow-up detection ──
    if (userId) {
      const pending = pendingCalendarRef.get(userId);
      if (pending && Date.now() - pending.timestamp < 10 * 60 * 1000) {
        const lower = text.toLowerCase();
        const isCalendarFollowUp = /\b(cri[ae]|create|adjust|add|confirm|yes|sim|manda|vai|go ahead)\b/.test(lower)
          && /\b(event|evento|calendar|calend[aá]rio|outlook|agenda)\b/.test(lower);
        if (isCalendarFollowUp) {
          const cbData = getCallback(pending.ref);
          if (cbData) {
            pendingCalendarRef.delete(userId);
            await ctx.reply('⏳ Criando eventos no calendário...');
            const events = cbData.events as { title: string; start: string; end: string; description?: string }[];
            const categories = cbData.categories as string[];
            let successCount = 0;
            const createdTitles: string[] = [];
            for (const event of events) {
              try {
                const created = await createCalendarEvent({
                  title: event.title, start: event.start, end: event.end,
                  description: event.description, categories,
                });
                successCount++;
                createdTitles.push(created.summary);
              } catch (err) {
                logger.error({ err, eventTitle: event.title }, 'Failed to create calendar event from text follow-up');
              }
            }
            if (successCount === 0) {
              await ctx.reply('⚠️ Falha ao criar os eventos. Tente novamente.');
              return;
            }
            let msg = `📅✅ <b>${successCount} evento${successCount > 1 ? 's' : ''} criado${successCount > 1 ? 's' : ''}:</b>\n`;
            for (const title of createdTitles) msg += `\n  📌 ${escapeHtml(title)}`;
            msg += `\n\n🏷️ ${escapeHtml(categories[0])}`;
            try {
              await ctx.reply(msg, { parse_mode: 'HTML' });
            } catch (err) {
              if (isHtmlParseError(err)) await ctx.reply(msg.replace(/<[^>]*>/g, ''));
              else throw err;
            }
            return;
          }
        }
      }
    }

    // ── Build active conversation context for the classifier ──
    let activeContext: { domain: DomainName; lastAssistantMessage: string } | null = null;
    if (userId && !text.startsWith('/')) {
      const lastState = lastActiveDomain.get(userId);
      if (lastState && Date.now() - lastState.timestamp < CONTINUITY_WINDOW_MS) {
        const lastMsg = getLastAssistantMessage(userId, lastState.domain);
        if (lastMsg) {
          activeContext = { domain: lastState.domain, lastAssistantMessage: lastMsg };
        }
      }
    }

    // Pre-flight quota check — block before making any AI call
    if (userId) {
      try {
        const { isOwner } = require('../services/user-service');
        if (!isOwner(userId)) {
          const { checkQuota } = require('../services/usage-metering');
          const quotaCheck = checkQuota(userId);
          if (!quotaCheck.allowed) {
            const reasons = quotaCheck.exceeded.map((r: string) => {
              if (r === 'messages') return `📨 Message limit: ${quotaCheck.quota?.dailyMessageLimit}/day`;
              if (r === 'tokens') return '🔤 Token limit reached';
              if (r === 'cost') return '💰 Cost limit reached';
              return r;
            }).join('\n');
            await ctx.reply(
              `⚠️ You've reached your daily limit:\n\n${reasons}\n\n` +
              `Your limits reset at midnight (${config.app.timezone}).`,
            );
            return;
          }
        }
      } catch { /* quota check not available — allow */ }
    }

    // Global cost guardrail — block ALL users (including owner) when daily spend exceeded
    try {
      const { checkGlobalCostGuardrail } = require('../services/cost-guardrail');
      const costCheck = checkGlobalCostGuardrail();
      if (costCheck.exceeded) {
        const { getUserLanguage } = require('../services/user-service');
        const { t } = require('../utils/i18n');
        const lang = userId ? getUserLanguage(userId) : 'en-US';
        await ctx.reply(t('cost_limit_reached', lang));
        logger.error({ total: costCheck.totalUsd, limit: costCheck.limitUsd }, 'Global cost limit exceeded — AI call blocked');
        return;
      }
    } catch { /* cost guardrail not available — allow */ }

    const route = await routeMessage(text, activeContext);
    logger.info({ domain: route.domain, method: route.method, confidence: route.confidence }, 'Message routed');

    // Track last active domain for photo routing and conversation continuity
    if (userId) lastActiveDomain.set(userId, { domain: route.domain, timestamp: Date.now() });

    // Check if the user has access to this skill (two layers).
    //
    // Layer 1 — explicit enable/disable (migration 032, `user_skill_overrides`):
    //   admin-controlled boolean gate. When false, the admin has explicitly
    //   turned off this skill for this user regardless of tier.
    //
    // Layer 2 — tier gate (migration 045, `skill_tiers` via skill-tiers.ts):
    //   Phase 1 Slice C. Checks user.tier against the catalog + config
    //   fallback. Blocks when the user's tier is below the skill's
    //   required tier AND no per-user override grants access.
    //
    // Both layers must pass — Layer 1 fires first so an explicit admin
    // disable overrides the tier check (useful for muting a pro user
    // from a pro skill without downgrading their whole tier).
    try {
      const { isSkillEnabled } = require('../services/user-skill-access');
      if (userId && !isSkillEnabled(userId, route.domain)) {
        const { getUserLanguage } = require('../services/user-service');
        const { t } = require('../utils/i18n');
        await ctx.reply(t('skill_disabled', getUserLanguage(userId)), { parse_mode: 'HTML' });
        return;
      }
    } catch { /* skill access not loaded — allow */ }

    try {
      if (userId) {
        const { getUserByTelegramId, getUserLanguage } = require('../services/user-service');
        const { checkTierAccess } = require('../services/skill-tiers');
        const { t } = require('../utils/i18n');
        const user = getUserByTelegramId(userId);
        if (user) {
          // Gate against the parent skill. Sub-skill-level gating happens
          // deeper (tool filtering), so the chat entrypoint only needs to
          // check whether the user can reach this domain at all.
          const result = checkTierAccess({ id: user.id, tier: user.tier }, route.domain);
          if (!result.allowed) {
            await ctx.reply(
              t('skill_tier_required', getUserLanguage(userId), {
                tier: result.requiredTier,
                current: result.userTier,
              }),
              { parse_mode: 'HTML' },
            );
            logger.info(
              { userId, domain: route.domain, userTier: result.userTier, requiredTier: result.requiredTier, reason: result.reason },
              'tier gate blocked message',
            );
            return;
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'tier gate check failed — falling through (fail-open)');
    }

    const handler = domainHandlers[route.domain];
    const response = await handler(route.strippedMessage, ctx.from?.id);

    const parts = splitMessage(response.text);
    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'HTML' });
      } catch (err) {
        if (isHtmlParseError(err)) await ctx.reply(part.replace(/<[^>]*>/g, ''));
        else throw err;
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to handle domain message');
    await ctx.reply('⚠️ Something went wrong processing your message. Please try again.');
  }
}

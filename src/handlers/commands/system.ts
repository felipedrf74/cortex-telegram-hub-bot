// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * System command handlers — extracted from bot.ts.
 *
 * Registers: /start, lang: callback, /connect, /connections,
 * /version, /help, /clear, /onboard, ob: callback, /profile
 */

import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../../config';
import { storeCallback, getCallback } from '../../utils/callback-store';
import { DomainName } from '../../domains/types';
import * as onboarding from '../../services/onboarding';
import { clearConversation, clearAllConversations } from '../../state/conversation';
import { escapeHtml } from '../../utils/telegram-formatter';
import { enqueue, pendingOnboarding } from '../shared-state';
import { HELP_TEXT } from '../help-text';
import { sendOnboardingStep } from '../onboarding';
import fs from 'fs';
import path from 'path';

export function registerSystemCommands(bot: Bot): void {
  // ── /start ──
  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const { getUserByTelegramId, getOrCreateUser, validateAndConsumeInviteCode } = require('../../services/user-service');
    const { t, detectLanguageFromTelegram } = require('../../utils/i18n');

    const existing = getUserByTelegramId(userId);
    if (existing) {
      await ctx.reply(t('welcome_back', existing.language), { parse_mode: 'HTML' });
      return;
    }

    // Extract invite code from /start INVITE_CODE (deep link)
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    const inviteCode = args[0];
    const registrationOpen = process.env.REGISTRATION_OPEN === 'true';

    // Check if registration is allowed
    if (!registrationOpen && !inviteCode) {
      // Also allow if they're in the legacy whitelist
      if (!config.telegram.allowedUserIds.includes(userId)) {
        const lang = detectLanguageFromTelegram(ctx.from?.language_code);
        await ctx.reply(t('need_invite', lang));
        return;
      }
    }

    // Validate invite code if provided
    if (inviteCode && !validateAndConsumeInviteCode(inviteCode)) {
      const lang = detectLanguageFromTelegram(ctx.from?.language_code);
      await ctx.reply(t('invalid_invite', lang));
      return;
    }

    // Create the user
    getOrCreateUser(userId, {
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
      inviteCode,
    });

    // Language selection
    await ctx.reply(t('choose_language', 'en-US'), {
      reply_markup: {
        inline_keyboard: [[
          { text: '\u{1F1E7}\u{1F1F7} Portugu\u00EAs', callback_data: 'lang:pt-BR' },
          { text: '\u{1F1EC}\u{1F1E7} English', callback_data: 'lang:en-US' },
        ]],
      },
    });
  });

  // Handle language selection callback from registration
  bot.callbackQuery(/^lang:/, async (ctx) => {
    const { setUserLanguage } = require('../../services/user-service');
    const { t } = require('../../utils/i18n');
    const lang = ctx.callbackQuery.data?.replace('lang:', '') as 'pt-BR' | 'en-US';
    if (!lang || !['pt-BR', 'en-US'].includes(lang)) return;

    setUserLanguage(ctx.from.id, lang);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t('language_set', lang), { parse_mode: 'HTML' });
  });

  // ── /connect — OAuth account linking ──
  bot.command('connect', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const { getUserLanguage } = require('../../services/user-service');
    const { t } = require('../../utils/i18n');
    const { getOAuthUrl } = require('../../services/oauth-flow');

    const provider = ctx.message?.text?.split(' ')[1]?.toLowerCase();
    const lang = getUserLanguage(userId);

    if (!provider || !['google', 'outlook'].includes(provider)) {
      await ctx.reply(t('connect_help', lang), { parse_mode: 'HTML' });
      return;
    }

    try {
      const url = getOAuthUrl(provider, userId);
      await ctx.reply(t('connect_prompt', lang, { provider: provider.charAt(0).toUpperCase() + provider.slice(1) }), {
        reply_markup: {
          inline_keyboard: [[{ text: `\u{1F517} Connect ${provider.charAt(0).toUpperCase() + provider.slice(1)}`, url }]],
        },
      });
    } catch (err: any) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  // ── /connections — list connected accounts ──
  bot.command('connections', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const { getUserLanguage } = require('../../services/user-service');
    const { t } = require('../../utils/i18n');
    const { getUserConnections } = require('../../services/oauth-store');

    const lang = getUserLanguage(userId);
    const connections = getUserConnections(userId);

    if (connections.length === 0) {
      await ctx.reply(t('connections_none', lang), { parse_mode: 'HTML' });
      return;
    }

    const providerIcons: Record<string, string> = { google: '\u{1F7E2}', outlook: '\u{1F535}' };
    let msg = t('connections_header', lang);
    for (const c of connections) {
      const icon = providerIcons[c.provider] || '\u{1F4E1}';
      msg += `\n${icon} <b>${c.provider.charAt(0).toUpperCase() + c.provider.slice(1)}</b> \u2014 connected ${c.connectedAt?.split('T')[0] ?? 'unknown'}`;
      if (c.scopes.length > 0) {
        msg += `\n   <i>${c.scopes.length} scopes</i>`;
      }
    }
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  bot.command('version', async (ctx) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
    const commitHash = process.env.GIT_COMMIT || 'dev';
    const nodeVersion = process.version;
    const uptime = process.uptime();
    const uptimeStr = `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
    await ctx.reply(
      `<b>Nexus Hub</b> v${pkg.version}\n` +
      `Commit: <code>${commitHash}</code>\n` +
      `Node: ${nodeVersion}\n` +
      `Uptime: ${uptimeStr}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.command('clear', async (ctx) => {
    const domain = ctx.match?.trim();
    if (domain && ['secretary', 'triathlon', 'content'].includes(domain)) {
      clearConversation(ctx.from?.id ?? 0, domain as DomainName);
      await ctx.reply(`\u{1F5D1} Cleared conversation history for <b>${domain}</b>.`, { parse_mode: 'HTML' });
    } else if (domain === 'all') {
      clearAllConversations(ctx.from?.id ?? 0);
      await ctx.reply('\u{1F5D1} Cleared all conversation histories.', { parse_mode: 'HTML' });
    } else {
      await ctx.reply('Usage: /clear [secretary|triathlon|content|all]');
    }
  });

  // ── Onboarding Command ──
  bot.command('onboard', async (ctx) => {
    const args = (ctx.message?.text || '').replace(/^\/onboard\s*/i, '').trim();
    const userId = ctx.from?.id;
    if (!userId) return;

    const available = onboarding.getAvailableQuestionnaires();

    if (!args) {
      // Show available questionnaires
      const keyboard = new InlineKeyboard();
      for (const qId of available) {
        const def = onboarding.getQuestionnaire(qId)!;
        const ref = storeCallback({ action: 'start', questionnaire: qId }, 300_000);
        keyboard.text(`${def.title}`, `ob:start:${ref}`).row();
      }
      await ctx.reply(
        '\u{1F4CB} <b>Onboarding Questionnaires</b>\n\nChoose a profile to set up:',
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
      return;
    }

    // Start a specific questionnaire
    const qId = args.toLowerCase();
    if (!available.includes(qId)) {
      await ctx.reply(`Unknown questionnaire: ${escapeHtml(qId)}. Available: ${available.join(', ')}`);
      return;
    }

    const session = onboarding.startOrResume(userId, qId);
    const def = onboarding.getQuestionnaire(qId)!;
    const step = def.steps[session.current_step];
    if (!step) return;

    await sendOnboardingStep(ctx, qId, step, session.current_step, def.steps.length);
  });

  bot.command('profile', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const profiles = onboarding.getAllProfiles(userId);
    if (profiles.length === 0) {
      await ctx.reply('No profiles set up yet. Use /onboard to get started.');
      return;
    }

    const lines = profiles.map(p => {
      const data = p.data;
      const entries = Object.entries(data).map(([k, v]) => `  <code>${k}</code>: ${escapeHtml(String(v))}`);
      return `<b>${escapeHtml(p.profile_type)}</b>\n${entries.join('\n')}`;
    });
    await ctx.reply(`\u{1F4CB} <b>Your Profiles</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
  });

  // Onboarding questionnaire callbacks
  bot.callbackQuery(/^ob:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];
    const userId = ctx.from?.id;
    if (!userId) return;

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    const cbData = getCallback(ref);
    if (!cbData) {
      await ctx.editMessageText('\u26A0\uFE0F This action has expired. Use /onboard to start again.');
      return;
    }

    switch (action) {
      case 'start': {
        const qId = cbData.questionnaire;
        const session = onboarding.startOrResume(userId, qId);
        const def = onboarding.getQuestionnaire(qId)!;
        const step = def.steps[session.current_step];
        if (!step) return;

        await ctx.editMessageText(
          `${def.title}\n\n${def.description}\n\nLet's begin! (${def.steps.length} questions)`,
          { parse_mode: 'HTML' },
        );
        await sendOnboardingStep(ctx, qId, step, session.current_step, def.steps.length);
        break;
      }
      case 'answer': {
        const { questionnaire: qId, answer } = cbData;
        try {
          const result = onboarding.answerStep(userId, qId, answer);
          if (!result.nextStep) {
            // Questionnaire complete
            const profile = onboarding.getProfile(userId, qId);
            const entries = profile ? Object.entries(profile.data).map(([k, v]) =>
              `  <code>${k}</code>: ${escapeHtml(String(v))}`
            ).join('\n') : '';
            await ctx.editMessageText(
              `\u2705 <b>Profile Complete!</b>\n\n${entries}\n\nYour ${qId} profile is saved. The AI will use this for personalized responses.`,
              { parse_mode: 'HTML' },
            );
          } else {
            await ctx.editMessageText(`\u2705 Got it!`);
            await sendOnboardingStep(ctx, qId, result.nextStep, result.session.current_step, onboarding.getQuestionnaire(qId)!.steps.length);
          }
        } catch (err: any) {
          await ctx.editMessageText(`\u26A0\uFE0F ${escapeHtml(err.message)}`);
        }
        break;
      }
      case 'cancel': {
        const qId = cbData.questionnaire;
        onboarding.abandonSession(userId, qId);
        await ctx.editMessageText('\u274C Onboarding cancelled. Use /onboard to start again.');
        break;
      }
    }
  });
}

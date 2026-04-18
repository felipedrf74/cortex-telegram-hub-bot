// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content command handlers — extracted from bot.ts.
 *
 * Registers: /discover, /ideas, /deepsearch, /sources, /hotnews, /trending,
 * /reaction, /hooks, /genscript, /titles, /genthumbnail, /gencaption,
 * /competitor, /gaps, /seo, /feedback, /report,
 * /learnfrom, /references, /relearn, /contenttopic, /contentretro,
 * /addbook, /booknote, /books, /bookidea,
 * /seokeyword, /seorank,
 * /pipeline, /filmed, /editing, /published,
 * /autoresearch, /evalscore,
 * /transcribe, /studyvideo, /script, /reel, /buildscript, /calendar, /brandcheck, /repurpose,
 * ci: callback, cw: callback
 */

import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { config } from '../../config';
import { getDb } from '../../services/database';
import { logger } from '../../utils/logger';
import { storeCallback, getCallback } from '../../utils/callback-store';
import { runContentDiscovery } from '../../services/content-discovery';
import { saveIdea, getSavedIdeas } from '../../state/saved-ideas';
import {
  addAndAnalyzeChannel,
  processAllChannelScopes,
} from '../../services/channel-learner';
import {
  getAllChannels,
  buildKnowledgePromptBlock,
} from '../../state/content-references';
import { studyVideo, getTranscript, saveTranscriptAsDocx, saveStudyAsDocx, saveScriptAsDocx } from '../../services/video-study';
import {
  deepSearch, getSources, getHotNews, isContentEngineConfigured,
  getTrending, getReaction, getHooks, getScript, getTitles,
  getThumbnail, getCaption, getCompetitor, getGaps, getSeo,
  logFeedback, getReport,
  saveContentAsDocx,
} from '../../services/content-engine';
// Telegram-specific formatters — live in the transport adapter, not the engine
import {
  formatDeepSearch, formatSources, formatHotNews,
  formatTrending, formatReaction, formatHooks, formatScript, formatTitles,
  formatThumbnail, formatCaption, formatCompetitor, formatGaps, formatSeo,
  formatFeedback, formatReport,
} from '../../services/content-telegram-formatter';
import {
  sendTopicCandidates, sendWeeklyPackage,
  updateFeedback, markScriptGenerated, getTopicById,
  generateReelScript, generateYouTubeScript,
} from '../../services/content-workflow';
import { handleContent } from '../../domains/content-creator';
import { handlePipelineStatus, handleFilmedStage, handleEditingStage, handlePublishedStage } from '../../commands/pipeline';
import { handleAddBook, handleBookNote, handleListBooks, handleBookIdea } from '../../commands/books';
import { handleAddSEOKeyword, handleSEORank } from '../../agents/seo-agent';
import { handleAutoresearch, handleEvalScore } from '../../commands/autoresearch';
import { splitMessage, escapeHtml } from '../../utils/telegram-formatter';
import { now } from '../../utils/date-parser';
import { enqueue, isHtmlParseError } from '../shared-state';
import { resolveCanonicalUserId } from '../../services/user-service';
import fs from 'fs';
import path from 'path';

// ─── Content Engine: send inline OR save to file ─────────────────────

/**
 * If the formatted message is too long, save full output to ~/Desktop/IDEAS
 * and send a short summary + file path in Telegram. Otherwise send inline.
 *
 * @param forceFile - commands like genscript/competitor always save a file
 */
async function sendOrSave(
  ctx: Context,
  msg: string,
  command: string,
  topic: string,
  forceFile = false,
): Promise<void> {
  // Always try to save as DOCX and send as downloadable file
  const result = await saveContentAsDocx(msg, command, topic, forceFile);
  if (result) {
    // Send a clean short summary + the file + Drive link
    const plain = msg.replace(/<[^>]*>/g, '');
    const firstLine = plain.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 120) || topic;
    const driveLink = result.driveUrl ? `\n\n\u{1F4C2} <a href="${escapeHtml(result.driveUrl)}">Open in Google Drive</a>` : '';
    const caption = `\u{1F4C4} <b>${escapeHtml(command.toUpperCase())}</b> \u2014 ${escapeHtml(topic)}\n\n${escapeHtml(firstLine)}${firstLine.length >= 120 ? '...' : ''}${driveLink}`;

    try {
      await ctx.replyWithDocument(new InputFile(result.filePath), {
        caption,
        parse_mode: 'HTML',
      });
    } catch (err) {
      // Fallback: send file path if document upload fails
      logger.error({ err }, `Failed to send ${command} DOCX via Telegram`);
      await ctx.reply(`\u{1F4C1} Saved to: <code>${escapeHtml(result.filePath)}</code>`, { parse_mode: 'HTML' });
    }
  } else {
    // Short enough — send inline
    for (const chunk of splitMessage(msg)) {
      try { await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); }
      catch (err) { if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, '')); else throw err; }
    }
  }
}

// ─── Shared Command Handlers ────────────────────────────────────────

/**
 * Unified script handler — used by both /script and /genscript (alias).
 * Always includes research + intelligence bus signal injection.
 */
async function handleScriptCommand(ctx: Context): Promise<void> {
  if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
  const topic = ctx.match?.toString().trim();
  if (!topic) {
    await ctx.reply(
      '\u{1F4DD} <b>Usage:</b> <code>/script &lt;topic&gt;</code>\n\n' +
      'Generates a full video script with research + intelligence.\n\n' +
      'Examples:\n' +
      '  <code>/script dieta carn\u00EDvora 30 dias resultados</code>\n' +
      '  <code>/script por que o estado \u00E9 seu inimigo</code>\n' +
      '  <code>/script reaction to trending topic about AI</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }
  await ctx.reply('\u{1F4DD} Generating script\u2026 this takes 30-60s (research + writing).', { parse_mode: 'HTML' });
  const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
  try {
    const result = await getScript(topic);
    clearInterval(typingInterval);
    const msg = formatScript(result);
    await sendOrSave(ctx, msg, 'script', topic, true);
  } catch (err: any) {
    clearInterval(typingInterval);
    logger.error({ err }, 'Script generation failed');
    await ctx.reply(`\u274C Script failed: ${escapeHtml(err.message || 'Unknown error')}`);
  }
}

/**
 * Unified discover handler — used by /discover, /hotnews (alias), /trending (alias).
 * Flags: --news (hotnews only), --platform (cross-platform trending), default (full discovery).
 */
async function handleDiscoverCommand(ctx: Context, mode: 'full' | 'news' | 'platform' = 'full'): Promise<void> {
  if (mode === 'news') {
    // /hotnews behavior
    if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
    await ctx.replyWithChatAction('typing');
    const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
    try {
      const result = await getHotNews();
      clearInterval(typingInterval);
      const msg = formatHotNews(result);
      await sendOrSave(ctx, msg, 'discover', 'trending-news', true);
    } catch (err: any) {
      clearInterval(typingInterval);
      logger.error({ err }, 'Hot news failed');
      await ctx.reply(`\u274C Discover (news) failed: ${escapeHtml(err.message || 'Unknown error')}`);
    }
  } else if (mode === 'platform') {
    // /trending behavior
    if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
    const niche = ctx.match?.toString().replace(/--platform\s*/i, '').trim() || undefined;
    await ctx.replyWithChatAction('typing');
    const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
    try {
      const result = await getTrending(niche);
      clearInterval(typingInterval);
      const msg = formatTrending(result);
      await sendOrSave(ctx, msg, 'discover', niche || 'general', true);
    } catch (err: any) {
      clearInterval(typingInterval);
      logger.error({ err }, 'Trending failed');
      await ctx.reply(`\u274C Discover (platform) failed: ${escapeHtml(err.message || 'Unknown error')}`);
    }
  } else {
    // Full discovery (original /discover behavior)
    await ctx.replyWithChatAction('typing');
    await ctx.reply('\u{1F50D} Running content discovery\u2026 this takes ~2 minutes.', { parse_mode: 'HTML' });
    const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
    try {
      const result = await runContentDiscovery();
      clearInterval(typingInterval);
      const dateStr = now().toFormat('yyyy-MM-dd');
      let msg = `\u{1F3AC} <b>Content Ideas Ready</b>\n\n`;
      if (result.ideas.length > 0) {
        for (let i = 0; i < result.ideas.length; i++) {
          msg += `${i + 1}. ${escapeHtml(result.ideas[i])}\n`;
        }
      } else {
        msg += `Ideas generated but couldn't parse titles \u2014 check the file.\n`;
      }
      msg += `\n\u{1F4C1} <code>${escapeHtml(result.filePath)}</code>`;
      msg += `\n\u{1F50D} ${result.searchCount} web searches used`;
      for (const chunk of splitMessage(msg)) {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      }
      if (result.ideas.length > 0) {
        const keyboard = new InlineKeyboard();
        for (let i = 0; i < Math.min(result.ideas.length, 10); i++) {
          const ref = storeCallback({ title: result.ideas[i], date: dateStr });
          keyboard.text(`\u{1F4BE} ${i + 1}`, `ci:save:${ref}`);
          if ((i + 1) % 5 === 0) keyboard.row();
        }
        await ctx.reply('Tap to save ideas you want to pursue:', { reply_markup: keyboard });
      }
    } catch (err: any) {
      clearInterval(typingInterval);
      logger.error({ err }, 'Content discovery failed');
      await ctx.reply(`\u274C Content discovery failed: ${escapeHtml(err.message || 'Unknown error')}`);
    }
  }
}

export function registerContentCommands(bot: Bot): void {
  // ── Content Discovery (unified: /discover, /discover --news, /discover --platform) ──
  bot.command('discover', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const input = ctx.match?.toString().trim() || '';
      if (input.startsWith('--news')) {
        await handleDiscoverCommand(ctx, 'news');
      } else if (input.startsWith('--platform')) {
        await handleDiscoverCommand(ctx, 'platform');
      } else {
        await handleDiscoverCommand(ctx, 'full');
      }
    });
  });

  bot.command('ideas', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const dateArg = ctx.match?.trim();

      // /ideas saved — show saved content ideas
      if (dateArg === 'saved') {
        const saved = getSavedIdeas();
        if (saved.length === 0) {
          await ctx.reply('\u{1F4ED} No saved ideas. Use /discover and tap \u{1F4BE} to save ideas.');
          return;
        }
        let msg = `\u{1F4BE} <b>Saved Ideas</b> (${saved.length})\n\n`;
        for (const idea of saved) {
          msg += `\u2022 ${escapeHtml(idea.title)} <i>(${idea.source_date})</i>\n`;
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      const dateStr = dateArg || now().toFormat('yyyy-MM-dd');

      const dir = path.resolve(config.app.databasePath, '../content-ideas');
      const filePath = path.join(dir, `${dateStr}.md`);

      if (!fs.existsSync(filePath)) {
        const available: string[] = [];
        if (fs.existsSync(dir)) {
          available.push(
            ...fs.readdirSync(dir)
              .filter((f) => f.endsWith('.md'))
              .map((f) => f.replace('.md', ''))
              .sort()
              .slice(-5)
          );
        }
        let msg = `\u{1F4ED} No content ideas found for <b>${escapeHtml(dateStr)}</b>.`;
        if (available.length > 0) {
          msg += `\n\nAvailable dates:\n${available.map((d) => `\u2022 /ideas ${d}`).join('\n')}`;
        } else {
          msg += '\n\nRun /discover to generate ideas first.';
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      for (const chunk of splitMessage(content)) {
        try {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        } catch (err) {
          if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
          else throw err;
        }
      }
    });
  });

  // ── Content Engine Commands (Python microservice) ──

  bot.command('deepsearch', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) {
        await ctx.reply('\u26A0\uFE0F Content Engine not enabled. Set CONTENT_ENGINE_ENABLED=true and start the Python service.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /deepsearch <topic>\nExample: /deepsearch Lula economia rea\u00E7\u00E3o');
        return;
      }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await deepSearch(query);
        clearInterval(typingInterval);
        const msg = formatDeepSearch(result);
        await sendOrSave(ctx, msg, 'deepsearch', query);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Deep search failed');
        await ctx.reply(`\u274C Deep search failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('sources', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) {
        await ctx.reply('\u26A0\uFE0F Content Engine not enabled.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /sources <topic>\nExample: /sources fitness trends 2026');
        return;
      }
      await ctx.replyWithChatAction('typing');
      try {
        const result = await getSources(query);
        const msg = formatSources(result);
        await sendOrSave(ctx, msg, 'sources', query, true);
      } catch (err: any) {
        logger.error({ err }, 'Sources fetch failed');
        await ctx.reply(`\u274C Sources failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // /hotnews -> alias for /discover --news
  bot.command('hotnews', async (ctx) => {
    logger.info('Deprecated /hotnews used \u2014 forwarding to /discover --news');
    enqueue(ctx.from!.id, async () => { await handleDiscoverCommand(ctx, 'news'); });
  });

  // /trending -> alias for /discover --platform
  bot.command('trending', async (ctx) => {
    logger.info('Deprecated /trending used \u2014 forwarding to /discover --platform');
    enqueue(ctx.from!.id, async () => { await handleDiscoverCommand(ctx, 'platform'); });
  });

  bot.command('reaction', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const topic = ctx.match?.trim();
      if (!topic) { await ctx.reply('Usage: /reaction <topic>\nExample: /reaction Lula cortou verbas'); return; }

      // Check Reaction Radar signals first
      const { readSignals } = await import('../../services/intelligence-bus');
      const radarSignals = readSignals('reaction-command', ['reaction_opportunity']);
      const topicLower = topic.toLowerCase();
      const matching = radarSignals.filter((s: any) => {
        const p = s.payload as any;
        const text = `${p.title || ''} ${p.topic || ''} ${p.description || ''}`.toLowerCase();
        return topicLower.split(/\s+/).some((w: string) => w.length > 3 && text.includes(w));
      });

      if (matching.length > 0) {
        let radarMsg = `\u{1F50D} <b>Reaction Radar found ${matching.length} match${matching.length > 1 ? 'es' : ''}:</b>\n\n`;
        for (const sig of matching.slice(0, 3)) {
          const p = sig.payload as any;
          radarMsg += `\u{1F4FA} <b>${escapeHtml(p.title || p.topic || '')}</b>\n`;
          if (p.scores) {
            const s = p.scores;
            radarMsg += `   \u{1F3AF} Audience: ${s.audience_trigger}/10 \u00B7 \u{1F525} Controversy: ${s.controversy}/10 \u00B7 \u23F0 Timely: ${s.timeliness}/10\n`;
            radarMsg += `   \u{1F4F9} Visual: ${s.visual_reactability}/10 \u00B7 \u{1F3F7} Pillars: ${s.pillar_alignment}/10 \u00B7 <b>Total: ${p.total_score || 'N/A'}/50</b>\n`;
          }
          if (p.reaction_angle) radarMsg += `   \u{1F4A1} Angle: ${escapeHtml(p.reaction_angle)}\n`;
          if (p.source_url) radarMsg += `   \u{1F517} ${escapeHtml(p.source_url)}\n`;
          radarMsg += '\n';
        }
        radarMsg += `<i>Running fresh scan for more angles...</i>`;
        await ctx.reply(radarMsg, { parse_mode: 'HTML' });
      }

      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getReaction(topic);
        clearInterval(typingInterval);
        const msg = formatReaction(result);
        await sendOrSave(ctx, msg, 'reaction', topic);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Reaction search failed');
        await ctx.reply(`\u274C Reaction search failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('hooks', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const topic = ctx.match?.trim();
      if (!topic) { await ctx.reply('Usage: /hooks <topic>\nExample: /hooks corrida 5k iniciante'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getHooks(topic);
        clearInterval(typingInterval);
        const msg = formatHooks(result);
        await sendOrSave(ctx, msg, 'hooks', topic);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Hooks generation failed');
        await ctx.reply(`\u274C Hooks failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // /genscript -> alias for /script (deprecated, forwards silently)
  bot.command('genscript', async (ctx) => {
    logger.info('Deprecated /genscript used \u2014 forwarding to /script handler');
    enqueue(ctx.from!.id, async () => {
      await handleScriptCommand(ctx);
    });
  });

  bot.command('titles', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const topic = ctx.match?.trim();
      if (!topic) { await ctx.reply('Usage: /titles <topic>\nExample: /titles como perder gordura sem cardio'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getTitles(topic);
        clearInterval(typingInterval);
        const msg = formatTitles(result);
        await sendOrSave(ctx, msg, 'titles', topic);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Titles generation failed');
        await ctx.reply(`\u274C Titles failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('genthumbnail', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const title = ctx.match?.trim();
      if (!title) { await ctx.reply('Usage: /genthumbnail <video title>\nExample: /genthumbnail PERDI 10KG EM 30 DIAS'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getThumbnail(title);
        clearInterval(typingInterval);
        const msg = formatThumbnail(result);
        await sendOrSave(ctx, msg, 'genthumbnail', title);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Thumbnail generation failed');
        await ctx.reply(`\u274C Thumbnail failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('gencaption', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const topic = ctx.match?.trim();
      if (!topic) { await ctx.reply('Usage: /gencaption <topic>\nExample: /gencaption treino de peito e tr\u00EDceps'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getCaption(topic);
        clearInterval(typingInterval);
        const msg = formatCaption(result);
        await sendOrSave(ctx, msg, 'gencaption', topic);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Caption generation failed');
        await ctx.reply(`\u274C Caption failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('competitor', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const channel = ctx.match?.trim();
      if (!channel) { await ctx.reply('Usage: /competitor <channel URL or handle>\nExample: /competitor @RenatoCariani'); return; }
      await ctx.reply('\u{1F50E} Analyzing competitor\u2026 this may take 30-60s.', { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getCompetitor(channel);
        clearInterval(typingInterval);
        const msg = formatCompetitor(result);
        await sendOrSave(ctx, msg, 'competitor', channel, true);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Competitor analysis failed');
        await ctx.reply(`\u274C Competitor analysis failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('gaps', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const niche = ctx.match?.trim() || 'fitness';
      await ctx.reply(`\u{1F50D} Finding content gaps for <b>${escapeHtml(niche)}</b>\u2026`, { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getGaps(niche);
        clearInterval(typingInterval);
        const msg = formatGaps(result);
        await sendOrSave(ctx, msg, 'gaps', niche);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Gap analysis failed');
        await ctx.reply(`\u274C Gap analysis failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('seo', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const input = ctx.match?.trim() || '';

      // /seo (no args) -> dashboard of tracked keywords
      if (!input) {
        const db = getDb();
        const keywords = db.prepare(`
          SELECT keyword, last_rank, previous_rank, trend, last_checked
          FROM seo_keywords ORDER BY last_rank ASC NULLS LAST, keyword ASC
        `).all() as any[];

        if (keywords.length === 0) {
          await ctx.reply(
            '\u{1F4CA} <b>SEO Dashboard</b>\n\nNo keywords tracked yet.\n\n' +
            '<code>/seo track [keyword]</code> \u2014 Track a keyword\n' +
            '<code>/seo [topic]</code> \u2014 Research keywords for a topic',
            { parse_mode: 'HTML' },
          );
          return;
        }

        let msg = `\u{1F4CA} <b>SEO Dashboard</b> (${keywords.length} keywords)\n\n`;
        for (const kw of keywords) {
          const arrow = kw.trend === 'up' ? '\u{1F4C8}' : kw.trend === 'down' ? '\u{1F4C9}' : '\u27A1\uFE0F';
          const rank = kw.last_rank ? `#${kw.last_rank}` : 'N/R';
          const delta = (kw.previous_rank && kw.last_rank)
            ? ` (was #${kw.previous_rank})`
            : '';
          msg += `${arrow} <b>${escapeHtml(kw.keyword)}</b> \u2014 ${rank}${delta}\n`;
        }
        msg += `\n<i>Updated: ${keywords[0]?.last_checked || 'never'}</i>`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      // /seo track [keyword] -> add keyword to tracking
      if (input.startsWith('track ')) {
        const keyword = input.replace('track ', '').trim();
        if (!keyword) { await ctx.reply('Usage: <code>/seo track [keyword]</code>', { parse_mode: 'HTML' }); return; }

        const db = getDb();
        db.prepare(`
          INSERT OR IGNORE INTO seo_keywords (keyword, pillar, last_checked)
          VALUES (?, 'manual', datetime('now'))
        `).run(keyword);

        // Immediately check ranking
        const { checkKeywordRanking } = await import('../../services/youtube-analytics');
        const channelId = config.youtube?.channelId;
        if (channelId) {
          const result = await checkKeywordRanking(keyword, channelId);
          if (result.position) {
            db.prepare('UPDATE seo_keywords SET last_rank = ? WHERE keyword = ?')
              .run(result.position, keyword);
            await ctx.reply(
              `\u2705 Now tracking: <b>${escapeHtml(keyword)}</b>\nCurrent rank: <b>#${result.position}</b>` +
              (result.topCompetitor ? `\nTop competitor: ${escapeHtml(result.topCompetitor)}` : ''),
              { parse_mode: 'HTML' },
            );
          } else {
            await ctx.reply(`\u2705 Now tracking: <b>${escapeHtml(keyword)}</b>\nNo ranking found yet (not in top 20).`, { parse_mode: 'HTML' });
          }
        } else {
          await ctx.reply(`\u2705 Now tracking: <b>${escapeHtml(keyword)}</b>\n\u26A0\uFE0F Set YOUTUBE_CHANNEL_ID to enable rank checking.`, { parse_mode: 'HTML' });
        }
        return;
      }

      // /seo [topic] -> keyword research via content engine
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getSeo(input);
        clearInterval(typingInterval);
        const msg = formatSeo(result);
        await sendOrSave(ctx, msg, 'seo', input);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'SEO analysis failed');
        await ctx.reply(`\u274C SEO failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('feedback', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const args = ctx.match?.trim();
      if (!args) {
        await ctx.reply(
          '\u{1F4CA} <b>Usage:</b>\n' +
          '<code>/feedback &lt;url&gt;</code> \u2014 Auto-fetch from YouTube API\n' +
          '<code>/feedback &lt;url&gt; &lt;views&gt; &lt;ret%&gt; [likes] [comments] [subs]</code> \u2014 Manual\n\n' +
          'Example: <code>/feedback https://youtu.be/abc</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }
      const parts = args.split(/\s+/);
      const videoUrl = parts[0];

      // Auto-fetch mode: URL only (no manual numbers)
      if (parts.length === 1 && (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be'))) {
        await ctx.reply('\u{1F4CA} Fetching stats from YouTube API...', { parse_mode: 'HTML' });
        const { extractVideoId, getVideoStats } = await import('../../services/youtube-analytics');
        const videoId = extractVideoId(videoUrl);
        if (!videoId) { await ctx.reply('\u274C Could not extract video ID from URL.'); return; }

        const stats = await getVideoStats(videoId);
        if (!stats) { await ctx.reply('\u274C Could not fetch stats. Video may be private or API key issue.'); return; }

        await ctx.replyWithChatAction('typing');
        try {
          const result = await logFeedback({
            video_url: videoUrl,
            views: stats.views,
            retention_pct: stats.retentionPct || 0,
            likes: stats.likes,
            comments: stats.comments,
            subs_gained: stats.subscribersGained || 0,
          });
          const msg = formatFeedback(result);
          const autoNote = `\n\n<i>\u{1F4E1} Auto-fetched from YouTube API: ${stats.views.toLocaleString()} views, ${stats.likes.toLocaleString()} likes, ${stats.comments.toLocaleString()} comments</i>`;
          await sendOrSave(ctx, msg + autoNote, 'feedback', videoUrl);
        } catch (err: any) {
          logger.error({ err }, 'Feedback logging failed');
          await ctx.reply(`\u274C Feedback failed: ${escapeHtml(err.message || 'Unknown error')}`);
        }
        return;
      }

      // Manual mode: URL + numbers
      if (parts.length < 3) {
        await ctx.reply('\u274C Need at least: URL, views, retention%. Or just URL for auto-fetch.');
        return;
      }
      const [, viewsStr, retStr, likesStr, commentsStr, subsStr] = parts;
      const views = parseInt(viewsStr, 10);
      const retention = parseFloat(retStr);
      if (isNaN(views) || isNaN(retention)) {
        await ctx.reply('\u274C Views and retention must be numbers.');
        return;
      }
      await ctx.replyWithChatAction('typing');
      try {
        const result = await logFeedback({
          video_url: videoUrl,
          views,
          retention_pct: retention,
          likes: likesStr ? parseInt(likesStr, 10) || 0 : 0,
          comments: commentsStr ? parseInt(commentsStr, 10) || 0 : 0,
          subs_gained: subsStr ? parseInt(subsStr, 10) || 0 : 0,
        });
        const msg = formatFeedback(result);
        await sendOrSave(ctx, msg, 'feedback', videoUrl);
      } catch (err: any) {
        logger.error({ err }, 'Feedback logging failed');
        await ctx.reply(`\u274C Feedback failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('report', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const period = ctx.match?.trim() || 'week';
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getReport(period);
        clearInterval(typingInterval);
        const msg = formatReport(result);
        await sendOrSave(ctx, msg, 'report', period, true);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Report generation failed');
        await ctx.reply(`\u274C Report failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ── Content Learning Commands ──────────────────────────────

  bot.command('learnfrom', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const url = ctx.match?.trim();
      if (!url || !url.includes('youtube.com')) {
        await ctx.reply(
          '\u{1F4DA} <b>Usage:</b> <code>/learnfrom https://www.youtube.com/@ChannelHandle</code>\n\n' +
          'Analyzes a YouTube channel and extracts content creation patterns (hooks, titles, storytelling, etc.) ' +
          'to improve your content AI.',
          { parse_mode: 'HTML' },
        );
        return;
      }
      await ctx.replyWithChatAction('typing');
      await ctx.reply(
        '\u{1F50D} Analyzing channel\u2026 this takes 30-60s (fetching videos + Claude analysis).',
        { parse_mode: 'HTML' },
      );
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);
      try {
        const userId = resolveCanonicalUserId(ctx.from!.id) ?? 0;
        const result = await addAndAnalyzeChannel(url, 'bot', userId);
        clearInterval(typingInterval);

        if (result.analysis.success) {
          let msg = `\u{1F4DA} <b>Channel Learned!</b>\n\n`;
          msg += `\u{1F4FA} <b>${escapeHtml(result.channel.channel_name || url)}</b>\n`;
          msg += `\u{1F3AC} ${result.analysis.videosAnalyzed} videos analyzed\n`;
          msg += `\u{1F9E0} ${result.analysis.patternsFound} patterns extracted\n`;
          if (result.analysis.summary) {
            msg += `\n\u{1F4DD} <i>${escapeHtml(result.analysis.summary.substring(0, 300))}${result.analysis.summary.length > 300 ? '...' : ''}</i>\n`;
          }
          msg += `\n\u2705 Knowledge has been synthesized and will be used in future content suggestions.`;
          await ctx.reply(msg, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(
            `\u26A0\uFE0F Failed to analyze channel: ${escapeHtml(result.analysis.error || 'Unknown error')}\n\n` +
            `Make sure the URL is correct and YOUTUBE_API_KEY is set.`,
            { parse_mode: 'HTML' },
          );
        }
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Channel learning failed');
        await ctx.reply(`\u274C Analysis failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('references', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const userId = resolveCanonicalUserId(ctx.from!.id) ?? 0;
      const channels = getAllChannels(userId);
      if (channels.length === 0) {
        await ctx.reply(
          '\u{1F4DA} No reference channels configured.\n\nUse <code>/learnfrom https://www.youtube.com/@Channel</code> to add one.',
          { parse_mode: 'HTML' },
        );
        return;
      }

      let msg = `\u{1F4DA} <b>Content Reference Channels</b> (${channels.length})\n\n`;
      for (const ch of channels) {
        const statusEmoji = ch.status === 'active' ? '\u2705' :
                           ch.status === 'analyzing' ? '\u{1F504}' :
                           ch.status === 'pending' ? '\u23F3' : '\u274C';
        msg += `${statusEmoji} <b>${escapeHtml(ch.channel_name || ch.channel_url)}</b>\n`;
        msg += `   ${escapeHtml(ch.channel_url)}\n`;
        if (ch.video_count_analyzed > 0) {
          msg += `   \u{1F4CA} ${ch.video_count_analyzed} videos \u00B7 Last: ${ch.last_analyzed_at?.split('T')[0] || 'never'}\n`;
        }
        if (ch.error_message) {
          msg += `   \u26A0\uFE0F <i>${escapeHtml(ch.error_message.substring(0, 80))}</i>\n`;
        }
        msg += '\n';
      }

      const knowledge = buildKnowledgePromptBlock(userId);
      if (knowledge) {
        msg += `\n\u{1F9E0} <b>Active knowledge:</b> ${knowledge.split('\n').filter(l => l.trim()).length} lines injected into content AI`;
      } else {
        msg += `\n\u23F3 <i>No knowledge synthesized yet. Add channels and wait for analysis.</i>`;
      }

      await ctx.reply(msg, { parse_mode: 'HTML' });
    });
  });

  bot.command('relearn', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      await ctx.reply('\u{1F504} Re-analyzing all reference channels\u2026 this may take a few minutes.', { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);
      try {
        const result = await processAllChannelScopes(true);
        clearInterval(typingInterval);
        let msg = `\u{1F504} <b>Re-learning Complete</b>\n\n`;
        msg += `\u2705 Analyzed: ${result.analyzed} channel(s)\n`;
        if (result.failed > 0) msg += `\u274C Failed: ${result.failed}\n`;
        msg += `\u{1F9E0} Knowledge ${result.synthesized ? 'updated' : 'unchanged'}`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (err: any) {
        clearInterval(typingInterval);
        await ctx.reply(`\u274C Re-learning failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /contenttopic — Manual trigger for trending topics ────────────
  bot.command('contenttopic', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const arg = ctx.match?.trim().toLowerCase();
      if (arg === 'tuesday' || arg === 'reels') {
        await sendTopicCandidates(bot, ctx.from!.id, 'reel', 'tuesday_reels');
      } else if (arg === 'thursday' || arg === 'youtube') {
        await sendTopicCandidates(bot, ctx.from!.id, 'youtube', 'thursday_youtube');
      } else {
        await ctx.reply(
          '\u{1F4CB} <b>Usage:</b>\n\n' +
          '<code>/contenttopic tuesday</code> \u2014 5 trending Reel topics\n' +
          '<code>/contenttopic thursday</code> \u2014 5 trending YouTube topics',
          { parse_mode: 'HTML' },
        );
      }
    });
  });

  // ─── /contentretro — Manual trigger for weekly content package ─────
  bot.command('contentretro', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await sendWeeklyPackage(bot, ctx.from!.id);
    });
  });

  // ─── Book Commands ────────────────────────────────────────────────
  bot.command('addbook', async (ctx) => { enqueue(ctx.from!.id, () => handleAddBook(ctx)); });
  bot.command('booknote', async (ctx) => { enqueue(ctx.from!.id, () => handleBookNote(ctx)); });
  bot.command('books', async (ctx) => { enqueue(ctx.from!.id, () => handleListBooks(ctx)); });
  bot.command('bookidea', async (ctx) => { enqueue(ctx.from!.id, () => handleBookIdea(ctx)); });

  // ─── SEO Commands ──────────────────────────────────────────────────
  bot.command('seokeyword', async (ctx) => { enqueue(ctx.from!.id, () => handleAddSEOKeyword(ctx)); });
  bot.command('seorank', async (ctx) => { enqueue(ctx.from!.id, () => handleSEORank(ctx)); });

  // ─── Pipeline Commands ─────────────────────────────────────────────
  bot.command('pipeline', async (ctx) => { enqueue(ctx.from!.id, () => handlePipelineStatus(ctx)); });
  bot.command('filmed', async (ctx) => { enqueue(ctx.from!.id, () => handleFilmedStage(ctx)); });
  bot.command('editing', async (ctx) => { enqueue(ctx.from!.id, () => handleEditingStage(ctx)); });
  bot.command('published', async (ctx) => { enqueue(ctx.from!.id, () => handlePublishedStage(ctx)); });

  // ─── Autoresearch Commands ──────────────────────────────────────────
  bot.command('autoresearch', async (ctx) => { enqueue(ctx.from!.id, () => handleAutoresearch(ctx)); });
  bot.command('evalscore', async (ctx) => { enqueue(ctx.from!.id, () => handleEvalScore(ctx)); });

  // ─── /transcribe — Quick transcript fetch -> save as DOCX ───────────
  bot.command('transcribe', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const url = ctx.match?.trim();
      if (!url) {
        await ctx.reply('Usage: /transcribe <youtube-url>\n\nFetches the transcript and sends it as a Word file.', { parse_mode: 'HTML' });
        return;
      }

      const statusMsg = await ctx.reply('\u23F3 Fetching transcript...');

      try {
        const transcript = await getTranscript(url);
        if (!transcript) {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
            '\u274C No transcript available for this video. It may not have captions enabled.');
          return;
        }

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          '\u{1F4C4} Generating Word document...');

        const filePath = await saveTranscriptAsDocx(transcript);

        // Send summary + file
        let caption = `\u{1F4DD} <b>${escapeHtml(transcript.title)}</b>\n`;
        caption += `\u{1F4FA} ${escapeHtml(transcript.channelName)} \u00B7 ${transcript.language}${transcript.isAutoGenerated ? ' (auto)' : ''}\n`;
        caption += `\u23F1 ${Math.floor(transcript.durationSeconds / 60)}:${(transcript.durationSeconds % 60).toString().padStart(2, '0')} \u00B7 ${transcript.segments.length} segments \u00B7 ${Math.round(transcript.fullText.length / 1000)}K chars`;

        await ctx.replyWithDocument(new InputFile(filePath), {
          caption,
          parse_mode: 'HTML',
        });

        // Clean up status message
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      } catch (err: any) {
        logger.error({ err, url }, '/transcribe failed');
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          `\u274C Failed to fetch transcript: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /studyvideo — Deep video analysis -> save as DOCX ───────────────
  bot.command('studyvideo', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const url = ctx.match?.trim();
      if (!url) {
        await ctx.reply(
          'Usage: /studyvideo <youtube-url>\n\n' +
          'Deep-analyzes a video and sends the result as a Word file:\n' +
          '\u2022 \u{1F3A3} Hook breakdown (first 30s)\n' +
          '\u2022 \u{1F3D7}\uFE0F Content structure with timestamps\n' +
          '\u2022 \u2B50 Key moments (quotable/viral)\n' +
          '\u2022 \u{1F4A1} Content ideas (PT-BR, your niches)\n' +
          '\u2022 \u{1F3AC} Reel/Short cut suggestions',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const statusMsg = await ctx.reply('\u{1F52C} Studying video... (fetching transcript + running analysis, ~30s)');

      try {
        const result = await studyVideo(url);

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          '\u{1F4C4} Generating Word document...');

        const filePath = await saveStudyAsDocx(result);

        let caption = `\u{1F52C} <b>Video Study: ${escapeHtml(result.title)}</b>\n`;
        caption += `\u{1F4FA} ${escapeHtml(result.channelName)}\n`;
        caption += `\u{1F3A3} Hook \u00B7 \u{1F3D7}\uFE0F Structure \u00B7 \u2B50 Key Moments \u00B7 \u{1F4A1} Ideas \u00B7 \u{1F3AC} Reel Cuts`;

        await ctx.replyWithDocument(new InputFile(filePath), {
          caption,
          parse_mode: 'HTML',
        });

        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      } catch (err: any) {
        logger.error({ err, url }, '/studyvideo failed');
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          `\u274C Video study failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /script — Full video script (research + intelligence bus) ──────
  bot.command('script', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await handleScriptCommand(ctx);
    });
  });

  // ─── /reel — Generate a Reel/Short script with SFX + editing cues ──
  bot.command('reel', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const topic = ctx.match?.toString().trim();
      if (!topic) {
        await ctx.reply(
          '\u{1F3AC} <b>Usage:</b> <code>/reel &lt;topic&gt;</code>\n\n' +
          'Generates a 30-60s Reel/Short script with [SFX:] markers, [EDIT:] cues, and timing marks.\n\n' +
          'Examples:\n' +
          '  <code>/reel 3 erros no jejum intermitente</code>\n' +
          '  <code>/reel por que acordar \u00E0s 5h \u00E9 golpe</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }
      await ctx.reply('\u{1F3AC} Generating Reel script\u2026 ~30s (research + writing).', { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getScript(topic, 'general', 1, 'Reel');
        clearInterval(typingInterval);
        const msg = formatScript(result);
        await sendOrSave(ctx, msg, 'reel', topic, true);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Reel script generation failed');
        await ctx.reply(`\u274C Reel script failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /buildscript — Generate a Build Log script for tech/AI projects ──
  bot.command('buildscript', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('\u26A0\uFE0F Content Engine not enabled.'); return; }
      const project = ctx.match?.toString().trim();
      if (!project) {
        await ctx.reply(
          '\u{1F6E0}\uFE0F <b>Usage:</b> <code>/buildscript &lt;project&gt;</code>\n\n' +
          'Generates a Build Log script (Hook \u2192 Problem \u2192 Build \u2192 Result) with screen recording cues.\n\n' +
          'Examples:\n' +
          '  <code>/buildscript telegram bot que agenda treinos</code>\n' +
          '  <code>/buildscript AI agent que analisa concorrentes</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }
      await ctx.reply('\u{1F6E0}\uFE0F Generating Build Log script\u2026 ~30-60s (research + writing).', { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getScript(project, 'general', 2, 'Build');
        clearInterval(typingInterval);
        const msg = formatScript(result);
        await sendOrSave(ctx, msg, 'buildscript', project, true);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Build script generation failed');
        await ctx.reply(`\u274C Build script failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /calendar — Generate a content calendar for the next week/month ──
  bot.command('calendar', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const period = ctx.match?.toString().trim() || 'week';
      const days = period.toLowerCase().startsWith('month') ? 30 : 7;
      await ctx.reply(`\u{1F4C5} Generating ${days}-day content calendar\u2026`, { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const calendarPrompt =
          `Generate a content calendar for the next ${days} days for a Brazilian creator named Felipe "The Operator" Dominguez.\n\n` +
          `PILLARS (rotate evenly across all days):\n` +
          `\u{1F916} AI/Tech \u2014 builds, automations, AI tools\n` +
          `\u{1F5E3}\uFE0F Commentary \u2014 politics, culture, hot takes\n` +
          `\u{1F4AA} Training \u2014 triathlon, carnivore diet, fitness\n` +
          `\u{1F3AE} Gaming \u2014 Helldivers, game reviews\n` +
          `\u{1F0CF} Wild Card \u2014 memes, personal stories, collabs\n\n` +
          `For each day provide EXACTLY this format (one line per day):\n` +
          `DAY | PILLAR_EMOJI | TOPIC | FORMAT | TIME_SENSITIVITY\n\n` +
          `FORMAT must be one of: Reel, YouTube, Both\n` +
          `TIME_SENSITIVITY must be: \u{1F525} (urgent/trending) or \u23F3 (evergreen)\n\n` +
          `Rules:\n` +
          `- Each pillar appears at least once per week\n` +
          `- Mix Reels and YouTube formats (not all the same)\n` +
          `- Topics should be specific and actionable, not generic\n` +
          `- Start from tomorrow's date\n` +
          `- Output as HTML table with <b> tags for headers\n` +
          `- Language: PT-BR for topics`;

        const contentResponse = await handleContent(calendarPrompt, 4096);
        clearInterval(typingInterval);
        const msg = `\u{1F4C5} <b>CONTENT CALENDAR \u2014 Next ${days} days</b>\n\n${contentResponse.text}`;
        await sendOrSave(ctx, msg, 'calendar', `${days}-day-plan`);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Calendar generation failed');
        await ctx.reply(`\u274C Calendar failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /brandcheck — Analyze recent content for pillar balance ──────
  bot.command('brandcheck', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const db = getDb();
        // Query last 30 days of content topics by niche
        const rows = db.prepare(`
          SELECT niche, COUNT(*) as cnt, sentiment,
                 GROUP_CONCAT(topic, ' | ') as topics
          FROM content_topic_feedback
          WHERE created_at > datetime('now', '-30 days')
          GROUP BY niche, sentiment
          ORDER BY cnt DESC
        `).all() as Array<{ niche: string; cnt: number; sentiment: string; topics: string }>;

        if (rows.length === 0) {
          clearInterval(typingInterval);
          await ctx.reply(
            '\u{1F4CA} <b>Brand Check</b>\n\nNo content topics found in the last 30 days.\n' +
            'Use <code>/contenttopic</code> to generate topic candidates first.',
            { parse_mode: 'HTML' },
          );
          return;
        }

        // Build a summary for Claude to analyze
        let dataSummary = 'Content topics from the last 30 days by niche and sentiment:\n\n';
        for (const row of rows) {
          dataSummary += `- ${row.niche || 'unknown'} (${row.sentiment}): ${row.cnt} topics\n`;
          dataSummary += `  Examples: ${row.topics.split(' | ').slice(0, 3).join(', ')}\n`;
        }

        const analysisPrompt =
          `You are a content strategist analyzing pillar balance for Felipe "The Operator" Dominguez.\n\n` +
          `His 5 pillars are:\n` +
          `\u{1F916} AI/Tech\n\u{1F5E3}\uFE0F Commentary/Politics\n\u{1F4AA} Training/Fitness\n\u{1F3AE} Gaming\n\u{1F0CF} Wild Card\n\n` +
          `Here is the actual data from the last 30 days:\n${dataSummary}\n\n` +
          `Provide:\n` +
          `1. A brief analysis of which pillars are OVER-represented and which are UNDER-represented\n` +
          `2. A "balance score" from 1-10 (10 = perfectly balanced)\n` +
          `3. Exactly 3 specific topic suggestions for each underrepresented pillar\n\n` +
          `Format as clean HTML with <b> tags for headers. Be direct and actionable. Language: PT-BR.`;

        const contentResponse = await handleContent(analysisPrompt, 4096);
        clearInterval(typingInterval);
        const msg = `\u{1F4CA} <b>BRAND CHECK \u2014 Pillar Balance (30 days)</b>\n\n${contentResponse.text}`;
        await sendOrSave(ctx, msg, 'brandcheck', 'pillar-analysis');
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Brand check failed');
        await ctx.reply(`\u274C Brand check failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /repurpose — Upload a script .docx -> multi-format content ─────
  bot.command('repurpose', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      // Check if replying to a document message
      const replyMsg = ctx.message?.reply_to_message;
      const doc = replyMsg?.document || ctx.message?.document;
      const textTopic = ctx.match?.trim();

      // Text-based: /repurpose <topic> (no document)
      if (!doc && textTopic) {
        await ctx.replyWithChatAction('typing');
        const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
        try {
          const repurposePrompt = `Repurpose the following content topic into these formats:\n\n` +
            `1. **3 REELS/SHORTS** (30-60s each) \u2014 complete scripts with hook, body, CTA. Each one takes a different angle.\n` +
            `2. **1 STORIES SEQUENCE** (5-7 stories) \u2014 text + poll/question stickers suggestions.\n\n` +
            `Everything in PT-BR. Make each format self-contained and optimized for its platform.\n\n` +
            `Topic: ${textTopic}`;
          const contentResponse = await handleContent(repurposePrompt, 8192);
          clearInterval(typingInterval);
          const filePath = await saveScriptAsDocx(`Repurpose \u2014 ${textTopic}`, contentResponse.text);
          await ctx.replyWithDocument(new InputFile(filePath), {
            caption: `\u267B\uFE0F <b>Repurposed: ${escapeHtml(textTopic)}</b>\n\u{1F3AC} 3 Reels \u00B7 \u{1F4D6} Stories`,
            parse_mode: 'HTML',
          });
        } catch (err: any) {
          clearInterval(typingInterval);
          logger.error({ err }, '/repurpose (text) failed');
          await ctx.reply(`\u274C Repurpose failed: ${escapeHtml(err.message || 'Unknown error')}`);
        }
        return;
      }

      if (!doc) {
        await ctx.reply(
          '\u267B\uFE0F <b>Usage:</b>\n\n' +
          '\u25B8 Reply to a .docx script file with /repurpose\n' +
          '\u25B8 Or: <code>/repurpose topic here</code>\n\n' +
          'Generates from your script:\n' +
          '  \u25B8 3 Reels/Shorts scripts (30-60s)\n' +
          '  \u25B8 1 Stories sequence',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const fileName = doc.file_name || '';
      if (!fileName.endsWith('.docx')) {
        await ctx.reply('\u274C Please send a .docx file. Other formats are not supported.');
        return;
      }

      const statusMsg = await ctx.reply('\u{1F4E5} Reading script...');

      try {
        // Download the file from Telegram
        const file = await ctx.api.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        // Extract text from .docx using mammoth
        const mammoth = await import('mammoth');
        const result = await mammoth.default.extractRawText({ buffer });
        const scriptText = result.value;

        if (!scriptText || scriptText.trim().length < 50) {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
            '\u274C Could not extract enough text from the document.');
          return;
        }

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          '\u267B\uFE0F Repurposing script into multiple formats...');

        // Send to content domain with high token limit
        const repurposePrompt = `I have the following YouTube video script. Repurpose it into these formats:\n\n` +
          `1. **3 REELS/SHORTS** (30-60s each) \u2014 complete scripts with hook, body, CTA. Each one takes a different angle from the original.\n` +
          `2. **1 STORIES SEQUENCE** (5-7 stories) \u2014 text + poll/question stickers suggestions.\n\n` +
          `Everything in PT-BR. Make each format self-contained and optimized for its platform.\n\n` +
          `\u2501\u2501\u2501 ORIGINAL SCRIPT \u2501\u2501\u2501\n\n${scriptText}`;

        const contentResponse = await handleContent(repurposePrompt, 8192);

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          '\u{1F4C4} Saving as Word document...');

        // Extract topic from filename
        const topic = fileName
          .replace(/^script_/, '').replace(/\.docx$/, '').replace(/_/g, ' ').trim()
          || 'repurposed content';

        const filePath = await saveScriptAsDocx(`Repurpose \u2014 ${topic}`, contentResponse.text);

        const caption = `\u267B\uFE0F <b>Repurposed: ${escapeHtml(topic)}</b>\n` +
          `\u{1F3AC} 3 Reels \u00B7 \u{1F4D6} Stories`;

        await ctx.replyWithDocument(new InputFile(filePath), {
          caption,
          parse_mode: 'HTML',
        });

        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      } catch (err: any) {
        logger.error({ err }, '/repurpose failed');
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          `\u274C Repurpose failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ── Content Idea Callback Handler ──
  bot.callbackQuery(/^ci:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];

    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Ignore if callback query is too old
    }

    const cbData = getCallback(ref);
    if (!cbData) {
      await ctx.answerCallbackQuery({ text: '\u26A0\uFE0F Expired. Run /discover again.' });
      return;
    }

    if (action === 'save') {
      saveIdea(cbData.title, cbData.date);
      await ctx.answerCallbackQuery({ text: `\u{1F4BE} Saved: ${cbData.title.slice(0, 40)}` });
    }
  });

  // ── Content Workflow Callback Handler ──
  bot.callbackQuery(/^cw:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1]; // approve | skip | reject
    const feedbackId = parseInt(parts[2], 10);

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    if (isNaN(feedbackId)) {
      await ctx.answerCallbackQuery({ text: '\u26A0\uFE0F Invalid topic reference.' });
      return;
    }

    const topic = getTopicById(feedbackId);
    if (!topic) {
      await ctx.answerCallbackQuery({ text: '\u26A0\uFE0F Topic not found.' });
      return;
    }

    if (action === 'approve') {
      updateFeedback(feedbackId, 'approved');
      await ctx.answerCallbackQuery({ text: `\u2705 ${topic.title.slice(0, 40)}` });

      enqueue(ctx.from!.id, async () => {
        const statusMsg = await ctx.reply(
          `\u270D\uFE0F Generating ${topic.format} script for: <b>${escapeHtml(topic.title)}</b>...`,
          { parse_mode: 'HTML' },
        );

        try {
          const scriptText = topic.format === 'reel'
            ? await generateReelScript(topic)
            : await generateYouTubeScript(topic);

          const filePath = await saveScriptAsDocx(topic.title, scriptText);
          markScriptGenerated(feedbackId);

          const emoji = topic.format === 'reel' ? '\u{1F3AC}' : '\u{1F3A5}';
          await ctx.replyWithDocument(new InputFile(filePath), {
            caption: `${emoji} <b>${topic.format === 'reel' ? 'Reel' : 'YT'} Script: ${escapeHtml(topic.title)}</b>\n\u2705 Ready to record`,
            parse_mode: 'HTML',
          });

          await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
        } catch (err: any) {
          logger.error({ err, feedbackId }, 'Content workflow script generation failed');
          await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id,
            `\u274C Script failed: ${escapeHtml(err.message || 'Unknown error')}`);
        }
      });

    } else if (action === 'skip') {
      updateFeedback(feedbackId, 'skipped');
      await ctx.answerCallbackQuery({ text: `\u23ED Skipped: ${topic.title.slice(0, 40)}` });

    } else if (action === 'reject') {
      updateFeedback(feedbackId, 'rejected');
      await ctx.answerCallbackQuery({ text: `\u{1F44E} Noted \u2014 won't suggest similar` });
    }
  });
}

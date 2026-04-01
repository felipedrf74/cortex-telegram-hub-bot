// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Autoresearch bot commands — /autoresearch and /evalscore
 */

import type { Context } from 'grammy';
import { runAutoresearch, runEvalOnly } from '../services/autoresearch';
import { getEvalTarget, getAllTargets } from '../services/eval-criteria';
import { escapeHtml, splitMessage } from '../utils/telegram-formatter';
import { logger } from '../utils/logger';

export async function handleAutoresearch(ctx: Context): Promise<void> {
  const raw = ctx.match?.toString().trim() || '';
  const dryRun = /--dry/i.test(raw);
  const args = raw.replace(/--dry/gi, '').trim().split(/\s+/);
  const targetId = args[0];
  const maxRounds = parseInt(args[1], 10) || 3;

  if (!targetId) {
    const targets = getAllTargets().map((t) => `<code>${t.id}</code> — ${escapeHtml(t.description)}`).join('\n');
    await ctx.reply(
      `<b>Usage:</b> <code>/autoresearch &lt;target&gt; [rounds] [--dry]</code>\n\n` +
      `<b>Available targets:</b>\n${targets}\n\n` +
      `Example: <code>/autoresearch secretary 3 --dry</code>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const target = getEvalTarget(targetId);
  if (!target) {
    await ctx.reply(`Unknown target: <code>${escapeHtml(targetId)}</code>. Use /autoresearch to see available targets.`, { parse_mode: 'HTML' });
    return;
  }

  const statusMsg = await ctx.reply(
    `🔬 Starting autoresearch for <b>${escapeHtml(targetId)}</b> — ${maxRounds} rounds${dryRun ? ' (DRY RUN)' : ''}...`,
    { parse_mode: 'HTML' },
  );

  try {
    const result = await runAutoresearch(targetId, maxRounds, dryRun, async (msg) => {
      try {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, msg, { parse_mode: 'HTML' });
      } catch {
        // Telegram may reject if message hasn't changed
      }
    });

    // Build final summary
    let summary = `<b>Autoresearch: ${escapeHtml(targetId)}</b>\n\n`;
    summary += `Run: <code>${result.runId.slice(0, 8)}</code>\n`;
    summary += `Final score: <b>${(result.finalScore * 100).toFixed(1)}%</b>\n`;
    summary += `Duration: ${(result.totalDurationMs / 1000).toFixed(0)}s\n\n`;

    for (const round of result.rounds) {
      const icon = round.decision === 'kept' ? '✅' : round.decision === 'reverted' ? '❌' : '⏸';
      summary += `${icon} Round ${round.round}: ${(round.baselineScore * 100).toFixed(1)}%`;
      if (round.newScore !== null) {
        summary += ` → ${(round.newScore * 100).toFixed(1)}%`;
      }
      if (round.mutationDescription) {
        summary += `\n   <i>${escapeHtml(round.mutationDescription)}</i>`;
      }
      summary += '\n';
    }

    for (const chunk of splitMessage(summary)) {
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  } catch (err: any) {
    logger.error({ err, targetId }, 'Autoresearch command failed');
    await ctx.reply(`❌ Autoresearch failed: ${escapeHtml(err.message || 'Unknown error')}`, { parse_mode: 'HTML' });
  }
}

export async function handleEvalScore(ctx: Context): Promise<void> {
  const targetId = ctx.match?.toString().trim();

  if (!targetId) {
    const targets = getAllTargets().map((t) => `<code>${t.id}</code>`).join(', ');
    await ctx.reply(
      `<b>Usage:</b> <code>/evalscore &lt;target&gt;</code>\n\nTargets: ${targets}`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const target = getEvalTarget(targetId);
  if (!target) {
    await ctx.reply(`Unknown target: <code>${escapeHtml(targetId)}</code>`, { parse_mode: 'HTML' });
    return;
  }

  const statusMsg = await ctx.reply(`🔍 Evaluating <b>${escapeHtml(targetId)}</b>...`, { parse_mode: 'HTML' });

  try {
    const result = await runEvalOnly(targetId);

    let msg = `<b>Eval: ${escapeHtml(targetId)}</b>\n`;
    msg += `Score: <b>${(result.score * 100).toFixed(1)}%</b>\n`;
    msg += `Weakest: <code>${escapeHtml(result.weakestCriterion)}</code> (${(result.weakestScore * 100).toFixed(0)}%)\n\n`;

    for (const detail of result.details) {
      const inputScore = (detail.score * 100).toFixed(0);
      msg += `<b>${escapeHtml(detail.inputId)}</b> — ${inputScore}%\n`;
      for (const cr of detail.criteria) {
        msg += `  ${cr.passed ? '✅' : '❌'} ${escapeHtml(cr.criterionId)}\n`;
      }
      msg += '\n';
    }

    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

    for (const chunk of splitMessage(msg)) {
      await ctx.reply(chunk, { parse_mode: 'HTML' });
    }
  } catch (err: any) {
    logger.error({ err, targetId }, 'Evalscore command failed');
    await ctx.reply(`❌ Eval failed: ${escapeHtml(err.message || 'Unknown error')}`, { parse_mode: 'HTML' });
  }
}

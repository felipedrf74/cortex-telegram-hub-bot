// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Inline keyboard callback query handlers — extracted from bot.ts Phase 5.
 *
 * Handles: td: (ToDo actions), cal: (calendar event actions).
 * Other callback prefixes (lang:, ob:, ci:, cw:, nf:, coach:) were
 * extracted in Phase 4 into their respective command modules.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { storeCallback, getCallback } from '../utils/callback-store';
import { logger } from '../utils/logger';
import { createEvent as createCalendarEvent } from '../services/unified-calendar';
import { classifyAndExtractImage } from '../services/anthropic';
import { escapeHtml, formatMsTodoTasks } from '../utils/telegram-formatter';
import { pendingEdits, isHtmlParseError } from './shared-state';
import {
  buildTaskListKeyboard,
  getTelegramTaskScope,
} from './commands/secretary-helpers';
import { handleTaskExtraction } from './photo';
import { downloadTelegramFile } from './telegram-file';

async function requireTelegramTaskScopeForCallback(ctx: any) {
  const taskScope = getTelegramTaskScope(ctx);
  if (!taskScope) {
    await ctx.editMessageText('⚠️ Task provider unavailable for this user.');
    return null;
  }
  return taskScope;
}

/**
 * Register callback query handlers for ToDo actions and calendar events.
 */
export function registerCallbackQueries(bot: Bot): void {

  // ── ToDo Callback Handler (td:) ──
  bot.callbackQuery(/^td:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];

    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Ignore if callback query is too old
    }

    if (action === 'dn') {
      // Cancel action
      await ctx.editMessageText('Cancelled.', { parse_mode: 'HTML' });
      return;
    }

    const cbData = getCallback(ref);
    if (!cbData) {
      await ctx.editMessageText('⚠️ This action has expired. Please try again.');
      return;
    }

    switch (action) {
      case 'ls': {
        // List selected — show tasks
        const taskScope = await requireTelegramTaskScopeForCallback(ctx);
        if (!taskScope) break;
        await ctx.editMessageText('Loading tasks...', { parse_mode: 'HTML' });
        const result = await taskScope.provider.getTasks(cbData.listId, cbData.listName, { status: 'notStarted' });
        if (!result.success) {
          await ctx.editMessageText(`⚠️ Failed to fetch tasks: ${result.error}`);
          return;
        }
        const msg = formatMsTodoTasks(result.data, cbData.listName);
        const keyboard = buildTaskListKeyboard(result.data, cbData.listId);
        await ctx.editMessageText(msg, {
          parse_mode: 'HTML',
          reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
        });
        break;
      }

      case 'tc': {
        // Complete task
        const taskScope = await requireTelegramTaskScopeForCallback(ctx);
        if (!taskScope) break;
        const result = await taskScope.provider.completeTask(cbData.listId, cbData.taskId);
        if (result.success) {
          await ctx.editMessageText(
            `✅ Completed: "<b>${escapeHtml(cbData.title)}</b>" [${escapeHtml(cbData.listName)}]`,
            { parse_mode: 'HTML' },
          );
        } else {
          await ctx.editMessageText(`⚠️ Failed to complete: ${result.error}`);
        }
        break;
      }

      case 'tx': {
        // Delete task — show confirmation
        const confirmRef = storeCallback({ ...cbData, type: 'task' });
        const keyboard = new InlineKeyboard()
          .text('Yes, delete', `td:dy:${confirmRef}`)
          .text('Cancel', `td:dn:${confirmRef}`);

        await ctx.editMessageText(
          `🗑 Delete "<b>${escapeHtml(cbData.title)}</b>"?`,
          { parse_mode: 'HTML', reply_markup: keyboard },
        );
        break;
      }

      case 'te': {
        // Edit task — show edit options
        const editKeyboard = new InlineKeyboard();
        const titleRef = storeCallback({ ...cbData, field: 'title' });
        const dueRef = storeCallback({ ...cbData, field: 'due' });
        const remRef = storeCallback({ ...cbData, field: 'reminder' });
        const prioRef = storeCallback({ ...cbData, field: 'priority' });

        editKeyboard
          .text('📝 Title', `td:ef:${titleRef}`)
          .text('📅 Due Date', `td:ef:${dueRef}`)
          .row()
          .text('⏰ Reminder', `td:ef:${remRef}`)
          .text('⚡ Priority', `td:ef:${prioRef}`)
          .row()
          .text('Cancel', 'td:dn:0');

        await ctx.editMessageText(
          `📝 Edit "<b>${escapeHtml(cbData.title)}</b>" — what do you want to change?`,
          { parse_mode: 'HTML', reply_markup: editKeyboard },
        );
        break;
      }

      case 'ef': {
        // Edit field — prompt user to type, then capture next message
        const field = cbData.field;
        const fieldLabels: Record<string, string> = {
          title: 'new title',
          due: 'due date (e.g., "tomorrow 5pm")',
          reminder: 'reminder time (e.g., "today 2pm")',
          priority: 'priority (low, normal, or high)',
        };
        const userId = ctx.from?.id;
        if (userId) {
          pendingEdits.set(userId, {
            listId: cbData.listId,
            taskId: cbData.taskId,
            title: cbData.title,
            listName: cbData.listName,
            field,
            expires: Date.now() + 120_000, // 2 min TTL
          });
        }
        await ctx.editMessageText(
          `📝 Send me the ${fieldLabels[field] || field} for "<b>${escapeHtml(cbData.title)}</b>":`,
          { parse_mode: 'HTML' },
        );
        break;
      }

      case 'dy': {
        // Confirm delete
        const taskScope = await requireTelegramTaskScopeForCallback(ctx);
        if (!taskScope) break;
        if (cbData.type === 'list') {
          const result = await taskScope.provider.deleteList(cbData.listId);
          if (result.success) {
            await ctx.editMessageText(`🗑 List "<b>${escapeHtml(cbData.listName)}</b>" deleted.`, { parse_mode: 'HTML' });
          } else {
            await ctx.editMessageText(`⚠️ Failed to delete list: ${result.error}`);
          }
        } else {
          const result = await taskScope.provider.deleteTask(cbData.listId, cbData.taskId);
          if (result.success) {
            await ctx.editMessageText(`🗑 Task "<b>${escapeHtml(cbData.title)}</b>" deleted.`, { parse_mode: 'HTML' });
          } else {
            await ctx.editMessageText(`⚠️ Failed to delete task: ${result.error}`);
          }
        }
        break;
      }

      case 'ep': {
        // Set priority from inline keyboard
        const level = cbData.level;
        const taskScope = await requireTelegramTaskScopeForCallback(ctx);
        if (!taskScope) break;
        const result = await taskScope.provider.updateTask(cbData.listId, cbData.taskId, { importance: level });
        if (result.success) {
          await ctx.editMessageText(
            `⚡ Priority set to <b>${level}</b> for "${escapeHtml(cbData.title)}"`,
            { parse_mode: 'HTML' },
          );
        } else {
          await ctx.editMessageText(`⚠️ Failed to update priority: ${result.error}`);
        }
        break;
      }

      default:
        await ctx.editMessageText('⚠️ Unknown action.');
    }
  });

  // ── Calendar Callback Handler (cal:) ──
  bot.callbackQuery(/^cal:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    const cbData = getCallback(ref);
    if (!cbData) {
      await ctx.editMessageText('⚠️ Ação expirada. Envie a foto novamente.');
      return;
    }

    if (action === 'create') {
      // Create the confirmed calendar events
      await ctx.editMessageText('⏳ Criando eventos no calendário...');

      const events = cbData.events as { title: string; start: string; end: string; description?: string }[];
      const categories = cbData.categories as string[];
      let successCount = 0;
      const createdTitles: string[] = [];

      for (const event of events) {
        try {
          const userId = ctx.from?.id;
          const created = await createCalendarEvent({
            title: event.title,
            start: event.start,
            end: event.end,
            description: event.description,
            categories,
          }, undefined, userId);
          successCount++;
          createdTitles.push(created.summary);
        } catch (err) {
          logger.error({ err, eventTitle: event.title }, 'Failed to create calendar event from image');
        }
      }

      if (successCount === 0) {
        await ctx.editMessageText('⚠️ Falha ao criar os eventos. Tente novamente.');
        return;
      }

      let msg = `📅✅ <b>${successCount} evento${successCount > 1 ? 's' : ''} criado${successCount > 1 ? 's' : ''}:</b>\n`;
      for (const title of createdTitles) {
        msg += `\n  📌 ${escapeHtml(title)}`;
      }
      msg += `\n\n🏷️ ${escapeHtml(categories[0])}`;

      try {
        await ctx.editMessageText(msg, { parse_mode: 'HTML' });
      } catch (err) {
        if (isHtmlParseError(err)) await ctx.editMessageText(msg.replace(/<[^>]*>/g, ''));
        else throw err;
      }

    } else if (action === 'cancel') {
      await ctx.editMessageText('❌ Criação de eventos cancelada.');

    } else if (action === 'undo') {
      // Reprocess as task instead
      await ctx.editMessageText('🔄 Reprocessando como tarefa...');
      const { base64: reBase64, mediaType: reMT } = await downloadTelegramFile(bot, cbData.fileId);
      const reClassified = await classifyAndExtractImage(reBase64, reMT, (cbData.caption || '') + ' [TASK LIST]');
      if (reClassified.type === 'task') {
        await handleTaskExtraction(ctx as any, reClassified, cbData.caption || '');
      } else {
        const evtTitles = reClassified.type === 'calendar' ? reClassified.events.map((e: any) => e.title) : [];
        await handleTaskExtraction(ctx as any,
          { type: 'task', title: evtTitles.length > 0 ? 'Items from image' : 'Photo', subtasks: evtTitles },
          cbData.caption || '');
      }
    }
  });
}

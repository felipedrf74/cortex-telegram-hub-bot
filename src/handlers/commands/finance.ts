// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Finance command handlers — extracted from bot.ts.
 *
 * Registers: /invoices, /addfatura, /rmfatura, /faturas, /amazon, /uber
 * Callback: nf: (invoice undo)
 */

import { Bot, InputFile } from 'grammy';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getCallback } from '../../utils/callback-store';
import { splitMessage, escapeHtml } from '../../utils/telegram-formatter';
import { now } from '../../utils/date-parser';
import { classifyAndExtractImage } from '../../services/anthropic';
import { isInvoiceFilingConfigured, PT_MONTHS } from '../../services/invoice-filer';
import { collectMonthlyInvoices, formatCollectionNotification, getBuiltinVendors } from '../../services/invoice-collector';
import { deleteAmazonFilings, deleteUberFilings } from '../../state/invoice-filings';
import { addVendor, removeVendorByName, getActiveVendors as getCustomVendors } from '../../state/invoice-vendors';
import {
  collectAmazonInvoices, formatAmazonNotification, isAmazonConfigured,
  registerReplyWaiter as registerAmazonReplyWaiter,
} from '../../services/amazon-collector';
import {
  collectUberInvoices, formatUberNotification, isUberConfigured,
  registerReplyWaiter as registerUberReplyWaiter,
} from '../../services/uber-collector';
import { handleTaskExtraction } from '../photo';
import { enqueue, isHtmlParseError } from '../shared-state';
import { downloadTelegramFile } from '../telegram-file';

export function registerFinanceCommands(bot: Bot): void {
  // /invoices [YYYY-MM] — Manual trigger for monthly invoice collection
  bot.command('invoices', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isInvoiceFilingConfigured()) {
        await ctx.reply('\u26A0\uFE0F Arquivamento de faturas n\u00E3o configurado.');
        return;
      }

      const arg = ctx.match?.trim();
      let year: number, month: number;

      if (arg && /^\d{4}-\d{2}$/.test(arg)) {
        const [y, m] = arg.split('-').map(Number);
        if (m < 1 || m > 12) {
          await ctx.reply('\u26A0\uFE0F M\u00EAs inv\u00E1lido. Use formato YYYY-MM (ex: 2026-02).');
          return;
        }
        year = y;
        month = m;
      } else {
        // Default: previous month
        const prev = now().minus({ months: 1 });
        year = prev.year;
        month = prev.month;
      }

      const monthLabel = `${PT_MONTHS[month]}-${year}`;
      await ctx.reply(`\u{1F4CA} A recolher faturas de <b>${monthLabel}</b>...`, { parse_mode: 'HTML' });

      try {
        const result = await collectMonthlyInvoices(undefined, year, month);
        const notification = formatCollectionNotification(result);

        for (const chunk of splitMessage(notification)) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]+>/g, ''));
            else throw err;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Manual invoice collection failed');
        await ctx.reply('\u26A0\uFE0F Recolha de faturas falhou. Verificar logs.');
      }
    });
  });

  // /addfatura <name> | <sender> — Register a new invoice vendor
  bot.command('addfatura', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const arg = ctx.match?.trim();
      if (!arg || !arg.includes('|')) {
        await ctx.reply(
          '\u{1F4DD} <b>Uso:</b> <code>/addfatura Nome | sender@domain.pt</code>\n\n' +
          'Exemplo: <code>/addfatura MEO | meo.pt</code>\n' +
          'Exemplo: <code>/addfatura Vodafone | vodafone.pt</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const [namePart, senderPart] = arg.split('|').map((s) => s.trim());
      if (!namePart || !senderPart) {
        await ctx.reply('\u26A0\uFE0F Nome e sender s\u00E3o obrigat\u00F3rios. Exemplo: <code>/addfatura MEO | meo.pt</code>', { parse_mode: 'HTML' });
        return;
      }

      try {
        const vendor = addVendor(namePart, senderPart);
        await ctx.reply(
          `\u2705 <b>${escapeHtml(vendor.name)}</b> adicionado.\n` +
          `\u{1F4E7} Emails de <code>${escapeHtml(vendor.sender_pattern)}</code> ser\u00E3o recolhidos no pr\u00F3ximo m\u00EAs.`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.error({ err, name: namePart, sender: senderPart }, 'Failed to add vendor');
        await ctx.reply('\u26A0\uFE0F Erro ao adicionar fornecedor.');
      }
    });
  });

  // /rmfatura <name> — Remove/disable a custom vendor
  bot.command('rmfatura', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const name = ctx.match?.trim();
      if (!name) {
        await ctx.reply('\u{1F4DD} <b>Uso:</b> <code>/rmfatura Nome</code>', { parse_mode: 'HTML' });
        return;
      }

      const removed = removeVendorByName(name);
      if (removed) {
        await ctx.reply(`\u{1F5D1} <b>${escapeHtml(name)}</b> desativado. N\u00E3o ser\u00E1 recolhido nos pr\u00F3ximos meses.`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`\u26A0\uFE0F Fornecedor "${escapeHtml(name)}" n\u00E3o encontrado. Usa /faturas para ver a lista.`, { parse_mode: 'HTML' });
      }
    });
  });

  // /faturas — List all configured vendors (builtin + custom)
  bot.command('faturas', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const builtins = getBuiltinVendors();
      const customs = getCustomVendors();

      let msg = `\u{1F4CB} <b>Fornecedores de Faturas</b>\n\n`;
      msg += `<b>\u{1F4CC} Fixos:</b>\n`;
      for (const v of builtins) {
        msg += `\u2022 ${escapeHtml(v.name)} \u2014 <code>${v.senderPatterns.join(', ')}</code>\n`;
      }

      if (customs.length > 0) {
        msg += `\n<b>\u{1F464} Personalizados:</b>\n`;
        for (const v of customs) {
          msg += `\u2022 ${escapeHtml(v.name)} \u2014 <code>${escapeHtml(v.sender_pattern)}</code>\n`;
        }
        msg += `\n<i>Remover com:</i> <code>/rmfatura Nome</code>`;
      } else {
        msg += `\n<i>Nenhum fornecedor personalizado. Adicionar com:</i>\n<code>/addfatura Nome | sender@domain.pt</code>`;
      }

      await ctx.reply(msg, { parse_mode: 'HTML' });
    });
  });

  // /amazon [YYYY-MM] [--force] — Manual trigger for Amazon.es invoice collection (with 2FA support)
  bot.command('amazon', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isAmazonConfigured()) {
        await ctx.reply(
          '\u26A0\uFE0F Amazon n\u00E3o configurado.\n' +
          'Defina <code>AMAZON_EMAIL</code>, <code>AMAZON_PASSWORD</code> e <code>AMAZON_COLLECTION_ENABLED=true</code> no .env',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const rawArg = ctx.match?.trim() || '';
      const force = /--force/i.test(rawArg);
      const arg = rawArg.replace(/--force/gi, '').trim();

      let year: number, month: number;

      if (arg && /^\d{4}-\d{2}$/.test(arg)) {
        const [y, m] = arg.split('-').map(Number);
        if (m < 1 || m > 12) {
          await ctx.reply('\u26A0\uFE0F M\u00EAs inv\u00E1lido. Use formato YYYY-MM (ex: 2026-02).');
          return;
        }
        year = y;
        month = m;
      } else {
        // Default: current month (Amazon invoices are available immediately)
        const current = now();
        year = current.year;
        month = current.month;
      }

      const monthLabel = `${PT_MONTHS[month]}-${year}`;

      // If --force, delete stale filing records for this month first
      if (force) {
        const deleted = deleteAmazonFilings(year, month);
        if (deleted > 0) {
          await ctx.reply(
            `\u{1F5D1} <b>--force</b>: ${deleted} registo(s) anterior(es) removido(s) para ${monthLabel}.`,
            { parse_mode: 'HTML' },
          );
        }
      }

      await ctx.reply(`\u{1F6D2} A recolher faturas Amazon.es para <b>${monthLabel}</b>...`, { parse_mode: 'HTML' });

      try {
        // Interactive Telegram callbacks for 2FA
        const chatId = ctx.chat.id;
        const sendMessage = async (text: string) => {
          await ctx.reply(text, { parse_mode: 'HTML' });
        };
        const sendScreenshot = async (buffer: Buffer) => {
          await ctx.replyWithPhoto(new InputFile(buffer, 'amazon-2fa.jpg'));
        };
        const waitForReply = (timeoutMs: number) => registerAmazonReplyWaiter(chatId, timeoutMs);

        const result = await collectAmazonInvoices(year, month, sendMessage, sendScreenshot, waitForReply);
        const notification = formatAmazonNotification(result);

        for (const chunk of splitMessage(notification)) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
            else throw err;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Manual Amazon invoice collection failed');
        await ctx.reply('\u26A0\uFE0F Recolha Amazon falhou. Verificar logs.');
      }
    });
  });

  // /uber [YYYY-MM] [--force] — Manual Uber invoice collection (rides + eats, with 2FA support)
  bot.command('uber', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isUberConfigured()) {
        await ctx.reply(
          '\u26A0\uFE0F Uber n\u00E3o configurado.\n' +
          'Defina <code>UBER_EMAIL</code>, <code>UBER_PASSWORD</code> e <code>UBER_COLLECTION_ENABLED=true</code> no .env',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const rawArg = ctx.match?.trim() || '';
      const force = /--force/i.test(rawArg);
      const arg = rawArg.replace(/--force/gi, '').trim();

      let year: number, month: number;

      if (arg && /^\d{4}-\d{2}$/.test(arg)) {
        const [y, m] = arg.split('-').map(Number);
        if (m < 1 || m > 12) {
          await ctx.reply('\u26A0\uFE0F M\u00EAs inv\u00E1lido. Use formato YYYY-MM (ex: 2026-02).');
          return;
        }
        year = y;
        month = m;
      } else {
        const current = now();
        year = current.year;
        month = current.month;
      }

      const monthLabel = `${PT_MONTHS[month]}-${year}`;

      if (force) {
        const deleted = deleteUberFilings(year, month);
        if (deleted > 0) {
          await ctx.reply(
            `\u{1F5D1} <b>--force</b>: ${deleted} registo(s) anterior(es) removido(s) para ${monthLabel}.`,
            { parse_mode: 'HTML' },
          );
        }
      }

      await ctx.reply(`\u{1F697} A recolher faturas Uber para <b>${monthLabel}</b>...`, { parse_mode: 'HTML' });

      try {
        const chatId = ctx.chat.id;
        const sendMessage = async (text: string) => {
          await ctx.reply(text, { parse_mode: 'HTML' });
        };
        const sendScreenshot = async (buffer: Buffer) => {
          await ctx.replyWithPhoto(new InputFile(buffer, 'uber-2fa.jpg'));
        };
        const waitForReply = (timeoutMs: number) => registerUberReplyWaiter(chatId, timeoutMs);

        const result = await collectUberInvoices(year, month, sendMessage, sendScreenshot, waitForReply);
        const notification = formatUberNotification(result);

        for (const chunk of splitMessage(notification)) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
            else throw err;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Manual Uber invoice collection failed');
        await ctx.reply('\u26A0\uFE0F Recolha Uber falhou. Verificar logs.');
      }
    });
  });

  // ── Invoice Correction Callback Handler ──
  bot.callbackQuery(/^nf:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    if (action === 'undo') {
      const cbData = getCallback(ref);
      if (!cbData) {
        await ctx.editMessageText('\u26A0\uFE0F A\u00E7\u00E3o expirada. Envie a foto novamente.');
        return;
      }
      // Delete auto-logged finance transaction if one was created
      if (cbData.txId && ctx.from?.id) {
        const { deleteTransaction } = await import('../../services/finance-tracker');
        deleteTransaction(ctx.from.id, cbData.txId);
        logger.info({ txId: cbData.txId }, 'Undid auto-logged finance transaction (not an invoice)');
      }
      await ctx.editMessageText('\u{1F504} Reprocessando como tarefa...');
      // Re-download image from Telegram (stored fileId instead of base64 to save memory)
      const { base64: reBase64, mediaType: reMT } = await downloadTelegramFile(bot, cbData.fileId);
      // Re-classify with task hint — if still not task, force conversion
      const reClassified = await classifyAndExtractImage(reBase64, reMT, (cbData.caption || '') + ' [TASK LIST]');
      if (reClassified.type === 'task') {
        await handleTaskExtraction(ctx as any, reClassified, cbData.caption || '');
      } else if (reClassified.type === 'calendar') {
        // Force calendar events into task format
        await handleTaskExtraction(ctx as any,
          { type: 'task', title: 'Items from image', subtasks: reClassified.events.map(e => e.title) },
          cbData.caption || '');
      } else {
        await handleTaskExtraction(ctx as any,
          { type: 'task', title: reClassified.vendor || 'Document', subtasks: [] },
          cbData.caption || '');
      }
    }
  });
}

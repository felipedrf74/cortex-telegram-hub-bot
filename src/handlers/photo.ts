// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Photo/media message handlers — extracted from bot.ts Phase 2.
 *
 * Contains: handlePhotoMessage, handleInvoiceFiling,
 * handleCalendarExtraction, handleTaskExtraction, parseCaptionInfo.
 */

import { Context, InlineKeyboard } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { storeCallback } from '../utils/callback-store';
import { keywordMatch } from '../router';
import { DomainName } from '../domains/types';
import { lastActiveDomain, pendingCalendarRef, isHtmlParseError } from './shared-state';
import { classifyAndExtractImage, ImageInvoiceResult, ImageCalendarResult, ImageTaskResult } from '../services/anthropic';
import { InvoiceAnalysis, fileInvoice, isInvoiceFilingConfigured } from '../services/invoice-filer';
import { addTransaction, parseReceiptAmount } from '../services/finance-tracker';
import { enqueueInvoice, getPendingCount } from '../services/invoice-queue';
import { recordFiling } from '../state/invoice-filings';
import { getEvents, createEvent as createCalendarEvent, isAnyCalendarConfigured } from '../services/unified-calendar';
import { getCategoryNameForColor } from '../services/outlook-calendar';
import { splitMessage, escapeHtml } from '../utils/telegram-formatter';
import { formatTime } from '../utils/date-parser';
import { resolveCanonicalUserId } from '../services/user-service';
import { getTaskProviderForUser } from '../services/task-store/task-router';

// ── Types ─────���───────────────────────────────────────────────────

/** Domain handler function signature (matches DOMAIN_HANDLERS in bot.ts) */
export type DomainHandlerFn = (message: string, userId?: number) => Promise<{ text: string; domain: DomainName }>;

interface CalendarCaptionInfo {
  categories: string[];
  prefix: string;     // "SMS - ", "EC - ", or ""
  label: string;      // "SMS", "EC", or "Pessoal"
}

// ── Caption Parsing ───────────────────────────────────────────────

/**
 * Resolves caption keywords to Outlook category names by querying
 * the user's master categories (cached after first fetch).
 * SMS → blue preset, EC → green preset, default → red preset.
 */
async function parseCaptionInfo(caption: string): Promise<CalendarCaptionInfo> {
  if (caption) {
    const upper = caption.toUpperCase().trim();
    if (upper.includes('SMS')) {
      const cat = await getCategoryNameForColor('blue');
      return { categories: [cat], prefix: 'SMS - ', label: 'SMS' };
    }
    if (upper.includes('EC')) {
      const cat = await getCategoryNameForColor('green');
      return { categories: [cat], prefix: 'EC - ', label: 'EC' };
    }
  }
  const cat = await getCategoryNameForColor('red');
  return { categories: [cat], prefix: '', label: 'Pessoal' };
}

// ── Photo Message Router ─────────���────────────────────────────────

/**
 * Main photo message handler — classifies the image and routes to
 * invoice filing, calendar extraction, or task extraction.
 *
 * @param domainHandlers - The DOMAIN_HANDLERS map from bot.ts (injected to avoid circular deps)
 */
export async function handlePhotoMessage(
  ctx: Context,
  domainHandlers: Record<string, DomainHandlerFn>,
): Promise<void> {
  try {
    await ctx.replyWithChatAction('typing');
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    const caption = ctx.message?.caption || '';
    const userId = ctx.from?.id;

    // ── Branch 1: Caption explicitly targets a non-secretary domain ──
    if (caption) {
      const domainFromCaption = keywordMatch(caption) as DomainName | null;

      if (domainFromCaption && domainFromCaption !== 'secretary') {
        const handler = domainHandlers[domainFromCaption];
        const photoContext = `[Photo attached] ${caption}`;
        const response = await handler(photoContext, userId);
        if (userId) lastActiveDomain.set(userId, { domain: domainFromCaption, timestamp: Date.now() });
        const parts = splitMessage(response.text);
        for (const part of parts) {
          try {
            await ctx.reply(part, { parse_mode: 'HTML' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(part.replace(/<[^>]*>/g, ''));
            else throw err;
          }
        }
        return;
      }
    }

    // ── Download image ──
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    // SECURITY: fileUrl contains bot token — never log this variable
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    logger.debug({ filePath: file.file_path }, 'Downloading Telegram file');

    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString('base64');
    const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'jpg';
    const mediaType = (
      ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    ) as 'image/jpeg' | 'image/png' | 'image/webp';

    // ── Branch 2: Unified image classification ──
    const classification = await classifyAndExtractImage(base64, mediaType as any, caption || undefined);

    switch (classification.type) {
      case 'invoice':
        await handleInvoiceFiling(ctx, buffer, mediaType, classification, photo.file_id, caption);
        break;

      case 'calendar':
        await handleCalendarExtraction(ctx, classification, caption, photo.file_id, mediaType);
        break;

      case 'task':
        await handleTaskExtraction(ctx, classification, caption);
        break;

      default:
        await ctx.reply('📷 Não foi possível classificar esta imagem. Tente adicionar uma legenda.');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to process photo message');
    await ctx.reply('⚠️ Falha ao processar a imagem. Tente novamente.');
  }
}

// ── Invoice Filing ────────────────────────────────────────────────

export async function handleInvoiceFiling(
  ctx: Context,
  buffer: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  analysis: ImageInvoiceResult,
  fileId: string,
  caption: string,
): Promise<void> {
  const telegramUserId = ctx.from?.id;
  const canonicalUserId = telegramUserId ? resolveCanonicalUserId(telegramUserId) : null;

  if (!isInvoiceFilingConfigured() || analysis.confidence < config.invoices.minConfidence) {
    logger.info({ confidence: analysis.confidence }, 'Invoice detected but low confidence or filing not configured');
    await handleTaskExtraction(ctx, { type: 'task', title: analysis.vendor || 'Document', subtasks: [] }, caption);
    return;
  }

  logger.info(
    { vendor: analysis.vendor, date: analysis.documentDate, confidence: analysis.confidence },
    'Invoice detected — filing via SCP',
  );

  const invoiceAnalysis: InvoiceAnalysis = {
    isInvoice: true,
    confidence: analysis.confidence,
    documentDate: analysis.documentDate,
    documentDateRaw: analysis.documentDateRaw,
    vendor: analysis.vendor,
    totalAmount: analysis.totalAmount,
    invoiceNumber: analysis.invoiceNumber,
  };

  const filingResult = await fileInvoice(buffer, mediaType, invoiceAnalysis);

  if (filingResult.success) {
    if (!canonicalUserId) {
      logger.error({ telegramUserId }, 'Invoice filing succeeded but no canonical user ID was resolved');
      await ctx.reply('⚠️ Nota fiscal detectada, mas não foi possível associá-la à tua conta.');
      return;
    }

    recordFiling({
      vendor: analysis.vendor || 'Unknown',
      amount: analysis.totalAmount,
      document_date: analysis.documentDate,
      invoice_number: analysis.invoiceNumber,
      source: 'photo',
      source_ref: 'telegram_photo',
      remote_path: filingResult.filePath,
      folder_path: filingResult.folderPath,
      filename: filingResult.filename,
      file_size_bytes: filingResult.originalSizeKB ? filingResult.originalSizeKB * 1024 : null,
      compressed_size_bytes: filingResult.compressedSizeKB ? filingResult.compressedSizeKB * 1024 : null,
      status: 'filed',
      user_id: canonicalUserId,
    });

    // Auto-log receipt as finance expense transaction
    const parsedAmount = parseReceiptAmount(analysis.totalAmount);
    let txId: number | null = null;

    if (canonicalUserId && parsedAmount) {
      const txDate = analysis.documentDate || new Date().toISOString().split('T')[0];
      const tx = addTransaction(canonicalUserId, txDate, 'expense', parsedAmount, {
        subcategory: 'receipt',
        description: analysis.vendor ? `Receipt: ${analysis.vendor}` : 'Receipt from photo',
        receiptRef: filingResult.filename || undefined,
      });
      txId = tx.id;
      logger.info({ userId: canonicalUserId, amount: parsedAmount, vendor: analysis.vendor }, 'Receipt auto-logged as finance transaction');
    }

    let msg = `🧾 <b>Nota fiscal arquivada!</b>\n\n`;
    if (analysis.vendor) msg += `🏢 ${escapeHtml(analysis.vendor)}\n`;
    if (analysis.documentDateRaw) msg += `���� ${escapeHtml(analysis.documentDateRaw)}\n`;
    if (analysis.totalAmount) msg += `💰 ${escapeHtml(analysis.totalAmount)}\n`;
    if (analysis.invoiceNumber) msg += `🔢 ${escapeHtml(analysis.invoiceNumber)}\n`;
    msg += `\n📁 <code>${escapeHtml(filingResult.folderPath!)}</code>`;
    msg += `\n📄 <code>${escapeHtml(filingResult.filename!)}</code>`;

    if (filingResult.originalSizeKB && filingResult.compressedSizeKB && filingResult.originalSizeKB !== filingResult.compressedSizeKB) {
      const savings = Math.round((1 - filingResult.compressedSizeKB / filingResult.originalSizeKB) * 100);
      msg += `\n📦 ${filingResult.originalSizeKB}KB → ${filingResult.compressedSizeKB}KB (-${savings}%)`;
    }

    if (txId && parsedAmount) {
      msg += `\n\n💳 <b>Despesa registrada:</b> R$ ${parsedAmount.toFixed(2)}`;
    }

    const ref = storeCallback({ fileId, caption, txId });
    const keyboard = new InlineKeyboard()
      .text('�� Não é nota fiscal', `nf:undo:${ref}`);

    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
    return;
  }

  // Filing failed — check if SSH/connectivity issue and queue for retry
  const isSshError = filingResult.error && (
    filingResult.error.includes('Connection') ||
    filingResult.error.includes('timed out') ||
    filingResult.error.includes('No route') ||
    filingResult.error.includes('Connection refused') ||
    filingResult.error.includes('Host is down') ||
    filingResult.error.includes('Permission denied') ||
    filingResult.error.includes('ssh') ||
    filingResult.error.includes('scp')
  );

  if (isSshError) {
    logger.warn({ error: filingResult.error }, 'Invoice filing failed (SSH) — queuing for retry');
    if (!canonicalUserId) {
      await ctx.reply('⚠️ Nota fiscal detectada, mas não foi possível colocá-la em fila para a tua conta.');
      return;
    }
    const queueId = enqueueInvoice(
      buffer,
      'image',
      mediaType,
      JSON.stringify(invoiceAnalysis),
      'photo',
      canonicalUserId,
    );
    const pendingCount = getPendingCount();

    let msg = `📥 <b>Nota fiscal na fila de envio</b>\n\n`;
    msg += `O Mac parece estar indisponível (a dormir ou sem túnel SSH).\n`;
    msg += `A fatura foi guardada localmente e será enviada automaticamente quando a ligação voltar.\n\n`;
    if (analysis.vendor) msg += `🏢 ${escapeHtml(analysis.vendor)}\n`;
    if (analysis.totalAmount) msg += `💰 ${escapeHtml(analysis.totalAmount)}\n`;
    if (analysis.documentDateRaw) msg += `📅 ${escapeHtml(analysis.documentDateRaw)}\n`;
    msg += `\n🔄 Fila: ${pendingCount} fatura${pendingCount > 1 ? 's' : ''} pendente${pendingCount > 1 ? 's' : ''}`;
    msg += `\n⏱️ Tentativa automática a cada 15 minutos`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
    return;
  }

  logger.error({ error: filingResult.error }, 'Invoice filing failed');
  await ctx.reply(
    `⚠️ Nota fiscal detectada mas falhou ao arquivar: ${escapeHtml(filingResult.error || 'Erro desconhecido')}`,
    { parse_mode: 'HTML' },
  );
}

// ── Calendar Extraction ───────────────────────────────────────────

export async function handleCalendarExtraction(
  ctx: Context,
  result: ImageCalendarResult,
  caption: string,
  fileId: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
): Promise<void> {
  if (!isAnyCalendarConfigured()) {
    await ctx.reply('📅 Conteúdo de calendário detectado, mas nenhum calendário está configurado.');
    return;
  }

  if (!result.events || result.events.length === 0) {
    await ctx.reply('📅 Parece ser um calendário, mas não foi possível extrair eventos. Tente com uma imagem mais clara.');
    return;
  }

  const info = await parseCaptionInfo(caption);

  // Shift past events forward to next occurrence of same weekday
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const allInPast = result.events.every((e) => new Date(e.start) < todayStart);
  if (allInPast && result.events.length > 0) {
    const earliest = new Date(Math.min(...result.events.map((e) => new Date(e.start).getTime())));
    const daysDiff = Math.ceil((todayStart.getTime() - earliest.getTime()) / (24 * 60 * 60 * 1000));
    const weeksToShift = Math.ceil(daysDiff / 7);
    const msShift = weeksToShift * 7 * 24 * 60 * 60 * 1000;
    logger.info({ weeksShifted: weeksToShift, originalStart: earliest.toISOString() },
      'Calendar events are in the past — shifting forward to preserve weekdays');
    for (const e of result.events) {
      e.start = new Date(new Date(e.start).getTime() + msShift).toISOString().replace('Z', '').split('.')[0];
      e.end = new Date(new Date(e.end).getTime() + msShift).toISOString().replace('Z', '').split('.')[0];
    }
  }

  // Apply prefix to event titles
  const prefixedEvents = result.events.map((e) => ({
    ...e,
    title: info.prefix ? `${info.prefix}${e.title}` : e.title,
  }));

  // Fetch existing events for conflict detection
  const starts = prefixedEvents.map((e) => new Date(e.start).getTime());
  const ends = prefixedEvents.map((e) => new Date(e.end).getTime());
  const rangeStart = new Date(Math.min(...starts));
  const rangeEnd = new Date(Math.max(...ends));
  rangeEnd.setDate(rangeEnd.getDate() + 1);

  let existingEvents: { summary: string; start: string; end: string }[] = [];
  try {
    existingEvents = await getEvents(rangeStart.toISOString(), rangeEnd.toISOString());
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch existing calendar events for conflict check');
  }

  // Detect conflicts (overlapping time slots)
  interface Conflict {
    newEvent: string;
    newTime: string;
    existingEvent: string;
    existingTime: string;
  }
  const conflicts: Conflict[] = [];

  for (const newEvt of prefixedEvents) {
    const nStart = new Date(newEvt.start).getTime();
    const nEnd = new Date(newEvt.end).getTime();

    for (const existing of existingEvents) {
      const eStart = new Date(existing.start).getTime();
      const eEnd = new Date(existing.end).getTime();

      if (nStart < eEnd && nEnd > eStart) {
        conflicts.push({
          newEvent: newEvt.title,
          newTime: `${formatTime(newEvt.start)}-${formatTime(newEvt.end)}`,
          existingEvent: existing.summary,
          existingTime: `${formatTime(existing.start)}-${formatTime(existing.end)}`,
        });
      }
    }
  }

  // Build preview message
  let msg = `��� <b>${prefixedEvents.length} evento${prefixedEvents.length > 1 ? 's' : ''} detectado${prefixedEvents.length > 1 ? 's' : ''} (${escapeHtml(info.label)}):</b>\n`;
  for (const evt of prefixedEvents) {
    const day = new Date(evt.start).toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric' });
    msg += `\n  📌 ${escapeHtml(evt.title)} — ${day} ${formatTime(evt.start)}-${formatTime(evt.end)}`;
  }

  msg += `\n\n🏷️ Categoria: <b>${escapeHtml(info.categories[0])}</b>`;

  if (conflicts.length > 0) {
    msg += `\n\n⚠️ <b>${conflicts.length} conflito${conflicts.length > 1 ? 's' : ''} com eventos existentes:</b>`;
    const shown = new Set<string>();
    for (const c of conflicts) {
      const key = `${c.newEvent}|${c.existingEvent}`;
      if (shown.has(key)) continue;
      shown.add(key);
      msg += `\n  🔴 <b>${escapeHtml(c.newEvent)}</b> (${c.newTime}) ↔ <b>${escapeHtml(c.existingEvent)}</b> (${c.existingTime})`;
      if (shown.size >= 15) { msg += '\n  ...'; break; }
    }
  } else {
    msg += '\n\n✅ Sem conflitos com eventos existentes.';
  }

  // Store pending events and show confirmation buttons
  const ref = storeCallback({
    events: prefixedEvents,
    categories: info.categories,
    fileId,
    caption,
  }, 10 * 60 * 1000);

  const calUserId = ctx.from?.id;
  if (calUserId) pendingCalendarRef.set(calUserId, { ref, timestamp: Date.now() });

  const keyboard = new InlineKeyboard()
    .text(`✅ Criar ${prefixedEvents.length} evento${prefixedEvents.length > 1 ? 's' : ''}`, `cal:create:${ref}`)
    .text('❌ Cancelar', `cal:cancel:${ref}`)
    .row()
    .text('🔄 Não é calendário', `cal:undo:${ref}`);

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ── Task Extraction ───────────��──────────────────────────────────��

export async function handleTaskExtraction(
  ctx: Context,
  extracted: ImageTaskResult,
  caption: string,
): Promise<void> {
  const telegramUserId = ctx.from?.id;
  const userId = telegramUserId ? resolveCanonicalUserId(telegramUserId) : null;
  if (userId == null) {
    await ctx.reply('📷 Foto recebida, mas o provedor de tarefas não está disponível para este utilizador.');
    return;
  }

  if (!extracted.title) {
    await ctx.reply('📷 Não foi possível extrair tarefas desta imagem. Tente adicionar uma legenda.');
    return;
  }

  const taskProvider = getTaskProviderForUser(userId);

  let targetList: { id: string; displayName: string } | null = null;
  if (extracted.listHint) targetList = await taskProvider.findListByName(extracted.listHint);
  if (!targetList) targetList = await taskProvider.getDefaultList();
  if (!targetList) {
    const lists = await taskProvider.getLists();
    if (lists.success && lists.data.length > 0) targetList = lists.data[0];
  }
  if (!targetList) {
    await ctx.reply('⚠️ Nenhuma lista de tarefas encontrada.');
    return;
  }

  const taskResult = await taskProvider.createTask(targetList.id, targetList.displayName, {
    title: extracted.title,
  });
  if (!taskResult.success) {
    await ctx.reply(`⚠️ Falha ao criar tarefa: ${taskResult.error}`);
    return;
  }

  let addedSubtasks = 0;
  if (extracted.subtasks.length > 0) {
    const subResults = await Promise.all(
      extracted.subtasks.map((sub) => taskProvider.addChecklistItem(targetList!.id, taskResult.data.id, sub)),
    );
    addedSubtasks = subResults.filter((r) => r.success).length;
  }

  let msg = `📷✅ Tarefa criada da imagem:\n\n<b>${escapeHtml(extracted.title)}</b>\n📋 ${escapeHtml(targetList.displayName)}`;
  if (addedSubtasks > 0) {
    msg += `\n\n📝 ${addedSubtasks} subtarefa${addedSubtasks > 1 ? 's' : ''}:`;
    for (const sub of extracted.subtasks.slice(0, addedSubtasks)) {
      msg += `\n  ⬜ ${escapeHtml(sub)}`;
    }
  }
  await ctx.reply(msg, { parse_mode: 'HTML' });
}

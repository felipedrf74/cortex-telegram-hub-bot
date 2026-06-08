// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Finance routes — token-zero CRUD over the finance-tracker service.
 *
 * Thin HTTP layer over `src/services/finance-tracker.ts`. Exposes
 * transactions, monthly summaries, and Portugal tax estimate tracking
 * for the iOS Finance skill landing page.
 *
 * Mount point: `/api/v1/finance`
 *
 * Endpoints:
 *   GET    /transactions?from=&to=&category=&limit=  — list transactions
 *   POST   /transactions                              — add a transaction
 *   DELETE /transactions/:id                          — remove one
 *   GET    /monthly-summary?month=YYYY-MM             — monthly aggregates
 *   GET    /tax/events?year=                          — list tax events
 *   POST   /tax/calculate                             — compute + persist
 *                                                       this month's tax
 *
 * Part of TASK-14 Phase 1 (foundation). Real iOS UI ships in follow-up
 * sessions; this file exists so the iOS FinanceService + Repository
 * have something to call.
 */

import { createHash } from 'node:crypto';
import { Router, type Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { emitDomainEvent, runOutboxTransaction } from '../../services/event-outbox';
import { consumeResourceBudget } from '../../services/resource-budgets';
import { invalidateFinanceDerivedCaches } from '../../services/cache-coherence-registry';
import { config } from '../../config';
import {
  addTransaction,
  getTransactions,
  deleteTransaction,
  getMonthlyBudgetView,
  getMonthlySummary,
  getPreferredCurrencyForUser,
  getTaxEvents,
  getAnnualTaxSummary,
  calculateAndStoreTax,
  calculatePortugueseMonthlyTax,
  markTaxPaid,
  normalizeFinanceCategory,
  updateTransaction,
} from '../../services/finance-tracker';
import { acquireCostLock, enforceCostGuardrails } from '../../services/cost-guardrail';
import { analyzeInvoiceImage, fileInvoice } from '../../services/invoice-filer';
import { getFilingById, recordFiling } from '../../state/invoice-filings';
import { verifyInvoiceObjectChecksum } from '../../services/invoice-object-storage';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import { createNotificationIntent } from '../../services/notification-orchestrator';
import { centsToNumber, parseUserAmount, toCents } from '../../services/money';
import {
  buildFinanceSchedulingIntent,
  previewFinanceSchedulingIntent,
  submitFinanceSchedulingIntent,
} from '../../services/finance-secretary-integration';
import { loadLiveCalendarBusyWindowsForSecretaryIntent } from '../../services/secretary-live-calendar-busy';
import { assertTenantScope, TenantScopeError } from '../../services/tenant-scope';

function requireFinanceHandlerScope(req: Request, operation: string): { userId: number; tenantId: number } {
  return assertTenantScope(req as AuthenticatedRequest, operation);
}

export function financeRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const authReq = req as AuthenticatedRequest;
    const { userId } = authReq;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'finance_route', {
      method: req.method,
      path: req.path,
    })) return;
    try {
      assertTenantScope(authReq, 'finance_route');
    } catch (err) {
      if (err instanceof TenantScopeError) {
        sendError(res as Response, err.code, err.message, err.status);
        return;
      }
      throw err;
    }
    next();
  });

  // ── Transactions ───────────────────────────────────────────────────

  /**
   * GET /api/v1/finance/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&category=&limit=
   * Returns transactions for the authenticated user, newest first.
   */
  router.get('/transactions', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');

    const startDate = typeof req.query.from === 'string' ? req.query.from : undefined;
    const endDate = typeof req.query.to === 'string' ? req.query.to : undefined;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 50, 200)
      : 50;

    try {
      const txs = getTransactions(userId, { startDate, endDate, category, limit, tenantId });
      sendSuccess(res, { transactions: txs, count: txs.length });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS finance transactions list failed');
      sendInternalError(res, 'Failed to fetch transactions');
    }
  }));

  /**
   * POST /api/v1/finance/transactions
   * Body: { date, category, amount, subcategory?, description?, currency?, receiptRef? }
   */
  router.post('/transactions', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');
    const { date, category, amount, amount_cents: amountCentsSnake, amountCents, subcategory, description, currency, receiptRef } = req.body;

    if (!date || typeof date !== 'string') {
      sendError(res, 'BAD_REQUEST', 'date is required (YYYY-MM-DD)');
      return;
    }
    if (!category || typeof category !== 'string') {
      sendError(res, 'BAD_REQUEST', 'category is required');
      return;
    }
    try {
      normalizeFinanceCategory(category);
    } catch {
      sendError(res, 'BAD_REQUEST', 'unsupported finance transaction category');
      return;
    }
    const resolvedAmount = resolveFinanceRouteAmount(amount, amountCentsSnake ?? amountCents);
    if (resolvedAmount == null) {
      sendError(res, 'BAD_REQUEST', 'amount or amount_cents must be a finite money value');
      return;
    }
    if (resolvedAmount < 0) {
      sendError(res, 'BAD_REQUEST', 'amount must be non-negative');
      return;
    }
    if (!consumeFinanceWriteBudget(res, tenantId, userId, 'finance_transaction_create')) return;

    try {
      const writeTransaction = () => addTransaction(userId, date, category, resolvedAmount, {
        subcategory,
        description,
        currency,
        receiptRef,
        tenantId,
      });
      const tx = runOutboxTransaction((emitDomainEvent) => {
        const created = writeTransaction();
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'finance',
          eventType: 'finance.expense.created',
          entityType: 'finance_transaction',
          entityId: created.id,
          payload: {
            summary: { currency: created.currency },
            action: 'created',
          },
          privacyClassification: 'financial',
          idempotencyKey: `finance.expense.created:${tenantId}:${userId}:${created.id}`,
        });
        return created;
      });
      invalidateFinanceDerivedCaches(userId);
      logger.info({ userId, txId: tx.id }, 'iOS transaction added');
      sendSuccess(res, { transaction: tx }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS finance transaction create failed');
      sendInternalError(res, 'Failed to add transaction');
    }
  }));

  /**
   * PATCH /api/v1/finance/transactions/:id
   * Partial update — only the fields present in the body are written.
   * Scoped to the caller's user_id so cross-user writes return 404.
   */
  router.patch('/transactions/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');
    const txId = parseInt(req.params.id, 10);
    const { date, category, subcategory, amount, amount_cents: amountCentsSnake, amountCents, currency, description, receiptRef } = req.body;

    if (Number.isNaN(txId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    // Reject completely-empty bodies.
    if (date === undefined && category === undefined && subcategory === undefined
        && amount === undefined && amountCentsSnake === undefined && amountCents === undefined && currency === undefined && description === undefined
        && receiptRef === undefined) {
      sendError(res, 'BAD_REQUEST', 'At least one field must be provided');
      return;
    }

    // Per-field validation.
    if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      sendError(res, 'BAD_REQUEST', 'date must be YYYY-MM-DD');
      return;
    }
    if (category !== undefined && (typeof category !== 'string' || !category.trim())) {
      sendError(res, 'BAD_REQUEST', 'category must be a non-empty string');
      return;
    }
    let normalizedCategory: string | undefined;
    if (category !== undefined) {
      try {
        normalizedCategory = normalizeFinanceCategory(category);
      } catch {
        sendError(res, 'BAD_REQUEST', 'unsupported finance transaction category');
        return;
      }
    }
    const resolvedAmount = amount !== undefined || amountCentsSnake !== undefined || amountCents !== undefined
      ? resolveFinanceRouteAmount(amount, amountCentsSnake ?? amountCents)
      : undefined;
    if (resolvedAmount === null) {
      sendError(res, 'BAD_REQUEST', 'amount or amount_cents must be a finite money value');
      return;
    }
    if (resolvedAmount !== undefined && resolvedAmount < 0) {
      sendError(res, 'BAD_REQUEST', 'amount must be non-negative');
      return;
    }
    if (!consumeFinanceWriteBudget(res, tenantId, userId, 'finance_transaction_update')) return;

    try {
      const updated = runOutboxTransaction((emitDomainEvent) => {
        const row = updateTransaction(userId, txId, {
          date,
          category: normalizedCategory,
          subcategory,
          amount: resolvedAmount,
          currency,
          description,
          receiptRef,
        }, { tenantId });
        if (!row) return null;
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'finance',
          eventType: 'finance.expense.updated',
          entityType: 'finance_transaction',
          entityId: txId,
          payload: {
            summary: { currency: row.currency },
            action: 'updated',
          },
          privacyClassification: 'financial',
          idempotencyKey: `finance.expense.updated:${tenantId}:${userId}:${txId}:${stableMutationFingerprint(req.body ?? {})}`,
        });
        return row;
      });

      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Transaction not found or not owned by user', 404);
        return;
      }

      invalidateFinanceDerivedCaches(userId);
      logger.info({ userId, txId }, 'iOS finance transaction updated');
      sendSuccess(res, { transaction: updated });
    } catch (err: any) {
      logger.error({ err, userId, txId }, 'iOS finance transaction update failed');
      sendInternalError(res, 'Failed to update transaction');
    }
  }));

  /**
   * DELETE /api/v1/finance/transactions/:id
   */
  router.delete('/transactions/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');
    const txId = parseInt(req.params.id, 10);

    if (Number.isNaN(txId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }
    if (!consumeFinanceWriteBudget(res, tenantId, userId, 'finance_transaction_delete')) return;

    try {
      const writeDelete = () => deleteTransaction(userId, txId);
      const deleted = runOutboxTransaction((emitDomainEvent) => {
        const didDelete = writeDelete();
        if (!didDelete) return false;
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'finance',
          eventType: 'finance.expense.deleted',
          entityType: 'finance_transaction',
          entityId: txId,
          payload: {
            summary: { deleted: true },
            action: 'deleted',
          },
          privacyClassification: 'financial',
          idempotencyKey: `finance.expense.deleted:${tenantId}:${userId}:${txId}`,
        });
        return true;
      });
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Transaction not found or not owned by user', 404);
        return;
      }
      invalidateFinanceDerivedCaches(userId);
      sendSuccess(res, { deleted: true, id: txId });
    } catch (err: any) {
      logger.error({ err, userId, txId }, 'iOS finance transaction delete failed');
      sendInternalError(res, 'Failed to delete transaction');
    }
  }));

  // ── Monthly Summary ────────────────────────────────────────────────

  /**
   * GET /api/v1/finance/monthly-summary?month=YYYY-MM
   * Returns aggregated totals (income, expenses, net) for the month.
   * If month is omitted, defaults to the current month.
   */
  router.get('/monthly-summary', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');
    let month = typeof req.query.month === 'string' ? req.query.month : undefined;

    if (!month) {
      // Default to the current month in YYYY-MM
      const now = new Date();
      month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    if (!/^\d{4}-\d{2}$/.test(month)) {
      sendError(res, 'BAD_REQUEST', 'month must be YYYY-MM');
      return;
    }

    try {
      const summary = getMonthlySummary(userId, month, { tenantId });
      const budgetView = getMonthlyBudgetView(userId, month, { tenantId });
      const preferredCurrency = getPreferredCurrencyForUser(userId);

      // Precompute the Portugal tax estimate so the iOS KPI card can show it
      // without a second round-trip. Uses the same sourced ruleset the backend
      // persists via calculateAndStoreTax.
      const taxBreakdown = summary.mixedCurrency
        ? null
        : calculatePortugueseMonthlyTax(summary.totalIncome, summary.totalDeductions);
      const warnings = summary.mixedCurrency ? ['MIXED_CURRENCY_TAX_PREVIEW_SUPPRESSED'] : [];

      sendSuccess(res, { summary, budgetView, tax: taxBreakdown, warnings, preferredCurrency });
    } catch (err: any) {
      logger.error({ err, userId, month }, 'iOS finance monthly-summary failed');
      sendInternalError(res, 'Failed to fetch monthly summary');
    }
  }));

  // ── Tax Events ─────────────────────────────────────────────────────

  /**
   * GET /api/v1/finance/tax/events?year=&limit=
   * Returns the user's persisted tax events (Portugal estimate runs).
   */
  router.get('/tax/events', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');
    const year = req.query.year ? parseInt(String(req.query.year), 10) : undefined;
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 12, 60)
      : 12;

    try {
      const events = getTaxEvents(userId, { year, limit, tenantId });
      sendSuccess(res, { events, count: events.length });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS finance tax events list failed');
      sendInternalError(res, 'Failed to fetch tax events');
    }
  }));

  /**
   * GET /api/v1/finance/tax/annual-summary?year=
   * Aggregated annual Portugal tax view and payment tracking.
   */
  router.get('/tax/annual-summary', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');
    const currentYear = new Date().getFullYear();
    const year = req.query.year
      ? parseInt(String(req.query.year), 10)
      : currentYear;

    if (!Number.isInteger(year) || year < 2000 || year > currentYear + 1) {
      sendError(res, 'BAD_REQUEST', 'year must be a valid YYYY value');
      return;
    }

    try {
      const summary = getAnnualTaxSummary(userId, year, { tenantId });
      sendSuccess(res, { summary });
    } catch (err: any) {
      logger.error({ err, userId, year }, 'iOS finance annual tax summary failed');
      sendInternalError(res, 'Failed to fetch annual tax summary');
    }
  }));

  /**
   * POST /api/v1/finance/tax/calculate
   * Body: { month?: YYYY-MM }
   * Runs calculateAndStoreTax for the given month (defaults to current).
   */
  router.post('/tax/calculate', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');
    let { month } = req.body;

    if (!month) {
      const now = new Date();
      month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    if (!/^\d{4}-\d{2}$/.test(String(month))) {
      sendError(res, 'BAD_REQUEST', 'month must be YYYY-MM');
      return;
    }

    try {
      const event = calculateAndStoreTax(userId, month, { tenantId });
      invalidateFinanceDerivedCaches(userId);
      if (event.status !== 'paid' && (event.tax_due > 0 || event.inss_due > 0)) {
        const reminderWindow = financeTaxReminderWindow(String(month));
        if (reminderWindow) {
          try {
            const secretaryInput = {
              userId,
              tenantId,
              kind: 'bill_reminder' as const,
              entityId: month,
              title: `Review tax payment for ${month}`,
              deadline: reminderWindow.end,
              preferredWindows: [reminderWindow],
              durationMinutes: 15,
              priority: 'high' as const,
              context: 'Finance tax calculation created a payment reminder candidate. Amount details remain in Finance.',
            };
            const busyWindows = await loadLiveCalendarBusyWindowsForSecretaryIntent(
              buildFinanceSchedulingIntent(secretaryInput),
            );
            if (busyWindows.degraded) {
              throw new Error('FINANCE_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED');
            }
            const secretaryInputWithBusyWindows = { ...secretaryInput, additionalBusyWindows: busyWindows.windows };
            const preview = previewFinanceSchedulingIntent(secretaryInputWithBusyWindows);
            if (['scheduled', 'reflowed', 'compressed'].includes(preview.status) && preview.recommendedSlot) {
              submitFinanceSchedulingIntent(secretaryInputWithBusyWindows);
            } else if (!busyWindows.providerConfigured) {
              submitFinanceSchedulingIntent(secretaryInputWithBusyWindows);
            } else {
              logger.warn(
                { userId, tenantId, month, status: preview.status, reasonCodes: preview.reasonCodes },
                'Finance tax reminder was not placed by Secretary preview',
              );
            }
          } catch (secretaryErr) {
            logger.warn({ err: secretaryErr, userId, tenantId, month }, 'Finance Secretary reminder scheduling failed');
          }
        }
        try {
          const decisionDeadline = reminderWindow?.end ?? null;
          await createNotificationIntent({
            userId,
            tenantId,
            sourceSkill: 'finance',
            type: 'reminder',
            priority: 'time_sensitive',
            relatedEntityId: month,
            relatedEntityType: 'tax_event',
            title: 'Finance deadline',
            body: 'Tax payment reminder is ready.',
            sensitiveBody: `Tax event ${month}: tax and contribution amounts are available in Finance.`,
            actionButtons: [
              { id: 'mark_paid', label: 'Mark paid', style: 'primary' },
              { id: 'open_detail', label: 'Open', style: 'secondary' },
            ],
            deeplink: `nexus://finance/reminder/${encodeURIComponent(String(month))}`,
            dedupeKey: `finance:tax-event:${userId}:${month}`,
            requiresUserAction: true,
            decisionDeadline,
            decisionContext: {
              entityTitle: `Tax payment for ${month}`,
              sourceState: 'payment_due',
              deadlineAt: decisionDeadline,
            },
            privacyPolicy: 'financial',
          });
        } catch (notificationErr) {
          logger.warn({ err: notificationErr, userId, month }, 'Finance notification intent emit failed');
        }
      }
      logger.info({ userId, month }, 'iOS tax event calculated');
      sendSuccess(res, { event });
    } catch (err: any) {
      logger.error({ err, userId, month }, 'iOS finance tax calculate failed');
      sendInternalError(res, 'Failed to calculate tax');
    }
  }));

  /**
   * POST /api/v1/finance/tax/events/:month/pay
   * Marks a persisted monthly tax event as paid.
   */
  router.post('/tax/events/:month/pay', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance_handler');
    const { month } = req.params;

    if (!/^\d{4}-\d{2}$/.test(String(month))) {
      sendError(res, 'BAD_REQUEST', 'month must be YYYY-MM');
      return;
    }

    try {
      const updated = markTaxPaid(userId, month, { tenantId });
      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Tax event not found for the requested month', 404);
        return;
      }

      const event = getTaxEvents(userId, { year: parseInt(String(month).slice(0, 4), 10), limit: 24, tenantId })
        .find((candidate) => candidate.month === month);

      if (!event) {
        sendInternalError(res, 'Tax event updated but could not be reloaded');
        return;
      }
      invalidateFinanceDerivedCaches(userId);

      logger.info({ userId, month }, 'iOS tax event marked paid');
      sendSuccess(res, { updated: true, event });
    } catch (err: any) {
      logger.error({ err, userId, month }, 'iOS finance tax pay failed');
      sendInternalError(res, 'Failed to mark tax event as paid');
    }
  }));

  // ────────────────────────────────────────────────────────────────
  // Receipt parsing via vision models (TASK-14 Phase 4)
  //
  // The iOS Finance tab's capture-expense flow tries on-device
  // Vision OCR + heuristic parsing first (free, zero tokens) and
  // now calls this endpoint automatically after the on-device heuristic
  // pass. The local OCR result is still sent as a hint, but the server-side
  // model is now the primary extractor so the output matches the bot flow.
  //
  // Anthropic Haiku is the primary provider because it has proven more
  // reliable on invoices/receipts in production. Gemini/OpenAI remain
  // automatic fallbacks through `analyzeInvoiceImage`.
  //
  // Cost cap: the endpoint reuses the per-user daily USD cap from
  // cost-guardrail.ts (isUserOverDailyCap). A single Gemini Flash
  // vision call is ~$0.0001 so the cap is more of a belt-and-
  // suspenders safety net than a real constraint.
  // ────────────────────────────────────────────────────────────────

  /**
   * POST /api/v1/finance/parse-receipt
   * Body: {
   *   imageBase64: string,      // base64-encoded JPEG or PNG
   *   mimeType: string,         // "image/jpeg" or "image/png"
   *   ocrHint?: string,         // optional on-device OCR text as a hint
   * }
   *
   * Response: {
   *   parsed: {
   *     merchant: string | null,
   *     date: string | null,      // YYYY-MM-DD
   *     amount: number | null,
     *     currency: string,         // default "EUR" unless the user's profile says otherwise
   *     category: string | null,  // best-guess category
   *     confidence: number,       // 0-1, model confidence after server validation
   *   },
   *   tokensUsed: number,
   *   model: string,
   *   verificationNote?: string | null
   * }
   *
   * The iOS review sheet then lets the user edit any of the
   * parsed fields before they tap "Add transaction" — the final
   * POST /transactions call is separate from this parse call.
   */
  router.post('/parse-receipt', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId = userId } = req as AuthenticatedRequest;
    const { imageBase64, mimeType, ocrHint } = req.body;
    const normalizedOcrHint = typeof ocrHint === 'string' && ocrHint.trim().length > 0
      ? ocrHint.trim()
      : undefined;
    const ocrFallback = normalizedOcrHint
      ? parseReceiptFromOcrHint(normalizedOcrHint, userId)
      : null;
    const visionUnavailable = !config.anthropic.apiKey && !config.gemini.apiKey && !config.openai.apiKey;

    // ── Validation ────────────────────────────────────────────
    if ((!imageBase64 || typeof imageBase64 !== 'string') && !(visionUnavailable && normalizedOcrHint)) {
      sendError(res, 'BAD_REQUEST', 'imageBase64 is required and must be a string');
      return;
    }
    if ((!mimeType || typeof mimeType !== 'string') && !(visionUnavailable && normalizedOcrHint)) {
      sendError(res, 'BAD_REQUEST', 'mimeType is required (e.g. "image/jpeg")');
      return;
    }
    if (mimeType && !['image/jpeg', 'image/jpg', 'image/png', 'image/heic'].includes(mimeType.toLowerCase())) {
      sendError(res, 'BAD_REQUEST', 'mimeType must be image/jpeg, image/png, or image/heic');
      return;
    }

    // Reject oversized bodies early. Base64 is ~33% larger than raw bytes,
    // so the 6MB cap = ~4.5MB original image.
    const approxBytes = typeof imageBase64 === 'string' ? (imageBase64.length * 3) / 4 : 0;
    if (approxBytes > 6 * 1024 * 1024) {
      sendError(res, 'PAYLOAD_TOO_LARGE', 'Image exceeds 6MB. Compress before uploading.', 413);
      return;
    }

    // ── Provider availability ─────────────────────────────────
    if (visionUnavailable) {
      if (ocrFallback) {
        sendSuccess(res, {
          parsed: ocrFallback.parsed,
          verificationNote: ocrFallback.verificationNote,
          tokensUsed: 0,
          model: 'ocr_hint_fallback',
        });
        return;
      }

      sendError(
        res,
        'VISION_NOT_CONFIGURED',
        'No receipt vision provider is configured on this server. Fall back to manual entry.',
        503,
      );
      return;
    }

    // ── Cost cap (TOCTOU-safe) ────────────────────────────────
    // Per-user daily USD cap from cost-guardrail. Rejects before
    // the Gemini call so the user never gets charged past their
    // PER_USER_DAILY_USD_CAP. Since vision calls are cheap
    // (~$0.0001 each), the cap is mostly a stuck-retry-loop guard.
    // Acquire the per-user lock so concurrent parse-receipt calls
    // from the same user can't both pass the cap check.
    const releaseCostLock = await acquireCostLock(userId);
    const guardrail = enforceCostGuardrails(userId);
    if (guardrail.block) {
      releaseCostLock();
      logger.warn(
        {
          userId,
          reason: guardrail.reason,
          spentUsd: guardrail.quota.spentUsd,
          capUsd: guardrail.quota.capUsd,
          globalTotalUsd: guardrail.global.totalUsd,
          globalLimitUsd: guardrail.global.limitUsd,
        },
        'iOS parse-receipt blocked by cost guardrail',
      );
      sendError(
        res,
        guardrail.reason,
        `${guardrail.message} Try manual entry.`,
        guardrail.status,
        guardrail.details,
      );
      return;
    }

    try {
      const { analysis, provider } = await analyzeInvoiceImage(
        imageBase64,
        normalizeMimeType(mimeType),
        normalizedOcrHint,
        { userId, tenantId },
      );

      const result = {
        merchant: typeof analysis.vendor === 'string' ? analysis.vendor.trim() : null,
        date: typeof analysis.documentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(analysis.documentDate)
          ? analysis.documentDate
          : null,
        amount: parseInvoiceAmount(analysis.totalAmount),
        currency: inferCurrencyCode(analysis.totalAmount) ?? defaultCurrencyForTimezone(userId),
        category: guessReceiptCategory(analysis.vendor),
        confidence: clampReceiptConfidence(analysis),
      };

      const mergedResult = mergeReceiptParseResult(result, ocrFallback?.parsed);
      const verificationNote = buildReceiptVerificationNote(
        typeof analysis.validationNote === 'string' ? analysis.validationNote : null,
        result,
        mergedResult,
        ocrFallback?.verificationNote ?? null,
      );

      logger.info(
        {
          userId,
          confidence: mergedResult.confidence,
          provider,
          hasOcrBackfill: Boolean(ocrFallback),
        },
        'iOS receipt parsed',
      );

      let filedInvoice: Record<string, unknown> | null = null;
      let filingWarning: string | null = null;
      if (
        typeof imageBase64 === 'string' &&
        analysis.isInvoice &&
        mergedResult.confidence >= config.invoices.minConfidence
      ) {
        try {
          const imageBuffer = Buffer.from(imageBase64, 'base64');
          const filingResult = await fileInvoice(
            imageBuffer,
            normalizeMimeType(mimeType),
            analysis,
            { tenantId, userId },
          );
          if (filingResult.success) {
            const filing = recordFiling({
              tenant_id: tenantId,
              user_id: userId,
              vendor: analysis.vendor || mergedResult.merchant || 'Unknown',
              amount: analysis.totalAmount ?? (mergedResult.amount != null ? String(mergedResult.amount) : null),
              document_date: analysis.documentDate || mergedResult.date,
              invoice_number: analysis.invoiceNumber,
              source: 'photo',
              source_ref: filingResult.objectKey ? `photo:${filingResult.objectKey}` : `photo:${Date.now()}`,
              remote_path: filingResult.filePath,
              folder_path: filingResult.folderPath,
              filename: filingResult.filename,
              file_size_bytes: imageBuffer.length,
              compressed_size_bytes: filingResult.compressedSizeKB ? filingResult.compressedSizeKB * 1024 : null,
              object_key: filingResult.objectKey ?? null,
              checksum: filingResult.checksum ?? null,
              mime: filingResult.mime ?? normalizeMimeType(mimeType),
              bytes: filingResult.bytes ?? imageBuffer.length,
              storage_backend: filingResult.storageBackend ?? null,
              status: 'filed',
            });
            filedInvoice = {
              id: filing.id,
              objectKey: filing.object_key,
              checksum: filing.checksum,
              filename: filing.filename,
              mime: filing.mime,
              bytes: filing.bytes,
            };
          } else {
            filingWarning = filingResult.error || 'Invoice image was parsed but not durably filed.';
          }
        } catch (filingErr: any) {
          logger.error({ err: filingErr, userId, tenantId }, 'iOS parse-receipt: durable filing failed');
          filingWarning = filingErr?.message || 'Invoice image was parsed but not durably filed.';
        }
      }

      sendSuccess(res, {
        parsed: mergedResult,
        verificationNote,
        filedInvoice,
        filingWarning,
        tokensUsed: 0,
        model: provider,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS parse-receipt: vision pipeline failed');
      if (ocrFallback) {
        sendSuccess(res, {
          parsed: ocrFallback.parsed,
          verificationNote: ocrFallback.verificationNote,
          tokensUsed: 0,
          model: 'ocr_hint_fallback_after_ai_error',
        });
        return;
      }
      sendInternalError(res, 'Receipt parsing failed');
    } finally {
      releaseCostLock();
    }
  }));

  router.get('/invoices/:id/file', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = requireFinanceHandlerScope(req, 'finance.invoice_file');
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      sendError(res, 'BAD_REQUEST', 'id must be a positive integer');
      return;
    }

    try {
      const filing = getFilingById(tenantId, userId, id);
      if (!filing || !filing.object_key) {
        sendError(res, 'NOT_FOUND', 'Invoice file not found', 404);
        return;
      }
      const buffer = await verifyInvoiceObjectChecksum(
        filing.object_key,
        filing.checksum,
        filing.storage_backend,
      );
      res.setHeader('Content-Type', filing.mime || 'application/octet-stream');
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${(filing.filename || `invoice-${filing.id}`).replace(/"/g, '')}"`,
      );
      res.send(buffer);
    } catch (err) {
      logger.error({ err, userId, tenantId, id }, 'iOS invoice file download failed');
      sendInternalError(res, 'Unable to fetch invoice file right now.');
    }
  }));

  return router;
}

function financeTaxReminderWindow(month: string): { start: string; end: string; label: string; hard: boolean } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return null;
  const start = new Date(Date.UTC(year, monthNumber - 1, 20, 9, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthNumber - 1, 20, 9, 30, 0, 0));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: 'finance tax reminder window',
    hard: false,
  };
}

function stableMutationFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest('hex')
    .slice(0, 16);
}

function resolveFinanceRouteAmount(amount: unknown, amountCents: unknown): number | null {
  if (typeof amountCents === 'number') {
    if (!Number.isSafeInteger(amountCents)) return null;
    return centsToNumber(amountCents);
  }
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    return centsToNumber(toCents(amount));
  }
  return null;
}

function consumeFinanceWriteBudget(res: Response, tenantId: number, userId: number, budgetKey: string): boolean {
  const budget = consumeResourceBudget({
    tenantId,
    userId,
    budgetKey,
    limit: 60,
    windowSeconds: 60,
  });
  if (budget.allowed) return true;
  setRetryAfter(res, budget.resetAt);
  sendError(res, 'RATE_LIMITED', 'Too many finance write requests. Try again shortly.', 429, {
    resetAt: budget.resetAt,
    budgetKey: budget.budgetKey,
  });
  return false;
}

function setRetryAfter(res: Response, resetAt: string): void {
  const seconds = Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000));
  res.setHeader('Retry-After', String(Number.isFinite(seconds) ? seconds : 60));
}

function normalizeMimeType(mimeType: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/png') return 'image/png';
  if (normalized === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

function parseInvoiceAmount(rawAmount: string | null | undefined): number | null {
  if (!rawAmount) return null;
  const matches = rawAmount.match(/(?<!\d)(?:\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)(?!\d)/g);
  if (!matches || matches.length === 0) return null;

  for (const candidate of matches.slice().reverse()) {
    try {
      const cents = parseUserAmount(candidate);
      const parsed = Math.abs(centsToNumber(cents));
      if (isPlausibleReceiptAmount(parsed, candidate)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function isPlausibleReceiptAmount(value: number, rawMatch: string): boolean {
  if (value <= 0) return false;
  if (value > 10_000) return false;
  if (rawMatch.includes('.') || rawMatch.includes(',')) return true;
  return value <= 500;
}

function inferCurrencyCode(rawAmount: string | null | undefined): string | null {
  if (!rawAmount) return null;
  if (rawAmount.includes('R$')) return 'BRL';
  if (rawAmount.includes('€')) return 'EUR';
  if (rawAmount.includes('£')) return 'GBP';
  if (rawAmount.includes('$')) return 'USD';
  return null;
}

function guessReceiptCategory(vendor: string | null | undefined): string | null {
  if (!vendor) return null;
  const lower = vendor.toLowerCase();
  if (/(mcdonald|burger|pizza|restaurant|kebab|coffee|cafe|restaurante|bar)/i.test(lower)) return 'food';
  if (/(uber|bolt|taxi|cp|comboios|metro|transport)/i.test(lower)) return 'transport';
  if (/(farmacia|pharmacy|hospital|clinic|clinica|health)/i.test(lower)) return 'health';
  if (/(continente|pingo doce|lidl|aldi|supermercado|market|grocery)/i.test(lower)) return 'groceries';
  if (/(amazon|zara|ikea|shopping|store|loja)/i.test(lower)) return 'shopping';
  return 'other';
}

function clampReceiptConfidence(analysis: { confidence: number; vendor: string | null; documentDate: string | null; totalAmount: string | null; validationNote?: string | null }): number {
  let confidence = typeof analysis.confidence === 'number'
    ? Math.max(0, Math.min(1, analysis.confidence))
    : 0.4;

  if (!analysis.vendor) confidence = Math.min(confidence, 0.65);
  if (!analysis.documentDate) confidence = Math.min(confidence, 0.75);
  if (!analysis.totalAmount) confidence = Math.min(confidence, 0.5);
  if (analysis.validationNote) confidence = Math.min(confidence, 0.72);

  return confidence;
}

type ParsedReceiptResult = {
  merchant: string | null;
  date: string | null;
  amount: number | null;
  currency: string;
  category: string | null;
  confidence: number;
};

function mergeReceiptParseResult(
  primary: ParsedReceiptResult,
  fallback?: ParsedReceiptResult | null,
): ParsedReceiptResult {
  if (!fallback) return primary;

  const mergedMerchant = primary.merchant?.trim()
    ? primary.merchant.trim()
    : fallback.merchant;
  const mergedDate = primary.date ?? fallback.date;
  const mergedAmount = primary.amount != null && primary.amount > 0
    ? primary.amount
    : fallback.amount;
  const mergedCurrency = mergedAmount === fallback.amount && fallback.amount != null
    ? fallback.currency
    : primary.currency || fallback.currency;
  const mergedCategory = primary.category ?? fallback.category;
  const mergedConfidence = Math.max(primary.confidence, fallback.confidence);

  return {
    merchant: mergedMerchant,
    date: mergedDate,
    amount: mergedAmount,
    currency: mergedCurrency,
    category: mergedCategory,
    confidence: mergedConfidence,
  };
}

function buildReceiptVerificationNote(
  providerNote: string | null,
  primary: ParsedReceiptResult,
  merged: ParsedReceiptResult,
  fallbackNote: string | null,
): string | null {
  const notes: string[] = [];
  if (providerNote && providerNote.trim().length > 0) {
    notes.push(providerNote.trim());
  }

  const usedOcrBackfill = primary.merchant !== merged.merchant
    || primary.date !== merged.date
    || primary.amount !== merged.amount
    || primary.currency !== merged.currency
    || primary.category !== merged.category;

  if (usedOcrBackfill) {
    notes.push('Filled missing receipt fields using on-device OCR.');
  } else if (!providerNote && fallbackNote && merged.confidence <= 0.45) {
    notes.push(fallbackNote);
  }

  if (notes.length === 0) return null;
  return Array.from(new Set(notes)).join(' ');
}

function defaultCurrencyForTimezone(userId: number): string {
  try {
    const { getUserById } = require('../../services/user-service');
    const user = getUserById?.(userId);
    const tz = user?.timezone || 'Europe/Lisbon';
    if (tz.includes('Sao_Paulo') || tz.includes('Brazil') || tz.includes('Brasilia')) return 'BRL';
    if (tz.includes('America/New_York') || tz.includes('America/Los_Angeles') || tz.includes('America/Chicago')) return 'USD';
    if (tz.includes('London')) return 'GBP';
  } catch {}
  return 'EUR';
}

function parseReceiptFromOcrHint(ocrHint: string, userId: number): {
  parsed: {
    merchant: string | null;
    date: string | null;
    amount: number | null;
    currency: string;
    category: string | null;
    confidence: number;
  };
  verificationNote: string;
} {
  const lines = ocrHint
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const merchant = extractMerchantFromOcrLines(lines);
  const amountLine = extractAmountLineFromOcrLines(lines);
  const amount = amountLine ? parseInvoiceAmount(amountLine) : null;
  const currency = inferCurrencyFromOcrLines(lines, amountLine, userId);
  const date = extractReceiptDateFromOcrLines(lines);

  let confidence = 0.38;
  if (merchant) confidence += 0.16;
  if (date) confidence += 0.14;
  if (amount != null) confidence += 0.20;

  return {
    parsed: {
      merchant,
      date,
      amount,
      currency,
      category: guessReceiptCategory(merchant),
      confidence: Math.min(0.88, confidence),
    },
    verificationNote: 'AI receipt vision unavailable. Parsed from on-device OCR only.',
  };
}

function extractMerchantFromOcrLines(lines: string[]): string | null {
  const legalEntityIndex = lines.findIndex((line) => isLikelyLegalEntityLine(line));
  if (legalEntityIndex > 0) {
    const previous = lines[legalEntityIndex - 1];
    if (isLikelyBrandLine(previous)) {
      return cleanMerchantLine(previous);
    }
  }

  const candidate = lines.find((line) => {
    if (isLikelyMerchantNoiseLine(line)) return false;
    if (looksLikeReceiptDate(line)) return false;
    return line.length >= 3 && line.length <= 60;
  });

  return candidate ? cleanMerchantLine(candidate) : null;
}

function cleanMerchantLine(line: string): string {
  const withoutStoreCode = line.replace(/^\d+\s+/, '').trim();
  return withoutStoreCode
    .toLowerCase()
    .split(/\s+/)
    .map((part) => {
      if (part.length <= 3 && part === part.toUpperCase()) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function extractAmountLineFromOcrLines(lines: string[]): string | null {
  const labeledTotal = lines.find((line, index) => {
    const lower = line.toLowerCase();
    if (!/\btotal\b/.test(lower)) return false;
    if (parseInvoiceAmount(line) != null) return true;
    return index + 1 < lines.length
      && looksLikeAmountLine(lines[index + 1] || '')
      && parseInvoiceAmount(lines[index + 1] || '') != null;
  });
  if (labeledTotal) {
    const ownAmount = parseInvoiceAmount(labeledTotal);
    if (ownAmount != null) return labeledTotal;
    const idx = lines.indexOf(labeledTotal);
    const nearby = bestAmountLineNearTotal(lines, idx);
    if (nearby) return nearby;
    const next = lines[idx + 1] || '';
    return looksLikeAmountLine(next) ? next : labeledTotal;
  }

  const numericCandidates = lines
    .map((line) => ({ line, amount: parseInvoiceAmount(line) }))
    .filter((entry): entry is { line: string; amount: number } => {
      return entry.amount != null && isLikelyAmountCandidateLine(entry.line);
    });

  if (numericCandidates.length === 0) return null;
  numericCandidates.sort((lhs, rhs) => rhs.amount - lhs.amount);
  return numericCandidates[0]?.line ?? null;
}

function bestAmountLineNearTotal(lines: string[], totalIndex: number, lookahead: number = 20): string | null {
  const candidates = lines
    .slice(totalIndex + 1, totalIndex + 1 + lookahead)
    .filter((line) => looksLikeAmountLine(line))
    .map((line) => ({ line, amount: parseInvoiceAmount(line) }))
    .filter((entry): entry is { line: string; amount: number } => entry.amount != null);

  if (candidates.length === 0) return null;
  candidates.sort((lhs, rhs) => rhs.amount - lhs.amount);
  return candidates[0]?.line ?? null;
}

function looksLikeAmountLine(text: string): boolean {
  const upper = text.toUpperCase();
  return upper.includes('€')
    || upper.includes('$')
    || upper.includes('EUR')
    || upper.includes('BRL')
    || upper.includes('R$')
    || upper.includes(',')
    || upper.includes('.')
    || isLikelyEuroOcrGlyph(text);
}

function isLikelyAmountCandidateLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (/\b(total|subtotal|taxa|iva|base)\b/.test(lower)) return true;
  if (looksLikeReceiptDate(line)) return false;

  const letters = (line.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (letters === 0) return true;

  return /€|\$|r\$|\be\b|\beur\b|\busd\b|\bbrl\b|\bgbp\b/i.test(line);
}

function inferCurrencyFromOcrLines(lines: string[], amountLine: string | null, userId: number): string {
  const combined = [amountLine, ...lines].filter(Boolean).join(' ');
  const explicitCurrency = inferCurrencyCode(combined);
  if (explicitCurrency) return explicitCurrency;
  if (isLikelyEuroOcrGlyph(combined)) return 'EUR';
  return defaultCurrencyForTimezone(userId);
}

function extractReceiptDateFromOcrLines(lines: string[]): string | null {
  for (const line of lines) {
    const iso = line.match(/\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/);
    if (iso) {
      return `${iso[1]}-${iso[2]}-${iso[3]}`;
    }

    const local = line.match(/\b(\d{2})[-/.](\d{2})[-/.](\d{2,4})\b/);
    if (local) {
      const year = local[3].length === 2 ? `20${local[3]}` : local[3];
      return `${year}-${local[2]}-${local[1]}`;
    }
  }

  return null;
}

function isLikelyLegalEntityLine(line: string): boolean {
  return /\b(lda|unip|ltda|llc|inc|s\.a\.?|sa)\b/i.test(line);
}

function isLikelyBrandLine(line: string): boolean {
  if (isLikelyLegalEntityLine(line)) return false;
  if (isLikelyMerchantNoiseLine(line)) return false;
  const letters = (line.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const digits = (line.match(/\d/g) || []).length;
  return letters >= 6 && digits <= 2;
}

function isLikelyMerchantNoiseLine(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.includes('@')
    || lower.includes('tel')
    || lower.includes('rua ')
    || lower.includes('avenida')
    || lower.includes('nif')
    || lower.includes('contrib')
    || lower.includes('registo')
    || lower.includes('capital social')
    || lower.includes('consultas')
    || lower.includes('obrigado')
    || lower.includes('atcud')
    || lower.includes('certificado')
    || lower.includes('copyright');
}

function looksLikeReceiptDate(line: string): boolean {
  return /\b\d{4}[-/.]\d{2}[-/.]\d{2}\b/.test(line)
    || /\b\d{2}[-/.]\d{2}[-/.]\d{2,4}\b/.test(line);
}

function isLikelyEuroOcrGlyph(text: string): boolean {
  return /(^|[\s:])e\s*\d+(?:[.,]\d{2})?(\s|$)/i.test(text);
}

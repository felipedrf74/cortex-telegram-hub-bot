// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Finance routes — token-zero CRUD over the finance-tracker service.
 *
 * Thin HTTP layer over `src/services/finance-tracker.ts`. Exposes
 * transactions, monthly summaries, and Brazilian tax event tracking
 * (IRPF Carnê-Leão + INSS) for the iOS Finance skill landing page.
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

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { getDb } from '../../services/database';
import {
  addTransaction,
  getTransactions,
  deleteTransaction,
  getMonthlySummary,
  getTaxEvents,
  calculateAndStoreTax,
  calculateMonthlyTax,
} from '../../services/finance-tracker';
import { completeVisionOneShot, isGeminiProviderConfigured } from '../../services/gemini-provider';
import { isUserOverDailyCap } from '../../services/cost-guardrail';

export function financeRoutes(): Router {
  const router = Router();

  // ── Transactions ───────────────────────────────────────────────────

  /**
   * GET /api/v1/finance/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&category=&limit=
   * Returns transactions for the authenticated user, newest first.
   */
  router.get('/transactions', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    const startDate = typeof req.query.from === 'string' ? req.query.from : undefined;
    const endDate = typeof req.query.to === 'string' ? req.query.to : undefined;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 50, 200)
      : 50;

    try {
      const txs = getTransactions(userId, { startDate, endDate, category, limit });
      sendSuccess(res, { transactions: txs, count: txs.length });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS finance transactions list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch transactions', 500);
    }
  }));

  /**
   * POST /api/v1/finance/transactions
   * Body: { date, category, amount, subcategory?, description?, currency?, receiptRef? }
   */
  router.post('/transactions', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { date, category, amount, subcategory, description, currency, receiptRef } = req.body;

    if (!date || typeof date !== 'string') {
      sendError(res, 'BAD_REQUEST', 'date is required (YYYY-MM-DD)');
      return;
    }
    if (!category || typeof category !== 'string') {
      sendError(res, 'BAD_REQUEST', 'category is required');
      return;
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      sendError(res, 'BAD_REQUEST', 'amount must be a finite number');
      return;
    }

    try {
      const tx = addTransaction(userId, date, category, amount, {
        subcategory,
        description,
        currency,
        receiptRef,
      });
      logger.info({ userId, txId: tx.id, category, amount }, 'iOS transaction added');
      sendSuccess(res, { transaction: tx }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS finance transaction create failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to add transaction', 500);
    }
  }));

  /**
   * PATCH /api/v1/finance/transactions/:id
   * Partial update — only the fields present in the body are written.
   * Scoped to the caller's user_id so cross-user writes return 404.
   *
   * Implemented at the route layer (not via a service function) because
   * finance-tracker.ts doesn't currently expose an updateTransaction
   * helper and the raw SQL is simple enough to inline. If more update
   * surfaces show up later, this should move to finance-tracker.ts.
   */
  router.patch('/transactions/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const txId = parseInt(req.params.id, 10);
    const { date, category, subcategory, amount, currency, description, receiptRef } = req.body;

    if (Number.isNaN(txId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    // Reject completely-empty bodies.
    if (date === undefined && category === undefined && subcategory === undefined
        && amount === undefined && currency === undefined && description === undefined
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
    if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount))) {
      sendError(res, 'BAD_REQUEST', 'amount must be a finite number');
      return;
    }

    try {
      const db = getDb();

      // Verify the row exists + is owned by this user BEFORE updating.
      const existing = db.prepare(
        'SELECT id FROM finance_transactions WHERE id = ? AND user_id = ?'
      ).get(txId, userId) as { id: number } | undefined;

      if (!existing) {
        sendError(res, 'NOT_FOUND', 'Transaction not found or not owned by user', 404);
        return;
      }

      // Build the SET clause dynamically — only touch fields the caller wants.
      const setParts: string[] = [];
      const params: any[] = [];

      if (date !== undefined) { setParts.push('date = ?'); params.push(date); }
      if (category !== undefined) { setParts.push('category = ?'); params.push(category); }
      if (subcategory !== undefined) { setParts.push('subcategory = ?'); params.push(subcategory); }
      if (amount !== undefined) { setParts.push('amount = ?'); params.push(amount); }
      if (currency !== undefined) { setParts.push('currency = ?'); params.push(currency); }
      if (description !== undefined) { setParts.push('description = ?'); params.push(description); }
      if (receiptRef !== undefined) { setParts.push('receipt_ref = ?'); params.push(receiptRef); }

      setParts.push("updated_at = datetime('now')");
      params.push(txId, userId);

      db.prepare(
        `UPDATE finance_transactions SET ${setParts.join(', ')} WHERE id = ? AND user_id = ?`
      ).run(...params);

      const updated = db.prepare(
        'SELECT * FROM finance_transactions WHERE id = ?'
      ).get(txId) as any;

      logger.info({ userId, txId }, 'iOS finance transaction updated');
      sendSuccess(res, { transaction: updated });
    } catch (err: any) {
      logger.error({ err, userId, txId }, 'iOS finance transaction update failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update transaction', 500);
    }
  }));

  /**
   * DELETE /api/v1/finance/transactions/:id
   */
  router.delete('/transactions/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const txId = parseInt(req.params.id, 10);

    if (Number.isNaN(txId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const deleted = deleteTransaction(userId, txId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Transaction not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { deleted: true, id: txId });
    } catch (err: any) {
      logger.error({ err, userId, txId }, 'iOS finance transaction delete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to delete transaction', 500);
    }
  }));

  // ── Monthly Summary ────────────────────────────────────────────────

  /**
   * GET /api/v1/finance/monthly-summary?month=YYYY-MM
   * Returns aggregated totals (income, expenses, net) for the month.
   * If month is omitted, defaults to the current month.
   */
  router.get('/monthly-summary', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
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
      const summary = getMonthlySummary(userId, month);

      // Precompute the tax breakdown so the iOS KPI card can show it
      // without a second round-trip. Uses the same IRPF + INSS logic
      // the backend persists via calculateAndStoreTax.
      const taxBreakdown = calculateMonthlyTax(summary.totalIncome, summary.totalDeductions);

      sendSuccess(res, { summary, tax: taxBreakdown });
    } catch (err: any) {
      logger.error({ err, userId, month }, 'iOS finance monthly-summary failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch monthly summary', 500);
    }
  }));

  // ── Tax Events ─────────────────────────────────────────────────────

  /**
   * GET /api/v1/finance/tax/events?year=&limit=
   * Returns the user's persisted tax events (historical IRPF runs).
   */
  router.get('/tax/events', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const year = req.query.year ? parseInt(String(req.query.year), 10) : undefined;
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 12, 60)
      : 12;

    try {
      const events = getTaxEvents(userId, { year, limit });
      sendSuccess(res, { events, count: events.length });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS finance tax events list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch tax events', 500);
    }
  }));

  /**
   * POST /api/v1/finance/tax/calculate
   * Body: { month?: YYYY-MM }
   * Runs calculateAndStoreTax for the given month (defaults to current).
   */
  router.post('/tax/calculate', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
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
      const event = calculateAndStoreTax(userId, month);
      logger.info({ userId, month, taxDue: event.tax_due }, 'iOS tax event calculated');
      sendSuccess(res, { event });
    } catch (err: any) {
      logger.error({ err, userId, month }, 'iOS finance tax calculate failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to calculate tax', 500);
    }
  }));

  // ────────────────────────────────────────────────────────────────
  // Receipt parsing via Gemini vision (TASK-14 Phase 4)
  //
  // The iOS Finance tab's capture-expense flow tries on-device
  // Vision OCR + heuristic parsing first (free, zero tokens) and
  // only calls this endpoint when heuristics fail OR the user
  // explicitly taps "Ask AI for help" on the review sheet.
  //
  // Per the owner's April 9 directive, Gemini is the vision
  // provider. There's no Claude fallback here because vision is
  // a pure content-generation task where provider quality is
  // similar and cost/latency favor Gemini Flash ~10x over Sonnet.
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
   *     currency: string,         // default "BRL"
   *     category: string | null,  // best-guess category
   *     confidence: number,       // 0-1, Gemini's self-reported confidence
   *   },
   *   tokensUsed: number,
   *   model: string,
   * }
   *
   * The iOS review sheet then lets the user edit any of the
   * parsed fields before they tap "Add transaction" — the final
   * POST /transactions call is separate from this parse call.
   */
  router.post('/parse-receipt', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { imageBase64, mimeType, ocrHint } = req.body;

    // ── Validation ────────────────────────────────────────────
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      sendError(res, 'BAD_REQUEST', 'imageBase64 is required and must be a string');
      return;
    }
    if (!mimeType || typeof mimeType !== 'string') {
      sendError(res, 'BAD_REQUEST', 'mimeType is required (e.g. "image/jpeg")');
      return;
    }
    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/heic'].includes(mimeType.toLowerCase())) {
      sendError(res, 'BAD_REQUEST', 'mimeType must be image/jpeg, image/png, or image/heic');
      return;
    }

    // Reject oversized bodies early. Gemini's max inline image is 20MB,
    // but realistically a 5MB receipt is already absurdly high-res.
    // Base64 is ~33% larger than raw bytes so the 6MB cap = ~4.5MB image.
    const approxBytes = (imageBase64.length * 3) / 4;
    if (approxBytes > 6 * 1024 * 1024) {
      sendError(res, 'PAYLOAD_TOO_LARGE', 'Image exceeds 6MB. Compress before uploading.', 413);
      return;
    }

    // ── Provider availability ─────────────────────────────────
    if (!isGeminiProviderConfigured()) {
      sendError(
        res,
        'VISION_NOT_CONFIGURED',
        'Gemini vision is not configured on this server. Fall back to manual entry.',
        503,
      );
      return;
    }

    // ── Cost cap ──────────────────────────────────────────────
    // Per-user daily USD cap from cost-guardrail. Rejects before
    // the Gemini call so the user never gets charged past their
    // PER_USER_DAILY_USD_CAP. Since vision calls are cheap
    // (~$0.0001 each), the cap is mostly a stuck-retry-loop guard.
    const cap = isUserOverDailyCap(userId);
    if (cap.over) {
      logger.warn(
        { userId, spentUsd: cap.spentUsd, capUsd: cap.capUsd },
        'iOS parse-receipt blocked by daily cost cap',
      );
      sendError(
        res,
        'COST_CAP_EXCEEDED',
        `Daily AI cost cap of $${cap.capUsd.toFixed(2)} reached. Resets at midnight UTC. Try manual entry.`,
        429,
      );
      return;
    }

    // ── Prompt construction ───────────────────────────────────
    // System prompt locks the output to strict JSON so the iOS
    // client can parse it without fuzzy matching.
    const systemPrompt = `You extract structured fields from receipt images.
Return ONLY a single JSON object with these keys:
  - merchant: string (the store/business name, title-cased)
  - date: string (YYYY-MM-DD format; null if not visible)
  - amount: number (the TOTAL amount paid, as a decimal; null if not visible)
  - currency: string (ISO code, default "BRL" for Brazilian receipts)
  - category: string (best-guess from: food, groceries, transport, utilities, entertainment, health, education, shopping, services, other)
  - confidence: number (0.0-1.0, your own confidence in the extraction)

If a field is not visible or readable, return null for that field.
DO NOT include any explanation, markdown, or code fences. Return only the JSON.`;

    const userPrompt = ocrHint
      ? `Parse this receipt. On-device OCR extracted this text as a hint (may be noisy):\n\n${ocrHint}`
      : 'Parse this receipt and extract the structured fields.';

    // ── Call Gemini ───────────────────────────────────────────
    // April 9 2026: pass `userId` so the cost row in api_usage
    // attributes this call to the real user. Before the A1 fix
    // that persisted user_id in the INSERT, this was pointless —
    // the column existed but was never written. Now that it's
    // wired, we can actually enforce per-user caps on receipt
    // parsing and attribute the cost to the right person for
    // the pricing model math.
    try {
      const rawText = await completeVisionOneShot(
        systemPrompt,
        userPrompt,
        { base64: imageBase64, mimeType },
        'parse-receipt',   // usage category for logGeminiUsage
        { maxTokens: 512, temperature: 0.1, userId },
      );

      // Gemini sometimes wraps JSON in ```json fences even when told
      // not to. Strip any surrounding code fences / whitespace before
      // parsing. This is a forgiving cleanup, not a spec violation.
      const cleaned = rawText
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      let parsed: {
        merchant: string | null;
        date: string | null;
        amount: number | null;
        currency: string;
        category: string | null;
        confidence: number;
      };

      try {
        parsed = JSON.parse(cleaned);
      } catch (err) {
        logger.error({ rawText, cleaned }, 'iOS parse-receipt: Gemini returned non-JSON');
        sendError(
          res,
          'PARSE_FAILED',
          'Could not extract structured fields from the receipt. Try manual entry.',
          422,
        );
        return;
      }

      // ── Sanity-check + normalize ───────────────────────────
      // Guard against null/undefined fields that would crash the
      // iOS client's Codable decoder. Fill in safe defaults.
      const result = {
        merchant: typeof parsed.merchant === 'string' ? parsed.merchant.trim() : null,
        date: typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
          ? parsed.date
          : null,
        amount: typeof parsed.amount === 'number' && Number.isFinite(parsed.amount)
          ? Math.abs(parsed.amount)   // flip sign if Gemini returned negative
          : null,
        currency: typeof parsed.currency === 'string' && parsed.currency.length === 3
          ? parsed.currency.toUpperCase()
          : 'BRL',
        category: typeof parsed.category === 'string' ? parsed.category.toLowerCase() : null,
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      };

      logger.info(
        { userId, merchant: result.merchant, amount: result.amount, confidence: result.confidence },
        'iOS receipt parsed',
      );

      sendSuccess(res, {
        parsed: result,
        // tokensUsed is logged internally by logGeminiUsage — surfacing
        // it here too lets the iOS review sheet show "parsed with N
        // tokens" for transparency about what spent money.
        tokensUsed: 0,   // placeholder — backend doesn't return usage yet
        model: 'gemini-flash',
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS parse-receipt: Gemini call failed');
      sendError(res, 'INTERNAL', err?.message || 'Receipt parsing failed', 500);
    }
  }));

  return router;
}

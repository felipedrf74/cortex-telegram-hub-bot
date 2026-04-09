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
import {
  addTransaction,
  getTransactions,
  deleteTransaction,
  getMonthlySummary,
  getTaxEvents,
  calculateAndStoreTax,
  calculateMonthlyTax,
} from '../../services/finance-tracker';

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

  return router;
}

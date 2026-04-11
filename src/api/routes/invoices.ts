// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Invoices routes — manage the vendor-scan configuration used by the
 * monthly email collector.
 *
 * Thin HTTP layer over:
 *   - `src/services/invoice-collector.ts`  — getAllVendors, collectMonthlyInvoices
 *   - `src/state/invoice-vendors.ts`       — addVendor, removeVendor
 *
 * The iOS Finance landing page uses these routes to show the user's
 * configured email-scan rules (vendor name, sender pattern, subject
 * keywords) and to trigger an on-demand rescan. Actual photo capture
 * + receipt parsing is Phase 4 and lives behind a separate endpoint
 * (not built yet).
 *
 * Mount point: `/api/v1/invoices`
 *
 * Endpoints:
 *   GET    /vendors                 — list merged builtin + user vendors
 *   POST   /vendors                 — add or re-enable a custom vendor
 *   DELETE /vendors/:id             — soft-delete (disable) a custom vendor
 *   POST   /scan-now                — trigger on-demand monthly collection
 *
 * Part of TASK-14 Phase 1 (foundation). Vendor management was
 * previously only accessible via Telegram commands; exposing it
 * over HTTP lets the iOS Finance tab own the configuration UI.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import {
  getAllVendors as getAllVendorsMerged,
  collectMonthlyInvoices,
} from '../../services/invoice-collector';
import {
  addVendor,
  removeVendor,
  getAllVendors as getAllVendorsDb,
} from '../../state/invoice-vendors';

export function invoicesRoutes(): Router {
  const router = Router();

  // ── Vendors ────────────────────────────────────────────────────────

  /**
   * GET /api/v1/invoices/vendors
   *
   * Returns the MERGED list (builtin + user-added + disabled). The iOS
   * UI differentiates the three by:
   *   - `builtin: true`   — cannot be edited/deleted
   *   - `builtin: false`  — user-added, editable + deletable
   *   - `enabled: false`  — previously added but soft-deleted
   *
   * Builtins never appear in the `invoice_vendors` table, so they have
   * no `id` — the iOS client should not assume every row has one.
   */
  router.get('/vendors', asyncHandler(async (req, res: Response) => {
    try {
      const userId = (req as any).userId;

      // Invoice scanning requires an Outlook connection (email access).
      // Users without Outlook connected get an empty vendor list.
      try {
        const { isConnected } = require('../../services/oauth-store');
        if (!isConnected(userId, 'outlook')) {
          sendSuccess(res, { active: [], dbRows: [], builtinCount: 0, customCount: 0 });
          return;
        }
      } catch {
        // oauth-store not available — fall through to show vendors
      }

      // Builtins + currently-enabled custom vendors (what the collector
      // actually uses when it runs).
      const active = getAllVendorsMerged(userId);

      // Also pull the raw DB rows so the UI can show disabled vendors
      // (for re-enable) — these include `id` and `enabled` fields.
      const dbRows = getAllVendorsDb(userId);

      sendSuccess(res, {
        active,                  // what the collector uses right now
        dbRows,                  // full DB inventory for admin management
        builtinCount: active.filter(v => v.builtin).length,
        customCount: dbRows.length,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS invoices vendors list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch vendors', 500);
    }
  }));

  /**
   * POST /api/v1/invoices/vendors
   * Body: { name, senderPattern, subjectPatterns? }
   *
   * Adds or re-enables a custom vendor for the monthly collector.
   * Uses INSERT OR REPLACE semantics inside `addVendor`, so re-POSTing
   * the same `senderPattern` is an upsert (updates name + subject rules
   * and toggles `enabled` back on if it was previously disabled).
   */
  router.post('/vendors', asyncHandler(async (req, res: Response) => {
    const { name, senderPattern, subjectPatterns } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      sendError(res, 'BAD_REQUEST', 'name is required');
      return;
    }
    if (!senderPattern || typeof senderPattern !== 'string' || !senderPattern.trim()) {
      sendError(res, 'BAD_REQUEST', 'senderPattern is required (e.g. "vendor.com")');
      return;
    }

    try {
      const vendor = addVendor(name.trim(), senderPattern.trim(), subjectPatterns);
      logger.info({ vendorId: vendor.id, name }, 'iOS invoice vendor added');
      sendSuccess(res, { vendor }, { status: 201 });
    } catch (err: any) {
      logger.error({ err }, 'iOS invoices vendor create failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to add vendor', 500);
    }
  }));

  /**
   * DELETE /api/v1/invoices/vendors/:id
   * Soft-delete — flips `enabled` to 0 but keeps the row for audit.
   */
  router.delete('/vendors/:id', asyncHandler(async (req, res: Response) => {
    const id = parseInt(req.params.id, 10);

    if (Number.isNaN(id)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const removed = removeVendor(id);
      if (!removed) {
        sendError(res, 'NOT_FOUND', 'Vendor not found', 404);
        return;
      }
      sendSuccess(res, { removed: true, id });
    } catch (err: any) {
      logger.error({ err, id }, 'iOS invoices vendor delete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to delete vendor', 500);
    }
  }));

  // ── On-demand scan ─────────────────────────────────────────────────

  /**
   * POST /api/v1/invoices/scan-now
   * Body: { year?: number, month?: number }
   *
   * Triggers the monthly invoice collector for the given year+month
   * (defaults to the current month). Runs synchronously — the response
   * is the full MonthlyCollectionResult including filed counts, errors,
   * and per-vendor details. For large months this can take 10-30s, so
   * the iOS client should show a loading state and not retry.
   */
  router.post('/scan-now', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const now = new Date();
    const year = Number(req.body?.year ?? now.getFullYear());
    const month = Number(req.body?.month ?? (now.getMonth() + 1));

    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      sendError(res, 'BAD_REQUEST', 'year must be between 2000 and 2100');
      return;
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      sendError(res, 'BAD_REQUEST', 'month must be between 1 and 12');
      return;
    }

    try {
      logger.info({ userId, year, month }, 'iOS on-demand invoice scan started');
      const result = await collectMonthlyInvoices(year, month);
      logger.info(
        { userId, year, month, filed: result.totalFiled, errors: result.totalErrors },
        'iOS on-demand invoice scan complete'
      );
      sendSuccess(res, { result });
    } catch (err: any) {
      logger.error({ err, userId, year, month }, 'iOS on-demand invoice scan failed');
      sendError(res, 'INTERNAL', err?.message || 'Invoice scan failed', 500);
    }
  }));

  return router;
}

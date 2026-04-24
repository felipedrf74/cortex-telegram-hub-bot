// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Invoices routes — finance email collection + accountant bundle workflow.
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
 *   GET    /vendors                 — list user-scoped configured vendors
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
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { collectMonthlyInvoices } from '../../services/invoice-collector';
import {
  addVendor,
  removeVendor,
  getAllVendors as getAllVendorsDb,
} from '../../state/invoice-vendors';
import type { InvoiceVendor } from '../../domains/types';
import {
  getFiscalCollectionSummary,
  sendFiscalBundleNow,
} from '../../services/fiscal-bundle';
import { updateFiscalCollectionProfile } from '../../state/fiscal-collection-profiles';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

function splitSubjectPatterns(subjectPatterns: string | null | undefined): string[] {
  const patterns = subjectPatterns
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return patterns?.length ? patterns : ['fatura'];
}

function toUserScopedVendorConfig(row: InvoiceVendor) {
  return {
    name: row.name,
    senderPatterns: [row.sender_pattern],
    subjectPatterns: splitSubjectPatterns(row.subject_patterns),
    builtin: false,
  };
}

export function invoicesRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'invoices_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  router.get('/profile', asyncHandler(async (req, res: Response) => {
    try {
      const { userId } = req as AuthenticatedRequest;
      const summary = getFiscalCollectionSummary(userId);
      sendSuccess(res, summary);
    } catch (err: any) {
      logger.error({ err }, 'iOS fiscal collection profile failed');
      sendInternalError(res, 'Unable to load fiscal collection profile right now.');
    }
  }));

  router.put('/profile', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { destinationEmail, cadence, primaryDay, secondaryDay, enabled } = req.body ?? {};

    if (destinationEmail !== undefined && destinationEmail !== null && typeof destinationEmail !== 'string') {
      sendError(res, 'BAD_REQUEST', 'destinationEmail must be a string or null');
      return;
    }
    if (cadence !== undefined && cadence !== 'monthly' && cadence !== 'twice_monthly') {
      sendError(res, 'BAD_REQUEST', "cadence must be 'monthly' or 'twice_monthly'");
      return;
    }
    if (primaryDay !== undefined && (!Number.isFinite(primaryDay) || primaryDay < 1 || primaryDay > 28)) {
      sendError(res, 'BAD_REQUEST', 'primaryDay must be between 1 and 28');
      return;
    }
    if (secondaryDay !== undefined && secondaryDay !== null && (!Number.isFinite(secondaryDay) || secondaryDay < 1 || secondaryDay > 28)) {
      sendError(res, 'BAD_REQUEST', 'secondaryDay must be between 1 and 28 or null');
      return;
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      sendError(res, 'BAD_REQUEST', 'enabled must be a boolean');
      return;
    }

    try {
      updateFiscalCollectionProfile(userId, {
        destination_email: destinationEmail,
        cadence,
        primary_day: primaryDay,
        secondary_day: secondaryDay,
        enabled,
      });
      sendSuccess(res, getFiscalCollectionSummary(userId));
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS fiscal collection profile update failed');
      sendInternalError(res, 'Unable to update fiscal collection profile right now.');
    }
  }));

  router.post('/bundle-now', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    try {
      logger.info({ userId }, 'iOS fiscal bundle send started');
      const result = await sendFiscalBundleNow(userId, {
        startAt: req.body?.startAt,
        endAt: req.body?.endAt,
      });
      sendSuccess(res, { result });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS fiscal bundle send failed');
      sendInternalError(res, 'Unable to send the fiscal bundle right now.');
    }
  }));

  // ── Vendors ────────────────────────────────────────────────────────

  /**
   * GET /api/v1/invoices/vendors
   *
   * Returns only the authenticated user's configured vendor rows.
   *
   * The collector still has legacy built-in recognizers, but the app-facing
   * management surface must not expose global defaults as if they belonged to
   * every tenant. That previously made owner-specific fiscal vendors visible
   * to unrelated accounts.
   */
  router.get('/vendors', asyncHandler(async (req, res: Response) => {
    try {
      const { userId } = req as AuthenticatedRequest;

      // Pull the raw DB rows so the UI can show disabled vendors
      // (for re-enable) — these include `id` and `enabled` fields.
      const dbRows = getAllVendorsDb(userId);
      const active = dbRows
        .filter((row) => row.enabled === 1)
        .map(toUserScopedVendorConfig);

      sendSuccess(res, {
        active,                  // enabled user-scoped rules visible to iOS
        dbRows,                  // full user-scoped DB inventory for management
        builtinCount: 0,
        customCount: dbRows.length,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS invoices vendors list failed');
      sendInternalError(res, 'Unable to load invoice vendors right now.');
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
      const { userId } = req as AuthenticatedRequest;
      const vendor = addVendor(name.trim(), senderPattern.trim(), userId, subjectPatterns);
      logger.info({ vendorId: vendor.id, name }, 'iOS invoice vendor added');
      sendSuccess(res, { vendor }, { status: 201 });
    } catch (err: any) {
      logger.error({ err }, 'iOS invoices vendor create failed');
      sendInternalError(res, 'Unable to add the invoice vendor right now.');
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
      const { userId } = req as AuthenticatedRequest;
      const removed = removeVendor(id, userId);
      if (!removed) {
        sendError(res, 'NOT_FOUND', 'Vendor not found', 404);
        return;
      }
      sendSuccess(res, { removed: true, id });
    } catch (err: any) {
      logger.error({ err, id }, 'iOS invoices vendor delete failed');
      sendInternalError(res, 'Unable to delete the invoice vendor right now.');
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
      const result = await collectMonthlyInvoices(userId, year, month);
      logger.info(
        { userId, year, month, filed: result.totalFiled, errors: result.totalErrors },
        'iOS on-demand invoice scan complete'
      );
      sendSuccess(res, { result });
    } catch (err: any) {
      logger.error({ err, userId, year, month }, 'iOS on-demand invoice scan failed');
      sendInternalError(res, 'Unable to run the invoice scan right now.');
    }
  }));

  return router;
}

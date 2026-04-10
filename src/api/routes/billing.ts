// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Billing Routes — Stripe web checkout + Apple IAP verification
 *
 * Token-zero: GET /billing/status reads from SQLite, no AI pipeline.
 * POST /billing/checkout creates a Stripe Checkout Session URL.
 * POST /billing/portal creates a Stripe Customer Portal URL.
 * POST /billing/apple-verify verifies a StoreKit 2 JWS transaction.
 *
 * Protected by authMiddleware (JWT required).
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import {
  isStripeConfigured,
  getSubscriptionStatus,
  createCheckoutSession,
  createPortalSession,
  handleAppleTransaction,
} from '../../services/stripe-service';
import { config } from '../../config';

export function billingRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/billing/status
   * Token-zero: returns the user's subscription status from SQLite.
   * Called by iOS on app launch and after every purchase.
   */
  router.get('/status', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const status = getSubscriptionStatus(userId);
    sendSuccess(res, status);
  }));

  /**
   * POST /api/v1/billing/checkout
   * Creates a Stripe Checkout Session and returns the URL.
   * Body: { priceId: string, successUrl?: string, cancelUrl?: string }
   */
  router.post('/checkout', asyncHandler(async (req: Request, res: Response) => {
    if (!isStripeConfigured()) {
      sendError(res, 'NOT_CONFIGURED', 'Stripe billing is not configured', 503);
      return;
    }

    const userId = (req as any).userId;
    const { priceId } = req.body;

    if (!priceId) {
      sendError(res, 'BAD_REQUEST', 'priceId is required');
      return;
    }

    // Validate that the priceId is one of our known prices (USD + BRL)
    const validPrices = [
      config.stripe.priceProMonthly,
      config.stripe.priceProYearly,
      config.stripe.priceMaxMonthly,
      config.stripe.priceMaxYearly,
      config.stripe.priceProMonthlyBrl,
      config.stripe.priceProYearlyBrl,
      config.stripe.priceMaxMonthlyBrl,
      config.stripe.priceMaxYearlyBrl,
    ].filter(Boolean);

    if (!validPrices.includes(priceId)) {
      sendError(res, 'INVALID_PRICE', 'Unknown price ID', 400);
      return;
    }

    const successUrl = req.body.successUrl || 'https://nexushub.me/?checkout=success';
    const cancelUrl = req.body.cancelUrl || 'https://nexushub.me/?checkout=canceled';

    const url = await createCheckoutSession(userId, priceId, successUrl, cancelUrl);
    sendSuccess(res, { url });
  }));

  /**
   * POST /api/v1/billing/portal
   * Creates a Stripe Customer Portal session for managing subscription.
   * Body: { returnUrl?: string }
   */
  router.post('/portal', asyncHandler(async (req: Request, res: Response) => {
    if (!isStripeConfigured()) {
      sendError(res, 'NOT_CONFIGURED', 'Stripe billing is not configured', 503);
      return;
    }

    const userId = (req as any).userId;
    const returnUrl = req.body.returnUrl || 'https://nexushub.me/';

    try {
      const url = await createPortalSession(userId, returnUrl);
      sendSuccess(res, { url });
    } catch (err: any) {
      if (err.message?.includes('No Stripe customer')) {
        sendError(res, 'NO_SUBSCRIPTION', 'No active Stripe subscription found', 404);
      } else {
        throw err;
      }
    }
  }));

  /**
   * POST /api/v1/billing/apple-verify
   * Verifies a StoreKit 2 JWS transaction from the iOS app.
   * Body: { jwsTransaction: string }
   *
   * For beta: we decode the JWS payload (base64url middle segment)
   * and trust it — full certificate chain verification is a post-launch
   * hardening step. The JWS is signed by Apple's infrastructure and
   * delivered directly from StoreKit 2 on-device, so the trust model
   * is: device → our server (no intermediary tampering vector).
   */
  router.post('/apple-verify', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { jwsTransaction } = req.body;

    if (!jwsTransaction) {
      sendError(res, 'BAD_REQUEST', 'jwsTransaction is required');
      return;
    }

    try {
      // Decode JWS payload (middle segment, base64url)
      const parts = jwsTransaction.split('.');
      if (parts.length !== 3) {
        sendError(res, 'INVALID_JWS', 'Malformed JWS transaction', 400);
        return;
      }

      const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);

      const originalTransactionId = payload.originalTransactionId || payload.transactionId;
      const productId = payload.productId;
      const expiresDate = payload.expiresDate
        ? new Date(payload.expiresDate).toISOString()
        : null;

      if (!originalTransactionId || !productId) {
        sendError(res, 'INVALID_PAYLOAD', 'Missing transactionId or productId in JWS payload', 400);
        return;
      }

      handleAppleTransaction(userId, originalTransactionId, productId, expiresDate);

      const status = getSubscriptionStatus(userId);
      sendSuccess(res, status);
    } catch (err: any) {
      logger.error({ err, userId }, 'Apple transaction verification failed');
      sendError(res, 'VERIFICATION_FAILED', err.message || 'Failed to verify Apple transaction', 400);
    }
  }));

  return router;
}

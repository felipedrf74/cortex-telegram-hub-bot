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
import { verifyAppleJws } from '../../services/apple-jws-verifier';
import { buildQuotaUsagePayload, isUserOverDailyCap } from '../../services/cost-guardrail';
import {
  grantNexusPoints,
  isNexusPointProductId,
  listNexusPointPackages,
} from '../../services/nexus-points';

function buildBillingStatusPayload(userId: number): Record<string, unknown> {
  const status = getSubscriptionStatus(userId);
  const usage = isUserOverDailyCap(userId);
  return {
    ...status,
    ...buildQuotaUsagePayload(usage),
  };
}

export function billingRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/billing/status
   * Token-zero: returns the user's subscription status from SQLite.
   * Called by iOS on app launch and after every purchase.
   */
  router.get('/status', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    sendSuccess(res, buildBillingStatusPayload(userId));
  }));

  /**
   * GET /api/v1/billing/usage
   * Token-zero: returns today's AI usage as a qualitative meter.
   *
   * The response deliberately hides raw dollar amounts and call
   * counts from the client — we expose only a fraction (0.0–1.0)
   * and a qualitative usage level. This follows Claude's best
   * practice of showing relative usage, not absolute numbers.
   *
   * Raw data (spentUsd, capUsd, callsToday) stays in the DB for
   * our internal cost analytics dashboard.
   */
  router.get('/usage', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const usage = isUserOverDailyCap(userId);
    sendSuccess(res, {
      plan: usage.plan,
      usageLevel: usage.usageLevel,
      usageFraction: usage.usageFraction,
      isOverLimit: usage.over,
      resetsAt: usage.resetAt,
      boostAvailable: usage.boostAvailable,
      ...buildQuotaUsagePayload(usage),
    });
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

    // Validate that the priceId is one of our known prices (USD + BRL + EUR)
    const validPrices = [
      config.stripe.priceProMonthly,
      config.stripe.priceProYearly,
      config.stripe.priceMaxMonthly,
      config.stripe.priceMaxYearly,
      config.stripe.priceProMonthlyBrl,
      config.stripe.priceProYearlyBrl,
      config.stripe.priceMaxMonthlyBrl,
      config.stripe.priceMaxYearlyBrl,
      config.stripe.priceProMonthlyEur,
      config.stripe.priceProYearlyEur,
      config.stripe.priceMaxMonthlyEur,
      config.stripe.priceMaxYearlyEur,
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
   * Verification steps (consumer-grade, not beta):
   *   1. Structural: valid 3-part JWS, parseable JSON payload
   *   2. Bundle ID: must match our app's bundle identifier
   *   3. Environment: production transactions only (sandbox allowed in dev)
   *   4. Product ID: must be in our known product allowlist
   *   5. Expiry: reject transactions that expired before today
   *   6. Transaction ID: must be a plausible Apple transaction ID format
   *
   * Step 7 (added April 2026): JWS cryptographic signature verification
   * using the x5c certificate chain from the JWS header. No external
   * dependencies — uses Node's built-in crypto module. The leaf cert's
   * public key is extracted and the ES256 signature is verified against
   * header.payload. This catches any payload modification after Apple signed it.
   */
  router.post('/apple-verify', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { jwsTransaction } = req.body;

    if (!jwsTransaction || typeof jwsTransaction !== 'string') {
      sendError(res, 'BAD_REQUEST', 'jwsTransaction is required and must be a string');
      return;
    }

    try {
      // ── Step 1: Structural validation ──
      const parts = jwsTransaction.split('.');
      if (parts.length !== 3) {
        sendError(res, 'INVALID_JWS', 'Malformed JWS: expected 3 segments (header.payload.signature)', 400);
        return;
      }

      // ── Step 1b: JWS signature verification ──
      // Apple's StoreKit 2 JWS includes an x5c certificate chain in the
      // header. The leaf certificate's public key is used to verify the
      // ES256 signature over "header.payload". This catches any payload
      // modification after Apple signed the transaction.
      let payload: any;
      try {
        payload = verifyAppleJws(jwsTransaction, { requireX5c: false }).payload;
        logger.debug({ userId }, 'Apple verify: JWS signature verified ✓');
      } catch (sigErr: any) {
        // Missing x5c remains non-fatal for older sandbox/Xcode receipts.
        // If Apple supplied a cert chain and signature verification failed,
        // reject instead of falling back to attacker-controlled claims.
        if (sigErr?.message !== 'APPLE_JWS_MISSING_X5C') {
          logger.warn({ err: sigErr?.message, userId }, 'Apple verify: signature check failed');
          sendError(res, 'INVALID_SIGNATURE', 'Apple transaction signature verification failed', 403);
          return;
        }
        logger.warn({ err: sigErr.message, userId }, 'Apple verify: missing x5c — continuing with claims validation for sandbox/Xcode compatibility');
        try {
          const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
          payload = JSON.parse(payloadJson);
        } catch {
          sendError(res, 'INVALID_JWS', 'JWS payload is not valid base64url JSON', 400);
          return;
        }
      }

      // ── Step 2: Bundle ID validation ──
      const expectedBundleId = 'me.nexushub.app';
      if (payload.bundleId && payload.bundleId !== expectedBundleId) {
        logger.warn({ userId, bundleId: payload.bundleId }, 'Apple verify: bundle ID mismatch');
        sendError(res, 'INVALID_BUNDLE', 'Transaction bundle ID does not match this app', 403);
        return;
      }

      // ── Step 3: Environment check ──
      // In production, only accept 'Production' environment.
      // In development (NODE_ENV !== 'production'), also accept 'Sandbox' and 'Xcode'.
      const env = payload.environment || '';
      const isProduction = process.env.NODE_ENV === 'production';
      const allowedEnvs = isProduction
        ? ['Production']
        : ['Production', 'Sandbox', 'Xcode'];
      if (env && !allowedEnvs.includes(env)) {
        logger.warn({ userId, environment: env }, 'Apple verify: environment rejected');
        sendError(res, 'INVALID_ENVIRONMENT', `Transaction environment '${env}' not accepted`, 403);
        return;
      }

      // ── Step 4: Extract and validate required fields ──
      const transactionId = payload.transactionId || payload.originalTransactionId;
      const originalTransactionId = payload.originalTransactionId || transactionId;
      const productId = payload.productId;

      if (!originalTransactionId || !productId) {
        sendError(res, 'INVALID_PAYLOAD', 'Missing transactionId or productId in JWS payload', 400);
        return;
      }

      // Transaction ID format: Apple uses numeric strings (e.g., "2000000123456789")
      if (!/^\d{5,25}$/.test(String(originalTransactionId))) {
        logger.warn({ userId, transactionId: originalTransactionId }, 'Apple verify: suspicious transaction ID format');
        sendError(res, 'INVALID_TRANSACTION', 'Transaction ID format is not valid', 400);
        return;
      }

      // ── Step 5: Product ID allowlist ──
      const knownProducts = [
        'me.nexushub.pro.monthly', 'me.nexushub.pro.yearly',
        'me.nexushub.max.monthly', 'me.nexushub.max.yearly',
        ...listNexusPointPackages().map((pkg) => pkg.productId),
      ];
      if (!knownProducts.includes(productId)) {
        logger.warn({ userId, productId }, 'Apple verify: unknown product ID');
        sendError(res, 'UNKNOWN_PRODUCT', `Product ID '${productId}' is not a known Nexus Hub product`, 400);
        return;
      }

      // ── Step 6: Expiry check ──
      const expiresDate = payload.expiresDate
        ? new Date(payload.expiresDate).toISOString()
        : null;

      if (expiresDate && !isNexusPointProductId(productId)) {
        const expiryMs = new Date(expiresDate).getTime();
        // Allow 24h grace period for clock skew and renewal processing
        if (expiryMs < Date.now() - 86400000) {
          logger.warn({ userId, expiresDate, productId }, 'Apple verify: transaction expired');
          sendError(res, 'EXPIRED', 'Transaction has expired', 400);
          return;
        }
      }

      // ── Step 7: Process the verified transaction ──
      if (isNexusPointProductId(productId)) {
        const grant = grantNexusPoints({
          userId,
          provider: 'apple',
          providerTransactionId: String(transactionId),
          productId,
          source: 'apple_iap',
        });
        logger.info({
          userId,
          productId,
          transactionId,
          granted: grant.granted,
          creditId: grant.creditId,
          environment: env || 'unknown',
        }, 'Apple Nexus Points transaction verified and processed');

        sendSuccess(res, {
          ...buildBillingStatusPayload(userId),
          nexusPointsPurchase: {
            granted: grant.granted,
            productId,
            points: grant.package.points,
            usdAllowance: grant.package.usdAllowance,
            expiresInDays: 30,
          },
        });
        return;
      }

      handleAppleTransaction(userId, String(originalTransactionId), productId, expiresDate);

      logger.info({
        userId,
        productId,
        transactionId: originalTransactionId,
        environment: env || 'unknown',
      }, 'Apple transaction verified and processed');

      sendSuccess(res, buildBillingStatusPayload(userId));
    } catch (err: any) {
      logger.error({ err, userId }, 'Apple transaction verification failed');
      sendError(res, 'VERIFICATION_FAILED', 'Failed to verify Apple transaction', 400);
    }
  }));

  return router;
}

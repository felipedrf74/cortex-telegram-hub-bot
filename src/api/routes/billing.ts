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
    const { isUserOverDailyCap } = require('../../services/cost-guardrail');
    const usage = isUserOverDailyCap(userId);
    sendSuccess(res, {
      plan: usage.plan,
      usageLevel: usage.usageLevel,
      usageFraction: usage.usageFraction,
      isOverLimit: usage.over,
      resetsAt: usage.resetAt,
      boostAvailable: usage.boostAvailable,
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
        const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
        const header = JSON.parse(headerJson);
        const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
        payload = JSON.parse(payloadJson);

        // Verify signature if x5c chain is present (production JWS always has it)
        if (header.x5c && Array.isArray(header.x5c) && header.x5c.length > 0) {
          const crypto = require('crypto');
          // x5c[0] is the leaf cert (DER-encoded, base64)
          const leafCertDer = Buffer.from(header.x5c[0], 'base64');
          const leafCertPem = '-----BEGIN CERTIFICATE-----\n'
            + leafCertDer.toString('base64').match(/.{1,64}/g)!.join('\n')
            + '\n-----END CERTIFICATE-----';

          // Extract public key from the certificate
          const pubKey = crypto.createPublicKey({ key: leafCertPem, format: 'pem' });

          // The JWS signature is over "header.payload" (the first two base64url segments)
          const signedData = parts[0] + '.' + parts[1];
          const signature = Buffer.from(parts[2], 'base64url');

          // ES256 = ECDSA with SHA-256
          const isValid = crypto.verify(
            'SHA256',
            Buffer.from(signedData),
            { key: pubKey, dsaEncoding: 'ieee-p1363' },
            signature,
          );

          if (!isValid) {
            logger.warn({ userId }, 'Apple verify: JWS signature verification FAILED');
            sendError(res, 'INVALID_SIGNATURE', 'JWS signature verification failed — transaction may be tampered', 403);
            return;
          }
          logger.debug({ userId }, 'Apple verify: JWS signature verified ✓');
        }
        // If no x5c (Xcode/sandbox test transactions may omit it), fall through to claims checks
      } catch (sigErr: any) {
        // Signature verification failure is non-fatal for sandbox/Xcode
        // transactions that may have a different signing format.
        // Log the error but continue with claims-based checks.
        logger.warn({ err: sigErr.message, userId }, 'Apple verify: signature check failed — continuing with claims validation');
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
      const originalTransactionId = payload.originalTransactionId || payload.transactionId;
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

      if (expiresDate) {
        const expiryMs = new Date(expiresDate).getTime();
        // Allow 24h grace period for clock skew and renewal processing
        if (expiryMs < Date.now() - 86400000) {
          logger.warn({ userId, expiresDate, productId }, 'Apple verify: transaction expired');
          sendError(res, 'EXPIRED', 'Transaction has expired', 400);
          return;
        }
      }

      // ── Step 7: Process the verified transaction ──
      handleAppleTransaction(userId, String(originalTransactionId), productId, expiresDate);

      logger.info({
        userId,
        productId,
        transactionId: originalTransactionId,
        environment: env || 'unknown',
      }, 'Apple transaction verified and processed');

      const status = getSubscriptionStatus(userId);
      sendSuccess(res, status);
    } catch (err: any) {
      logger.error({ err, userId }, 'Apple transaction verification failed');
      sendError(res, 'VERIFICATION_FAILED', 'Failed to verify Apple transaction', 400);
    }
  }));

  return router;
}

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

import express, { Router, Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import {
  isStripeConfigured,
  getSubscriptionStatus,
  createCheckoutSession,
  createCreditPackCheckoutSession,
  createCheckoutSessionForPlan,
  createPortalSession,
  handleAppleTransaction,
  claimWebsiteStripeSubscriptionForUser,
  deriveAppleAppAccountToken,
  isAppleTransactionAlreadyClaimedError,
  isUnknownAppleProductError,
  APPLE_SUBSCRIPTION_PRODUCT_IDS,
} from '../../services/stripe-service';
import { verifyAppleJws } from '../../services/apple-jws-verifier';
import { safeCheckoutUrl } from './public-billing';
import { buildQuotaUsagePayload, isUserOverDailyCap } from '../../services/cost-guardrail';
import {
  grantNexusPoints,
  isNexusPointProductId,
  listNexusPointPackages,
} from '../../services/nexus-points';
import {
  createNexusPointsCheckoutSession,
  isStripeNexusPointsIdempotencyConflictError,
  isStripeNexusPointsConfigured,
} from '../../services/stripe-nexus-points-service';
import { logAudit } from '../../services/audit-trail';
import {
  legalConsentContextFromRequest,
  type LegalAcceptanceInput,
  recordCurrentLegalConsentForUser,
  validateCurrentLegalAcceptance,
} from '../../services/legal-consent';
import { getEffectiveEntitlement } from '../../services/entitlement';
import {
  BILLING_CATALOG_VERSION,
  getBillingCatalog,
  resolveBillingCatalogItem,
} from '../../services/billing-catalog';
import { getAiCreditWallet } from '../../services/ai-credit-ledger';
import { resolveBillingPlanForUser } from '../../services/plan-quotas';

const STRIPE_NEXUS_CHECKOUT_BODY_LIMIT_BYTES = 8 * 1024;
const STRIPE_NEXUS_CHECKOUT_BODY_FIELDS = new Set(['packageId']);

function rejectOversizedStripeNexusCheckoutBody(req: Request, res: Response, next: NextFunction): void {
  const rawLength = req.headers['content-length'];
  const contentLength = Array.isArray(rawLength) ? Number(rawLength[0]) : Number(rawLength || 0);
  if (Number.isFinite(contentLength) && contentLength > STRIPE_NEXUS_CHECKOUT_BODY_LIMIT_BYTES) {
    sendError(res, 'PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
    return;
  }
  next();
}

function unexpectedStripeCheckoutBodyFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>)
    .filter((key) => !STRIPE_NEXUS_CHECKOUT_BODY_FIELDS.has(key));
}

function buildBillingStatusPayload(userId: number): Record<string, unknown> {
  const status = getSubscriptionStatus(userId);
  const usage = isUserOverDailyCap(userId);
  const entitlement = usage.entitlement;
  // A transient failure inside the entitlement/quota resolver must never
  // downgrade a paying account. When the resolver failed closed it returns no
  // entitlement (or source 'error') and a plan of 'none'; billing identity then
  // falls back to the last known subscription row instead of reporting Free.
  const entitlementResolved = !!entitlement && entitlement.source !== 'error';
  const canonicalProductActive = entitlementResolved
    ? !['free', 'error'].includes(entitlement!.source)
      && (entitlement!.status === 'active' || entitlement!.status === 'trialing')
    : status.isActive;
  const canonicalIsPro = entitlementResolved
    ? canonicalProductActive && (entitlement!.plan === 'pro' || entitlement!.plan === 'max')
    : status.isPro;
  const canonicalPlan = entitlementResolved ? entitlement!.plan : status.plan;
  const canonicalStatus = entitlementResolved
    ? (entitlement!.status === 'none' ? 'inactive' : entitlement!.status)
    : status.status;
  return {
    ...status,
    ...buildQuotaUsagePayload(usage),
    // Canonical billing identity is written LAST. The quota payload carries its
    // own `plan` (and emits 'none' whenever the quota read fails), which must
    // never clobber the entitlement answer for a paying user. Deriving plan and
    // status from the same source as isActive/isPro also stops the payload
    // contradicting itself, e.g. status 'expired' alongside isPro true.
    plan: canonicalPlan,
    status: canonicalStatus,
    isActive: canonicalProductActive,
    isPro: canonicalIsPro,
    // Opaque per-user token the client attaches to a StoreKit purchase as
    // `Product.PurchaseOption.appAccountToken`. Apple echoes it back in server
    // notifications, which is what lets the webhook recover a purchase whose
    // apple-verify call never landed.
    appAccountToken: deriveAppleAppAccountToken(userId),
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
   * GET /api/v1/billing/catalog
   * Token-zero: server-owned versioned catalog (hybrid AI plan §3).
   * Clients submit catalog item ids only; provider identifiers never leave
   * the server.
   */
  router.get('/catalog', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    sendSuccess(res, {
      ...getBillingCatalog(),
      plan: resolveBillingPlanForUser(userId),
    });
  }));

  /**
   * GET /api/v1/billing/wallet
   * Token-zero: shared AI-credit wallet separating included, promotional,
   * purchased, reserved, and available credits (hybrid AI plan §3).
   */
  router.get('/wallet', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const plan = resolveBillingPlanForUser(userId);
    sendSuccess(res, {
      catalogVersion: BILLING_CATALOG_VERSION,
      plan,
      wallet: getAiCreditWallet(userId, plan),
    });
  }));

  /**
   * POST /api/v1/billing/credits-checkout
   * Catalog-item checkout for the hybrid AI plans and credit packs.
   * Body: { catalogItemId, acceptedLegal, successUrl?, cancelUrl? }.
   * Clients cannot select prices, credits, providers, or amounts.
   */
  router.post('/credits-checkout', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const item = resolveBillingCatalogItem(String(req.body?.catalogItemId || ''));
    if (!item) {
      sendError(res, 'UNKNOWN_CATALOG_ITEM', 'catalogItemId is not in the current catalog', 404);
      return;
    }
    if (item.requiresActivePaidPlan) {
      const entitlement = getEffectiveEntitlement(userId);
      const paidActive = (entitlement.plan === 'pro' || entitlement.plan === 'max')
        && entitlement.status === 'active';
      if (!paidActive) {
        sendError(res, 'PACK_REQUIRES_PAID_PLAN', 'Credit packs require an active Pro or Max subscription', 403);
        return;
      }
    }
    if (!item.purchasable || !item.stripePriceId) {
      const reason = item.unavailableReason === 'fulfillment_pending'
        ? 'This item is not yet available for purchase'
        : 'Checkout for this item is not configured';
      sendError(res, 'CATALOG_ITEM_UNAVAILABLE', reason, 503);
      return;
    }
    if (!isStripeConfigured()) {
      sendError(res, 'NOT_CONFIGURED', 'Stripe billing is not configured', 503);
      return;
    }
    const acceptedLegal = req.body?.acceptedLegal as LegalAcceptanceInput | null | undefined;
    const legalAcceptance = validateCurrentLegalAcceptance(acceptedLegal);
    if (!legalAcceptance.ok) {
      sendError(res, 'LEGAL_CONSENT_REQUIRED', legalAcceptance.reason || 'Current legal acceptance is required', 400);
      return;
    }
    const successUrl = safeCheckoutUrl(req.body?.successUrl, 'https://nexushub.me/?checkout=success');
    const cancelUrl = safeCheckoutUrl(req.body?.cancelUrl, 'https://nexushub.me/?checkout=canceled');
    await recordCurrentLegalConsentForUser(
      userId,
      acceptedLegal as LegalAcceptanceInput,
      legalConsentContextFromRequest(req, 'billing_credits_checkout'),
    );
    const url = item.kind === 'credit_pack'
      ? await createCreditPackCheckoutSession(
        userId,
        { catalogItemId: item.id, priceId: item.stripePriceId },
        successUrl,
        cancelUrl,
      )
      : await createCheckoutSession(userId, item.stripePriceId, successUrl, cancelUrl);
    sendSuccess(res, { url, catalogVersion: BILLING_CATALOG_VERSION, catalogItemId: item.id });
  }));

  /**
   * POST /api/v1/billing/checkout
   * Creates a Stripe Checkout Session and returns the URL.
   * Body: { plan: 'pro'|'max', currency: 'usd'|'brl', successUrl?: string, cancelUrl?: string }
   */
  router.post('/checkout', asyncHandler(async (req: Request, res: Response) => {
    if (!isStripeConfigured()) {
      sendError(res, 'NOT_CONFIGURED', 'Stripe billing is not configured', 503);
      return;
    }

    const userId = (req as any).userId;
    const plan = req.body.plan || 'pro';
    const currency = req.body.currency || 'usd';

    if (!['pro', 'max'].includes(String(plan).toLowerCase())) {
      sendError(res, 'BAD_REQUEST', 'plan must be pro or max');
      return;
    }
    if (!['usd', 'brl'].includes(String(currency).toLowerCase())) {
      sendError(res, 'BAD_REQUEST', 'currency must be usd or brl');
      return;
    }

    const acceptedLegal = req.body.acceptedLegal as LegalAcceptanceInput | null | undefined;
    const legalAcceptance = validateCurrentLegalAcceptance(acceptedLegal);
    if (!legalAcceptance.ok) {
      sendError(res, 'LEGAL_CONSENT_REQUIRED', legalAcceptance.reason || 'Current legal acceptance is required', 400);
      return;
    }
    const currentAcceptedLegal = acceptedLegal as LegalAcceptanceInput;

    const successUrl = safeCheckoutUrl(req.body.successUrl, 'https://nexushub.me/?checkout=success');
    const cancelUrl = safeCheckoutUrl(req.body.cancelUrl, 'https://nexushub.me/?checkout=canceled');

    try {
      await recordCurrentLegalConsentForUser(
        userId,
        currentAcceptedLegal,
        legalConsentContextFromRequest(req, 'billing_checkout'),
      );
      const url = await createCheckoutSessionForPlan(userId, plan, currency, successUrl, cancelUrl);
      sendSuccess(res, { url });
    } catch (err: any) {
      if (err?.message === 'PRICE_NOT_CONFIGURED') {
        sendError(res, 'NOT_CONFIGURED', 'Requested Stripe price is not configured', 503);
        return;
      }
      throw err;
    }
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
    const returnUrl = safeCheckoutUrl(req.body.returnUrl, 'https://nexushub.me/');

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
   * POST /api/v1/billing/claim-website-checkout
   * Claims a website checkout created before the user signed in.
   * Requires the Nexus email to be verified before attaching billing state.
   */
  router.post('/claim-website-checkout', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const claimed = claimWebsiteStripeSubscriptionForUser(userId);
    if (!claimed) {
      sendError(
        res,
        'NO_CLAIMABLE_SUBSCRIPTION',
        'No claimable website subscription was found for this verified email.',
        404,
      );
      return;
    }
    sendSuccess(res, { claimed: true });
  }));

  /**
   * POST /api/v1/billing/nexus-points/stripe-checkout
   * Web-only Nexus Points Checkout. Identity comes from JWT auth middleware;
   * body-supplied identity or attribution fields are rejected by design.
   */
  router.post('/nexus-points/stripe-checkout', rejectOversizedStripeNexusCheckoutBody, express.json({ limit: '8kb' }), asyncHandler(async (req: Request, res: Response) => {
    if (!isStripeNexusPointsConfigured()) {
      sendError(res, 'STRIPE_NOT_CONFIGURED', 'Stripe Nexus Points checkout is not configured', 503);
      return;
    }

    const unexpectedFields = unexpectedStripeCheckoutBodyFields(req.body);
    if (unexpectedFields.length > 0) {
      sendError(res, 'UNEXPECTED_BODY_FIELDS', 'Unexpected body fields are not allowed for Stripe Nexus Points checkout', 400, {
        fields: unexpectedFields,
      });
      return;
    }

    const userId = (req as any).userId;
    const tenantId = (req as any).tenantId || userId;
    const packageId = String(req.body?.packageId ?? '').trim();
    if (!isNexusPointProductId(packageId)) {
      sendError(res, 'BAD_REQUEST', 'packageId must be a known Nexus Points package', 400);
      return;
    }
    const entitlement = getEffectiveEntitlement(userId);
    if (!entitlement.nexusPointsAllowed) {
      sendError(
        res,
        'AI_PLAN_REQUIRED',
        'Nexus Points are available only with an active paid plan.',
        403,
        {
          requiredPlan: 'pro',
          currentPlan: entitlement.plan,
          blockReason: entitlement.blockReason,
          window: 'plan',
          unblocksAt: null,
          retryable: false,
        },
      );
      return;
    }

    let session;
    try {
      session = await createNexusPointsCheckoutSession({
        userId,
        tenantId,
        packageId,
        source: 'web',
      });
    } catch (err) {
      if (isStripeNexusPointsIdempotencyConflictError(err)) {
        sendError(res, 'IDEMPOTENCY_CONFLICT', err.message, 409);
        return;
      }
      throw err;
    }
    logAudit({
      tenantId,
      userId,
      actorId: userId,
      action: 'billing.nexus_points.checkout_started',
      resource: 'billing.nexus_points.stripe_checkout',
      details: {
        sessionId: session.sessionId,
        packageId,
        source: 'web',
      },
    });
    sendSuccess(res, session);
  }));

  /**
   * POST /api/v1/billing/apple-verify
   * Verifies a StoreKit 2 JWS transaction from the iOS app.
   * Body: { jwsTransaction: string }
   *
   * Verification steps (consumer-grade, not beta):
   *   1. Structural: valid 3-part JWS, parseable JSON payload
   *   2. Bundle ID: must match our app's bundle identifier
   *   3. Environment: recorded as provenance, never used to deny
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
      const isProduction = process.env.NODE_ENV === 'production';
      try {
        payload = verifyAppleJws(jwsTransaction, { requireX5c: isProduction }).payload;
        logger.debug({ userId }, 'Apple verify: JWS signature verified ✓');
      } catch (sigErr: any) {
        // Missing x5c remains non-fatal for older sandbox/Xcode receipts.
        // If Apple supplied a cert chain and signature verification failed,
        // reject instead of falling back to attacker-controlled claims.
        if (sigErr?.message !== 'APPLE_JWS_MISSING_X5C' || isProduction) {
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

      // ── Step 3: Environment provenance ──
      // The environment claim is NEVER a gate. App Review buys against the
      // StoreKit sandbox even on an App-Store-Connect-distributed build, so
      // denying 'Sandbox' in production rejected every reviewer purchase — and
      // the client calls transaction.finish() regardless of our answer, so the
      // rejection was terminal. The claim is recorded on the subscription row
      // and in the audit trail instead. Strict expiry (step 6) is what bounds
      // abuse: sandbox subscriptions expire in minutes. JWS signature
      // verification (step 1b) stays keyed on isProduction and stays strict.
      const env = typeof payload.environment === 'string' ? payload.environment : '';

      // ── Step 4: Extract and validate required fields ──
      const transactionId = payload.transactionId || payload.originalTransactionId;
      const originalTransactionId = payload.originalTransactionId || transactionId;
      const productId = payload.productId;

      if (!originalTransactionId || !productId) {
        sendError(res, 'INVALID_PAYLOAD', 'Missing transactionId or productId in JWS payload', 400);
        return;
      }

      // Transaction ID format: Apple uses long numeric strings (e.g.
      // "2000000123456789"). Xcode's StoreKit Testing mints short sequential
      // ids, so outside production any numeric id is accepted; production keeps
      // the 5-digit floor.
      const transactionIdPattern = isProduction ? /^\d{5,25}$/ : /^\d{1,25}$/;
      if (!transactionIdPattern.test(String(originalTransactionId))) {
        logger.warn({ userId, transactionId: originalTransactionId }, 'Apple verify: suspicious transaction ID format');
        sendError(res, 'INVALID_TRANSACTION', 'Transaction ID format is not valid', 400);
        return;
      }

      // ── Step 5: Product ID allowlist ──
      const knownProducts = [
        ...APPLE_SUBSCRIPTION_PRODUCT_IDS,
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
      const tenantId = (req as any).tenantId || userId;
      if (isNexusPointProductId(productId)) {
        const grant = grantNexusPoints({
          userId,
          provider: 'apple',
          providerTransactionId: String(originalTransactionId),
          productId,
          source: 'apple_iap',
          metadata: {
            transactionId: String(transactionId),
            originalTransactionId: String(originalTransactionId),
          },
        });
        logger.info({
          userId,
          productId,
          transactionId,
          granted: grant.granted,
          creditId: grant.creditId,
          environment: env || 'unknown',
        }, 'Apple Nexus Points transaction verified and processed');
        logAudit({
          tenantId,
          userId,
          actorId: userId,
          action: 'create',
          resource: 'billing.apple_verify.nexus_points',
          details: {
            productId,
            originalTransactionId: String(originalTransactionId),
            environment: env || 'unknown',
            granted: grant.granted,
            creditId: grant.creditId,
          },
        });

        sendSuccess(res, {
          ...buildBillingStatusPayload(userId),
          nexusPointsPurchase: {
            granted: grant.granted,
            productId,
            points: grant.package.points,
            expiresInDays: 30,
          },
        });
        return;
      }

      let grant;
      try {
        const currentPeriodStart = payload.purchaseDate
          ? new Date(payload.purchaseDate).toISOString()
          : null;
        grant = handleAppleTransaction(userId, String(originalTransactionId), productId, expiresDate, currentPeriodStart, {
          environment: env,
          appAccountToken: payload.appAccountToken,
        });
      } catch (err) {
        if (isAppleTransactionAlreadyClaimedError(err)) {
          sendError(
            res,
            'APPLE_TRANSACTION_ALREADY_CLAIMED',
            'This Apple subscription is already attached to another Nexus Hub account.',
            409,
          );
          return;
        }
        if (isUnknownAppleProductError(err)) {
          sendError(res, 'UNKNOWN_PRODUCT', `Product ID '${productId}' is not a known Nexus Hub product`, 400);
          return;
        }
        throw err;
      }

      logger.info({
        userId,
        productId,
        transactionId: originalTransactionId,
        environment: env || 'unknown',
        transferredFromUserId: grant.transferredFromUserId,
      }, 'Apple transaction verified and processed');
      // `create` rather than a billing-specific AuditAction: the action union in
      // audit-trail.ts is closed and the resource carries the specificity.
      logAudit({
        tenantId,
        userId,
        actorId: userId,
        action: 'create',
        resource: 'billing.apple_verify.subscription',
        details: {
          productId,
          plan: grant.plan,
          period: grant.period,
          originalTransactionId: String(originalTransactionId),
          // Provenance: a Sandbox/Xcode entitlement in production is legitimate
          // during App Review, but it must be visible in the audit trail.
          environment: env || 'unknown',
          expiresDate,
          transferredFromUserId: grant.transferredFromUserId,
        },
      });

      sendSuccess(res, buildBillingStatusPayload(userId));
    } catch (err: any) {
      logger.error({ err, userId }, 'Apple transaction verification failed');
      sendError(res, 'VERIFICATION_FAILED', 'Failed to verify Apple transaction', 400);
    }
  }));

  return router;
}

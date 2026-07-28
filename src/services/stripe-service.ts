// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Stripe Billing Service
 *
 * Manages web-based subscriptions via Stripe Checkout + Customer Portal.
 * Writes to the `subscriptions` SQLite table (single source of truth shared
 * with Apple IAP). The iOS app reads status via GET /api/v1/billing/status.
 *
 * Token-zero: no AI pipeline involved. Pure REST CRUD on the subscriptions
 * table, orchestrated by Stripe webhook events.
 */

import crypto from 'crypto';
import StripeLib from 'stripe';
import { config } from '../config';
import { getDb } from './database';
import { isPublicEmailSyntaxValid, normalizePublicEmail } from './waitlist-email-validation';
import { hashEmail } from '../utils/identity';
import { logger } from '../utils/logger';
import { isNexusPointProductId, revokeNexusPointsCredit } from './nexus-points';
import { recordOperatorAlert } from './operator-alerts';
import {
  sendCancellationConfirmation,
  sendPaymentFailed,
  sendPaymentReceipt,
} from './email-sender';

// Stripe v17+ uses a different export shape. The namespace for types
// is accessed via the default export's type definitions.
type StripeInstance = InstanceType<typeof StripeLib>;
const STRIPE_API_VERSION = '2026-03-25.dahlia' as const;

// ── Types ───────────────────────────────────────────────────────────

export interface SubscriptionStatus {
  plan: string;
  period: string;
  status: string;
  provider: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  isActive: boolean;
  isPro: boolean;
}

export type StripeBillingPlan = 'pro' | 'max';
export type StripeBillingCurrency = 'usd' | 'brl';

// Price ID → plan mapping. The env vars hold Stripe price_xxx IDs;
// this map resolves them to our internal plan names on webhooks.
function resolvePlan(priceId: string): { plan: string; period: string } | null {
  const { stripe: s } = config;
  const matches = (configuredPriceId: string | undefined): boolean => !!configuredPriceId && priceId === configuredPriceId;
  // USD prices
  if (matches(s.priceProMonthly)) return { plan: 'pro', period: 'monthly' };
  if (matches(s.priceProYearly))  return { plan: 'pro', period: 'yearly' };
  if (matches(s.priceMaxMonthly)) return { plan: 'max', period: 'monthly' };
  if (matches(s.priceMaxYearly))  return { plan: 'max', period: 'yearly' };
  // BRL prices
  if (matches(s.priceProMonthlyBrl)) return { plan: 'pro', period: 'monthly' };
  if (matches(s.priceProYearlyBrl))  return { plan: 'pro', period: 'yearly' };
  if (matches(s.priceMaxMonthlyBrl)) return { plan: 'max', period: 'monthly' };
  if (matches(s.priceMaxYearlyBrl))  return { plan: 'max', period: 'yearly' };
  return null;
}

export function resolveStripePriceId(plan: string, currency: string): string | null {
  const normalizedPlan = String(plan || '').toLowerCase();
  const normalizedCurrency = String(currency || '').toLowerCase();
  const { stripe: s } = config;

  if (normalizedPlan === 'pro' && normalizedCurrency === 'usd') return s.priceProMonthly || null;
  if (normalizedPlan === 'pro' && normalizedCurrency === 'brl') return s.priceProMonthlyBrl || null;
  if (normalizedPlan === 'max' && normalizedCurrency === 'usd') return s.priceMaxMonthly || null;
  if (normalizedPlan === 'max' && normalizedCurrency === 'brl') return s.priceMaxMonthlyBrl || null;
  return null;
}

function assertCheckoutPlanCurrency(plan: string, currency: string): {
  plan: StripeBillingPlan;
  currency: StripeBillingCurrency;
  priceId: string;
} {
  const normalizedPlan = String(plan || '').toLowerCase();
  const normalizedCurrency = String(currency || '').toLowerCase();
  if (!['pro', 'max'].includes(normalizedPlan)) {
    throw new Error('INVALID_PLAN');
  }
  if (!['usd', 'brl'].includes(normalizedCurrency)) {
    throw new Error('INVALID_CURRENCY');
  }

  const priceId = resolveStripePriceId(normalizedPlan, normalizedCurrency);
  if (!priceId) throw new Error('PRICE_NOT_CONFIGURED');
  return {
    plan: normalizedPlan as StripeBillingPlan,
    currency: normalizedCurrency as StripeBillingCurrency,
    priceId,
  };
}

function upsertStripeSubscription(input: {
  userId: number;
  plan: string;
  period: string;
  status: string;
  subscriptionId: string;
  customerId: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan, period, status, provider, provider_subscription_id,
      provider_customer_id, current_period_start, current_period_end,
      cancel_at_period_end, updated_at
    )
    VALUES (?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = excluded.period,
      status = excluded.status,
      provider = 'stripe',
      provider_subscription_id = excluded.provider_subscription_id,
      provider_customer_id = COALESCE(excluded.provider_customer_id, provider_customer_id),
      current_period_start = COALESCE(excluded.current_period_start, current_period_start),
      current_period_end = COALESCE(excluded.current_period_end, current_period_end),
      cancel_at_period_end = excluded.cancel_at_period_end,
      updated_at = datetime('now')
  `).run(
    input.userId,
    input.plan,
    input.period,
    input.status,
    input.subscriptionId,
    input.customerId,
    input.currentPeriodStart ?? null,
    input.currentPeriodEnd ?? null,
    input.cancelAtPeriodEnd ?? 0,
  );
}

function stripeTimestampToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000).toISOString();
}

function primarySubscriptionItem(subscription: any): any | null {
  const item = subscription?.items?.data?.[0];
  return item && typeof item === 'object' ? item : null;
}

interface BillingEmailContext {
  userId: number;
  email: string | null;
  firstName: string | null;
  plan: string;
  period: string;
}

function getBillingEmailContextForUser(userId: number): BillingEmailContext | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      s.user_id AS userId,
      s.plan,
      s.period,
      u.email,
      u.first_name AS firstName
    FROM subscriptions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ?
      AND s.provider = 'stripe'
    LIMIT 1
  `).get(userId) as BillingEmailContext | undefined;
  return row ?? null;
}

function getBillingEmailContextForCustomer(customerId: string): BillingEmailContext | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      s.user_id AS userId,
      s.plan,
      s.period,
      u.email,
      u.first_name AS firstName
    FROM subscriptions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.provider_customer_id = ?
      AND s.provider = 'stripe'
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT 1
  `).get(customerId) as BillingEmailContext | undefined;
  return row ?? null;
}

function queuePaymentEmail(kind: string, to: string, send: Promise<boolean>): void {
  send.catch((err) => {
    logger.warn({ err, kind, toHash: hashEmail(to, 16) }, 'Stripe payment email send failed');
  });
}

// ── Singleton ───────────────────────────────────────────────────────

let stripeClient: StripeInstance | null = null;

function getStripe(): StripeInstance {
  if (!stripeClient) {
    if (!config.stripe.secretKey) {
      throw new Error('Stripe not configured (STRIPE_SECRET_KEY missing)');
    }
    stripeClient = new StripeLib(config.stripe.secretKey, {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return stripeClient;
}

export function isStripeConfigured(): boolean {
  return !!(config.stripe.secretKey && config.stripe.webhookSecret);
}

// ── Subscription Status ─────────────────────────────────────────────

function normalizeStoredBillingTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const normalizedInput = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const milliseconds = Date.parse(normalizedInput);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function getSubscriptionStatus(userId: number): SubscriptionStatus {
  const db = getDb();
  const row = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId) as any;

  if (!row || row.status === 'inactive' || row.status === 'expired') {
    return {
      plan: 'free', period: 'monthly', status: 'inactive', provider: 'none',
      currentPeriodEnd: null, cancelAtPeriodEnd: false,
      isActive: false, isPro: false,
    };
  }

  const normalizedPeriodEnd = normalizeStoredBillingTimestamp(row.current_period_end);
  const currentPeriodEndMs = normalizedPeriodEnd ? Date.parse(normalizedPeriodEnd) : NaN;
  const periodExpired = Number.isFinite(currentPeriodEndMs) && currentPeriodEndMs <= Date.now();
  if (['active', 'trialing'].includes(row.status) && periodExpired) {
    return {
      plan: 'free', period: 'monthly', status: 'expired', provider: row.provider,
      currentPeriodEnd: normalizedPeriodEnd, cancelAtPeriodEnd: !!row.cancel_at_period_end,
      isActive: false, isPro: false,
    };
  }

  const isActive = ['active', 'trialing'].includes(row.status);
  return {
    plan: row.plan,
    period: row.period,
    status: row.status,
    provider: row.provider,
    currentPeriodEnd: normalizedPeriodEnd,
    cancelAtPeriodEnd: !!row.cancel_at_period_end,
    isActive,
    isPro: isActive && (row.plan === 'pro' || row.plan === 'max'),
  };
}

// ── Checkout Session ────────────────────────────────────────────────

export async function createCheckoutSession(
  userId: number,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const stripe = getStripe();

  // Look up existing Stripe customer for this user
  const db = getDb();
  const existing = db.prepare(
    "SELECT provider_customer_id FROM subscriptions WHERE user_id = ? AND provider = 'stripe'"
  ).get(userId) as { provider_customer_id: string } | undefined;

  const sessionParams: any = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId: String(userId) },
    subscription_data: {
      metadata: { userId: String(userId) },
    },
  };

  // Reuse existing Stripe customer if we have one
  if (existing?.provider_customer_id) {
    sessionParams.customer = existing.provider_customer_id;
  } else {
    sessionParams.customer_creation = 'always';
  }

  const session = await stripe.checkout.sessions.create(sessionParams);
  if (!session.url) throw new Error('Stripe returned no checkout URL');

  logger.info({ userId, priceId, sessionId: session.id }, 'Stripe checkout session created');
  return session.url;
}

export async function createCheckoutSessionForPlan(
  userId: number,
  plan: string,
  currency: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const resolved = assertCheckoutPlanCurrency(plan, currency);
  return createCheckoutSession(userId, resolved.priceId, successUrl, cancelUrl);
}

export async function createPublicCheckoutSession(input: {
  email: string;
  plan: string;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const normalizedEmail = normalizePublicEmail(input.email);
  if (!normalizedEmail || !isPublicEmailSyntaxValid(normalizedEmail)) {
    throw new Error('INVALID_EMAIL');
  }

  const resolved = assertCheckoutPlanCurrency(input.plan, input.currency);
  const stripe = getStripe();
  const emailHash = hashEmail(normalizedEmail);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: normalizedEmail,
    line_items: [{ price: resolved.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: {
      email: normalizedEmail,
      emailHash,
      plan: resolved.plan,
      currency: resolved.currency,
      source: 'website',
    },
    subscription_data: {
      metadata: {
        email: normalizedEmail,
        emailHash,
        plan: resolved.plan,
        currency: resolved.currency,
        source: 'website',
      },
    },
  });
  if (!session.url) throw new Error('Stripe returned no checkout URL');

  const db = getDb();
  db.prepare(`
    INSERT INTO stripe_web_checkouts (
      email, email_hash, plan, currency, price_id, status,
      stripe_checkout_session_id, user_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'created', ?, ?, datetime('now'))
  `).run(
    normalizedEmail,
    emailHash,
    resolved.plan,
    resolved.currency,
    resolved.priceId,
    session.id,
    null,
  );

  logger.info({
    emailHash: hashEmail(normalizedEmail, 16),
    plan: resolved.plan,
    currency: resolved.currency,
    sessionId: session.id,
  }, 'Public Stripe checkout session created');

  return session.url;
}

// ── Customer Portal ─────────────────────────────────────────────────

export async function createPortalSession(userId: number, returnUrl: string): Promise<string> {
  const stripe = getStripe();
  const db = getDb();
  const row = db.prepare(
    "SELECT provider_customer_id FROM subscriptions WHERE user_id = ? AND provider = 'stripe'"
  ).get(userId) as { provider_customer_id: string } | undefined;

  if (!row?.provider_customer_id) {
    throw new Error('No Stripe customer found for this user');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: row.provider_customer_id,
    return_url: returnUrl,
  });

  return session.url;
}

// ── Webhook Handlers ────────────────────────────────────────────────

export function handleCheckoutCompleted(session: any): void {
  const userId = parseInt(session.metadata?.userId || '0', 10);
  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;
  const customerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id;

  if (!subscriptionId) {
    logger.warn({ sessionId: session.id }, 'checkout.session.completed with no subscription');
    return;
  }

  const db = getDb();
  const metadataEmail = typeof session.metadata?.email === 'string'
    ? session.metadata.email.toLowerCase()
    : typeof session.customer_email === 'string'
      ? session.customer_email.toLowerCase()
      : null;
  const resolvedUserId = userId || null;

  if (metadataEmail) {
    db.prepare(`
      UPDATE stripe_web_checkouts
         SET status = 'completed',
             stripe_customer_id = ?,
             stripe_subscription_id = ?,
             updated_at = datetime('now')
       WHERE stripe_checkout_session_id = ?
          OR email_hash = ?
    `).run(customerId || null, subscriptionId, session.id, hashEmail(metadataEmail));
  }

  if (!resolvedUserId) {
    logger.info({ sessionId: session.id, emailHash: metadataEmail ? hashEmail(metadataEmail, 16) : null }, 'Stripe checkout completed before Nexus user exists');
    return;
  }

  const plan = typeof session.metadata?.plan === 'string' ? session.metadata.plan : 'pro';
  upsertStripeSubscription({
    userId: resolvedUserId,
    plan,
    period: 'monthly',
    status: 'active',
    subscriptionId,
    customerId: customerId || null,
  });

  const billingEmail = getBillingEmailContextForUser(resolvedUserId);
  if (billingEmail?.email) {
    queuePaymentEmail('receipt', billingEmail.email, sendPaymentReceipt({
      to: billingEmail.email,
      firstName: billingEmail.firstName,
      plan: billingEmail.plan,
      period: billingEmail.period,
      checkoutSessionId: session.id,
    }));
  }

  logger.info({ userId: resolvedUserId, subscriptionId, customerId }, 'Stripe checkout completed — subscription activated');
}

export function handleSubscriptionUpdated(subscription: any): void {
  const metadataEmail = typeof subscription.metadata?.email === 'string'
    ? subscription.metadata.email.toLowerCase()
    : null;
  let userId = parseInt(subscription.metadata?.userId || '0', 10) || 0;

  // Resolve plan from the first line item's price
  const priceId = subscription.items?.data?.[0]?.price?.id || '';
  const resolvedPlan = resolvePlan(priceId);
  if (!resolvedPlan) {
    logger.warn({ subId: subscription.id, priceId }, 'Stripe subscription update skipped: unknown price id');
    return;
  }
  const { plan, period } = resolvedPlan;

  const status = subscription.status; // 'active', 'past_due', 'canceled', 'trialing', etc.
  const primaryItem = primarySubscriptionItem(subscription);
  const periodStart = stripeTimestampToIso(primaryItem?.current_period_start ?? subscription.current_period_start);
  const periodEnd = stripeTimestampToIso(primaryItem?.current_period_end ?? subscription.current_period_end);
  const cancelAtEnd = subscription.cancel_at_period_end ? 1 : 0;

  const db = getDb();
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id ?? null;

  if (!userId) {
    const claimed = db.prepare(`
      SELECT user_id FROM stripe_web_checkouts
      WHERE (stripe_subscription_id = ? OR stripe_customer_id = ?)
        AND user_id IS NOT NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(subscription.id, customerId || '') as { user_id: number | null } | undefined;
    userId = claimed?.user_id ?? 0;
  }

  if (!userId) {
    db.prepare(`
      UPDATE stripe_web_checkouts
         SET status = ?,
             stripe_customer_id = COALESCE(?, stripe_customer_id),
             stripe_subscription_id = ?,
             updated_at = datetime('now')
       WHERE stripe_subscription_id = ?
          OR stripe_customer_id = ?
          OR email_hash = ?
    `).run(status, customerId, subscription.id, subscription.id, customerId, metadataEmail ? hashEmail(metadataEmail) : '__missing__');
    logger.info({ subId: subscription.id, emailHash: metadataEmail ? hashEmail(metadataEmail, 16) : null }, 'Stripe subscription updated before Nexus user exists');
    return;
  }

  upsertStripeSubscription({
    userId,
    plan,
    period,
    status,
    subscriptionId: subscription.id,
    customerId,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: cancelAtEnd,
  });

  if (metadataEmail) {
    db.prepare(`
      UPDATE stripe_web_checkouts
         SET status = ?,
             stripe_customer_id = COALESCE(?, stripe_customer_id),
             stripe_subscription_id = ?,
             user_id = ?,
             updated_at = datetime('now')
       WHERE stripe_subscription_id = ?
          OR stripe_customer_id = ?
          OR email_hash = ?
    `).run(status, customerId, subscription.id, userId, subscription.id, customerId, hashEmail(metadataEmail));
  }

  logger.info({ userId, plan, period, status, subId: subscription.id }, 'Stripe subscription updated');
}

export function handleSubscriptionDeleted(subscription: any): void {
  let userId = parseInt(subscription.metadata?.userId || '0', 10);

  const db = getDb();
  if (!userId) {
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    const row = db.prepare(`
      SELECT user_id FROM stripe_web_checkouts
      WHERE stripe_subscription_id = ? OR stripe_customer_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(subscription.id, customerId || '') as { user_id: number | null } | undefined;
    userId = row?.user_id ?? 0;
    if (!userId) {
      const subRow = db.prepare(`
        SELECT user_id FROM subscriptions
        WHERE provider = 'stripe'
          AND (provider_subscription_id = ? OR provider_customer_id = ?)
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(subscription.id, customerId || '') as { user_id: number | null } | undefined;
      userId = subRow?.user_id ?? 0;
    }
  }
  if (!userId) return;

  const billingEmail = getBillingEmailContextForUser(userId);
  db.prepare(`
    UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 1, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'stripe'
  `).run(userId);
  try {
    db.prepare("UPDATE users SET tier = 'free' WHERE id = ? AND tier IN ('pro', 'max')").run(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'Stripe subscription deleted: failed to reconcile stale users.tier');
  }

  if (billingEmail?.email) {
    queuePaymentEmail('cancellation', billingEmail.email, sendCancellationConfirmation({
      to: billingEmail.email,
      firstName: billingEmail.firstName,
      plan: billingEmail.plan,
      period: billingEmail.period,
    }));
  }

  logger.info({ userId, subId: subscription.id }, 'Stripe subscription deleted/canceled');
}

export function handleInvoicePaymentFailed(invoice: any): void {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  const db = getDb();
  const billingEmail = getBillingEmailContextForCustomer(customerId);
  db.prepare(`
    UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now')
    WHERE provider_customer_id = ? AND provider = 'stripe'
  `).run(customerId);

  if (billingEmail?.email) {
    queuePaymentEmail('payment_failed', billingEmail.email, sendPaymentFailed({
      to: billingEmail.email,
      firstName: billingEmail.firstName,
      plan: billingEmail.plan,
      period: billingEmail.period,
      invoiceId: invoice.id ?? null,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    }));
  }

  logger.warn({ customerId, invoiceId: invoice.id }, 'Stripe invoice payment failed — subscription past_due');
}

export function hasProcessedStripeWebhookEvent(eventId: string): boolean {
  if (!eventId) return false;
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM stripe_webhook_events WHERE event_id = ?').get(eventId);
  return !!row;
}

export function markStripeWebhookEventProcessed(eventId: string, eventType: string): void {
  if (!eventId) return;
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type, processed_at)
    VALUES (?, ?, datetime('now'))
  `).run(eventId, eventType || 'unknown');
}

export function claimWebsiteStripeSubscriptionForUser(userId: number): boolean {
  const db = getDb();
  const user = db.prepare('SELECT email, email_verified FROM users WHERE id = ?').get(userId) as
    | { email: string | null; email_verified: number | null }
    | undefined;
  const normalizedEmail = normalizePublicEmail(user?.email || '');
  if (!normalizedEmail || user?.email_verified !== 1) return false;

  const row = db.prepare(`
    SELECT plan, stripe_customer_id, stripe_subscription_id
    FROM stripe_web_checkouts
    WHERE email_hash = ?
      AND stripe_subscription_id IS NOT NULL
      AND (user_id IS NULL OR user_id = ?)
      AND status IN ('completed', 'active', 'trialing')
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(hashEmail(normalizedEmail), userId) as
    | { plan: string; stripe_customer_id: string | null; stripe_subscription_id: string | null }
    | undefined;

  if (!row?.stripe_subscription_id) return false;

  upsertStripeSubscription({
    userId,
    plan: row.plan || 'pro',
    period: 'monthly',
    status: 'active',
    subscriptionId: row.stripe_subscription_id,
    customerId: row.stripe_customer_id,
  });

  db.prepare(`
    UPDATE stripe_web_checkouts
       SET user_id = ?, updated_at = datetime('now')
     WHERE email_hash = ?
  `).run(userId, hashEmail(normalizedEmail));

  logger.info({ userId, emailHash: hashEmail(normalizedEmail, 16) }, 'Claimed website Stripe checkout for verified Nexus user');
  return true;
}

// ── Apple IAP Verification ──────────────────────────────────────────
// Called by POST /api/v1/billing/apple-verify when StoreKit 2 sends a
// signed JWS transaction. We decode the payload (trusting the Apple
// certificate chain) and UPSERT to the same subscriptions table.

/**
 * Apple subscription catalog. This used to be substring matching that fell
 * through to Pro monthly for every unrecognised id, so a typo or a not-yet-
 * mapped product silently granted Pro. The map is now exhaustive and unknown
 * ids resolve to null — callers must refuse the grant rather than guess.
 */
const APPLE_SUBSCRIPTION_PRODUCTS: Readonly<Record<string, { plan: string; period: string }>> = {
  'me.nexushub.pro.monthly': { plan: 'pro', period: 'monthly' },
  'me.nexushub.pro.yearly':  { plan: 'pro', period: 'yearly' },
  'me.nexushub.max.monthly': { plan: 'max', period: 'monthly' },
  'me.nexushub.max.yearly':  { plan: 'max', period: 'yearly' },
};

/** Product allowlist shared with the apple-verify route. */
export const APPLE_SUBSCRIPTION_PRODUCT_IDS: readonly string[] = Object.freeze(
  Object.keys(APPLE_SUBSCRIPTION_PRODUCTS),
);

export function resolveAppleProduct(productId: string): { plan: string; period: string } | null {
  return APPLE_SUBSCRIPTION_PRODUCTS[productId] ?? null;
}

export class UnknownAppleProductError extends Error {
  constructor(public readonly productId: string) {
    super('UNKNOWN_APPLE_PRODUCT');
    this.name = 'UnknownAppleProductError';
  }
}

export function isUnknownAppleProductError(err: unknown): err is UnknownAppleProductError {
  return err instanceof UnknownAppleProductError
    || (err instanceof Error && err.name === 'UnknownAppleProductError');
}

export class AppleTransactionAlreadyClaimedError extends Error {
  constructor(public readonly originalTransactionId: string) {
    super('APPLE_TRANSACTION_ALREADY_CLAIMED');
    this.name = 'AppleTransactionAlreadyClaimedError';
  }
}

export function isAppleTransactionAlreadyClaimedError(
  err: unknown,
): err is AppleTransactionAlreadyClaimedError {
  return err instanceof AppleTransactionAlreadyClaimedError
    || (err instanceof Error && err.name === 'AppleTransactionAlreadyClaimedError');
}

// ── appAccountToken ─────────────────────────────────────────────────
// StoreKit lets the client attach an opaque UUID to a purchase. Apple echoes
// it in the transaction JWS *and* in every App Store Server Notification for
// that subscription, which is the only way to map a notification back to a
// Nexus user when `apple-verify` never succeeded (network drop, 5xx, app kill).
//
// The token is derived, not stored, so no extra table or purchase-time write is
// needed. Layout (16 bytes rendered as a UUID): 1 version byte, 4 big-endian
// user-id bytes, 11 bytes of HMAC-SHA256 tag over the first 5. The tag makes
// the token unguessable and lets the server reject a fabricated mapping. It is
// not a credential: recovery still requires an Apple-signed notification, and
// the worst a forged token could do is donate someone else's purchase away.
//
// Rotating IOS_API_JWT_SECRET invalidates outstanding tokens. That is safe —
// the client re-reads the token from GET /billing/status on every launch, and
// notifications for an already-verified transaction still resolve by
// originalTransactionId.
//
// IOS_API_JWT_SECRET is the ONLY accepted key. A source-literal fallback would
// make every token derivable — and therefore forgeable — by anyone who can read
// this repo, on any host that never set the env var (its default is empty).
// Without the secret the token is simply unavailable, so a misconfigured host
// loses notification-based recovery instead of accepting spoofed user mappings.

const APPLE_APP_ACCOUNT_TOKEN_VERSION = 0x01;

function appleAppAccountTokenTag(body: Buffer): Buffer | null {
  const key = config.ios.jwtSecret;
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(body).digest().subarray(0, 11);
}

export function deriveAppleAppAccountToken(userId: number): string | null {
  if (!Number.isInteger(userId) || userId <= 0 || userId > 0xffffffff) return null;
  const body = Buffer.alloc(5);
  body.writeUInt8(APPLE_APP_ACCOUNT_TOKEN_VERSION, 0);
  body.writeUInt32BE(userId, 1);
  const tag = appleAppAccountTokenTag(body);
  if (!tag) return null;
  const hex = Buffer.concat([body, tag]).toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

export function resolveUserIdFromAppleAppAccountToken(token: unknown): number | null {
  if (typeof token !== 'string' || !config.ios.jwtSecret) return null;
  const hex = token.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.readUInt8(0) !== APPLE_APP_ACCOUNT_TOKEN_VERSION) return null;
  const userId = bytes.readUInt32BE(1);
  const expected = deriveAppleAppAccountToken(userId)?.replace(/-/g, '');
  if (!expected || expected.length !== hex.length) return null;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hex)) ? userId : null;
}

export interface AppleTransactionContext {
  /** Apple's `environment` claim ('Production' | 'Sandbox' | 'Xcode'). Provenance only. */
  environment?: string | null;
  /** Opaque per-user token echoed by Apple so notifications can be mapped back. */
  appAccountToken?: string | null;
}

export interface AppleTransactionResult {
  plan: string;
  period: string;
  environment: string | null;
  /** Set when this grant took the transaction away from a previous account. */
  transferredFromUserId: number | null;
}

function normalizeAppleEnvironment(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function upsertAppleSubscription(input: {
  userId: number;
  plan: string;
  period: string;
  originalTransactionId: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  environment: string | null;
  appAccountToken: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id, provider_customer_id, current_period_start, current_period_end, environment, cancel_at_period_end, updated_at)
    VALUES (?, ?, ?, 'active', 'apple', ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = excluded.period,
      status = 'active',
      provider = 'apple',
      provider_subscription_id = excluded.provider_subscription_id,
      -- This column holds the Apple appAccountToken, but a pre-existing Stripe
      -- row keeps its Stripe customer id here. Overwriting that would strip the
      -- only handle back to the Stripe customer, so it is only written when the
      -- row is already Apple's or the slot is empty.
      provider_customer_id = CASE
        WHEN subscriptions.provider_customer_id IS NULL OR subscriptions.provider = 'apple'
          THEN COALESCE(excluded.provider_customer_id, subscriptions.provider_customer_id)
        ELSE subscriptions.provider_customer_id
      END,
      current_period_start = COALESCE(excluded.current_period_start, current_period_start),
      current_period_end = excluded.current_period_end,
      environment = COALESCE(excluded.environment, environment),
      -- The transaction JWS carries no autoRenewStatus, so DID_CHANGE_RENEWAL_STATUS
      -- stays the only authority for turning cancellation ON: a restore must not
      -- silently re-enable auto-renew inside an already-cancelled period. A
      -- genuinely NEW period is different — it can only exist because the
      -- subscription actually renewed or was resubscribed, and Apple does not
      -- always pair that with an AUTO_RENEW_ENABLED notification. Leaving the
      -- flag latched there tells a paying subscriber their plan is ending forever.
      cancel_at_period_end = CASE
        WHEN excluded.current_period_end IS NOT NULL
         AND (subscriptions.current_period_end IS NULL
              OR excluded.current_period_end > subscriptions.current_period_end)
          THEN 0
        ELSE subscriptions.cancel_at_period_end
      END,
      updated_at = datetime('now')
  `).run(
    input.userId,
    input.plan,
    input.period,
    input.originalTransactionId,
    input.appAccountToken,
    input.currentPeriodStart,
    input.currentPeriodEnd,
    input.environment,
  );
}

export function handleAppleTransaction(
  userId: number,
  originalTransactionId: string,
  productId: string,
  expiresDate: string | null,
  currentPeriodStart: string | null = null,
  context: AppleTransactionContext = {},
): AppleTransactionResult {
  const resolved = resolveAppleProduct(productId);
  if (!resolved) {
    logger.warn({ userId, productId, originalTransactionId }, 'Apple IAP transaction refused: unmapped product id');
    throw new UnknownAppleProductError(productId);
  }
  const { plan, period } = resolved;
  const resolvedPeriodStart = currentPeriodStart ?? deriveApplePeriodStart(expiresDate, period);
  const environment = normalizeAppleEnvironment(context.environment);
  const appAccountToken = typeof context.appAccountToken === 'string' && context.appAccountToken.trim()
    ? context.appAccountToken.trim()
    : null;

  const db = getDb();
  const previousOwner = db.prepare(`
    SELECT user_id, status, current_period_end
    FROM subscriptions
    WHERE provider = 'apple'
      AND provider_subscription_id = ?
      AND user_id != ?
    LIMIT 1
  `).get(originalTransactionId, userId) as {
    user_id: number;
    status: string;
    current_period_end: string | null;
  } | undefined;

  // A stale App Review account must not make restore a permanent dead end, but
  // a valid StoreKit transaction is a bearer proof of purchase, not proof that
  // the current Nexus user owns the account that already holds it. Transfer is
  // therefore limited to a terminal or time-expired prior entitlement. An
  // active prior holder keeps the grant and receives a stable 409.
  if (previousOwner) {
    const previousPeriodEndMs = previousOwner.current_period_end
      ? Date.parse(previousOwner.current_period_end)
      : NaN;
    const previousPeriodEnded = Number.isFinite(previousPeriodEndMs)
      && previousPeriodEndMs <= Date.now();
    const previousStatusTerminal = ['inactive', 'expired', 'refunded'].includes(previousOwner.status);
    if (!previousStatusTerminal && !previousPeriodEnded) {
      logger.warn(
        {
          userId,
          existingUserId: previousOwner.user_id,
          originalTransactionId,
          productId,
          environment,
        },
        'Apple IAP transaction rejected because an active entitlement is attached to another account',
      );
      throw new AppleTransactionAlreadyClaimedError(originalTransactionId);
    }
  }

  const applyGrant = db.transaction(() => {
    if (previousOwner) {
      db.prepare(`
        UPDATE subscriptions
           SET status = 'inactive',
               provider_subscription_id = NULL,
               cancel_at_period_end = 1,
               updated_at = datetime('now')
         WHERE provider = 'apple'
           AND provider_subscription_id = ?
           AND user_id != ?
      `).run(originalTransactionId, userId);
    }
    upsertAppleSubscription({
      userId,
      plan,
      period,
      originalTransactionId,
      currentPeriodStart: resolvedPeriodStart,
      currentPeriodEnd: expiresDate,
      environment,
      appAccountToken,
    });
  });
  applyGrant();

  if (previousOwner) {
    logger.warn(
      { userId, previousUserId: previousOwner.user_id, originalTransactionId, productId, environment },
      'Apple IAP transaction transferred to the newest authenticated claimant',
    );
  }
  logger.info(
    { userId, productId, originalTransactionId, environment },
    'Apple IAP transaction verified — subscription active',
  );

  return {
    plan,
    period,
    environment,
    transferredFromUserId: previousOwner?.user_id ?? null,
  };
}

function deriveApplePeriodStart(expiresDate: string | null, period: string | null | undefined): string | null {
  if (!expiresDate) return null;
  const end = new Date(expiresDate);
  if (!Number.isFinite(end.getTime())) return null;
  const targetYear = end.getUTCFullYear() - (period === 'yearly' ? 1 : 0);
  const rawTargetMonth = end.getUTCMonth() - (period === 'yearly' ? 0 : 1);
  const normalizedYear = targetYear + Math.floor(rawTargetMonth / 12);
  const normalizedMonth = ((rawTargetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    normalizedYear,
    normalizedMonth,
    Math.min(end.getUTCDate(), lastDay),
    end.getUTCHours(),
    end.getUTCMinutes(),
    end.getUTCSeconds(),
    end.getUTCMilliseconds(),
  )).toISOString();
}

// ── Apple App Store Server Notifications V2 ───────────────────────
// Called by the public webhook POST /api/v1/billing/apple-notifications.
// Apple sends lifecycle events (renewal, expiry, refund, etc.) as
// server-to-server JWS payloads. We decode and map notification types
// to subscription status changes in the same `subscriptions` table.
//
// Reference: https://developer.apple.com/documentation/appstoreservernotifications

const APPLE_NOTIFICATION_STATUS_MAP: Record<string, string> = {
  EXPIRED:                'expired',
  DID_FAIL_TO_RENEW:     'past_due',
  REFUND:                'refunded',
  REVOKE:                'refunded',
  DID_RENEW:             'active',
  SUBSCRIBED:            'active',
  DID_CHANGE_RENEWAL_PREF: 'active',  // plan change, still active
  OFFER_REDEEMED:        'active',
  GRACE_PERIOD_EXPIRED:  'expired',
};

// DID_CHANGE_RENEWAL_STATUS is auto-renew being toggled, not a status change.
// The subtype carries the direction; the subscription stays exactly as active
// (or as expired) as it already was.
const APPLE_RENEWAL_STATUS_SUBTYPES: Record<string, number> = {
  AUTO_RENEW_DISABLED: 1,
  AUTO_RENEW_ENABLED:  0,
};

export interface AppleNotificationContext {
  /** Apple's per-notification UUID, used for replay de-duplication. */
  notificationUUID?: string | null;
  /** Notification subtype, e.g. AUTO_RENEW_DISABLED. */
  subtype?: string | null;
  /** Environment from the outer payload; the inner transaction claim wins. */
  environment?: string | null;
}

export function hasProcessedAppleNotification(notificationUUID: string): boolean {
  if (!notificationUUID) return false;
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM apple_webhook_events WHERE notification_uuid = ?').get(notificationUUID);
  return !!row;
}

export function markAppleNotificationProcessed(input: {
  notificationUUID: string;
  notificationType: string;
  subtype?: string | null;
  environment?: string | null;
}): void {
  if (!input.notificationUUID) return;
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO apple_webhook_events (notification_uuid, notification_type, subtype, environment, processed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(
    input.notificationUUID,
    input.notificationType || 'unknown',
    input.subtype ?? null,
    normalizeAppleEnvironment(input.environment),
  );
}

/**
 * Handle an Apple App Store Server Notification V2.
 *
 * Apple can deliver the same notificationUUID several times. The UUID is
 * recorded in `apple_webhook_events` (mirroring `stripe_webhook_events`) so a
 * duplicate delivery cannot re-apply a lifecycle transition.
 *
 * The ledger guards against genuine duplicate deliveries only — it is not a
 * retry mechanism. The route answers HTTP 200 for every outcome, including a
 * throw, precisely so Apple never sees a non-200, which also means Apple will
 * never retry a notification that threw here. A throw simply loses that
 * notification; reconciliation for it comes from the next lifecycle event or
 * from the client's own apple-verify call, not from an Apple retry.
 *
 * @param notificationType - The notification type from Apple's payload
 * @param signedTransactionInfo - JWS-encoded transaction info (inner JWS)
 * @param context - notificationUUID / subtype / environment from the outer payload
 * @returns true if the notification was processed, false if skipped
 */
export function handleAppleNotification(
  notificationType: string,
  signedTransactionInfo: string,
  context: AppleNotificationContext = {},
): boolean {
  const notificationUUID = typeof context.notificationUUID === 'string' && context.notificationUUID.trim()
    ? context.notificationUUID.trim()
    : null;

  if (notificationUUID && hasProcessedAppleNotification(notificationUUID)) {
    logger.info({ notificationType, notificationUUID }, 'Apple notification: duplicate notificationUUID ignored');
    return false;
  }

  const processed = applyAppleNotification(notificationType, signedTransactionInfo, context);

  if (notificationUUID) {
    markAppleNotificationProcessed({
      notificationUUID,
      notificationType,
      subtype: context.subtype ?? null,
      environment: context.environment ?? null,
    });
  }

  return processed;
}

function applyAppleNotification(
  notificationType: string,
  signedTransactionInfo: string,
  context: AppleNotificationContext,
): boolean {
  const isRenewalStatusChange = notificationType === 'DID_CHANGE_RENEWAL_STATUS';
  const newStatus = APPLE_NOTIFICATION_STATUS_MAP[notificationType];
  if (!newStatus && !isRenewalStatusChange) {
    logger.info({ notificationType }, 'Apple notification: unhandled type, skipping');
    return false;
  }

  // Decode the inner JWS to get transaction details
  const parts = signedTransactionInfo.split('.');
  if (parts.length !== 3) {
    logger.warn({ notificationType }, 'Apple notification: malformed inner JWS');
    return false;
  }

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    logger.warn({ notificationType }, 'Apple notification: failed to decode inner JWS payload');
    return false;
  }

  const originalTransactionId = payload.originalTransactionId || payload.transactionId;
  const transactionId = payload.transactionId || originalTransactionId;
  if (!originalTransactionId) {
    logger.warn({ notificationType }, 'Apple notification: no transactionId in payload');
    return false;
  }

  if (payload.productId && isNexusPointProductId(String(payload.productId))) {
    const pointStatus = notificationType === 'REFUND'
      ? 'refunded'
      : notificationType === 'REVOKE'
        ? 'revoked'
        : null;
    if (!pointStatus) {
      logger.info({ notificationType, productId: payload.productId }, 'Apple notification: Nexus Points event does not require ledger mutation');
      return false;
    }

    const attempts = Array.from(new Set([String(originalTransactionId), String(transactionId)]));
    for (const providerTransactionId of attempts) {
      const result = revokeNexusPointsCredit({
        provider: 'apple',
        providerTransactionId,
        status: pointStatus,
      });
      if (result.revoked) {
        const consumedRatio = typeof result.pointsGranted === 'number' && result.pointsGranted > 0
          ? (result.pointsGranted - (result.pointsRemaining ?? 0)) / result.pointsGranted
          : 0;
        if (consumedRatio > 0.5) {
          recordOperatorAlert({
            source: 'nexus_points',
            severity: 'warning',
            dedupeKey: `nexus_points_high_consumption_refund:${result.userId ?? 'unknown'}:${result.creditId}`,
            title: `Nexus Points refund after ${Math.round(consumedRatio * 100)}% consumption`,
            detail: `Apple ${notificationType} arrived after ${Math.round(consumedRatio * 100)}% of purchased Nexus Points were consumed.`,
            metadata: {
              userId: result.userId ?? null,
              creditId: result.creditId,
              pointsGranted: result.pointsGranted ?? null,
              pointsRemaining: result.pointsRemaining ?? null,
              productId: result.productId ?? String(payload.productId),
            },
            owner: 'ops',
            suspectedArea: 'billing',
            userImpact: 'Potential Apple refund or chargeback after most purchased AI credits were consumed.',
          });
        }
        logger.warn({
          notificationType,
          productId: payload.productId,
          providerTransactionId,
          creditId: result.creditId,
          previousStatus: result.previousStatus,
          newStatus: pointStatus,
        }, 'Apple Nexus Points credit revoked/refunded');
        return true;
      }
    }

    logger.warn({
      notificationType,
      productId: payload.productId,
      transactionId,
      originalTransactionId,
    }, 'Apple Nexus Points notification did not match an existing credit');
    return false;
  }

  // Extract new expiry date for renewal events
  const expiresDate = payload.expiresDate
    ? new Date(payload.expiresDate).toISOString()
    : null;
  let periodStart = payload.purchaseDate
    ? new Date(payload.purchaseDate).toISOString()
    : null;
  // The inner transaction JWS is Apple-signed, so its environment claim beats
  // the outer envelope's. Both are provenance only — never an access gate.
  const environment = normalizeAppleEnvironment(payload.environment)
    ?? normalizeAppleEnvironment(context.environment);
  const appAccountToken = typeof payload.appAccountToken === 'string' && payload.appAccountToken.trim()
    ? payload.appAccountToken.trim()
    : null;

  const db = getDb();
  if (!periodStart && expiresDate) {
    const subscription = db.prepare(`
      SELECT period FROM subscriptions
      WHERE provider_subscription_id = ? AND provider = 'apple'
      LIMIT 1
    `).get(String(originalTransactionId)) as { period: string | null } | undefined;
    periodStart = deriveApplePeriodStart(expiresDate, subscription?.period);
  }

  if (isRenewalStatusChange) {
    const cancelAtPeriodEnd = APPLE_RENEWAL_STATUS_SUBTYPES[String(context.subtype ?? '')];
    if (cancelAtPeriodEnd === undefined) {
      logger.warn({ notificationType, subtype: context.subtype }, 'Apple notification: renewal status change without a known subtype');
      return false;
    }
    const renewalUpdate = db.prepare(`
      UPDATE subscriptions
      SET cancel_at_period_end = ?, environment = COALESCE(?, environment), updated_at = datetime('now')
      WHERE provider_subscription_id = ? AND provider = 'apple'
    `).run(cancelAtPeriodEnd, environment, String(originalTransactionId));
    if (renewalUpdate.changes === 0) {
      logger.warn({ notificationType, subtype: context.subtype, originalTransactionId }, 'Apple notification: renewal status change for an unknown transaction');
      return false;
    }
    logger.info({ notificationType, subtype: context.subtype, originalTransactionId, environment }, 'Apple Server Notification processed');
    return true;
  }

  // Update subscription status based on the notification type.
  // For renewals, also update the expiry date. A strictly newer period end can
  // only come from an actual renewal or a RESUBSCRIBE, neither of which Apple
  // reliably pairs with DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_ENABLED — so a
  // stale cancellation flag is cleared here rather than latched forever.
  const update = newStatus === 'active' && expiresDate
    ? db.prepare(`
        UPDATE subscriptions
        SET status = 'active',
            current_period_start = COALESCE(?, current_period_start),
            cancel_at_period_end = CASE
              WHEN current_period_end IS NULL OR ? > current_period_end THEN 0
              ELSE cancel_at_period_end
            END,
            current_period_end = ?,
            environment = COALESCE(?, environment),
            updated_at = datetime('now')
        WHERE provider_subscription_id = ? AND provider = 'apple'
      `).run(periodStart, expiresDate, expiresDate, environment, String(originalTransactionId))
    : db.prepare(`
        UPDATE subscriptions
        SET status = ?, environment = COALESCE(?, environment), updated_at = datetime('now')
        WHERE provider_subscription_id = ? AND provider = 'apple'
      `).run(newStatus, environment, String(originalTransactionId));

  if (update.changes === 0 && !recoverAppleSubscriptionFromNotification({
    notificationType,
    newStatus,
    originalTransactionId: String(originalTransactionId),
    productId: payload.productId ? String(payload.productId) : null,
    expiresDate,
    periodStart,
    environment,
    appAccountToken,
  })) {
    return false;
  }

  logger.info({
    notificationType,
    newStatus,
    originalTransactionId,
    environment,
  }, 'Apple Server Notification processed');

  return true;
}

/**
 * Recover a subscription whose `apple-verify` call never landed.
 *
 * Before appAccountToken existed the webhook could only UPDATE, so a purchase
 * whose verify call failed (network drop, 5xx, app killed mid-purchase) was
 * only recoverable through a manual Restore. When the client attached an
 * appAccountToken we can resolve the owner from the notification itself and
 * write the row Apple already believes exists.
 *
 * Only a grant-shaped notification may create a row. A terminal event
 * (expiry/refund/revoke) for an unknown transaction has nothing to activate,
 * and writing it would take the user row away from whichever provider
 * currently owns it.
 *
 * @returns true if a row was created
 */
function recoverAppleSubscriptionFromNotification(input: {
  notificationType: string;
  newStatus: string;
  originalTransactionId: string;
  productId: string | null;
  expiresDate: string | null;
  periodStart: string | null;
  environment: string | null;
  appAccountToken: string | null;
}): boolean {
  if (input.newStatus !== 'active') {
    logger.warn({
      notificationType: input.notificationType,
      originalTransactionId: input.originalTransactionId,
    }, 'Apple notification: no matching subscription row for a terminal event');
    return false;
  }

  const userId = resolveUserIdFromAppleAppAccountToken(input.appAccountToken);
  if (!userId) {
    logger.warn({
      notificationType: input.notificationType,
      originalTransactionId: input.originalTransactionId,
      hasAppAccountToken: !!input.appAccountToken,
    }, 'Apple notification: cannot map an unknown transaction back to a user');
    return false;
  }

  const resolved = input.productId ? resolveAppleProduct(input.productId) : null;
  if (!resolved) {
    logger.warn({
      notificationType: input.notificationType,
      productId: input.productId,
      userId,
    }, 'Apple notification: refusing to create a subscription for an unmapped product id');
    return false;
  }

  const db = getDb();
  const existing = db.prepare(
    'SELECT provider, status FROM subscriptions WHERE user_id = ?',
  ).get(userId) as { provider: string | null; status: string | null } | undefined;
  if (existing && existing.provider !== 'apple' && ['active', 'trialing'].includes(String(existing.status))) {
    logger.warn({
      notificationType: input.notificationType,
      userId,
      existingProvider: existing.provider,
    }, 'Apple notification: refusing to overwrite an active non-Apple subscription');
    return false;
  }

  upsertAppleSubscription({
    userId,
    plan: resolved.plan,
    period: resolved.period,
    originalTransactionId: input.originalTransactionId,
    currentPeriodStart: input.periodStart ?? deriveApplePeriodStart(input.expiresDate, resolved.period),
    currentPeriodEnd: input.expiresDate,
    environment: input.environment,
    appAccountToken: input.appAccountToken,
  });

  logger.warn({
    notificationType: input.notificationType,
    userId,
    productId: input.productId,
    originalTransactionId: input.originalTransactionId,
    environment: input.environment,
  }, 'Apple notification: recovered a subscription that never completed apple-verify');
  return true;
}

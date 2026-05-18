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

import StripeLib from 'stripe';
import { config } from '../config';
import { getDb } from './database';
import { isPublicEmailSyntaxValid, normalizePublicEmail } from './waitlist-email-validation';
import { hashEmail } from '../utils/identity';
import { logger } from '../utils/logger';

// Stripe v17+ uses a different export shape. The namespace for types
// is accessed via the default export's type definitions.
type StripeInstance = InstanceType<typeof StripeLib>;

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

// ── Singleton ───────────────────────────────────────────────────────

let stripeClient: StripeInstance | null = null;

function getStripe(): StripeInstance {
  if (!stripeClient) {
    if (!config.stripe.secretKey) {
      throw new Error('Stripe not configured (STRIPE_SECRET_KEY missing)');
    }
    stripeClient = new StripeLib(config.stripe.secretKey);
  }
  return stripeClient;
}

export function isStripeConfigured(): boolean {
  return !!(config.stripe.secretKey && config.stripe.webhookSecret);
}

// ── Subscription Status ─────────────────────────────────────────────

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

  const currentPeriodEndMs = row.current_period_end ? Date.parse(row.current_period_end) : NaN;
  const periodExpired = Number.isFinite(currentPeriodEndMs) && currentPeriodEndMs <= Date.now();
  if (['active', 'trialing'].includes(row.status) && periodExpired) {
    return {
      plan: 'free', period: 'monthly', status: 'expired', provider: row.provider,
      currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: !!row.cancel_at_period_end,
      isActive: false, isPro: false,
    };
  }

  const isActive = ['active', 'trialing'].includes(row.status);
  return {
    plan: row.plan,
    period: row.period,
    status: row.status,
    provider: row.provider,
    currentPeriodEnd: row.current_period_end,
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
  const periodStart = subscription.current_period_start
    ? new Date(subscription.current_period_start * 1000).toISOString()
    : null;
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;
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
  }
  if (!userId) return;

  db.prepare(`
    UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 1, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'stripe'
  `).run(userId);

  logger.info({ userId, subId: subscription.id }, 'Stripe subscription deleted/canceled');
}

export function handleInvoicePaymentFailed(invoice: any): void {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  const db = getDb();
  db.prepare(`
    UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now')
    WHERE provider_customer_id = ? AND provider = 'stripe'
  `).run(customerId);

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

export function handleAppleTransaction(
  userId: number,
  originalTransactionId: string,
  productId: string,
  expiresDate: string | null,
): void {
  const { plan, period } = resolveAppleProduct(productId);

  const db = getDb();
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, period, status, provider, provider_subscription_id, current_period_end, updated_at)
    VALUES (?, ?, ?, 'active', 'apple', ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = excluded.period,
      status = 'active',
      provider = 'apple',
      provider_subscription_id = excluded.provider_subscription_id,
      current_period_end = excluded.current_period_end,
      updated_at = datetime('now')
  `).run(userId, plan, period, originalTransactionId, expiresDate);

  logger.info({ userId, productId, originalTransactionId }, 'Apple IAP transaction verified — subscription active');
}

function resolveAppleProduct(productId: string): { plan: string; period: string } {
  if (productId.includes('max') && productId.includes('yearly'))  return { plan: 'max', period: 'yearly' };
  if (productId.includes('max'))                                   return { plan: 'max', period: 'monthly' };
  if (productId.includes('yearly'))                                return { plan: 'pro', period: 'yearly' };
  return { plan: 'pro', period: 'monthly' };
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

/**
 * Handle an Apple App Store Server Notification V2.
 *
 * @param notificationType - The notification type from Apple's payload
 * @param signedTransactionInfo - JWS-encoded transaction info (inner JWS)
 * @returns true if the notification was processed, false if skipped
 */
export function handleAppleNotification(
  notificationType: string,
  signedTransactionInfo: string,
): boolean {
  const newStatus = APPLE_NOTIFICATION_STATUS_MAP[notificationType];
  if (!newStatus) {
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
  if (!originalTransactionId) {
    logger.warn({ notificationType }, 'Apple notification: no transactionId in payload');
    return false;
  }

  // Extract new expiry date for renewal events
  const expiresDate = payload.expiresDate
    ? new Date(payload.expiresDate).toISOString()
    : null;

  const db = getDb();

  // Update subscription status based on the notification type.
  // For renewals, also update the expiry date.
  if (newStatus === 'active' && expiresDate) {
    db.prepare(`
      UPDATE subscriptions
      SET status = 'active', current_period_end = ?, updated_at = datetime('now')
      WHERE provider_subscription_id = ? AND provider = 'apple'
    `).run(expiresDate, String(originalTransactionId));
  } else {
    db.prepare(`
      UPDATE subscriptions
      SET status = ?, updated_at = datetime('now')
      WHERE provider_subscription_id = ? AND provider = 'apple'
    `).run(newStatus, String(originalTransactionId));
  }

  logger.info({
    notificationType,
    newStatus,
    originalTransactionId,
  }, 'Apple Server Notification processed');

  return true;
}

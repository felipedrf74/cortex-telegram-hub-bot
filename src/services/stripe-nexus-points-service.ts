// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Stripe Nexus Points purchase flow.
 *
 * Required env when STRIPE_NEXUS_POINTS_ENABLED=true:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRICE_ID_POINTS_SMALL
 *   STRIPE_PRICE_ID_POINTS_MEDIUM
 *   STRIPE_PRICE_ID_POINTS_LARGE
 * Optional redirect env:
 *   STRIPE_NEXUS_POINTS_SUCCESS_URL
 *   STRIPE_NEXUS_POINTS_CANCEL_URL
 *
 * This service is intentionally separate from stripe-service.ts, which owns
 * subscription billing and Apple IAP subscription handling. Nexus Points are
 * one-time consumable credits fulfilled only by verified Stripe webhooks.
 */

import StripeLib from 'stripe';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  grantNexusPoints,
  getNexusPointPackage,
  isNexusPointProductId,
  lookupNexusPointCreditByProviderTransaction,
  type NexusPointPackageId,
  revokeNexusPointsCredit,
} from './nexus-points';
import { recordOperatorAlert } from './operator-alerts';
import { assertStripeCheckoutKeyMode } from './stripe-service';
import { getDb } from './database';
import {
  STRIPE_MANAGED_PAYMENTS_API_VERSION,
  STRIPE_MANAGED_PAYMENTS_CHECKOUT_OPTIONS,
} from './stripe-managed-payments';

type StripeInstance = InstanceType<typeof StripeLib>;
const STRIPE_NEXUS_POINTS_API_VERSION = '2026-02-25.clover' as const;
const NOTE_METADATA_MAX_LENGTH = 280;
const ACTOR_METADATA_MAX_LENGTH = 160;
const DEFAULT_METADATA_MAX_LENGTH = 500;

export type StripeNexusPointsCheckoutSource = 'web' | 'portal';

export interface CreateNexusPointsCheckoutSessionInput {
  userId: number;
  tenantId: number;
  packageId: NexusPointPackageId;
  source: StripeNexusPointsCheckoutSource;
  note?: string | null;
  actor?: string | null;
}

export interface NexusPointsCheckoutSessionResult {
  sessionId: string;
  checkoutUrl: string;
}

export class StripeNexusPointsIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly statusCode = 409;

  constructor() {
    super('A different Stripe Nexus Points checkout was created with the same key in the current minute window. Wait ~60s before creating another checkout for this user/package/source.');
    this.name = 'StripeNexusPointsIdempotencyConflictError';
  }
}

let stripeClient: StripeInstance | null = null;

export function _resetStripeNexusPointsClientForTests(): void {
  stripeClient = null;
}

export function initializeStripeClient(): StripeInstance | null {
  if (!config.stripe.nexusPoints.enabled) return null;
  if (!stripeClient) {
    if (!config.stripe.secretKey) {
      throw new Error('Stripe Nexus Points is enabled but STRIPE_SECRET_KEY is missing');
    }
    stripeClient = new StripeLib(config.stripe.secretKey, {
      apiVersion: (config.stripe.managedPaymentsSandboxEnabled
        ? STRIPE_MANAGED_PAYMENTS_API_VERSION
        : STRIPE_NEXUS_POINTS_API_VERSION) as any,
    });
  }
  return stripeClient;
}

export function isStripeNexusPointsConfigured(): boolean {
  return !!(
    config.stripe.nexusPoints.enabled
    && config.stripe.secretKey
    && config.stripe.webhookSecret
    && config.stripe.nexusPoints.priceIds.small
    && config.stripe.nexusPoints.priceIds.medium
    && config.stripe.nexusPoints.priceIds.large
  );
}

export function isStripeNexusPointsIdempotencyConflictError(
  err: unknown,
): err is StripeNexusPointsIdempotencyConflictError {
  return err instanceof StripeNexusPointsIdempotencyConflictError
    || !!(err && typeof err === 'object' && (err as any).code === 'IDEMPOTENCY_CONFLICT');
}

export function resolvePackageIdForStripePriceId(priceId: string): NexusPointPackageId | null {
  const entries: Array<[string, NexusPointPackageId]> = [
    [config.stripe.nexusPoints.priceIds.small, 'me.nexushub.points.small'],
    [config.stripe.nexusPoints.priceIds.medium, 'me.nexushub.points.medium'],
    [config.stripe.nexusPoints.priceIds.large, 'me.nexushub.points.large'],
  ];
  for (const [configuredPriceId, packageId] of entries) {
    if (configuredPriceId && priceId === configuredPriceId) return packageId;
  }
  return null;
}

export async function createNexusPointsCheckoutSession(
  input: CreateNexusPointsCheckoutSessionInput,
): Promise<NexusPointsCheckoutSessionResult> {
  // Uniform key-mode guard with every other checkout surface: a non-live key
  // never mints a session unless the sandbox posture is explicitly declared.
  assertStripeCheckoutKeyMode();
  if (!isStripeNexusPointsConfigured()) {
    throw new Error('STRIPE_NEXUS_POINTS_NOT_CONFIGURED');
  }
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new Error('INVALID_USER_ID');
  }
  if (!Number.isInteger(input.tenantId) || input.tenantId <= 0) {
    throw new Error('INVALID_TENANT_ID');
  }
  if (!isNexusPointProductId(input.packageId)) {
    throw new Error('UNKNOWN_NEXUS_POINT_PACKAGE');
  }
  const priceId = stripePriceIdForPackage(input.packageId);
  if (!priceId) {
    throw new Error('STRIPE_PRICE_ID_NOT_CONFIGURED');
  }

  const stripe = initializeStripeClient();
  if (!stripe) {
    throw new Error('STRIPE_NEXUS_POINTS_NOT_CONFIGURED');
  }
  const pkg = getNexusPointPackage(input.packageId);
  const metadata = normalizeStripeMetadata({
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    packageId: input.packageId,
    nexusInternalSku: input.packageId,
    stripePriceId: priceId,
    source: input.source,
    actor: input.actor ?? '',
    note: input.note ?? '',
  });

  const sessionParams: any = {
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: config.stripe.nexusPoints.webSuccessUrl,
    cancel_url: config.stripe.nexusPoints.webCancelUrl,
    client_reference_id: String(input.userId),
    metadata,
    payment_intent_data: { metadata },
  };
  if (config.stripe.managedPaymentsSandboxEnabled) {
    sessionParams.managed_payments = { ...STRIPE_MANAGED_PAYMENTS_CHECKOUT_OPTIONS };
  }
  const customer = lookupStripeCustomerForNexusPoints(input.userId);
  if (customer.providerCustomerId) {
    sessionParams.customer = customer.providerCustomerId;
  } else if (customer.email) {
    sessionParams.customer_email = customer.email;
  } else {
    sessionParams.customer_creation = 'if_required';
  }

  let session: any;
  try {
    session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: buildCheckoutIdempotencyKey(input),
    });
  } catch (err) {
    if (isStripeIdempotencyConflict(err)) {
      logger.warn({
        userId: input.userId,
        tenantId: input.tenantId,
        packageId: input.packageId,
        source: input.source,
        stripeErrorType: (err as any)?.type,
        stripeRawType: (err as any)?.rawType,
        stripeStatusCode: (err as any)?.statusCode,
      }, 'Stripe Nexus Points Checkout idempotency conflict');
      throw new StripeNexusPointsIdempotencyConflictError();
    }
    throw err;
  }

  if (!session.url) {
    throw new Error('Stripe returned no Checkout URL for Nexus Points');
  }

  logger.info({
    userId: input.userId,
    tenantId: input.tenantId,
    packageId: input.packageId,
    points: pkg?.points,
    source: input.source,
    sessionId: session.id,
  }, 'Stripe Nexus Points Checkout session created');

  return { sessionId: session.id, checkoutUrl: session.url };
}

// Removed (QA6 P3): a second webhook entry point verified the Stripe
// signature and dispatched straight into handleStripeNexusPointsEvent without
// the livemode gate — the exact shape of the QA5 P0, kept alive only by its
// own test. The single routed entry point is POST /webhooks/stripe
// (src/api/routes/webhooks.ts), which gates livemode before any handler runs.

export async function handleStripeNexusPointsEvent(event: any): Promise<boolean> {
  if (!config.stripe.nexusPoints.enabled) return false;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return processCheckoutSession(event.data.object, event.type);
    case 'checkout.session.async_payment_failed':
      return processCheckoutPaymentFailed(event.data.object, event.type);
    case 'charge.refunded':
      return processChargeRefunded(event.data.object);
    case 'charge.dispute.created':
      return processChargeDisputeCreated(event.data.object);
    default:
      return false;
  }
}

function processCheckoutPaymentFailed(session: any, eventType: string): boolean {
  if (session.mode !== 'payment') return false;
  const metadata = session.metadata ?? {};
  if (!metadata.packageId && !metadata.nexusInternalSku) return false;
  logger.info({ eventType, sessionId: session.id }, 'Stripe Nexus Points delayed payment failed; no credits granted');
  return true;
}

function stripePriceIdForPackage(packageId: NexusPointPackageId): string {
  switch (packageId) {
    case 'me.nexushub.points.small':
      return config.stripe.nexusPoints.priceIds.small;
    case 'me.nexushub.points.medium':
      return config.stripe.nexusPoints.priceIds.medium;
    case 'me.nexushub.points.large':
      return config.stripe.nexusPoints.priceIds.large;
  }
}

async function processCheckoutSession(session: any, eventType: string): Promise<boolean> {
  if (session.mode !== 'payment') return false;
  if (session.payment_status !== 'paid') {
    logger.info({ eventType, sessionId: session.id, paymentStatus: session.payment_status }, 'Stripe Nexus Points checkout not paid yet; skipping');
    return false;
  }
  const metadata = session.metadata ?? {};
  if (!metadata.packageId && !metadata.nexusInternalSku) {
    logger.debug({ sessionId: session.id, eventType }, 'mode=payment checkout is not a Nexus Points session; ignoring');
    return false;
  }
  const userId = Number.parseInt(String(metadata.userId ?? ''), 10);
  const tenantId = Number.parseInt(String(metadata.tenantId ?? ''), 10);
  const packageId = String(metadata.packageId ?? metadata.nexusInternalSku ?? '');
  const paymentIntentId = getStripeId(session.payment_intent);

  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(tenantId) || tenantId <= 0 || !paymentIntentId) {
    recordStripeNexusAlert({
      dedupeKey: `stripe_nexus_checkout_invalid:${session.id}`,
      title: 'Stripe Nexus Points checkout missing required metadata',
      detail: 'A paid Stripe Checkout session could not be fulfilled because required internal metadata was missing.',
      metadata: { sessionId: session.id, eventType, hasPaymentIntent: !!paymentIntentId },
    });
    return false;
  }
  if (!isNexusPointProductId(packageId)) {
    recordStripeNexusAlert({
      dedupeKey: `stripe_nexus_checkout_unknown_package:${session.id}`,
      title: 'Stripe Nexus Points checkout has unknown package',
      detail: 'A paid Stripe Checkout session referenced an unknown Nexus Points package.',
      metadata: { sessionId: session.id, eventType, packageId },
    });
    return false;
  }

  const priceId = sessionLinePriceId(session) || String(metadata.stripePriceId ?? '');
  if (priceId) {
    const pricePackageId = resolvePackageIdForStripePriceId(priceId);
    if (pricePackageId !== packageId) {
      recordStripeNexusAlert({
        dedupeKey: `stripe_nexus_checkout_price_mismatch:${session.id}`,
        title: 'Stripe Nexus Points checkout price/package mismatch',
        detail: 'A paid Stripe Checkout session price id did not match its internal Nexus Points package metadata.',
        metadata: { sessionId: session.id, eventType, priceId, packageId, resolvedPackageId: pricePackageId },
      });
      return false;
    }
  }

  const chargeId = getStripeId((session as any).charge);
  const grant = grantNexusPoints({
    userId,
    provider: 'stripe',
    providerTransactionId: paymentIntentId,
    productId: packageId,
    source: metadata.source === 'portal' ? 'stripe_portal_checkout' : 'stripe_web_checkout',
    metadata: {
      sessionId: session.id,
      paymentIntentId,
      chargeId,
      packageId,
      source: metadata.source ?? 'web',
      actor: metadata.actor ?? null,
      note: metadata.note ?? null,
      tenantId,
      stripeEventType: eventType,
    },
  });

  logger.info({
    userId,
    tenantId,
    packageId,
    paymentIntentId,
    sessionId: session.id,
    granted: grant.granted,
    creditId: grant.creditId,
  }, 'Stripe Nexus Points checkout fulfilled');
  return true;
}

async function processChargeRefunded(charge: any): Promise<boolean> {
  const paymentIntentId = getStripeId(charge.payment_intent);
  if (!paymentIntentId) {
    logger.debug({ chargeId: charge.id }, 'Stripe refund webhook for non-NP charge without PaymentIntent; ignoring');
    return false;
  }

  const credit = lookupNexusPointCreditByProviderTransaction('stripe', paymentIntentId);
  if (!credit) {
    logger.debug({ paymentIntentId, chargeId: charge.id, eventType: 'charge.refunded' }, 'Stripe webhook for non-NP charge; ignoring');
    return false;
  }

  const amountRefunded = Number(charge.amount_refunded || 0);
  const amount = Number(charge.amount || 0);
  if (amountRefunded <= 0) {
    logger.info({ paymentIntentId, chargeId: charge.id, amountRefunded }, 'Stripe refund webhook has no refunded amount; ignoring');
    return false;
  }
  if (amount > 0 && amountRefunded >= amount) {
    const result = revokeNexusPointsCredit({
      provider: 'stripe',
      providerTransactionId: paymentIntentId,
      status: 'refunded',
    });
    logger.warn({
      paymentIntentId,
      chargeId: charge.id,
      revoked: result.revoked,
      creditId: result.creditId,
      previousStatus: result.previousStatus,
    }, 'Stripe Nexus Points full refund processed');
    return result.revoked;
  }

  recordStripeNexusAlert({
    dedupeKey: `stripe_nexus_partial_refund:${charge.id}`,
    title: 'Stripe Nexus Points partial refund requires review',
    detail: 'A partial refund was created for a Nexus Points purchase. Remaining credits were not automatically revoked.',
    metadata: {
      chargeId: charge.id,
      paymentIntentId,
      amount,
      amountRefunded,
      currency: charge.currency,
    },
  });
  return false;
}

async function processChargeDisputeCreated(dispute: any): Promise<boolean> {
  const paymentIntentId = getStripeId((dispute as any).payment_intent);
  const chargeId = getStripeId(dispute.charge);
  const resolvedPaymentIntentId = paymentIntentId || await lookupPaymentIntentIdForCharge(chargeId);
  if (!resolvedPaymentIntentId) {
    logger.debug({ disputeId: dispute.id, chargeId, eventType: 'charge.dispute.created' }, 'Stripe dispute webhook for non-NP charge without PaymentIntent; ignoring');
    return false;
  }
  const credit = lookupNexusPointCreditByProviderTransaction('stripe', resolvedPaymentIntentId);
  if (!credit) {
    logger.debug({ paymentIntentId: resolvedPaymentIntentId, disputeId: dispute.id, chargeId, eventType: 'charge.dispute.created' }, 'Stripe webhook for non-NP charge; ignoring');
    return false;
  }
  recordStripeNexusAlert({
    dedupeKey: `stripe_nexus_dispute:${dispute.id}`,
    title: 'Stripe Nexus Points dispute opened',
    detail: 'A Stripe dispute was opened for a Nexus Points purchase. Credits were not automatically revoked; handle case-by-case.',
    metadata: {
      disputeId: dispute.id,
      chargeId,
      paymentIntentId: resolvedPaymentIntentId,
      amount: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
    },
  });
  return true;
}

async function lookupPaymentIntentIdForCharge(chargeId: string | null): Promise<string | null> {
  if (!chargeId) return null;
  try {
    const stripe = initializeStripeClient();
    if (!stripe) return null;
    const charge = await (stripe as any).charges.retrieve(chargeId);
    return getStripeId(charge?.payment_intent);
  } catch (err) {
    logger.warn({ err, chargeId }, 'Failed to resolve Stripe charge PaymentIntent for Nexus Points dispute');
    return null;
  }
}

function sessionLinePriceId(session: any): string | null {
  const lineItems = (session as any).line_items?.data;
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  return getStripeId(lineItems[0]?.price);
}

function getStripeId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

function recordStripeNexusAlert(input: {
  dedupeKey: string;
  title: string;
  detail: string;
  metadata?: Record<string, unknown>;
}): void {
  recordOperatorAlert({
    severity: 'critical',
    source: 'stripe_nexus_points',
    dedupeKey: input.dedupeKey,
    title: input.title,
    detail: input.detail,
    owner: 'ops',
    suspectedArea: 'stripe_nexus_points',
    userImpact: 'A Nexus Points purchase may require manual billing or ledger review.',
    runbookUrl: 'docs/integrations/stripe-nexus-points.md',
    metadata: input.metadata ?? null,
  });
}

function normalizeStripeMetadata(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const maxLength = key === 'note'
      ? NOTE_METADATA_MAX_LENGTH
      : key === 'actor'
        ? ACTOR_METADATA_MAX_LENGTH
        : DEFAULT_METADATA_MAX_LENGTH;
    const clean = String(value ?? '')
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean) out[key] = clean.slice(0, maxLength);
  }
  if (Object.keys(out).length > 50) {
    throw new Error('Stripe Nexus Points metadata exceeds Stripe 50-key limit');
  }
  return out;
}

function buildCheckoutIdempotencyKey(input: CreateNexusPointsCheckoutSessionInput): string {
  const minuteBucket = Math.floor(Date.now() / 60000);
  return `nexus-points:${input.userId}:${input.packageId}:${input.source}:${minuteBucket}`;
}

function isStripeIdempotencyConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { type?: unknown; rawType?: unknown; code?: unknown; statusCode?: unknown };
  return e.type === 'StripeIdempotencyError'
    || e.rawType === 'idempotency_error'
    || e.code === 'idempotency_error'
    || (e.statusCode === 400 && e.rawType === 'idempotency_error');
}

function lookupStripeCustomerForNexusPoints(userId: number): { providerCustomerId: string | null; email: string | null } {
  try {
    const db = getDb();
    const subscription = db.prepare(
      "SELECT provider_customer_id FROM subscriptions WHERE user_id = ? AND provider = 'stripe' AND provider_customer_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    ).get(userId) as { provider_customer_id?: string | null } | undefined;
    if (subscription?.provider_customer_id) {
      return { providerCustomerId: subscription.provider_customer_id, email: null };
    }
    const user = db.prepare('SELECT email FROM users WHERE id = ? LIMIT 1').get(userId) as { email?: string | null } | undefined;
    return { providerCustomerId: null, email: user?.email || null };
  } catch {
    return { providerCustomerId: null, email: null };
  }
}

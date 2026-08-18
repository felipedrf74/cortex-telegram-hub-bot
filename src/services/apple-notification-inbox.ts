// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Durable Apple App Store notification inbox (hybrid AI plan §3).
 *
 * Contract:
 * - The webhook verifies both JWS layers and the bundle id, then persists the
 *   notification here BEFORE processing. A storage failure returns a
 *   retryable error to Apple; a processing failure keeps the stored row in
 *   `failed` for internal reprocessing, so a notification is never lost
 *   behind an HTTP 200.
 * - Credit-pack consumables (ONE_TIME_CHARGE) grant purchased credit lots
 *   bound to the Apple transaction id and the self-verifying appAccountToken;
 *   REFUND/REVOKE for a pack revokes only the originating lot. Every other
 *   notification type delegates to the existing subscription/points handler.
 * - Reprocessing is idempotent: grants dedupe on the provider transaction id
 *   and the delegate handler dedupes on notificationUUID.
 */

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { verifyAppleJws } from './apple-jws-verifier';
import {
  handleAppleNotification,
  resolveUserIdFromAppleAppAccountToken,
} from './stripe-service';
import { resolveBillingCatalogItemByAppleProductId } from './billing-catalog';
import { recordOperatorAlert } from './operator-alerts';
import {
  findAiCreditLotByProviderTransaction,
  grantPurchasedAiCredits,
  revokeAiCreditLot,
} from './ai-credit-ledger';

const MAX_PROCESS_ATTEMPTS = 5;
const LAST_ERROR_MAX_LENGTH = 300;
const MAX_CONSUMABLE_QUANTITY = 100;

function isProductionRuntime(): boolean {
  return (process.env.NODE_ENV || '') === 'production';
}

export interface AppleInboxRow {
  id: number;
  notificationUuid: string;
  notificationType: string;
  subtype: string | null;
  environment: string | null;
  state: 'pending' | 'processed' | 'failed';
  attempts: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export type IngestAppleNotificationResult =
  | { kind: 'stored'; row: AppleInboxRow }
  | { kind: 'duplicate'; row: AppleInboxRow };

export type ProcessAppleNotificationResult =
  | { kind: 'processed'; row: AppleInboxRow; handled: boolean }
  | { kind: 'failed'; row: AppleInboxRow; error: string }
  | { kind: 'deferred'; row: AppleInboxRow }
  | { kind: 'not_found'; inboxId: number }
  | { kind: 'exhausted'; row: AppleInboxRow };

/** Pack work is deferred — not failed — while its kill switch is off. */
class PackFulfillmentDisabledError extends Error {
  constructor() {
    super('Apple pack fulfillment is disabled; notification retained as pending');
    this.name = 'PackFulfillmentDisabledError';
  }
}

interface RawRow {
  id: number;
  notification_uuid: string;
  notification_type: string;
  subtype: string | null;
  environment: string | null;
  signed_payload: string;
  state: 'pending' | 'processed' | 'failed';
  attempts: number;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
}

function mapRow(row: RawRow): AppleInboxRow {
  return {
    id: row.id,
    notificationUuid: row.notification_uuid,
    notificationType: row.notification_type,
    subtype: row.subtype,
    environment: row.environment,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

function getRawRow(inboxId: number): RawRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM apple_notification_inbox WHERE id = ?').get(inboxId) as RawRow | undefined;
}

/**
 * Persist one verified notification. The caller has already verified both JWS
 * layers and the bundle id; the raw signed payload is stored so reprocessing
 * can re-verify instead of trusting a cached decode.
 */
export function ingestVerifiedAppleNotification(input: {
  notificationUuid: string;
  notificationType: string;
  subtype?: string | null;
  environment?: string | null;
  signedPayload: string;
  now?: Date;
}): IngestAppleNotificationResult {
  const db = getDb();
  const now = input.now ?? new Date();
  const tx = db.transaction((): IngestAppleNotificationResult => {
    const existing = db
      .prepare('SELECT * FROM apple_notification_inbox WHERE notification_uuid = ?')
      .get(input.notificationUuid) as RawRow | undefined;
    if (existing) return { kind: 'duplicate', row: mapRow(existing) };
    const inserted = db
      .prepare(
        `INSERT INTO apple_notification_inbox (
           notification_uuid, notification_type, subtype, environment,
           signed_payload, received_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.notificationUuid,
        input.notificationType,
        input.subtype ?? null,
        input.environment ?? null,
        input.signedPayload,
        now.toISOString(),
      );
    const row = getRawRow(Number(inserted.lastInsertRowid));
    if (!row) throw new Error('apple-notification-inbox: insert readback failed');
    return { kind: 'stored', row: mapRow(row) };
  });
  return tx();
}

function isPackPurchaseType(notificationType: string): boolean {
  return notificationType === 'ONE_TIME_CHARGE';
}

function isPackReversalType(notificationType: string): boolean {
  return notificationType === 'REFUND' || notificationType === 'REVOKE';
}

/**
 * Apply one stored notification. Pack consumables settle against the credit
 * ledger; everything else delegates to the existing Apple handler.
 */
function applyStoredNotification(row: RawRow): boolean {
  const outer = verifyAppleJws(row.signed_payload, { requireX5c: true }).payload as Record<string, any>;
  const signedTransactionInfo = outer?.data?.signedTransactionInfo;
  if (typeof signedTransactionInfo !== 'string' || !signedTransactionInfo) {
    throw new Error('stored notification is missing signedTransactionInfo');
  }
  const inner = verifyAppleJws(signedTransactionInfo, { requireX5c: true }).payload as Record<string, any>;
  const productId = typeof inner.productId === 'string' ? inner.productId : '';
  const packItem = resolveBillingCatalogItemByAppleProductId(productId);

  if (packItem && !config.hybridCommerce.applePackFulfillmentEnabled) {
    throw new PackFulfillmentDisabledError();
  }

  // Sandbox and TestFlight notifications carry valid Apple signatures and the
  // same bundle id. A sandbox purchase must never mint spendable production
  // credit: ledger grants require a Production-environment notification.
  if (packItem && isProductionRuntime() && row.environment !== 'Production') {
    throw new Error(`refusing ledger grant for non-production environment: ${row.environment ?? 'unknown'}`);
  }

  if (packItem && isPackPurchaseType(row.notification_type)) {
    const userId = resolveUserIdFromAppleAppAccountToken(inner.appAccountToken);
    if (!userId) {
      throw new Error('pack purchase has no resolvable appAccountToken');
    }
    const transactionId = String(inner.transactionId || inner.originalTransactionId || '');
    if (!transactionId) {
      throw new Error('pack purchase has no transactionId');
    }
    // Apple charges for the full consumable quantity; crediting once would
    // undercharge the user's balance for a multi-quantity purchase.
    const rawQuantity = typeof inner.quantity === 'number' ? inner.quantity : 1;
    if (!Number.isInteger(rawQuantity) || rawQuantity < 1 || rawQuantity > MAX_CONSUMABLE_QUANTITY) {
      throw new Error(`pack purchase has an unsupported quantity: ${String(inner.quantity)}`);
    }
    const granted = grantPurchasedAiCredits({
      userId,
      provider: 'apple',
      providerTransactionId: transactionId,
      credits: (packItem.credits ?? 0) * rawQuantity,
    });
    if (granted.kind === 'rejected') {
      throw new Error(`pack grant rejected: ${granted.reason}`);
    }
    logger.info(
      { inboxId: row.id, catalogItemId: packItem.id, replay: granted.kind === 'already_granted' },
      'Apple pack consumable settled against the credit ledger',
    );
    return true;
  }

  if (packItem && isPackReversalType(row.notification_type)) {
    const candidates = Array.from(new Set([
      String(inner.transactionId || ''),
      String(inner.originalTransactionId || ''),
    ].filter(Boolean)));
    for (const providerTransactionId of candidates) {
      const lot = findAiCreditLotByProviderTransaction('apple', providerTransactionId);
      if (lot) {
        revokeAiCreditLot({ lotId: lot.id, reason: row.notification_type.toLowerCase() });
        logger.info(
          { inboxId: row.id, lotId: lot.id },
          'Apple pack reversal revoked the originating credit lot',
        );
        return true;
      }
    }
    // A reversal with no matching lot must not be marked processed: the
    // purchase may still be pending/failed in this inbox. Failing keeps the
    // reversal retryable so it lands after the purchase does; exhausted rows
    // stay visible for reconciliation instead of silently vanishing.
    throw new Error('pack reversal matched no credit lot; retained for reconciliation');
  }

  return handleAppleNotification(row.notification_type, signedTransactionInfo, {
    notificationUUID: row.notification_uuid,
    subtype: row.subtype,
    environment: row.environment,
  });
}

export function processStoredAppleNotification(inboxId: number, now: Date = new Date()): ProcessAppleNotificationResult {
  const db = getDb();
  const row = getRawRow(inboxId);
  if (!row) return { kind: 'not_found', inboxId };
  if (row.state === 'processed') return { kind: 'processed', row: mapRow(row), handled: false };
  if (row.attempts >= MAX_PROCESS_ATTEMPTS) {
    // An exhausted row is money or entitlement that never landed; it must be
    // visible to an operator rather than silently parked forever.
    recordOperatorAlert({
      source: 'apple_notifications',
      severity: 'warning',
      dedupeKey: `apple_inbox_exhausted:${row.notification_uuid}`,
      title: 'Apple notification exhausted its retries',
      metadata: {
        notificationUuid: row.notification_uuid,
        notificationType: row.notification_type,
        attempts: row.attempts,
      },
    });
    return { kind: 'exhausted', row: mapRow(row) };
  }

  try {
    const handled = applyStoredNotification(row);
    db.prepare(
      `UPDATE apple_notification_inbox
       SET state = 'processed', attempts = attempts + 1, processed_at = ?, last_error = NULL
       WHERE id = ?`,
    ).run(now.toISOString(), row.id);
    const updated = getRawRow(row.id);
    if (!updated) throw new Error('apple-notification-inbox: processed readback failed');
    return { kind: 'processed', row: mapRow(updated), handled };
  } catch (error) {
    if (error instanceof PackFulfillmentDisabledError) {
      // Kill switch off: keep the row pending without burning an attempt so
      // enabling fulfillment later replays every deferred purchase intact.
      return { kind: 'deferred', row: mapRow(row) };
    }
    const message = error instanceof Error ? error.message.slice(0, LAST_ERROR_MAX_LENGTH) : 'unknown error';
    db.prepare(
      `UPDATE apple_notification_inbox
       SET state = 'failed', attempts = attempts + 1, last_error = ?
       WHERE id = ?`,
    ).run(message, row.id);
    const updated = getRawRow(row.id);
    if (!updated) throw new Error('apple-notification-inbox: failure readback failed');
    logger.warn({ inboxId: row.id, error: message }, 'Apple notification processing failed; retained for retry');
    return { kind: 'failed', row: mapRow(updated), error: message };
  }
}

/**
 * Retry hook for the scheduled reconciliation job. Scheduler wiring ships
 * with the Content/scheduler phase; this stays callable and idempotent.
 */
export function processPendingAppleNotifications(input: { limit?: number; now?: Date } = {}): {
  processed: number;
  failed: number;
  exhausted: number;
  deferred: number;
} {
  const db = getDb();
  const now = input.now ?? new Date();
  // Deferred pack rows keep attempts at 0 forever while their kill switch is
  // off. Selecting them by received_at would park them permanently at the head
  // of every pass and starve retryable subscription notifications behind them,
  // so they are excluded while fulfillment is disabled.
  const packProductIds = config.hybridCommerce.applePackFulfillmentEnabled
    ? []
    : Object.values(config.hybridCommerce.appleProductIds).filter(Boolean);
  const excludeDeferredPacks = packProductIds.length > 0
    ? "AND NOT (notification_type = 'ONE_TIME_CHARGE' AND state = 'pending' AND attempts = 0)"
    : '';
  const rows = db
    .prepare(
      `SELECT id FROM apple_notification_inbox
       WHERE state IN ('pending', 'failed') AND attempts < ?
       ${excludeDeferredPacks}
       ORDER BY received_at ASC
       LIMIT ?`,
    )
    .all(MAX_PROCESS_ATTEMPTS, Math.max(1, Math.min(input.limit ?? 25, 100))) as Array<{ id: number }>;
  const counts = { processed: 0, failed: 0, exhausted: 0, deferred: 0 };
  for (const { id } of rows) {
    const result = processStoredAppleNotification(id, now);
    if (result.kind === 'processed') counts.processed += 1;
    else if (result.kind === 'failed') counts.failed += 1;
    else if (result.kind === 'exhausted') counts.exhausted += 1;
    else if (result.kind === 'deferred') counts.deferred += 1;
  }
  return counts;
}

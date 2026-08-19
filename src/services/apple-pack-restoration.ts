// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Client-initiated StoreKit pack restoration (plan §3, NH-0041).
 *
 * Recovery path for consumable pack purchases that Apple settled but the
 * notification inbox never received (dropped V2 notification, outage during
 * ingest). The iOS client submits the signed transaction JWS it already
 * holds from StoreKit; the server re-verifies every claim independently:
 *
 * - Apple's x5c chain signs the transaction (same verifier as the inbox).
 * - The product must be a known credit-pack consumable from the catalog.
 * - The environment must be Production unless sandbox grants are allowed.
 * - The appAccountToken must resolve to the AUTHENTICATED caller — a stolen
 *   or replayed transaction belonging to another account is refused without
 *   revealing whether the transaction exists.
 * - The grant is idempotent on the Apple transaction id: re-submitting a
 *   settled transaction returns already_credited and never double-mints.
 */

import { verifyAppleJws } from './apple-jws-verifier';
import { resolveBillingCatalogItemByAppleProductId } from './billing-catalog';
import { grantPurchasedAiCredits } from './ai-credit-ledger';
import {
  isSandboxGrantAllowed,
  MAX_CONSUMABLE_QUANTITY,
} from './apple-notification-inbox';
import { isApplePackFulfillmentActive } from './hybrid-runtime-kill-switches';
import { resolveUserIdFromAppleAppAccountToken } from './stripe-service';
import { logger } from '../utils/logger';

export const MAX_RESTORE_TRANSACTIONS_PER_REQUEST = 8;
export const MAX_RESTORE_TRANSACTION_JWS_LENGTH = 16_384;

export type ApplePackRestorationOutcome =
  | 'credited'
  | 'already_credited'
  | 'not_a_pack'
  | 'wrong_account'
  | 'environment_refused'
  | 'invalid_transaction'
  | 'grant_rejected';

export interface ApplePackRestorationItemResult {
  outcome: ApplePackRestorationOutcome;
  catalogItemId?: string;
  transactionId?: string;
}

export type ApplePackRestorationResult =
  | { kind: 'fulfillment_disabled' }
  | { kind: 'invalid_request'; reason: string }
  | { kind: 'processed'; results: ApplePackRestorationItemResult[] };

export function restoreApplePackTransactions(input: {
  userId: number;
  signedTransactions: unknown;
}): ApplePackRestorationResult {
  if (!isApplePackFulfillmentActive()) {
    return { kind: 'fulfillment_disabled' };
  }
  const raw = input.signedTransactions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RESTORE_TRANSACTIONS_PER_REQUEST) {
    return {
      kind: 'invalid_request',
      reason: `signedTransactions must be a non-empty array of at most ${MAX_RESTORE_TRANSACTIONS_PER_REQUEST}`,
    };
  }
  if (!raw.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_RESTORE_TRANSACTION_JWS_LENGTH)) {
    return { kind: 'invalid_request', reason: 'each signed transaction must be a bounded JWS string' };
  }

  const results: ApplePackRestorationItemResult[] = [];
  for (const jws of raw as string[]) {
    results.push(restoreOne(input.userId, jws));
  }
  return { kind: 'processed', results };
}

function restoreOne(userId: number, jws: string): ApplePackRestorationItemResult {
  let inner: Record<string, any>;
  try {
    inner = verifyAppleJws(jws, { requireX5c: true }).payload as Record<string, any>;
  } catch {
    return { outcome: 'invalid_transaction' };
  }

  const productId = typeof inner.productId === 'string' ? inner.productId : '';
  const packItem = resolveBillingCatalogItemByAppleProductId(productId);
  if (!packItem) return { outcome: 'not_a_pack' };

  // Restoration mirrors the inbox environment rule: sandbox transactions
  // never mint spendable production credit.
  const environment = typeof inner.environment === 'string' ? inner.environment : '';
  if (environment !== 'Production' && !isSandboxGrantAllowed()) {
    return { outcome: 'environment_refused', catalogItemId: packItem.id };
  }

  // Ownership is derived from the transaction's own appAccountToken, never
  // from the caller's claim. A mismatch is refused as wrong_account without
  // confirming the transaction's existence to the wrong caller.
  const boundUserId = resolveUserIdFromAppleAppAccountToken(inner.appAccountToken);
  if (!boundUserId || boundUserId !== userId) {
    return { outcome: 'wrong_account', catalogItemId: packItem.id };
  }

  const transactionId = String(inner.transactionId || inner.originalTransactionId || '');
  if (!transactionId) return { outcome: 'invalid_transaction', catalogItemId: packItem.id };

  const rawQuantity = typeof inner.quantity === 'number' ? inner.quantity : 1;
  if (!Number.isInteger(rawQuantity) || rawQuantity < 1 || rawQuantity > MAX_CONSUMABLE_QUANTITY) {
    return { outcome: 'invalid_transaction', catalogItemId: packItem.id, transactionId };
  }

  const granted = grantPurchasedAiCredits({
    userId,
    provider: 'apple',
    providerTransactionId: transactionId,
    credits: (packItem.credits ?? 0) * rawQuantity,
  });
  if (granted.kind === 'rejected') {
    logger.warn({ userId, catalogItemId: packItem.id }, 'apple-pack-restoration: grant rejected');
    return { outcome: 'grant_rejected', catalogItemId: packItem.id, transactionId };
  }
  logger.info(
    { userId, catalogItemId: packItem.id, replay: granted.kind === 'already_granted' },
    'apple-pack-restoration: pack settled against the credit ledger',
  );
  return {
    outcome: granted.kind === 'already_granted' ? 'already_credited' : 'credited',
    catalogItemId: packItem.id,
    transactionId,
  };
}

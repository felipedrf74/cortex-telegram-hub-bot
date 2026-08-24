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
import { isApplePackFulfillmentActive } from './hybrid-runtime-kill-switches';
import { logger } from '../utils/logger';
import { decodeAppleJwsPayload, verifyAppleJws } from './apple-jws-verifier';
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
import { isCreditPackPurchaseEligible } from './credit-pack-entitlement';

const MAX_PROCESS_ATTEMPTS = 5;
const MAX_REVERSAL_INDEX_ATTEMPTS = 3;
const LAST_ERROR_MAX_LENGTH = 300;
export const MAX_CONSUMABLE_QUANTITY = 100;

/**
 * Sandbox grants are opt-in by explicit flag, not inferred from NODE_ENV
 * (QA3 P2-9): both staging and production containers run NODE_ENV=production,
 * so an env-based gate made the pack path untestable anywhere but production.
 * Default refuses non-Production notifications everywhere; staging sets
 * APPLE_ALLOW_SANDBOX_GRANTS=true deliberately.
 */
export function isSandboxGrantAllowed(): boolean {
  return process.env.APPLE_ALLOW_SANDBOX_GRANTS === 'true';
}

/** Notification types that reverse a purchase and must block restoration. */
export const REVERSAL_NOTIFICATION_TYPES = ['REFUND', 'REVOKE'] as const;

export interface ReversalTransactionIds {
  transactionId: string | null;
  originalTransactionId: string | null;
}

/** Pull the transaction identity out of a decoded inner transaction payload. */
export function readReversalTransactionIds(inner: unknown): ReversalTransactionIds {
  const payload = (inner ?? {}) as Record<string, unknown>;
  const pick = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  };
  return {
    transactionId: pick(payload.transactionId),
    originalTransactionId: pick(payload.originalTransactionId),
  };
}

/**
 * Resolve the reversal identity of rows ingested before migration 292 added
 * the indexed columns. Bounded per call so a scheduled pass stays cheap;
 * reports whether unresolved/retryable evidence remains afterwards.
 *
 * Reversal rows whose payload cannot be decoded remain unresolved. They may
 * be the only durable evidence that a transaction was refunded, so stamping
 * them with NULL ids would turn an unknown into a false clean verdict. The
 * restore path fails closed until an operator repairs or reindexes the row.
 */
export interface AppleReversalBackfillResult {
  scanned: number;
  processed: number;
  failed: number;
  hasRemaining: boolean;
  hasRetryableRemaining: boolean;
}

interface AppleReversalBackfillRow {
  id: number;
  signedPayload: string;
  indexAttempts: number;
}

const UNRESOLVED_REVERSAL_BUCKET_PREDICATES = [
  'reversal_indexed_at IS NULL',
  '(reversal_transaction_id IS NULL AND reversal_original_transaction_id IS NULL)',
] as const;

/**
 * Existence-only probe across four indexed buckets (REFUND/REVOKE × timestamp
 * missing/identity missing). It never counts or sorts the retained corpus.
 */
function hasUnresolvedAppleReversalEvidence(
  db: ReturnType<typeof getDb>,
  retryableOnly = false,
): boolean {
  for (const notificationType of REVERSAL_NOTIFICATION_TYPES) {
    for (const predicate of UNRESOLVED_REVERSAL_BUCKET_PREDICATES) {
      const retryPredicate = retryableOnly
        ? 'AND reversal_index_attempts < ?'
        : '';
      const statement = db.prepare(
        `SELECT 1 FROM apple_notification_inbox
          WHERE notification_type = ?
            AND ${predicate}
            ${retryPredicate}
          LIMIT 1`,
      );
      const hit = retryableOnly
        ? statement.get(notificationType, MAX_REVERSAL_INDEX_ATTEMPTS)
        : statement.get(notificationType);
      if (hit) return true;
    }
  }
  return false;
}

/**
 * Read at most four fixed-size index windows, deduplicate their overlap, then
 * decode no more than `limit` rows. Separate exact-type queries let SQLite use
 * the attempt-order suffix of migration 294's plain indexes without a temp
 * sort across the full retained corpus.
 */
function selectDueAppleReversalBackfillRows(
  db: ReturnType<typeof getDb>,
  limit: number,
): AppleReversalBackfillRow[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const candidates = new Map<number, AppleReversalBackfillRow>();
  for (const notificationType of REVERSAL_NOTIFICATION_TYPES) {
    for (const predicate of UNRESOLVED_REVERSAL_BUCKET_PREDICATES) {
      const rows = db.prepare(
        `SELECT id,
                signed_payload AS signedPayload,
                reversal_index_attempts AS indexAttempts
           FROM apple_notification_inbox
          WHERE notification_type = ?
            AND ${predicate}
            AND reversal_index_attempts < ?
          ORDER BY reversal_index_attempts ASC, id ASC
          LIMIT ?`,
      ).all(notificationType, MAX_REVERSAL_INDEX_ATTEMPTS, safeLimit) as AppleReversalBackfillRow[];
      for (const row of rows) candidates.set(row.id, row);
    }
  }
  return [...candidates.values()]
    .sort((left, right) => left.indexAttempts - right.indexAttempts || left.id - right.id)
    .slice(0, safeLimit);
}

export function backfillAppleReversalIndex(
  limit = 500,
  now = new Date(),
): AppleReversalBackfillResult {
  const db = getDb();
  const rows = selectDueAppleReversalBackfillRows(db, limit);
  const stamp = db.prepare(
    `UPDATE apple_notification_inbox
        SET reversal_transaction_id = ?,
            reversal_original_transaction_id = ?,
            reversal_indexed_at = ?,
            reversal_index_attempts = reversal_index_attempts + 1
      WHERE id = ?`,
  );
  const recordFailure = db.prepare(
    `UPDATE apple_notification_inbox
        SET reversal_index_attempts = reversal_index_attempts + 1
      WHERE id = ?`,
  );
  const nowIso = now.toISOString();
  let processed = 0;
  const failedInboxIds: number[] = [];
  for (const row of rows) {
    let ids: ReversalTransactionIds = { transactionId: null, originalTransactionId: null };
    let resolved = false;
    try {
      const outer = decodeAppleJwsPayload<any>(String(row.signedPayload ?? ''));
      const innerJws = outer?.data?.signedTransactionInfo;
      if (typeof innerJws === 'string') {
        ids = readReversalTransactionIds(decodeAppleJwsPayload<any>(innerJws));
        resolved = ids.transactionId !== null || ids.originalTransactionId !== null;
      }
    } catch {
      // Aggregate below. Logging every corrupt row let one restore request
      // emit hundreds of errors while still returning one bounded outcome.
    }
    if (!resolved) {
      recordFailure.run(row.id);
      failedInboxIds.push(row.id);
      continue;
    }
    stamp.run(ids.transactionId, ids.originalTransactionId, nowIso, row.id);
    processed += 1;
  }
  const hasRemaining = hasUnresolvedAppleReversalEvidence(db);
  const hasRetryableRemaining = hasUnresolvedAppleReversalEvidence(db, true);
  const backfillSummary = {
    scanned: rows.length,
    processed,
    failed: failedInboxIds.length,
    hasRemaining,
    hasRetryableRemaining,
    firstFailedInboxId: failedInboxIds[0] ?? null,
  };
  if (failedInboxIds.length > 0) {
    logger.error(
      backfillSummary,
      'apple-notification-inbox: reversal index remains incomplete; restoration stays fail-closed',
    );
    recordOperatorAlert({
      source: 'apple_notifications',
      severity: 'critical',
      dedupeKey: 'apple_reversal_index_incomplete',
      title: 'Apple reversal index is incomplete',
      detail: 'Pack restoration is fail-closed until legacy reversal identities are fully indexed or repaired.',
      suspectedArea: 'billing',
      userImpact: 'apple_pack_restoration_blocked',
      metadata: backfillSummary,
    });
  } else if (hasRetryableRemaining) {
    logger.warn(
      backfillSummary,
      'apple-notification-inbox: bounded reversal-index pass left a backlog; restoration stays fail-closed',
    );
  }
  return {
    scanned: rows.length,
    processed,
    failed: failedInboxIds.length,
    hasRemaining,
    hasRetryableRemaining,
  };
}

/**
 * Result of checking the durable inbox for an Apple-signed REFUND/REVOKE.
 * `unavailable` is deliberately distinct from `recorded`: both stop a grant,
 * but only signed evidence matching this transaction may be reported as a
 * refund/revocation to the caller.
 */
export type AppleReversalLookupResult =
  | { kind: 'recorded' }
  | { kind: 'clear' }
  | { kind: 'unavailable'; reason: 'invalid_transaction_id' | 'index_incomplete' | 'lookup_failed' };

export interface AppleReversalBackfillBudget {
  remainingPasses: number;
}

export interface AppleReversalLookupOptions {
  /** Shared mutable budget; decremented only when unresolved work runs. */
  backfillBudget: AppleReversalBackfillBudget;
}

/**
 * Check whether the durable inbox already holds an Apple-signed
 * REFUND/REVOKE for this transaction, in ANY state (QA5 P2
 * restore-refund-window-open).
 *
 * The restoration endpoint verifies only the JWS the client submits, so a user
 * who cached a transaction JWS before refunding could replay it and mint
 * credits while the server held Apple's own refund notice on disk — including
 * when that notice failed processing and never revoked anything.
 *
 * Indexed equality probe with no window (QA6 P2). The previous version scanned
 * the newest 2,000 reversals and decoded each payload in JS, so once the table
 * grew past the cap — and migration 286 forbids deletes — every older refund
 * became silently replayable. This version answers from the columns extracted
 * at ingest, and refuses to answer "clean" while ANY row is still unresolved.
 */
export function lookupAppleReversalForTransaction(
  transactionId: string,
  options: AppleReversalLookupOptions,
): AppleReversalLookupResult {
  const id = String(transactionId || '').trim();
  if (!id) return { kind: 'unavailable', reason: 'invalid_transaction_id' };
  try {
    const db = getDb();
    const hit = db
      .prepare(
        `SELECT 1 FROM apple_notification_inbox
          WHERE notification_type IN ('REFUND', 'REVOKE')
            AND (reversal_transaction_id = ? OR reversal_original_transaction_id = ?)
          LIMIT 1`,
      )
      .get(id, id);
    if (hit) return { kind: 'recorded' };

    // A clean verdict is only trustworthy once every reversal row has an
    // extracted identity. Resolve what is left, then fail CLOSED if the
    // backlog outlives this call rather than reporting a false clean.
    if (!hasUnresolvedAppleReversalEvidence(db)) return { kind: 'clear' };

    const mayBackfill = options.backfillBudget.remainingPasses > 0;
    if (mayBackfill) {
      options.backfillBudget.remainingPasses -= 1;
      backfillAppleReversalIndex();
    }
    // Re-probe BEFORE inspecting the remaining backlog. The bounded pass may
    // have indexed this exact transaction even when row 501+ is still pending.
    const retry = db
      .prepare(
        `SELECT 1 FROM apple_notification_inbox
          WHERE notification_type IN ('REFUND', 'REVOKE')
            AND (reversal_transaction_id = ? OR reversal_original_transaction_id = ?)
          LIMIT 1`,
      )
      .get(id, id);
    if (retry) return { kind: 'recorded' };
    return hasUnresolvedAppleReversalEvidence(db)
      ? { kind: 'unavailable', reason: 'index_incomplete' }
      : { kind: 'clear' };
  } catch (err) {
    // Fail CLOSED: if the reversal record cannot be read, do not mint credit
    // on a transaction that may already be refunded.
    logger.error({ err, transactionId: id }, 'apple-notification-inbox: reversal lookup failed; refusing to treat as clean');
    return { kind: 'unavailable', reason: 'lookup_failed' };
  }
}

/** Non-retryable inbox faults: retries cannot fix them, so the row fails
 * closed immediately with an operator alert instead of burning five attempts
 * while the money sits ungrantable (QA3 P3-14). */
class NonRetryableInboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableInboxError';
  }
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
  const isReversal = (REVERSAL_NOTIFICATION_TYPES as readonly string[]).includes(input.notificationType);
  // Best-effort product identity at ingest (QA3 P2-11): the retry selector
  // needs it in SQL. A malformed inner payload stores NULL and never blocks
  // durable ingestion — full verification still happens at processing time.
  let ingestProductId: string | null = null;
  // Reversal transaction identity at ingest (QA6 P2): REFUND/REVOKE rows get
  // their transaction ids in indexed columns so the restore path can probe
  // them directly instead of decoding a capped window of stored JWS.
  let reversalIds: ReversalTransactionIds = { transactionId: null, originalTransactionId: null };
  let reversalIndexResolved = !isReversal;
  try {
    const outer = verifyAppleJws(input.signedPayload, { requireX5c: false }).payload as Record<string, any>;
    const innerJws = outer?.data?.signedTransactionInfo;
    if (typeof innerJws === 'string' && innerJws) {
      const inner = verifyAppleJws(innerJws, { requireX5c: false }).payload as Record<string, any>;
      ingestProductId = typeof inner.productId === 'string' && inner.productId ? inner.productId : null;
      reversalIds = readReversalTransactionIds(inner);
      reversalIndexResolved = !isReversal
        || reversalIds.transactionId !== null
        || reversalIds.originalTransactionId !== null;
    }
  } catch {
    ingestProductId = null;
  }
  const tx = db.transaction((): IngestAppleNotificationResult => {
    const existing = db
      .prepare('SELECT * FROM apple_notification_inbox WHERE notification_uuid = ?')
      .get(input.notificationUuid) as RawRow | undefined;
    if (existing) return { kind: 'duplicate', row: mapRow(existing) };
    const inserted = db
      .prepare(
        `INSERT INTO apple_notification_inbox (
           notification_uuid, notification_type, subtype, environment,
           signed_payload, received_at, product_id,
           reversal_transaction_id, reversal_original_transaction_id, reversal_indexed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.notificationUuid,
        input.notificationType,
        input.subtype ?? null,
        input.environment ?? null,
        input.signedPayload,
        now.toISOString(),
        ingestProductId,
        isReversal ? reversalIds.transactionId : null,
        isReversal ? reversalIds.originalTransactionId : null,
        // A non-reversal needs no extraction. A reversal is resolved only
        // when at least one transaction identity was decoded; otherwise it
        // must remain in the fail-closed backlog.
        reversalIndexResolved ? now.toISOString() : null,
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

  if (packItem && !isApplePackFulfillmentActive()) {
    throw new PackFulfillmentDisabledError();
  }

  // Sandbox and TestFlight notifications carry valid Apple signatures and the
  // same bundle id. A sandbox purchase must never mint spendable production
  // credit: ledger grants require a Production-environment notification.
  // The VERIFIED outer payload's environment claim outranks the ingest-time
  // hint on the row; absent both, the grant is refused as unknown provenance.
  const notificationEnvironment = typeof outer?.data?.environment === 'string'
    ? outer.data.environment
    : row.environment;
  if (packItem && notificationEnvironment !== 'Production' && !isSandboxGrantAllowed()) {
    throw new Error(`refusing ledger grant for non-production environment: ${notificationEnvironment ?? 'unknown'}`);
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
      throw new NonRetryableInboxError(`pack purchase has an unsupported quantity: ${String(inner.quantity)}`);
    }
    const existingLot = findAiCreditLotByProviderTransaction('apple', transactionId);
    if (!existingLot && !isCreditPackPurchaseEligible({
      userId,
    })) {
      // Keep the row retryable because Apple may deliver the pack before the
      // subscription webhook that establishes the paid billing period.
      throw new Error('pack purchase requires an active Pro or Max billing period');
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

  const handledByLegacy = handleAppleNotification(row.notification_type, signedTransactionInfo, {
    notificationUUID: row.notification_uuid,
    subtype: row.subtype,
    environment: row.environment,
  });
  if (!handledByLegacy && row.notification_type === 'ONE_TIME_CHARGE') {
    // A paid consumable that resolves to NO catalog pack and NO legacy points
    // product is money with no destination — the exact trap of enabling pack
    // fulfillment before the APPLE_PRODUCT_ID_* env is pasted (QA3 P1-3).
    // Failing keeps it retryable so pasting the ids later lands the grant.
    recordOperatorAlert({
      source: 'apple_notifications',
      severity: 'critical',
      dedupeKey: `apple_inbox_unresolvable_charge:${row.notification_uuid}`,
      title: 'Apple ONE_TIME_CHARGE matched no catalog pack and no legacy product',
      metadata: {
        notificationUuid: row.notification_uuid,
        productId,
      },
    });
    throw new Error(`ONE_TIME_CHARGE for unresolvable product id: ${productId || 'unknown'}`);
  }
  if (!handledByLegacy && isPackReversalType(row.notification_type)) {
    // A refund/revoke whose product id resolves to no catalog pack (the
    // APPLE_PRODUCT_ID_* env is unset) previously fell through both the pack
    // branch and the ONE_TIME_CHARGE trap, and was marked processed with no
    // revocation and no signal — the user kept credits Apple refunded
    // (QA5 P2 pack-reversal-swallowed-when-product-id-unset).
    recordOperatorAlert({
      source: 'apple_notifications',
      severity: 'critical',
      dedupeKey: `apple_inbox_unresolvable_reversal:${row.notification_uuid}`,
      title: 'Apple reversal matched no catalog pack and no legacy product',
      detail: 'A REFUND/REVOKE could not be attributed, so no credit was revoked. Check APPLE_PRODUCT_ID_* configuration.',
      suspectedArea: 'billing',
      metadata: {
        notificationUuid: row.notification_uuid,
        notificationType: row.notification_type,
        productId,
      },
    });
    throw new Error(`${row.notification_type} for unresolvable product id: ${productId || 'unknown'}`);
  }
  return handledByLegacy;
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
    const nonRetryable = error instanceof NonRetryableInboxError;
    if (nonRetryable) {
      recordOperatorAlert({
        source: 'apple_notifications',
        severity: 'critical',
        dedupeKey: `apple_inbox_nonretryable:${row.notification_uuid}`,
        title: 'Apple notification failed a non-retryable check',
        metadata: {
          notificationUuid: row.notification_uuid,
          notificationType: row.notification_type,
          error: message,
        },
      });
    }
    db.prepare(
      `UPDATE apple_notification_inbox
       SET state = 'failed', attempts = ?, last_error = ?
       WHERE id = ?`,
    ).run(nonRetryable ? MAX_PROCESS_ATTEMPTS : row.attempts + 1, message, row.id);
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
  /**
   * GAUGE, not a counter (QA6 P3): how many rows are stuck at the retry
   * ceiling right now, across all time. `exhausted` counts only the rows this
   * pass exhausted. The two were previously summed into `exhausted`, so the
   * number climbed on every scheduled pass even with no new failures.
   */
  stuckExhausted: number;
} {
  const db = getDb();
  const now = input.now ?? new Date();
  // The existing 15-minute Apple inbox reconciliation is also the durable
  // drain for migration-292 reversal identities. A request can still repair
  // one batch immediately, but correctness and eventual availability do not
  // depend on users repeatedly restoring the same transaction.
  const reversalBackfill = backfillAppleReversalIndex(500, now);
  if (reversalBackfill.processed > 0) {
    logger.info(reversalBackfill, 'Apple reversal index backfill pass');
  }
  // Deferred pack rows keep attempts at 0 forever while their kill switch is
  // off. Selecting them by received_at would park them permanently at the head
  // of every pass and starve retryable subscription notifications behind them,
  // so they are excluded while fulfillment is disabled.
  const packProductIds = isApplePackFulfillmentActive()
    ? []
    : Object.values(config.hybridCommerce.appleProductIds).filter(Boolean);
  // Exclusion selects on the STORED product id (QA3 P2-11), so a legacy
  // points ONE_TIME_CHARGE is never parked behind the pack kill switch.
  // It must NOT also require state='pending' AND attempts=0 (QA5 P2
  // deferred-pack-starves-retry-head-failed-state): a pack row that already
  // reached 'failed' keeps its old received_at, is re-selected every pass,
  // defers again, and starves newer notifications behind it forever.
  const excludeDeferredPacks = packProductIds.length > 0
    ? `AND NOT (notification_type = 'ONE_TIME_CHARGE'
        AND product_id IN (${packProductIds.map(() => '?').join(', ')}))`
    : '';
  const rows = db
    .prepare(
      `SELECT id FROM apple_notification_inbox
       WHERE state IN ('pending', 'failed') AND attempts < ?
       ${excludeDeferredPacks}
       ORDER BY received_at ASC
       LIMIT ?`,
    )
    .all(
      MAX_PROCESS_ATTEMPTS,
      ...packProductIds.length > 0 ? packProductIds : [],
      Math.max(1, Math.min(input.limit ?? 25, 100)),
    ) as Array<{ id: number }>;
  const counts = { processed: 0, failed: 0, exhausted: 0, deferred: 0, stuckExhausted: 0 };
  for (const { id } of rows) {
    const result = processStoredAppleNotification(id, now);
    if (result.kind === 'processed') counts.processed += 1;
    else if (result.kind === 'failed') counts.failed += 1;
    else if (result.kind === 'exhausted') counts.exhausted += 1;
    else if (result.kind === 'deferred') counts.deferred += 1;
  }

  // The selector above can never return an exhausted row (attempts < MAX), so
  // the exhausted-row alert was unreachable from the only scheduled caller
  // (QA5 P2 exhausted-inbox-rows-never-alert). Money Apple already collected
  // would sit ungrantable with zero signal. Surface them explicitly; the alert
  // dedupe key keeps repeated passes to one open alert per notification.
  // Reported separately from counts.exhausted (see the gauge docs above): the
  // sweep re-reports every historically stuck row, so summing the two inflated
  // the metric on every pass with no new failures (QA6 P3). The alert itself
  // stays — it is the only signal for rows the selector can never pick up
  // (QA5 P2 exhausted-inbox-rows-never-alert).
  counts.stuckExhausted = alertOnExhaustedAppleNotifications();
  return counts;
}

/**
 * Raise one operator alert per stuck, retry-exhausted inbox row.
 *
 * Every exhausted row alerts, with no page cap (QA6 P3): the previous limit of
 * 50 ordered oldest-first, so past 50 stuck rows the newest — the ones an
 * operator most needs to see — never alerted at all. Alerts dedupe per
 * notification uuid, so a large backlog produces one open alert per row rather
 * than repeated noise.
 */
function alertOnExhaustedAppleNotifications(): number {
  const rows = getDb()
    .prepare(
      `SELECT notification_uuid, notification_type, attempts
         FROM apple_notification_inbox
        WHERE state != 'processed' AND attempts >= ?
        ORDER BY received_at ASC`,
    )
    .all(MAX_PROCESS_ATTEMPTS) as Array<{
      notification_uuid: string;
      notification_type: string;
      attempts: number;
    }>;
  for (const row of rows) {
    recordOperatorAlert({
      source: 'apple_notifications',
      severity: 'warning',
      dedupeKey: `apple_inbox_exhausted:${row.notification_uuid}`,
      title: 'Apple notification exhausted its retries',
      detail: 'The notification will not be retried again; entitlement or credit it carries has not landed.',
      suspectedArea: 'billing',
      metadata: {
        notificationUuid: row.notification_uuid,
        notificationType: row.notification_type,
        attempts: row.attempts,
      },
    });
  }
  return rows.length;
}

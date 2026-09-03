// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * AI credit ledger — financial primitives for the hybrid AI commerce plan
 * (docs/release/hybrid-ai-commerce-production-plan.md §2).
 *
 * Contract:
 * - Default OFF, but fully wired: with `HYBRID_AI_CREDITS_ENABLED` on, chat
 *   turns and content script jobs reserve/capture here through
 *   `ai-credit-admission`, and included monthly lots are provisioned lazily
 *   by `ai-credit-provisioning`. While the flag is off every path is a
 *   passthrough with no ledger reads or writes.
 * - Admission order is entitlement first: callers resolve the effective plan
 *   through `entitlement.ts` / `plan-quotas.ts` BEFORE reserving. The ledger
 *   never derives ownership or plan from client-supplied data. Operation-
 *   class availability per plan (§2 "Unavailable" cells) IS enforced here at
 *   reservation, so no caller can admit an unavailable class.
 * - Lots and captures are append-only (schema triggers enforce this);
 *   reservations settle exactly once: reserved -> captured/released/expired.
 * - Debit order at capture: monthly credits, nearest-expiry promotional
 *   credits, then purchased credits FIFO. Purchased lots never expire.
 * - Replay identity (tenant, user, workload, request hash, client operation)
 *   is unique: a replayed admission returns the existing reservation and a
 *   settled replay never authorizes provider work again.
 */

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { recordOperatorAlert } from './operator-alerts';
import { logAudit } from './audit-trail';
import type { BillingPlan } from './plan-quotas';
import {
  AiCreditOperationClass,
  getAiCreditOperationCost,
  isAllowedPromotionalExpiryDays,
  isOperationClassAvailableForPlan,
} from './ai-credit-policy';

export type AiCreditLotType = 'monthly' | 'promotional' | 'purchased';
export type AiCreditReservationState = 'reserved' | 'captured' | 'released' | 'expired';
export type AiCreditProvider = 'stripe' | 'apple';

export interface AiCreditLot {
  id: number;
  userId: number;
  lotType: AiCreditLotType;
  creditsGranted: number;
  creditsRemaining: number;
  grantedAt: string;
  expiresAt: string | null;
  sourceKind: string;
  sourceRef: string;
  status: 'active' | 'revoked';
}

export interface AiCreditReservation {
  id: number;
  userId: number;
  operationClass: AiCreditOperationClass;
  credits: number;
  state: AiCreditReservationState;
  tenantScope: string;
  workload: string;
  requestHash: string;
  clientOperationId: string;
  reservedAt: string;
  reservedDay: string;
  settledAt: string | null;
  captureShortfall: number;
}

export interface AiCreditWallet {
  includedRemaining: number;
  promotionalRemaining: number;
  purchasedRemaining: number;
  reservedCredits: number;
  availableCredits: number;
  dailyCapCredits: number;
  dailyUsedCredits: number;
  dailyRemainingCredits: number;
  planMonthlyCredits: number;
}

export interface AiCreditReplayScope {
  tenantScope: string;
  workload: string;
  requestHash: string;
  clientOperationId: string;
}

export type ReserveAiCreditsResult =
  | { kind: 'reserved'; reservation: AiCreditReservation }
  | { kind: 'replay'; reservation: AiCreditReservation }
  | {
      kind: 'insufficient_credits';
      requiredCredits: number;
      availableCredits: number;
      packCtaEligible: boolean;
    }
  | {
      kind: 'daily_cap_exceeded';
      requiredCredits: number;
      dailyCapCredits: number;
      dailyRemainingCredits: number;
    }
  | {
      kind: 'operation_not_available';
      operationClass: AiCreditOperationClass;
      plan: BillingPlan;
    };

export type SettleAiCreditsResult =
  | { kind: 'captured'; reservation: AiCreditReservation; captureShortfall: number }
  | { kind: 'released'; reservation: AiCreditReservation }
  | { kind: 'invalid_state'; reservationId: number; state: AiCreditReservationState }
  | { kind: 'not_found'; reservationId: number }
  /** NH-0040 double-capture proof: a still-reserved reservation that already
   * has capture rows is ledger corruption — refuse instead of re-allocating. */
  | { kind: 'capture_conflict'; reservationId: number };

export type GrantAiCreditsResult =
  | { kind: 'granted'; lot: AiCreditLot }
  | { kind: 'already_granted'; lot: AiCreditLot }
  | { kind: 'rejected'; reason: string };

export type RevokeAiCreditLotResult =
  | { kind: 'revoked'; lot: AiCreditLot }
  | { kind: 'already_revoked'; lot: AiCreditLot }
  | { kind: 'not_found'; lotId: number };

interface PlanCreditPolicy {
  monthlyCredits: number;
  dailyCapCredits: number;
}

// ── Grant-path registry (QA5 P1-2 activation guard) ─────────────────
// Admission may only be enabled while some runtime path can actually mint
// lots. Modules that provide one register at import time; startup asserts the
// registry is non-empty so "credits on, nothing grants" fails loudly at boot
// instead of denying every paid operation at runtime.
export const MONTHLY_INCLUDED_GRANT_PATH = 'monthly_included' as const;

const registeredGrantPaths = new Set<string>();

export function registerAiCreditGrantPath(name: string): void {
  if (name) registeredGrantPaths.add(name);
}

export function listRegisteredAiCreditGrantPaths(): string[] {
  return [...registeredGrantPaths].sort();
}

function toIso(value: Date): string {
  return value.toISOString();
}

function toUtcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Missing plan rows fail closed: zero credits, zero daily cap. */
export function getPlanCreditPolicy(
  plan: BillingPlan,
  database: Database.Database = getDb(),
): PlanCreditPolicy {
  const db = database;
  const row = db
    .prepare('SELECT monthly_ai_credits, daily_ai_credit_cap FROM plan_configs WHERE plan_id = ?')
    .get(plan) as { monthly_ai_credits: number | null; daily_ai_credit_cap: number | null } | undefined;
  return {
    monthlyCredits: Math.max(0, row?.monthly_ai_credits ?? 0),
    dailyCapCredits: Math.max(0, row?.daily_ai_credit_cap ?? 0),
  };
}

interface LotRow {
  id: number;
  user_id: number;
  lot_type: AiCreditLotType;
  credits_granted: number;
  captured: number;
  granted_at: string;
  expires_at: string | null;
  source_kind: string;
  source_ref: string;
  status: 'active' | 'revoked';
}

function mapLot(row: LotRow): AiCreditLot {
  return {
    id: row.id,
    userId: row.user_id,
    lotType: row.lot_type,
    creditsGranted: row.credits_granted,
    creditsRemaining: Math.max(0, row.credits_granted - row.captured),
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    status: row.status,
  };
}

interface ReservationRow {
  id: number;
  user_id: number;
  operation_class: AiCreditOperationClass;
  credits: number;
  state: AiCreditReservationState;
  tenant_scope: string;
  workload: string;
  request_hash: string;
  client_operation_id: string;
  reserved_at: string;
  reserved_day: string;
  settled_at: string | null;
  capture_shortfall: number;
}

function mapReservation(row: ReservationRow): AiCreditReservation {
  return {
    id: row.id,
    userId: row.user_id,
    operationClass: row.operation_class,
    credits: row.credits,
    state: row.state,
    tenantScope: row.tenant_scope,
    workload: row.workload,
    requestHash: row.request_hash,
    clientOperationId: row.client_operation_id,
    reservedAt: row.reserved_at,
    reservedDay: row.reserved_day,
    settledAt: row.settled_at,
    captureShortfall: row.capture_shortfall,
  };
}

const LOT_WITH_CAPTURED_SQL = `
  SELECT l.id, l.user_id, l.lot_type, l.credits_granted, l.granted_at, l.expires_at,
         l.source_kind, l.source_ref, l.status,
         COALESCE(c.captured, 0) AS captured
  FROM ai_credit_lots l
  LEFT JOIN (
    SELECT lot_id, SUM(credits) AS captured FROM ai_credit_captures GROUP BY lot_id
  ) c ON c.lot_id = l.id
`;

/**
 * Usable lots in debit order: monthly, then promotional by nearest expiry,
 * then purchased FIFO by grant time.
 */
function listUsableLots(
  userId: number,
  nowIso: string,
  database: Database.Database = getDb(),
): LotRow[] {
  const db = database;
  const rows = db
    .prepare(
      `${LOT_WITH_CAPTURED_SQL}
       WHERE l.user_id = ? AND l.status = 'active'
         AND (l.expires_at IS NULL OR l.expires_at > ?)
       ORDER BY CASE l.lot_type WHEN 'monthly' THEN 0 WHEN 'promotional' THEN 1 ELSE 2 END,
                CASE WHEN l.expires_at IS NULL THEN 1 ELSE 0 END,
                l.expires_at ASC,
                l.granted_at ASC,
                l.id ASC`,
    )
    .all(userId, nowIso) as LotRow[];
  return rows.filter((row) => row.credits_granted - row.captured > 0);
}

function sumActiveReservations(
  userId: number,
  database: Database.Database = getDb(),
): number {
  const db = database;
  const row = db
    .prepare(`SELECT COALESCE(SUM(credits), 0) AS total FROM ai_credit_reservations WHERE user_id = ? AND state = 'reserved'`)
    .get(userId) as { total: number };
  return row.total;
}

function sumDailyCommittedCredits(
  userId: number,
  day: string,
  database: Database.Database = getDb(),
): number {
  const db = database;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(credits), 0) AS total
       FROM ai_credit_reservations
       WHERE user_id = ? AND reserved_day = ? AND state IN ('reserved', 'captured')`,
    )
    .get(userId, day) as { total: number };
  return row.total;
}

export function getAiCreditWallet(userId: number, plan: BillingPlan, now: Date = new Date()): AiCreditWallet {
  const policy = getPlanCreditPolicy(plan);
  const lots = listUsableLots(userId, toIso(now));
  let included = 0;
  let promotional = 0;
  let purchased = 0;
  for (const lot of lots) {
    const remaining = lot.credits_granted - lot.captured;
    if (lot.lot_type === 'monthly') included += remaining;
    else if (lot.lot_type === 'promotional') promotional += remaining;
    else purchased += remaining;
  }
  const reserved = sumActiveReservations(userId);
  const day = toUtcDay(now);
  const dailyUsed = sumDailyCommittedCredits(userId, day);
  return {
    includedRemaining: included,
    promotionalRemaining: promotional,
    purchasedRemaining: purchased,
    reservedCredits: reserved,
    availableCredits: Math.max(0, included + promotional + purchased - reserved),
    dailyCapCredits: policy.dailyCapCredits,
    dailyUsedCredits: dailyUsed,
    dailyRemainingCredits: Math.max(0, policy.dailyCapCredits - dailyUsed),
    planMonthlyCredits: policy.monthlyCredits,
  };
}

function getReservationByReplayScope(
  userId: number,
  scope: AiCreditReplayScope,
  database: Database.Database = getDb(),
): ReservationRow | undefined {
  const db = database;
  return db
    .prepare(
      `SELECT * FROM ai_credit_reservations
       WHERE tenant_scope = ? AND user_id = ? AND workload = ? AND request_hash = ? AND client_operation_id = ?`,
    )
    .get(scope.tenantScope, userId, scope.workload, scope.requestHash, scope.clientOperationId) as
    | ReservationRow
    | undefined;
}

export function getAiCreditReservation(
  reservationId: number,
  database: Database.Database = getDb(),
): AiCreditReservation | null {
  const db = database;
  const row = db.prepare('SELECT * FROM ai_credit_reservations WHERE id = ?').get(reservationId) as
    | ReservationRow
    | undefined;
  return row ? mapReservation(row) : null;
}

/**
 * Atomically admit one credit-bearing operation. Insufficient balance and
 * daily-cap denials report the exact required and available amounts and do
 * not start the request. Purchased credits never bypass the daily cap.
 */
export function reserveAiCredits(input: {
  userId: number;
  plan: BillingPlan;
  operationClass: AiCreditOperationClass;
  replayScope: AiCreditReplayScope;
  now?: Date;
}, database: Database.Database = getDb()): ReserveAiCreditsResult {
  const db = database;
  const now = input.now ?? new Date();
  const cost = getAiCreditOperationCost(input.operationClass);
  const packCtaEligible = input.plan === 'pro' || input.plan === 'max';
  const tx = db.transaction((): ReserveAiCreditsResult => {
    // Availability outranks replay (QA3 P2-12): a scope reserved on a paid
    // plan must not be replayable into a restricted class after a downgrade.
    if (!isOperationClassAvailableForPlan(input.plan, input.operationClass)) {
      return {
        kind: 'operation_not_available',
        operationClass: input.operationClass,
        plan: input.plan,
      };
    }
    const existing = getReservationByReplayScope(input.userId, input.replayScope, db);
    if (existing) {
      return { kind: 'replay', reservation: mapReservation(existing) };
    }
    const policy = getPlanCreditPolicy(input.plan, db);
    const day = toUtcDay(now);
    const dailyUsed = sumDailyCommittedCredits(input.userId, day, db);
    if (dailyUsed + cost > policy.dailyCapCredits) {
      return {
        kind: 'daily_cap_exceeded',
        requiredCredits: cost,
        dailyCapCredits: policy.dailyCapCredits,
        dailyRemainingCredits: Math.max(0, policy.dailyCapCredits - dailyUsed),
      };
    }
    const lots = listUsableLots(input.userId, toIso(now), db);
    const usable = lots.reduce((total, lot) => total + (lot.credits_granted - lot.captured), 0);
    const available = Math.max(0, usable - sumActiveReservations(input.userId, db));
    if (cost > available) {
      return {
        kind: 'insufficient_credits',
        requiredCredits: cost,
        availableCredits: available,
        packCtaEligible,
      };
    }
    const inserted = db
      .prepare(
        `INSERT INTO ai_credit_reservations (
           user_id, operation_class, credits, state, tenant_scope, workload,
           request_hash, client_operation_id, reserved_at, reserved_day
         ) VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.userId,
        input.operationClass,
        cost,
        input.replayScope.tenantScope,
        input.replayScope.workload,
        input.replayScope.requestHash,
        input.replayScope.clientOperationId,
        toIso(now),
        day,
      );
    const reservation = getAiCreditReservation(Number(inserted.lastInsertRowid), db);
    if (!reservation) {
      throw new Error('ai-credit-ledger: reservation insert readback failed');
    }
    return { kind: 'reserved', reservation };
  });
  return tx.immediate();
}

/**
 * Capture exactly once after a validated user-visible result. Consumption is
 * allocated across lots in debit order. If usable lots shrank between reserve
 * and capture (expiry or revocation mid-operation) the unallocatable portion
 * is recorded as capture_shortfall instead of corrupting other lots; the user
 * is never charged twice for one operation.
 */
export function captureAiCreditReservation(input: {
  reservationId: number;
  resultRef?: string;
  now?: Date;
}, database: Database.Database = getDb()): SettleAiCreditsResult {
  const db = database;
  const now = input.now ?? new Date();
  const tx = db.transaction((): SettleAiCreditsResult => {
    const row = db.prepare('SELECT * FROM ai_credit_reservations WHERE id = ?').get(input.reservationId) as
      | ReservationRow
      | undefined;
    if (!row) return { kind: 'not_found', reservationId: input.reservationId };
    if (row.state !== 'reserved') {
      return { kind: 'invalid_state', reservationId: row.id, state: row.state };
    }
    // Double-capture proof (NH-0040): the state machine says this reservation
    // never captured, so any existing capture row is corruption. A schema-level
    // unique index on this pre-existing table would classify as a contract
    // migration and freeze CD, so the guard lives here, inside the same
    // immediate transaction that performs the allocation.
    const existingCaptures = db
      .prepare('SELECT COUNT(*) AS n FROM ai_credit_captures WHERE reservation_id = ?')
      .get(row.id) as { n: number };
    if (existingCaptures.n > 0) {
      recordOperatorAlert({
        severity: 'critical',
        source: 'ai-credit-ledger',
        dedupeKey: `ai_credit_capture_conflict:${row.id}`,
        title: 'AI credit capture conflict',
        detail: `Reservation ${row.id} is marked reserved but already has ${existingCaptures.n} capture row(s); refusing a second allocation.`,
        metadata: { reservationId: row.id, userId: row.user_id, existingCaptureRows: existingCaptures.n },
        suspectedArea: 'billing',
        userImpact: 'none_capture_refused',
      }, db);
      return { kind: 'capture_conflict', reservationId: row.id };
    }
    let remainingToCapture = row.credits;
    const insertCapture = db.prepare(
      `INSERT INTO ai_credit_captures (reservation_id, lot_id, user_id, credits, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const lot of listUsableLots(row.user_id, toIso(now), db)) {
      if (remainingToCapture <= 0) break;
      const lotRemaining = lot.credits_granted - lot.captured;
      const take = Math.min(lotRemaining, remainingToCapture);
      insertCapture.run(row.id, lot.id, row.user_id, take, toIso(now));
      remainingToCapture -= take;
    }
    db.prepare(
      `UPDATE ai_credit_reservations
       SET state = 'captured', settled_at = ?, capture_result_ref = ?, capture_shortfall = ?
       WHERE id = ?`,
    ).run(toIso(now), input.resultRef ?? null, remainingToCapture, row.id);
    if (remainingToCapture > 0) {
      logger.warn(
        { reservationId: row.id, captureShortfall: remainingToCapture },
        'ai-credit-ledger capture shortfall: usable lots shrank between reserve and capture',
      );
      // NH-0041: a shortfall means a mid-operation revocation/expiry left part
      // of a delivered operation unbilled. Raise an operator alert instead of
      // leaving only the evidence row for a reconciliation pass to find.
      recordOperatorAlert({
        severity: 'warning',
        source: 'ai-credit-ledger',
        dedupeKey: `ai_credit_capture_shortfall:${row.id}`,
        title: 'AI credit capture shortfall',
        detail: `Reservation ${row.id} captured ${row.credits - remainingToCapture}/${row.credits} credits; usable lots shrank mid-operation.`,
        metadata: { reservationId: row.id, userId: row.user_id, shortfall: remainingToCapture },
        suspectedArea: 'billing',
        userImpact: 'none_user_kept_result',
      }, db);
    }
    const reservation = getAiCreditReservation(row.id, db);
    if (!reservation) {
      throw new Error('ai-credit-ledger: capture readback failed');
    }
    return { kind: 'captured', reservation, captureShortfall: remainingToCapture };
  });
  return tx.immediate();
}

/** Release returns the reserved credits on cancellation or failure. */
export function releaseAiCreditReservation(input: {
  reservationId: number;
  now?: Date;
}, database: Database.Database = getDb()): SettleAiCreditsResult {
  const db = database;
  const now = input.now ?? new Date();
  const tx = db.transaction((): SettleAiCreditsResult => {
    const row = db.prepare('SELECT * FROM ai_credit_reservations WHERE id = ?').get(input.reservationId) as
      | ReservationRow
      | undefined;
    if (!row) return { kind: 'not_found', reservationId: input.reservationId };
    if (row.state !== 'reserved') {
      return { kind: 'invalid_state', reservationId: row.id, state: row.state };
    }
    db.prepare(`UPDATE ai_credit_reservations SET state = 'released', settled_at = ? WHERE id = ?`).run(
      toIso(now),
      row.id,
    );
    const reservation = getAiCreditReservation(row.id, db);
    if (!reservation) {
      throw new Error('ai-credit-ledger: release readback failed');
    }
    return { kind: 'released', reservation };
  });
  return tx.immediate();
}

/**
 * Expire stale reservations older than the cutoff. Operational sweeper hook;
 * scheduler wiring ships with the admission layer. Purchase-linked admissions
 * (e.g. StoreKit Ask-to-Buy) must NOT be expired by client-elapsed time —
 * callers own that exclusion per the plan's StoreKit invariants.
 */
export function expireStaleAiCreditReservations(input: { olderThan: Date; now?: Date }): number {
  const db = getDb();
  const now = input.now ?? new Date();
  const stale = db
    .prepare(`SELECT id FROM ai_credit_reservations WHERE state = 'reserved' AND reserved_at < ?`)
    .all(toIso(input.olderThan)) as Array<{ id: number }>;
  const tx = db.transaction(() => {
    const update = db.prepare(
      `UPDATE ai_credit_reservations SET state = 'expired', settled_at = ? WHERE id = ? AND state = 'reserved'`,
    );
    let expired = 0;
    for (const row of stale) {
      expired += update.run(toIso(now), row.id).changes;
    }
    return expired;
  });
  return tx.immediate();
}

function getLotById(lotId: number): LotRow | undefined {
  const db = getDb();
  return db.prepare(`${LOT_WITH_CAPTURED_SQL} WHERE l.id = ?`).get(lotId) as LotRow | undefined;
}

function insertLot(input: {
  userId: number;
  lotType: AiCreditLotType;
  credits: number;
  grantedAt: string;
  expiresAt: string | null;
  sourceKind: 'subscription_period' | 'promotion' | 'provider_purchase' | 'admin_grant';
  sourceRef: string;
  provider?: AiCreditProvider;
  providerTransactionId?: string;
}): AiCreditLot {
  const db = getDb();
  const inserted = db
    .prepare(
      `INSERT INTO ai_credit_lots (
         user_id, lot_type, credits_granted, granted_at, expires_at,
         source_kind, source_ref, provider, provider_transaction_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.lotType,
      input.credits,
      input.grantedAt,
      input.expiresAt,
      input.sourceKind,
      input.sourceRef,
      input.provider ?? null,
      input.providerTransactionId ?? null,
    );
  const lot = getLotById(Number(inserted.lastInsertRowid));
  if (!lot) throw new Error('ai-credit-ledger: lot insert readback failed');
  return mapLot(lot);
}

/** Marker written to `revoke_reason` when a period change supersedes a lot. */
export const SUPERSEDED_BY_PERIOD_CHANGE = 'superseded_by_period_change' as const;

/**
 * Grant the plan's included monthly credits for one billing period, exactly
 * once per (user, period). Included credits expire at period end and never
 * roll over.
 *
 * Ledger invariant (QA6 P1): a user has AT MOST ONE live included lot, and it
 * carries exactly the plan allowance. When a grant arrives under a different
 * period key while an included lot is still live — a renewal, or a stopgap
 * calendar lot being replaced by the real billing period — the old lot is
 * SUPERSEDED inside this same transaction rather than stacked beside the new
 * one. Callers keep period keys stable (see `ai-credit-provisioning`); this
 * is the structural backstop that holds even if a key is wrong, so no key bug
 * can ever put more than one allowance of included credit in a wallet.
 *
 * Superseding revokes rather than deletes: the lot row, its grant, and every
 * capture taken against it stay on the append-only ledger, carrying
 * `revoke_reason = 'superseded_by_period_change'` for the operator.
 */
export function grantMonthlyAiCredits(input: {
  userId: number;
  plan: BillingPlan;
  periodKey: string;
  periodEnd: Date;
  now?: Date;
}): GrantAiCreditsResult {
  const db = getDb();
  const now = input.now ?? new Date();
  if (!input.periodKey) return { kind: 'rejected', reason: 'periodKey is required' };
  const tx = db.transaction((): GrantAiCreditsResult => {
    const existing = db
      .prepare(
        `${LOT_WITH_CAPTURED_SQL} WHERE l.user_id = ? AND l.source_kind = 'subscription_period' AND l.source_ref = ?`,
      )
      .get(input.userId, input.periodKey) as LotRow | undefined;
    if (existing) return { kind: 'already_granted', lot: mapLot(existing) };
    const policy = getPlanCreditPolicy(input.plan);
    if (policy.monthlyCredits <= 0) {
      return { kind: 'rejected', reason: `plan ${input.plan} grants no monthly AI credits` };
    }
    // Supersede every OTHER live included lot before minting this period's.
    // Plural on purpose: it also self-heals a wallet that a previous defect
    // left holding more than one.
    const nowIso = toIso(now);
    const superseded = db
      .prepare(
        `SELECT id FROM ai_credit_lots
          WHERE user_id = ? AND source_kind = 'subscription_period'
            AND source_ref <> ? AND status = 'active'
            AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(input.userId, input.periodKey, nowIso) as Array<{ id: number }>;
    for (const row of superseded) {
      db.prepare(
        `UPDATE ai_credit_lots SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE id = ?`,
      ).run(nowIso, SUPERSEDED_BY_PERIOD_CHANGE, row.id);
    }
    const lot = insertLot({
      userId: input.userId,
      lotType: 'monthly',
      credits: policy.monthlyCredits,
      grantedAt: nowIso,
      expiresAt: toIso(input.periodEnd),
      sourceKind: 'subscription_period',
      sourceRef: input.periodKey,
    });
    if (superseded.length > 0) {
      logger.info(
        {
          userId: input.userId,
          plan: input.plan,
          periodKey: input.periodKey,
          supersededLotIds: superseded.map((row) => row.id),
        },
        'ai-credit-ledger: superseded prior included lot(s) on period change',
      );
    }
    return { kind: 'granted', lot };
  });
  return tx.immediate();
}

export function grantPromotionalAiCredits(input: {
  userId: number;
  promotionId: string;
  credits: number;
  expiryDays: number;
  now?: Date;
}): GrantAiCreditsResult {
  const db = getDb();
  const now = input.now ?? new Date();
  if (!input.promotionId) return { kind: 'rejected', reason: 'promotionId is required' };
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    return { kind: 'rejected', reason: 'credits must be a positive integer' };
  }
  if (!isAllowedPromotionalExpiryDays(input.expiryDays)) {
    return { kind: 'rejected', reason: 'promotional expiry must be 30, 60, or 90 days' };
  }
  const tx = db.transaction((): GrantAiCreditsResult => {
    const existing = db
      .prepare(`${LOT_WITH_CAPTURED_SQL} WHERE l.user_id = ? AND l.source_kind = 'promotion' AND l.source_ref = ?`)
      .get(input.userId, input.promotionId) as LotRow | undefined;
    if (existing) return { kind: 'already_granted', lot: mapLot(existing) };
    const expiresAt = new Date(now.getTime() + input.expiryDays * 24 * 60 * 60 * 1000);
    const lot = insertLot({
      userId: input.userId,
      lotType: 'promotional',
      credits: input.credits,
      grantedAt: toIso(now),
      expiresAt: toIso(expiresAt),
      sourceKind: 'promotion',
      sourceRef: input.promotionId,
    });
    return { kind: 'granted', lot };
  });
  return tx.immediate();
}

/** Plan §2: administrative overrides are audited and time-limited. */
export const ADMIN_GRANT_MAX_CREDITS = 5_000;
export const ADMIN_GRANT_MAX_EXPIRY_DAYS = 90;

/**
 * Audited, time-limited administrative credit grant (support or incident
 * recovery only). Grants land as promotional-class lots so they burn before
 * purchased credits and always expire; the grant id is idempotent per user.
 */
export function grantAdminAiCredits(input: {
  userId: number;
  grantId: string;
  credits: number;
  expiryDays: number;
  actorUserId: number;
  reason: string;
  now?: Date;
}): GrantAiCreditsResult {
  const db = getDb();
  const now = input.now ?? new Date();
  const grantId = input.grantId.trim();
  const reason = input.reason.trim();
  if (!grantId) return { kind: 'rejected', reason: 'grantId is required' };
  if (!reason) return { kind: 'rejected', reason: 'a non-empty reason is required' };
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    return { kind: 'rejected', reason: 'an authenticated operator actor is required' };
  }
  if (!Number.isInteger(input.credits) || input.credits <= 0 || input.credits > ADMIN_GRANT_MAX_CREDITS) {
    return { kind: 'rejected', reason: `credits must be a positive integer up to ${ADMIN_GRANT_MAX_CREDITS}` };
  }
  if (!Number.isInteger(input.expiryDays) || input.expiryDays < 1 || input.expiryDays > ADMIN_GRANT_MAX_EXPIRY_DAYS) {
    return { kind: 'rejected', reason: `expiryDays must be between 1 and ${ADMIN_GRANT_MAX_EXPIRY_DAYS}` };
  }
  const tx = db.transaction((): GrantAiCreditsResult => {
    const existing = db
      .prepare(`${LOT_WITH_CAPTURED_SQL} WHERE l.user_id = ? AND l.source_kind = 'admin_grant' AND l.source_ref = ?`)
      .get(input.userId, grantId) as LotRow | undefined;
    if (existing) return { kind: 'already_granted', lot: mapLot(existing) };
    const expiresAt = new Date(now.getTime() + input.expiryDays * 24 * 60 * 60 * 1000);
    const lot = insertLot({
      userId: input.userId,
      lotType: 'promotional',
      credits: input.credits,
      grantedAt: toIso(now),
      expiresAt: toIso(expiresAt),
      sourceKind: 'admin_grant',
      sourceRef: grantId,
    });
    return { kind: 'granted', lot };
  });
  const result = tx.immediate();
  if (result.kind === 'granted') {
    logAudit({
      userId: input.userId,
      actorId: input.actorUserId,
      action: 'ai_credit_admin_grant',
      resource: `ai_credit_lot:${result.lot.id}`,
      details: { grantId, credits: input.credits, expiryDays: input.expiryDays, reason },
    });
  }
  return result;
}

/**
 * Purchased credits never expire. The provider transaction identity is
 * unique: a replayed provider event returns the originally granted lot.
 */
export function grantPurchasedAiCredits(input: {
  userId: number;
  provider: AiCreditProvider;
  providerTransactionId: string;
  credits: number;
  now?: Date;
}): GrantAiCreditsResult {
  const db = getDb();
  const now = input.now ?? new Date();
  if (!input.providerTransactionId) {
    return { kind: 'rejected', reason: 'providerTransactionId is required' };
  }
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    return { kind: 'rejected', reason: 'credits must be a positive integer' };
  }
  const sourceRef = `${input.provider}:${input.providerTransactionId}`;
  const tx = db.transaction((): GrantAiCreditsResult => {
    const existing = db
      .prepare(`${LOT_WITH_CAPTURED_SQL} WHERE l.provider = ? AND l.provider_transaction_id = ?`)
      .get(input.provider, input.providerTransactionId) as LotRow | undefined;
    if (existing) {
      const lot = mapLot(existing);
      if (lot.userId !== input.userId) {
        return { kind: 'rejected', reason: 'provider transaction belongs to another user' };
      }
      return { kind: 'already_granted', lot };
    }
    const lot = insertLot({
      userId: input.userId,
      lotType: 'purchased',
      credits: input.credits,
      grantedAt: toIso(now),
      expiresAt: null,
      sourceKind: 'provider_purchase',
      sourceRef,
      provider: input.provider,
      providerTransactionId: input.providerTransactionId,
    });
    return { kind: 'granted', lot };
  });
  return tx.immediate();
}

/**
 * Refunds, disputes, and revocations affect only the originating lot. Past
 * captures against the lot remain recorded; other balances are untouched.
 */
export function revokeAiCreditLot(input: {
  lotId: number;
  reason: string;
  now?: Date;
}): RevokeAiCreditLotResult {
  const db = getDb();
  const now = input.now ?? new Date();
  const tx = db.transaction((): RevokeAiCreditLotResult => {
    const existing = getLotById(input.lotId);
    if (!existing) return { kind: 'not_found', lotId: input.lotId };
    if (existing.status === 'revoked') return { kind: 'already_revoked', lot: mapLot(existing) };
    db.prepare(
      `UPDATE ai_credit_lots SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE id = ?`,
    ).run(toIso(now), input.reason || 'unspecified', input.lotId);
    const lot = getLotById(input.lotId);
    if (!lot) throw new Error('ai-credit-ledger: revoke readback failed');
    return { kind: 'revoked', lot: mapLot(lot) };
  });
  return tx.immediate();
}

export function listAiCreditLots(userId: number): AiCreditLot[] {
  const db = getDb();
  const rows = db
    .prepare(`${LOT_WITH_CAPTURED_SQL} WHERE l.user_id = ? ORDER BY l.id ASC`)
    .all(userId) as LotRow[];
  return rows.map(mapLot);
}

/**
 * All reservations sharing one request identity (e.g. a durable job and its
 * user-initiated retries), oldest first. Async operations settle against the
 * newest still-reserved entry.
 */
export function listAiCreditReservationsForRequest(input: {
  tenantScope: string;
  userId: number;
  workload: string;
  requestHash: string;
}, database: Database.Database = getDb()): AiCreditReservation[] {
  const db = database;
  const rows = db
    .prepare(
      `SELECT * FROM ai_credit_reservations
       WHERE tenant_scope = ? AND user_id = ? AND workload = ? AND request_hash = ?
       ORDER BY id ASC`,
    )
    .all(input.tenantScope, input.userId, input.workload, input.requestHash) as ReservationRow[];
  return rows.map(mapReservation);
}

/** Provider-event binding lookup for refunds, disputes, and revocations. */
export function findAiCreditLotByProviderTransaction(
  provider: AiCreditProvider,
  providerTransactionId: string,
): AiCreditLot | null {
  if (!providerTransactionId) return null;
  const db = getDb();
  const row = db
    .prepare(`${LOT_WITH_CAPTURED_SQL} WHERE l.provider = ? AND l.provider_transaction_id = ?`)
    .get(provider, providerTransactionId) as LotRow | undefined;
  return row ? mapLot(row) : null;
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getActiveUserAiBudgetOverride } from './ai-budget-overrides';
import { getEffectiveEntitlement } from './entitlement';
import { logAudit } from './audit-trail';

export const NEXUS_POINT_USD_ALLOWANCE = 0.001;
export const NEXUS_POINT_EXPIRY_DAYS = 30;

/**
 * Nonexpiring sentinel (hybrid AI plan §3 / Addendum B, NH-0029). The schema
 * requires a NOT NULL expiry, so "never expires" is this far-future instant.
 * Every consumer — balance filters, nearest-expiry debit order, expiring-soon
 * windows, and the expiry sweep — treats it correctly without changes, and it
 * deliberately sorts LAST in the nearest-expiry-first debit order.
 */
export const NEXUS_POINTS_NONEXPIRING_AT = '9999-12-31T00:00:00.000Z';

export function isNexusPointsCutoverActive(): boolean {
  return config.hybridCredits?.pointsCutover === true;
}

export type NexusPointPackageId =
  | 'me.nexushub.points.small'
  | 'me.nexushub.points.medium'
  | 'me.nexushub.points.large';

export interface NexusPointPackage {
  productId: NexusPointPackageId;
  label: 'small' | 'medium' | 'large';
  priceUsd: number;
  points: number;
  usdAllowance: number;
  aiOnlyMarginPct: number;
  netMarginAfterAppleCutPct: number;
}

export const NEXUS_POINT_PACKAGES: Record<NexusPointPackageId, NexusPointPackage> = {
  // Plan §3: the legacy points products keep their ORIGINAL economics — the
  // $x.99 price points belong to the NEW versioned credit packs
  // (pack.credits.*), never to these live product ids. QA round 3 (P0-1)
  // caught an in-place repricing that granted a third of the points for the
  // same Apple charge; this block is the restored pre-repricing truth.
  'me.nexushub.points.small': {
    productId: 'me.nexushub.points.small',
    label: 'small',
    priceUsd: 5,
    points: 300,
    usdAllowance: 0.30,
    aiOnlyMarginPct: 94,
    netMarginAfterAppleCutPct: 91.4,
  },
  'me.nexushub.points.medium': {
    productId: 'me.nexushub.points.medium',
    label: 'medium',
    priceUsd: 10,
    points: 600,
    usdAllowance: 0.60,
    aiOnlyMarginPct: 94,
    netMarginAfterAppleCutPct: 91.4,
  },
  'me.nexushub.points.large': {
    productId: 'me.nexushub.points.large',
    label: 'large',
    priceUsd: 20,
    points: 1200,
    usdAllowance: 1.20,
    aiOnlyMarginPct: 94,
    netMarginAfterAppleCutPct: 91.4,
  },
};

export interface NexusPointBalance {
  pointsBalance: number;
  usdBalance: number;
  nextCreditExpiryAt: string | null;
  pointsExpiringSoon: number;
  usdExpiringSoon: number;
}

export interface GrantNexusPointsInput {
  userId: number;
  provider: 'apple' | 'stripe' | 'portal' | string;
  providerTransactionId: string;
  productId: string;
  source?: string;
  purchasedAt?: Date;
  metadata?: Record<string, unknown> | null;
}

export interface GrantNexusPointsResult {
  granted: boolean;
  package: NexusPointPackage;
  creditId: number | null;
}

export interface RevokeNexusPointsResult {
  revoked: boolean;
  creditId: number | null;
  previousStatus: string | null;
  userId?: number;
  productId?: string;
  pointsGranted?: number;
  pointsRemaining?: number;
}

export interface NexusPointCreditLookup {
  id: number;
  userId: number;
  provider: string;
  providerTransactionId: string;
  status: string;
  productId: string;
  pointsGranted: number;
  pointsRemaining: number;
  usdAllowanceGranted: number;
  usdAllowanceRemaining: number;
  metadata: Record<string, unknown> | null;
}

export function isNexusPointProductId(productId: string): productId is NexusPointPackageId {
  return Object.prototype.hasOwnProperty.call(NEXUS_POINT_PACKAGES, productId);
}

export function getNexusPointPackage(productId: string): NexusPointPackage | null {
  return isNexusPointProductId(productId) ? NEXUS_POINT_PACKAGES[productId] : null;
}

export function listNexusPointPackages(): NexusPointPackage[] {
  return Object.values(NEXUS_POINT_PACKAGES).map((pkg) => ({ ...pkg }));
}

export function grantNexusPoints(input: GrantNexusPointsInput): GrantNexusPointsResult {
  const pkg = getNexusPointPackage(input.productId);
  if (!pkg) throw new Error(`Unknown Nexus Points product: ${input.productId}`);
  const purchasedAt = input.purchasedAt ?? new Date();
  // Post-cutover, purchases at the legacy product ids keep their point
  // economics (plan §3) but never expire (Addendum B).
  const expiresAt = isNexusPointsCutoverActive()
    ? NEXUS_POINTS_NONEXPIRING_AT
    : new Date(purchasedAt.getTime() + NEXUS_POINT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  const metadataJson = stringifyCreditMetadata(input.metadata, input.provider, input.providerTransactionId);
  const result = db.prepare(`
    INSERT OR IGNORE INTO nexus_point_credits (
      user_id, source, provider, product_id, provider_transaction_id,
      points_granted, points_remaining, usd_allowance_granted,
      usd_allowance_remaining, purchased_at, expires_at, status, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    input.userId,
    input.source ?? 'purchase',
    input.provider,
    input.productId,
    input.providerTransactionId,
    pkg.points,
    pkg.points,
    pkg.usdAllowance,
    pkg.usdAllowance,
    purchasedAt.toISOString(),
    expiresAt,
    metadataJson,
  );

  if (result.changes === 0) {
    const existing = db.prepare(`
      SELECT id FROM nexus_point_credits
      WHERE provider = ? AND provider_transaction_id = ?
      LIMIT 1
    `).get(input.provider, input.providerTransactionId) as { id: number } | undefined;
    return { granted: false, package: pkg, creditId: existing?.id ?? null };
  }

  return { granted: true, package: pkg, creditId: Number(result.lastInsertRowid) };
}

export function lookupNexusPointCreditByProviderTransaction(
  provider: string,
  providerTransactionId: string,
): NexusPointCreditLookup | null {
  const providerKey = String(provider || '').trim();
  const transactionId = String(providerTransactionId || '').trim();
  if (!providerKey || !transactionId) return null;
  const row = getDb().prepare(`
    SELECT id, user_id, provider, provider_transaction_id, status, product_id,
           points_granted, points_remaining, usd_allowance_granted,
           usd_allowance_remaining, metadata_json
    FROM nexus_point_credits
    WHERE provider = ? AND provider_transaction_id = ?
    LIMIT 1
  `).get(providerKey, transactionId) as any | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    provider: String(row.provider),
    providerTransactionId: String(row.provider_transaction_id),
    status: String(row.status),
    productId: String(row.product_id),
    pointsGranted: Number(row.points_granted || 0),
    pointsRemaining: Number(row.points_remaining || 0),
    usdAllowanceGranted: Number(row.usd_allowance_granted || 0),
    usdAllowanceRemaining: Number(row.usd_allowance_remaining || 0),
    metadata: parseCreditMetadata(row.metadata_json),
  };
}

export function revokeNexusPointsCredit(input: {
  provider: string;
  providerTransactionId: string;
  status: 'refunded' | 'revoked';
}): RevokeNexusPointsResult {
  const provider = String(input.provider || '').trim();
  const providerTransactionId = String(input.providerTransactionId || '').trim();
  if (!provider || !providerTransactionId) {
    return { revoked: false, creditId: null, previousStatus: null };
  }
  const db = getDb();
  const row = db.prepare(`
    SELECT id, status, user_id, product_id, points_granted, points_remaining
    FROM nexus_point_credits
    WHERE provider = ? AND provider_transaction_id = ?
    LIMIT 1
  `).get(provider, providerTransactionId) as {
    id: number;
    status: string;
    user_id: number;
    product_id: string;
    points_granted: number;
    points_remaining: number;
  } | undefined;
  if (!row) return { revoked: false, creditId: null, previousStatus: null };
  if (row.status === input.status) {
    return {
      revoked: false,
      creditId: row.id,
      previousStatus: row.status,
      userId: Number(row.user_id),
      productId: String(row.product_id),
      pointsGranted: Number(row.points_granted || 0),
      pointsRemaining: Number(row.points_remaining || 0),
    };
  }

  db.prepare(`
    UPDATE nexus_point_credits
    SET status = ?,
        points_remaining = 0,
        usd_allowance_remaining = 0,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(input.status, row.id);

  return {
    revoked: true,
    creditId: row.id,
    previousStatus: row.status,
    userId: Number(row.user_id),
    productId: String(row.product_id),
    pointsGranted: Number(row.points_granted || 0),
    pointsRemaining: Number(row.points_remaining || 0),
  };
}

export function getNexusPointBalance(userId: number, now = new Date()): NexusPointBalance {
  if (!Number.isFinite(userId) || userId <= 0) {
    return emptyBalance();
  }
  try {
    const db = getDb();
    expireOldNexusPointCredits(userId, now);
    const nowIso = now.toISOString();
    const soonIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(usd_allowance_remaining), 0) AS usd_balance,
        COALESCE(SUM(points_remaining), 0) AS points_balance,
        MIN(expires_at) AS next_expiry
      FROM nexus_point_credits
      WHERE user_id = ?
        AND status = 'active'
        AND expires_at > ?
        AND usd_allowance_remaining > 0
    `).get(userId, nowIso) as { usd_balance: number; points_balance: number; next_expiry: string | null };
    const expiring = db.prepare(`
      SELECT
        COALESCE(SUM(usd_allowance_remaining), 0) AS usd_expiring,
        COALESCE(SUM(points_remaining), 0) AS points_expiring
      FROM nexus_point_credits
      WHERE user_id = ?
        AND status = 'active'
        AND expires_at > ?
        AND expires_at <= ?
        AND usd_allowance_remaining > 0
    `).get(userId, nowIso, soonIso) as { usd_expiring: number; points_expiring: number };
    return {
      pointsBalance: roundPoints(row.points_balance ?? usdToPoints(row.usd_balance ?? 0)),
      usdBalance: roundUsd(row.usd_balance ?? 0),
      nextCreditExpiryAt: row.next_expiry === NEXUS_POINTS_NONEXPIRING_AT ? null : row.next_expiry ?? null,
      pointsExpiringSoon: roundPoints(expiring.points_expiring ?? usdToPoints(expiring.usd_expiring ?? 0)),
      usdExpiringSoon: roundUsd(expiring.usd_expiring ?? 0),
    };
  } catch {
    return emptyBalance();
  }
}

export function debitNexusPoints(
  userId: number,
  usdCost: number,
  metadata: { apiUsageId?: number | null; category?: string | null; description?: string | null } = {},
): { usdDebited: number; pointsDebited: number } {
  if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(usdCost) || usdCost <= 0) {
    return { usdDebited: 0, pointsDebited: 0 };
  }
  const db = getDb();
  const tx = db.transaction(() => debitNexusPointsCore(db, userId, usdCost, metadata));
  return tx();
}

export function transferNexusPointsCredits(input: {
  fromUserId: number;
  toUserId: number;
  auditReason: string;
  actorId: number;
}): { creditsTransferred: number; debitsTransferred: number } {
  const fromUserId = Number(input.fromUserId);
  const toUserId = Number(input.toUserId);
  const actorId = Number(input.actorId);
  const auditReason = String(input.auditReason || '').trim();
  if (!Number.isFinite(fromUserId) || fromUserId <= 0) throw new Error('fromUserId must be a positive user id');
  if (!Number.isFinite(toUserId) || toUserId <= 0) throw new Error('toUserId must be a positive user id');
  if (!Number.isFinite(actorId) || actorId <= 0) throw new Error('actorId must be a positive user id');
  if (fromUserId === toUserId) throw new Error('fromUserId and toUserId must differ');
  if (!auditReason) throw new Error('auditReason is required');

  const db = getDb();
  const tx = db.transaction(() => {
    const creditsTransferred = db.prepare(`
      UPDATE nexus_point_credits
      SET user_id = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(toUserId, fromUserId).changes;
    const debitsTransferred = db.prepare(`
      UPDATE nexus_point_debits
      SET user_id = ?
      WHERE user_id = ?
    `).run(toUserId, fromUserId).changes;

    if (creditsTransferred > 0 || debitsTransferred > 0) {
      logAudit({
        userId: toUserId,
        tenantId: toUserId,
        actorId,
        action: 'nexus_points.transfer',
        resource: 'nexus_points',
        details: {
          fromUserId,
          toUserId,
          auditReason,
          creditsTransferred,
          debitsTransferred,
        },
      });
    }

    return { creditsTransferred, debitsTransferred };
  });
  return tx();
}

function debitNexusPointsCore(
  db: ReturnType<typeof getDb>,
  userId: number,
  usdCost: number,
  metadata: { apiUsageId?: number | null; category?: string | null; description?: string | null },
): { usdDebited: number; pointsDebited: number } {
  expireOldNexusPointCredits(userId);
  if (metadata.apiUsageId != null) {
    const existing = db.prepare(`
      SELECT id FROM nexus_point_debits
      WHERE api_usage_id = ?
      LIMIT 1
    `).get(metadata.apiUsageId) as { id: number } | undefined;
    if (existing) return { usdDebited: 0, pointsDebited: 0 };
  }
  let remaining = roundUsd(usdCost);
  let usdDebited = 0;
  let pointsDebited = 0;
  const allocations: Array<{ creditId: number; usd: number; points: number }> = [];
  const credits = db.prepare(`
    SELECT id, usd_allowance_remaining, points_remaining
    FROM nexus_point_credits
    WHERE user_id = ?
      AND status = 'active'
      AND expires_at > ?
      AND usd_allowance_remaining > 0
    ORDER BY expires_at ASC, id ASC
  `).all(userId, new Date().toISOString()) as Array<{ id: number; usd_allowance_remaining: number; points_remaining: number }>;

  for (const credit of credits) {
    if (remaining <= 0) break;
    const usdFromCredit = Math.min(remaining, Number(credit.usd_allowance_remaining || 0));
    if (usdFromCredit <= 0) continue;
    const pointsFromCredit = Math.min(Number(credit.points_remaining || 0), usdToPoints(usdFromCredit));
    db.prepare(`
      UPDATE nexus_point_credits
      SET usd_allowance_remaining = MAX(usd_allowance_remaining - ?, 0),
          points_remaining = MAX(points_remaining - ?, 0),
          status = CASE
            WHEN usd_allowance_remaining - ? <= 0.0000001 THEN 'exhausted'
            ELSE status
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(usdFromCredit, pointsFromCredit, usdFromCredit, credit.id);
    allocations.push({ creditId: credit.id, usd: usdFromCredit, points: pointsFromCredit });
    remaining = roundUsd(remaining - usdFromCredit);
    usdDebited = roundUsd(usdDebited + usdFromCredit);
    pointsDebited = roundPoints(pointsDebited + pointsFromCredit);
  }

  if (allocations.length > 0) {
    if (metadata.apiUsageId != null) {
      db.prepare(`
        INSERT INTO nexus_point_debits (
          credit_id, user_id, points_debited, usd_cost_debited,
          api_usage_id, category, metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(api_usage_id) DO NOTHING
      `).run(
        allocations[0].creditId,
        userId,
        pointsDebited,
        usdDebited,
        metadata.apiUsageId,
        metadata.category ?? null,
        JSON.stringify({
          description: metadata.description ?? null,
          allocations,
        }),
      );
    } else {
      for (const allocation of allocations) {
        db.prepare(`
          INSERT INTO nexus_point_debits (
            credit_id, user_id, points_debited, usd_cost_debited,
            api_usage_id, category, metadata_json
          )
          VALUES (?, ?, ?, ?, NULL, ?, ?)
        `).run(
          allocation.creditId,
          userId,
          allocation.points,
          allocation.usd,
          metadata.category ?? null,
          JSON.stringify({ description: metadata.description ?? null }),
        );
      }
    }
  }

  return { usdDebited, pointsDebited };
}

export async function settleNexusPointOverageForUser(userId: number, apiUsageId: number | null | undefined): Promise<void> {
  if (!Number.isFinite(userId) || userId <= 0) return;
  if (!Number.isFinite(apiUsageId) || Number(apiUsageId) <= 0) return;
  try {
    const db = getDb();
    const tx = db.transaction(() => {
      const usageRow = db.prepare(`
        SELECT *
        FROM api_usage
        WHERE id = ? AND user_id = ?
        LIMIT 1
      `).get(apiUsageId, userId) as { id: number; user_id: number; ts: string; category: string; request_source?: string } | undefined;
      if (!usageRow) return;
      if ((usageRow.request_source ?? 'interactive') !== 'interactive') return;

      const entitlement = getEffectiveEntitlement(userId);
      if (!entitlement.aiAccessAllowed || !entitlement.nexusPointsAllowed) return;
      if (!entitlement.billingPeriodStart || !entitlement.billingPeriodEnd) return;
      const override = getActiveUserAiBudgetOverride(userId, new Date(usageRow.ts));
      const dailyCapUsd = override?.dailyCostUsd ?? entitlement.dailyCostCapUsd;
      const monthlyCapUsd = override?.monthlyCostUsd ?? entitlement.monthlyCostCapUsd;
      const spent = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN date(ts) = date(?) THEN cost_usd ELSE 0 END), 0) AS daily_spent,
          COALESCE(SUM(CASE WHEN ts >= datetime(?) AND ts < datetime(?) THEN cost_usd ELSE 0 END), 0) AS monthly_spent
        FROM api_usage
        WHERE user_id = ?
          AND COALESCE(request_source, 'interactive') <> 'system'
      `).get(
        usageRow.ts,
        entitlement.billingPeriodStart,
        entitlement.billingPeriodEnd,
        userId,
      ) as { daily_spent: number; monthly_spent: number };
      const debited = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN date(COALESCE(u.ts, d.created_at)) = date(?) THEN d.usd_cost_debited ELSE 0 END), 0) AS daily_debited,
          COALESCE(SUM(CASE WHEN COALESCE(u.ts, d.created_at) >= datetime(?) AND COALESCE(u.ts, d.created_at) < datetime(?) THEN d.usd_cost_debited ELSE 0 END), 0) AS monthly_debited
        FROM nexus_point_debits d
        LEFT JOIN api_usage u ON u.id = d.api_usage_id
        WHERE d.user_id = ?
      `).get(
        usageRow.ts,
        entitlement.billingPeriodStart,
        entitlement.billingPeriodEnd,
        userId,
      ) as { daily_debited: number; monthly_debited: number };
      const unsettledOverage = roundUsd(Math.max(
        (spent.daily_spent || 0) - dailyCapUsd - (debited.daily_debited || 0),
        (spent.monthly_spent || 0) - monthlyCapUsd - (debited.monthly_debited || 0),
        0,
      ));
      if (unsettledOverage <= 0) return;
      debitNexusPointsCore(db, userId, unsettledOverage, {
        apiUsageId: Number(apiUsageId),
        category: 'interactive_ai_overage',
        description: `Interactive AI spend above included ${entitlement.plan} budget for ${usageRow.category || 'api_usage'}`,
      });
    });
    tx();
  } catch (err) {
    logger.warn({ err, userId, apiUsageId }, 'Nexus Points overage settlement failed');
  }
}

export function expireOldNexusPointCredits(userId?: number, now = new Date()): void {
  try {
    const db = getDb();
    const nowIso = now.toISOString();
    if (userId && userId > 0) {
      db.prepare(`
        UPDATE nexus_point_credits
        SET status = 'expired', updated_at = datetime('now')
        WHERE user_id = ? AND status = 'active' AND expires_at <= ?
      `).run(userId, nowIso);
      return;
    }
    db.prepare(`
      UPDATE nexus_point_credits
      SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'active' AND expires_at <= ?
    `).run(nowIso);
  } catch {
    // Missing table in older local DBs should not break quota reads.
  }
}

function emptyBalance(): NexusPointBalance {
  return {
    pointsBalance: 0,
    usdBalance: 0,
    nextCreditExpiryAt: null,
    pointsExpiringSoon: 0,
    usdExpiringSoon: 0,
  };
}

export function usdToPoints(usd: number): number {
  return usd / NEXUS_POINT_USD_ALLOWANCE;
}

function roundUsd(value: number): number {
  return Number((Math.max(0, value) + 1e-12).toFixed(8));
}

function roundPoints(value: number): number {
  return Number((Math.max(0, value) + 1e-12).toFixed(5));
}

function stringifyCreditMetadata(
  metadata: Record<string, unknown> | null | undefined,
  provider?: string,
  providerTransactionId?: string,
): string {
  if (!metadata || typeof metadata !== 'object') return '{}';
  try {
    return JSON.stringify(metadata);
  } catch (err) {
    logger.warn({ err, provider, providerTransactionId }, 'Nexus Points credit metadata failed to serialize');
    return JSON.stringify({ serializationError: true });
  }
}

function parseCreditMetadata(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return { parseError: true };
  }
}

export interface NexusPointsCutoverResult {
  unexpiredMigrated: number;
  appleRestored: number;
}

/**
 * One-time, idempotent Addendum B cutover (NH-0029), run at activation:
 *
 * - every active, unexpired purchased lot becomes nonexpiring;
 * - identifiable unspent EXPIRED Apple purchase lots are restored to active
 *   and nonexpiring (plan §3) — refunded and revoked lots are never touched,
 *   and expired Stripe lots are deliberately not restored.
 *
 * Historical receipts, consumption, and audit rows are untouched; only the
 * expiry (and the restored Apple lots' status) changes. Safe to re-run: a
 * second invocation matches nothing.
 *
 * Defense in depth: the internal route gates on the cutover flag, and this
 * function refuses independently so no other caller can strip expiries while
 * the legacy points economy is still live.
 */
export function runNexusPointsCutover(now: Date = new Date()): NexusPointsCutoverResult {
  if (!isNexusPointsCutoverActive()) {
    throw new Error('NEXUS_POINTS_CUTOVER_INACTIVE: enable HYBRID_CREDITS_POINTS_CUTOVER before running the cutover');
  }
  const db = getDb();
  const nowIso = now.toISOString();
  const result = db.transaction((): NexusPointsCutoverResult => {
    const unexpired = db.prepare(`
      UPDATE nexus_point_credits
      SET expires_at = ?, updated_at = ?
      WHERE source = 'purchase'
        AND status = 'active'
        AND expires_at > ?
        AND expires_at != ?
    `).run(NEXUS_POINTS_NONEXPIRING_AT, nowIso, nowIso, NEXUS_POINTS_NONEXPIRING_AT).changes;
    const restored = db.prepare(`
      UPDATE nexus_point_credits
      SET expires_at = ?, status = 'active', updated_at = ?
      WHERE source = 'purchase'
        AND provider = 'apple'
        AND status IN ('active', 'expired')
        AND points_remaining > 0
        AND expires_at <= ?
    `).run(NEXUS_POINTS_NONEXPIRING_AT, nowIso, nowIso).changes;
    return { unexpiredMigrated: unexpired, appleRestored: restored };
  }).immediate();
  if (result.unexpiredMigrated > 0 || result.appleRestored > 0) {
    logAudit({
      userId: 0,
      tenantId: 0,
      actorId: 0,
      action: 'nexus_points.cutover',
      resource: 'nexus_points',
      details: {
        unexpiredMigrated: result.unexpiredMigrated,
        appleRestored: result.appleRestored,
      },
    });
  }
  return result;
}

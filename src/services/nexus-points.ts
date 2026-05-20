// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';
import { getEffectiveDailyCostLimitUsd, resolveBillingPlanForUser } from './plan-quotas';
import { getActiveUserAiBudgetOverride } from './ai-budget-overrides';

export const NEXUS_POINT_USD_ALLOWANCE = 0.001;
export const NEXUS_POINT_EXPIRY_DAYS = 30;

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
  const expiresAt = new Date(purchasedAt.getTime() + NEXUS_POINT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  const metadataJson = stringifyCreditMetadata(input.metadata);
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
    SELECT id, status
    FROM nexus_point_credits
    WHERE provider = ? AND provider_transaction_id = ?
    LIMIT 1
  `).get(provider, providerTransactionId) as { id: number; status: string } | undefined;
  if (!row) return { revoked: false, creditId: null, previousStatus: null };

  db.prepare(`
    UPDATE nexus_point_credits
    SET status = ?,
        points_remaining = 0,
        usd_allowance_remaining = 0,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(input.status, row.id);

  return { revoked: true, creditId: row.id, previousStatus: row.status };
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
      nextCreditExpiryAt: row.next_expiry ?? null,
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
        SELECT id, user_id, ts, category
        FROM api_usage
        WHERE id = ? AND user_id = ?
        LIMIT 1
      `).get(apiUsageId, userId) as { id: number; user_id: number; ts: string; category: string } | undefined;
      if (!usageRow) return;

      const plan = resolveBillingPlanForUser(userId);
      const capUsd = getActiveUserAiBudgetOverride(userId)?.dailyCostUsd ?? getEffectiveDailyCostLimitUsd(plan);
      const spent = db.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) AS spent
        FROM api_usage
        WHERE user_id = ? AND date(ts) = date(?)
      `).get(userId, usageRow.ts) as { spent: number };
      const debited = db.prepare(`
        SELECT COALESCE(SUM(d.usd_cost_debited), 0) AS debited
        FROM nexus_point_debits d
        LEFT JOIN api_usage u ON u.id = d.api_usage_id
        WHERE d.user_id = ?
          AND (
            (d.api_usage_id IS NOT NULL AND date(u.ts) = date(?))
            OR (d.api_usage_id IS NULL AND date(d.created_at) = date(?))
          )
      `).get(userId, usageRow.ts, usageRow.ts) as { debited: number };
      const unsettledOverage = roundUsd((spent.spent || 0) - capUsd - (debited.debited || 0));
      if (unsettledOverage <= 0) return;
      debitNexusPointsCore(db, userId, unsettledOverage, {
        apiUsageId: Number(apiUsageId),
        category: 'daily_ai_overage',
        description: `AI spend above included ${plan} daily budget for ${usageRow.category || 'api_usage'}`,
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

function stringifyCreditMetadata(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || typeof metadata !== 'object') return '{}';
  try {
    return JSON.stringify(metadata);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

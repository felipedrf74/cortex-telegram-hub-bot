// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * DB-backed operator control for the four hybrid kill switches (NH-0040).
 *
 * Layering contract:
 * - Env activation flags (`*_ENABLED`) remain the only way to turn a surface
 *   ON. This module can only turn surfaces OFF.
 * - Env kill switches (`*_KILL_SWITCH`) keep working unchanged; a surface is
 *   killed when EITHER the env switch or the DB row says so.
 * - Every DB flip writes an append-only event row and an audit_trail entry
 *   with operator attribution, which env flips cannot provide.
 * - Reads fail open (env-only behavior) if the control table is unreadable:
 *   a DB hiccup must not disable commerce that the environment allows, and
 *   the env kill switch remains available as the emergency stop.
 */

import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { logAudit } from './audit-trail';

export type HybridKillSwitchKey =
  | 'hybrid_credits'
  | 'apple_pack_fulfillment'
  | 'stripe_pack_fulfillment'
  | 'cloud_reasoning_fallback';

export const HYBRID_KILL_SWITCH_KEYS: readonly HybridKillSwitchKey[] = Object.freeze([
  'hybrid_credits',
  'apple_pack_fulfillment',
  'stripe_pack_fulfillment',
  'cloud_reasoning_fallback',
]);

export interface HybridKillSwitchState {
  controlKey: HybridKillSwitchKey;
  engaged: boolean;
  reason: string;
  actorUserId: number | null;
  updatedAt: string;
}

interface ControlRow {
  control_key: HybridKillSwitchKey;
  engaged: number;
  reason: string;
  actor_user_id: number | null;
  updated_at: string;
}

// Admission paths consult switches on every operation; a short TTL keeps the
// read off the hot path while an operator flip still lands within seconds.
const CACHE_TTL_MS = 5_000;
let cache: { at: number; engaged: Set<HybridKillSwitchKey> } | null = null;

export function _resetHybridKillSwitchCacheForTests(): void {
  cache = null;
}

function readEngagedKeys(): Set<HybridKillSwitchKey> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.engaged;
  const engaged = new Set<HybridKillSwitchKey>();
  try {
    const rows = getDb()
      .prepare('SELECT control_key FROM hybrid_commerce_runtime_control WHERE engaged = 1')
      .all() as Array<{ control_key: HybridKillSwitchKey }>;
    for (const row of rows) engaged.add(row.control_key);
    cache = { at: now, engaged };
  } catch (err) {
    // Fail open to env-only behavior; never cache a failed read.
    logger.warn({ err }, 'hybrid-kill-switches: control read failed; env switches remain authoritative');
    return engaged;
  }
  return engaged;
}

export function isHybridKillSwitchEngaged(key: HybridKillSwitchKey): boolean {
  return readEngagedKeys().has(key);
}

/** Env activation AND (env + DB) kill switches, combined per surface. */
export function isApplePackFulfillmentActive(): boolean {
  return config.hybridCommerce.applePackFulfillmentEnabled
    && !isHybridKillSwitchEngaged('apple_pack_fulfillment');
}

export function isStripePackFulfillmentActive(): boolean {
  return config.hybridCommerce.stripePackFulfillmentEnabled
    && !isHybridKillSwitchEngaged('stripe_pack_fulfillment');
}

export function listHybridKillSwitches(): HybridKillSwitchState[] {
  const rows = getDb()
    .prepare('SELECT * FROM hybrid_commerce_runtime_control ORDER BY control_key')
    .all() as ControlRow[];
  return rows.map((row) => ({
    controlKey: row.control_key,
    engaged: row.engaged === 1,
    reason: row.reason,
    actorUserId: row.actor_user_id,
    updatedAt: row.updated_at,
  }));
}

export type SetHybridKillSwitchResult =
  | { kind: 'updated'; state: HybridKillSwitchState }
  | { kind: 'unchanged'; state: HybridKillSwitchState }
  | { kind: 'rejected'; reason: string };

export function setHybridKillSwitch(input: {
  controlKey: HybridKillSwitchKey;
  engaged: boolean;
  actorUserId: number;
  reason: string;
}): SetHybridKillSwitchResult {
  if (!HYBRID_KILL_SWITCH_KEYS.includes(input.controlKey)) {
    return { kind: 'rejected', reason: 'unknown control key' };
  }
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    return { kind: 'rejected', reason: 'an authenticated operator actor is required' };
  }
  const reason = input.reason.trim();
  if (!reason) {
    return { kind: 'rejected', reason: 'a non-empty reason is required' };
  }
  const db = getDb();
  const tx = db.transaction((): SetHybridKillSwitchResult => {
    const current = db
      .prepare('SELECT * FROM hybrid_commerce_runtime_control WHERE control_key = ?')
      .get(input.controlKey) as ControlRow | undefined;
    if (!current) return { kind: 'rejected', reason: 'control row missing; run migrations' };
    const nextEngaged = input.engaged ? 1 : 0;
    if (current.engaged === nextEngaged) {
      return {
        kind: 'unchanged',
        state: {
          controlKey: current.control_key,
          engaged: current.engaged === 1,
          reason: current.reason,
          actorUserId: current.actor_user_id,
          updatedAt: current.updated_at,
        },
      };
    }
    const updatedAt = new Date().toISOString();
    db.prepare(
      `UPDATE hybrid_commerce_runtime_control
       SET engaged = ?, reason = ?, actor_user_id = ?, updated_at = ?
       WHERE control_key = ?`,
    ).run(nextEngaged, reason, input.actorUserId, updatedAt, input.controlKey);
    db.prepare(
      `INSERT INTO hybrid_commerce_control_events (control_key, previous_engaged, engaged, actor_user_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.controlKey, current.engaged, nextEngaged, input.actorUserId, reason);
    return {
      kind: 'updated',
      state: {
        controlKey: input.controlKey,
        engaged: nextEngaged === 1,
        reason,
        actorUserId: input.actorUserId,
        updatedAt,
      },
    };
  });
  const result = tx.immediate();
  if (result.kind === 'updated') {
    cache = null;
    logAudit({
      userId: input.actorUserId,
      actorId: input.actorUserId,
      action: 'admin_mutation',
      resource: `hybrid_kill_switch:${input.controlKey}`,
      details: { engaged: input.engaged, reason },
    });
    logger.warn(
      { controlKey: input.controlKey, engaged: input.engaged, actorUserId: input.actorUserId },
      'hybrid-kill-switches: operator flip applied',
    );
  }
  return result;
}

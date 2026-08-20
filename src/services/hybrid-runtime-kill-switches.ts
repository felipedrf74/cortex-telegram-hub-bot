// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * DB-backed operator control for the six hybrid kill switches (plan §5:
 * NH-0040 shipped four; migration 293 added subscription_checkout and
 * storefront).
 *
 * Layering contract:
 * - Env activation flags (`*_ENABLED`) remain the only way to turn a surface
 *   ON. This module can only turn surfaces OFF.
 * - Env kill switches (`*_KILL_SWITCH`) keep working unchanged; a surface is
 *   killed when EITHER the env switch or the DB row says so.
 * - Every DB flip writes an append-only event row and an audit_trail entry
 *   with operator attribution, which env flips cannot provide.
 * - Reads fail open (env-only behavior) if the control table is unreadable.
 *   DECIDED POSTURE (QA4 P2-6): fail-open is deliberate — a DB hiccup must
 *   not disable commerce that the environment allows, and the env kill
 *   switch remains the fail-safe emergency stop that needs no DB. The cost
 *   (an engaged DB switch silently losing effect during a DB incident) is
 *   made loud instead of silent: every failed control read raises a critical
 *   operator alert so the operator knows to reach for the env switch.
 */

import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { logAudit } from './audit-trail';
import { recordOperatorAlert } from './operator-alerts';

export type HybridKillSwitchKey =
  | 'hybrid_credits'
  | 'apple_pack_fulfillment'
  | 'stripe_pack_fulfillment'
  | 'cloud_reasoning_fallback'
  | 'subscription_checkout'
  | 'storefront';

export const HYBRID_KILL_SWITCH_KEYS: readonly HybridKillSwitchKey[] = Object.freeze([
  'hybrid_credits',
  'apple_pack_fulfillment',
  'stripe_pack_fulfillment',
  'cloud_reasoning_fallback',
  'subscription_checkout',
  'storefront',
]);

/**
 * The plan's six switches live in two tables (migration 293). The original
 * four carry a CHECK constraint enumerating only themselves, and SQLite cannot
 * widen a CHECK without rebuilding the table — a CONTRACT migration that would
 * halt unattended CD. The two later switches therefore live in an additive
 * table, and every read below unions the pair. This is a storage detail: to
 * callers there is one flat set of six keys.
 */
const EXT_CONTROL_KEYS: readonly HybridKillSwitchKey[] = Object.freeze([
  'subscription_checkout',
  'storefront',
]);

const CONTROL_TABLES: readonly string[] = Object.freeze([
  'hybrid_commerce_runtime_control',
  'hybrid_commerce_runtime_control_ext',
]);

function controlTableFor(key: HybridKillSwitchKey): string {
  return EXT_CONTROL_KEYS.includes(key)
    ? 'hybrid_commerce_runtime_control_ext'
    : 'hybrid_commerce_runtime_control';
}

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

// Failed reads are never cached, so an unreadable control table would alert on
// every admission — an alert storm precisely during a database incident, when
// the alert store itself is degraded. One alert per window is enough to tell
// the operator to reach for the env switch.
const CONTROL_READ_ALERT_INTERVAL_MS = 60_000;
let lastControlReadAlertAt = 0;

export function _resetHybridKillSwitchCacheForTests(): void {
  cache = null;
  lastControlReadAlertAt = 0;
}

function readEngagedKeys(): Set<HybridKillSwitchKey> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.engaged;
  const engaged = new Set<HybridKillSwitchKey>();
  try {
    const db = getDb();
    for (const table of CONTROL_TABLES) {
      const rows = db
        .prepare(`SELECT control_key FROM ${table} WHERE engaged = 1`)
        .all() as Array<{ control_key: HybridKillSwitchKey }>;
      for (const row of rows) engaged.add(row.control_key);
    }
    cache = { at: now, engaged };
  } catch (err) {
    // Fail open to env-only behavior; never cache a failed read. Escalate
    // loudly: an unreadable control table means an engaged DB kill switch is
    // NOT being enforced, and the operator must fall back to env switches.
    logger.error({ err }, 'hybrid-kill-switches: control read failed; env switches remain authoritative');
    const sinceLastAlert = now - lastControlReadAlertAt;
    if (lastControlReadAlertAt !== 0 && sinceLastAlert < CONTROL_READ_ALERT_INTERVAL_MS) {
      return engaged;
    }
    lastControlReadAlertAt = now;
    try {
      recordOperatorAlert({
        severity: 'critical',
        source: 'hybrid-kill-switches',
        dedupeKey: 'hybrid_kill_switch_control_read_failed',
        title: 'Hybrid kill-switch control table unreadable',
        detail: 'hybrid_commerce_runtime_control could not be read; DB kill switches are not enforceable until it recovers. Env kill switches remain the only effective stop.',
        suspectedArea: 'billing',
        userImpact: 'db_kill_switches_unenforceable',
      });
    } catch {
      // The alert store shares the database; during a full DB outage the
      // logger line above is the remaining signal.
    }
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

/**
 * Subscription checkout has no activation flag — subscriptions are the base
 * product, sellable whenever a price id is configured. These switches are
 * therefore pure stop controls: engaged means stop, disengaged means normal.
 */
export function isSubscriptionCheckoutActive(): boolean {
  return !isHybridKillSwitchEngaged('subscription_checkout')
    && !isHybridKillSwitchEngaged('storefront');
}

/** Master stop for every paid surface: catalog listing and all checkout. */
export function isStorefrontActive(): boolean {
  return !isHybridKillSwitchEngaged('storefront');
}

export function listHybridKillSwitches(): HybridKillSwitchState[] {
  const db = getDb();
  const rows = CONTROL_TABLES.flatMap((table) => (
    db.prepare(`SELECT * FROM ${table}`).all() as ControlRow[]
  )).sort((a, b) => a.control_key.localeCompare(b.control_key));
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
    const table = controlTableFor(input.controlKey);
    const current = db
      .prepare(`SELECT * FROM ${table} WHERE control_key = ?`)
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
      `UPDATE ${table}
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

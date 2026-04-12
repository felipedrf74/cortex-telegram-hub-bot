// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Founders Service — Permanent plan access by email.
 *
 * The "Founders" list is an admin-managed table of emails that get
 * automatic Pro or Max subscriptions with no expiry. When a user
 * registers (Google, Apple, email), the auth flow checks this list
 * and seeds a subscription with provider='founder'.
 *
 * Managed from the admin portal's Founders section.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export interface Founder {
  email: string;
  plan: 'pro' | 'max';
  note: string | null;
  createdAt: string;
}

/**
 * Check if an email is in the founders list.
 * Returns the plan ('pro' or 'max') or null if not a founder.
 */
export function getFounderPlan(email: string): 'pro' | 'max' | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT plan FROM founders WHERE email = ?'
  ).get(email.toLowerCase().trim()) as { plan: string } | undefined;
  return row ? (row.plan as 'pro' | 'max') : null;
}

/**
 * List all founders.
 */
export function listFounders(): Founder[] {
  const db = getDb();
  return db.prepare(
    'SELECT email, plan, note, created_at FROM founders ORDER BY created_at DESC'
  ).all() as any[];
}

/**
 * Add a founder email. If already exists, updates the plan.
 */
export function addFounder(email: string, plan: 'pro' | 'max', note?: string): void {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  db.prepare(`
    INSERT INTO founders (email, plan, note)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      plan = excluded.plan,
      note = COALESCE(excluded.note, founders.note)
  `).run(normalizedEmail, plan, note ?? null);

  // If this user already has an account, update their subscription
  syncFounderSubscription(normalizedEmail, plan);

  logger.info({ email: normalizedEmail, plan, note }, 'Founder added/updated');
}

/**
 * Remove a founder email. Does NOT revoke their subscription
 * (they keep whatever they had — removal just stops auto-granting
 * on future re-registrations).
 */
export function removeFounder(email: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM founders WHERE email = ?')
    .run(email.toLowerCase().trim());
  if (result.changes > 0) {
    logger.info({ email }, 'Founder removed');
  }
  return result.changes > 0;
}

/**
 * Sync a founder's subscription to their assigned plan.
 * Called when:
 *   1. A founder is added/updated in the portal
 *   2. A user registers and their email matches the founders list
 */
export function syncFounderSubscription(email: string, plan: 'pro' | 'max'): void {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  // Find the user by email
  const user = db.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).get(normalizedEmail) as { id: number } | undefined;

  if (!user) return; // No account yet — will sync on registration

  // Upsert subscription with provider='founder' and no expiry
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, period, status, provider, current_period_end)
    VALUES (?, ?, 'lifetime', 'active', 'founder', NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = 'lifetime',
      status = 'active',
      provider = 'founder',
      current_period_end = NULL,
      updated_at = datetime('now')
  `).run(user.id, plan);

  logger.info({ email: normalizedEmail, userId: user.id, plan }, 'Founder subscription synced');
}

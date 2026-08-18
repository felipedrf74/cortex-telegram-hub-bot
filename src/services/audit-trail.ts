// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Audit Trail — logs all data access, export, and delete operations for GDPR compliance.
 *
 * The audit_trail table is exempt from user deletion (Article 17(3)(e))
 * because it serves as proof that a deletion was requested and performed.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export type AuditAction =
  | 'create'
  | 'update'
  | 'export'
  | 'delete'
  | 'access'
  | 'mutation_scope'
  | 'encrypt'
  | 'decrypt'
  | 'privacy_consent'
  | 'billing.nexus_points.checkout_started'
  | 'nexus_points.transfer'
  | 'nexus_points.cutover'
  /**
   * Portal admin mutation — founder grant/revoke, user tier change,
   * skill override, plan-config edit. Added 2026-04-21 so Felipe (or
   * any future ops role) has a replayable log of every privileged
   * admin action that could change a user's entitlement.
   */
  | 'admin_mutation'
  /**
   * 2026-05-18 (skill-hardening QA P0-4): fiscal-record-impacting actions
   * wired into `src/api/routes/invoices.ts`. Portuguese tax retention
   * rules require an audit row for every fiscal mutation. These cover the
   * 5 invoice routes that previously had no `audit_trail` wiring.
   */
  | 'fiscal_profile_update'
  | 'fiscal_bundle_send'
  | 'invoice_vendor_create'
  | 'invoice_vendor_disable'
  | 'invoice_scan_on_demand'
  | 'invoice_scraper_mfa_reply';

export interface AuditEntry {
  userId: number;
  tenantId?: number;
  actorId: number;
  action: AuditAction;
  resource: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

export function logAudit(entry: AuditEntry): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_trail (tenant_id, user_id, actor_id, action, resource, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.tenantId ?? entry.userId,
      entry.userId,
      entry.actorId,
      entry.action,
      entry.resource,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.ipAddress ?? null,
    );
  } catch (err) {
    logger.warn({ err, entry }, 'Failed to log audit trail entry');
  }
}

export interface AuditRow {
  ts: string;
  action: string;
  resource: string;
  actorId: number;
  details: string | null;
}

export function getAuditTrail(userId: number, limit = 50): AuditRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT ts, action, resource, actor_id as actorId, details
    FROM audit_trail
    WHERE tenant_id = ? AND user_id = ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(userId, userId, limit) as AuditRow[];
}

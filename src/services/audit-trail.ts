// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Audit Trail — logs all data access, export, and delete operations for GDPR compliance.
 *
 * The audit_trail table is exempt from user deletion (Article 17(3)(e))
 * because it serves as proof that a deletion was requested and performed.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export type AuditAction = 'export' | 'delete' | 'access' | 'encrypt' | 'decrypt';

export interface AuditEntry {
  userId: number;
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
      INSERT INTO audit_trail (user_id, actor_id, action, resource, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
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
    WHERE user_id = ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(userId, limit) as AuditRow[];
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { countUserFinanceData } from '../services/user-data-export';
import { sendPortalInternalError } from './http';

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseAuditLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '50'), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 500);
}

function countUserRows(db: ReturnType<typeof getDb>, table: string, userId: number): number {
  try {
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE user_id = ?`).get(userId) as { c?: number } | undefined)?.c ?? 0;
  } catch {
    return 0;
  }
}

export function registerPortalAdminDataRoutes(app: Express): void {
  // GET /api/audit-trail — recent audit events (admin only)
  app.get('/api/audit-trail', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const userId = req.query.userId ? parsePositiveInteger(req.query.userId) : null;
      const limit = parseAuditLimit(req.query.limit);
      const db = getDb();

      const rows = userId
        ? db.prepare('SELECT * FROM audit_trail WHERE user_id = ? ORDER BY ts DESC LIMIT ?').all(userId, limit)
        : db.prepare('SELECT * FROM audit_trail ORDER BY ts DESC LIMIT ?').all(limit);

      res.json({ entries: rows });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // GET /api/users/:userId/data-summary — record counts per table (admin view)
  app.get('/api/users/:userId/data-summary', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const userId = parsePositiveInteger(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      const financeCounts = countUserFinanceData(userId);
      const db = getDb();

      res.json({
        conversations: countUserRows(db, 'conversations', userId),
        todos: countUserRows(db, 'todos', userId),
        reminders: countUserRows(db, 'reminders', userId),
        notes: countUserRows(db, 'notes', userId),
        sharedMemory: countUserRows(db, 'shared_memory', userId),
        savedIdeas: countUserRows(db, 'saved_ideas', userId),
        financeTransactions: financeCounts.transactions,
        financeTaxEvents: financeCounts.taxEvents,
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}

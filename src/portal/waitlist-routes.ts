// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Request, Response } from 'express';
import { countFounderSlots } from '../api/routes/waitlist';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { createInviteCode } from '../services/user-service';
import { logger } from '../utils/logger';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseListLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '200'), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.min(parsed, 1000);
}

function parseExpiresInDays(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 30;
}

export function registerPortalWaitlistRoutes(app: express.Express): void {
  // ADMIN endpoints for the landing page waitlist. The public endpoints
  // (POST /waitlist and GET /waitlist/stats) live at the root in
  // api/routes/waitlist.ts and bypass the portal token gate.
  app.get('/api/waitlist', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const intent = typeof req.query.intent === 'string' ? req.query.intent : null;
      const limit = parseListLimit(req.query.limit);

      const where: string[] = [];
      const args: unknown[] = [];
      if (status) { where.push('status = ?'); args.push(status); }
      if (intent) { where.push('intent = ?'); args.push(intent); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const rows = db.prepare(
        `SELECT id, email, intent, source, use_case, status, invite_code, founder_slot,
                utm_source, utm_medium, utm_campaign, created_at, approved_at, notes
         FROM waitlist ${whereSql} ORDER BY created_at DESC LIMIT ?`,
      ).all(...args, limit) as any[];

      const totals = db.prepare(
        `SELECT
           SUM(CASE WHEN intent = 'founder' THEN 1 ELSE 0 END) AS founder_total,
           SUM(CASE WHEN intent = 'general' THEN 1 ELSE 0 END) AS general_total,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_total,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_total,
           SUM(CASE WHEN status = 'invited' THEN 1 ELSE 0 END) AS invited_total,
           SUM(CASE WHEN status = 'signed_up' THEN 1 ELSE 0 END) AS signed_up_total
         FROM waitlist`,
      ).get() as any;

      res.json({
        ok: true,
        entries: rows,
        counters: {
          founder: countFounderSlots(),
          totals,
        },
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/waitlist failed');
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/waitlist/:id/approve', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const id = parsePositiveInteger(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, message: 'invalid waitlist id' });
        return;
      }

      const db = getDb();
      const row = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id) as any;
      if (!row) {
        res.status(404).json({ ok: false, error: 'Waitlist entry not found' });
        return;
      }
      if (row.status !== 'pending' && !req.body?.force) {
        res.status(400).json({
          ok: false,
          error: `Already ${row.status}. Pass {"force": true} to re-approve.`,
        });
        return;
      }

      const code = createInviteCode(0, 1, parseExpiresInDays(req.body?.expiresInDays));

      if (row.intent === 'founder') {
        try {
          db.prepare('UPDATE invite_codes SET skill_preset = ? WHERE code = ?')
            .run(JSON.stringify({ tier: 'founder', founderSlot: row.founder_slot }), code);
        } catch { /* skill_preset column may not exist yet */ }
      }

      db.prepare(
        `UPDATE waitlist SET
           status = 'approved',
           invite_code = ?,
           approved_at = datetime('now')
         WHERE id = ?`,
      ).run(code, id);

      logPortalAdminMutation(req, 0, 'waitlist.approve', {
        waitlistId: id,
        email: row.email,
        intent: row.intent,
        inviteCode: code,
      });
      res.json({ ok: true, code, email: row.email, intent: row.intent });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to approve waitlist entry', 'Portal: waitlist approve failed');
    }
  });

  app.post('/api/waitlist/:id/reject', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const id = parsePositiveInteger(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, message: 'invalid waitlist id' });
        return;
      }

      const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;
      const db = getDb();
      db.prepare(
        "UPDATE waitlist SET status = 'rejected', notes = COALESCE(?, notes) WHERE id = ?",
      ).run(notes, id);
      logPortalAdminMutation(req, 0, 'waitlist.reject', { waitlistId: id, notes });
      res.json({ ok: true });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to reject waitlist entry', 'Portal: waitlist reject failed');
    }
  });

  app.post('/api/waitlist/:id/invited', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const id = parsePositiveInteger(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, message: 'invalid waitlist id' });
        return;
      }

      const db = getDb();
      db.prepare("UPDATE waitlist SET status = 'invited' WHERE id = ?").run(id);
      logPortalAdminMutation(req, 0, 'waitlist.invited', { waitlistId: id });
      res.json({ ok: true });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to mark waitlist entry as invited', 'Portal: waitlist invited failed');
    }
  });
}

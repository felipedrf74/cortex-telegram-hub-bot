// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Portal Owner / Control Plane router (`/owner/*`).
 *
 * Part of the portal redesign (feature/nexus-hub-owner-workspace-separation,
 * 2026-04-22). See `docs/portal/nexus-hub-portal-owner-workspace-redesign.md`.
 *
 * ## Purpose
 *
 * Platform-owner (Felipe) and future platform-admin cross-tenant
 * operations: list tenants, inspect a tenant's members, see usage
 * rollups, view full audit trail, manage platform admins.
 *
 * ## Auth chain
 *
 *   1. The request is mounted AFTER the existing portal-token
 *      middleware in portal/server.ts, so the shared token check
 *      already happened.
 *   2. `resolvePlatformAdmin` then resolves an admin IDENTITY from
 *      the `X-Admin-User-Id` header (or `?_asAdmin=N` for debug).
 *      Without that identity, 401.
 *   3. Destructive endpoints additionally require
 *      `requirePlatformOwner` or `requirePlatformWrite`.
 *
 * ## MVP scope
 *
 * This router ships the minimum set of read + write endpoints
 * needed to demonstrate the separation:
 *   GET    /owner/tenants                — list all tenants (paginated)
 *   GET    /owner/tenants/:tenantId      — tenant detail + status + plan
 *   PATCH  /owner/tenants/:tenantId      — mutate status/plan (audited)
 *   GET    /owner/tenants/:tenantId/members  — who's in this tenant
 *   GET    /owner/usage                  — cross-tenant usage summary
 *   GET    /owner/platform-admins        — list platform admins
 *   POST   /owner/platform-admins        — grant (platform_owner only)
 *   DELETE /owner/platform-admins/:userId — revoke (platform_owner only)
 *
 * Future phases add: full audit trail, feature entitlements, tenant
 * lifecycle (suspend/archive), security events, SSO config.
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { logger } from '../utils/logger';
import {
  ownerRateLimitMiddleware,
  requireOwnerConsoleToken,
  resolvePlatformAdmin,
  requirePlatformOwner,
  requirePlatformWrite,
  type PlatformAdminRequest,
} from './platform-admin-guard';
import {
  listAllTenants,
  countAllTenants,
  getTenantById,
  listMembersOfTenant,
  listPlatformAdmins,
  type TenantStatus,
  type TenantPlan,
  type PlatformRole,
} from '../services/tenant-service';
import { getDb } from '../services/database';

// ── Response helpers (local — avoids coupling to /api/v1 response-helpers) ─

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({
    ok: true,
    data,
    timestamp: new Date().toISOString(),
  });
}

function err(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: Record<string, unknown> = {
    ok: false,
    error: { code, message },
    timestamp: new Date().toISOString(),
  };
  if (details !== undefined) {
    (body.error as Record<string, unknown>).details = details;
  }
  res.status(status).json(body);
}

// ── Audit trail helper ─────────────────────────────────────────────

function logAdminAudit(
  adminUserId: number,
  action: string,
  resource: string,
  details: Record<string, unknown>,
): void {
  try {
    const db = getDb();
    // The existing audit_trail schema is (user_id, actor_id, action, resource, details, ...).
    // For /owner/* admin actions, actor_id = the resolved platform admin (real identity!),
    // and user_id can be the target user / tenant id when the action targets one, or the
    // admin themselves when it's a cross-tenant op.
    db.prepare(
      `INSERT INTO audit_trail (user_id, actor_id, action, resource, details, ts)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      adminUserId,
      adminUserId,
      action,
      resource,
      JSON.stringify(details),
    );
  } catch (auditErr) {
    // Audit logging must never break a mutation. Just surface it.
    logger.warn({ err: auditErr, action, resource }, 'portal-owner-router: audit log write failed');
  }
}

// ── Router factory ─────────────────────────────────────────────────

export function createPortalOwnerRouter(): Router {
  const router = Router();

  // JSON parser scoped to this router so we can mount it even when
  // the outer app hasn't globally parsed JSON yet.
  router.use(express.json({ limit: '1mb' }));

  // Gate 0 (validation pass 2026-04-22): per-IP rate limit. Runs
  // FIRST so even valid-token traffic is rate-limited, preventing
  // a leaked token from being used to enumerate admin user ids.
  // 30 req/min/IP — generous for a human admin clicking around,
  // tight against scripted enumeration.
  router.use(ownerRateLimitMiddleware);

  // Gate 1 (defense in depth): owner-console token. Runs BEFORE the
  // identity resolver so the platform_admins DB read is gated on
  // token possession. Added 2026-04-22 to close open-risk #1 from
  // the Phase-1 final report.
  router.use(requireOwnerConsoleToken);

  // Gate 2: every route under /owner/* requires a resolved platform
  // admin identity (X-Admin-User-Id → platform_admins row).
  router.use(resolvePlatformAdmin);

  // ── GET /owner/tenants ─────────────────────────────────────────
  router.get('/tenants', (req: Request, res: Response) => {
    const rawLimit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const rawOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const allowedStatuses: TenantStatus[] = ['active', 'suspended', 'archived', 'trial'];
    const statusFilter =
      statusRaw && (allowedStatuses as readonly string[]).includes(statusRaw)
        ? (statusRaw as TenantStatus)
        : undefined;

    const tenants = listAllTenants({
      limit: Number.isFinite(rawLimit) ? rawLimit : 50,
      offset: Number.isFinite(rawOffset) ? rawOffset : 0,
      statusFilter,
    });
    const total = countAllTenants();
    ok(res, { tenants, pagination: { total, limit: tenants.length, offset: rawOffset || 0 } });
  });

  // ── GET /owner/tenants/:tenantId ───────────────────────────────
  router.get('/tenants/:tenantId', (req: Request, res: Response) => {
    const tenantId = Number.parseInt(String(req.params.tenantId), 10);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'tenantId must be a positive integer');
    }
    const tenant = getTenantById(tenantId);
    if (!tenant) {
      return err(res, 404, 'TENANT_NOT_FOUND', 'No tenant with that id', { tenantId });
    }
    const members = listMembersOfTenant(tenantId);
    ok(res, { tenant, memberCount: members.length, members });
  });

  // ── PATCH /owner/tenants/:tenantId ─────────────────────────────
  // Mutation: platform_admin or above, not platform_readonly.
  router.patch('/tenants/:tenantId', requirePlatformWrite, (req: Request, res: Response) => {
    const tenantId = Number.parseInt(String(req.params.tenantId), 10);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'tenantId must be a positive integer');
    }
    const existing = getTenantById(tenantId);
    if (!existing) {
      return err(res, 404, 'TENANT_NOT_FOUND', 'No tenant with that id', { tenantId });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowedStatuses: TenantStatus[] = ['active', 'suspended', 'archived', 'trial'];
    const allowedPlans: TenantPlan[] = ['free', 'pro', 'max', 'owner', 'beta'];

    const nextStatus: TenantStatus | undefined =
      typeof body.status === 'string' && (allowedStatuses as readonly string[]).includes(body.status)
        ? (body.status as TenantStatus)
        : undefined;
    const nextPlan: TenantPlan | undefined =
      typeof body.plan === 'string' && (allowedPlans as readonly string[]).includes(body.plan)
        ? (body.plan as TenantPlan)
        : undefined;
    const nextDisplayName: string | undefined =
      typeof body.displayName === 'string' && body.displayName.trim().length > 0
        ? body.displayName.trim().slice(0, 128)
        : undefined;

    if (!nextStatus && !nextPlan && !nextDisplayName) {
      return err(
        res,
        400,
        'BAD_REQUEST',
        'At least one of status, plan, displayName must be provided.',
      );
    }

    try {
      const db = getDb();
      const sets: string[] = [];
      const values: unknown[] = [];
      if (nextStatus) { sets.push('status = ?'); values.push(nextStatus); }
      if (nextPlan) { sets.push('plan = ?'); values.push(nextPlan); }
      if (nextDisplayName) { sets.push('display_name = ?'); values.push(nextDisplayName); }
      values.push(tenantId);
      db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    } catch (dbErr) {
      logger.error({ err: dbErr, tenantId }, 'portal-owner-router: tenant update failed');
      return err(res, 500, 'INTERNAL', 'Failed to update tenant');
    }

    const admin = (req as PlatformAdminRequest).platformAdmin;
    logAdminAudit(admin.userId, 'tenant.update', `tenant.${tenantId}`, {
      tenantId,
      changes: {
        status: nextStatus,
        plan: nextPlan,
        displayName: nextDisplayName,
      },
      before: { status: existing.status, plan: existing.plan, displayName: existing.displayName },
    });

    const updated = getTenantById(tenantId);
    ok(res, { tenant: updated });
  });

  // ── GET /owner/tenants/:tenantId/members ───────────────────────
  router.get('/tenants/:tenantId/members', (req: Request, res: Response) => {
    const tenantId = Number.parseInt(String(req.params.tenantId), 10);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'tenantId must be a positive integer');
    }
    const tenant = getTenantById(tenantId);
    if (!tenant) {
      return err(res, 404, 'TENANT_NOT_FOUND', 'No tenant with that id', { tenantId });
    }
    ok(res, { tenantId, members: listMembersOfTenant(tenantId) });
  });

  // ── GET /owner/tenants/:tenantId/audit (OI-ADM-301, 2026-04-22) ──
  //
  // Tenant-scoped audit feed. Used by the Admin Console's tenant
  // detail drawer → Audit tab. Returns audit_trail rows whose
  // `resource` column matches the tenant resource convention
  // established by the hardening pass
  //   (writeWorkspaceAudit sets resource = `tenant.<id>` or
  //    `tenant.<id>.member.<x>` / `tenant.<id>.invite.<x>`).
  //
  // Query strategy: WHERE resource = 'tenant.<id>' OR resource LIKE
  // 'tenant.<id>.%'. The dot-prefix match avoids tenant.<id> matching
  // tenant.<id>XXX — e.g. tenant=4 must NOT match tenant.42.*.
  router.get('/tenants/:tenantId/audit', (req: Request, res: Response) => {
    const tenantId = Number.parseInt(String(req.params.tenantId), 10);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'tenantId must be a positive integer');
    }
    const tenant = getTenantById(tenantId);
    if (!tenant) {
      return err(res, 404, 'TENANT_NOT_FOUND', 'No tenant with that id', { tenantId });
    }
    const rawLimit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);
    const rawOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

    try {
      const db = getDb();
      const exact = `tenant.${tenantId}`;
      const prefix = `tenant.${tenantId}.%`;
      const rows = db
        .prepare(
          `SELECT id, ts, user_id, actor_id, action, resource, details
           FROM audit_trail
           WHERE resource = ? OR resource LIKE ?
           ORDER BY id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(exact, prefix, limit, offset) as Array<{
          id: number; ts: string; user_id: number; actor_id: number;
          action: string; resource: string; details: string | null;
        }>;
      const countRow = db
        .prepare(
          `SELECT COUNT(*) AS c FROM audit_trail WHERE resource = ? OR resource LIKE ?`,
        )
        .get(exact, prefix) as { c: number } | undefined;
      const total = countRow?.c ?? 0;
      ok(res, {
        tenantId,
        events: rows.map((r) => ({
          id: r.id,
          ts: r.ts,
          userId: r.user_id,
          actorId: r.actor_id,
          action: r.action,
          resource: r.resource,
          // Leave details as a raw string; UI parses on demand. This
          // keeps the payload small when the drawer is closed.
          details: r.details,
        })),
        pagination: { total, limit, offset },
      });
    } catch (dbErr) {
      logger.error({ err: dbErr, tenantId }, 'portal-owner-router: /tenants/:id/audit failed');
      err(res, 500, 'INTERNAL', 'Failed to load tenant audit');
    }
  });

  // ── GET /owner/audit (OI-ADM-303, 2026-04-22) ────────────────────
  //
  // Filtered platform-wide audit viewer. Feeds the Admin Console's
  // Security → Audit page. Query parameters (all optional):
  //
  //   actor    — actor_id (integer) — exact match
  //   action   — action (string) — exact match, OR
  //              action (string ending in '*') — prefix match
  //              e.g. ?action=tenant.* matches tenant.member.remove etc.
  //   from     — ISO-ish timestamp; events with ts >= from
  //   to       — ISO-ish timestamp; events with ts <= to
  //   q        — free-text LIKE on resource (contains match)
  //   limit    — 1..500, default 100
  //   offset   — pagination
  //
  // Response carries `{ events, pagination: { total, limit, offset } }`.
  router.get('/audit', (req: Request, res: Response) => {
    const where: string[] = [];
    const params: unknown[] = [];

    const actorRaw = String(req.query.actor ?? '').trim();
    if (actorRaw) {
      const actor = Number.parseInt(actorRaw, 10);
      if (!Number.isFinite(actor) || actor < 0) {
        return err(res, 400, 'BAD_REQUEST', 'actor must be a non-negative integer');
      }
      where.push('actor_id = ?'); params.push(actor);
    }

    const actionRaw = String(req.query.action ?? '').trim();
    if (actionRaw) {
      if (actionRaw.length > 128) {
        return err(res, 400, 'BAD_REQUEST', 'action too long');
      }
      if (actionRaw.endsWith('*')) {
        // Prefix match. Escape `%` and `_` in the remainder so a
        // user-supplied `action=tenant_%` can't inject wildcards.
        const prefix = actionRaw.slice(0, -1).replace(/[%_]/g, (c) => '\\' + c);
        where.push("action LIKE ? ESCAPE '\\'"); params.push(prefix + '%');
      } else {
        where.push('action = ?'); params.push(actionRaw);
      }
    }

    const from = String(req.query.from ?? '').trim();
    if (from) { where.push('ts >= ?'); params.push(from); }
    const to = String(req.query.to ?? '').trim();
    if (to) { where.push('ts <= ?'); params.push(to); }

    const q = String(req.query.q ?? '').trim();
    if (q) {
      if (q.length > 128) {
        return err(res, 400, 'BAD_REQUEST', 'q too long');
      }
      const esc = q.replace(/[%_]/g, (c) => '\\' + c);
      where.push("resource LIKE ? ESCAPE '\\'"); params.push('%' + esc + '%');
    }

    const rawLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500);
    const rawOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    try {
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT id, ts, user_id, actor_id, action, resource, details
           FROM audit_trail
           ${whereSql}
           ORDER BY id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as Array<{
          id: number; ts: string; user_id: number; actor_id: number;
          action: string; resource: string; details: string | null;
        }>;
      const countRow = db
        .prepare(`SELECT COUNT(*) AS c FROM audit_trail ${whereSql}`)
        .get(...params) as { c: number } | undefined;
      const total = countRow?.c ?? 0;
      ok(res, {
        events: rows.map((r) => ({
          id: r.id,
          ts: r.ts,
          userId: r.user_id,
          actorId: r.actor_id,
          action: r.action,
          resource: r.resource,
          details: r.details,
        })),
        pagination: { total, limit, offset },
        appliedFilters: {
          actor: actorRaw || null,
          action: actionRaw || null,
          from: from || null,
          to: to || null,
          q: q || null,
        },
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, 'portal-owner-router: /audit failed');
      err(res, 500, 'INTERNAL', 'Failed to load audit');
    }
  });

  // ── GET /owner/usage ───────────────────────────────────────────
  // Cross-tenant cost + token rollup. Reads from api_usage, which
  // keys by user_id. Since our solo-tenant convention is tenant.id
  // == users.id, the rollup-by-user IS the rollup-by-tenant for all
  // existing tenants. When multi-member tenants arrive, this query
  // needs to JOIN through tenant_members — Phase 2.
  router.get('/usage', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const todayRows = db
        .prepare(
          `SELECT user_id, COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as calls
           FROM api_usage
           WHERE ts >= date('now')
           GROUP BY user_id
           ORDER BY cost DESC
           LIMIT 50`,
        )
        .all() as Array<{ user_id: number; cost: number; calls: number }>;

      const totalRow = db
        .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_usage WHERE ts >= date('now')")
        .get() as { total: number } | undefined;

      ok(res, {
        today: {
          totalUsd: totalRow?.total ?? 0,
          byTenant: todayRows.map((row) => ({
            tenantId: row.user_id,
            costUsd: row.cost,
            calls: row.calls,
          })),
        },
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, 'portal-owner-router: /usage failed');
      err(res, 500, 'INTERNAL', 'Failed to compute usage');
    }
  });

  // ── GET /owner/platform-admins ─────────────────────────────────
  router.get('/platform-admins', (_req: Request, res: Response) => {
    ok(res, { admins: listPlatformAdmins() });
  });

  // ── POST /owner/platform-admins ────────────────────────────────
  // Grant a platform role to a user. Only the platform_owner can do
  // this — not platform_admin (privilege-escalation boundary).
  router.post('/platform-admins', requirePlatformOwner, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = Number.parseInt(String(body.userId ?? ''), 10);
    const roleRaw = typeof body.role === 'string' ? body.role : 'platform_admin';
    const allowedRoles: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_readonly'];
    if (!Number.isFinite(userId) || userId <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'userId must be a positive integer');
    }
    if (!(allowedRoles as readonly string[]).includes(roleRaw)) {
      return err(res, 400, 'BAD_REQUEST', 'role must be one of platform_owner|platform_admin|platform_readonly');
    }
    const role = roleRaw as PlatformRole;

    try {
      const db = getDb();
      // Validation fix (Phase 2E, 2026-04-22): reject the grant if
      // the target user is not in `active` status. Prior code only
      // checked row existence, which meant a suspended/banned user
      // could be granted platform_admin — and if they were later
      // reactivated, they'd have admin without a re-review step.
      // Also guards against granting to a deleted user during the
      // window between user_service.setUserStatus('deleted') and
      // the eventual hard DELETE.
      const userRow = db
        .prepare('SELECT id, status FROM users WHERE id = ?')
        .get(userId) as { id: number; status: string | null } | undefined;
      if (!userRow) {
        return err(res, 404, 'USER_NOT_FOUND', 'No user with that id', { userId });
      }
      if (userRow.status && userRow.status !== 'active') {
        return err(
          res,
          400,
          'USER_NOT_ACTIVE',
          `Cannot grant platform role to a user whose status is "${userRow.status}". Reactivate the user first.`,
          { userId, status: userRow.status },
        );
      }
      db.prepare(
        `INSERT INTO platform_admins (user_id, role, granted_at, granted_by)
         VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, granted_at = excluded.granted_at, granted_by = excluded.granted_by`,
      ).run(userId, role, (req as PlatformAdminRequest).platformAdmin.userId);
    } catch (dbErr) {
      logger.error({ err: dbErr, userId }, 'portal-owner-router: platform-admin grant failed');
      return err(res, 500, 'INTERNAL', 'Failed to grant platform role');
    }

    const admin = (req as PlatformAdminRequest).platformAdmin;
    logAdminAudit(admin.userId, 'platform_admin.grant', `user.${userId}`, { userId, role });
    ok(res, { userId, role }, 201);
  });

  // ── DELETE /owner/platform-admins/:userId ──────────────────────
  router.delete(
    '/platform-admins/:userId',
    requirePlatformOwner,
    (req: Request, res: Response) => {
      const userId = Number.parseInt(String(req.params.userId), 10);
      if (!Number.isFinite(userId) || userId <= 0) {
        return err(res, 400, 'BAD_REQUEST', 'userId must be a positive integer');
      }
      const admin = (req as PlatformAdminRequest).platformAdmin;
      if (userId === admin.userId) {
        return err(
          res,
          400,
          'BAD_REQUEST',
          'Cannot revoke your own platform role via this endpoint. Use a different admin session or transfer first.',
        );
      }
      try {
        const db = getDb();
        const result = db.prepare('DELETE FROM platform_admins WHERE user_id = ?').run(userId);
        if (result.changes === 0) {
          return err(res, 404, 'NOT_A_PLATFORM_ADMIN', 'That user was not a platform admin', { userId });
        }
      } catch (dbErr) {
        logger.error({ err: dbErr, userId }, 'portal-owner-router: platform-admin revoke failed');
        return err(res, 500, 'INTERNAL', 'Failed to revoke platform role');
      }
      logAdminAudit(admin.userId, 'platform_admin.revoke', `user.${userId}`, { userId });
      ok(res, { userId, revoked: true });
    },
  );

  // ── GET /owner/console/overview ─────────────────────────────────
  //
  // Aggregated Admin Console overview payload. Added 2026-04-22 for
  // the admin/user-console IA pass. Composes data from existing
  // tables; no schema changes, no mutations. Feeds the top cards on
  // the new Admin Console home.
  //
  // Shape is documented in
  //   docs/portal/nexus-hub-portal-uiux-admin-user-console-spec.md §9.2
  router.get('/console/overview', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const scalar = (stmt: string, args: unknown[] = []): number => {
        const r = db.prepare(stmt).get(...args) as { c: number } | undefined;
        return r?.c ?? 0;
      };

      const tenantCount = scalar('SELECT COUNT(*) AS c FROM tenants');
      const userCount = scalar('SELECT COUNT(*) AS c FROM users');
      const activeUserCount = scalar("SELECT COUNT(*) AS c FROM users WHERE status = 'active'");
      const suspendedUserCount = scalar("SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'");

      // Waitlist may not exist on every deployment; wrap in try/catch
      // so the overview still renders if the table is absent.
      let waitlistPending = 0;
      try {
        waitlistPending = scalar("SELECT COUNT(*) AS c FROM waitlist WHERE status = 'pending'");
      } catch { /* table not present on this deployment */ }

      // Usage today (admin plane — may expose cost).
      const usageTotalRow = db
        .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS calls FROM api_usage WHERE ts >= date('now')")
        .get() as { total: number; calls: number } | undefined;

      // Recent audit events (last 10 — newest first).
      const recentAudit = db
        .prepare(
          `SELECT id, ts, user_id, actor_id, action, resource
           FROM audit_trail
           ORDER BY id DESC
           LIMIT 10`,
        )
        .all() as Array<{
          id: number; ts: string; user_id: number; actor_id: number; action: string; resource: string;
        }>;

      // Tenant-adoption risk: tenants with zero api_usage in the
      // last 14 days. Cheap heuristic; real churn scoring is future.
      const inactiveTenants = db
        .prepare(
          `SELECT t.id, t.slug, t.display_name
           FROM tenants t
           LEFT JOIN api_usage u ON u.user_id = t.id AND u.ts >= datetime('now', '-14 days')
           WHERE u.user_id IS NULL
           ORDER BY t.id DESC
           LIMIT 20`,
        )
        .all() as Array<{ id: number; slug: string; display_name: string | null }>;

      ok(res, {
        counts: {
          tenants: tenantCount,
          users: userCount,
          activeUsers: activeUserCount,
          suspendedUsers: suspendedUserCount,
          waitlistPending,
        },
        usageToday: {
          totalUsd: usageTotalRow?.total ?? 0,
          calls: usageTotalRow?.calls ?? 0,
        },
        recentAudit: recentAudit.map((r) => ({
          id: r.id,
          ts: r.ts,
          userId: r.user_id,
          actorId: r.actor_id,
          action: r.action,
          resource: r.resource,
        })),
        adoptionRisk: {
          inactiveTenants: inactiveTenants.length,
          samples: inactiveTenants,
        },
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, 'portal-owner-router: /console/overview failed');
      err(res, 500, 'INTERNAL', 'Failed to compute overview');
    }
  });

  return router;
}

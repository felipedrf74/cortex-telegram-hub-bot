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

  return router;
}

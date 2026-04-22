// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Portal Workspace / User Console router (`/workspace/*`).
 *
 * Part of the portal redesign (feature/nexus-hub-owner-workspace-separation,
 * 2026-04-22). See `docs/portal/nexus-hub-portal-owner-workspace-redesign.md`.
 *
 * ## Purpose
 *
 * Tenant-scoped, user-scoped console. Normal tenant users manage
 * their own books/content/links/profile/preferences. Tenant admins
 * get elevated sub-sections (members, invites, tenant settings).
 * Nothing here reveals cross-tenant data — platform-level
 * observability lives at /owner/*.
 *
 * ## Auth chain
 *
 *   1. `authMiddleware` (iOS JWT) runs first, sets `req.userId`.
 *   2. `resolveTenantContext` reads `X-Tenant-Id` (or falls back
 *      to the solo tenant) and verifies membership, attaching
 *      `req.tenantContext`.
 *   3. Tenant-admin-only endpoints additionally call
 *      `requireTenantAdmin`.
 *
 * ## MVP scope
 *
 * This router ships a small set of proof-of-concept endpoints that
 * demonstrate the separation. Real backing implementations of
 * /workspace/books, /content, /links land in Phase 2 when we wire
 * the existing book / content / link services through tenant-scoped
 * query helpers.
 *
 *   GET   /workspace/me              — current user + tenant + role
 *   GET   /workspace/tenants         — tenants I'm a member of (switcher)
 *   GET   /workspace/profile         — my profile (subset of users row)
 *   PATCH /workspace/profile         — update my profile
 *   GET   /workspace/members         — list tenant members (tenant_admin)
 *   GET   /workspace/books           — stub (Phase 2 wires real books)
 *   GET   /workspace/usage           — my + my tenant's usage today
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { logger } from '../utils/logger';
import { authMiddleware, type AuthenticatedRequest } from './auth-middleware';
import {
  resolveTenantContext,
  requireTenantAdmin,
  type TenantContextRequest,
} from './tenant-context-guard';
import {
  listTenantsForUser,
  listMembersOfTenant,
} from '../services/tenant-service';
import {
  createInvite,
  listInvitesForTenant,
  listPendingForEmail,
  acceptInvite,
  revokeInvite,
  InviteError,
  type InviteRole,
} from '../services/tenant-invite-service';
import { getDb } from '../services/database';

// ── Response helpers (same shape as /owner/*) ─────────────────────

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

// ── Router factory ─────────────────────────────────────────────────

export function createPortalWorkspaceRouter(): Router {
  const router = Router();

  // JSON parser scoped to this router.
  router.use(express.json({ limit: '2mb' }));

  // Every route requires iOS-JWT auth THEN resolved tenant context.
  router.use(authMiddleware);
  router.use(resolveTenantContext);

  // ── GET /workspace/me ──────────────────────────────────────────
  router.get('/me', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const userId = ctx.userId;
    try {
      const db = getDb();
      const user = db
        .prepare(
          'SELECT id, email, username, first_name, last_name, avatar_url, language, timezone, tier, status FROM users WHERE id = ?',
        )
        .get(userId) as
        | {
            id: number;
            email: string | null;
            username: string | null;
            first_name: string | null;
            last_name: string | null;
            avatar_url: string | null;
            language: string | null;
            timezone: string | null;
            tier: string | null;
            status: string | null;
          }
        | undefined;
      if (!user) {
        return err(res, 404, 'USER_NOT_FOUND', 'Your user record was not found', { userId });
      }
      ok(res, {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
          avatarUrl: user.avatar_url,
          language: user.language,
          timezone: user.timezone,
          tier: user.tier,
          status: user.status,
        },
        tenant: ctx.tenant,
        role: ctx.role,
        joinedAt: ctx.joinedAt,
      });
    } catch (dbErr) {
      logger.error({ err: dbErr, userId }, 'portal-workspace-router: /me failed');
      err(res, 500, 'INTERNAL', 'Failed to load your profile');
    }
  });

  // ── GET /workspace/tenants ─────────────────────────────────────
  // The tenant switcher list. Returns every tenant the user is a
  // member of, with their role in each. The single-tenant case
  // (solo tenant) returns exactly one row.
  router.get('/tenants', (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    ok(res, { tenants: listTenantsForUser(userId) });
  });

  // ── GET /workspace/profile ─────────────────────────────────────
  router.get('/profile', (req: Request, res: Response) => {
    const userId = (req as TenantContextRequest).userId;
    try {
      const db = getDb();
      const user = db
        .prepare(
          'SELECT email, username, first_name, last_name, avatar_url, language, timezone FROM users WHERE id = ?',
        )
        .get(userId) as
        | {
            email: string | null;
            username: string | null;
            first_name: string | null;
            last_name: string | null;
            avatar_url: string | null;
            language: string | null;
            timezone: string | null;
          }
        | undefined;
      if (!user) {
        return err(res, 404, 'USER_NOT_FOUND', 'Your user record was not found');
      }
      ok(res, {
        profile: {
          email: user.email,
          username: user.username,
          firstName: user.first_name,
          lastName: user.last_name,
          avatarUrl: user.avatar_url,
          language: user.language,
          timezone: user.timezone,
        },
      });
    } catch (dbErr) {
      logger.error({ err: dbErr, userId }, 'portal-workspace-router: /profile GET failed');
      err(res, 500, 'INTERNAL', 'Failed to load profile');
    }
  });

  // ── PATCH /workspace/profile ───────────────────────────────────
  // A user can ONLY edit their own profile. No way to modify another
  // user's row via this route — the WHERE clause is keyed on the JWT
  // userId exclusively.
  router.patch('/profile', (req: Request, res: Response) => {
    const userId = (req as TenantContextRequest).userId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowedFields = [
      'firstName',
      'lastName',
      'avatarUrl',
      'language',
      'timezone',
      'username',
    ] as const;

    const columnMap: Record<(typeof allowedFields)[number], string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      avatarUrl: 'avatar_url',
      language: 'language',
      timezone: 'timezone',
      username: 'username',
    };

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const field of allowedFields) {
      if (!(field in body)) continue;
      const v = body[field];
      if (v !== null && typeof v !== 'string') {
        return err(
          res,
          400,
          'BAD_REQUEST',
          `${field} must be a string or null`,
        );
      }
      sets.push(`${columnMap[field]} = ?`);
      values.push(v === null ? null : String(v).trim().slice(0, 256));
    }

    if (sets.length === 0) {
      return err(res, 400, 'BAD_REQUEST', 'At least one editable field must be provided');
    }

    try {
      const db = getDb();
      values.push(userId);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    } catch (dbErr) {
      logger.error({ err: dbErr, userId }, 'portal-workspace-router: /profile PATCH failed');
      return err(res, 500, 'INTERNAL', 'Failed to update profile');
    }
    ok(res, { updated: true });
  });

  // ── GET /workspace/members ─────────────────────────────────────
  // Tenant-admin only. List members of MY tenant (the active tenant
  // from context), never cross-tenant.
  router.get('/members', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    ok(res, {
      tenantId: ctx.tenantId,
      members: listMembersOfTenant(ctx.tenantId),
    });
  });

  // ── GET /workspace/books ───────────────────────────────────────
  // Stub: a per-user "my books" table doesn't exist yet in the
  // schema — today the global admin /api/books endpoint returns
  // the seed-book library (config_seed_books + read-status). Phase 2
  // adds a `tenant_books` table keyed by tenant_id and wires this
  // endpoint to it. For the MVP we return an empty list scoped to
  // the active tenant so the iOS shape is round-trippable and the
  // isolation guarantee is already enforced by the middleware chain.
  router.get('/books', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    ok(res, {
      tenantId: ctx.tenantId,
      books: [],
      note: 'Per-tenant books backing not yet implemented. See docs/portal/nexus-hub-portal-owner-workspace-redesign.md §7 Phase 2.',
    });
  });

  // ── GET /workspace/usage ───────────────────────────────────────
  // Returns the CURRENT USER's spend for today — never any other
  // tenant's. This is the user-scoped "how much have I used?"
  // version of /owner/usage.
  router.get('/usage', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    try {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as calls
           FROM api_usage
           WHERE user_id = ? AND ts >= date('now')`,
        )
        .get(ctx.userId) as { cost: number; calls: number } | undefined;
      ok(res, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        today: {
          costUsd: row?.cost ?? 0,
          calls: row?.calls ?? 0,
        },
      });
    } catch (dbErr) {
      logger.error({ err: dbErr, userId: ctx.userId }, 'portal-workspace-router: /usage failed');
      err(res, 500, 'INTERNAL', 'Failed to compute usage');
    }
  });

  // ── /workspace/invites — tenant_admin side ────────────────────
  //
  // Admin flows for managing invites INTO the active tenant. All
  // three endpoints require tenant_admin. The invite code is a
  // 32-byte base64url string generated server-side; callers receive
  // it on create and surface it to the invitee through whatever
  // channel (email, chat, paste). We don't send emails from this
  // service — the backend is email-agnostic for invites.

  /** GET /workspace/invites — list all invites for the active tenant */
  router.get('/invites', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    ok(res, {
      tenantId: ctx.tenantId,
      invites: listInvitesForTenant(ctx.tenantId),
    });
  });

  /** POST /workspace/invites — create a new invite for this tenant */
  router.post('/invites', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const roleRaw = typeof body.role === 'string' ? body.role.trim() : 'tenant_member';
    const allowedRoles: InviteRole[] = ['tenant_admin', 'tenant_member', 'tenant_viewer'];
    const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : null;

    if (!email || !email.includes('@')) {
      return err(res, 400, 'BAD_REQUEST', 'email must be a valid address');
    }
    if (!(allowedRoles as readonly string[]).includes(roleRaw)) {
      return err(res, 400, 'BAD_REQUEST', `role must be one of ${allowedRoles.join('|')}`);
    }

    try {
      const invite = createInvite({
        tenantId: ctx.tenantId,
        email,
        role: roleRaw as InviteRole,
        createdBy: ctx.userId,
        expiresAt,
      });
      // Return the FULL invite including invite_code. The admin UI
      // will typically copy this code to the clipboard and share it
      // through their own channel.
      ok(res, { invite }, 201);
    } catch (e) {
      if (e instanceof InviteError) {
        const status = e.code === 'DUPLICATE_PENDING' ? 409 : 400;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e }, 'portal-workspace-router: POST /invites failed');
      err(res, 500, 'INTERNAL', 'Failed to create invite');
    }
  });

  /** DELETE /workspace/invites/:id — revoke a pending invite */
  router.delete('/invites/:id', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const inviteId = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(inviteId) || inviteId <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    }

    // Tenant-admin can only revoke invites FOR their tenant — not
    // cross-tenant. Check ownership BEFORE revoking.
    const db = getDb();
    const ownerRow = db
      .prepare('SELECT tenant_id FROM tenant_invites WHERE id = ?')
      .get(inviteId) as { tenant_id: number } | undefined;
    if (!ownerRow) {
      return err(res, 404, 'NOT_FOUND', 'Invite not found', { inviteId });
    }
    if (ownerRow.tenant_id !== ctx.tenantId) {
      // Don't leak existence: return 404, not 403.
      return err(res, 404, 'NOT_FOUND', 'Invite not found', { inviteId });
    }

    try {
      const updated = revokeInvite(inviteId, ctx.userId);
      ok(res, { invite: updated });
    } catch (e) {
      if (e instanceof InviteError) {
        const status = e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e, inviteId }, 'portal-workspace-router: DELETE /invites failed');
      err(res, 500, 'INTERNAL', 'Failed to revoke invite');
    }
  });

  // ── /workspace/my-invites — invitee side ──────────────────────

  /** GET /workspace/my-invites — pending invites addressed to ME */
  router.get('/my-invites', (req: Request, res: Response) => {
    const userId = (req as TenantContextRequest).userId;
    try {
      const db = getDb();
      const user = db
        .prepare('SELECT email FROM users WHERE id = ?')
        .get(userId) as { email: string | null } | undefined;
      const email = user?.email || '';
      if (!email) {
        // User has no email on file — impossible to have received
        // an invite. Return empty, not an error.
        return ok(res, { invites: [] });
      }
      const invites = listPendingForEmail(email);
      // Decorate each invite with the tenant display name so the
      // UI can render "Accept invitation to Acme Corp" without a
      // second request per row.
      const stmt = db.prepare('SELECT id, slug, display_name FROM tenants WHERE id = ?');
      const decorated = invites.map((inv) => {
        const t = stmt.get(inv.tenantId) as
          | { id: number; slug: string; display_name: string }
          | undefined;
        return {
          ...inv,
          tenant: t ? { id: t.id, slug: t.slug, displayName: t.display_name } : null,
        };
      });
      ok(res, { email, invites: decorated });
    } catch (dbErr) {
      logger.error({ err: dbErr, userId }, 'portal-workspace-router: GET /my-invites failed');
      err(res, 500, 'INTERNAL', 'Failed to load invites');
    }
  });

  /** POST /workspace/my-invites/:code/accept — accept the invite */
  router.post('/my-invites/:code/accept', (req: Request, res: Response) => {
    const userId = (req as TenantContextRequest).userId;
    const code = String(req.params.code || '').trim();
    if (!code) {
      return err(res, 400, 'BAD_REQUEST', 'code is required');
    }
    try {
      const db = getDb();
      const user = db
        .prepare('SELECT email FROM users WHERE id = ?')
        .get(userId) as { email: string | null } | undefined;
      const invite = acceptInvite({
        code,
        userId,
        userEmail: user?.email || '',
      });
      ok(res, { invite, tenantId: invite.tenantId, role: invite.role });
    } catch (e) {
      if (e instanceof InviteError) {
        const statusMap: Record<string, number> = {
          NOT_FOUND: 404,
          EMAIL_MISMATCH: 403,
          REVOKED: 410,
          EXPIRED: 410,
          ALREADY_ACCEPTED: 409,
          DB_ERROR: 500,
        };
        return err(res, statusMap[e.code] ?? 400, e.code, e.message, e.details);
      }
      logger.error({ err: e, code }, 'portal-workspace-router: accept-invite failed');
      err(res, 500, 'INTERNAL', 'Failed to accept invite');
    }
  });

  return router;
}

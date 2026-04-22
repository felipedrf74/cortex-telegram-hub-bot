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
  removeMember,
  RemoveMemberError,
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
import {
  listBooks, getBook, createBook, updateBook, deleteBook,
  listContentNotes, getContentNote, createContentNote, updateContentNote, deleteContentNote,
  listLinks, getLink, createLink, updateLink, deleteLink,
  ResourceError,
  type BookStatus, type ContentKind,
} from '../services/tenant-resource-service';
import { getDb } from '../services/database';

// ── Audit helper ──────────────────────────────────────────────────
//
// Added 2026-04-22 (validation pass) to close an audit-log gap:
// tenant-level sensitive mutations (removeMember, acceptInvite,
// revokeInvite) were previously untracked. That meant a tenant
// admin could kick a member and there was no record of who did it
// or when — a blind spot for security review.
//
// actorId is the user performing the action. For workspace routes
// this is req.userId (the caller's identity). The audit row is
// written best-effort; a failure here never blocks the mutation.
function writeWorkspaceAudit(
  actorUserId: number,
  action: string,
  resource: string,
  details: Record<string, unknown>,
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO audit_trail (user_id, actor_id, action, resource, details, ts)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      actorUserId,
      actorUserId,
      action,
      resource,
      JSON.stringify(details),
    );
  } catch (auditErr) {
    logger.warn({ err: auditErr, action, resource }, 'workspace audit log write failed');
  }
}

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

  // ── /workspace/members — tenant-admin-scoped ──────────────────
  // List members of the ACTIVE tenant (never cross-tenant). The
  // guard chain (authMiddleware → resolveTenantContext → requireTenantAdmin)
  // already proved the caller is tenant_admin of this tenant; this
  // endpoint just surfaces the membership list.
  router.get('/members', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    ok(res, {
      tenantId: ctx.tenantId,
      members: listMembersOfTenant(ctx.tenantId),
    });
  });

  /**
   * DELETE /workspace/members/:userId — remove a member from the
   * active tenant. Enforces three rules server-side (see
   * tenant-service.ts `removeMember` for full rationale):
   *   1. target must be a member (else 404)
   *   2. cannot remove self through this endpoint (400)
   *   3. cannot remove the last tenant_admin (409)
   *
   * Rows the removed member authored (books/notes/links) are
   * intentionally preserved — their `created_by` stays, the rows
   * become read-only for them (membership guard blocks re-entry)
   * and editable by any tenant_admin per the authorship rule in
   * tenant-resource-service.
   */
  router.delete('/members/:userId', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const targetUserId = Number.parseInt(String(req.params.userId), 10);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'userId must be a positive integer');
    }
    try {
      const removed = removeMember(ctx.tenantId, targetUserId, {
        userId: ctx.userId,
        role: ctx.role,
      });
      // Audit log (validation pass 2026-04-22): removed-member is a
      // sensitive tenant-level action. Actor = caller; target = the
      // user they kicked. Resource string matches the /owner/*
      // convention: `tenant.<id>.member.<userId>`.
      writeWorkspaceAudit(
        ctx.userId,
        'tenant.member.remove',
        `tenant.${ctx.tenantId}.member.${targetUserId}`,
        {
          tenantId: ctx.tenantId,
          targetUserId,
          formerRole: removed.role,
          memberSince: removed.joinedAt,
        },
      );
      ok(res, {
        removed: {
          tenantId: removed.tenantId,
          userId: removed.userId,
          role: removed.role,
          joinedAt: removed.joinedAt,
        },
      });
    } catch (e) {
      if (e instanceof RemoveMemberError) {
        const status =
          e.code === 'NOT_A_MEMBER' ? 404
            : e.code === 'CANNOT_REMOVE_SELF' ? 400
              : e.code === 'CANNOT_REMOVE_LAST_ADMIN' ? 409
                : 500;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e, targetUserId }, 'portal-workspace-router: DELETE /members failed');
      err(res, 500, 'INTERNAL', 'Failed to remove member');
    }
  });

  // ── /workspace/books — full CRUD (Phase 2C) ────────────────────
  //
  // Tenant-scoped books library. See tenant-resource-service.ts for
  // the authorship rule (author or tenant_admin can mutate) and
  // tenant-resource-service tests for the isolation contract.

  router.get('/books', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    ok(res, {
      tenantId: ctx.tenantId,
      books: listBooks(ctx.tenantId, { limit, offset }),
    });
  });

  router.get('/books/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    const book = getBook(ctx.tenantId, id);
    if (!book) return err(res, 404, 'NOT_FOUND', 'Book not found');
    ok(res, { book });
  });

  router.post('/books', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const book = createBook(ctx.tenantId, { userId: ctx.userId, role: ctx.role }, {
        title: String(body.title ?? ''),
        author: typeof body.author === 'string' ? body.author : null,
        notes: typeof body.notes === 'string' ? body.notes : null,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        status: typeof body.status === 'string' ? (body.status as BookStatus) : undefined,
      });
      ok(res, { book }, 201);
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e }, 'portal-workspace-router: POST /books failed');
      err(res, 500, 'INTERNAL', 'Failed to create book');
    }
  });

  router.patch('/books/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const book = updateBook(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role }, {
        title: typeof body.title === 'string' ? body.title : undefined,
        author: 'author' in body ? (typeof body.author === 'string' ? body.author : null) : undefined,
        notes: 'notes' in body ? (typeof body.notes === 'string' ? body.notes : null) : undefined,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        status: typeof body.status === 'string' ? (body.status as BookStatus) : undefined,
      });
      ok(res, { book });
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e, id }, 'portal-workspace-router: PATCH /books failed');
      err(res, 500, 'INTERNAL', 'Failed to update book');
    }
  });

  router.delete('/books/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    try {
      deleteBook(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role });
      ok(res, { deleted: true, id });
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message);
      }
      logger.error({ err: e, id }, 'portal-workspace-router: DELETE /books failed');
      err(res, 500, 'INTERNAL', 'Failed to delete book');
    }
  });

  // ── /workspace/content — notes / ideas / drafts ─────────────────
  router.get('/content', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const kind: ContentKind | undefined =
      kindRaw && ['note', 'idea', 'draft', 'published'].includes(kindRaw)
        ? (kindRaw as ContentKind) : undefined;
    ok(res, {
      tenantId: ctx.tenantId,
      notes: listContentNotes(ctx.tenantId, { limit, offset, kind }),
    });
  });

  router.get('/content/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    const note = getContentNote(ctx.tenantId, id);
    if (!note) return err(res, 404, 'NOT_FOUND', 'Note not found');
    ok(res, { note });
  });

  router.post('/content', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const note = createContentNote(ctx.tenantId, { userId: ctx.userId, role: ctx.role }, {
        title: String(body.title ?? ''),
        body: typeof body.body === 'string' ? body.body : '',
        kind: typeof body.kind === 'string' ? (body.kind as ContentKind) : undefined,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      });
      ok(res, { note }, 201);
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e }, 'portal-workspace-router: POST /content failed');
      err(res, 500, 'INTERNAL', 'Failed to create note');
    }
  });

  router.patch('/content/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const note = updateContentNote(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role }, {
        title: typeof body.title === 'string' ? body.title : undefined,
        body: typeof body.body === 'string' ? body.body : undefined,
        kind: typeof body.kind === 'string' ? (body.kind as ContentKind) : undefined,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      });
      ok(res, { note });
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e, id }, 'portal-workspace-router: PATCH /content failed');
      err(res, 500, 'INTERNAL', 'Failed to update note');
    }
  });

  router.delete('/content/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    try {
      deleteContentNote(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role });
      ok(res, { deleted: true, id });
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message);
      }
      logger.error({ err: e, id }, 'portal-workspace-router: DELETE /content failed');
      err(res, 500, 'INTERNAL', 'Failed to delete note');
    }
  });

  // ── /workspace/links — URL bookmarks ────────────────────────────
  router.get('/links', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const favoritesOnly = req.query.favorites === 'true';
    ok(res, {
      tenantId: ctx.tenantId,
      links: listLinks(ctx.tenantId, { limit, offset, favoritesOnly }),
    });
  });

  router.get('/links/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    const link = getLink(ctx.tenantId, id);
    if (!link) return err(res, 404, 'NOT_FOUND', 'Link not found');
    ok(res, { link });
  });

  router.post('/links', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const link = createLink(ctx.tenantId, { userId: ctx.userId, role: ctx.role }, {
        url: String(body.url ?? ''),
        title: typeof body.title === 'string' ? body.title : null,
        description: typeof body.description === 'string' ? body.description : null,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        isFavorite: body.isFavorite === true,
      });
      ok(res, { link }, 201);
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e }, 'portal-workspace-router: POST /links failed');
      err(res, 500, 'INTERNAL', 'Failed to create link');
    }
  });

  router.patch('/links/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const link = updateLink(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role }, {
        url: typeof body.url === 'string' ? body.url : undefined,
        title: 'title' in body ? (typeof body.title === 'string' ? body.title : null) : undefined,
        description: 'description' in body ? (typeof body.description === 'string' ? body.description : null) : undefined,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        isFavorite: typeof body.isFavorite === 'boolean' ? body.isFavorite : undefined,
      });
      ok(res, { link });
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message, e.details);
      }
      logger.error({ err: e, id }, 'portal-workspace-router: PATCH /links failed');
      err(res, 500, 'INTERNAL', 'Failed to update link');
    }
  });

  router.delete('/links/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    try {
      deleteLink(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role });
      ok(res, { deleted: true, id });
    } catch (e) {
      if (e instanceof ResourceError) {
        const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400;
        return err(res, status, e.code, e.message);
      }
      logger.error({ err: e, id }, 'portal-workspace-router: DELETE /links failed');
      err(res, 500, 'INTERNAL', 'Failed to delete link');
    }
  });

  // ── /workspace/settings — tenant-local settings ─────────────────
  //
  // Tenant-admin can rename the tenant + mutate metadata_json. The
  // platform owner can ALSO do this via /owner/tenants/:id; this
  // endpoint is the tenant-side surface so tenant_admin doesn't
  // need platform-level access.

  router.get('/settings', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    ok(res, {
      tenantId: ctx.tenantId,
      settings: {
        displayName: ctx.tenant.displayName,
        slug: ctx.tenant.slug,
        plan: ctx.tenant.plan,   // read-only here; only platform_owner can change plan
        status: ctx.tenant.status,
        metadata: ctx.tenant.metadata,
      },
    });
  });

  router.patch('/settings', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (typeof body.displayName === 'string') {
      const n = body.displayName.trim();
      if (!n) return err(res, 400, 'BAD_REQUEST', 'displayName cannot be empty');
      if (n.length > 128) return err(res, 400, 'BAD_REQUEST', 'displayName too long');
      sets.push('display_name = ?');
      values.push(n);
    }
    if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
      // Merge over the existing metadata rather than replace — this
      // lets the client set one key without clobbering others.
      const merged = { ...ctx.tenant.metadata, ...(body.metadata as Record<string, unknown>) };
      sets.push('metadata_json = ?');
      values.push(JSON.stringify(merged));
    }
    if (sets.length === 0) {
      return err(res, 400, 'BAD_REQUEST', 'At least one of displayName, metadata must be provided');
    }
    values.push(ctx.tenantId);
    try {
      getDb()
        .prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values);
    } catch (dbErr) {
      logger.error({ err: dbErr, tenantId: ctx.tenantId }, 'portal-workspace-router: PATCH /settings failed');
      return err(res, 500, 'INTERNAL', 'Failed to update settings');
    }
    ok(res, { updated: true });
  });

  // ── /workspace/security — read-only personal security view ─────
  //
  // Shows the caller's active iOS devices + recent audit_trail rows
  // for their own user_id. No passwords, no 2FA yet (Phase 3). This
  // is a tenant-scoped surface only in the sense that it runs inside
  // the workspace router — the data returned is the caller's own
  // security state, orthogonal to the active tenant.
  router.get('/security', (req: Request, res: Response) => {
    const userId = (req as TenantContextRequest).userId;
    try {
      const db = getDb();
      const devices = db
        .prepare(
          `SELECT device_id, device_name, last_active_at, created_at
           FROM ios_devices
           WHERE user_id = ?
           ORDER BY last_active_at DESC
           LIMIT 20`,
        )
        .all(userId) as Array<{
          device_id: string;
          device_name: string | null;
          last_active_at: string | null;
          created_at: string | null;
        }>;
      const audit = db
        .prepare(
          `SELECT id, ts, action, resource, details
           FROM audit_trail
           WHERE user_id = ? OR actor_id = ?
           ORDER BY id DESC
           LIMIT 50`,
        )
        .all(userId, userId) as Array<{
          id: number;
          ts: string;
          action: string;
          resource: string;
          details: string | null;
        }>;
      ok(res, {
        userId,
        devices: devices.map((d) => ({
          deviceId: d.device_id,
          deviceName: d.device_name,
          lastActiveAt: d.last_active_at,
          createdAt: d.created_at,
        })),
        recentAudit: audit.map((a) => ({
          id: a.id,
          ts: a.ts,
          action: a.action,
          resource: a.resource,
          details: (() => {
            try { return a.details ? JSON.parse(a.details) : null; } catch { return a.details; }
          })(),
        })),
      });
    } catch (dbErr) {
      logger.error({ err: dbErr, userId }, 'portal-workspace-router: GET /security failed');
      err(res, 500, 'INTERNAL', 'Failed to load security info');
    }
  });

  // ── GET /workspace/usage ───────────────────────────────────────
  // Returns the CURRENT USER's spend for today — never any other
  // tenant's. This is the user-scoped "how much have I used?"
  // version of /owner/usage.
  // Cost-privacy invariant (2026-04-22): `/workspace/*` MUST NOT
  // expose AI spend dollars to tenant users. The platform owner
  // subsidizes AI infrastructure — tenants see their own activity
  // (call counts, rate-limit status) but NEVER the $ amount.
  // Cross-tenant + per-tenant spend rollups live at `/owner/usage`
  // behind the platform-admin guard. See the test case
  // "cost-privacy: /workspace/usage MUST NOT return costUsd" in
  // __tests__/api/portal-workspace-router.test.ts.
  router.get('/usage', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    try {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT COUNT(*) as calls
           FROM api_usage
           WHERE user_id = ? AND ts >= date('now')`,
        )
        .get(ctx.userId) as { calls: number } | undefined;
      ok(res, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        today: {
          // NOTE: no costUsd. Platform-owner-only via /owner/usage.
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
      // Audit log (validation pass 2026-04-22). Note: we deliberately
      // do NOT include the invite_code in the audit row — that's the
      // shared secret. The id + email + role are enough for review.
      writeWorkspaceAudit(
        ctx.userId,
        'tenant.invite.create',
        `tenant.${ctx.tenantId}.invite.${invite.id}`,
        { tenantId: ctx.tenantId, inviteId: invite.id, email: invite.email, role: invite.role },
      );
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
      writeWorkspaceAudit(
        ctx.userId,
        'tenant.invite.revoke',
        `tenant.${ctx.tenantId}.invite.${inviteId}`,
        { tenantId: ctx.tenantId, inviteId, email: updated.email, role: updated.role },
      );
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
      // Audit: actor is the invitee who accepted. Target resource is
      // the tenant they joined. The audit row surfaces on BOTH the
      // invitee's /workspace/security view and any /owner/audit.
      writeWorkspaceAudit(
        userId,
        'tenant.invite.accept',
        `tenant.${invite.tenantId}.member.${userId}`,
        { tenantId: invite.tenantId, inviteId: invite.id, role: invite.role },
      );
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

  // ── GET /workspace/console/home ──────────────────────────────────
  //
  // Aggregated User Console home payload. Added 2026-04-22 for the
  // admin/user-console IA pass. It is a READ-ONLY convenience
  // endpoint that composes existing tables — no schema changes, no
  // side effects, no cost exposure (tenant plane never shows costUsd).
  //
  // Response shape is documented in
  //   docs/portal/nexus-hub-portal-uiux-admin-user-console-spec.md §9.2
  //   docs/portal/nexus-hub-portal-uiux-dependencies-and-insights-model.md
  //
  // Kept intentionally small: each field is a pure function of
  // existing data. If a derived field can't be computed honestly
  // (e.g. real insight engine not yet built) we return an empty
  // array and let the UI render an honest empty state.
  router.get('/console/home', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    try {
      const db = getDb();

      // ── Counts of tenant-scoped reference material. Used by the
      //    sidebar badges and the dependency evaluator below.
      const row = (stmt: string, ...args: unknown[]): number => {
        const r = db.prepare(stmt).get(...args) as { c: number } | undefined;
        return r?.c ?? 0;
      };
      const booksCount = row(
        'SELECT COUNT(*) AS c FROM tenant_books WHERE tenant_id = ?',
        ctx.tenantId,
      );
      const notesCount = row(
        'SELECT COUNT(*) AS c FROM tenant_content_notes WHERE tenant_id = ?',
        ctx.tenantId,
      );
      const linksCount = row(
        'SELECT COUNT(*) AS c FROM tenant_links WHERE tenant_id = ?',
        ctx.tenantId,
      );
      const membersCount = row(
        'SELECT COUNT(*) AS c FROM tenant_members WHERE tenant_id = ?',
        ctx.tenantId,
      );
      const pendingInvitesCount = row(
        "SELECT COUNT(*) AS c FROM tenant_invites WHERE tenant_id = ? AND status = 'pending'",
        ctx.tenantId,
      );

      // ── Usage today (NO costUsd — tenant plane never shows dollars)
      const usageRow = db
        .prepare(
          `SELECT COUNT(*) AS calls
           FROM api_usage
           WHERE user_id = ? AND ts >= date('now')`,
        )
        .get(ctx.userId) as { calls: number } | undefined;

      // ── Setup progress. Honest: 4 milestones, counted as done if
      //    the underlying table has a row.
      const milestones = [
        { id: 'first-book',     label: 'Add your first book',           done: booksCount > 0 },
        { id: 'first-note',     label: 'Capture a content note',        done: notesCount > 0 },
        { id: 'first-link',     label: 'Save a reference link',         done: linksCount > 0 },
        { id: 'team-or-solo',   label: 'Set up your team (or stay solo)', done: membersCount > 0 || pendingInvitesCount > 0 },
      ];
      const doneCount = milestones.filter((m) => m.done).length;
      const setupPercent = Math.round((doneCount / milestones.length) * 100);

      // ── Dependencies (MVP subset — only the four we can compute
      //    cheaply from existing tables; full catalog in the spec).
      interface ConsoleDependency {
        id: string;
        skillId: string;
        kind: string;
        label: string;
        status: 'ready' | 'missing' | 'degraded' | 'unknown';
        cta: { label: string; href: string } | null;
      }
      const dependencies: ConsoleDependency[] = [
        {
          id: 'content.books.library',
          skillId: 'content',
          kind: 'reference',
          label: 'Books library',
          status: booksCount > 0 ? 'ready' : 'missing',
          cta: booksCount > 0 ? null : { label: 'Add a book', href: '#/references/books' },
        },
        {
          id: 'content.links.curated',
          skillId: 'content',
          kind: 'reference',
          label: 'Curated links',
          status: linksCount >= 3 ? 'ready' : linksCount > 0 ? 'degraded' : 'missing',
          cta: linksCount >= 3 ? null : { label: 'Add links', href: '#/references/links' },
        },
        {
          id: 'content.notes.captured',
          skillId: 'content',
          kind: 'reference',
          label: 'Content notes',
          status: notesCount > 0 ? 'ready' : 'missing',
          cta: notesCount > 0 ? null : { label: 'Capture a note', href: '#/references/notes' },
        },
        {
          id: 'workspace.team.set-up',
          skillId: 'workspace',
          kind: 'setting',
          label: 'Team set up (or solo confirmed)',
          status: membersCount > 0 || pendingInvitesCount > 0 ? 'ready' : 'unknown',
          cta: ctx.role === 'tenant_admin'
            ? { label: 'Invite a teammate', href: '#/team/invites' }
            : null,
        },
      ];
      const depCounts = {
        total: dependencies.length,
        ready: dependencies.filter((d) => d.status === 'ready').length,
        missing: dependencies.filter((d) => d.status === 'missing').length,
        degraded: dependencies.filter((d) => d.status === 'degraded').length,
        unknown: dependencies.filter((d) => d.status === 'unknown').length,
      };

      // ── Insights (MVP: derived ONLY from missing dependencies +
      //    setup progress. No fake intelligence.).
      interface ConsoleInsight {
        id: string;
        scope: 'tenant' | 'user';
        skillId: string | null;
        severity: 'info' | 'nudge' | 'warning';
        kind: 'setup' | 'dependency-missing';
        title: string;
        body: string;
        cta: { label: string; href: string } | null;
      }
      const insights: ConsoleInsight[] = [];
      for (const dep of dependencies) {
        if (dep.status === 'missing') {
          insights.push({
            id: `dep:${dep.id}`,
            scope: 'tenant',
            skillId: dep.skillId,
            severity: 'warning',
            kind: 'dependency-missing',
            title: `${dep.label} — not set up`,
            body: `Your ${dep.skillId} skill needs this to work at its best.`,
            cta: dep.cta,
          });
        }
      }
      if (setupPercent < 100) {
        insights.push({
          id: 'setup:incomplete',
          scope: 'user',
          skillId: null,
          severity: 'nudge',
          kind: 'setup',
          title: `Workspace setup is ${setupPercent}% complete`,
          body: `${doneCount} of ${milestones.length} milestones done. Finishing setup unlocks stronger skill outputs.`,
          cta: { label: 'Finish setup', href: '#/home' },
        });
      }

      ok(res, {
        tenant: {
          id: ctx.tenantId,
          role: ctx.role,
        },
        user: {
          id: ctx.userId,
        },
        counts: {
          books: booksCount,
          notes: notesCount,
          links: linksCount,
          members: membersCount,
          pendingInvites: pendingInvitesCount,
        },
        usage: {
          // No costUsd. Tenant plane never exposes dollars.
          callsToday: usageRow?.calls ?? 0,
        },
        setup: {
          percent: setupPercent,
          done: doneCount,
          total: milestones.length,
          milestones,
        },
        dependencies: {
          ...depCounts,
          items: dependencies,
        },
        insights,
      });
    } catch (dbErr) {
      logger.error({ err: dbErr, tenantId: ctx.tenantId, userId: ctx.userId }, 'portal-workspace-router: /console/home failed');
      err(res, 500, 'INTERNAL', 'Failed to compute console home');
    }
  });

  return router;
}

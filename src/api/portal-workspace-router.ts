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
import {
  listChannels, countActiveChannels, getChannel, createChannel, updateChannel, deleteChannel,
  ChannelError,
  type ChannelKind, type ChannelStatus,
} from '../services/tenant-channel-service';
import {
  getSkillConfig, putSkillConfig, getSkillSchemaKeys, isSkillId,
  listSkillConfigHistoryByKey,
  SkillConfigError,
  type SkillId,
} from '../services/tenant-skill-config-service';
import { suggestTagsForRef } from '../services/skill-inference';
import { getDb } from '../services/database';
// OI-DATA-007 (2026-04-24): consolidated integrations view.
import { listUserIntegrations } from '../services/integrations-view';

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

// OI-DATA-005a (2026-04-24): compute which ALLOWED fields were
// present in a PATCH body, so update-audits record WHICH keys the
// caller touched without ever leaking the VALUES. Matches the
// OI-DATA-003e convention used by skill-config history (keysTouched
// but never the values — body can be long, personal, sensitive).
//
// `allowedKeys` is the closed set of fields the PATCH handler maps
// to service-layer updateX inputs. Unknown keys on the body are
// ignored (same as the service layer does). `undefined` values
// don't count as "touched" — callers that pass `title: undefined`
// to unset are rejected by the service anyway; we align semantics.
function pickKeysTouched(
  body: Record<string, unknown>,
  allowedKeys: readonly string[],
): string[] {
  const touched: string[] = [];
  for (const k of allowedKeys) {
    if (k in body && body[k] !== undefined) touched.push(k);
  }
  return touched;
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
      // OI-DATA-005a (2026-04-24): audit the create. We include
      // title + author (both user-facing, already shown in the UI)
      // but NOT notes (can be long + personal). This mirrors the
      // delete-audit details shape so the Activity feed can render
      // both consistently.
      writeWorkspaceAudit(
        ctx.userId,
        'tenant.book.create',
        `tenant.${ctx.tenantId}.book.${book.id}`,
        { tenantId: ctx.tenantId, bookId: book.id, title: book.title, author: book.author },
      );
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
      // OI-DATA-005a: keysTouched but never values. `notes` is
      // particularly sensitive (long-form personal content);
      // recording that notes was touched is useful for the
      // Activity feed without leaking what it contains.
      const keysTouched = pickKeysTouched(body, ['title', 'author', 'notes', 'tags', 'status']);
      if (keysTouched.length > 0) {
        writeWorkspaceAudit(
          ctx.userId,
          'tenant.book.update',
          `tenant.${ctx.tenantId}.book.${id}`,
          { tenantId: ctx.tenantId, bookId: id, title: book.title, keysTouched },
        );
      }
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
      // OI-DATA-005: capture row before delete so the audit trail
      // carries title (useful in the Activity feed) — rows are gone
      // after delete so we can't join back. getBook returns null
      // on cross-tenant mismatch, which surfaces as NOT_FOUND in
      // the service delete anyway — no leak.
      const snap = getBook(ctx.tenantId, id);
      deleteBook(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role });
      if (snap) {
        writeWorkspaceAudit(
          ctx.userId,
          'tenant.book.delete',
          `tenant.${ctx.tenantId}.book.${id}`,
          { tenantId: ctx.tenantId, bookId: id, title: snap.title, author: snap.author },
        );
      }
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
      // OI-DATA-005a: audit the create. Title + kind only — the
      // note body is long-form personal content and never belongs
      // in the audit log.
      writeWorkspaceAudit(
        ctx.userId,
        'tenant.note.create',
        `tenant.${ctx.tenantId}.note.${note.id}`,
        { tenantId: ctx.tenantId, noteId: note.id, title: note.title, kind: note.kind },
      );
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
      // OI-DATA-005a: keysTouched only; `body` is the canonical
      // "long-form personal content" field — recording that it
      // was touched is useful; recording what it contains is not.
      const keysTouched = pickKeysTouched(body, ['title', 'body', 'kind', 'tags']);
      if (keysTouched.length > 0) {
        writeWorkspaceAudit(
          ctx.userId,
          'tenant.note.update',
          `tenant.${ctx.tenantId}.note.${id}`,
          { tenantId: ctx.tenantId, noteId: id, title: note.title, keysTouched },
        );
      }
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
      const snap = getContentNote(ctx.tenantId, id);
      deleteContentNote(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role });
      if (snap) {
        writeWorkspaceAudit(
          ctx.userId,
          'tenant.note.delete',
          `tenant.${ctx.tenantId}.note.${id}`,
          { tenantId: ctx.tenantId, noteId: id, title: snap.title, kind: snap.kind },
        );
      }
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
      // OI-DATA-005a: audit the create. URL is user-visible
      // metadata (already shown on the Reference Center list) so
      // it's fine in the audit row; description is the long-form
      // "why I saved this" content and is intentionally omitted.
      writeWorkspaceAudit(
        ctx.userId,
        'tenant.link.create',
        `tenant.${ctx.tenantId}.link.${link.id}`,
        { tenantId: ctx.tenantId, linkId: link.id, title: link.title, url: link.url },
      );
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
      const keysTouched = pickKeysTouched(body, ['url', 'title', 'description', 'tags', 'isFavorite']);
      if (keysTouched.length > 0) {
        writeWorkspaceAudit(
          ctx.userId,
          'tenant.link.update',
          `tenant.${ctx.tenantId}.link.${id}`,
          { tenantId: ctx.tenantId, linkId: id, title: link.title, keysTouched },
        );
      }
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
      const snap = getLink(ctx.tenantId, id);
      deleteLink(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role });
      if (snap) {
        writeWorkspaceAudit(
          ctx.userId,
          'tenant.link.delete',
          `tenant.${ctx.tenantId}.link.${id}`,
          { tenantId: ctx.tenantId, linkId: id, title: snap.title, url: snap.url },
        );
      }
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

  // ── /workspace/channels (OI-DATA-002, 2026-04-22) ──────────────
  //
  // Tenant-scoped channel references. Backs the Reference Center →
  // Channels tab. Same shape as /workspace/books / /content / /links.
  // Service layer enforces isolation + authorship; routes just parse
  // input, call through, and translate ChannelError to HTTP codes.
  //
  // Default ?status filter: excludes archived (see service).
  // Pass ?status=all to include archived, or ?status=<x> to pin down.

  function mapChannelError(res: Response, e: ChannelError): void {
    const statusByCode: Record<string, number> = {
      NOT_FOUND: 404, FORBIDDEN: 403, BAD_REQUEST: 400, DB_ERROR: 500,
    };
    err(res, statusByCode[e.code] ?? 400, e.code, e.message, e.details);
  }

  router.get('/channels', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const rawStatus = req.query.status ? String(req.query.status) : undefined;
    const rawKind = req.query.kind ? String(req.query.kind) : undefined;
    const rawLimit = req.query.limit ? Number.parseInt(String(req.query.limit), 10) : undefined;
    const rawOffset = req.query.offset ? Number.parseInt(String(req.query.offset), 10) : undefined;
    try {
      const channels = listChannels(ctx.tenantId, {
        limit: rawLimit,
        offset: rawOffset,
        status: rawStatus as ChannelStatus | 'all' | undefined,
        kind: rawKind as ChannelKind | undefined,
      });
      ok(res, { tenantId: ctx.tenantId, channels });
    } catch (e) {
      if (e instanceof ChannelError) return mapChannelError(res, e);
      logger.error({ err: e, tenantId: ctx.tenantId }, 'portal-workspace-router: GET /channels failed');
      err(res, 500, 'INTERNAL', 'Failed to list channels');
    }
  });

  router.get('/channels/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    }
    const channel = getChannel(ctx.tenantId, id);
    if (!channel) return err(res, 404, 'NOT_FOUND', 'Channel not found', { id });
    ok(res, { channel });
  });

  router.post('/channels', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const channel = createChannel(
        ctx.tenantId,
        { userId: ctx.userId, role: ctx.role },
        {
          title: typeof body.title === 'string' ? body.title : '',
          url: typeof body.url === 'string' ? body.url : null,
          handle: typeof body.handle === 'string' ? body.handle : null,
          description: typeof body.description === 'string' ? body.description : null,
          kind: typeof body.kind === 'string' ? (body.kind as ChannelKind) : undefined,
          status: typeof body.status === 'string' ? (body.status as ChannelStatus) : undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        },
      );
      // OI-DATA-005a: audit the create. title + kind are
      // user-facing metadata; URL + description are intentionally
      // omitted from the audit details (URL can be very long,
      // description is long-form personal content).
      writeWorkspaceAudit(
        ctx.userId,
        'tenant.channel.create',
        `tenant.${ctx.tenantId}.channel.${channel.id}`,
        { tenantId: ctx.tenantId, channelId: channel.id, title: channel.title, kind: channel.kind },
      );
      ok(res, { channel }, 201);
    } catch (e) {
      if (e instanceof ChannelError) return mapChannelError(res, e);
      logger.error({ err: e, tenantId: ctx.tenantId }, 'portal-workspace-router: POST /channels failed');
      err(res, 500, 'INTERNAL', 'Failed to create channel');
    }
  });

  router.patch('/channels/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const channel = updateChannel(
        ctx.tenantId, id,
        { userId: ctx.userId, role: ctx.role },
        {
          title: typeof body.title === 'string' ? body.title : undefined,
          url: body.url === null ? null : (typeof body.url === 'string' ? body.url : undefined),
          handle: body.handle === null ? null : (typeof body.handle === 'string' ? body.handle : undefined),
          description: body.description === null ? null : (typeof body.description === 'string' ? body.description : undefined),
          kind: typeof body.kind === 'string' ? (body.kind as ChannelKind) : undefined,
          status: typeof body.status === 'string' ? (body.status as ChannelStatus) : undefined,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        },
      );
      const keysTouched = pickKeysTouched(body, ['title', 'url', 'handle', 'description', 'kind', 'status', 'tags']);
      if (keysTouched.length > 0) {
        writeWorkspaceAudit(
          ctx.userId,
          'tenant.channel.update',
          `tenant.${ctx.tenantId}.channel.${id}`,
          { tenantId: ctx.tenantId, channelId: id, title: channel.title, keysTouched },
        );
      }
      ok(res, { channel });
    } catch (e) {
      if (e instanceof ChannelError) return mapChannelError(res, e);
      logger.error({ err: e, tenantId: ctx.tenantId, id }, 'portal-workspace-router: PATCH /channels failed');
      err(res, 500, 'INTERNAL', 'Failed to update channel');
    }
  });

  router.delete('/channels/:id', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      return err(res, 400, 'BAD_REQUEST', 'id must be a positive integer');
    }
    try {
      const snap = getChannel(ctx.tenantId, id);
      deleteChannel(ctx.tenantId, id, { userId: ctx.userId, role: ctx.role });
      if (snap) {
        writeWorkspaceAudit(
          ctx.userId,
          'tenant.channel.delete',
          `tenant.${ctx.tenantId}.channel.${id}`,
          { tenantId: ctx.tenantId, channelId: id, title: snap.title, kind: snap.kind },
        );
      }
      ok(res, { deleted: true, id });
    } catch (e) {
      if (e instanceof ChannelError) return mapChannelError(res, e);
      logger.error({ err: e, tenantId: ctx.tenantId, id }, 'portal-workspace-router: DELETE /channels failed');
      err(res, 500, 'INTERNAL', 'Failed to delete channel');
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

  // ── /workspace/skills/:skillId/config (OI-DATA-003, 2026-04-22) ─
  //
  // Per-tenant, per-skill configuration. Backs the Configuration
  // tab on each skill page in the User Console. Storage = JSON blob
  // per (tenant, skill) — migration 080. Per-skill schema validation
  // lives in tenant-skill-config-service.ts.
  //
  //   GET  = any member (config is tenant-shared state; visibility
  //          helps everyone understand what drives their skills)
  //   PUT  = tenant_admin only (editing is admin-scope)
  //
  // v1 scope: only the Content skill has a real schema. Secretary /
  // Training / Finance / Cooking accept GET but PUT with any field
  // returns 400 BAD_REQUEST ("has no configurable fields yet").
  // Per-skill schemas come in a follow-up (OI-DATA-003a..d).

  function mapSkillConfigError(res: Response, e: SkillConfigError): void {
    const statusByCode: Record<string, number> = {
      NOT_FOUND: 404, UNKNOWN_SKILL: 404, BAD_REQUEST: 400, DB_ERROR: 500,
    };
    err(res, statusByCode[e.code] ?? 400, e.code, e.message, e.details);
  }

  router.get('/skills/:skillId/config', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const skillId = String(req.params.skillId);
    if (!isSkillId(skillId)) {
      return err(res, 404, 'UNKNOWN_SKILL', `Unknown skill '${skillId}'`, { skillId });
    }
    try {
      const row = getSkillConfig(ctx.tenantId, skillId as SkillId);
      ok(res, {
        skillId,
        tenantId: ctx.tenantId,
        config: row.config,
        schemaKeys: getSkillSchemaKeys(skillId as SkillId),
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      });
    } catch (e) {
      if (e instanceof SkillConfigError) return mapSkillConfigError(res, e);
      logger.error({ err: e, tenantId: ctx.tenantId, skillId }, 'portal-workspace-router: GET /skills/:id/config failed');
      err(res, 500, 'INTERNAL', 'Failed to load skill config');
    }
  });

  router.put('/skills/:skillId/config', requireTenantAdmin, (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const skillId = String(req.params.skillId);
    if (!isSkillId(skillId)) {
      return err(res, 404, 'UNKNOWN_SKILL', `Unknown skill '${skillId}'`, { skillId });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Callers may send `{ config: { ... } }` OR the flat patch
    // directly at the body root. Prefer the nested form for clarity
    // but accept both so the UI can be terse.
    const patch = (body.config && typeof body.config === 'object' && !Array.isArray(body.config))
      ? body.config as Record<string, unknown>
      : body;
    try {
      const row = putSkillConfig(ctx.tenantId, skillId as SkillId, ctx.userId, patch);
      // Audit the save. We log 'tenant.skill_config.update' with the
      // full key set of the patch (not the values — voice guidelines
      // can be long and personal; we don't want them in audit_trail).
      writeWorkspaceAudit(
        ctx.userId,
        'tenant.skill_config.update',
        `tenant.${ctx.tenantId}.skill.${skillId}.config`,
        { tenantId: ctx.tenantId, skillId, keysTouched: Object.keys(patch) },
      );
      ok(res, {
        skillId,
        tenantId: ctx.tenantId,
        config: row.config,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      });
    } catch (e) {
      if (e instanceof SkillConfigError) return mapSkillConfigError(res, e);
      logger.error({ err: e, tenantId: ctx.tenantId, skillId }, 'portal-workspace-router: PUT /skills/:id/config failed');
      err(res, 500, 'INTERNAL', 'Failed to save skill config');
    }
  });

  // ── /workspace/skills/:skillId/config/history (OI-DATA-003e) ───
  //
  // Per-key audit history for a skill-config field. Returns the N
  // most recent audit_trail rows whose keysTouched array contained
  // the queried key. Values are NEVER returned — only who changed
  // it, when, and what other keys they touched in the same save.
  // (Preserves the CLAUDE.md "audit: keysTouched only" invariant.)
  //
  // Any tenant member can read (view-only, no PII beyond the
  // actor's email, which the member already sees in the Team list).
  router.get('/skills/:skillId/config/history', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const skillId = String(req.params.skillId);
    if (!isSkillId(skillId)) {
      return err(res, 404, 'UNKNOWN_SKILL', `Unknown skill '${skillId}'`, { skillId });
    }
    const keyRaw = typeof req.query.key === 'string' ? req.query.key : '';
    const validKeys = getSkillSchemaKeys(skillId as SkillId);
    if (!keyRaw || !validKeys.includes(keyRaw)) {
      return err(res, 400, 'INVALID_KEY', `key must be one of the ${skillId} schema keys`, {
        allowed: validKeys,
      });
    }
    const limitRaw = req.query.limit;
    const limitParsed = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : 10;
    if (!Number.isFinite(limitParsed) || limitParsed <= 0 || limitParsed > 100) {
      return err(res, 400, 'INVALID_LIMIT', 'limit must be a positive integer ≤ 100');
    }
    try {
      const entries = listSkillConfigHistoryByKey(ctx.tenantId, skillId as SkillId, keyRaw, limitParsed);
      ok(res, { skillId, key: keyRaw, entries });
    } catch (e) {
      if (e instanceof SkillConfigError) return mapSkillConfigError(res, e);
      logger.error({ err: e, tenantId: ctx.tenantId, skillId, key: keyRaw }, 'portal-workspace-router: GET /skills/:id/config/history failed');
      err(res, 500, 'INTERNAL', 'Failed to load skill config history');
    }
  });

  // ── /workspace/skills/suggest-tags (OI-USR-405b, 2026-04-24) ───
  //
  // Given an existing reference (book / link / note / channel),
  // return ranked skill suggestions based on tag overlap with
  // the tenant's already-skill-tagged references. Pure read — no
  // writes, no side effects. Returns `coldStart: true` when the
  // tenant has ≤ 3 refs carrying any skill tag (the user hasn't
  // built enough tagging history for the signal to be useful).
  //
  // Any tenant member can call this (the suggestions are read-
  // only and don't reveal other tenants' data). The audit trail
  // skips this endpoint — it's a view-like operation, not a
  // mutation.
  router.post('/skills/suggest-tags', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kindRaw = typeof body.kind === 'string' ? body.kind : '';
    const idRaw = body.id;
    if (!['book', 'link', 'note', 'channel'].includes(kindRaw)) {
      return err(res, 400, 'INVALID_KIND', `kind must be one of book|link|note|channel (got '${kindRaw}')`);
    }
    const id = typeof idRaw === 'number' ? idRaw : Number(idRaw);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      return err(res, 400, 'INVALID_ID', `id must be a positive integer (got ${JSON.stringify(idRaw)})`);
    }
    try {
      const result = suggestTagsForRef(ctx.tenantId, kindRaw as 'book' | 'link' | 'note' | 'channel', id);
      ok(res, result);
    } catch (e) {
      if (e instanceof ReferenceError) {
        return err(res, 404, 'REF_NOT_FOUND', e.message);
      }
      logger.error({ err: e, tenantId: ctx.tenantId, kind: kindRaw, id }, 'portal-workspace-router: POST /skills/suggest-tags failed');
      err(res, 500, 'INTERNAL', 'Failed to compute skill suggestions');
    }
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
  // Every caller always gets their OWN spend for today. A
  // tenant_admin ADDITIONALLY gets the tenant-wide roll-up under
  // `tenant.today` (OI-COR-001, 2026-04-24): previously a 3-member
  // tenant wanting "our total usage this month" had to fan out
  // three individual responses and sum manually. Now one call
  // gets it, role-gated.
  //
  // Cost-privacy invariant (2026-04-22): `/workspace/*` MUST NOT
  // expose AI spend dollars to tenant users — NOT even to tenant
  // admins, NOT in the tenant rollup, NOT anywhere. The platform
  // owner subsidizes AI infrastructure; tenants see their own
  // activity (call counts, rate-limit status) but NEVER the $
  // amount. Cross-tenant + per-tenant spend rollups live at
  // `/owner/usage` behind the platform-admin guard. See the test
  // "cost-privacy: /workspace/usage MUST NOT return costUsd" in
  // __tests__/api/portal-workspace-router.test.ts.
  //
  // Isolation invariant: the tenant rollup is scoped via
  // tenant_members, never via a global SELECT. The test "tenant
  // total never leaks from another tenant" pins this — a user in
  // tenant A querying /workspace/usage must never see tenant B's
  // calls, even when A is also a member of B.
  router.get('/usage', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    try {
      const db = getDb();

      // Caller's own calls (every role sees this).
      const mine = db
        .prepare(
          `SELECT COUNT(*) as calls
           FROM api_usage
           WHERE user_id = ? AND ts >= date('now')`,
        )
        .get(ctx.userId) as { calls: number } | undefined;

      // Base response. `tenant` added conditionally for admins below.
      const response: Record<string, unknown> = {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        today: {
          // NOTE: no costUsd. Platform-owner-only via /owner/usage.
          calls: mine?.calls ?? 0,
        },
      };

      // OI-COR-001: tenant-wide rollup for admins only. Aggregation
      // joins api_usage through tenant_members so the count is
      // strictly the sum of calls-by-current-members-of-this-tenant
      // today. A user who left the tenant yesterday is correctly
      // excluded (their membership row is gone); a user still in
      // the tenant has all their calls today included.
      if (ctx.role === 'tenant_admin') {
        const rollup = db.prepare(
          `SELECT COUNT(u.id) AS calls, COUNT(DISTINCT tm.user_id) AS memberCount
           FROM tenant_members tm
           LEFT JOIN api_usage u
             ON u.user_id = tm.user_id
             AND u.ts >= date('now')
           WHERE tm.tenant_id = ?`,
        ).get(ctx.tenantId) as { calls: number; memberCount: number } | undefined;
        // `memberCount` counts members regardless of whether they
        // called today — the admin wants "3 members, 47 calls
        // today" not "2 members who happened to make calls today".
        response.tenant = {
          today: {
            // NOTE: no costUsd. Same invariant as `today`.
            calls: rollup?.calls ?? 0,
            memberCount: rollup?.memberCount ?? 0,
          },
        };
      }

      ok(res, response);
    } catch (dbErr) {
      logger.error({ err: dbErr, userId: ctx.userId }, 'portal-workspace-router: /usage failed');
      err(res, 500, 'INTERNAL', 'Failed to compute usage');
    }
  });

  // ── GET /workspace/integrations ────────────────────────────────
  // OI-DATA-007 (2026-04-24): consolidated integration status. Any
  // tenant member can read this — it only surfaces the CALLER's own
  // oauth connections (keyed on users.id), never another member's.
  //
  // Returns a row per supported provider (connected + unconnected
  // alike) so the UI can render an Integrations page that doubles as
  // a "what you CAN connect" list. Joins user_oauth_tokens with the
  // platform-wide integration_health latest-probe snapshot so the
  // user sees BOTH "am I connected?" AND "is the provider healthy?"
  // in one view.
  //
  // Privacy: scopes + expiresAt are per-user data; healthStatus +
  // healthError are platform-wide (same for every tenant).
  router.get('/integrations', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    try {
      const integrations = listUserIntegrations(ctx.userId);
      ok(res, { integrations });
    } catch (dbErr) {
      logger.error(
        { err: dbErr, userId: ctx.userId },
        'portal-workspace-router: /integrations failed',
      );
      err(res, 500, 'INTERNAL', 'Failed to load integration status');
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

  // ── GET /workspace/activity (OI-DATA-005, 2026-04-22) ───────────
  //
  // Tenant-scoped audit feed. Backs the User Console → Activity page.
  // Scopes on the same dot-prefix convention as the Admin Console's
  // /owner/tenants/:id/audit endpoint (OI-ADM-301):
  //   WHERE resource = 'tenant.<id>' OR resource LIKE 'tenant.<id>.%'
  // This is the ONLY way members see cross-member events — they
  // can't scroll the platform-wide audit (that's owner-only).
  //
  // All tenant members, including tenant_viewer, can READ the feed:
  // the events describe changes to shared tenant state, so visibility
  // is parallel to the resource tables themselves.
  //
  // Query parameters (all optional):
  //   action  — exact match OR prefix with trailing *
  //             (e.g. ?action=tenant.invite.* matches all 3 invite
  //             events; ?action=tenant.book.delete matches exact)
  //   actor   — actor_id (integer)
  //   from    — ISO-ish timestamp; events with ts >= from
  //   to      — events with ts <= to
  //   limit   — 1..200, default 100
  //   offset  — pagination
  //
  // LIKE-wildcard escape + 128-char length caps on text inputs
  // mirror the OI-ADM-303 defense.
  router.get('/activity', (req: Request, res: Response) => {
    const ctx = (req as TenantContextRequest).tenantContext;
    // OI-DATA-005b: qualify every column with `a.` so WHERE is
    // valid against the SELECT that JOINs audit_trail (aliased as
    // `a`) against users. The plain `count` query below uses the
    // same WHERE unaliased, which also works because SQLite
    // silently accepts `a.col` when there's no ambiguity — so we
    // keep ONE builder and inject the prefix consistently.
    const where: string[] = ['(a.resource = ? OR a.resource LIKE ?)'];
    const params: unknown[] = [`tenant.${ctx.tenantId}`, `tenant.${ctx.tenantId}.%`];

    const actorRaw = String(req.query.actor ?? '').trim();
    if (actorRaw) {
      const actor = Number.parseInt(actorRaw, 10);
      if (!Number.isFinite(actor) || actor < 0) {
        return err(res, 400, 'BAD_REQUEST', 'actor must be a non-negative integer');
      }
      where.push('a.actor_id = ?'); params.push(actor);
    }

    const actionRaw = String(req.query.action ?? '').trim();
    if (actionRaw) {
      if (actionRaw.length > 128) {
        return err(res, 400, 'BAD_REQUEST', 'action too long');
      }
      if (actionRaw.endsWith('*')) {
        const prefix = actionRaw.slice(0, -1).replace(/[%_]/g, (c) => '\\' + c);
        where.push("a.action LIKE ? ESCAPE '\\'"); params.push(prefix + '%');
      } else {
        where.push('a.action = ?'); params.push(actionRaw);
      }
    }

    const from = String(req.query.from ?? '').trim();
    if (from) { where.push('a.ts >= ?'); params.push(from); }
    const to = String(req.query.to ?? '').trim();
    if (to) { where.push('a.ts <= ?'); params.push(to); }

    const rawLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 200);
    const rawOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

    try {
      const db = getDb();
      const whereSql = 'WHERE ' + where.join(' AND ');
      // OI-DATA-005b (2026-04-24): LEFT JOIN users so the feed can
      // display actor identity (email + first name) instead of
      // just a numeric id. LEFT (not INNER) so audit rows whose
      // actor has been deleted since still appear — the UI renders
      // "(deleted user)" for null joins.
      //
      // The WHERE clause filters on audit_trail.* columns (aliased
      // as `a`), so the JOIN has no isolation risk: rows are
      // already tenant-scoped by resource before users is touched.
      const rows = db
        .prepare(
          `SELECT a.id, a.ts, a.user_id, a.actor_id, a.action, a.resource, a.details,
                  u.email       AS actor_email,
                  u.first_name  AS actor_first_name
           FROM audit_trail a
           LEFT JOIN users u ON u.id = a.actor_id
           ${whereSql}
           ORDER BY a.id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as Array<{
          id: number; ts: string; user_id: number; actor_id: number;
          action: string; resource: string; details: string | null;
          actor_email: string | null; actor_first_name: string | null;
        }>;
      const countRow = db
        .prepare(`SELECT COUNT(*) AS c FROM audit_trail a ${whereSql}`)
        .get(...params) as { c: number } | undefined;
      const total = countRow?.c ?? 0;
      ok(res, {
        tenantId: ctx.tenantId,
        events: rows.map((r) => ({
          id: r.id,
          ts: r.ts,
          userId: r.user_id,
          actorId: r.actor_id,
          // OI-DATA-005b: null when actor_id is 0 (system event)
          // OR when the user was deleted after the audit row was
          // written. UI distinguishes via actorId: 0 → "System",
          // actorId > 0 + null email → "(deleted user)".
          actorEmail: r.actor_email,
          actorFirstName: r.actor_first_name,
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
        },
      });
    } catch (dbErr) {
      logger.error({ err: dbErr, tenantId: ctx.tenantId }, 'portal-workspace-router: /activity failed');
      err(res, 500, 'INTERNAL', 'Failed to load activity');
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
      // OI-DATA-002: active channels. Uses the service helper which
      // wraps the (cheap) index-backed SELECT … WHERE status='active'.
      const activeChannelsCount = countActiveChannels(ctx.tenantId);
      // OI-DATA-003: has the tenant filled in Content voice guidelines?
      // Safe to evaluate here — service returns an empty config for
      // tenants that never saved, so no 404 path to handle.
      let contentVoiceSet = false;
      try {
        const cfg = getSkillConfig(ctx.tenantId, 'content');
        const vg = cfg.config.voice_guidelines;
        contentVoiceSet = typeof vg === 'string' && vg.trim().length > 0;
      } catch {
        // If skill-config storage isn't ready yet, just treat as missing.
        contentVoiceSet = false;
      }
      // OI-DATA-003a: has the tenant described their daily routines?
      // Secretary leans on these to know when to protect focus blocks
      // and how to sequence the day.
      let secretaryRoutinesSet = false;
      try {
        const cfg = getSkillConfig(ctx.tenantId, 'secretary');
        const dr = cfg.config.daily_routines;
        secretaryRoutinesSet = typeof dr === 'string' && dr.trim().length > 0;
      } catch {
        secretaryRoutinesSet = false;
      }
      // OI-DATA-003b: has the tenant set Training goals? Without a
      // north star, Training's plans default to generic endurance
      // and miss the user's real objective.
      let trainingGoalsSet = false;
      try {
        const cfg = getSkillConfig(ctx.tenantId, 'training');
        const g = cfg.config.goals;
        trainingGoalsSet = typeof g === 'string' && g.trim().length > 0;
      } catch {
        trainingGoalsSet = false;
      }
      // OI-DATA-003c: has the tenant described their monthly budget?
      // Finance can't answer "can I afford this?" without this anchor.
      let financeBudgetSet = false;
      try {
        const cfg = getSkillConfig(ctx.tenantId, 'finance');
        const b = cfg.config.budget_monthly;
        financeBudgetSet = typeof b === 'string' && b.trim().length > 0;
      } catch {
        financeBudgetSet = false;
      }
      // OI-DATA-003d: has the tenant set dietary restrictions?
      // Restrictions are HARD constraints (allergies can be dangerous)
      // — Cooking can't safely plan anything without them. Preferences
      // (soft) are separate and not gated here.
      let cookingRestrictionsSet = false;
      try {
        const cfg = getSkillConfig(ctx.tenantId, 'cooking');
        const dr = cfg.config.dietary_restrictions;
        cookingRestrictionsSet = typeof dr === 'string' && dr.trim().length > 0;
      } catch {
        cookingRestrictionsSet = false;
      }
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
          // OI-DATA-002: promoted from the full catalog (spec §2.2).
          // Content Radar is blind without at least one active channel.
          id: 'content.channel.primary',
          skillId: 'content',
          kind: 'reference',
          label: 'Primary reference channel',
          status: activeChannelsCount > 0 ? 'ready' : 'missing',
          cta: activeChannelsCount > 0
            ? null
            : { label: 'Add a channel', href: '#/references/channels' },
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
          // OI-DATA-003: voice guidelines wired as a first-class
          // dependency. Without them the Content skill generates in
          // a generic tone; with them every output respects the
          // tenant's brand voice.
          id: 'content.voice.guidelines',
          skillId: 'content',
          kind: 'setting',
          label: 'Voice & brand guidelines',
          status: contentVoiceSet ? 'ready' : 'missing',
          cta: contentVoiceSet
            ? null
            : { label: 'Configure', href: '#/skills/content/configuration' },
        },
        {
          // OI-DATA-003a: daily routines anchor Secretary's scheduling
          // decisions. Without them it has no way to know when to
          // protect focus blocks or how the user's day is shaped.
          id: 'secretary.routines.set',
          skillId: 'secretary',
          kind: 'setting',
          label: 'Daily routines',
          status: secretaryRoutinesSet ? 'ready' : 'missing',
          cta: secretaryRoutinesSet
            ? null
            : { label: 'Describe your routines', href: '#/skills/secretary/configuration' },
        },
        {
          // OI-DATA-003b: training goals are Training's north star.
          // Without them plans default to generic endurance work
          // and miss what the user is actually training for.
          id: 'training.goals.set',
          skillId: 'training',
          kind: 'setting',
          label: 'Training goals',
          status: trainingGoalsSet ? 'ready' : 'missing',
          cta: trainingGoalsSet
            ? null
            : { label: 'Set your goals', href: '#/skills/training/configuration' },
        },
        {
          // OI-DATA-003c: monthly budget is Finance's anchor. Without
          // it, "can I afford this?" becomes guesswork.
          id: 'finance.budget.set',
          skillId: 'finance',
          kind: 'setting',
          label: 'Monthly budget',
          status: financeBudgetSet ? 'ready' : 'missing',
          cta: financeBudgetSet
            ? null
            : { label: 'Describe your budget', href: '#/skills/finance/configuration' },
        },
        {
          // OI-DATA-003d: dietary restrictions are HARD safety
          // constraints. Cooking can't plan a meal without them;
          // this dep is gated on restrictions, not preferences.
          id: 'cooking.restrictions.set',
          skillId: 'cooking',
          kind: 'setting',
          label: 'Dietary restrictions',
          status: cookingRestrictionsSet ? 'ready' : 'missing',
          cta: cookingRestrictionsSet
            ? null
            : { label: 'List restrictions', href: '#/skills/cooking/configuration' },
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
          channels: activeChannelsCount,
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

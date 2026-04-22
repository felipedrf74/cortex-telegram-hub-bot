// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tenant-context guard for the /workspace/* user console.
 *
 * Part of the portal redesign (feature/nexus-hub-owner-workspace-separation,
 * 2026-04-22). See `docs/portal/nexus-hub-portal-owner-workspace-redesign.md`.
 *
 * ## Flow
 *
 * 1. The caller has already passed `authMiddleware` (iOS JWT) so
 *    `req.userId` is set and the user is verified active.
 * 2. This guard reads the active tenant id from `X-Tenant-Id` (or
 *    falls back to the user's solo tenant id == their user id).
 * 3. It verifies the user is a member of that tenant by looking up
 *    `tenant_members`. If not a member → 403 NOT_A_MEMBER.
 * 4. It attaches `req.tenantContext = { tenantId, role, joinedAt }`
 *    so downstream handlers have the role without re-querying.
 *
 * Tenant status (suspended / archived) is enforced here too:
 * - A suspended tenant rejects ALL /workspace/* traffic.
 * - An archived tenant allows read-only GET but rejects mutations.
 *
 * ## Fail-closed
 *
 * Missing userId (auth-middleware not run) → 500 (middleware order
 * bug). DB error resolving membership → 403 (fail-closed). Unknown
 * tenant → 404. Not a member → 403. Suspended tenant → 423 LOCKED
 * (chosen over 403 so iOS can distinguish and render a clear banner).
 */

import type { Request, Response, NextFunction } from 'express';
import {
  getMembership,
  getTenantById,
  ensureSoloTenantFor,
  type MembershipRow,
  type TenantRow,
  type TenantRole,
} from '../services/tenant-service';
import { logger } from '../utils/logger';

// ── Request augmentation ──────────────────────────────────────────

export interface TenantContext {
  tenantId: number;
  tenant: TenantRow;
  userId: number;
  role: TenantRole;
  joinedAt: string;
}

export interface TenantContextRequest extends Request {
  userId: number;
  tenantContext: TenantContext;
}

// ── Header parsing ─────────────────────────────────────────────────

/**
 * Read the active tenant id from `X-Tenant-Id`. Accepts either a
 * numeric id or the `user-<id>` slug. Returns null when absent or
 * invalid — caller falls back to the user's solo tenant.
 */
function readTenantIdClaim(req: Request): number | null {
  const raw = req.header('X-Tenant-Id');
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  // Numeric form
  if (/^\d+$/.test(trimmed)) {
    const parsed = parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  // Slug form: "user-42" or "user-000042"
  const m = /^user-(\d+)$/.exec(trimmed);
  if (m) {
    const parsed = parseInt(m[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

// ── Response helper ────────────────────────────────────────────────

function respond(res: Response, status: number, code: string, message: string, details?: unknown): void {
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

// ── Middleware ─────────────────────────────────────────────────────

/**
 * Resolve and attach the active tenant context. Assumes
 * `authMiddleware` ran first and set `req.userId` to a valid
 * positive number.
 */
export function resolveTenantContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId = (req as TenantContextRequest).userId;
  if (typeof userId !== 'number' || userId <= 0) {
    logger.error(
      { path: req.path },
      'tenant-context-guard: resolveTenantContext ran before authMiddleware — order bug',
    );
    respond(
      res,
      500,
      'INTERNAL',
      'Tenant-context guard misconfigured (authMiddleware must run first).',
    );
    return;
  }

  // 1. Parse claimed tenant, or fall back to the solo tenant.
  let tenantId = readTenantIdClaim(req);
  if (tenantId === null) {
    tenantId = userId; // solo-tenant convention from migration 076
  }

  // 2. Look up the tenant. If it's the solo tenant and doesn't exist
  //    yet (user registered after migration ran), provision it.
  let tenant: TenantRow | null = getTenantById(tenantId);
  if (!tenant && tenantId === userId) {
    const provisioned = ensureSoloTenantFor(userId);
    if (provisioned) {
      tenant = getTenantById(provisioned);
    }
  }

  if (!tenant) {
    respond(res, 404, 'TENANT_NOT_FOUND', 'No tenant with that id', { tenantId });
    return;
  }

  // 3. Status gates.
  if (tenant.status === 'suspended') {
    respond(
      res,
      423,
      'TENANT_SUSPENDED',
      'This tenant is suspended. Contact the platform admin to restore access.',
      { tenantId: tenant.id, status: tenant.status },
    );
    return;
  }
  if (tenant.status === 'archived' && req.method !== 'GET' && req.method !== 'HEAD') {
    respond(
      res,
      423,
      'TENANT_ARCHIVED',
      'This tenant is archived (read-only).',
      { tenantId: tenant.id, status: tenant.status, allowedMethods: ['GET', 'HEAD'] },
    );
    return;
  }

  // 4. Membership check.
  let membership: MembershipRow | null = null;
  try {
    membership = getMembership(tenant.id, userId);
  } catch (err) {
    logger.error({ err, tenantId: tenant.id, userId }, 'tenant-context-guard: membership lookup failed');
    respond(
      res,
      403,
      'NOT_A_MEMBER',
      'Unable to verify tenant membership (DB error).',
    );
    return;
  }

  if (!membership) {
    respond(
      res,
      403,
      'NOT_A_MEMBER',
      'You are not a member of this tenant.',
      { tenantId: tenant.id },
    );
    return;
  }

  // 5. Attach context and proceed.
  (req as TenantContextRequest).tenantContext = {
    tenantId: tenant.id,
    tenant,
    userId,
    role: membership.role,
    joinedAt: membership.joinedAt,
  };
  next();
}

/**
 * Require the caller to be a `tenant_admin` of the active tenant.
 * Used on tenant-local admin actions: invite members, change tenant
 * settings, manage tenant security.
 *
 * Assumes `resolveTenantContext` ran first.
 */
export function requireTenantAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ctx = (req as TenantContextRequest).tenantContext;
  if (!ctx) {
    logger.error(
      { path: req.path },
      'tenant-context-guard: requireTenantAdmin ran before resolveTenantContext — order bug',
    );
    respond(res, 500, 'INTERNAL', 'Tenant-context guard misconfigured.');
    return;
  }
  if (ctx.role !== 'tenant_admin') {
    respond(
      res,
      403,
      'INSUFFICIENT_TENANT_ROLE',
      'This action requires tenant_admin of this tenant.',
      { tenantId: ctx.tenantId, currentRole: ctx.role, requiredRole: 'tenant_admin' },
    );
    return;
  }
  next();
}

/**
 * Require the caller to NOT be a mere viewer. Use on any mutation
 * under /workspace/* that a read-only viewer shouldn't perform.
 */
export function requireTenantWrite(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ctx = (req as TenantContextRequest).tenantContext;
  if (!ctx) {
    respond(res, 500, 'INTERNAL', 'Tenant-context guard misconfigured.');
    return;
  }
  if (ctx.role === 'tenant_viewer') {
    respond(
      res,
      403,
      'INSUFFICIENT_TENANT_ROLE',
      'This action requires write access; your role is tenant_viewer.',
      { tenantId: ctx.tenantId, currentRole: ctx.role },
    );
    return;
  }
  next();
}

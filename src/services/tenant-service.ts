// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tenant service — the SINGLE point where "who is this user in which
 * tenant with which role?" is answered.
 *
 * Introduced by the portal owner/workspace redesign (2026-04-22). See
 * `docs/portal/nexus-hub-portal-owner-workspace-redesign.md` for the
 * architectural context.
 *
 * ## Model
 *
 * - Every pre-existing user is their own solo tenant after migration
 *   076's backfill. tenant.id == users.id, slug == `user-<id>`,
 *   membership role == `tenant_admin`.
 * - Future: a user can belong to multiple tenants. The workspace
 *   surface will expose a tenant switcher reading from
 *   `listTenantsForUser`.
 * - Platform-level roles (`platform_owner` | `platform_admin` |
 *   `platform_readonly`) live in a SEPARATE table and are queried via
 *   `getPlatformRole` / `isPlatformAdmin`. They are orthogonal to
 *   tenant membership — you can be a platform_owner without any
 *   tenant memberships, and a tenant_admin without any platform role.
 *
 * ## Fail-closed posture
 *
 * Every assertion throws `TenantError` with a stable `code`. Callers
 * are expected to convert to an HTTP response in the middleware layer.
 * A DB error during a membership lookup is treated as "not a member"
 * (fail closed) — the same posture as the hardening pass took with
 * `user-skill-access` on 2026-04-21.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

// ── Types ──────────────────────────────────────────────────────────

export type TenantStatus = 'active' | 'suspended' | 'archived' | 'trial';
export type TenantPlan = 'free' | 'pro' | 'max' | 'owner' | 'beta';
export type TenantRole = 'tenant_admin' | 'tenant_member' | 'tenant_viewer';
export type PlatformRole = 'platform_owner' | 'platform_admin' | 'platform_readonly';

export interface TenantRow {
  id: number;
  slug: string;
  displayName: string;
  status: TenantStatus;
  plan: TenantPlan;
  createdAt: string;
  createdBy: number | null;
  metadata: Record<string, unknown>;
}

export interface MembershipRow {
  tenantId: number;
  userId: number;
  role: TenantRole;
  joinedAt: string;
  invitedBy: number | null;
}

export interface TenantSummary {
  tenant: TenantRow;
  role: TenantRole;
  joinedAt: string;
}

// ── Errors ─────────────────────────────────────────────────────────

export type TenantErrorCode =
  | 'TENANT_NOT_FOUND'
  | 'NOT_A_MEMBER'
  | 'INSUFFICIENT_TENANT_ROLE'
  | 'NOT_A_PLATFORM_ADMIN'
  | 'INSUFFICIENT_PLATFORM_ROLE'
  | 'DB_ERROR';

export class TenantError extends Error {
  readonly code: TenantErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: TenantErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TenantError';
    this.code = code;
    this.details = details;
  }
}

// ── Row mapping ────────────────────────────────────────────────────

interface RawTenantRow {
  id: number;
  slug: string;
  display_name: string;
  status: string;
  plan: string;
  created_at: string;
  created_by: number | null;
  metadata_json: string;
}

function mapTenant(row: RawTenantRow): TenantRow {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed metadata shouldn't kill the tenant lookup. Leave empty.
  }
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    status: (row.status as TenantStatus) || 'active',
    plan: (row.plan as TenantPlan) || 'free',
    createdAt: row.created_at,
    createdBy: row.created_by,
    metadata,
  };
}

// ── Tenant reads ───────────────────────────────────────────────────

/**
 * Get a tenant by its numeric id. Returns null when not found — the
 * caller decides whether absence is a 404 or a silent fallback.
 */
export function getTenantById(tenantId: number): TenantRow | null {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return null;
  try {
    const db = getDb();
    const row = db
      .prepare(
        'SELECT id, slug, display_name, status, plan, created_at, created_by, metadata_json FROM tenants WHERE id = ?',
      )
      .get(tenantId) as RawTenantRow | undefined;
    return row ? mapTenant(row) : null;
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-service: getTenantById failed');
    return null;
  }
}

/**
 * Get a tenant by its url-safe slug (e.g. `user-42`).
 */
export function getTenantBySlug(slug: string): TenantRow | null {
  if (typeof slug !== 'string' || slug.length === 0) return null;
  try {
    const db = getDb();
    const row = db
      .prepare(
        'SELECT id, slug, display_name, status, plan, created_at, created_by, metadata_json FROM tenants WHERE slug = ?',
      )
      .get(slug) as RawTenantRow | undefined;
    return row ? mapTenant(row) : null;
  } catch (err) {
    logger.error({ err, slug }, 'tenant-service: getTenantBySlug failed');
    return null;
  }
}

/**
 * List all tenants. Used by the /owner/tenants endpoint.
 *
 * Pagination is deliberate — the control plane is NOT supposed to
 * scroll an unbounded list on every page load. The optional
 * `statusFilter` parameter supports the "show only suspended / active"
 * filters documented in the redesign note.
 */
export function listAllTenants(
  opts: { limit?: number; offset?: number; statusFilter?: TenantStatus } = {},
): TenantRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  try {
    const db = getDb();
    const rows = opts.statusFilter
      ? (db
          .prepare(
            'SELECT id, slug, display_name, status, plan, created_at, created_by, metadata_json FROM tenants WHERE status = ? ORDER BY id ASC LIMIT ? OFFSET ?',
          )
          .all(opts.statusFilter, limit, offset) as RawTenantRow[])
      : (db
          .prepare(
            'SELECT id, slug, display_name, status, plan, created_at, created_by, metadata_json FROM tenants ORDER BY id ASC LIMIT ? OFFSET ?',
          )
          .all(limit, offset) as RawTenantRow[]);
    return rows.map(mapTenant);
  } catch (err) {
    logger.error({ err }, 'tenant-service: listAllTenants failed');
    return [];
  }
}

export function countAllTenants(): number {
  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as c FROM tenants').get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch (err) {
    logger.error({ err }, 'tenant-service: countAllTenants failed');
    return 0;
  }
}

// ── Membership reads ───────────────────────────────────────────────

/**
 * List the tenants a user is a member of, with the user's role in
 * each. Used by `/workspace/tenants` (tenant switcher) and by the
 * /owner drill-in on a specific user.
 */
export function listTenantsForUser(userId: number): TenantSummary[] {
  if (!Number.isFinite(userId) || userId <= 0) return [];
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT t.id, t.slug, t.display_name, t.status, t.plan, t.created_at, t.created_by, t.metadata_json,
                m.role, m.joined_at
         FROM tenant_members m
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = ?
         ORDER BY m.joined_at ASC`,
      )
      .all(userId) as Array<RawTenantRow & { role: TenantRole; joined_at: string }>;
    return rows.map((row) => ({
      tenant: mapTenant(row),
      role: row.role,
      joinedAt: row.joined_at,
    }));
  } catch (err) {
    logger.error({ err, userId }, 'tenant-service: listTenantsForUser failed');
    return [];
  }
}

/**
 * Look up a single membership row — the "is this user in this tenant
 * with what role?" question. Returns null if the user is not a
 * member; this is the building block for `assertMembership`.
 */
export function getMembership(tenantId: number, userId: number): MembershipRow | null {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return null;
  if (!Number.isFinite(userId) || userId <= 0) return null;
  try {
    const db = getDb();
    const row = db
      .prepare(
        'SELECT tenant_id, user_id, role, joined_at, invited_by FROM tenant_members WHERE tenant_id = ? AND user_id = ?',
      )
      .get(tenantId, userId) as
      | { tenant_id: number; user_id: number; role: TenantRole; joined_at: string; invited_by: number | null }
      | undefined;
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role,
      joinedAt: row.joined_at,
      invitedBy: row.invited_by,
    };
  } catch (err) {
    logger.error({ err, tenantId, userId }, 'tenant-service: getMembership failed');
    return null;
  }
}

/**
 * List every member of a tenant. Used by the tenant-admin side
 * (`/workspace/members`) and the platform-owner side
 * (`/owner/tenants/:id/members`).
 */
export function listMembersOfTenant(tenantId: number): MembershipRow[] {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return [];
  try {
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT tenant_id, user_id, role, joined_at, invited_by FROM tenant_members WHERE tenant_id = ? ORDER BY joined_at ASC',
      )
      .all(tenantId) as Array<{
        tenant_id: number;
        user_id: number;
        role: TenantRole;
        joined_at: string;
        invited_by: number | null;
      }>;
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role,
      joinedAt: row.joined_at,
      invitedBy: row.invited_by,
    }));
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-service: listMembersOfTenant failed');
    return [];
  }
}

// ── Platform admin reads ───────────────────────────────────────────

/**
 * Returns the platform role for a user, or null if they have none.
 * This is the single check that gates /owner/* access.
 */
export function getPlatformRole(userId: number): PlatformRole | null {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  try {
    const db = getDb();
    const row = db.prepare('SELECT role FROM platform_admins WHERE user_id = ?').get(userId) as
      | { role: PlatformRole }
      | undefined;
    return row?.role ?? null;
  } catch (err) {
    logger.error({ err, userId }, 'tenant-service: getPlatformRole failed');
    return null;
  }
}

export function isPlatformAdmin(userId: number): boolean {
  return getPlatformRole(userId) !== null;
}

export function isPlatformOwner(userId: number): boolean {
  return getPlatformRole(userId) === 'platform_owner';
}

export function listPlatformAdmins(): Array<{ userId: number; role: PlatformRole; grantedAt: string }> {
  try {
    const db = getDb();
    const rows = db
      .prepare('SELECT user_id, role, granted_at FROM platform_admins ORDER BY granted_at ASC')
      .all() as Array<{ user_id: number; role: PlatformRole; granted_at: string }>;
    return rows.map((row) => ({ userId: row.user_id, role: row.role, grantedAt: row.granted_at }));
  } catch (err) {
    logger.error({ err }, 'tenant-service: listPlatformAdmins failed');
    return [];
  }
}

// ── Assertions (throwing variants for middleware) ──────────────────

/**
 * Throws a TenantError if the user is NOT a member of the tenant.
 * Returns the membership row on success so the caller can inspect
 * the role without a second query.
 */
export function assertMembership(tenantId: number, userId: number): MembershipRow {
  const membership = getMembership(tenantId, userId);
  if (!membership) {
    throw new TenantError('NOT_A_MEMBER', `User ${userId} is not a member of tenant ${tenantId}`, {
      tenantId,
      userId,
    });
  }
  return membership;
}

/**
 * Throws unless the user is a tenant_admin of the given tenant.
 * Returns the membership row on success.
 */
export function assertTenantAdmin(tenantId: number, userId: number): MembershipRow {
  const membership = assertMembership(tenantId, userId);
  if (membership.role !== 'tenant_admin') {
    throw new TenantError(
      'INSUFFICIENT_TENANT_ROLE',
      `User ${userId} is not a tenant_admin of tenant ${tenantId}`,
      { tenantId, userId, role: membership.role, requiredRole: 'tenant_admin' },
    );
  }
  return membership;
}

/**
 * Throws unless the user holds ANY platform role.
 */
export function assertPlatformAdmin(userId: number): PlatformRole {
  const role = getPlatformRole(userId);
  if (!role) {
    throw new TenantError('NOT_A_PLATFORM_ADMIN', `User ${userId} is not a platform admin`, {
      userId,
    });
  }
  return role;
}

/**
 * Throws unless the user is the platform_owner. Used for the
 * destructive operations: grant/revoke platform admin, delete tenant,
 * transfer ownership.
 */
export function assertPlatformOwner(userId: number): void {
  const role = getPlatformRole(userId);
  if (role !== 'platform_owner') {
    throw new TenantError(
      'INSUFFICIENT_PLATFORM_ROLE',
      `User ${userId} is not a platform_owner (has role=${role ?? 'none'})`,
      { userId, role, requiredRole: 'platform_owner' },
    );
  }
}

// ── Solo-tenant helpers (migration 076 backfill) ───────────────────

/**
 * For a user that exists as their own solo tenant (the default
 * post-migration-076 state), this returns the tenant id.
 *
 * The contract after migration 076 is: tenant.id == users.id for
 * every pre-existing user. If the caller passes a userId that does
 * NOT have a matching tenant row (shouldn't happen after backfill,
 * but possible for users created between migration-run and service-
 * boot), we return null so the caller can decide whether to auto-
 * provision or error.
 */
export function resolveSoloTenantId(userId: number): number | null {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const tenant = getTenantById(userId);
  return tenant ? tenant.id : null;
}

/**
 * Best-effort provisioning of a solo tenant for a user that was
 * created AFTER migration 076 ran. Called on the hot path of the
 * workspace guard so a brand-new user doesn't 500 on their first
 * request.
 *
 * Idempotent — uses INSERT OR IGNORE; safe to call multiple times.
 * Returns the tenant id on success, null on DB failure.
 */
export function ensureSoloTenantFor(userId: number, fallbackName?: string): number | null {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  try {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM tenants WHERE id = ?').get(userId) as { id: number } | undefined;
    if (existing) return existing.id;

    const user = db
      .prepare('SELECT email, username, tier, created_at FROM users WHERE id = ?')
      .get(userId) as { email: string | null; username: string | null; tier: string | null; created_at: string | null } | undefined;

    const plan: TenantPlan = ((): TenantPlan => {
      const t = user?.tier;
      if (t === 'pro' || t === 'max' || t === 'owner' || t === 'beta') return t;
      return 'free';
    })();

    const displayName =
      fallbackName ||
      (user?.email && user.email.length > 0 ? user.email : undefined) ||
      (user?.username && user.username.length > 0 ? user.username : undefined) ||
      `Tenant ${userId}`;

    db.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, display_name, plan, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      `user-${userId}`,
      displayName,
      plan,
      user?.created_at ?? new Date().toISOString(),
      userId,
    );

    db.prepare(
      `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role, joined_at)
       VALUES (?, ?, 'tenant_admin', ?)`,
    ).run(userId, userId, user?.created_at ?? new Date().toISOString());

    return userId;
  } catch (err) {
    logger.error({ err, userId }, 'tenant-service: ensureSoloTenantFor failed');
    return null;
  }
}

// ── Member removal (Phase 2D) ─────────────────────────────────────

/**
 * Error codes raised by `removeMember`. The HTTP layer maps:
 *   NOT_A_MEMBER            → 404 (target was never in the tenant)
 *   CANNOT_REMOVE_SELF      → 400 (use a different admin, or leave-tenant flow)
 *   CANNOT_REMOVE_LAST_ADMIN → 409 (tenant would be orphaned)
 *   DB_ERROR                → 500
 */
export type RemoveMemberErrorCode =
  | 'NOT_A_MEMBER'
  | 'CANNOT_REMOVE_SELF'
  | 'CANNOT_REMOVE_LAST_ADMIN'
  | 'DB_ERROR';

export class RemoveMemberError extends Error {
  readonly code: RemoveMemberErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: RemoveMemberErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RemoveMemberError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Count the number of tenant_admin members in a tenant. Used by
 * `removeMember` to enforce "cannot remove the last admin" — if this
 * returns 1 and the target is a tenant_admin, the removal is refused.
 */
export function countTenantAdmins(tenantId: number): number {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM tenant_members
         WHERE tenant_id = ? AND role = 'tenant_admin'`,
      )
      .get(tenantId) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-service: countTenantAdmins failed');
    return 0;
  }
}

/**
 * Remove a user from a tenant. Enforces three business rules:
 *
 *   1. `target` must actually be a member (else NOT_A_MEMBER / 404).
 *   2. `actor` cannot remove themselves through this endpoint
 *      (CANNOT_REMOVE_SELF / 400). Rationale: if the actor is the
 *      last admin, self-removal orphans the tenant; if they aren't
 *      the last, another admin should remove them. Either way this
 *      is an ambiguous action we refuse.
 *   3. If the target is a `tenant_admin` AND they're the last one,
 *      removal is refused (CANNOT_REMOVE_LAST_ADMIN / 409). The
 *      caller must either promote another member to admin first or
 *      delete the tenant entirely.
 *
 * Authorship preservation: rows in tenant_books / tenant_content_notes /
 * tenant_links that the removed user created are NOT deleted. Their
 * `created_by` column retains the userId. The ex-member can no longer
 * mutate those rows (membership guard blocks re-entry), but the
 * remaining members see them as "created by <removed user>".
 *
 * The caller is expected to have already passed the workspace guard
 * (so actor is a tenant_admin of the tenant). This service re-checks
 * the role-agnostic invariants (membership, self-removal, last admin)
 * so a bypassed route can't silently orphan a tenant.
 */
export function removeMember(
  tenantId: number,
  targetUserId: number,
  actor: { userId: number; role: TenantRole },
): MembershipRow {
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    throw new RemoveMemberError('NOT_A_MEMBER', 'Invalid tenant id', { tenantId });
  }
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    throw new RemoveMemberError('NOT_A_MEMBER', 'Invalid user id', { targetUserId });
  }

  // Rule 2: self-removal refused at this endpoint.
  if (targetUserId === actor.userId) {
    throw new RemoveMemberError(
      'CANNOT_REMOVE_SELF',
      'You cannot remove yourself through this endpoint. Ask another tenant_admin to remove you, or delete the tenant if you\'re the last admin.',
      { userId: targetUserId },
    );
  }

  // Rule 1: target must actually be a member.
  const existing = getMembership(tenantId, targetUserId);
  if (!existing) {
    throw new RemoveMemberError('NOT_A_MEMBER', 'That user is not a member of this tenant', {
      tenantId,
      userId: targetUserId,
    });
  }

  // Rule 3: last-admin protection. Count admins AFTER hypothetically
  // removing this one. If the target is an admin and they're the
  // only one, refuse.
  if (existing.role === 'tenant_admin') {
    const adminCount = countTenantAdmins(tenantId);
    if (adminCount <= 1) {
      throw new RemoveMemberError(
        'CANNOT_REMOVE_LAST_ADMIN',
        'Cannot remove the last tenant_admin. Promote another member first, or archive the tenant.',
        { tenantId, userId: targetUserId, adminCount },
      );
    }
  }

  try {
    const db = getDb();
    db.prepare(
      'DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?',
    ).run(tenantId, targetUserId);
  } catch (err) {
    logger.error({ err, tenantId, targetUserId }, 'tenant-service: removeMember failed');
    throw new RemoveMemberError('DB_ERROR', 'Failed to remove member');
  }

  return existing; // the row AS IT WAS before removal, for the caller
}

// ─── OI-ADM-302: tenant suspend / activate ───────────────────────────
// (TenantStatus is declared at the top of this file.)

export class SetTenantStatusError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'SetTenantStatusError';
  }
}

/**
 * Transition a tenant between lifecycle statuses. The CHECK
 * constraint on `tenants.status` is the authoritative allow-list
 * — we pre-validate here to return a nicer error shape than a
 * raw SQLite constraint violation.
 *
 * Idempotent: setting a tenant's status to its current value is a
 * no-op and still returns the row (no error, no audit). Callers
 * depending on "was this an actual transition?" should compare the
 * returned row's status against the requested value BEFORE calling.
 *
 * Cascade is deliberately MINIMAL here:
 *   - The tenant-context-guard in src/api/tenant-context-guard.ts
 *     already rejects workspace-router calls with TENANT_SUSPENDED
 *     when status === 'suspended' (landed before this commit).
 *   - `acceptInvite` in tenant-invite-service.ts rejects accepts
 *     into non-active tenants (see OI-ADM-302 companion edit).
 *   - Scheduled-job pause/resume is tracked separately as
 *     OI-ADM-302b — requires a scheduler refactor, not a
 *     tenant-service concern.
 *   - Existing iOS sessions (JWTs) stay valid until natural expiry
 *     but every tenant-scoped API call 403s via the guard.
 */
export function setTenantStatus(
  tenantId: number,
  status: TenantStatus,
  actorUserId: number,
  reason: string | null = null,
): TenantRow {
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    throw new SetTenantStatusError('INVALID_TENANT_ID', 'tenantId must be a positive integer');
  }
  const allowed: readonly TenantStatus[] = ['active', 'suspended', 'archived', 'trial'];
  if (!(allowed as readonly string[]).includes(status)) {
    throw new SetTenantStatusError(
      'INVALID_STATUS',
      `status must be one of ${allowed.join(' | ')}`,
      { status },
    );
  }
  const tenant = getTenantById(tenantId);
  if (!tenant) {
    throw new SetTenantStatusError('TENANT_NOT_FOUND', 'No tenant with that id', { tenantId });
  }
  try {
    getDb()
      .prepare('UPDATE tenants SET status = ? WHERE id = ?')
      .run(status, tenantId);
  } catch (err) {
    logger.error({ err, tenantId, status, actorUserId, reason }, 'tenant-service: setTenantStatus failed');
    throw new SetTenantStatusError('DB_ERROR', 'Failed to update tenant status');
  }
  const updated = getTenantById(tenantId);
  if (!updated) {
    // Should be unreachable — we just updated it.
    throw new SetTenantStatusError('DB_ERROR', 'Tenant vanished after update', { tenantId });
  }
  return updated;
}

/** Convenience: move tenant to `suspended` via setTenantStatus. */
export function suspendTenant(
  tenantId: number,
  actorUserId: number,
  reason: string | null = null,
): TenantRow {
  return setTenantStatus(tenantId, 'suspended', actorUserId, reason);
}

/** Convenience: move tenant to `active` via setTenantStatus. */
export function activateTenant(tenantId: number, actorUserId: number): TenantRow {
  return setTenantStatus(tenantId, 'active', actorUserId, null);
}

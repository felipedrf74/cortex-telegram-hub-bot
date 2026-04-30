// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';

export type CookingVisibilityScope =
  | 'user_private'
  | 'tenant_shared'
  | 'tenant_admin_visible'
  | 'platform_internal';

export type CookingScopeStatus = 'active' | 'quarantined' | 'archived' | 'deleted';

export interface CookingScopeInsert {
  tenantId: number;
  ownerUserId: number;
  visibilityScope: CookingVisibilityScope;
  lifecycleState: string;
  scopeStatus: CookingScopeStatus;
  createdBy: number;
  updatedBy: number;
  auditMetadataJson: string;
}

const cookingScopedTables = ['recipes', 'meal_plans', 'shopping_lists'] as const;
const ensured = new WeakSet<object>();

export function resolveCookingTenantId(userId: number, tenantId?: number | null): number {
  return Number.isFinite(tenantId) && Number(tenantId) > 0
    ? Number(tenantId)
    : userId;
}

export function cookingScopeForInsert(
  userId: number,
  tenantId?: number | null,
  visibilityScope: CookingVisibilityScope = 'user_private',
  lifecycleState = 'active',
): CookingScopeInsert {
  return {
    tenantId: resolveCookingTenantId(userId, tenantId),
    ownerUserId: userId,
    visibilityScope,
    lifecycleState,
    scopeStatus: 'active',
    createdBy: userId,
    updatedBy: userId,
    auditMetadataJson: '{}',
  };
}

export function cookingPrivateScopePredicate(alias?: string): string {
  const c = (name: string) => alias ? `${alias}.${name}` : name;
  return `(
    COALESCE(${c('scope_status')}, 'active') = 'active'
    AND COALESCE(${c('visibility_scope')}, 'user_private') = 'user_private'
    AND COALESCE(${c('tenant_id')}, ${c('user_id')}) = ?
    AND COALESCE(${c('owner_user_id')}, ${c('user_id')}) = ?
  )`;
}

export function cookingScopeParams(userId: number, tenantId?: number | null): [number, number] {
  return [resolveCookingTenantId(userId, tenantId), userId];
}

export function ensureCookingTenantScopeColumns(db: any = getDb()): void {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') return;
  if (ensured.has(db as object)) return;

  for (const table of cookingScopedTables) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, 'tenant_id', 'INTEGER');
    ensureColumn(db, table, 'owner_user_id', 'INTEGER');
    ensureColumn(db, table, 'visibility_scope', "TEXT DEFAULT 'user_private'");
    ensureColumn(db, table, 'lifecycle_state', "TEXT DEFAULT 'active'");
    ensureColumn(db, table, 'scope_status', "TEXT DEFAULT 'active'");
    ensureColumn(db, table, 'created_by', 'INTEGER');
    ensureColumn(db, table, 'updated_by', 'INTEGER');
    ensureColumn(db, table, 'audit_metadata_json', "TEXT DEFAULT '{}'");
    backfillTable(db, table);
  }

  ensured.add(db as object);
}

function tableExists(db: any, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { name: string } | undefined;
  return Boolean(row);
}

function columnExists(db: any, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function ensureColumn(db: any, table: string, column: string, definition: string): void {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillTable(db: any, table: string): void {
  const defaultLifecycle = table === 'meal_plans'
    ? 'planned'
    : table === 'shopping_lists'
      ? 'active'
      : 'active';

  db.prepare(`
    UPDATE ${table}
    SET
      tenant_id = COALESCE(NULLIF(tenant_id, 0), user_id),
      owner_user_id = COALESCE(NULLIF(owner_user_id, 0), user_id),
      visibility_scope = COALESCE(NULLIF(visibility_scope, ''), 'user_private'),
      lifecycle_state = COALESCE(NULLIF(lifecycle_state, ''), ?),
      scope_status = COALESCE(NULLIF(scope_status, ''), CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END),
      created_by = COALESCE(NULLIF(created_by, 0), user_id),
      updated_by = COALESCE(NULLIF(updated_by, 0), user_id),
      audit_metadata_json = COALESCE(NULLIF(audit_metadata_json, ''), '{}')
  `).run(defaultLifecycle);
}

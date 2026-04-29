// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';

export type ContentVisibilityScope =
  | 'user_private'
  | 'tenant_shared'
  | 'tenant_admin_visible'
  | 'platform_internal'
  | 'public_published';

export type ContentScopeStatus = 'active' | 'quarantined' | 'archived' | 'deleted';

export interface ContentScopeContext {
  userId: number;
  tenantId?: number | null;
}

export interface ContentScopeInsert {
  tenantId: number;
  ownerUserId: number;
  visibilityScope: ContentVisibilityScope;
  lifecycleState: string;
  scopeStatus: ContentScopeStatus;
  createdBy: number;
  updatedBy: number;
  auditMetadataJson: string;
}

export interface ContentScopedRow {
  tenant_id?: number | null;
  owner_user_id?: number | null;
  visibility_scope?: string | null;
  scope_status?: string | null;
  user_id?: number | null;
  owner_scope?: string | null;
}

const scopedTables = [
  'book_library',
  'content_ref_channels',
  'content_patterns',
  'content_knowledge',
  'content_reference_links',
  'content_scripts',
  'content_performance',
  'content_learned_patterns',
  'content_radar_preferences',
  'content_topics',
  'content_topic_feedback',
  'content_pipeline',
  'saved_ideas',
  'content_notifications',
  'content_research_briefs',
  'content_search_cache',
  'content_search_results',
  'content_trending_topics',
  'video_transcripts',
  'video_studies',
  'content_ideas',
];

const ensured = new WeakSet<object>();

export function resolveContentTenantId(userId: number, tenantId?: number | null): number {
  return Number.isFinite(tenantId) && Number(tenantId) > 0
    ? Number(tenantId)
    : userId;
}

export function contentScopeForInsert(
  userId: number,
  tenantId?: number | null,
  visibilityScope: ContentVisibilityScope = 'user_private',
  lifecycleState = 'active',
): ContentScopeInsert {
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  return {
    tenantId: resolvedTenantId,
    ownerUserId: userId,
    visibilityScope,
    lifecycleState,
    scopeStatus: 'active',
    createdBy: userId,
    updatedBy: userId,
    auditMetadataJson: '{}',
  };
}

export function ensureContentTenantScopeColumns(db: any = getDb()): void {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') return;
  if (ensured.has(db as unknown as object)) return;
  for (const table of scopedTables) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, 'tenant_id', 'INTEGER');
    ensureColumn(db, table, 'owner_user_id', 'INTEGER');
    ensureColumn(db, table, 'visibility_scope', 'TEXT');
    ensureColumn(db, table, 'lifecycle_state', 'TEXT');
    ensureColumn(db, table, 'scope_status', 'TEXT');
    ensureColumn(db, table, 'created_by', 'INTEGER');
    ensureColumn(db, table, 'updated_by', 'INTEGER');
    ensureColumn(db, table, 'audit_metadata_json', "TEXT DEFAULT '{}'");
    backfillTable(db, table);
  }

  if (!tableExists(db, 'content_reference_links')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_reference_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        tenant_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        visibility_scope TEXT NOT NULL DEFAULT 'user_private',
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        scope_status TEXT NOT NULL DEFAULT 'active',
        url TEXT NOT NULL,
        title TEXT,
        source_type TEXT NOT NULL DEFAULT 'link',
        extraction_status TEXT NOT NULL DEFAULT 'pending',
        source_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by INTEGER NOT NULL,
        updated_by INTEGER NOT NULL,
        audit_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, owner_user_id, url)
      );
      CREATE INDEX IF NOT EXISTS idx_content_reference_links_tenant_scope
        ON content_reference_links(tenant_id, owner_user_id, visibility_scope, scope_status);
    `);
  }
  ensured.add(db as unknown as object);
}

export function contentScopePredicate(alias?: string): string {
  const c = (name: string) => alias ? `${alias}.${name}` : name;
  const tenantExpr = `COALESCE(${c('tenant_id')}, CASE WHEN ${c('user_id')} > 0 THEN ${c('user_id')} ELSE 0 END)`;
  const ownerExpr = `COALESCE(${c('owner_user_id')}, ${c('user_id')}, 0)`;
  const visibilityExpr = `COALESCE(${c('visibility_scope')}, CASE WHEN ${c('user_id')} > 0 THEN 'user_private' ELSE 'platform_internal' END)`;
  const statusExpr = `COALESCE(${c('scope_status')}, CASE WHEN ${c('user_id')} > 0 THEN 'active' ELSE 'quarantined' END)`;

  return `(
    ${statusExpr} = 'active'
    AND (
      (${visibilityExpr} = 'user_private' AND ${tenantExpr} = ? AND ${ownerExpr} = ?)
      OR (${visibilityExpr} IN ('tenant_shared', 'public_published') AND ${tenantExpr} = ?)
    )
  )`;
}

export function contentDirectScopePredicate(alias?: string): string {
  const c = (name: string) => alias ? `${alias}.${name}` : name;
  return `(
    ${c('scope_status')} = 'active'
    AND (
      (${c('visibility_scope')} = 'user_private' AND ${c('tenant_id')} = ? AND ${c('owner_user_id')} = ?)
      OR (${c('visibility_scope')} IN ('tenant_shared', 'public_published') AND ${c('tenant_id')} = ?)
    )
  )`;
}

export function platformContentScopePredicate(alias?: string): string {
  const c = (name: string) => alias ? `${alias}.${name}` : name;
  const tenantExpr = `COALESCE(${c('tenant_id')}, 0)`;
  const ownerExpr = `COALESCE(${c('owner_user_id')}, ${c('user_id')}, 0)`;
  const visibilityExpr = `COALESCE(${c('visibility_scope')}, 'platform_internal')`;
  const statusExpr = `COALESCE(${c('scope_status')}, 'quarantined')`;

  return `(
    ${statusExpr} = 'active'
    AND ${visibilityExpr} IN ('platform_internal', 'public_published')
    AND ${tenantExpr} = 0
    AND ${ownerExpr} = 0
  )`;
}

export function platformOrSystemSeedContentScopePredicate(alias?: string): string {
  const c = (name: string) => alias ? `${alias}.${name}` : name;
  return `(
    ${platformContentScopePredicate(alias)}
    OR (
      COALESCE(${c('owner_scope')}, '') = 'system'
      AND COALESCE(${c('user_id')}, 0) = 0
      AND COALESCE(${c('tenant_id')}, 0) = 0
      AND COALESCE(${c('owner_user_id')}, 0) = 0
      AND COALESCE(${c('visibility_scope')}, 'platform_internal') = 'platform_internal'
      AND COALESCE(${c('scope_status')}, 'active') IN ('active', 'quarantined')
    )
  )`;
}

export function contentScopeParams(userId: number, tenantId?: number | null): [number, number, number] {
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  return [resolvedTenantId, userId, resolvedTenantId];
}

export function contentScopeOrderExpr(alias?: string, userId?: number): string {
  const c = (name: string) => alias ? `${alias}.${name}` : name;
  if (userId == null) return '0';
  return `CASE WHEN COALESCE(${c('owner_user_id')}, ${c('user_id')}, 0) = ${Number(userId)} THEN 0 ELSE 1 END`;
}

export function isAuthorizedContentRow(
  row: ContentScopedRow | null | undefined,
  context: ContentScopeContext,
): boolean {
  if (!row) return false;
  const tenantId = resolveContentTenantId(context.userId, context.tenantId);
  const effectiveTenant = row.tenant_id ?? (row.user_id && row.user_id > 0 ? row.user_id : 0);
  const effectiveOwner = row.owner_user_id ?? row.user_id ?? 0;
  const visibility = row.visibility_scope ?? (row.user_id && row.user_id > 0 ? 'user_private' : 'platform_internal');
  const status = row.scope_status ?? (row.user_id && row.user_id > 0 ? 'active' : 'quarantined');
  if (status !== 'active') return false;
  if (visibility === 'user_private') return effectiveTenant === tenantId && effectiveOwner === context.userId;
  if (visibility === 'tenant_shared' || visibility === 'public_published') return effectiveTenant === tenantId;
  return false;
}

export function isAmbiguousLegacyContentRow(row: ContentScopedRow | null | undefined): boolean {
  if (!row) return true;
  const status = row.scope_status ?? (row.user_id && row.user_id > 0 ? 'active' : 'quarantined');
  const tenant = row.tenant_id ?? (row.user_id && row.user_id > 0 ? row.user_id : 0);
  return status === 'quarantined' || tenant <= 0;
}

function tableExists(db: any, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

function ensureColumn(db: any, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillTable(db: any, table: string): void {
  const hasUserId = hasColumn(db, table, 'user_id');
  const userExpr = hasUserId ? 'user_id' : '0';
  db.prepare(`
    UPDATE ${table}
       SET tenant_id = COALESCE(tenant_id, CASE WHEN ${userExpr} > 0 THEN ${userExpr} ELSE 0 END),
           owner_user_id = COALESCE(owner_user_id, CASE WHEN ${userExpr} > 0 THEN ${userExpr} ELSE 0 END),
           visibility_scope = COALESCE(visibility_scope, CASE WHEN ${userExpr} > 0 THEN 'user_private' ELSE 'platform_internal' END),
           lifecycle_state = COALESCE(lifecycle_state, 'active'),
           scope_status = COALESCE(scope_status, CASE WHEN ${userExpr} > 0 THEN 'active' ELSE 'quarantined' END),
           created_by = COALESCE(created_by, CASE WHEN ${userExpr} > 0 THEN ${userExpr} ELSE 0 END),
           updated_by = COALESCE(updated_by, CASE WHEN ${userExpr} > 0 THEN ${userExpr} ELSE 0 END),
           audit_metadata_json = COALESCE(audit_metadata_json, '{}')
     WHERE tenant_id IS NULL OR owner_user_id IS NULL OR visibility_scope IS NULL OR scope_status IS NULL
  `).run();
}

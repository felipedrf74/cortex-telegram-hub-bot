// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import {
  contentDirectScopePredicate,
  contentScopeForInsert,
  contentScopeParams,
  resolveContentTenantId,
  type ContentVisibilityScope,
} from './content-tenant-scope';
import {
  CONTENT_EXTRACTION_STATUSES,
  CONTENT_SOURCE_TYPES,
  CONTENT_TRUST_LEVELS,
  type ContentExtractionStatus,
  type ContentObjectType,
  type ContentSourceType,
  type ContentTrustLevel,
} from './content-domain-ontology';

export type ContentBrokenStatus = 'ok' | 'unknown' | 'broken';
export type ContentStaleStatus = 'fresh' | 'unknown' | 'stale';
export type ContentGroundingStatus = 'grounded' | 'partially_grounded' | 'ungrounded' | 'no_claims';

export interface ContentReferenceRegistryInput {
  userId: number;
  tenantId?: number;
  visibilityScope?: ContentVisibilityScope;
  referenceType: ContentSourceType | string;
  sourceTable?: string | null;
  sourcePk?: string | number | null;
  sourceIdentifier: string;
  title: string;
  url?: string | null;
  authorSource?: string | null;
  extractionStatus?: ContentExtractionStatus | string;
  freshnessScore?: number;
  trustLevel?: ContentTrustLevel | string;
  qualityScore?: number;
  confidenceScore?: number;
  topicTags?: string[];
  relatedOutputIds?: string[];
  brokenStatus?: ContentBrokenStatus | string;
  staleStatus?: ContentStaleStatus | string;
  sourceSummary?: string | null;
  sourceSnippets?: string[];
  sourceMetadata?: Record<string, unknown>;
}

export interface ContentRegisteredReference {
  id: number;
  referenceId: string;
  tenantId: number;
  ownerUserId: number;
  visibilityScope: string;
  referenceType: string;
  sourceTable: string | null;
  sourcePk: string | null;
  sourceIdentifier: string;
  title: string;
  url: string | null;
  authorSource: string | null;
  extractionStatus: string;
  freshnessScore: number;
  trustLevel: string;
  qualityScore: number;
  confidenceScore: number;
  topicTags: string[];
  relatedOutputIds: string[];
  lastUsedAt: string | null;
  brokenStatus: string;
  staleStatus: string;
  sourceSummary: string | null;
  sourceSnippets: string[];
  usableForGeneration: boolean;
  reviewRequired: boolean;
  rejectionReasons: string[];
}

export interface RetrieveContentReferencesInput {
  userId: number;
  tenantId?: number;
  query?: string;
  referenceTypes?: string[];
  limit?: number;
}

export interface ContentProvenanceClaimInput {
  id: string;
  text: string;
  supportedBy?: string[];
  confidence?: number;
}

export interface ContentOutputProvenanceInput {
  userId: number;
  tenantId?: number;
  visibilityScope?: ContentVisibilityScope;
  outputObjectType: ContentObjectType | string;
  outputId: string | number;
  referencesUsed?: ContentRegisteredReference[];
  claims?: ContentProvenanceClaimInput[];
  sourceSummaries?: string[];
  generatedFromRadarSignalId?: string | number | null;
  reusedFromContentId?: string | number | null;
}

export interface ContentOutputProvenance {
  id: number;
  tenantId: number;
  ownerUserId: number;
  outputObjectType: string;
  outputId: string;
  groundingStatus: ContentGroundingStatus;
  referencesUsed: unknown[];
  claims: unknown[];
  unsupportedClaims: unknown[];
  reviewRequired: boolean;
  generatedFromRadarSignalId: string | null;
  reusedFromContentId: string | null;
}

export interface ContentSourceOutputLink {
  id: number;
  tenantId: number;
  ownerUserId: number;
  sourceType: string;
  sourceId: string;
  outputObjectType: string;
  outputId: string;
  usageType: string;
  attributionText: string | null;
  claimIds: unknown[];
  evidenceIds: unknown[];
  confidence: number;
  createdAt: string;
}

const TABLES_WITH_SOURCE_HEALTH = ['book_library', 'content_reference_links', 'content_ref_channels'] as const;

const REFERENCE_REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS content_reference_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    reference_type TEXT NOT NULL,
    source_table TEXT,
    source_pk TEXT,
    source_identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    author_source TEXT,
    extraction_status TEXT NOT NULL DEFAULT 'pending',
    freshness_score REAL NOT NULL DEFAULT 0.7,
    trust_level TEXT NOT NULL DEFAULT 'unverified',
    quality_score REAL NOT NULL DEFAULT 0.5,
    confidence_score REAL NOT NULL DEFAULT 0.5,
    topic_tags_json TEXT NOT NULL DEFAULT '[]',
    related_output_ids_json TEXT NOT NULL DEFAULT '[]',
    last_used_at TEXT,
    broken_status TEXT NOT NULL DEFAULT 'unknown',
    stale_status TEXT NOT NULL DEFAULT 'unknown',
    source_summary TEXT,
    source_snippets_json TEXT NOT NULL DEFAULT '[]',
    source_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, reference_type, source_identifier)
  );
  CREATE INDEX IF NOT EXISTS idx_content_reference_registry_scope
    ON content_reference_registry(tenant_id, owner_user_id, visibility_scope, scope_status, reference_type);
  CREATE INDEX IF NOT EXISTS idx_content_reference_registry_quality
    ON content_reference_registry(tenant_id, reference_type, extraction_status, broken_status, stale_status, trust_level);
`;

const OUTPUT_PROVENANCE_DDL = `
  CREATE TABLE IF NOT EXISTS content_output_provenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    output_object_type TEXT NOT NULL,
    output_id TEXT NOT NULL,
    grounding_status TEXT NOT NULL DEFAULT 'ungrounded',
    references_used_json TEXT NOT NULL DEFAULT '[]',
    claims_json TEXT NOT NULL DEFAULT '[]',
    unsupported_claims_json TEXT NOT NULL DEFAULT '[]',
    source_summaries_json TEXT NOT NULL DEFAULT '[]',
    generated_from_radar_signal_id TEXT,
    reused_from_content_id TEXT,
    provenance_status TEXT NOT NULL DEFAULT 'active',
    review_required INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, output_object_type, output_id)
  );
  CREATE INDEX IF NOT EXISTS idx_content_output_provenance_scope
    ON content_output_provenance(tenant_id, owner_user_id, visibility_scope, scope_status, output_object_type);
  CREATE INDEX IF NOT EXISTS idx_content_output_provenance_grounding
    ON content_output_provenance(tenant_id, grounding_status, review_required);
`;

const ensured = new WeakSet<object>();

export function ensureContentReferenceProvenanceTables(db: any = getDb()): void {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') return;
  if (ensured.has(db as object)) return;
  for (const table of TABLES_WITH_SOURCE_HEALTH) {
    if (!tableExists(db, table)) continue;
    ensureColumn(db, table, 'broken_status', "TEXT DEFAULT 'unknown'");
    ensureColumn(db, table, 'stale_status', "TEXT DEFAULT 'unknown'");
    ensureColumn(db, table, 'extraction_status', "TEXT DEFAULT 'pending'");
    ensureColumn(db, table, 'last_used_at', 'TEXT');
    ensureColumn(db, table, 'source_summary', 'TEXT');
    ensureColumn(db, table, 'source_snippets_json', "TEXT DEFAULT '[]'");
    ensureColumn(db, table, 'freshness_score', 'REAL DEFAULT 0.7');
    ensureColumn(db, table, 'quality_score', 'REAL DEFAULT 0.5');
    ensureColumn(db, table, 'trust_level', "TEXT DEFAULT 'unverified'");
    ensureColumn(db, table, 'topic_tags_json', "TEXT DEFAULT '[]'");
    ensureColumn(db, table, 'used_by_outputs_json', "TEXT DEFAULT '[]'");
  }
  db.exec(REFERENCE_REGISTRY_DDL);
  db.exec(OUTPUT_PROVENANCE_DDL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_source_output_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      output_object_type TEXT NOT NULL,
      output_id TEXT NOT NULL,
      usage_type TEXT NOT NULL DEFAULT 'inspiration',
      attribution_text TEXT,
      claim_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5,
      created_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, owner_user_id, source_type, source_id, output_object_type, output_id, usage_type)
    );
  `);
  ensured.add(db as object);
}

export function isContentReferenceUsable(input: {
  extractionStatus?: string | null;
  brokenStatus?: string | null;
  staleStatus?: string | null;
  trustLevel?: string | null;
  confidenceScore?: number | null;
  qualityScore?: number | null;
}): { usable: boolean; reviewRequired: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const extraction = input.extractionStatus || 'pending';
  const broken = input.brokenStatus || 'unknown';
  const stale = input.staleStatus || 'unknown';
  const trust = input.trustLevel || 'unverified';
  const confidence = typeof input.confidenceScore === 'number' ? input.confidenceScore : 0.5;
  const quality = typeof input.qualityScore === 'number' ? input.qualityScore : 0.5;

  if (['failed', 'quarantined'].includes(extraction)) reasons.push(`extraction_${extraction}`);
  if (broken === 'broken') reasons.push('source_broken');
  if (stale === 'stale') reasons.push('source_stale');
  if (trust === 'deprecated') reasons.push('source_deprecated');
  if (confidence < 0.25) reasons.push('confidence_too_low');
  if (quality < 0.2) reasons.push('quality_too_low');

  const reviewRequired = extraction === 'pending'
    || extraction === 'extracting'
    || extraction === 'stale'
    || broken === 'unknown'
    || stale === 'unknown'
    || trust === 'unverified'
    || confidence < 0.5
    || quality < 0.5;

  return { usable: reasons.length === 0, reviewRequired, reasons };
}

export function upsertContentReference(input: ContentReferenceRegistryInput): number {
  const db = getDb();
  ensureContentReferenceProvenanceTables(db);
  const scope = contentScopeForInsert(input.userId, input.tenantId, input.visibilityScope ?? 'user_private');
  const referenceType = normalizeReferenceType(input.referenceType);
  const extractionStatus = normalizeExtractionStatus(input.extractionStatus ?? 'pending');
  const trustLevel = normalizeTrustLevel(input.trustLevel ?? 'unverified');
  const sourceIdentifier = input.sourceIdentifier.trim();
  if (!sourceIdentifier) throw new Error('sourceIdentifier is required');
  const title = input.title.trim();
  if (!title) throw new Error('title is required');

  const result = db.prepare(`
    INSERT INTO content_reference_registry (
      tenant_id, owner_user_id, visibility_scope, scope_status, reference_type,
      source_table, source_pk, source_identifier, title, url, author_source,
      extraction_status, freshness_score, trust_level, quality_score, confidence_score,
      topic_tags_json, related_output_ids_json, broken_status, stale_status,
      source_summary, source_snippets_json, source_metadata_json,
      created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, owner_user_id, reference_type, source_identifier) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      author_source = excluded.author_source,
      extraction_status = excluded.extraction_status,
      freshness_score = excluded.freshness_score,
      trust_level = excluded.trust_level,
      quality_score = excluded.quality_score,
      confidence_score = excluded.confidence_score,
      topic_tags_json = excluded.topic_tags_json,
      related_output_ids_json = excluded.related_output_ids_json,
      broken_status = excluded.broken_status,
      stale_status = excluded.stale_status,
      source_summary = excluded.source_summary,
      source_snippets_json = excluded.source_snippets_json,
      source_metadata_json = excluded.source_metadata_json,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run(
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.scopeStatus,
    referenceType,
    input.sourceTable ?? null,
    input.sourcePk != null ? String(input.sourcePk) : null,
    sourceIdentifier,
    title,
    input.url ?? null,
    input.authorSource ?? null,
    extractionStatus,
    clamp01(input.freshnessScore ?? 0.7),
    trustLevel,
    clamp01(input.qualityScore ?? 0.5),
    clamp01(input.confidenceScore ?? 0.5),
    JSON.stringify(input.topicTags ?? []),
    JSON.stringify(input.relatedOutputIds ?? []),
    normalizeBrokenStatus(input.brokenStatus ?? 'unknown'),
    normalizeStaleStatus(input.staleStatus ?? 'unknown'),
    input.sourceSummary ?? null,
    JSON.stringify(input.sourceSnippets ?? []),
    JSON.stringify(input.sourceMetadata ?? {}),
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
  );

  if (Number(result.lastInsertRowid) > 0) return Number(result.lastInsertRowid);
  const existing = db.prepare(`
    SELECT id FROM content_reference_registry
     WHERE tenant_id = ? AND owner_user_id = ? AND reference_type = ? AND source_identifier = ?
  `).get(scope.tenantId, scope.ownerUserId, referenceType, sourceIdentifier) as { id?: number } | undefined;
  return Number(existing?.id ?? 0);
}

export function retrieveAuthorizedContentReferences(input: RetrieveContentReferencesInput): ContentRegisteredReference[] {
  const db = getDb();
  ensureContentReferenceProvenanceTables(db);
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  const types = input.referenceTypes?.map(normalizeReferenceType).filter(Boolean) ?? [];
  const params: unknown[] = [...contentScopeParams(input.userId, tenantId)];
  const typeClause = types.length > 0
    ? ` AND reference_type IN (${types.map(() => '?').join(', ')})`
    : '';
  params.push(...types);

  const query = input.query?.trim();
  const queryClause = query
    ? ' AND (LOWER(title) LIKE ? OR LOWER(COALESCE(source_summary, \'\')) LIKE ? OR LOWER(topic_tags_json) LIKE ?)'
    : '';
  if (query) {
    const like = `%${query.toLowerCase()}%`;
    params.push(like, like, like);
  }

  params.push(Math.min(Math.max(input.limit ?? 20, 1), 100));
  const rows = db.prepare(`
    SELECT *
      FROM content_reference_registry
     WHERE ${contentDirectScopePredicate()}
       ${typeClause}
       ${queryClause}
     ORDER BY
       CASE WHEN extraction_status IN ('ready', 'indexed') THEN 0 ELSE 1 END,
       CASE WHEN broken_status = 'ok' THEN 0 ELSE 1 END,
       CASE WHEN stale_status = 'fresh' THEN 0 ELSE 1 END,
       confidence_score DESC,
       quality_score DESC,
       freshness_score DESC,
       COALESCE(last_used_at, created_at) ASC
     LIMIT ?
  `).all(...params) as any[];

  return dedupeReferences(rows.map(mapReferenceRow))
    .filter((ref) => ref.usableForGeneration);
}

export function assessClaimsGrounding(
  claims: readonly ContentProvenanceClaimInput[],
  references: readonly ContentRegisteredReference[],
): {
  groundingStatus: ContentGroundingStatus;
  unsupportedClaims: ContentProvenanceClaimInput[];
  reviewRequired: boolean;
} {
  if (claims.length === 0) {
    return {
      groundingStatus: references.length > 0 ? 'no_claims' : 'ungrounded',
      unsupportedClaims: [],
      reviewRequired: false,
    };
  }
  const referenceIds = new Set(references.map((ref) => ref.referenceId));
  const unsupportedClaims = claims.filter((claim) => {
    const supportedBy = claim.supportedBy ?? [];
    return supportedBy.length === 0 || supportedBy.some((id) => !referenceIds.has(id));
  });
  const groundingStatus: ContentGroundingStatus = unsupportedClaims.length === 0
    ? 'grounded'
    : unsupportedClaims.length === claims.length
      ? 'ungrounded'
      : 'partially_grounded';
  return {
    groundingStatus,
    unsupportedClaims,
    reviewRequired: unsupportedClaims.length > 0 || references.some((ref) => ref.reviewRequired),
  };
}

export function recordContentOutputProvenance(input: ContentOutputProvenanceInput): number {
  const db = getDb();
  ensureContentReferenceProvenanceTables(db);
  const scope = contentScopeForInsert(input.userId, input.tenantId, input.visibilityScope ?? 'user_private');
  const references = dedupeReferences(input.referencesUsed ?? []);
  const claims = input.claims ?? [];
  const grounding = assessClaimsGrounding(claims, references);
  const outputObjectType = String(input.outputObjectType);
  const outputId = String(input.outputId);
  const sourceSummaries = input.sourceSummaries ?? references
    .map((ref) => ref.sourceSummary)
    .filter((summary): summary is string => Boolean(summary));

  const result = db.prepare(`
    INSERT INTO content_output_provenance (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      output_object_type, output_id, grounding_status, references_used_json,
      claims_json, unsupported_claims_json, source_summaries_json,
      generated_from_radar_signal_id, reused_from_content_id, review_required,
      created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, owner_user_id, output_object_type, output_id) DO UPDATE SET
      grounding_status = excluded.grounding_status,
      references_used_json = excluded.references_used_json,
      claims_json = excluded.claims_json,
      unsupported_claims_json = excluded.unsupported_claims_json,
      source_summaries_json = excluded.source_summaries_json,
      generated_from_radar_signal_id = excluded.generated_from_radar_signal_id,
      reused_from_content_id = excluded.reused_from_content_id,
      review_required = excluded.review_required,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run(
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.scopeStatus,
    outputObjectType,
    outputId,
    grounding.groundingStatus,
    JSON.stringify(references.map(publicReferenceForProvenance)),
    JSON.stringify(claims),
    JSON.stringify(grounding.unsupportedClaims),
    JSON.stringify(sourceSummaries),
    input.generatedFromRadarSignalId != null ? String(input.generatedFromRadarSignalId) : null,
    input.reusedFromContentId != null ? String(input.reusedFromContentId) : null,
    grounding.reviewRequired ? 1 : 0,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
  );

  for (const ref of references) {
    recordSourceOutputLink(db, scope, ref, outputObjectType, outputId, claims);
    markReferenceUsed(db, ref, outputObjectType, outputId);
  }

  if (Number(result.lastInsertRowid) > 0) return Number(result.lastInsertRowid);
  const existing = db.prepare(`
    SELECT id FROM content_output_provenance
     WHERE tenant_id = ? AND owner_user_id = ? AND output_object_type = ? AND output_id = ?
  `).get(scope.tenantId, scope.ownerUserId, outputObjectType, outputId) as { id?: number } | undefined;
  return Number(existing?.id ?? 0);
}

export function getContentOutputProvenance(
  userId: number,
  outputObjectType: string,
  outputId: string | number,
  tenantId?: number,
): ContentOutputProvenance | null {
  const db = getDb();
  ensureContentReferenceProvenanceTables(db);
  const row = db.prepare(`
    SELECT *
      FROM content_output_provenance
     WHERE output_object_type = ?
       AND output_id = ?
       AND ${contentDirectScopePredicate()}
     LIMIT 1
  `).get(
    outputObjectType,
    String(outputId),
    ...contentScopeParams(userId, tenantId),
  ) as any;
  return row ? mapProvenanceRow(row) : null;
}

export function listContentOutputProvenance(input: {
  userId: number;
  tenantId?: number;
  outputObjectType?: string;
  outputId?: string | number;
  limit?: number;
}): ContentOutputProvenance[] {
  const db = getDb();
  ensureContentReferenceProvenanceTables(db);
  const params: unknown[] = [...contentScopeParams(input.userId, input.tenantId)];
  const clauses: string[] = [];
  if (input.outputObjectType) {
    clauses.push('AND output_object_type = ?');
    params.push(String(input.outputObjectType));
  }
  if (input.outputId != null) {
    clauses.push('AND output_id = ?');
    params.push(String(input.outputId));
  }
  params.push(Math.min(Math.max(input.limit ?? 50, 1), 100));

  const rows = db.prepare(`
    SELECT *
      FROM content_output_provenance
     WHERE ${contentDirectScopePredicate()}
       ${clauses.join('\n       ')}
     ORDER BY updated_at DESC, id DESC
     LIMIT ?
  `).all(...params) as any[];
  return rows.map(mapProvenanceRow);
}

export function listContentSourceOutputLinks(input: {
  userId: number;
  tenantId?: number;
  outputObjectType?: string;
  outputId?: string | number;
  sourceId?: string | number;
  limit?: number;
}): ContentSourceOutputLink[] {
  const db = getDb();
  ensureContentReferenceProvenanceTables(db);
  const params: unknown[] = [...contentScopeParams(input.userId, input.tenantId)];
  const clauses: string[] = [];
  if (input.outputObjectType) {
    clauses.push('AND output_object_type = ?');
    params.push(String(input.outputObjectType));
  }
  if (input.outputId != null) {
    clauses.push('AND output_id = ?');
    params.push(String(input.outputId));
  }
  if (input.sourceId != null) {
    clauses.push('AND source_id = ?');
    params.push(String(input.sourceId));
  }
  params.push(Math.min(Math.max(input.limit ?? 100, 1), 200));

  const rows = db.prepare(`
    SELECT *
      FROM content_source_output_links
     WHERE ${contentDirectScopePredicate()}
       ${clauses.join('\n       ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(...params) as any[];
  return rows.map(mapSourceOutputLinkRow);
}

function recordSourceOutputLink(
  db: any,
  scope: ReturnType<typeof contentScopeForInsert>,
  ref: ContentRegisteredReference,
  outputObjectType: string,
  outputId: string,
  claims: readonly ContentProvenanceClaimInput[],
): void {
  const claimIds = claims
    .filter((claim) => claim.supportedBy?.includes(ref.referenceId))
    .map((claim) => claim.id);
  db.prepare(`
    INSERT INTO content_source_output_links (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      source_type, source_id, output_object_type, output_id,
      usage_type, attribution_text, claim_ids_json, evidence_ids_json,
      confidence, created_by, audit_metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, owner_user_id, source_type, source_id, output_object_type, output_id, usage_type)
    DO UPDATE SET
      attribution_text = excluded.attribution_text,
      claim_ids_json = excluded.claim_ids_json,
      evidence_ids_json = excluded.evidence_ids_json,
      confidence = excluded.confidence
  `).run(
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.scopeStatus,
    ref.referenceType,
    ref.referenceId,
    outputObjectType,
    outputId,
    claimIds.length > 0 ? 'evidence' : 'inspiration',
    ref.title,
    JSON.stringify(claimIds),
    JSON.stringify(ref.sourceSnippets.slice(0, 3)),
    ref.confidenceScore,
    scope.createdBy,
    scope.auditMetadataJson,
  );
}

function markReferenceUsed(
  db: any,
  ref: ContentRegisteredReference,
  outputObjectType: string,
  outputId: string,
): void {
  const related = Array.from(new Set([...ref.relatedOutputIds, `${outputObjectType}:${outputId}`])).slice(0, 50);
  db.prepare(`
    UPDATE content_reference_registry
       SET last_used_at = datetime('now'),
           related_output_ids_json = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(JSON.stringify(related), ref.id);
}

function mapReferenceRow(row: any): ContentRegisteredReference {
  const referenceId = `${row.reference_type}:${row.id}`;
  const usability = isContentReferenceUsable({
    extractionStatus: row.extraction_status,
    brokenStatus: row.broken_status,
    staleStatus: row.stale_status,
    trustLevel: row.trust_level,
    confidenceScore: row.confidence_score,
    qualityScore: row.quality_score,
  });
  return {
    id: Number(row.id),
    referenceId,
    tenantId: Number(row.tenant_id),
    ownerUserId: Number(row.owner_user_id),
    visibilityScope: row.visibility_scope,
    referenceType: row.reference_type,
    sourceTable: row.source_table ?? null,
    sourcePk: row.source_pk ?? null,
    sourceIdentifier: row.source_identifier,
    title: row.title,
    url: row.url ?? null,
    authorSource: row.author_source ?? null,
    extractionStatus: row.extraction_status,
    freshnessScore: Number(row.freshness_score ?? 0.7),
    trustLevel: row.trust_level,
    qualityScore: Number(row.quality_score ?? 0.5),
    confidenceScore: Number(row.confidence_score ?? 0.5),
    topicTags: parseJsonArray(row.topic_tags_json),
    relatedOutputIds: parseJsonArray(row.related_output_ids_json),
    lastUsedAt: row.last_used_at ?? null,
    brokenStatus: row.broken_status,
    staleStatus: row.stale_status,
    sourceSummary: row.source_summary ?? null,
    sourceSnippets: parseJsonArray(row.source_snippets_json),
    usableForGeneration: usability.usable,
    reviewRequired: usability.reviewRequired,
    rejectionReasons: usability.reasons,
  };
}

function mapProvenanceRow(row: any): ContentOutputProvenance {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    ownerUserId: Number(row.owner_user_id),
    outputObjectType: row.output_object_type,
    outputId: row.output_id,
    groundingStatus: row.grounding_status,
    referencesUsed: parseJsonArray(row.references_used_json),
    claims: parseJsonArray(row.claims_json),
    unsupportedClaims: parseJsonArray(row.unsupported_claims_json),
    reviewRequired: row.review_required === 1,
    generatedFromRadarSignalId: row.generated_from_radar_signal_id ?? null,
    reusedFromContentId: row.reused_from_content_id ?? null,
  };
}

function mapSourceOutputLinkRow(row: any): ContentSourceOutputLink {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    ownerUserId: Number(row.owner_user_id),
    sourceType: row.source_type,
    sourceId: row.source_id,
    outputObjectType: row.output_object_type,
    outputId: row.output_id,
    usageType: row.usage_type,
    attributionText: row.attribution_text ?? null,
    claimIds: parseJsonArray(row.claim_ids_json),
    evidenceIds: parseJsonArray(row.evidence_ids_json),
    confidence: Number(row.confidence ?? 0.5),
    createdAt: row.created_at,
  };
}

function publicReferenceForProvenance(ref: ContentRegisteredReference): Record<string, unknown> {
  return {
    referenceId: ref.referenceId,
    referenceType: ref.referenceType,
    sourceIdentifier: ref.sourceIdentifier,
    title: ref.title,
    url: ref.url,
    trustLevel: ref.trustLevel,
    freshnessScore: ref.freshnessScore,
    confidenceScore: ref.confidenceScore,
    sourceSummary: ref.sourceSummary,
  };
}

function dedupeReferences<T extends { referenceId: string; confidenceScore?: number; freshnessScore?: number }>(refs: T[]): T[] {
  const map = new Map<string, T>();
  for (const ref of refs) {
    const existing = map.get(ref.referenceId);
    const score = (ref.confidenceScore ?? 0) + (ref.freshnessScore ?? 0);
    const existingScore = (existing?.confidenceScore ?? 0) + (existing?.freshnessScore ?? 0);
    if (!existing || score > existingScore) map.set(ref.referenceId, ref);
  }
  return Array.from(map.values());
}

function parseJsonArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeReferenceType(value: string): string {
  return CONTENT_SOURCE_TYPES.includes(value as ContentSourceType) ? value : 'external_research_result';
}

function normalizeExtractionStatus(value: string): string {
  return CONTENT_EXTRACTION_STATUSES.includes(value as ContentExtractionStatus) ? value : 'pending';
}

function normalizeTrustLevel(value: string): string {
  return CONTENT_TRUST_LEVELS.includes(value as ContentTrustLevel) ? value : 'unverified';
}

function normalizeBrokenStatus(value: string): ContentBrokenStatus {
  return value === 'ok' || value === 'broken' || value === 'unknown' ? value : 'unknown';
}

function normalizeStaleStatus(value: string): ContentStaleStatus {
  return value === 'fresh' || value === 'stale' || value === 'unknown' ? value : 'unknown';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
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

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { isContentReferenceUsable, type ContentRegisteredReference } from './content-reference-provenance';
import type { ContentWorkspaceScope } from './content-workspace';
import {
  recordContentWorkspaceQualitySignal,
  startContentWorkspaceObservation,
} from './content-workspace-observability';
import { assertContentWorkspaceWriteEnabled } from './content-workspace-capabilities';
import {
  classifyContentClaimRisk,
  extractReviewableContentClaims,
} from './content-claim-safety';

export const CONTENT_REVISION_LINEAGE_SCHEMA_VERSION = 'content-revision-lineage-v1' as const;
export const CONTENT_WORKSPACE_SOURCE_SCHEMA_VERSION = 'content-workspace-source-v1' as const;
export const CONTENT_WORKSPACE_SOURCE_ASSESSMENT_SCHEMA_VERSION = 'content-workspace-source-assessment-v1' as const;

const WORKSPACE_SOURCE_TYPES = [
  'link',
  'note',
  'external_research_result',
  'user_uploaded_source',
  'previous_content',
] as const;

type WorkspaceSourceType = typeof WORKSPACE_SOURCE_TYPES[number];
export type ContentClaimRiskLevel = 'standard' | 'sensitive' | 'regulated';

export interface ContentWorkspaceClaimInput {
  id: string;
  text: string;
  supportedBy?: string[];
  confidence?: number;
  riskLevel?: ContentClaimRiskLevel;
}

export interface ContentClaimPolicy {
  status: 'not_recorded' | 'clear' | 'warning' | 'blocked';
  blocksApproval: boolean;
  warningCodes: string[];
  blockCodes: string[];
  unsupportedClaimIds: string[];
  reviewSourceIds: string[];
}

export interface ContentRevisionLineageReadModel {
  schemaVersion: typeof CONTENT_REVISION_LINEAGE_SCHEMA_VERSION;
  status: 'not_recorded' | 'recorded';
  revisionId: number;
  artifactId: number;
  groundingStatus: 'grounded' | 'partially_grounded' | 'ungrounded' | 'no_claims' | 'not_recorded';
  references: Array<{
    referenceId: string;
    title: string;
    url: string | null;
    trustLevel: string;
    freshnessScore: number;
    reviewRequired: boolean;
    usageType: 'evidence' | 'inspiration';
    claimIds: string[];
  }>;
  claims: ContentWorkspaceClaimInput[];
  unsupportedClaims: ContentWorkspaceClaimInput[];
  policy: ContentClaimPolicy;
  recordedAt: string | null;
}

export class ContentWorkspaceLineageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentWorkspaceLineageError';
  }
}

export function registerContentWorkspaceSource(input: {
  scope: ContentWorkspaceScope;
  referenceType: string;
  title: unknown;
  url?: unknown;
  summary?: unknown;
  sourceIdentifier?: unknown;
  metadata?: unknown;
  idempotencyKey: string;
}, db: Database.Database = getDb()): {
  source: ReturnType<typeof publicWorkspaceSource>;
  replayed: boolean;
  created: boolean;
} {
  const observation = startContentWorkspaceObservation('source_register');
  try {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'lineage');
  const referenceType = requireWorkspaceSourceType(input.referenceType);
  const title = requireBoundedText(input.title, 'title', 240, { singleLine: true });
  const summary = optionalBoundedText(input.summary, 'summary', 4_000);
  const url = sanitizeSourceUrl(input.url);
  if (referenceType === 'link' && !url) {
    throw new ContentWorkspaceLineageError('CONTENT_SOURCE_URL_REQUIRED', 'A valid http(s) URL is required for a link source.', 400, { field: 'url' });
  }
  const metadata = sanitizeSourceMetadata(input.metadata);
  const sourceIdentifier = resolveSourceIdentifier({
    referenceType,
    requested: input.sourceIdentifier,
    url,
    title,
    summary,
    metadata,
  });
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = 'register_workspace_source';
  const requestHash = hashPayload({ referenceType, title, url, summary, sourceIdentifier, metadata });

  const mutation = db.transaction(() => {
    const receipt = readReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      const row = getScopedReferenceById(db, scope, Number(receipt.resourceId));
      if (!row) throw inconsistentReceiptError();
      return { source: publicWorkspaceSource(row), replayed: true, created: false };
    }

    const existing = db.prepare(`
      SELECT * FROM content_reference_registry
       WHERE tenant_id = ? AND owner_user_id = ?
         AND visibility_scope = 'user_private' AND scope_status = 'active'
         AND reference_type = ? AND source_identifier = ?
       LIMIT 1
    `).get(scope.tenantId, scope.userId, referenceType, sourceIdentifier) as any;
    if (existing) {
      // A source identifier is an identity boundary, not an update handle.
      // Recapture must not rewrite a title/summary a user reviewed, or replace
      // assessment and extraction provenance while retaining its trust state.
      // Explicit assessment remains the only CAS-protected mutation path.
      writeReceipt(db, scope, operation, idempotencyKey, requestHash, 'content_reference', Number(existing.id), {
        created: false,
        preservedExisting: true,
      });
      return { source: publicWorkspaceSource(existing), replayed: false, created: false };
    }
    const firstParty = referenceType === 'note' || referenceType === 'previous_content';
    const extractionStatus = firstParty ? 'ready' : 'pending';
    const trustLevel = firstParty ? 'first_party' : 'unverified';
    const brokenStatus = firstParty ? 'ok' : 'unknown';
    const staleStatus = firstParty ? 'fresh' : 'unknown';
    const confidence = firstParty ? 0.8 : 0.5;
    const quality = firstParty ? 0.8 : 0.5;
    const sourceMetadata = {
      ...metadata,
      trust: 'untrusted_evidence',
      instructionAuthority: 'none',
      schemaVersion: CONTENT_WORKSPACE_SOURCE_SCHEMA_VERSION,
    };

    db.prepare(`
      INSERT INTO content_reference_registry (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        reference_type, source_table, source_pk, source_identifier,
        title, url, author_source, extraction_status, freshness_score,
        trust_level, quality_score, confidence_score, topic_tags_json,
        related_output_ids_json, broken_status, stale_status, source_summary,
        source_snippets_json, source_metadata_json, created_by, updated_by,
        audit_metadata_json
      ) VALUES (?, ?, 'user_private', 'active', ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, '[]', ?, ?, ?, ?)
      ON CONFLICT(tenant_id, owner_user_id, reference_type, source_identifier) DO NOTHING
    `).run(
      scope.tenantId,
      scope.userId,
      referenceType,
      sourceIdentifier,
      title,
      url,
      extractionStatus,
      firstParty ? 1 : 0.7,
      trustLevel,
      quality,
      confidence,
      brokenStatus,
      staleStatus,
      summary,
      stableJson(sourceMetadata),
      scope.userId,
      scope.userId,
      stableJson({ source: 'content_workspace', schemaVersion: CONTENT_WORKSPACE_SOURCE_SCHEMA_VERSION }),
    );
    const row = db.prepare(`
      SELECT * FROM content_reference_registry
       WHERE tenant_id = ? AND owner_user_id = ?
         AND reference_type = ? AND source_identifier = ?
       LIMIT 1
    `).get(scope.tenantId, scope.userId, referenceType, sourceIdentifier) as any;
    if (!row) throw new ContentWorkspaceLineageError('CONTENT_SOURCE_WRITE_FAILED', 'The source could not be read after saving.', 500);
    writeReceipt(db, scope, operation, idempotencyKey, requestHash, 'content_reference', Number(row.id), {
      created: !existing,
    });
    return { source: publicWorkspaceSource(row), replayed: false, created: !existing };
  }).immediate();
  observation.complete(mutation.replayed ? 'replayed' : mutation.created ? 'success' : 'no_change');
  return mutation;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

/**
 * Stage a user-reviewed external source before freezing revision lineage.
 * Imported text remains untrusted evidence with zero instruction authority.
 * A manual review can make ordinary claims reviewable, but high-risk claims
 * still require a curated or published source in assessWorkspaceClaims.
 */
export function assessContentWorkspaceSource(input: {
  scope: ContentWorkspaceScope;
  referenceId: string;
  assessment: 'reviewed' | 'broken' | 'stale';
  summary?: unknown;
  expectedUpdatedAt: unknown;
  idempotencyKey: string;
}, db: Database.Database = getDb()): {
  schemaVersion: typeof CONTENT_WORKSPACE_SOURCE_ASSESSMENT_SCHEMA_VERSION;
  source: ReturnType<typeof publicWorkspaceSource>;
  replayed: boolean;
  changed: boolean;
} {
  const observation = startContentWorkspaceObservation('source_assess');
  try {
    const scope = normalizeScope(input.scope);
    assertContentWorkspaceWriteEnabled(scope, 'lineage');
    const parsedReferenceId = parseReferenceId(input.referenceId);
    const assessment = input.assessment;
    if (!['reviewed', 'broken', 'stale'].includes(assessment)) {
      throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'assessment is not supported.', 400, { field: 'assessment' });
    }
    const expectedUpdatedAt = requireBoundedText(input.expectedUpdatedAt, 'expectedUpdatedAt', 80, { singleLine: true });
    const summary = assessment === 'reviewed'
      ? requireBoundedText(input.summary, 'summary', 4_000)
      : optionalBoundedText(input.summary, 'summary', 4_000);
    if (assessment === 'reviewed' && (!summary || summary.length < 10)) {
      throw new ContentWorkspaceLineageError(
        'CONTENT_SOURCE_REVIEW_SUMMARY_REQUIRED',
        'Add a short evidence summary before marking this source reviewed.',
        400,
        { field: 'summary' },
      );
    }
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const operation = `assess_workspace_source:${input.referenceId}`;
    const requestHash = hashPayload({
      referenceId: input.referenceId,
      assessment,
      summary,
      expectedUpdatedAt,
    });

    const mutation = db.transaction(() => {
      const receipt = readReceipt(db, scope, operation, idempotencyKey, requestHash);
      if (receipt) {
        const replayRow = getScopedReferenceById(db, scope, Number(receipt.resourceId));
        if (!replayRow || `${replayRow.reference_type}:${replayRow.id}` !== input.referenceId) {
          throw inconsistentReceiptError();
        }
        return { source: publicWorkspaceSource(replayRow), replayed: true, changed: Boolean(receipt.metadata.changed) };
      }
      const row = getScopedReferenceById(db, scope, parsedReferenceId.id);
      if (!row || row.reference_type !== parsedReferenceId.type) {
        throw new ContentWorkspaceLineageError('CONTENT_REFERENCE_NOT_FOUND', 'This private source is unavailable.', 404);
      }
      if (!['link', 'external_research_result', 'user_uploaded_source'].includes(row.reference_type)) {
        throw new ContentWorkspaceLineageError(
          'CONTENT_SOURCE_ASSESSMENT_NOT_REQUIRED',
          'This first-party source is already represented by its saved content.',
          409,
        );
      }
      const next = assessment === 'reviewed'
        ? {
            extractionStatus: 'ready',
            trustLevel: 'observed',
            brokenStatus: 'ok',
            staleStatus: 'fresh',
            freshnessScore: 0.8,
            qualityScore: 0.65,
            confidenceScore: 0.65,
          }
        : assessment === 'broken'
          ? {
              extractionStatus: 'failed',
              trustLevel: 'unverified',
              brokenStatus: 'broken',
              staleStatus: 'unknown',
              freshnessScore: 0,
              qualityScore: 0,
              confidenceScore: 0,
            }
          : {
              extractionStatus: 'stale',
              trustLevel: 'unverified',
              brokenStatus: 'unknown',
              staleStatus: 'stale',
              freshnessScore: 0,
              qualityScore: 0.3,
              confidenceScore: 0.3,
            };
      const now = new Date().toISOString();
      const sourceMetadata = {
        ...parseObject(row.source_metadata_json),
        trust: 'untrusted_evidence',
        instructionAuthority: 'none',
        assessment: {
          schemaVersion: CONTENT_WORKSPACE_SOURCE_ASSESSMENT_SCHEMA_VERSION,
          status: assessment,
          assessedBy: 'authenticated_user',
          assessedAt: now,
        },
      };
      const update = db.prepare(`
        UPDATE content_reference_registry
           SET extraction_status = ?, trust_level = ?, broken_status = ?, stale_status = ?,
               freshness_score = ?, quality_score = ?, confidence_score = ?,
               source_summary = COALESCE(?, source_summary), source_metadata_json = ?,
               updated_by = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
           AND visibility_scope = 'user_private' AND scope_status = 'active'
           AND updated_at = ?
      `).run(
        next.extractionStatus,
        next.trustLevel,
        next.brokenStatus,
        next.staleStatus,
        next.freshnessScore,
        next.qualityScore,
        next.confidenceScore,
        summary,
        stableJson(sourceMetadata),
        scope.userId,
        now,
        row.id,
        scope.tenantId,
        scope.userId,
        expectedUpdatedAt,
      );
      if (update.changes !== 1) {
        const current = getScopedReferenceById(db, scope, parsedReferenceId.id);
        throw new ContentWorkspaceLineageError(
          'CONTENT_SOURCE_VERSION_CONFLICT',
          'This source review changed after it was loaded. Reload it before retrying.',
          409,
          { currentUpdatedAt: current?.updated_at ?? null, recovery: 'reload_source_and_retry' },
        );
      }
      const updated = getScopedReferenceById(db, scope, parsedReferenceId.id);
      if (!updated) throw new ContentWorkspaceLineageError('CONTENT_SOURCE_WRITE_FAILED', 'The reviewed source could not be read.', 500);
      writeReceipt(db, scope, operation, idempotencyKey, requestHash, 'content_reference', Number(updated.id), { changed: true });
      return { source: publicWorkspaceSource(updated), replayed: false, changed: true };
    }).immediate();
    observation.complete(mutation.replayed ? 'replayed' : 'success');
    return { schemaVersion: CONTENT_WORKSPACE_SOURCE_ASSESSMENT_SCHEMA_VERSION, ...mutation };
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

export function recordContentRevisionLineage(input: {
  scope: ContentWorkspaceScope;
  revisionId: number;
  referenceIds?: unknown;
  claims?: unknown;
  idempotencyKey: string;
}, db: Database.Database = getDb()): {
  lineage: ContentRevisionLineageReadModel;
  replayed: boolean;
  created: boolean;
} {
  const observation = startContentWorkspaceObservation('lineage_record');
  try {
  const scope = normalizeScope(input.scope);
  assertContentWorkspaceWriteEnabled(scope, 'lineage');
  const revision = requireScopedRevision(db, scope, input.revisionId);
  const referenceIds = normalizeReferenceIds(input.referenceIds);
  const references = getPrivateContentReferencesByIds({ scope, referenceIds }, db);
  const claims = mergeRevisionSafetyClaims(
    revision,
    normalizeClaims(input.claims, referenceIds),
  );
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operation = `record_revision_lineage:${revision.id}`;
  const requestHash = hashPayload({ revisionId: revision.id, referenceIds, claims });
  const grounding = assessWorkspaceClaims(claims, references);
  const policy = evaluateContentClaimPolicy(claims, grounding.unsupportedClaims, references);
  const referenceSnapshot = references.map(publicReferenceSnapshot).sort(compareReferenceSnapshot);
  const unsupportedSnapshot = grounding.unsupportedClaims.slice().sort(compareClaim);
  const claimsSnapshot = claims.slice().sort(compareClaim);

  const mutation = db.transaction(() => {
    const receipt = readReceipt(db, scope, operation, idempotencyKey, requestHash);
    if (receipt) {
      return {
        lineage: getContentRevisionLineage(scope, revision.id, db),
        replayed: true,
        created: Boolean(receipt.metadata.created),
      };
    }

    const existing = getRawLineageRow(db, scope, revision.id);
    if (existing) {
      const existingReferences = normalizeStoredReferences(parseArray(existing.references_used_json));
      const existingClaims = mergeRevisionSafetyClaims(
        revision,
        normalizeStoredClaims(parseArray(existing.claims_json)),
      );
      const existingGrounding = assessWorkspaceClaims(existingClaims, existingReferences);
      const unchanged = stableJson(parseArray(existing.references_used_json)) === stableJson(referenceSnapshot)
        && stableJson(existingClaims.slice().sort(compareClaim)) === stableJson(claimsSnapshot)
        && stableJson(existingGrounding.unsupportedClaims.slice().sort(compareClaim)) === stableJson(unsupportedSnapshot)
        && existingGrounding.groundingStatus === grounding.groundingStatus;
      if (!unchanged) {
        throw new ContentWorkspaceLineageError(
          'CONTENT_REVISION_LINEAGE_IMMUTABLE',
          'Sources and claims for a saved revision cannot be rewritten. Save a new revision first.',
          409,
          { revisionId: revision.id, recovery: 'save_new_revision' },
        );
      }
      invalidateApprovalForBlockedLineage(db, scope, revision, policy);
      writeReceipt(db, scope, operation, idempotencyKey, requestHash, 'content_revision', revision.id, { created: false });
      return { lineage: mapLineageRow(revision, existing), replayed: false, created: false };
    }

    db.prepare(`
      INSERT INTO content_output_provenance (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        output_object_type, output_id, grounding_status, references_used_json,
        claims_json, unsupported_claims_json, source_summaries_json,
        generated_from_radar_signal_id, reused_from_content_id,
        provenance_status, review_required, created_by, updated_by,
        audit_metadata_json
      ) VALUES (?, ?, 'user_private', 'active', 'content_revision', ?, ?, ?, ?, ?, '[]', NULL, NULL, 'active', ?, ?, ?, ?)
    `).run(
      scope.tenantId,
      scope.userId,
      String(revision.id),
      grounding.groundingStatus,
      stableJson(referenceSnapshot),
      stableJson(claimsSnapshot),
      stableJson(unsupportedSnapshot),
      policy.status === 'clear' ? 0 : 1,
      scope.userId,
      scope.userId,
      stableJson({ source: 'content_workspace', schemaVersion: CONTENT_REVISION_LINEAGE_SCHEMA_VERSION }),
    );

    for (const reference of references) {
      const claimIds = claims
        .filter((claim) => claim.supportedBy?.includes(reference.referenceId))
        .map((claim) => claim.id)
        .sort();
      db.prepare(`
        INSERT INTO content_source_output_links (
          tenant_id, owner_user_id, visibility_scope, scope_status,
          source_type, source_id, output_object_type, output_id, usage_type,
          attribution_text, claim_ids_json, evidence_ids_json, confidence,
          created_by, audit_metadata_json
        ) VALUES (?, ?, 'user_private', 'active', ?, ?, 'content_revision', ?, ?, ?, ?, '[]', ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.userId,
        reference.referenceType,
        reference.referenceId,
        String(revision.id),
        claimIds.length > 0 ? 'evidence' : 'inspiration',
        reference.title,
        stableJson(claimIds),
        reference.confidenceScore,
        scope.userId,
        stableJson({ source: 'content_workspace', schemaVersion: CONTENT_REVISION_LINEAGE_SCHEMA_VERSION }),
      );
      const related = Array.from(new Set([...reference.relatedOutputIds, `content_revision:${revision.id}`])).slice(0, 50);
      db.prepare(`
        UPDATE content_reference_registry
           SET last_used_at = datetime('now'), related_output_ids_json = ?, updated_at = datetime('now')
         WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
      `).run(stableJson(related), reference.id, scope.tenantId, scope.userId);
    }
    invalidateApprovalForBlockedLineage(db, scope, revision, policy);
    writeReceipt(db, scope, operation, idempotencyKey, requestHash, 'content_revision', revision.id, {
      created: true,
      groundingStatus: grounding.groundingStatus,
      policyStatus: policy.status,
    });
    return { lineage: getContentRevisionLineage(scope, revision.id, db), replayed: false, created: true };
  }).immediate();
  if (mutation.replayed) {
    observation.complete('replayed');
  } else if (!mutation.created) {
    observation.complete('no_change');
  } else {
    observation.complete('success', mutation.lineage.policy.status === 'blocked' ? 'claim_safety_block' : undefined);
    if (mutation.lineage.policy.status === 'clear') {
      recordContentWorkspaceQualitySignal('lineage_recorded_clear');
    } else if (mutation.lineage.policy.status === 'warning') {
      recordContentWorkspaceQualitySignal('unsupported_claim_warning');
    } else if (mutation.lineage.policy.status === 'blocked') {
      recordContentWorkspaceQualitySignal('claim_safety_blocked');
    }
  }
  return mutation;
  } catch (error) {
    observation.completeFromError(error);
    throw error;
  }
}

export function getContentRevisionLineage(
  scopeInput: ContentWorkspaceScope,
  revisionId: number,
  db: Database.Database = getDb(),
): ContentRevisionLineageReadModel {
  const scope = normalizeScope(scopeInput);
  const revision = requireScopedRevision(db, scope, revisionId);
  const row = getRawLineageRow(db, scope, revision.id);
  return row ? mapLineageRow(revision, row) : emptyLineage(revision);
}

export function getContentRevisionClaimPolicy(
  scopeInput: ContentWorkspaceScope,
  revisionId: number,
  db: Database.Database = getDb(),
): ContentClaimPolicy {
  const scope = normalizeScope(scopeInput);
  const revision = requireScopedRevision(db, scope, revisionId);
  const row = getRawLineageRow(db, scope, revisionId);
  if (!row) return notRecordedPolicy();
  return mapLineageRow(revision, row).policy;
}

export function getPrivateContentReferencesByIds(input: {
  scope: ContentWorkspaceScope;
  referenceIds: string[];
}, db: Database.Database = getDb()): ContentRegisteredReference[] {
  if (input.referenceIds.length === 0) return [];
  const scope = normalizeScope(input.scope);
  const parsed = input.referenceIds.map(parseReferenceId);
  const ids = parsed.map((value) => value.id);
  const rows = db.prepare(`
    SELECT * FROM content_reference_registry
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND id IN (${ids.map(() => '?').join(', ')})
  `).all(scope.tenantId, scope.userId, ...ids) as any[];
  const byId = new Map(rows.map((row) => [`${row.reference_type}:${row.id}`, row]));
  const missing = input.referenceIds.filter((referenceId) => !byId.has(referenceId));
  if (missing.length > 0) {
    throw new ContentWorkspaceLineageError(
      'CONTENT_REFERENCE_NOT_FOUND',
      'One or more private sources are unavailable in this workspace.',
      404,
      { referenceIds: missing },
    );
  }
  return input.referenceIds.map((referenceId) => mapReferenceRow(byId.get(referenceId)));
}

export function evaluateContentClaimPolicy(
  claims: readonly ContentWorkspaceClaimInput[],
  unsupportedClaims: readonly ContentWorkspaceClaimInput[],
  references: readonly Pick<ContentRegisteredReference, 'referenceId' | 'reviewRequired'>[],
): ContentClaimPolicy {
  const unsupportedIds = unsupportedClaims.map((claim) => claim.id).sort();
  const reviewSourceIds = references.filter((reference) => reference.reviewRequired).map((reference) => reference.referenceId).sort();
  const blockCodes = new Set<string>();
  const warningCodes = new Set<string>();
  for (const claim of unsupportedClaims) {
    if (claim.riskLevel === 'regulated' || claim.riskLevel === 'sensitive' || classifyContentClaimRisk(claim.text) !== 'standard') {
      blockCodes.add('CONTENT_UNSUPPORTED_SENSITIVE_CLAIM');
    } else {
      warningCodes.add('CONTENT_UNSUPPORTED_CLAIM_REVIEW_REQUIRED');
    }
  }
  if (reviewSourceIds.length > 0) warningCodes.add('CONTENT_SOURCE_REVIEW_REQUIRED');
  if (claims.length === 0 && references.length === 0) warningCodes.delete('CONTENT_SOURCE_REVIEW_REQUIRED');
  const blocksApproval = blockCodes.size > 0;
  return {
    status: blocksApproval ? 'blocked' : warningCodes.size > 0 ? 'warning' : 'clear',
    blocksApproval,
    warningCodes: Array.from(warningCodes).sort(),
    blockCodes: Array.from(blockCodes).sort(),
    unsupportedClaimIds: unsupportedIds,
    reviewSourceIds,
  };
}

function assessWorkspaceClaims(claims: ContentWorkspaceClaimInput[], references: ContentRegisteredReference[]) {
  const eligible = new Map(
    references
      .filter((reference) => reference.usableForGeneration && !reference.reviewRequired)
      .map((reference) => [reference.referenceId, reference]),
  );
  const unsupportedClaims = claims.filter((claim) => {
    const supportedBy = claim.supportedBy ?? [];
    const highRisk = claim.riskLevel === 'regulated'
      || claim.riskLevel === 'sensitive'
      || classifyContentClaimRisk(claim.text) !== 'standard';
    return supportedBy.length === 0 || supportedBy.some((referenceId) => {
      const reference = eligible.get(referenceId);
      if (!reference) return true;
      // A private note or prior post can preserve the user's context, but it
      // cannot independently substantiate medical, legal, finance, tax, or
      // other sensitive claims. Such claims need separately reviewable
      // evidence; self-attestation remains visible as inspiration.
      return highRisk && (
        reference.referenceType === 'note'
        || reference.referenceType === 'previous_content'
        || reference.trustLevel === 'first_party'
        || !['curated', 'published'].includes(reference.trustLevel)
      );
    });
  });
  const groundingStatus = claims.length === 0
    ? (references.length > 0 ? 'no_claims' : 'ungrounded')
    : unsupportedClaims.length === 0
      ? 'grounded'
      : unsupportedClaims.length === claims.length
        ? 'ungrounded'
        : 'partially_grounded';
  return { groundingStatus, unsupportedClaims } as const;
}

function mapLineageRow(revision: ScopedRevision, row: any): ContentRevisionLineageReadModel {
  const claims = mergeRevisionSafetyClaims(
    revision,
    normalizeStoredClaims(parseArray(row.claims_json)),
  );
  const references = normalizeStoredReferences(parseArray(row.references_used_json));
  const grounding = assessWorkspaceClaims(claims, references);
  const unsupportedClaims = grounding.unsupportedClaims;
  const links = new Map<string, { usageType: 'evidence' | 'inspiration'; claimIds: string[] }>();
  // Link rows are intentionally not required for rendering a provenance
  // snapshot, but enrich the read model when present.
  for (const reference of references) {
    links.set(reference.referenceId, {
      usageType: claims.some((claim) => claim.supportedBy?.includes(reference.referenceId)) ? 'evidence' : 'inspiration',
      claimIds: claims.filter((claim) => claim.supportedBy?.includes(reference.referenceId)).map((claim) => claim.id).sort(),
    });
  }
  return {
    schemaVersion: CONTENT_REVISION_LINEAGE_SCHEMA_VERSION,
    status: 'recorded',
    revisionId: revision.id,
    artifactId: revision.artifactId,
    groundingStatus: grounding.groundingStatus,
    references: references.map((reference) => ({
      referenceId: reference.referenceId,
      title: reference.title,
      url: reference.url,
      trustLevel: reference.trustLevel,
      freshnessScore: reference.freshnessScore,
      reviewRequired: reference.reviewRequired,
      usageType: links.get(reference.referenceId)?.usageType ?? 'inspiration',
      claimIds: links.get(reference.referenceId)?.claimIds ?? [],
    })),
    claims,
    unsupportedClaims,
    policy: evaluateContentClaimPolicy(claims, unsupportedClaims, references),
    recordedAt: row.created_at ?? null,
  };
}

function emptyLineage(revision: ScopedRevision): ContentRevisionLineageReadModel {
  return {
    schemaVersion: CONTENT_REVISION_LINEAGE_SCHEMA_VERSION,
    status: 'not_recorded',
    revisionId: revision.id,
    artifactId: revision.artifactId,
    groundingStatus: 'not_recorded',
    references: [],
    claims: [],
    unsupportedClaims: [],
    policy: notRecordedPolicy(),
    recordedAt: null,
  };
}

function notRecordedPolicy(): ContentClaimPolicy {
  return {
    status: 'not_recorded',
    blocksApproval: false,
    warningCodes: ['CONTENT_LINEAGE_NOT_RECORDED'],
    blockCodes: [],
    unsupportedClaimIds: [],
    reviewSourceIds: [],
  };
}

interface ScopedRevision {
  id: number;
  artifactId: number;
  itemId: number;
  contentFormat: 'plain_text' | 'markdown' | 'structured_json';
  contentText: string | null;
  structuredContentJson: string | null;
}

function requireScopedRevision(db: Database.Database, scope: ContentWorkspaceScope, revisionId: number): ScopedRevision {
  const id = requirePositiveInteger(revisionId, 'revisionId');
  const row = db.prepare(`
    SELECT r.id, r.artifact_id, a.item_id,
           r.content_format, r.content_text, r.structured_content_json
      FROM content_revisions r
      JOIN content_artifacts a ON a.id = r.artifact_id AND a.tenant_id = r.tenant_id AND a.owner_user_id = r.owner_user_id
      JOIN content_domain_objects o ON o.id = a.item_id AND o.tenant_id = a.tenant_id AND o.owner_user_id = a.owner_user_id
     WHERE r.id = ? AND r.tenant_id = ? AND r.owner_user_id = ?
       AND a.visibility_scope = 'user_private' AND a.scope_status = 'active'
       AND o.visibility_scope = 'user_private' AND o.scope_status = 'active' AND o.deleted_at IS NULL
     LIMIT 1
  `).get(id, scope.tenantId, scope.userId) as {
    id: number;
    artifact_id: number;
    item_id: number;
    content_format: string;
    content_text: string | null;
    structured_content_json: string | null;
  } | undefined;
  if (!row) throw new ContentWorkspaceLineageError('CONTENT_REVISION_NOT_FOUND', 'Content revision not found.', 404);
  if (!['plain_text', 'markdown', 'structured_json'].includes(row.content_format)) {
    throw new ContentWorkspaceLineageError('CONTENT_REVISION_INTEGRITY_FAILED', 'The saved revision format is unsupported.', 500);
  }
  return {
    id: Number(row.id),
    artifactId: Number(row.artifact_id),
    itemId: Number(row.item_id),
    contentFormat: row.content_format as ScopedRevision['contentFormat'],
    contentText: row.content_text,
    structuredContentJson: row.structured_content_json,
  };
}

/**
 * Lineage is allowed to be recorded after an editorial decision, but a newly
 * blocked claim snapshot must revoke that decision atomically. Otherwise an
 * item can remain approved while its immutable evidence record says approval
 * is unsafe, and stale clients can continue from the old workflow version.
 */
function invalidateApprovalForBlockedLineage(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  revision: ScopedRevision,
  policy: ContentClaimPolicy,
): void {
  if (policy.status !== 'blocked') return;
  const current = db.prepare(`
    SELECT production_state, workflow_version, object_type
      FROM content_domain_objects
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND deleted_at IS NULL AND object_type = 'content_item'
     LIMIT 1
  `).get(revision.itemId, scope.tenantId, scope.userId) as {
    production_state: string;
    workflow_version: number;
    object_type: string;
  } | undefined;
  if (!current || !['approved', 'scheduled', 'published'].includes(current.production_state)) return;

  const now = new Date().toISOString();
  const reasonCodes = ['content_lineage_claim_safety_block'];
  const update = db.prepare(`
    UPDATE content_domain_objects
       SET production_state = 'review',
           lifecycle_state = 'review',
           editorial_state = 'reviewed',
           approval_state = 'required',
           review_required = 1,
           review_reason_codes_json = ?,
           approved_by = NULL,
           approved_at = NULL,
           updated_by = ?,
           updated_at = ?,
           workflow_version = workflow_version + 1
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND deleted_at IS NULL AND object_type = 'content_item'
       AND workflow_version = ?
  `).run(
    stableJson(reasonCodes),
    scope.userId,
    now,
    revision.itemId,
    scope.tenantId,
    scope.userId,
    current.workflow_version,
  );
  if (update.changes !== 1) {
    throw new ContentWorkspaceLineageError(
      'CONTENT_WORKFLOW_VERSION_CONFLICT',
      'The content item changed while claim safety was being recorded.',
      409,
      { recovery: 'reload_and_retry' },
    );
  }
  db.prepare(`
    INSERT INTO content_workflow_events (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, object_id, action, from_state, to_state,
      approval_state, review_required, reason_codes_json,
      actor_user_id, metadata_json
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?,
              'workspace_approval_invalidated_by_lineage', ?, 'review',
              'required', 1, ?, ?, ?)
  `).run(
    scope.tenantId,
    scope.userId,
    String(revision.itemId),
    current.production_state,
    stableJson(reasonCodes),
    scope.userId,
    stableJson({
      revisionId: revision.id,
      artifactId: revision.artifactId,
      policyStatus: policy.status,
      blockCodes: policy.blockCodes,
      schemaVersion: CONTENT_REVISION_LINEAGE_SCHEMA_VERSION,
    }),
  );
}

function getRawLineageRow(db: Database.Database, scope: ContentWorkspaceScope, revisionId: number): any {
  return db.prepare(`
    SELECT * FROM content_output_provenance
     WHERE tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND output_object_type = 'content_revision' AND output_id = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, String(revisionId));
}

function mapReferenceRow(row: any): ContentRegisteredReference {
  const usability = isContentReferenceUsable({
    extractionStatus: row.extraction_status,
    brokenStatus: row.broken_status,
    staleStatus: row.stale_status,
    trustLevel: row.trust_level,
    confidenceScore: Number(row.confidence_score),
    qualityScore: Number(row.quality_score),
  });
  return {
    id: Number(row.id),
    referenceId: `${row.reference_type}:${row.id}`,
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
    topicTags: parseStringArray(row.topic_tags_json),
    relatedOutputIds: parseStringArray(row.related_output_ids_json),
    lastUsedAt: row.last_used_at ?? null,
    brokenStatus: row.broken_status,
    staleStatus: row.stale_status,
    sourceSummary: row.source_summary ?? null,
    sourceSnippets: [],
    usableForGeneration: usability.usable,
    reviewRequired: usability.reviewRequired,
    rejectionReasons: usability.reasons,
  };
}

function publicReferenceSnapshot(reference: ContentRegisteredReference) {
  return {
    referenceId: reference.referenceId,
    title: reference.title,
    url: reference.url,
    trustLevel: reference.trustLevel,
    freshnessScore: reference.freshnessScore,
    reviewRequired: reference.reviewRequired,
  };
}

function normalizeStoredReferences(values: unknown[]): ContentRegisteredReference[] {
  return values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
    .map((value) => ({
      id: parseReferenceId(String(value.referenceId ?? '')).id,
      referenceId: String(value.referenceId),
      tenantId: 0,
      ownerUserId: 0,
      visibilityScope: 'user_private',
      referenceType: String(value.referenceId).split(':')[0],
      sourceTable: null,
      sourcePk: null,
      sourceIdentifier: '',
      title: String(value.title ?? ''),
      url: typeof value.url === 'string' ? value.url : null,
      authorSource: null,
      extractionStatus: '',
      freshnessScore: clamp01(Number(value.freshnessScore ?? 0)),
      trustLevel: String(value.trustLevel ?? 'unverified'),
      qualityScore: 0,
      confidenceScore: 0,
      topicTags: [],
      relatedOutputIds: [],
      lastUsedAt: null,
      brokenStatus: 'unknown',
      staleStatus: 'unknown',
      sourceSummary: null,
      sourceSnippets: [],
      usableForGeneration: value.reviewRequired !== true,
      reviewRequired: value.reviewRequired === true,
      rejectionReasons: [],
    }));
}

function publicWorkspaceSource(row: any) {
  const reference = mapReferenceRow(row);
  return {
    schemaVersion: CONTENT_WORKSPACE_SOURCE_SCHEMA_VERSION,
    referenceId: reference.referenceId,
    referenceType: reference.referenceType,
    title: reference.title,
    url: reference.url,
    extractionStatus: reference.extractionStatus,
    trustLevel: reference.trustLevel,
    freshnessScore: reference.freshnessScore,
    reviewRequired: reference.reviewRequired,
    usableForGeneration: reference.usableForGeneration && !reference.reviewRequired,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getScopedReferenceById(db: Database.Database, scope: ContentWorkspaceScope, id: number): any {
  return db.prepare(`
    SELECT * FROM content_reference_registry
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
     LIMIT 1
  `).get(id, scope.tenantId, scope.userId);
}

function normalizeReferenceIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'referenceIds must be an array with at most 50 entries.', 400, { field: 'referenceIds' });
  }
  const ids = value.map((entry) => String(entry));
  ids.forEach(parseReferenceId);
  if (new Set(ids).size !== ids.length) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'referenceIds must not contain duplicates.', 400, { field: 'referenceIds' });
  }
  return ids.slice().sort();
}

function normalizeClaims(value: unknown, allowedReferences: string[]): ContentWorkspaceClaimInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'claims must be an array with at most 100 entries.', 400, { field: 'claims' });
  }
  const allowed = new Set(allowedReferences);
  const claims = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'Each claim must be an object.', 400, { field: `claims[${index}]` });
    }
    const record = candidate as Record<string, unknown>;
    const id = requireBoundedText(record.id, `claims[${index}].id`, 100, { singleLine: true });
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
      throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'Claim ids may contain letters, numbers, dot, colon, underscore, and dash.', 400, { field: `claims[${index}].id` });
    }
    const text = requireBoundedText(record.text, `claims[${index}].text`, 2_000);
    const supportedBy = record.supportedBy === undefined ? [] : normalizeReferenceIds(record.supportedBy);
    const foreign = supportedBy.filter((referenceId) => !allowed.has(referenceId));
    if (foreign.length > 0) {
      throw new ContentWorkspaceLineageError('CONTENT_REFERENCE_NOT_FOUND', 'A claim refers to a source outside this revision package.', 404, { referenceIds: foreign });
    }
    const confidence = record.confidence === undefined ? undefined : clamp01(requireFiniteNumber(record.confidence, `claims[${index}].confidence`));
    const riskLevel = strongestRiskLevel(normalizeRiskLevel(record.riskLevel), classifyContentClaimRisk(text));
    return { id, text, supportedBy, confidence, riskLevel };
  });
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'Claim ids must be unique.', 400, { field: 'claims' });
  }
  return claims.sort(compareClaim);
}

/**
 * Client/provider claim ledgers are descriptive hints, never the safety
 * authority. Re-extract safety-critical statements from the exact immutable
 * revision on every lineage write/read and give those statements capacity
 * precedence. This also hardens lineage snapshots written before server-side
 * extraction existed without mutating their audit record.
 */
function mergeRevisionSafetyClaims(
  revision: ScopedRevision,
  submittedClaims: ContentWorkspaceClaimInput[],
): ContentWorkspaceClaimInput[] {
  const submittedByText = new Map(
    submittedClaims.map((claim) => [claimTextIdentity(claim.text), claim]),
  );
  const merged: ContentWorkspaceClaimInput[] = [];
  const usedIds = new Set<string>();
  const usedTexts = new Set<string>();
  for (const text of extractReviewableContentClaims(revisionSafetyText(revision), 100)) {
    const textIdentity = claimTextIdentity(text);
    const submitted = submittedByText.get(textIdentity);
    const id = submitted?.id ?? `server:${createHash('sha256').update(textIdentity).digest('hex').slice(0, 24)}`;
    if (usedIds.has(id) || usedTexts.has(textIdentity)) continue;
    merged.push({
      ...(submitted ?? {}),
      id,
      text,
      supportedBy: submitted?.supportedBy ?? [],
      riskLevel: strongestRiskLevel(
        normalizeRiskLevel(submitted?.riskLevel),
        classifyContentClaimRisk(text),
      ),
    });
    usedIds.add(id);
    usedTexts.add(textIdentity);
  }
  for (const claim of submittedClaims) {
    if (merged.length >= 100) break;
    const textIdentity = claimTextIdentity(claim.text);
    if (usedIds.has(claim.id) || usedTexts.has(textIdentity)) continue;
    merged.push(claim);
    usedIds.add(claim.id);
    usedTexts.add(textIdentity);
  }
  return merged.sort(compareClaim);
}

function revisionSafetyText(revision: ScopedRevision): string {
  if (revision.contentFormat !== 'structured_json') return revision.contentText ?? '';
  if (!revision.structuredContentJson) return '';
  try {
    const pending: unknown[] = [JSON.parse(revision.structuredContentJson)];
    const strings: string[] = [];
    const keys: string[] = [];
    // The persisted structured revision is already size-bounded by the
    // workspace writer. Traverse every string value: a fixed node cap lets a
    // hostile document place the unsafe claim just beyond the scan boundary.
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'string') {
        strings.push(value);
      } else if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) pending.push(value[index]);
      } else if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        keys.push(...entries.map(([key]) => key));
        for (let index = entries.length - 1; index >= 0; index -= 1) pending.push(entries[index][1]);
      }
    }
    // Values preserve semantic field/array order. Keys are scanned too (a
    // structured document can encode a user-visible claim as a key), but are
    // appended separately so schema labels cannot split subject/promise text.
    return [...strings, ...keys].join('\n');
  } catch {
    // The revision writer validates JSON, but fail closed on historical or
    // externally imported rows rather than dropping safety inspection.
    return revision.structuredContentJson;
  }
}

function claimTextIdentity(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, '')
    .replace(/[^a-z0-9%]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeStoredClaims(values: unknown[]): ContentWorkspaceClaimInput[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.text !== 'string') return [];
    return [{
      id: record.id,
      text: record.text,
      supportedBy: Array.isArray(record.supportedBy) ? record.supportedBy.filter((entry): entry is string => typeof entry === 'string') : [],
      confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
      riskLevel: strongestRiskLevel(normalizeRiskLevel(record.riskLevel), classifyContentClaimRisk(record.text)),
    }];
  }).sort(compareClaim);
}

function requireWorkspaceSourceType(value: string): WorkspaceSourceType {
  if (!WORKSPACE_SOURCE_TYPES.includes(value as WorkspaceSourceType)) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'referenceType is not supported by the Content workspace.', 400, { field: 'referenceType' });
  }
  return value as WorkspaceSourceType;
}

function parseReferenceId(value: string): { type: WorkspaceSourceType; id: number } {
  const match = value.match(/^([a-z_]+):([1-9]\d*)$/);
  if (!match) throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'A source reference id is invalid.', 400, { field: 'referenceIds' });
  return { type: requireWorkspaceSourceType(match[1]), id: requirePositiveInteger(Number(match[2]), 'referenceId') };
}

function resolveSourceIdentifier(input: {
  referenceType: WorkspaceSourceType;
  requested: unknown;
  url: string | null;
  title: string;
  summary: string | null;
  metadata: Record<string, unknown>;
}): string {
  if (input.url) return input.url;
  const requested = optionalBoundedText(input.requested, 'sourceIdentifier', 500, { singleLine: true });
  if (requested) return requested;
  const externalId = typeof input.metadata.externalDocumentId === 'string' ? input.metadata.externalDocumentId : null;
  if (externalId) return `${input.referenceType}:${externalId}`;
  return `workspace:${createHash('sha256').update(stableJson({
    referenceType: input.referenceType,
    title: input.title,
    summary: input.summary,
  })).digest('hex')}`;
}

function sanitizeSourceUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'url must be a valid http(s) URL.', 400, { field: 'url' });
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported protocol');
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(access_?token|token|api_?key|key|auth|authorization|signature|sig)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'url must be a valid http(s) URL.', 400, { field: 'url' });
  }
}

function sanitizeSourceMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'metadata must be an object.', 400, { field: 'metadata' });
  }
  const allowed = new Set(['language', 'mimeType', 'publishedAt', 'provider', 'externalDocumentId']);
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key) || raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') continue;
    output[key] = sanitizeText(raw, 500, true);
  }
  return output;
}

function normalizeRiskLevel(value: unknown): ContentClaimRiskLevel {
  return value === 'sensitive' || value === 'regulated' ? value : 'standard';
}

function strongestRiskLevel(
  left: ContentClaimRiskLevel,
  right: ContentClaimRiskLevel,
): ContentClaimRiskLevel {
  const rank: Readonly<Record<ContentClaimRiskLevel, number>> = {
    standard: 0,
    sensitive: 1,
    regulated: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  return {
    tenantId: requirePositiveInteger(scope?.tenantId, 'tenantId'),
    userId: requirePositiveInteger(scope?.userId, 'userId'),
  };
}

function normalizeIdempotencyKey(value: string): string {
  const key = requireBoundedText(value, 'idempotencyKey', 200, { singleLine: true });
  if (key.length < 8) throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', 'idempotencyKey must contain at least 8 characters.', 400, { field: 'idempotencyKey' });
  return key;
}

function readReceipt(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): { resourceId: string; metadata: Record<string, unknown> } | null {
  const row = db.prepare(`
    SELECT request_hash, resource_id, result_metadata_json
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ? AND operation = ? AND idempotency_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, operation, idempotencyKey) as any;
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new ContentWorkspaceLineageError('CONTENT_IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request.', 409, { operation });
  }
  return { resourceId: String(row.resource_id), metadata: parseObject(row.result_metadata_json) };
}

function writeReceipt(
  db: Database.Database,
  scope: ContentWorkspaceScope,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  resourceType: string,
  resourceId: number,
  metadata: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO content_mutation_receipts (
      tenant_id, owner_user_id, operation, idempotency_key,
      request_hash, resource_type, resource_id, result_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(scope.tenantId, scope.userId, operation, idempotencyKey, requestHash, resourceType, String(resourceId), stableJson(metadata));
}

function inconsistentReceiptError() {
  return new ContentWorkspaceLineageError('CONTENT_IDEMPOTENCY_RECEIPT_INVALID', 'A prior mutation receipt no longer resolves safely.', 500);
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function parseStringArray(value: unknown): string[] {
  return parseArray(value).filter((entry): entry is string => typeof entry === 'string');
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', `${field} must be a positive integer.`, 400, { field });
  }
  return Number(value);
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', `${field} must be a finite number.`, 400, { field });
  }
  return value;
}

function requireBoundedText(value: unknown, field: string, maxLength: number, options: { singleLine?: boolean } = {}): string {
  if (typeof value !== 'string') throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', `${field} must be text.`, 400, { field });
  const text = sanitizeText(value, maxLength, options.singleLine === true);
  if (!text) throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', `${field} is required.`, 400, { field });
  return text;
}

function optionalBoundedText(value: unknown, field: string, maxLength: number, options: { singleLine?: boolean } = {}): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireBoundedText(value, field, maxLength, options);
}

function sanitizeText(value: string, maxLength: number, singleLine: boolean): string {
  const withoutControls = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const normalized = singleLine ? withoutControls.replace(/\s+/g, ' ') : withoutControls;
  const trimmed = normalized.trim();
  if (trimmed.length > maxLength) {
    throw new ContentWorkspaceLineageError('CONTENT_VALIDATION_FAILED', `Text exceeds the ${maxLength}-character limit.`, 400, { maxLength });
  }
  return trimmed;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function compareClaim(a: ContentWorkspaceClaimInput, b: ContentWorkspaceClaimInput): number { return a.id.localeCompare(b.id); }
function compareReferenceSnapshot(a: { referenceId: string }, b: { referenceId: string }): number { return a.referenceId.localeCompare(b.referenceId); }

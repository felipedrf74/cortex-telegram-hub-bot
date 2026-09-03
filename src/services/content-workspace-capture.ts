// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  CONTENT_WORKSPACE_SCHEMA_VERSION,
  ContentWorkspaceError,
  createContentArtifact,
  createContentWorkspaceItem,
  getContentArtifact,
  getContentRevision,
  getContentWorkspaceItem,
  saveContentRevision,
  type ContentArtifact,
  type ContentRevision,
  type ContentRevisionActorType,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from './content-workspace';
import {
  recordContentRevisionLineage,
  registerContentWorkspaceSource,
  type ContentWorkspaceClaimInput,
} from './content-workspace-lineage';
import {
  classifyContentClaimRisk,
  extractHighRiskContentClaims,
} from './content-claim-safety';

export const CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION = 'content-workspace-capture-v1';

export interface ContentWorkspaceCaptureResult {
  schemaVersion: typeof CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION;
  workspaceSchemaVersion: typeof CONTENT_WORKSPACE_SCHEMA_VERSION;
  item: ContentWorkspaceItem;
  artifact: ContentArtifact;
  /** Immutable revision produced by the captured mutation. */
  revision: ContentRevision;
  revisionId: number;
  replayed: boolean;
}

export interface SaveGeneratedScriptInput {
  scope: ContentWorkspaceScope;
  topic: string;
  format: string;
  scriptText: string;
  platformId?: string | null;
  hook?: string | null;
  titleOptions?: string[];
  sourcesUsed?: unknown[];
  claimsUsed?: unknown[];
  hashtags?: string[];
  caption?: string | null;
  cta?: string | null;
  estimatedDuration?: string | null;
  niche?: string | null;
  generationDurationMs?: number | null;
  sourcePackageId?: string | null;
  topicFeedbackId?: number | null;
  actorType?: ContentRevisionActorType;
  actorId?: string | null;
  idempotencyKey?: string | null;
  /** Optional existing content item that should receive the script artifact. */
  targetItemId?: number | null;
  /** Required CAS version when targetItemId is supplied. */
  expectedWorkflowVersion?: number | null;
  captureOrigin: 'script_generation' | 'approved_variant';
}

export interface CaptureDiscoveredIdeaInput {
  scope: ContentWorkspaceScope;
  title: string;
  sourceDate: string;
  score: number;
  workflowEligible: boolean;
  whyNow?: string | null;
  angleTag?: string | null;
  provider?: string | null;
}

export interface SaveGeneratedScriptRevisionInput {
  scope: ContentWorkspaceScope;
  artifactId: number;
  baseRevision: number;
  scriptText: string;
  sourcesUsed?: unknown[];
  claimsUsed?: unknown[];
  changeSummary?: string | null;
  actorId?: string | null;
  idempotencyKey: string;
  captureOrigin: 'script_generation' | 'approved_variant';
}

export interface ContentWorkspaceGeneratedRevisionResult {
  schemaVersion: typeof CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION;
  workspaceSchemaVersion: typeof CONTENT_WORKSPACE_SCHEMA_VERSION;
  item: ContentWorkspaceItem;
  artifact: ContentArtifact;
  /** Immutable revision produced by the captured mutation. */
  revision: ContentRevision;
  revisionId: number;
  replayed: boolean;
  created: boolean;
}

/**
 * Atomically capture a generated/approved script in the canonical workspace.
 * The revision body is passed through byte-for-byte; no trim, reformat, or
 * lossy packaging conversion is allowed on this persistence boundary.
 */
export function saveGeneratedScriptToWorkspace(
  input: SaveGeneratedScriptInput,
  db: Database.Database = getDb(),
): ContentWorkspaceCaptureResult {
  const topic = requireCaptureText(input.topic, 'topic', 240, true);
  const format = requireCaptureText(input.format, 'format', 120, true);
  const scriptText = requireCaptureText(input.scriptText, 'scriptText', 1_000_000, false);
  const generatedSources = normalizeGeneratedSources(input.sourcesUsed);
  const generatedClaims = normalizeGeneratedClaims(input.claimsUsed, scriptText);
  const actorType = input.actorType ?? 'agent';
  const target = normalizeGeneratedScriptTarget(input.targetItemId, input.expectedWorkflowVersion);
  const payloadFingerprint = digest({
    topic,
    format,
    scriptText,
    platformId: input.platformId ?? null,
    hook: input.hook ?? null,
    titleOptions: input.titleOptions ?? [],
    // Fingerprint only the accepted evidence envelope. Provider-only fields,
    // invalid URLs, and other discarded input must not create false replay
    // conflicts, while every persisted source/claim change must be detected.
    sourcesUsed: generatedSources,
    claimsUsed: generatedClaims,
    hashtags: input.hashtags ?? [],
    caption: input.caption ?? null,
    cta: input.cta ?? null,
    estimatedDuration: input.estimatedDuration ?? null,
    niche: input.niche ?? null,
    generationDurationMs: input.generationDurationMs ?? null,
    sourcePackageId: input.sourcePackageId ?? null,
    topicFeedbackId: input.topicFeedbackId ?? null,
    actorType,
    actorId: input.actorId ?? null,
    captureOrigin: input.captureOrigin,
    targetItemId: target?.itemId ?? null,
    expectedWorkflowVersion: target?.expectedWorkflowVersion ?? null,
  });
  const clientIdempotencyKey = optionalCaptureIdempotencyKey(input.idempotencyKey);
  const captureReceiptKey = clientIdempotencyKey ?? `auto:${payloadFingerprint}`;
  const captureOperation = 'capture_generated_script';
  const ingressIdentity = clientIdempotencyKey
    ? digest(target
      ? {
        clientKey: clientIdempotencyKey,
        targetItemId: target.itemId,
        expectedWorkflowVersion: target.expectedWorkflowVersion,
      }
      : { clientKey: clientIdempotencyKey })
    : payloadFingerprint;
  const itemKey = `capture-script-item:${ingressIdentity}`;
  const artifactKey = `capture-script-artifact:${ingressIdentity}`;

  return db.transaction((): ContentWorkspaceCaptureResult => {
    const receiptRevision = getGeneratedCaptureReceipt({
      scope: input.scope,
      operation: captureOperation,
      idempotencyKey: captureReceiptKey,
      captureFingerprint: payloadFingerprint,
    }, db);
    if (receiptRevision) {
      const authoritative = requireGeneratedRevisionContext(input.scope, receiptRevision.artifactId, db);
      return {
        schemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
        workspaceSchemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        item: authoritative.item,
        artifact: authoritative.artifact,
        revision: receiptRevision,
        revisionId: receiptRevision.id,
        replayed: true,
      };
    }

    let item: ContentWorkspaceItem;
    let itemReplayed = false;
    let sourceArtifactId: number | undefined;
    if (target) {
      const targetItem = getContentWorkspaceItem(input.scope, target.itemId, db);
      if (!targetItem) {
        throw new ContentWorkspaceError(
          'CONTENT_ITEM_NOT_FOUND',
          'Content item not found.',
          404,
        );
      }
      item = targetItem;
      sourceArtifactId = targetItem.currentArtifactId ?? undefined;
    } else {
      const itemMutation = createContentWorkspaceItem({
        scope: input.scope,
        itemType: 'content_item',
        title: topic,
        summary: input.niche?.trim() || null,
        platformId: input.platformId ?? platformForFormat(format),
        formatId: format,
        idempotencyKey: itemKey,
      }, db);
      item = itemMutation.value;
      itemReplayed = itemMutation.replayed;
      if (itemMutation.replayed) {
        const capturedArtifactId = findCapturedArtifactId(
          input.scope,
          item.id,
          payloadFingerprint,
          db,
        );
        if (capturedArtifactId != null) {
          const replay = requireMatchingReplay(
            input.scope,
            item,
            capturedArtifactId,
            payloadFingerprint,
            db,
          );
          ensureGeneratedScriptLineage({
            scope: input.scope,
            revisionId: replay.revisionId,
            generatedSources,
            generatedClaims,
            ingressIdentity,
          }, db);
          putGeneratedCaptureReceipt({
            scope: input.scope,
            operation: captureOperation,
            idempotencyKey: captureReceiptKey,
            captureFingerprint: payloadFingerprint,
            revisionId: replay.revision.id,
          }, db);
          return replay;
        }
        if (item.currentArtifactId != null) {
          throw new ContentWorkspaceError(
            'CONTENT_IDEMPOTENCY_KEY_REUSED',
            'This content capture key was already used for a different request.',
            409,
          );
        }
      }
    }

    const artifactMutation = createContentArtifact({
      scope: input.scope,
      itemId: item.id,
      expectedWorkflowVersion: target?.expectedWorkflowVersion ?? item.workflowVersion,
      artifactType: 'script',
      title: topic,
      platformId: input.platformId ?? platformForFormat(format),
      formatId: format,
      metadata: {
        captureSchemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
        captureFingerprint: payloadFingerprint,
        captureOrigin: input.captureOrigin,
        hook: input.hook ?? null,
        titleOptions: input.titleOptions ?? [],
        // Persist only the normalized reference envelope here. Relevance
        // notes and arbitrary provider fields are untrusted source content,
        // not instructions for later agents.
        sourcesUsed: generatedSources,
        hashtags: input.hashtags ?? [],
        caption: input.caption ?? null,
        cta: input.cta ?? null,
        estimatedDuration: input.estimatedDuration ?? null,
        niche: input.niche ?? null,
        generationDurationMs: input.generationDurationMs ?? null,
        sourcePackageId: input.sourcePackageId ?? null,
        topicFeedbackId: input.topicFeedbackId ?? null,
        targetItemId: target?.itemId ?? null,
      },
      initialContent: { format: 'plain_text', text: scriptText },
      changeSummary: input.captureOrigin === 'approved_variant'
        ? 'Captured user-approved script variant'
        : 'Captured generated script',
      actorType,
      actorId: input.actorId ?? null,
      provenance: {
        captureSchemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
        captureOrigin: input.captureOrigin,
        sourcePackageId: input.sourcePackageId ?? null,
        topicFeedbackId: input.topicFeedbackId ?? null,
        targetItemId: target?.itemId ?? null,
      },
      sourceArtifactId,
      idempotencyKey: artifactKey,
    }, db);
    const authoritativeItem = getContentWorkspaceItem(input.scope, item.id, db);
    if (artifactMutation.replayed) {
      if (!authoritativeItem) {
        throw new ContentWorkspaceError(
          'CONTENT_CAPTURE_INTEGRITY_FAILED',
          'The captured script parent was not readable from the canonical workspace.',
          500,
        );
      }
      const replay = requireMatchingReplay(
        input.scope,
        authoritativeItem,
        artifactMutation.value.id,
        payloadFingerprint,
        db,
      );
      ensureGeneratedScriptLineage({
        scope: input.scope,
        revisionId: replay.revision.id,
        generatedSources,
        generatedClaims,
        ingressIdentity,
      }, db);
      putGeneratedCaptureReceipt({
        scope: input.scope,
        operation: captureOperation,
        idempotencyKey: captureReceiptKey,
        captureFingerprint: payloadFingerprint,
        revisionId: replay.revision.id,
      }, db);
      return replay;
    }
    const capturedRevision = artifactMutation.value.currentRevisionId == null
      ? null
      : getContentRevision(input.scope, artifactMutation.value.currentRevisionId, db);
    if (!authoritativeItem || !capturedRevision) {
      throw new ContentWorkspaceError(
        'CONTENT_CAPTURE_INTEGRITY_FAILED',
        'The captured script was not readable from the canonical workspace.',
        500,
      );
    }
    ensureGeneratedScriptLineage({
      scope: input.scope,
      revisionId: capturedRevision.id,
      generatedSources,
      generatedClaims,
      ingressIdentity,
    }, db);
    putGeneratedCaptureReceipt({
      scope: input.scope,
      operation: captureOperation,
      idempotencyKey: captureReceiptKey,
      captureFingerprint: payloadFingerprint,
      revisionId: capturedRevision.id,
    }, db);
    return {
      schemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
      workspaceSchemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
      item: authoritativeItem,
      artifact: artifactMutation.value,
      revision: capturedRevision,
      revisionId: capturedRevision.id,
      replayed: itemReplayed,
    };
  }).immediate();
}

/**
 * Persist an accepted generator rewrite into an existing canonical artifact.
 * This dedicated server boundary stamps agent provenance and freezes the
 * generated evidence envelope atomically; the generic user-edit endpoint must
 * never be used to relabel AI output as a user-authored revision.
 */
export function saveGeneratedScriptRevisionToWorkspace(
  input: SaveGeneratedScriptRevisionInput,
  db: Database.Database = getDb(),
): ContentWorkspaceGeneratedRevisionResult {
  const artifactId = requireCaptureInteger(input.artifactId, 'artifactId', true);
  const baseRevision = requireCaptureInteger(input.baseRevision, 'baseRevision', false);
  const scriptText = requireCaptureText(input.scriptText, 'scriptText', 1_000_000, false);
  const generatedSources = normalizeGeneratedSources(input.sourcesUsed);
  const generatedClaims = normalizeGeneratedClaims(input.claimsUsed, scriptText);
  const changeSummary = optionalCaptureText(input.changeSummary, 'changeSummary', 2_000)
    ?? (input.captureOrigin === 'approved_variant'
      ? 'Saved a user-accepted generated variant'
      : 'Saved generated script changes');
  const actorId = optionalCaptureText(input.actorId, 'actorId', 200)
    ?? 'content-script-generation';
  const idempotencyKey = requireCaptureIdempotencyKey(input.idempotencyKey);
  const captureFingerprint = digest({
    artifactId,
    baseRevision,
    scriptText,
    sourcesUsed: generatedSources,
    claimsUsed: generatedClaims,
    changeSummary,
    actorId,
    captureOrigin: input.captureOrigin,
  });
  const operation = `capture_generated_revision:${artifactId}`;
  const ingressIdentity = digest({
    artifactId,
    idempotencyKey,
  });

  return db.transaction((): ContentWorkspaceGeneratedRevisionResult => {
    const capturedRevision = getGeneratedCaptureReceipt({
      scope: input.scope,
      operation,
      idempotencyKey,
      captureFingerprint,
      expectedArtifactId: artifactId,
    }, db);
    if (capturedRevision) {
      const authoritative = requireGeneratedRevisionContext(input.scope, artifactId, db);
      return {
        schemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
        workspaceSchemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
        item: authoritative.item,
        artifact: authoritative.artifact,
        revision: capturedRevision,
        revisionId: capturedRevision.id,
        replayed: true,
        created: false,
      };
    }

    const mutation = saveContentRevision({
      scope: input.scope,
      artifactId,
      baseRevision,
      content: { format: 'markdown', text: scriptText },
      changeSummary,
      changeReason: input.captureOrigin,
      actorType: 'agent',
      actorId,
      provenance: {
        captureSchemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
        captureOrigin: input.captureOrigin,
        captureFingerprint,
        userAccepted: input.captureOrigin === 'approved_variant',
      },
      idempotencyKey,
    }, db);
    ensureGeneratedScriptLineage({
      scope: input.scope,
      revisionId: mutation.value.id,
      generatedSources,
      generatedClaims,
      ingressIdentity,
    }, db);
    putGeneratedCaptureReceipt({
      scope: input.scope,
      operation,
      idempotencyKey,
      captureFingerprint,
      revisionId: mutation.value.id,
    }, db);
    const authoritative = requireGeneratedRevisionContext(input.scope, artifactId, db);
    return {
      schemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
      workspaceSchemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
      item: authoritative.item,
      artifact: authoritative.artifact,
      revision: mutation.value,
      revisionId: mutation.value.id,
      replayed: mutation.replayed,
      created: mutation.created,
    };
  }).immediate();
}

interface GeneratedCaptureReceiptRow {
  request_hash: string;
  resource_type: string;
  resource_id: string;
}

function getGeneratedCaptureReceipt(input: {
  scope: ContentWorkspaceScope;
  operation: string;
  idempotencyKey: string;
  captureFingerprint: string;
  expectedArtifactId?: number;
}, db: Database.Database): ContentRevision | null {
  const row = db.prepare(`
    SELECT request_hash, resource_type, resource_id
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
     LIMIT 1
  `).get(
    input.scope.tenantId,
    input.scope.userId,
    input.operation,
    input.idempotencyKey,
  ) as GeneratedCaptureReceiptRow | undefined;
  if (!row) return null;
  if (row.request_hash !== input.captureFingerprint) {
    throw new ContentWorkspaceError(
      'CONTENT_IDEMPOTENCY_KEY_REUSED',
      'This content capture key was already used for a different request.',
      409,
      { operation: input.operation },
    );
  }
  const revisionId = Number(row.resource_id);
  const revision = row.resource_type === 'content_revision' && Number.isSafeInteger(revisionId)
    ? getContentRevision(input.scope, revisionId, db)
    : null;
  if (!revision || (input.expectedArtifactId != null && revision.artifactId !== input.expectedArtifactId)) {
    throw new ContentWorkspaceError(
      'CONTENT_CAPTURE_INTEGRITY_FAILED',
      'The generated revision capture receipt points to unavailable content.',
      500,
    );
  }
  return revision;
}

function putGeneratedCaptureReceipt(input: {
  scope: ContentWorkspaceScope;
  operation: string;
  idempotencyKey: string;
  captureFingerprint: string;
  revisionId: number;
}, db: Database.Database): void {
  db.prepare(`
    INSERT INTO content_mutation_receipts (
      tenant_id, owner_user_id, operation, idempotency_key,
      request_hash, resource_type, resource_id, result_metadata_json
    ) VALUES (?, ?, ?, ?, ?, 'content_revision', ?, ?)
  `).run(
    input.scope.tenantId,
    input.scope.userId,
    input.operation,
    input.idempotencyKey,
    input.captureFingerprint,
    String(input.revisionId),
    JSON.stringify({ captureSchemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION }),
  );
}

function requireGeneratedRevisionContext(
  scope: ContentWorkspaceScope,
  artifactId: number,
  db: Database.Database,
): { item: ContentWorkspaceItem; artifact: ContentArtifact } {
  const artifact = getContentArtifact(scope, artifactId, db);
  const item = artifact ? getContentWorkspaceItem(scope, artifact.itemId, db) : null;
  if (!artifact || !item || !artifact.currentRevision) {
    throw new ContentWorkspaceError(
      'CONTENT_CAPTURE_INTEGRITY_FAILED',
      'The generated revision was not readable from the canonical workspace.',
      500,
    );
  }
  return { item, artifact };
}

function findCapturedArtifactId(
  scope: ContentWorkspaceScope,
  itemId: number,
  captureFingerprint: string,
  db: Database.Database,
): number | null {
  const row = db.prepare(`
    SELECT id
      FROM content_artifacts
     WHERE item_id = ? AND tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private'
       AND scope_status = 'active'
       AND json_extract(metadata_json, '$.captureSchemaVersion') = ?
       AND json_extract(metadata_json, '$.captureFingerprint') = ?
     ORDER BY id ASC
     LIMIT 1
  `).get(
    itemId,
    scope.tenantId,
    scope.userId,
    CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
    captureFingerprint,
  ) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

interface NormalizedGeneratedSource {
  title: string;
  url: string;
  sourceType: string | null;
  relevanceNote: string | null;
  publisher: string | null;
  author: string | null;
  publishedAt: string | null;
  accessedAt: string | null;
}

/**
 * Register generated research references and freeze the exact reference set
 * against the saved revision. Imported source text never receives instruction
 * authority, and malformed entries cannot become lineage records.
 */
function ensureGeneratedScriptLineage(input: {
  scope: ContentWorkspaceScope;
  revisionId: number;
  generatedSources: NormalizedGeneratedSource[];
  generatedClaims: NormalizedGeneratedClaim[];
  ingressIdentity: string;
}, db: Database.Database): void {
  const referenceIdsByUrl = new Map<string, string>();
  for (const source of input.generatedSources) {
    const registered = registerContentWorkspaceSource({
      scope: input.scope,
      referenceType: 'external_research_result',
      title: source.title,
      url: source.url,
      summary: source.relevanceNote,
      metadata: {
        provider: source.sourceType,
        publisher: source.publisher,
        author: source.author,
        publishedAt: source.publishedAt,
        accessedAt: source.accessedAt,
      },
      idempotencyKey: `capture-script-source:${input.ingressIdentity}:${digest(source.url).slice(0, 16)}`,
    }, db).source;
    referenceIdsByUrl.set(source.url, registered.referenceId);
  }
  const referenceIds = [...referenceIdsByUrl.values()];

  // With neither evidence nor extracted claims there is nothing truthful to
  // freeze yet. Leaving lineage unrecorded keeps agent/import approval closed
  // and lets the user attach sources or save a reviewed user revision later.
  if (referenceIds.length === 0 && input.generatedClaims.length === 0) return;

  const claims: ContentWorkspaceClaimInput[] = input.generatedClaims.map((claim) => {
    const supportedBy = claim.support === 'source_backed'
      ? claim.sourceRefs.flatMap((sourceRef) => {
        const referenceId = referenceIdsByUrl.get(sourceRef);
        return referenceId ? [referenceId] : [];
      })
      : [];
    return {
      id: `generated:${digest(claim.text).slice(0, 24)}`,
      text: claim.text,
      supportedBy: [...new Set(supportedBy)],
      confidence: supportedBy.length > 0 ? 0.7 : 0.3,
      riskLevel: generatedClaimRiskLevel(claim.text),
    };
  });

  recordContentRevisionLineage({
    scope: input.scope,
    revisionId: input.revisionId,
    referenceIds,
    claims,
    idempotencyKey: `capture-script-lineage:${input.ingressIdentity}`,
  }, db);
}

interface NormalizedGeneratedClaim {
  text: string;
  support: 'source_backed' | 'creator_memory_backed' | 'unverified';
  sourceRefs: string[];
}

function normalizeGeneratedClaims(value: unknown, scriptText: string): NormalizedGeneratedClaim[] {
  const providerClaims = new Map<string, NormalizedGeneratedClaim>();
  const candidates = Array.isArray(value) ? value.slice(0, 100) : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const text = normalizeGeneratedSourceText(record.claim ?? record.text, 2_000);
    if (!text) continue;
    const support = record.support === 'source_backed'
      || record.support === 'creator_memory_backed'
      || record.support === 'unverified'
      ? record.support
      : 'unverified';
    const sourceRefs = [
      record.sourceRef,
      ...(Array.isArray(record.sourceRefs) ? record.sourceRefs : []),
    ].flatMap((sourceRef) => {
      const normalized = normalizeGeneratedSourceUrl(sourceRef);
      return normalized ? [normalized] : [];
    });
    const key = text.toLocaleLowerCase();
    if (!providerClaims.has(key)) providerClaims.set(key, {
      text,
      support,
      sourceRefs: [...new Set(sourceRefs)],
    });
  }
  // Treat provider claim ledgers as untrusted hints. A provider can omit a
  // claim, label it standard, or hide domain words behind separators. Derive
  // high-risk statements again from the persisted bytes and fail closed when
  // they have no independently eligible evidence.
  const byText = new Map<string, NormalizedGeneratedClaim>();
  for (const text of extractHighRiskContentClaims(scriptText, 100)) {
    const key = text.toLocaleLowerCase();
    byText.set(key, providerClaims.get(key) ?? { text, support: 'unverified', sourceRefs: [] });
  }
  // High-risk server-derived claims take capacity precedence, so a hostile or
  // malformed 100-entry provider ledger cannot crowd them out.
  for (const [key, claim] of providerClaims) {
    if (byText.size >= 100) break;
    if (!byText.has(key)) byText.set(key, claim);
  }
  return Array.from(byText.values()).sort((left, right) => left.text.localeCompare(right.text));
}

function generatedClaimRiskLevel(text: string): 'standard' | 'sensitive' | 'regulated' {
  return classifyContentClaimRisk(text);
}

/**
 * The Python engine normally supplies SourceReference objects, while some
 * provider paths return URL strings. Accept only those two explicit shapes.
 * Invalid entries are ignored so an unsafe source cannot prevent the user's
 * already-generated script from being saved or leak arbitrary payload fields.
 */
function normalizeGeneratedSources(value: unknown): NormalizedGeneratedSource[] {
  if (!Array.isArray(value)) return [];
  const byUrl = new Map<string, NormalizedGeneratedSource>();
  for (const candidate of value.slice(0, 50)) {
    const normalized = normalizeGeneratedSource(candidate);
    if (normalized && !byUrl.has(normalized.url)) byUrl.set(normalized.url, normalized);
  }
  return Array.from(byUrl.values()).sort((left, right) => left.url.localeCompare(right.url));
}

function normalizeGeneratedSource(value: unknown): NormalizedGeneratedSource | null {
  if (typeof value === 'string') {
    const url = normalizeGeneratedSourceUrl(value);
    if (!url) return null;
    return {
      title: sourceTitleFromUrl(url),
      url,
      sourceType: null,
      relevanceNote: null,
      publisher: null,
      author: null,
      publishedAt: null,
      accessedAt: null,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = normalizeGeneratedSourceUrl(record.url);
  if (!url) return null;
  const requestedTitle = normalizeGeneratedSourceText(record.title, 240);
  const sourceType = normalizeGeneratedSourceType(record.source_type ?? record.sourceType);
  return {
    title: requestedTitle ?? sourceTitleFromUrl(url),
    url,
    sourceType,
    relevanceNote: normalizeGeneratedSourceRelevanceNote(record.relevance_note ?? record.relevanceNote),
    publisher: normalizeGeneratedSourceText(record.publisher, 240),
    author: normalizeGeneratedSourceText(record.author, 240),
    publishedAt: normalizeGeneratedSourceDate(record.published_at ?? record.publishedAt),
    accessedAt: normalizeGeneratedSourceDate(record.accessed_at ?? record.accessedAt),
  };
}

function normalizeGeneratedSourceRelevanceNote(value: unknown): string | null {
  const normalized = normalizeGeneratedSourceText(value, 500);
  if (!normalized) return null;
  return /ignore (?:the |all |previous |above )*instructions|disregard (?:the |all |previous |above )*instructions|you are now|<\|im_start\|>|<system>/iu.test(normalized)
    ? null
    : normalized;
}

function normalizeGeneratedSourceDate(value: unknown): string | null {
  const normalized = normalizeGeneratedSourceText(value, 80);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeGeneratedSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(access_?token|token|api_?key|key|auth|authorization|signature|sig)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeGeneratedSourceText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeGeneratedSourceType(value: unknown): string | null {
  const normalized = normalizeGeneratedSourceText(value, 80)?.toLowerCase() ?? null;
  return normalized && /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : null;
}

function sourceTitleFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.hostname || 'Research source';
  } catch {
    return 'Research source';
  }
}

/** Capture discovery output once per normalized title and private scope. */
export function captureDiscoveredIdea(
  input: CaptureDiscoveredIdeaInput,
  db: Database.Database = getDb(),
): ContentWorkspaceCaptureResult {
  const title = requireCaptureText(input.title, 'title', 240, true);
  const normalizedTitle = normalizeTitle(title);
  const identity = digest({ source: 'discovery', normalizedTitle });
  const fingerprint = identity;

  return db.transaction((): ContentWorkspaceCaptureResult => {
    const existing = db.prepare(`
      SELECT artifact.id AS artifact_id, item.id AS item_id
        FROM content_artifacts AS artifact
        JOIN content_domain_objects AS item
          ON item.id = artifact.item_id
         AND item.tenant_id = artifact.tenant_id
         AND item.owner_user_id = artifact.owner_user_id
       WHERE artifact.tenant_id = ? AND artifact.owner_user_id = ?
         AND artifact.visibility_scope = 'user_private'
         AND artifact.scope_status = 'active'
         AND item.visibility_scope = 'user_private'
         AND item.scope_status = 'active'
         AND item.deleted_at IS NULL
         AND json_extract(artifact.metadata_json, '$.captureSchemaVersion') = ?
         AND json_extract(artifact.metadata_json, '$.captureFingerprint') = ?
       LIMIT 1
    `).get(
      input.scope.tenantId,
      input.scope.userId,
      CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
      fingerprint,
    ) as { artifact_id: number; item_id: number } | undefined;
    if (existing) {
      const item = getContentWorkspaceItem(input.scope, Number(existing.item_id), db);
      if (!item) {
        throw new ContentWorkspaceError(
          'CONTENT_CAPTURE_INTEGRITY_FAILED',
          'The discovered idea capture points to an unavailable workspace item.',
          500,
        );
      }
      return requireMatchingReplay(
        input.scope,
        item,
        Number(existing.artifact_id),
        fingerprint,
        db,
      );
    }
    const itemMutation = createContentWorkspaceItem({
      scope: input.scope,
      itemType: 'content_item',
      title,
      summary: input.whyNow?.trim() || null,
      idempotencyKey: `capture-discovery-item:${identity}`,
    }, db);
    if (itemMutation.replayed && itemMutation.value.currentArtifactId != null) {
      return requireMatchingReplay(
        input.scope,
        itemMutation.value,
        itemMutation.value.currentArtifactId,
        fingerprint,
        db,
      );
    }

    const artifactMutation = createContentArtifact({
      scope: input.scope,
      itemId: itemMutation.value.id,
      expectedWorkflowVersion: itemMutation.value.workflowVersion,
      artifactType: 'idea_note',
      title,
      metadata: {
        captureSchemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
        captureFingerprint: fingerprint,
        captureOrigin: 'discovery',
        sourceDate: input.sourceDate,
        score: input.score,
        workflowEligible: input.workflowEligible,
        whyNow: input.whyNow ?? null,
        angleTag: input.angleTag ?? null,
        provider: input.provider ?? null,
      },
      initialContent: { format: 'plain_text', text: title },
      changeSummary: 'Captured discovered content idea',
      actorType: 'agent',
      actorId: 'content-discovery',
      provenance: {
        captureSchemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
        captureOrigin: 'discovery',
        provider: input.provider ?? null,
        sourceDate: input.sourceDate,
      },
      idempotencyKey: `capture-discovery-artifact:${identity}`,
    }, db);
    const item = getContentWorkspaceItem(input.scope, itemMutation.value.id, db);
    const capturedRevision = artifactMutation.value.currentRevisionId == null
      ? null
      : getContentRevision(input.scope, artifactMutation.value.currentRevisionId, db);
    if (!item || !capturedRevision) {
      throw new ContentWorkspaceError(
        'CONTENT_CAPTURE_INTEGRITY_FAILED',
        'The discovered idea was not readable from the canonical workspace.',
        500,
      );
    }
    return {
      schemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
      workspaceSchemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
      item,
      artifact: artifactMutation.value,
      revision: capturedRevision,
      revisionId: capturedRevision.id,
      replayed: itemMutation.replayed || artifactMutation.replayed,
    };
  }).immediate();
}

function requireMatchingReplay(
  scope: ContentWorkspaceScope,
  item: ContentWorkspaceItem,
  artifactId: number,
  expectedFingerprint: string,
  db: Database.Database,
): ContentWorkspaceCaptureResult {
  const artifact = getContentArtifact(scope, artifactId, db);
  if (
    !artifact
    || artifact.itemId !== item.id
    || artifact.currentRevisionId == null
    || artifact.metadata.captureSchemaVersion !== CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION
    || artifact.metadata.captureFingerprint !== expectedFingerprint
  ) {
    throw new ContentWorkspaceError(
      'CONTENT_IDEMPOTENCY_KEY_REUSED',
      'This content capture key was already used for a different request.',
      409,
    );
  }
  const capturedRevisionRow = db.prepare(`
    SELECT id
      FROM content_revisions
     WHERE artifact_id = ? AND tenant_id = ? AND owner_user_id = ?
     ORDER BY revision_number ASC, id ASC
     LIMIT 1
  `).get(artifact.id, scope.tenantId, scope.userId) as { id: number } | undefined;
  if (!capturedRevisionRow) {
    throw new ContentWorkspaceError(
      'CONTENT_CAPTURE_INTEGRITY_FAILED',
      'The original captured script revision is unavailable.',
      500,
    );
  }
  const capturedRevision = getContentRevision(scope, Number(capturedRevisionRow.id), db);
  if (!capturedRevision) {
    throw new ContentWorkspaceError(
      'CONTENT_CAPTURE_INTEGRITY_FAILED',
      'The original captured script revision is unavailable.',
      500,
    );
  }
  return {
    schemaVersion: CONTENT_WORKSPACE_CAPTURE_SCHEMA_VERSION,
    workspaceSchemaVersion: CONTENT_WORKSPACE_SCHEMA_VERSION,
    item,
    artifact,
    revision: capturedRevision,
    // Replays resolve the revision created by this capture, never a newer
    // user edit that has since advanced the artifact's current pointer.
    revisionId: capturedRevision.id,
    replayed: true,
  };
}

function platformForFormat(format: string): string | null {
  const normalized = format.trim().toLowerCase();
  if (normalized.includes('youtube')) return 'youtube';
  if (normalized.includes('reel') || normalized.includes('instagram')) return 'instagram';
  if (normalized.includes('tiktok')) return 'tiktok';
  if (normalized.includes('linkedin')) return 'linkedin';
  return null;
}

function requireCaptureText(
  value: unknown,
  field: string,
  maxLength: number,
  trim: boolean,
): string {
  if (typeof value !== 'string') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} is required.`, 400, { field });
  }
  const normalized = trim ? value.trim() : value;
  if (!normalized.trim() || normalized.length > maxLength) {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      `${field} must contain 1 to ${maxLength} characters.`,
      400,
      { field },
    );
  }
  return normalized;
}

function optionalCaptureText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ContentWorkspaceError('CONTENT_VALIDATION_FAILED', `${field} must be a string.`, 400, { field });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      `${field} exceeds ${maxLength} characters.`,
      400,
      { field },
    );
  }
  return normalized;
}

function optionalCaptureIdempotencyKey(value: unknown): string | null {
  if (value == null) return null;
  return requireCaptureIdempotencyKey(value);
}

function normalizeGeneratedScriptTarget(
  targetItemId: unknown,
  expectedWorkflowVersion: unknown,
): { itemId: number; expectedWorkflowVersion: number } | null {
  const hasTarget = targetItemId != null;
  const hasVersion = expectedWorkflowVersion != null;
  if (!hasTarget && !hasVersion) return null;
  if (!hasTarget || !hasVersion) {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      'targetItemId and expectedWorkflowVersion must be supplied together.',
      400,
      { fields: ['targetItemId', 'expectedWorkflowVersion'] },
    );
  }
  return {
    itemId: requireCaptureInteger(targetItemId, 'targetItemId', true),
    expectedWorkflowVersion: requireCaptureInteger(expectedWorkflowVersion, 'expectedWorkflowVersion', true),
  };
}

function requireCaptureIdempotencyKey(value: unknown): string {
  const key = requireCaptureText(value, 'idempotencyKey', 200, true);
  if (key.length < 8) {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      'idempotencyKey must contain at least 8 characters.',
      400,
      { field: 'idempotencyKey' },
    );
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(key)) {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      'idempotencyKey contains unsupported control characters.',
      400,
      { field: 'idempotencyKey' },
    );
  }
  return key;
}

function requireCaptureInteger(value: unknown, field: string, positive: boolean): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (positive ? Number(parsed) <= 0 : Number(parsed) < 0)) {
    throw new ContentWorkspaceError(
      'CONTENT_VALIDATION_FAILED',
      `${field} must be a ${positive ? 'positive' : 'non-negative'} integer.`,
      400,
      { field },
    );
  }
  return Number(parsed);
}

function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

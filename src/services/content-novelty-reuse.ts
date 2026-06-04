// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import {
  contentDirectScopePredicate,
  contentScopeForInsert,
  contentScopeParams,
  resolveContentTenantId,
  type ContentVisibilityScope,
} from './content-tenant-scope';
import type {
  ContentFormatId,
  ContentObjectType,
  ContentPlatformId,
} from './content-domain-ontology';
import { contentBigramDice, contentTokenJaccard } from './content-text-utils';

export type ContentReuseIntent =
  | 'none'
  | 'repurpose'
  | 'adapt_platform'
  | 'series'
  | 'revisit_with_new_angle'
  | 'reuse_successful_pattern';

export type ContentTransformationType =
  | 'youtube_to_shorts'
  | 'book_to_thread'
  | 'linkedin_to_newsletter'
  | 'platform_adaptation'
  | 'series_continuation'
  | 'new_angle'
  | 'successful_pattern_variation'
  | 'generic_repurpose';

export type ContentNoveltyStatus =
  | 'novel'
  | 'near_duplicate'
  | 'duplicate'
  | 'stale_repetition'
  | 'allowed_reuse'
  | 'series_related'
  | 'needs_new_angle';

export type ContentArtifactType = ContentObjectType | string;

export interface ContentNoveltyCandidateInput {
  userId: number;
  tenantId?: number;
  visibilityScope?: ContentVisibilityScope;
  candidateId?: string;
  artifactType: ContentArtifactType;
  title?: string | null;
  body?: string | null;
  hook?: string | null;
  caption?: string | null;
  topic?: string | null;
  angle?: string | null;
  platformId?: ContentPlatformId | string | null;
  formatId?: ContentFormatId | string | null;
  audience?: string | null;
  contentPillar?: string | null;
  referenceIds?: readonly (string | number)[];
  sourceRadarSignalId?: string | number | null;
  seriesId?: string | number | null;
  reuseIntent?: ContentReuseIntent | string | null;
  originalContentId?: string | number | null;
  transformationType?: ContentTransformationType | string | null;
  allowStrategicReuse?: boolean;
  lifecycleState?: string;
  createdBy?: number;
  metadata?: Record<string, unknown>;
}

export interface ContentNoveltyCandidate {
  id: number;
  candidateId: string;
  tenantId: number;
  ownerUserId: number;
  visibilityScope: string;
  artifactType: string;
  title: string | null;
  body: string | null;
  hook: string | null;
  caption: string | null;
  topic: string | null;
  angle: string | null;
  platformId: string | null;
  formatId: string | null;
  audience: string | null;
  contentPillar: string | null;
  referenceIds: string[];
  sourceRadarSignalId: string | null;
  seriesId: string | null;
  reuseIntent: string;
  originalContentId: string | null;
  transformationType: string | null;
  noveltyScore: number;
  duplicationRiskScore: number;
  lifecycleState: string;
  reasonCodes: string[];
  reviewWarnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ContentNoveltyMatch {
  candidateId: string;
  artifactType: string;
  title: string | null;
  topic: string | null;
  hook: string | null;
  platformId: string | null;
  formatId: string | null;
  seriesId: string | null;
  originalContentId: string | null;
  riskScore: number;
  similarity: number;
  reasonCodes: string[];
}

export interface ContentNoveltyDecision {
  status: ContentNoveltyStatus;
  noveltyScore: number;
  duplicationRisk: number;
  reuseAllowed: boolean;
  matchedCandidates: ContentNoveltyMatch[];
  reasonCodes: string[];
  reviewWarnings: string[];
  strategicReuse: {
    intent: string;
    originalContentId: string | null;
    transformationType: string | null;
    platformChanged: boolean;
    formatChanged: boolean;
    angleChanged: boolean;
    referenceChanged: boolean;
  };
}

export interface ContentRepurposeInput {
  userId: number;
  tenantId?: number;
  visibilityScope?: ContentVisibilityScope;
  reuseId?: string;
  originalContentId: string | number;
  reusedContentId: string | number;
  originalArtifactType: ContentArtifactType;
  reusedArtifactType: ContentArtifactType;
  transformationType: ContentTransformationType | string;
  fromPlatformId?: string | null;
  toPlatformId?: string | null;
  referencesPreserved?: readonly (string | number)[];
  referencesChanged?: readonly (string | number)[];
  noveltyScore?: number;
  reasonCodes?: readonly string[];
  status?: 'planned' | 'created' | 'reviewed' | 'published' | 'archived';
  createdBy?: number;
  metadata?: Record<string, unknown>;
}

export interface ContentRepurposeRecord {
  id: number;
  reuseId: string;
  tenantId: number;
  ownerUserId: number;
  originalContentId: string;
  reusedContentId: string;
  originalArtifactType: string;
  reusedArtifactType: string;
  transformationType: string;
  fromPlatformId: string | null;
  toPlatformId: string | null;
  referencesPreserved: string[];
  referencesChanged: string[];
  noveltyScore: number;
  reasonCodes: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

const ACTIVE_CANDIDATE_STATES = new Set(['active', 'idea', 'planned', 'drafted', 'approved', 'scheduled', 'published', 'repurposed']);
const STRATEGIC_REUSE_INTENTS = new Set(['repurpose', 'adapt_platform', 'series', 'revisit_with_new_angle', 'reuse_successful_pattern']);
const ensured = new WeakSet<object>();

const NOVELTY_REUSE_DDL = `
  CREATE TABLE IF NOT EXISTS content_novelty_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL UNIQUE,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    artifact_type TEXT NOT NULL,
    title TEXT,
    body TEXT,
    hook TEXT,
    caption TEXT,
    topic TEXT,
    angle TEXT,
    normalized_text TEXT NOT NULL,
    normalized_topic TEXT,
    normalized_hook TEXT,
    normalized_angle TEXT,
    platform_id TEXT,
    format_id TEXT,
    audience TEXT,
    content_pillar TEXT,
    reference_ids_json TEXT NOT NULL DEFAULT '[]',
    source_radar_signal_id TEXT,
    series_id TEXT,
    reuse_intent TEXT NOT NULL DEFAULT 'none',
    original_content_id TEXT,
    transformation_type TEXT,
    novelty_score REAL NOT NULL DEFAULT 1.0,
    duplication_risk_score REAL NOT NULL DEFAULT 0.0,
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    review_warnings_json TEXT NOT NULL DEFAULT '[]',
    matched_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
    lifecycle_state TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_content_novelty_candidates_scope
    ON content_novelty_candidates(tenant_id, owner_user_id, visibility_scope, scope_status, artifact_type, lifecycle_state);
  CREATE INDEX IF NOT EXISTS idx_content_novelty_candidates_topic
    ON content_novelty_candidates(tenant_id, normalized_topic, artifact_type, platform_id, format_id);
  CREATE INDEX IF NOT EXISTS idx_content_novelty_candidates_reuse
    ON content_novelty_candidates(tenant_id, original_content_id, series_id, source_radar_signal_id);

  CREATE TABLE IF NOT EXISTS content_repurpose_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reuse_id TEXT NOT NULL UNIQUE,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'user_private',
    scope_status TEXT NOT NULL DEFAULT 'active',
    original_content_id TEXT NOT NULL,
    reused_content_id TEXT NOT NULL,
    original_artifact_type TEXT NOT NULL,
    reused_artifact_type TEXT NOT NULL,
    transformation_type TEXT NOT NULL,
    from_platform_id TEXT,
    to_platform_id TEXT,
    references_preserved_json TEXT NOT NULL DEFAULT '[]',
    references_changed_json TEXT NOT NULL DEFAULT '[]',
    novelty_score REAL NOT NULL DEFAULT 0.5,
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'created',
    created_by INTEGER NOT NULL,
    updated_by INTEGER NOT NULL,
    audit_metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, owner_user_id, original_content_id, reused_content_id, transformation_type)
  );
  CREATE INDEX IF NOT EXISTS idx_content_repurpose_history_scope
    ON content_repurpose_history(tenant_id, owner_user_id, visibility_scope, scope_status, status);
  CREATE INDEX IF NOT EXISTS idx_content_repurpose_history_original
    ON content_repurpose_history(tenant_id, original_content_id, transformation_type);
`;

export function ensureContentNoveltyReuseTables(db: any = getDb()): void {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') return;
  if (ensured.has(db as object)) return;
  db.exec(NOVELTY_REUSE_DDL);
  ensured.add(db as object);
}

export function assessContentNovelty(input: ContentNoveltyCandidateInput): ContentNoveltyDecision {
  const db = getDb();
  ensureContentNoveltyReuseTables(db);
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  const candidate = normalizeCandidateInput(input, tenantId);
  const existing = loadComparableCandidates(db, input.userId, tenantId);
  const matches = existing
    .map((row) => scoreCandidateMatch(candidate, row))
    .filter((match) => match.riskScore >= 0.3 || match.reasonCodes.length > 0)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 8);
  const maxRisk = matches[0]?.riskScore ?? 0;
  const strategicReuse = buildStrategicReuse(candidate, matches);
  const reasonCodes = new Set<string>();
  const reviewWarnings = new Set<string>();
  for (const match of matches) {
    for (const code of match.reasonCodes) reasonCodes.add(code);
  }

  const overusedReferences = findOverusedReferences(candidate.referenceIds, existing);
  for (const ref of overusedReferences) {
    reasonCodes.add('overused_reference');
    reviewWarnings.add(`Reference ${ref} is being reused heavily in this tenant/user scope.`);
  }

  let status: ContentNoveltyStatus = 'novel';
  let reuseAllowed = false;
  if (strategicReuse.intent !== 'none' && STRATEGIC_REUSE_INTENTS.has(strategicReuse.intent)) {
    const variationScore = strategicVariationScore(strategicReuse);
    if (strategicReuse.intent === 'series' && candidate.seriesId && variationScore >= 0.18) {
      status = 'series_related';
      reuseAllowed = true;
      reasonCodes.add('content_series_related_idea_allowed');
    } else if ((candidate.originalContentId || candidate.seriesId) && variationScore >= 0.22) {
      status = 'allowed_reuse';
      reuseAllowed = true;
      reasonCodes.add(`intentional_${strategicReuse.intent}_allowed`);
    } else if (strategicReuse.intent === 'reuse_successful_pattern' && variationScore >= 0.22) {
      status = 'allowed_reuse';
      reuseAllowed = true;
      reasonCodes.add('successful_pattern_variation_allowed');
    } else {
      status = 'needs_new_angle';
      reasonCodes.add('strategic_reuse_needs_new_angle');
      reviewWarnings.add('Intentional reuse is allowed, but this candidate needs a clearer new angle, platform adaptation, reference change, or series role.');
    }
  } else if (matches.some((match) => match.reasonCodes.includes('repeated_stale_radar_signal'))) {
    status = 'stale_repetition';
    reasonCodes.add('repeated_stale_radar_signal');
    reviewWarnings.add('This radar signal has already produced scoped content; avoid resurfacing it without a new angle.');
  } else if (maxRisk >= 0.9) {
    status = 'duplicate';
    reasonCodes.add('exact_or_high_confidence_duplicate');
    reviewWarnings.add('This looks like a duplicate of existing scoped content.');
  } else if (maxRisk >= 0.72) {
    status = 'near_duplicate';
    reasonCodes.add('near_duplicate_candidate');
    reviewWarnings.add('This is close to existing scoped content; ask for a new angle or transform it intentionally.');
  }

  const noveltyScore = scoreNovelty(status, maxRisk, strategicReuse);
  if (status === 'novel' && matches.length === 0) reasonCodes.add('no_recent_scoped_duplicate_found');

  return {
    status,
    noveltyScore,
    duplicationRisk: roundScore(maxRisk),
    reuseAllowed,
    matchedCandidates: matches,
    reasonCodes: [...reasonCodes],
    reviewWarnings: [...reviewWarnings],
    strategicReuse,
  };
}

export function recordContentNoveltyCandidate(
  input: ContentNoveltyCandidateInput,
  decision: ContentNoveltyDecision = assessContentNovelty(input),
): ContentNoveltyCandidate {
  const db = getDb();
  ensureContentNoveltyReuseTables(db);
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  const candidate = normalizeCandidateInput(input, tenantId);
  const scope = contentScopeForInsert(input.userId, tenantId, input.visibilityScope ?? 'user_private', input.lifecycleState ?? 'active');
  const actor = input.createdBy ?? input.userId;
  const matchedIds = decision.matchedCandidates.map((match) => match.candidateId);

  db.prepare(`
    INSERT INTO content_novelty_candidates (
      candidate_id, tenant_id, owner_user_id, visibility_scope, scope_status,
      artifact_type, title, body, hook, caption, topic, angle,
      normalized_text, normalized_topic, normalized_hook, normalized_angle,
      platform_id, format_id, audience, content_pillar, reference_ids_json,
      source_radar_signal_id, series_id, reuse_intent, original_content_id,
      transformation_type, novelty_score, duplication_risk_score,
      reason_codes_json, review_warnings_json, matched_candidate_ids_json,
      lifecycle_state, created_by, updated_by, audit_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      hook = excluded.hook,
      caption = excluded.caption,
      topic = excluded.topic,
      angle = excluded.angle,
      normalized_text = excluded.normalized_text,
      normalized_topic = excluded.normalized_topic,
      normalized_hook = excluded.normalized_hook,
      normalized_angle = excluded.normalized_angle,
      platform_id = excluded.platform_id,
      format_id = excluded.format_id,
      audience = excluded.audience,
      content_pillar = excluded.content_pillar,
      reference_ids_json = excluded.reference_ids_json,
      source_radar_signal_id = excluded.source_radar_signal_id,
      series_id = excluded.series_id,
      reuse_intent = excluded.reuse_intent,
      original_content_id = excluded.original_content_id,
      transformation_type = excluded.transformation_type,
      novelty_score = excluded.novelty_score,
      duplication_risk_score = excluded.duplication_risk_score,
      reason_codes_json = excluded.reason_codes_json,
      review_warnings_json = excluded.review_warnings_json,
      matched_candidate_ids_json = excluded.matched_candidate_ids_json,
      lifecycle_state = excluded.lifecycle_state,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run(
    candidate.candidateId,
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.scopeStatus,
    candidate.artifactType,
    candidate.title,
    candidate.body,
    candidate.hook,
    candidate.caption,
    candidate.topic,
    candidate.angle,
    candidate.normalizedText,
    candidate.normalizedTopic,
    candidate.normalizedHook,
    candidate.normalizedAngle,
    candidate.platformId,
    candidate.formatId,
    candidate.audience,
    candidate.contentPillar,
    JSON.stringify(candidate.referenceIds),
    candidate.sourceRadarSignalId,
    candidate.seriesId,
    candidate.reuseIntent,
    candidate.originalContentId,
    candidate.transformationType,
    decision.noveltyScore,
    decision.duplicationRisk,
    JSON.stringify(decision.reasonCodes),
    JSON.stringify(decision.reviewWarnings),
    JSON.stringify(matchedIds),
    input.lifecycleState ?? 'active',
    actor,
    actor,
    JSON.stringify(input.metadata ?? {}),
  );

  const row = db.prepare('SELECT * FROM content_novelty_candidates WHERE candidate_id = ?').get(candidate.candidateId) as any;
  return mapCandidateRow(row);
}

export function recordContentRepurpose(input: ContentRepurposeInput): ContentRepurposeRecord {
  const db = getDb();
  ensureContentNoveltyReuseTables(db);
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  const scope = contentScopeForInsert(input.userId, tenantId, input.visibilityScope ?? 'user_private');
  const actor = input.createdBy ?? input.userId;
  const reuseId = input.reuseId ?? makeReuseId(input, tenantId);

  db.prepare(`
    INSERT INTO content_repurpose_history (
      reuse_id, tenant_id, owner_user_id, visibility_scope, scope_status,
      original_content_id, reused_content_id, original_artifact_type, reused_artifact_type,
      transformation_type, from_platform_id, to_platform_id,
      references_preserved_json, references_changed_json, novelty_score,
      reason_codes_json, status, created_by, updated_by, audit_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, owner_user_id, original_content_id, reused_content_id, transformation_type)
    DO UPDATE SET
      from_platform_id = excluded.from_platform_id,
      to_platform_id = excluded.to_platform_id,
      references_preserved_json = excluded.references_preserved_json,
      references_changed_json = excluded.references_changed_json,
      novelty_score = excluded.novelty_score,
      reason_codes_json = excluded.reason_codes_json,
      status = excluded.status,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run(
    reuseId,
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.scopeStatus,
    String(input.originalContentId),
    String(input.reusedContentId),
    String(input.originalArtifactType),
    String(input.reusedArtifactType),
    String(input.transformationType),
    input.fromPlatformId ?? null,
    input.toPlatformId ?? null,
    JSON.stringify(normalizeIdList(input.referencesPreserved ?? [])),
    JSON.stringify(normalizeIdList(input.referencesChanged ?? [])),
    clamp01(input.noveltyScore ?? 0.65),
    JSON.stringify(input.reasonCodes ?? []),
    input.status ?? 'created',
    actor,
    actor,
    JSON.stringify(input.metadata ?? {}),
  );

  const row = db.prepare(`
    SELECT * FROM content_repurpose_history
     WHERE tenant_id = ? AND owner_user_id = ? AND original_content_id = ? AND reused_content_id = ? AND transformation_type = ?
  `).get(
    tenantId,
    input.userId,
    String(input.originalContentId),
    String(input.reusedContentId),
    String(input.transformationType),
  ) as any;
  return mapRepurposeRow(row);
}

export function listContentReuseHistory(input: {
  userId: number;
  tenantId?: number;
  originalContentId?: string | number;
  limit?: number;
}): ContentRepurposeRecord[] {
  const db = getDb();
  ensureContentNoveltyReuseTables(db);
  const params: unknown[] = [...contentScopeParams(input.userId, input.tenantId)];
  const originalClause = input.originalContentId != null ? 'AND original_content_id = ?' : '';
  if (input.originalContentId != null) params.push(String(input.originalContentId));
  params.push(Math.max(1, Math.min(100, input.limit ?? 50)));
  const rows = db.prepare(`
    SELECT *
      FROM content_repurpose_history
     WHERE ${contentDirectScopePredicate()}
       ${originalClause}
     ORDER BY updated_at DESC
     LIMIT ?
  `).all(...params) as any[];
  return rows.map(mapRepurposeRow);
}

export function listContentReuseLineage(input: {
  userId: number;
  tenantId?: number;
  contentId?: string | number;
  limit?: number;
}): ContentRepurposeRecord[] {
  const db = getDb();
  ensureContentNoveltyReuseTables(db);
  const params: unknown[] = [...contentScopeParams(input.userId, input.tenantId)];
  const lineageClause = input.contentId != null ? 'AND (original_content_id = ? OR reused_content_id = ?)' : '';
  if (input.contentId != null) {
    params.push(String(input.contentId), String(input.contentId));
  }
  params.push(Math.max(1, Math.min(100, input.limit ?? 50)));
  const rows = db.prepare(`
    SELECT *
      FROM content_repurpose_history
     WHERE ${contentDirectScopePredicate()}
       ${lineageClause}
     ORDER BY updated_at DESC
     LIMIT ?
  `).all(...params) as any[];
  return rows.map(mapRepurposeRow);
}

export function buildContentNoveltyConstraintLines(decision: ContentNoveltyDecision): string[] {
  const lines = [
    `Novelty status: ${decision.status}`,
    `Novelty score: ${decision.noveltyScore.toFixed(2)}; duplication risk: ${decision.duplicationRisk.toFixed(2)}`,
  ];
  if (decision.reuseAllowed) {
    lines.push(`Intentional reuse is allowed as ${decision.strategicReuse.intent}; preserve lineage and make the transformation explicit.`);
  }
  if (decision.status === 'near_duplicate' || decision.status === 'duplicate' || decision.status === 'needs_new_angle') {
    lines.push('Do not repeat the same hook, script, caption, or angle; create a meaningfully different angle or ask for review.');
  }
  if (decision.status === 'stale_repetition') {
    lines.push('Do not resurface this stale radar signal unless the user explicitly requests reuse with a new angle.');
  }
  if (decision.matchedCandidates.length > 0) {
    lines.push(`Closest scoped matches: ${decision.matchedCandidates.slice(0, 3).map((match) => match.candidateId).join(', ')}`);
  }
  for (const warning of decision.reviewWarnings) lines.push(`Review warning: ${warning}`);
  return lines;
}

interface NormalizedCandidate {
  tenantId: number;
  userId: number;
  candidateId: string;
  artifactType: string;
  title: string | null;
  body: string | null;
  hook: string | null;
  caption: string | null;
  topic: string | null;
  angle: string | null;
  normalizedText: string;
  normalizedTopic: string | null;
  normalizedHook: string | null;
  normalizedAngle: string | null;
  platformId: string | null;
  formatId: string | null;
  audience: string | null;
  contentPillar: string | null;
  referenceIds: string[];
  sourceRadarSignalId: string | null;
  seriesId: string | null;
  reuseIntent: string;
  originalContentId: string | null;
  transformationType: string | null;
}

function normalizeCandidateInput(input: ContentNoveltyCandidateInput, tenantId: number): NormalizedCandidate {
  const title = cleanText(input.title);
  const body = cleanText(input.body);
  const hook = cleanText(input.hook);
  const caption = cleanText(input.caption);
  const topic = cleanText(input.topic ?? title);
  const angle = cleanText(input.angle);
  const normalizedText = normalizeContentText([topic, title, hook, caption, body].filter(Boolean).join(' '));
  const candidate: NormalizedCandidate = {
    tenantId,
    userId: input.userId,
    candidateId: input.candidateId ?? '',
    artifactType: normalizeLabel(input.artifactType || 'idea'),
    title,
    body,
    hook,
    caption,
    topic,
    angle,
    normalizedText,
    normalizedTopic: topic ? normalizeContentText(topic) : null,
    normalizedHook: hook ? normalizeContentText(hook) : null,
    normalizedAngle: angle ? normalizeContentText(angle) : null,
    platformId: normalizeNullableTag(input.platformId),
    formatId: normalizeNullableTag(input.formatId),
    audience: cleanText(input.audience),
    contentPillar: cleanText(input.contentPillar),
    referenceIds: normalizeIdList(input.referenceIds ?? []),
    sourceRadarSignalId: input.sourceRadarSignalId != null ? String(input.sourceRadarSignalId) : null,
    seriesId: input.seriesId != null ? String(input.seriesId) : null,
    reuseIntent: inferReuseIntent(input),
    originalContentId: input.originalContentId != null ? String(input.originalContentId) : null,
    transformationType: input.transformationType != null ? normalizeLabel(input.transformationType) : null,
  };
  candidate.candidateId = input.candidateId ?? makeCandidateId(candidate);
  return candidate;
}

function loadComparableCandidates(db: any, userId: number, tenantId: number): ContentNoveltyCandidate[] {
  const rows = db.prepare(`
    SELECT *
      FROM content_novelty_candidates
     WHERE ${contentDirectScopePredicate()}
       AND lifecycle_state NOT IN ('archived', 'rejected', 'deleted', 'cancelled')
     ORDER BY datetime(created_at) DESC
     LIMIT 1000
  `).all(...contentScopeParams(userId, tenantId)) as any[];
  return rows.map(mapCandidateRow).filter((row) => ACTIVE_CANDIDATE_STATES.has(row.lifecycleState));
}

function inferReuseIntent(input: ContentNoveltyCandidateInput): string {
  if (input.reuseIntent != null) return normalizeReuseIntent(input.reuseIntent);
  if (input.originalContentId != null || input.transformationType != null) return 'repurpose';
  if (input.allowStrategicReuse) return 'revisit_with_new_angle';
  return 'none';
}

function scoreCandidateMatch(candidate: NormalizedCandidate, existing: ContentNoveltyCandidate): ContentNoveltyMatch {
  const reasonCodes = new Set<string>();
  const existingText = normalizeContentText([existing.topic, existing.title, existing.hook, existing.caption, existing.body].filter(Boolean).join(' '));
  const textSimilarity = similarity(candidate.normalizedText, existingText);
  const topicSimilarity = similarity(candidate.normalizedTopic ?? '', normalizeContentText(existing.topic ?? existing.title ?? ''));
  const hookSimilarity = candidate.normalizedHook && existing.hook
    ? similarity(candidate.normalizedHook, normalizeContentText(existing.hook))
    : 0;
  const angleSimilarity = candidate.normalizedAngle && existing.angle
    ? similarity(candidate.normalizedAngle, normalizeContentText(existing.angle))
    : 0;
  const refOverlap = overlapRatio(candidate.referenceIds, existing.referenceIds);
  const samePlatform = Boolean(candidate.platformId && existing.platformId && candidate.platformId === existing.platformId);
  const sameFormat = Boolean(candidate.formatId && existing.formatId && candidate.formatId === existing.formatId);
  const sameSeries = Boolean(candidate.seriesId && existing.seriesId && candidate.seriesId === existing.seriesId);
  const sameRadar = Boolean(candidate.sourceRadarSignalId && existing.sourceRadarSignalId && candidate.sourceRadarSignalId === existing.sourceRadarSignalId);
  const sameOriginal = Boolean(candidate.originalContentId && existing.originalContentId && candidate.originalContentId === existing.originalContentId);
  const samePillar = Boolean(candidate.contentPillar && existing.contentPillar && normalizeContentText(candidate.contentPillar) === normalizeContentText(existing.contentPillar));
  const strongestSimilarity = Math.max(textSimilarity, topicSimilarity, hookSimilarity);
  let risk = (
    strongestSimilarity * 0.5
    + angleSimilarity * 0.15
    + (samePlatform ? 0.08 : 0)
    + (sameFormat ? 0.07 : 0)
    + refOverlap * 0.12
    + (samePillar ? 0.06 : 0)
    + (sameSeries ? 0.05 : 0)
  );
  if (candidate.normalizedText && candidate.normalizedText === existingText) {
    risk = 1;
    reasonCodes.add('exact_duplicate_text');
  }
  if (candidate.normalizedTopic && candidate.normalizedTopic === normalizeContentText(existing.topic ?? existing.title ?? '')) {
    risk = Math.max(risk, 0.84);
    reasonCodes.add('duplicate_topic');
  }
  if (hookSimilarity >= 0.78) {
    risk = Math.max(risk, 0.78);
    reasonCodes.add('near_duplicate_hook');
  }
  if (sameRadar) {
    risk = Math.max(risk, 0.94);
    reasonCodes.add('repeated_stale_radar_signal');
  }
  if (sameOriginal) reasonCodes.add('same_original_content_lineage');
  if (sameSeries) reasonCodes.add('same_content_series');
  if (!samePlatform && candidate.platformId && existing.platformId) risk = Math.max(0, risk - 0.08);
  if (!sameFormat && candidate.formatId && existing.formatId) risk = Math.max(0, risk - 0.05);

  return {
    candidateId: existing.candidateId,
    artifactType: existing.artifactType,
    title: existing.title,
    topic: existing.topic,
    hook: existing.hook,
    platformId: existing.platformId,
    formatId: existing.formatId,
    seriesId: existing.seriesId,
    originalContentId: existing.originalContentId,
    riskScore: roundScore(clamp01(risk)),
    similarity: roundScore(strongestSimilarity),
    reasonCodes: [...reasonCodes],
  };
}

function buildStrategicReuse(candidate: NormalizedCandidate, matches: ContentNoveltyMatch[]): ContentNoveltyDecision['strategicReuse'] {
  const lineageMatch = matches.find((match) => (
    candidate.originalContentId
    && (match.candidateId === candidate.originalContentId || match.originalContentId === candidate.originalContentId)
  )) ?? matches[0];
  const platformChanged = Boolean(lineageMatch?.platformId && candidate.platformId && lineageMatch.platformId !== candidate.platformId);
  const formatChanged = Boolean(lineageMatch?.formatId && candidate.formatId && lineageMatch.formatId !== candidate.formatId);
  const angleChanged = candidate.normalizedAngle
    ? !matches.some((match) => match.reasonCodes.includes('duplicate_topic') && match.reasonCodes.includes('near_duplicate_hook'))
    : false;
  const referenceChanged = matches.length === 0 || !matches.some((match) => match.reasonCodes.includes('overused_reference'));
  return {
    intent: candidate.reuseIntent,
    originalContentId: candidate.originalContentId,
    transformationType: candidate.transformationType,
    platformChanged,
    formatChanged,
    angleChanged,
    referenceChanged,
  };
}

function strategicVariationScore(reuse: ContentNoveltyDecision['strategicReuse']): number {
  return (
    (reuse.originalContentId ? 0.18 : 0)
    + (reuse.transformationType ? 0.2 : 0)
    + (reuse.platformChanged ? 0.2 : 0)
    + (reuse.formatChanged ? 0.16 : 0)
    + (reuse.angleChanged ? 0.18 : 0)
    + (reuse.referenceChanged ? 0.08 : 0)
  );
}

function scoreNovelty(status: ContentNoveltyStatus, maxRisk: number, reuse: ContentNoveltyDecision['strategicReuse']): number {
  if (status === 'duplicate') return roundScore(Math.min(0.2, 1 - maxRisk));
  if (status === 'near_duplicate' || status === 'stale_repetition') return roundScore(Math.max(0.2, 1 - maxRisk));
  if (status === 'needs_new_angle') return roundScore(Math.max(0.35, 1 - maxRisk + strategicVariationScore(reuse) * 0.2));
  if (status === 'allowed_reuse' || status === 'series_related') {
    return roundScore(Math.max(0.62, Math.min(0.88, 1 - maxRisk + strategicVariationScore(reuse) * 0.45)));
  }
  return roundScore(Math.max(0.55, 1 - maxRisk));
}

function findOverusedReferences(referenceIds: readonly string[], existing: readonly ContentNoveltyCandidate[]): string[] {
  if (referenceIds.length === 0) return [];
  const counts = new Map<string, number>();
  const wanted = new Set(referenceIds);
  for (const row of existing) {
    for (const ref of row.referenceIds) {
      if (!wanted.has(ref)) continue;
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, count]) => count >= 3).map(([ref]) => ref);
}

function mapCandidateRow(row: any): ContentNoveltyCandidate {
  return {
    id: Number(row.id),
    candidateId: row.candidate_id,
    tenantId: Number(row.tenant_id),
    ownerUserId: Number(row.owner_user_id),
    visibilityScope: row.visibility_scope,
    artifactType: row.artifact_type,
    title: row.title ?? null,
    body: row.body ?? null,
    hook: row.hook ?? null,
    caption: row.caption ?? null,
    topic: row.topic ?? null,
    angle: row.angle ?? null,
    platformId: row.platform_id ?? null,
    formatId: row.format_id ?? null,
    audience: row.audience ?? null,
    contentPillar: row.content_pillar ?? null,
    referenceIds: parseJsonArray(row.reference_ids_json),
    sourceRadarSignalId: row.source_radar_signal_id ?? null,
    seriesId: row.series_id ?? null,
    reuseIntent: row.reuse_intent ?? 'none',
    originalContentId: row.original_content_id ?? null,
    transformationType: row.transformation_type ?? null,
    noveltyScore: Number(row.novelty_score ?? 1),
    duplicationRiskScore: Number(row.duplication_risk_score ?? 0),
    lifecycleState: row.lifecycle_state ?? 'active',
    reasonCodes: parseJsonArray(row.reason_codes_json),
    reviewWarnings: parseJsonArray(row.review_warnings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRepurposeRow(row: any): ContentRepurposeRecord {
  return {
    id: Number(row.id),
    reuseId: row.reuse_id,
    tenantId: Number(row.tenant_id),
    ownerUserId: Number(row.owner_user_id),
    originalContentId: row.original_content_id,
    reusedContentId: row.reused_content_id,
    originalArtifactType: row.original_artifact_type,
    reusedArtifactType: row.reused_artifact_type,
    transformationType: row.transformation_type,
    fromPlatformId: row.from_platform_id ?? null,
    toPlatformId: row.to_platform_id ?? null,
    referencesPreserved: parseJsonArray(row.references_preserved_json),
    referencesChanged: parseJsonArray(row.references_changed_json),
    noveltyScore: Number(row.novelty_score ?? 0.5),
    reasonCodes: parseJsonArray(row.reason_codes_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function makeCandidateId(candidate: NormalizedCandidate): string {
  return `content_candidate_${sha256([
    candidate.tenantId,
    candidate.userId,
    candidate.artifactType,
    candidate.normalizedText,
    candidate.platformId,
    candidate.formatId,
    candidate.sourceRadarSignalId,
    candidate.seriesId,
    candidate.originalContentId,
  ].join('|')).slice(0, 24)}`;
}

function makeReuseId(input: ContentRepurposeInput, tenantId: number): string {
  return `content_reuse_${sha256([
    tenantId,
    input.userId,
    input.originalContentId,
    input.reusedContentId,
    input.transformationType,
  ].join('|')).slice(0, 24)}`;
}

function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  return Math.max(
    contentTokenJaccard(normalizeContentText(left), normalizeContentText(right), { stopwords: STOPWORDS }),
    contentBigramDice(left, right, { includeShortGram: true }),
  );
}

function overlapRatio(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  const overlap = [...a].filter((item) => b.has(item)).length;
  return overlap / Math.max(a.size, b.size);
}

function normalizeContentText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNullableTag(value: unknown): string | null {
  if (value == null) return null;
  const normalized = normalizeLabel(value);
  return normalized || null;
}

function normalizeLabel(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeReuseIntent(value: unknown): string {
  const normalized = normalizeLabel(value || 'none');
  return normalized || 'none';
}

function normalizeIdList(values: readonly (string | number)[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

function cleanText(value: unknown): string | null {
  if (value == null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function parseJsonArray(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'you',
  'are',
  'how',
  'why',
  'what',
  'when',
  'about',
  'uma',
  'para',
  'com',
  'que',
  'por',
  'dos',
  'das',
  'the',
]);

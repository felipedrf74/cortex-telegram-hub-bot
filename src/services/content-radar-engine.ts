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
import {
  createContentWorkflowObject,
  type ContentRadarLifecycleState,
  type ContentWorkflowObject,
} from './content-editorial-workflow';
import { buildContentCreativeProfileContext } from './content-memory-profile';
import {
  contentTokenOverlap,
  foldContentText,
  normalizeContentTopicText,
} from './content-text-utils';
import {
  buildContentResearchPackage,
  type ContentResearchPackage,
} from './content-research-package';

export type ContentRadarSourceType =
  | 'book'
  | 'link'
  | 'channel'
  | 'previous_content'
  | 'content_performance'
  | 'agent_signal'
  | 'training'
  | 'cooking'
  | 'finance'
  | 'secretary'
  | 'chat'
  | 'manual';

export type ContentRadarConversionTarget = 'idea' | 'outline' | 'script' | 'content_calendar_item' | 'dismissed' | 'expired';

export interface ContentRadarScoreInput {
  topic: string;
  contentPillars?: string[];
  audience?: string[];
  preferredFormats?: string[];
  dislikedFormats?: string[];
  sourceQuality?: number;
  freshness?: number;
  confidence?: number;
  novelty?: number;
  platform?: string | null;
  format?: string | null;
  crossSkillRelevance?: number;
  productionFeasibility?: number;
  duplicationRisk?: number;
  strategicValue?: number;
  sourceType?: ContentRadarSourceType | string;
}

export interface ContentRadarScore {
  freshness: number;
  confidence: number;
  relevance: number;
  novelty: number;
  audienceFit: number;
  brandFit: number;
  platformFit: number;
  sourceQuality: number;
  crossSkillRelevance: number;
  productionFeasibility: number;
  duplicationRisk: number;
  strategicValue: number;
  total: number;
  reviewRequired: boolean;
  reasonCodes: string[];
}

export interface ContentRadarSignalInput extends ContentRadarScoreInput {
  userId: number;
  tenantId?: number;
  visibilityScope?: ContentVisibilityScope;
  sourceReferenceId?: string | number | null;
  sourceReferenceTitle?: string | null;
  sourceSkill?: string | null;
  sourceSignalType?: string | null;
  summary?: string | null;
  evidence?: unknown[];
  provenance?: Record<string, unknown>;
  researchPackage?: ContentResearchPackage;
  lifecycleState?: ContentRadarLifecycleState;
  forceReviewRequired?: boolean;
  reviewReasonCodes?: string[];
  createdBy?: number;
  auditMetadata?: Record<string, unknown>;
}

export interface ContentRadarSignal {
  id: number;
  signalId: string;
  tenantId: number;
  ownerUserId: number;
  visibilityScope: string;
  sourceType: string;
  sourceReferenceId: string | null;
  sourceReferenceTitle: string | null;
  sourceSkill: string | null;
  sourceSignalType: string | null;
  topic: string;
  normalizedTopic: string;
  summary: string | null;
  platformId: string | null;
  formatId: string | null;
  score: ContentRadarScore;
  evidence: unknown[];
  provenance: Record<string, unknown>;
  researchPackage: ContentResearchPackage | null;
  duplicateSignalIds: string[];
  relatedSignalIds: string[];
  lifecycleState: ContentRadarLifecycleState;
  reviewRequired: boolean;
  convertedToObjectId: number | null;
  convertedToObjectType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentRadarConversionResult {
  ok: boolean;
  status: 'converted' | 'dismissed' | 'expired' | 'not_found' | 'invalid_target';
  signal: ContentRadarSignal | null;
  object: ContentWorkflowObject | null;
  reasonCodes: string[];
}

const ACTIVE_RADAR_STATES = new Set([
  'detected',
  'scored',
  'review_required',
  'shortlisted',
  'converted_to_idea',
  'converted_to_outline',
  'converted_to_script',
  'converted_to_calendar_item',
  'scheduled',
]);
const CONVERSION_STATE: Record<ContentRadarConversionTarget, ContentRadarLifecycleState> = {
  idea: 'converted_to_idea',
  outline: 'converted_to_outline',
  script: 'converted_to_script',
  content_calendar_item: 'converted_to_calendar_item',
  dismissed: 'dismissed',
  expired: 'expired',
};

export function ensureContentRadarEngineTables(db: any = getDb()): void {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_radar_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL UNIQUE,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      source_type TEXT NOT NULL,
      source_reference_id TEXT,
      source_reference_title TEXT,
      source_skill TEXT,
      source_signal_type TEXT,
      topic TEXT NOT NULL,
      normalized_topic TEXT NOT NULL,
      summary TEXT,
      platform_id TEXT,
      format_id TEXT,
      freshness_score REAL NOT NULL DEFAULT 0.5,
      confidence_score REAL NOT NULL DEFAULT 0.5,
      relevance_score REAL NOT NULL DEFAULT 0.5,
      novelty_score REAL NOT NULL DEFAULT 0.5,
      audience_fit_score REAL NOT NULL DEFAULT 0.5,
      brand_fit_score REAL NOT NULL DEFAULT 0.5,
      platform_fit_score REAL NOT NULL DEFAULT 0.5,
      source_quality_score REAL NOT NULL DEFAULT 0.5,
      cross_skill_relevance_score REAL NOT NULL DEFAULT 0.0,
      production_feasibility_score REAL NOT NULL DEFAULT 0.5,
      duplication_risk_score REAL NOT NULL DEFAULT 0.0,
      strategic_value_score REAL NOT NULL DEFAULT 0.5,
      total_score REAL NOT NULL DEFAULT 0.5,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      duplicate_signal_ids_json TEXT NOT NULL DEFAULT '[]',
      related_signal_ids_json TEXT NOT NULL DEFAULT '[]',
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      lifecycle_state TEXT NOT NULL DEFAULT 'detected',
      review_required INTEGER NOT NULL DEFAULT 0,
      converted_to_object_id INTEGER,
      converted_to_object_type TEXT,
      converted_at TEXT,
      dismissed_at TEXT,
      expired_at TEXT,
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function scoreContentOpportunity(input: ContentRadarScoreInput): ContentRadarScore {
  const topic = foldContentText(input.topic);
  const contentPillars = (input.contentPillars ?? []).map(foldContentText).filter(Boolean);
  const audience = (input.audience ?? []).map(foldContentText).filter(Boolean);
  const preferredFormats = (input.preferredFormats ?? []).map(normalizeTag).filter(Boolean);
  const dislikedFormats = (input.dislikedFormats ?? []).map(normalizeTag).filter(Boolean);
  const format = normalizeTag(input.format ?? input.platform ?? '');

  const sourceQuality = clamp01(input.sourceQuality ?? defaultSourceQuality(input.sourceType));
  const freshness = clamp01(input.freshness ?? 0.65);
  const confidence = clamp01(input.confidence ?? 0.65);
  const novelty = clamp01(input.novelty ?? 0.65);
  const crossSkillRelevance = clamp01(input.crossSkillRelevance ?? 0);
  const productionFeasibility = clamp01(input.productionFeasibility ?? 0.65);
  const duplicationRisk = clamp01(input.duplicationRisk ?? 0);
  const strategicValue = clamp01(input.strategicValue ?? 0.6);
  const relevance = contentPillars.length === 0
    ? 0.5
    : Math.max(...contentPillars.map((pillar) => textOverlapScore(topic, pillar)));
  const audienceFit = audience.length === 0
    ? 0.5
    : Math.max(...audience.map((segment) => textOverlapScore(topic, segment)));
  const brandFit = Math.max(relevance, audienceFit * 0.8);
  const platformFit = format && dislikedFormats.includes(format)
    ? 0.15
    : format && preferredFormats.includes(format)
      ? 0.85
      : 0.55;

  const weighted = (
    relevance * 0.13
    + sourceQuality * 0.11
    + freshness * 0.1
    + confidence * 0.1
    + novelty * 0.11
    + audienceFit * 0.09
    + brandFit * 0.09
    + platformFit * 0.07
    + crossSkillRelevance * 0.07
    + productionFeasibility * 0.07
    + strategicValue * 0.06
    - duplicationRisk * 0.13
  );
  const reasonCodes = [
    ...(sourceQuality < 0.5 ? ['low_quality_source'] : []),
    ...(confidence < 0.5 ? ['low_confidence_signal_requires_review'] : []),
    ...(freshness < 0.35 ? ['stale_signal_downgraded'] : []),
    ...(duplicationRisk >= 0.7 ? ['high_duplicate_risk'] : []),
    ...(platformFit < 0.3 ? ['disliked_format_penalty'] : []),
    ...(crossSkillRelevance >= 0.7 ? ['cross_skill_opportunity'] : []),
    ...(productionFeasibility < 0.35 ? ['low_production_feasibility'] : []),
    ...(relevance >= 0.75 ? ['matches_content_pillar'] : []),
    ...(brandFit >= 0.75 ? ['brand_aligned'] : []),
    ...(audienceFit >= 0.75 ? ['audience_aligned'] : []),
    ...(input.sourceType === 'book' ? ['book_reference_signal'] : []),
    ...(input.sourceType === 'channel' ? ['reference_channel_signal'] : []),
    ...(input.sourceType === 'training' ? ['cross_skill_training_milestone'] : []),
    ...(input.sourceType === 'finance' ? ['cross_skill_finance_deadline'] : []),
    ...(input.sourceType === 'cooking' ? ['cross_skill_cooking_routine'] : []),
    ...(input.sourceType === 'secretary' ? ['cross_skill_secretary_capacity_signal'] : []),
    ...(input.sourceType === 'chat' ? ['chat_repeated_question_signal'] : []),
  ];
  const reviewRequired = confidence < 0.5 || sourceQuality < 0.5;
  return {
    freshness,
    confidence,
    relevance,
    novelty,
    audienceFit,
    brandFit,
    platformFit,
    sourceQuality,
    crossSkillRelevance,
    productionFeasibility,
    duplicationRisk,
    strategicValue,
    total: roundScore(Math.max(0, Math.min(1, weighted))),
    reviewRequired,
    reasonCodes,
  };
}

export function upsertContentRadarSignal(input: ContentRadarSignalInput): ContentRadarSignal {
  const db = getDb();
  ensureContentRadarEngineTables(db);
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  const scope = contentScopeForInsert(input.userId, tenantId, input.visibilityScope ?? 'user_private');
  const normalizedTopic = normalizeTopic(input.topic);
  const duplicates = findDuplicateRadarSignals({
    userId: input.userId,
    tenantId,
    normalizedTopic,
    sourceReferenceId: input.sourceReferenceId,
  });
  const related = findRelatedRadarSignals({
    userId: input.userId,
    tenantId,
    normalizedTopic,
    sourceType: input.sourceType ?? 'manual',
    sourceSkill: input.sourceSkill ?? null,
    duplicateSignalIds: duplicates.map((signal) => signal.signalId),
  });
  const baseScore = scoreContentOpportunity({
    ...input,
    duplicationRisk: Math.max(input.duplicationRisk ?? 0, duplicates.length > 0 ? 0.85 : 0),
  });
  const reviewRequired = Boolean(input.forceReviewRequired) || baseScore.reviewRequired;
  const reasonCodes = Array.from(new Set([
    ...baseScore.reasonCodes,
    ...(input.reviewReasonCodes ?? []),
  ]));
  const signalId = makeSignalId(tenantId, input.sourceType ?? 'manual', input.sourceReferenceId ?? '', normalizedTopic);
  const lifecycleState = input.lifecycleState
    ?? (reviewRequired ? 'review_required' : baseScore.total >= 0.72 ? 'shortlisted' : 'scored');
  const researchPackage = input.researchPackage ?? buildContentResearchPackage({
    topic: input.topic,
    query: input.summary ?? input.topic,
    route: 'radar',
    rawSources: researchSourcesFromRadarEvidence(input.evidence, input.provenance),
    sourceOrigin: 'server_fetched',
    degraded: input.forceReviewRequired === true && (input.reviewReasonCodes ?? []).some((code) => /degraded|fallback/i.test(code)),
    warnings: [
      ...(input.reviewReasonCodes ?? []),
      ...(baseScore.reasonCodes.includes('source_quality_low') ? ['radar_source_quality_low'] : []),
    ],
  });
  const provenance = {
    ...(input.provenance ?? {}),
    researchPackage,
    sourceMode: researchPackage.sourceMode,
    sourceCount: researchPackage.sourceCount,
    researchWarnings: researchPackage.warnings,
  };

  db.prepare(`
    INSERT INTO content_radar_signals (
      signal_id, tenant_id, owner_user_id, visibility_scope, scope_status,
      source_type, source_reference_id, source_reference_title, source_skill, source_signal_type,
      topic, normalized_topic, summary, platform_id, format_id,
      freshness_score, confidence_score, relevance_score, novelty_score, audience_fit_score,
      brand_fit_score, platform_fit_score, source_quality_score, cross_skill_relevance_score,
      production_feasibility_score, duplication_risk_score, strategic_value_score, total_score,
      evidence_json, provenance_json, duplicate_signal_ids_json, related_signal_ids_json,
      reason_codes_json, lifecycle_state, review_required,
      created_by, updated_by, audit_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signal_id) DO UPDATE SET
      summary = excluded.summary,
      freshness_score = excluded.freshness_score,
      confidence_score = excluded.confidence_score,
      relevance_score = excluded.relevance_score,
      novelty_score = excluded.novelty_score,
      audience_fit_score = excluded.audience_fit_score,
      brand_fit_score = excluded.brand_fit_score,
      platform_fit_score = excluded.platform_fit_score,
      source_quality_score = excluded.source_quality_score,
      cross_skill_relevance_score = excluded.cross_skill_relevance_score,
      production_feasibility_score = excluded.production_feasibility_score,
      duplication_risk_score = excluded.duplication_risk_score,
      strategic_value_score = excluded.strategic_value_score,
      total_score = excluded.total_score,
      evidence_json = excluded.evidence_json,
      provenance_json = excluded.provenance_json,
      duplicate_signal_ids_json = excluded.duplicate_signal_ids_json,
      related_signal_ids_json = excluded.related_signal_ids_json,
      reason_codes_json = excluded.reason_codes_json,
      lifecycle_state = CASE
        WHEN content_radar_signals.lifecycle_state IN ('converted_to_idea', 'converted_to_script', 'scheduled', 'dismissed', 'expired')
        THEN content_radar_signals.lifecycle_state
        ELSE excluded.lifecycle_state
      END,
      review_required = excluded.review_required,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run(
    signalId,
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.scopeStatus,
    input.sourceType ?? 'manual',
    input.sourceReferenceId != null ? String(input.sourceReferenceId) : null,
    input.sourceReferenceTitle ?? null,
    input.sourceSkill ?? null,
    input.sourceSignalType ?? null,
    input.topic.trim(),
    normalizedTopic,
    input.summary ?? null,
    input.platform ?? null,
    input.format ?? null,
    baseScore.freshness,
    baseScore.confidence,
    baseScore.relevance,
    baseScore.novelty,
    baseScore.audienceFit,
    baseScore.brandFit,
    baseScore.platformFit,
    baseScore.sourceQuality,
    baseScore.crossSkillRelevance,
    baseScore.productionFeasibility,
    baseScore.duplicationRisk,
    baseScore.strategicValue,
    baseScore.total,
    JSON.stringify(input.evidence ?? []),
    JSON.stringify(provenance),
    JSON.stringify(duplicates.map((signal) => signal.signalId)),
    JSON.stringify(related.map((signal) => signal.signalId)),
    JSON.stringify(reasonCodes),
    lifecycleState,
    reviewRequired ? 1 : 0,
    input.createdBy ?? input.userId,
    input.createdBy ?? input.userId,
    JSON.stringify(input.auditMetadata ?? {}),
  );

  const row = db.prepare('SELECT * FROM content_radar_signals WHERE signal_id = ?').get(signalId) as any;
  return mapRadarSignal(row);
}

export function retrieveContentRadarSignals(input: {
  userId: number;
  tenantId?: number;
  includeInactive?: boolean;
  limit?: number;
  prioritized?: boolean;
  platform?: string;
  secretaryCapacityScore?: number;
}): ContentRadarSignal[] {
  if (input.prioritized !== false && !input.includeInactive) {
    return prioritizeContentRadarSignals({
      userId: input.userId,
      tenantId: input.tenantId,
      platform: input.platform,
      secretaryCapacityScore: input.secretaryCapacityScore,
      limit: input.limit,
    });
  }
  return retrieveRawContentRadarSignals(input);
}

function retrieveRawContentRadarSignals(input: {
  userId: number;
  tenantId?: number;
  includeInactive?: boolean;
  limit?: number;
}): ContentRadarSignal[] {
  const db = getDb();
  ensureContentRadarEngineTables(db);
  const stateFilter = input.includeInactive
    ? ''
    : `AND lifecycle_state IN (${[...ACTIVE_RADAR_STATES].map(() => '?').join(', ')})`;
  const params: unknown[] = [
    ...contentScopeParams(input.userId, input.tenantId),
    ...(!input.includeInactive ? [...ACTIVE_RADAR_STATES] : []),
    Math.max(1, Math.min(100, input.limit ?? 50)),
  ];
  const rows = db.prepare(`
    SELECT *
      FROM content_radar_signals
     WHERE ${contentDirectScopePredicate()}
       ${stateFilter}
     ORDER BY total_score DESC, freshness_score DESC, updated_at DESC
     LIMIT ?
  `).all(...params) as any[];
  return rows.map(mapRadarSignal);
}

export function prioritizeContentRadarSignals(input: {
  userId: number;
  tenantId?: number;
  platform?: string;
  secretaryCapacityScore?: number;
  limit?: number;
}): ContentRadarSignal[] {
  const context = buildContentCreativeProfileContext({
    userId: input.userId,
    tenantId: input.tenantId,
    platform: input.platform,
  });
  const pillars = memoryList(context.memories.find((memory) => memory.memoryKey === 'brand.content_pillars')?.memoryValue);
  const audience = memoryList(context.memories.find((memory) => memory.memoryKey === 'brand.audience')?.memoryValue);
  const preferredFormats = memoryList(context.memories.find((memory) => memory.memoryKey === 'brand.preferred_formats')?.memoryValue);
  const dislikedFormats = memoryList(context.memories.find((memory) => memory.memoryKey === 'brand.disliked_formats')?.memoryValue);
  const capacity = clamp01(input.secretaryCapacityScore ?? 0.75);
  const signals = retrieveContentRadarSignals({
    userId: input.userId,
    tenantId: input.tenantId,
    limit: 100,
    prioritized: false,
  });
  const feedback = loadRadarFeedbackAdjustments(input.userId, input.tenantId);

  return signals.map((signal) => {
    const score = scoreContentOpportunity({
      topic: signal.topic,
      contentPillars: pillars,
      audience,
      preferredFormats,
      dislikedFormats,
      sourceQuality: signal.score.sourceQuality,
      freshness: signal.score.freshness,
      confidence: signal.score.confidence,
      novelty: signal.score.novelty,
      platform: input.platform ?? signal.platformId,
      format: signal.formatId,
      crossSkillRelevance: signal.score.crossSkillRelevance,
      productionFeasibility: Math.min(signal.score.productionFeasibility, capacity),
      duplicationRisk: signal.score.duplicationRisk,
      strategicValue: signal.score.strategicValue,
      sourceType: signal.sourceType,
    });
    const adjustment = feedback.bySignal.get(signal.signalId)
      ?? feedback.byTopic.get(normalizeTopic(signal.topic));
    const adjustedScore = adjustment
      ? {
        ...score,
        total: roundScore(clamp01(score.total + adjustment.delta)),
        reasonCodes: [...new Set([...score.reasonCodes, ...adjustment.reasonCodes])],
      }
      : score;
    return {
      ...signal,
      score: capacity < 0.35
        ? { ...adjustedScore, reasonCodes: [...new Set([...adjustedScore.reasonCodes, 'secretary_capacity_low'])] }
        : adjustedScore,
    };
  })
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, Math.max(1, Math.min(50, input.limit ?? 20)));
}

export function convertContentRadarSignal(input: {
  userId: number;
  tenantId?: number;
  signalId: string;
  target: ContentRadarConversionTarget;
  actorUserId?: number;
}): ContentRadarConversionResult {
  const db = getDb();
  ensureContentRadarEngineTables(db);
  const signal = getContentRadarSignal(input);
  if (!signal) {
    return { ok: false, status: 'not_found', signal: null, object: null, reasonCodes: ['radar_signal_not_found_or_unauthorized'] };
  }
  const targetState = CONVERSION_STATE[input.target];
  if (!targetState) {
    return { ok: false, status: 'invalid_target', signal, object: null, reasonCodes: ['invalid_radar_conversion_target'] };
  }
  if (input.target === 'dismissed' || input.target === 'expired') {
    db.prepare(`
      UPDATE content_radar_signals
         SET lifecycle_state = ?,
             dismissed_at = CASE WHEN ? = 'dismissed' THEN datetime('now') ELSE dismissed_at END,
             expired_at = CASE WHEN ? = 'expired' THEN datetime('now') ELSE expired_at END,
             updated_by = ?,
             updated_at = datetime('now')
       WHERE signal_id = ?
    `).run(targetState, targetState, targetState, input.actorUserId ?? input.userId, input.signalId);
    return {
      ok: true,
      status: input.target === 'dismissed' ? 'dismissed' : 'expired',
      signal: getContentRadarSignal(input),
      object: null,
      reasonCodes: [`radar_signal_${input.target}`],
    };
  }

  const objectType = input.target === 'content_calendar_item' ? 'content_calendar_item' : input.target;
  const editorialState = input.target === 'outline'
    ? 'outlined'
    : input.target === 'script'
      ? 'drafted'
      : input.target === 'content_calendar_item'
        ? 'selected'
        : 'idea';
  const object = createContentWorkflowObject({
    userId: input.userId,
    tenantId: input.tenantId,
    objectType,
    title: signal.topic,
    summary: signal.summary,
    editorialState,
    metadata: {
      generatedFromRadarSignalId: signal.signalId,
      radarSourceType: signal.sourceType,
      radarScore: signal.score.total,
      evidence: signal.evidence,
      provenance: signal.provenance,
    },
  });
  db.prepare(`
    UPDATE content_radar_signals
       SET lifecycle_state = ?,
           converted_to_object_id = ?,
           converted_to_object_type = ?,
           converted_at = datetime('now'),
           updated_by = ?,
           updated_at = datetime('now')
     WHERE signal_id = ?
  `).run(
    targetState,
    object.id,
    object.objectType,
    input.actorUserId ?? input.userId,
    signal.signalId,
  );
  return {
    ok: true,
    status: 'converted',
    signal: getContentRadarSignal(input),
    object,
    reasonCodes: [`radar_signal_converted_to_${input.target}`],
  };
}

function getContentRadarSignal(input: { userId: number; tenantId?: number; signalId: string }): ContentRadarSignal | null {
  const row = getDb().prepare(`
    SELECT *
      FROM content_radar_signals
     WHERE signal_id = ?
       AND ${contentDirectScopePredicate()}
     LIMIT 1
  `).get(input.signalId, ...contentScopeParams(input.userId, input.tenantId)) as any;
  return row ? mapRadarSignal(row) : null;
}

function findDuplicateRadarSignals(input: {
  userId: number;
  tenantId: number;
  normalizedTopic: string;
  sourceReferenceId?: string | number | null;
}): ContentRadarSignal[] {
  ensureContentRadarEngineTables(getDb());
  const rows = getDb().prepare(`
    SELECT *
      FROM content_radar_signals
     WHERE ${contentDirectScopePredicate()}
       AND lifecycle_state NOT IN ('dismissed', 'expired')
       AND (
        normalized_topic = ?
        OR (source_reference_id IS NOT NULL AND source_reference_id = ?)
       )
     ORDER BY total_score DESC, updated_at DESC
     LIMIT 10
  `).all(
    ...contentScopeParams(input.userId, input.tenantId),
    input.normalizedTopic,
    input.sourceReferenceId != null ? String(input.sourceReferenceId) : '__none__',
  ) as any[];
  return rows.map(mapRadarSignal);
}

function findRelatedRadarSignals(input: {
  userId: number;
  tenantId: number;
  normalizedTopic: string;
  sourceType: string;
  sourceSkill?: string | null;
  duplicateSignalIds: string[];
}): ContentRadarSignal[] {
  ensureContentRadarEngineTables(getDb());
  const duplicateSet = new Set(input.duplicateSignalIds);
  const rows = getDb().prepare(`
    SELECT *
      FROM content_radar_signals
     WHERE ${contentDirectScopePredicate()}
       AND lifecycle_state NOT IN ('dismissed', 'expired')
       AND normalized_topic != ?
       AND (
        source_type = ?
        OR (source_skill IS NOT NULL AND source_skill = ?)
       )
     ORDER BY total_score DESC, updated_at DESC
     LIMIT 10
  `).all(
    ...contentScopeParams(input.userId, input.tenantId),
    input.normalizedTopic,
    input.sourceType,
    input.sourceSkill ?? '__none__',
  ) as any[];
  return rows.map(mapRadarSignal).filter((signal) => !duplicateSet.has(signal.signalId));
}

function loadRadarFeedbackAdjustments(
  userId: number,
  tenantId?: number,
): {
  bySignal: Map<string, { delta: number; reasonCodes: string[] }>;
  byTopic: Map<string, { delta: number; reasonCodes: string[] }>;
} {
  const db = getDb();
  const bySignal = new Map<string, { delta: number; reasonCodes: string[] }>();
  const byTopic = new Map<string, { delta: number; reasonCodes: string[] }>();
  try {
    const rows = db.prepare(`
      SELECT signal_id, signal_topic, action, COUNT(*) AS c
        FROM content_radar_feedback
       WHERE tenant_id = ? AND owner_user_id = ?
         AND COALESCE(scope_status, 'active') = 'active'
       GROUP BY signal_id, signal_topic, action
    `).all(resolveContentTenantId(userId, tenantId), userId) as Array<{
      signal_id: string;
      signal_topic: string | null;
      action: string;
      c: number;
    }>;
    for (const row of rows) {
      const delta = feedbackDelta(row.action) * Math.max(1, Number(row.c) || 1);
      const reasonCodes = feedbackReasonCodes(row.action);
      mergeFeedbackAdjustment(bySignal, String(row.signal_id), delta, reasonCodes);
      if (row.signal_topic) mergeFeedbackAdjustment(byTopic, normalizeTopic(row.signal_topic), delta, reasonCodes);
    }
  } catch {
    return { bySignal, byTopic };
  }
  return { bySignal, byTopic };
}

function feedbackDelta(action: string): number {
  switch (action) {
    case 'reject': return -0.18;
    case 'accept': return 0.1;
    case 'save': return 0.06;
    case 'create_brief': return 0.14;
    default: return 0;
  }
}

function feedbackReasonCodes(action: string): string[] {
  switch (action) {
    case 'reject': return ['radar_feedback_rejected'];
    case 'accept': return ['radar_feedback_accepted'];
    case 'save': return ['radar_feedback_saved'];
    case 'create_brief': return ['radar_feedback_converted'];
    default: return [];
  }
}

function mergeFeedbackAdjustment(
  map: Map<string, { delta: number; reasonCodes: string[] }>,
  key: string,
  delta: number,
  reasonCodes: string[],
): void {
  const existing = map.get(key) ?? { delta: 0, reasonCodes: [] };
  map.set(key, {
    delta: Math.max(-0.5, Math.min(0.5, existing.delta + delta)),
    reasonCodes: [...new Set([...existing.reasonCodes, ...reasonCodes])],
  });
}

function mapRadarSignal(row: any): ContentRadarSignal {
  const reasonCodes = parseJsonArray(row.reason_codes_json).filter((item): item is string => typeof item === 'string');
  return {
    id: Number(row.id),
    signalId: row.signal_id,
    tenantId: Number(row.tenant_id),
    ownerUserId: Number(row.owner_user_id),
    visibilityScope: row.visibility_scope,
    sourceType: row.source_type,
    sourceReferenceId: row.source_reference_id ?? null,
    sourceReferenceTitle: row.source_reference_title ?? null,
    sourceSkill: row.source_skill ?? null,
    sourceSignalType: row.source_signal_type ?? null,
    topic: row.topic,
    normalizedTopic: row.normalized_topic,
    summary: row.summary ?? null,
    platformId: row.platform_id ?? null,
    formatId: row.format_id ?? null,
    score: {
      freshness: Number(row.freshness_score),
      confidence: Number(row.confidence_score),
      relevance: Number(row.relevance_score),
      novelty: Number(row.novelty_score),
      audienceFit: Number(row.audience_fit_score),
      brandFit: Number(row.brand_fit_score),
      platformFit: Number(row.platform_fit_score),
      sourceQuality: Number(row.source_quality_score),
      crossSkillRelevance: Number(row.cross_skill_relevance_score),
      productionFeasibility: Number(row.production_feasibility_score),
      duplicationRisk: Number(row.duplication_risk_score),
      strategicValue: Number(row.strategic_value_score),
      total: Number(row.total_score),
      reviewRequired: row.review_required === 1,
      reasonCodes,
    },
    evidence: parseJsonArray(row.evidence_json),
    provenance: parseJsonObject(row.provenance_json),
    researchPackage: readRadarResearchPackage(row.provenance_json),
    duplicateSignalIds: parseJsonArray(row.duplicate_signal_ids_json).filter((item): item is string => typeof item === 'string'),
    relatedSignalIds: parseJsonArray(row.related_signal_ids_json).filter((item): item is string => typeof item === 'string'),
    lifecycleState: normalizeLifecycle(row.lifecycle_state),
    reviewRequired: row.review_required === 1,
    convertedToObjectId: row.converted_to_object_id != null ? Number(row.converted_to_object_id) : null,
    convertedToObjectType: row.converted_to_object_type ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultSourceQuality(sourceType?: string): number {
  if (sourceType === 'book' || sourceType === 'previous_content') return 0.78;
  if (sourceType === 'channel' || sourceType === 'link') return 0.65;
  if (['training', 'cooking', 'finance', 'secretary', 'chat'].includes(sourceType ?? '')) return 0.72;
  return 0.55;
}

function memoryList(value?: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [value];
  } catch {
    return [value];
  }
}

function normalizeLifecycle(value: string): ContentRadarLifecycleState {
  return [
    'detected',
    'scored',
    'review_required',
    'shortlisted',
    'dismissed',
    'converted_to_idea',
    'converted_to_outline',
    'converted_to_script',
    'converted_to_calendar_item',
    'scheduled',
    'expired',
  ]
    .includes(value) ? value as ContentRadarLifecycleState : 'detected';
}

function makeSignalId(tenantId: number, sourceType: string, sourceReferenceId: string | number, normalizedTopic: string): string {
  return `content_radar_${sha256(`${tenantId}:${sourceType}:${sourceReferenceId}:${normalizedTopic}`).slice(0, 24)}`;
}

function normalizeTopic(topic: string): string {
  return normalizeContentTopicText(topic);
}

function normalizeTag(value: string): string {
  return foldContentText(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function textOverlapScore(topic: string, value: string): number {
  return contentTokenOverlap(topic, value, {
    emptyScore: 0.5,
    containmentScore: 0.9,
    floor: 0.35,
    cap: 0.9,
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function researchSourcesFromRadarEvidence(
  evidence: unknown[] | undefined,
  provenance: Record<string, unknown> | undefined,
) {
  const fromEvidence = (evidence ?? [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => ({
      title: stringField(item, ['title', 'sourceTitle', 'name']) || `Radar evidence ${index + 1}`,
      url: stringField(item, ['url', 'sourceUrl', 'href']) || '',
      source_type: stringField(item, ['sourceType', 'source_type', 'type']) || 'radar_evidence',
      relevance_note: stringField(item, ['relevanceNote', 'relevance_note', 'summary', 'note']) || 'Radar evidence source.',
    }));
  const provenanceSources = Array.isArray(provenance?.sources)
    ? provenance.sources
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map((item, index) => ({
        title: stringField(item, ['title', 'name']) || `Radar provenance source ${index + 1}`,
        url: stringField(item, ['url', 'href']) || '',
        source_type: stringField(item, ['sourceType', 'source_type', 'type']) || 'radar_provenance',
        relevance_note: stringField(item, ['relevanceNote', 'relevance_note', 'summary', 'note']) || 'Radar provenance source.',
      }))
    : [];
  return [...fromEvidence, ...provenanceSources];
}

function readRadarResearchPackage(value: unknown): ContentResearchPackage | null {
  const provenance = parseJsonObject(value);
  const researchPackage = provenance.researchPackage;
  if (
    researchPackage
    && typeof researchPackage === 'object'
    && !Array.isArray(researchPackage)
    && typeof (researchPackage as any).packageId === 'string'
    && typeof (researchPackage as any).sourceMode === 'string'
  ) {
    return researchPackage as ContentResearchPackage;
  }
  return null;
}

function stringField(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

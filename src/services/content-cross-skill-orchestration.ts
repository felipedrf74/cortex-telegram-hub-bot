// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  convertContentRadarSignal,
  retrieveContentRadarSignals,
  upsertContentRadarSignal,
  type ContentRadarSignal,
  type ContentRadarSourceType,
} from './content-radar-engine';
import {
  buildContentSecretarySchedulingIntent,
  type ContentScheduleRequestInput,
} from './content-editorial-workflow';
import type { SecretarySchedulingIntent } from './secretary-scheduling-arbitrator';
import {
  resolveContentTenantId,
  type ContentVisibilityScope,
} from './content-tenant-scope';

export type ContentCrossSkillSource = 'training' | 'cooking' | 'finance' | 'secretary' | 'chat';
export type ContentSignalSensitivity = 'low' | 'moderate' | 'sensitive' | 'prohibited';
export type ContentSignalPermission = 'not_required' | 'granted' | 'missing';
export type ContentSignalUsePolicy = 'auto_use' | 'requires_review' | 'anonymize_summary' | 'do_not_use';
export type ContentCrossSkillConsumeStatus = 'consumed' | 'requires_review' | 'rejected';

export interface ContentCrossSkillSignalInput {
  userId: number;
  tenantId?: number;
  sourceTenantId?: number;
  visibilityScope?: ContentVisibilityScope;
  sourceSkill: ContentCrossSkillSource;
  signalType: string;
  sourceEntityId?: string | number | null;
  topic: string;
  summary?: string | null;
  confidence?: number;
  freshness?: number;
  evidence?: unknown[];
  permission?: ContentSignalPermission;
  sensitivity?: ContentSignalSensitivity;
  convertToIdea?: boolean;
  platform?: string | null;
  format?: string | null;
  productionFeasibility?: number;
  strategicValue?: number;
  auditMetadata?: Record<string, unknown>;
}

export interface ContentSensitiveSignalPolicy {
  usePolicy: ContentSignalUsePolicy;
  reviewRequired: boolean;
  anonymize: boolean;
  reasonCodes: string[];
  allowedSummary: string | null;
}

export interface ContentCrossSkillSignalResult {
  status: ContentCrossSkillConsumeStatus;
  policy: ContentSensitiveSignalPolicy;
  radarSignal: ContentRadarSignal | null;
  convertedObjectId: number | null;
  reasonCodes: string[];
  downstreamImplications: string[];
}

export interface ContentOutboundSkillSignal {
  targetSkill: 'secretary' | 'chat' | 'training' | 'cooking' | 'finance';
  signalType: string;
  tenantId: number;
  userId: number;
  summary: string;
  permissionRequired: boolean;
  reasonCodes: string[];
  payload: Record<string, unknown>;
}

export interface ContentChatStatusInput {
  userId: number;
  tenantId?: number;
  signalType:
    | 'content_ideas_available'
    | 'content_plan_status'
    | 'source_limitations'
    | 'pending_approvals';
  summary: string;
  count?: number;
  objectIds?: readonly (string | number)[];
  sourceLimitations?: readonly string[];
  pendingApprovalTypes?: readonly string[];
}

const SOURCE_SKILLS = new Set<ContentCrossSkillSource>(['training', 'cooking', 'finance', 'secretary', 'chat']);
const SENSITIVE_SIGNAL_TYPES = new Set([
  'recovery_insight',
  'struggle',
  'health_context',
  'nutrition_lesson',
  'budget_constraint',
  'purchase_decision',
  'creator_spend_pattern',
  'calendar_details',
  'private_schedule_context',
  'user_correction',
  'sensitive_private_context',
]);
const PROHIBITED_SIGNAL_TYPES = new Set([
  'account_balance',
  'transaction_detail',
  'medical_detail',
  'private_calendar_raw_event',
  'secret',
  'credential',
]);

export function evaluateContentSignalPolicy(input: ContentCrossSkillSignalInput): ContentSensitiveSignalPolicy {
  const sourceSkill = normalizeSourceSkill(input.sourceSkill);
  const signalType = normalizeSignalType(input.signalType);
  const sensitivity = input.sensitivity ?? inferSignalSensitivity(sourceSkill, signalType);
  const permission = input.permission ?? (sensitivity === 'low' ? 'not_required' : 'missing');
  const reasonCodes = new Set<string>();

  if (sensitivity === 'prohibited' || PROHIBITED_SIGNAL_TYPES.has(signalType)) {
    return {
      usePolicy: 'do_not_use',
      reviewRequired: true,
      anonymize: true,
      reasonCodes: ['sensitive_signal_prohibited_for_content'],
      allowedSummary: null,
    };
  }

  if (permission === 'missing' && (sensitivity === 'sensitive' || SENSITIVE_SIGNAL_TYPES.has(signalType))) {
    reasonCodes.add('sensitive_signal_requires_review');
    return {
      usePolicy: 'requires_review',
      reviewRequired: true,
      anonymize: true,
      reasonCodes: [...reasonCodes],
      allowedSummary: summarizeSensitiveSignal(input),
    };
  }

  if (sensitivity === 'sensitive') {
    reasonCodes.add('sensitive_signal_permission_granted_summary_only');
    return {
      usePolicy: 'anonymize_summary',
      reviewRequired: false,
      anonymize: true,
      reasonCodes: [...reasonCodes],
      allowedSummary: summarizeSensitiveSignal(input),
    };
  }

  if (sensitivity === 'moderate') {
    reasonCodes.add('moderate_signal_use_summary_only');
    return {
      usePolicy: 'anonymize_summary',
      reviewRequired: false,
      anonymize: true,
      reasonCodes: [...reasonCodes],
      allowedSummary: summarizeSensitiveSignal(input),
    };
  }

  reasonCodes.add('cross_skill_signal_allowed');
  return {
    usePolicy: 'auto_use',
    reviewRequired: false,
    anonymize: false,
    reasonCodes: [...reasonCodes],
    allowedSummary: input.summary?.trim() || input.topic.trim(),
  };
}

export function consumeContentCrossSkillSignal(input: ContentCrossSkillSignalInput): ContentCrossSkillSignalResult {
  const sourceSkill = normalizeSourceSkill(input.sourceSkill);
  const signalType = normalizeSignalType(input.signalType);
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  const sourceTenantId = input.sourceTenantId != null
    ? resolveContentTenantId(input.userId, input.sourceTenantId)
    : tenantId;

  if (!SOURCE_SKILLS.has(sourceSkill)) {
    return rejected('unsupported_cross_skill_source', input);
  }
  if (sourceTenantId !== tenantId) {
    return rejected('cross_tenant_signal_rejected', input);
  }

  const policy = evaluateContentSignalPolicy({ ...input, sourceSkill, signalType });
  if (policy.usePolicy === 'do_not_use') {
    return {
      status: 'rejected',
      policy,
      radarSignal: null,
      convertedObjectId: null,
      reasonCodes: policy.reasonCodes,
      downstreamImplications: ['Do not use this source signal for Content Creation.'],
    };
  }

  const topic = sanitizeTopic(input.topic);
  const sourceReferenceId = stableSourceReferenceId(input);
  const implications = downstreamImplicationsForSignal(sourceSkill, signalType, input);
  const radarSignal = upsertContentRadarSignal({
    userId: input.userId,
    tenantId,
    visibilityScope: input.visibilityScope ?? 'user_private',
    sourceType: sourceSkill as ContentRadarSourceType,
    sourceReferenceId,
    sourceSkill,
    sourceSignalType: signalType,
    topic,
    summary: policy.allowedSummary,
    platform: input.platform ?? null,
    format: input.format ?? null,
    sourceQuality: sourceQualityForSkill(sourceSkill),
    freshness: clamp01(input.freshness ?? 0.82),
    confidence: clamp01(input.confidence ?? (policy.reviewRequired ? 0.48 : 0.74)),
    crossSkillRelevance: crossSkillRelevanceForSignal(sourceSkill, signalType),
    productionFeasibility: productionFeasibilityForSignal(sourceSkill, signalType, input),
    strategicValue: clamp01(input.strategicValue ?? strategicValueForSignal(sourceSkill, signalType)),
    evidence: policy.anonymize ? [] : input.evidence ?? [],
    provenance: {
      sourceSkill,
      signalType,
      sourceEntityId: input.sourceEntityId != null ? String(input.sourceEntityId) : null,
      usePolicy: policy.usePolicy,
      sensitivity: input.sensitivity ?? inferSignalSensitivity(sourceSkill, signalType),
      permission: input.permission ?? null,
      downstreamImplications: implications,
    },
    forceReviewRequired: policy.reviewRequired,
    reviewReasonCodes: [
      ...policy.reasonCodes,
      ...reasonCodesForSignal(sourceSkill, signalType),
    ],
    auditMetadata: input.auditMetadata,
  });

  const converted = input.convertToIdea && !policy.reviewRequired
    ? convertContentRadarSignal({
        userId: input.userId,
        tenantId,
        signalId: radarSignal.signalId,
        target: 'idea',
      })
    : null;

  return {
    status: policy.reviewRequired ? 'requires_review' : 'consumed',
    policy,
    radarSignal,
    convertedObjectId: converted?.object?.id ?? null,
    reasonCodes: Array.from(new Set([
      ...policy.reasonCodes,
      ...reasonCodesForSignal(sourceSkill, signalType),
      ...(converted?.reasonCodes ?? []),
    ])),
    downstreamImplications: implications,
  };
}

export function buildContentSecretarySignals(input: {
  userId: number;
  tenantId?: number;
  objectId: string | number;
  title: string;
  signalTypes: Array<'writing_block' | 'editing_block' | 'publishing_deadline' | 'review_task' | 'radar_review_block'>;
  deadline?: string | null;
  durationMinutes?: number;
  priority?: ContentScheduleRequestInput['priority'];
}): Array<ContentOutboundSkillSignal & { schedulingIntent: SecretarySchedulingIntent }> {
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  return input.signalTypes.map((signalType) => {
    const intent = buildContentSecretarySchedulingIntent({
      userId: input.userId,
      tenantId,
      objectId: input.objectId,
      title: titleForSecretarySignal(input.title, signalType),
      durationMinutes: input.durationMinutes ?? defaultDurationForSecretarySignal(signalType),
      deadline: input.deadline ?? null,
      priority: input.priority ?? (signalType === 'publishing_deadline' ? 'high' : 'normal'),
      reason: reasonForSecretarySignal(signalType),
    });
    return {
      targetSkill: 'secretary',
      signalType,
      tenantId,
      userId: input.userId,
      summary: intent.reason ?? reasonForSecretarySignal(signalType),
      permissionRequired: signalType === 'publishing_deadline',
      reasonCodes: ['content_to_secretary_schedule_signal'],
      payload: {
        objectId: String(input.objectId),
        deadline: input.deadline ?? null,
        durationMinutes: intent.requestedDurationMinutes,
      },
      schedulingIntent: intent,
    };
  });
}

export function buildContentChatStatusSignal(input: ContentChatStatusInput): ContentOutboundSkillSignal {
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  return {
    targetSkill: 'chat',
    signalType: input.signalType,
    tenantId,
    userId: input.userId,
    summary: input.summary.trim(),
    permissionRequired: input.signalType === 'pending_approvals',
    reasonCodes: [`content_to_chat_${input.signalType}`],
    payload: {
      count: input.count ?? null,
      objectIds: (input.objectIds ?? []).map(String),
      sourceLimitations: input.sourceLimitations ?? [],
      pendingApprovalTypes: input.pendingApprovalTypes ?? [],
    },
  };
}

export function listContentCrossSkillRadarSignals(input: {
  userId: number;
  tenantId?: number;
  includeInactive?: boolean;
  limit?: number;
}): ContentRadarSignal[] {
  return retrieveContentRadarSignals(input)
    .filter((signal) => SOURCE_SKILLS.has(signal.sourceType as ContentCrossSkillSource));
}

function rejected(reason: string, input: ContentCrossSkillSignalInput): ContentCrossSkillSignalResult {
  const policy: ContentSensitiveSignalPolicy = {
    usePolicy: 'do_not_use',
    reviewRequired: true,
    anonymize: true,
    reasonCodes: [reason],
    allowedSummary: null,
  };
  return {
    status: 'rejected',
    policy,
    radarSignal: null,
    convertedObjectId: null,
    reasonCodes: [reason],
    downstreamImplications: [`Rejected ${input.sourceSkill}.${input.signalType} for Content Creation.`],
  };
}

function inferSignalSensitivity(sourceSkill: ContentCrossSkillSource, signalType: string): ContentSignalSensitivity {
  if (PROHIBITED_SIGNAL_TYPES.has(signalType)) return 'prohibited';
  if (SENSITIVE_SIGNAL_TYPES.has(signalType)) return 'sensitive';
  if (sourceSkill === 'finance') return 'moderate';
  if (sourceSkill === 'secretary' && /calendar|availability|workload|cadence/.test(signalType)) return 'moderate';
  if (sourceSkill === 'training' && /milestone|progress|routine|streak|lesson/.test(signalType)) return 'low';
  if (sourceSkill === 'cooking' && /recipe|routine|prep_system|lifestyle_pattern/.test(signalType)) return 'low';
  if (sourceSkill === 'chat' && /recurring_question|unresolved_idea|repeated_theme/.test(signalType)) return 'low';
  return 'moderate';
}

function summarizeSensitiveSignal(input: ContentCrossSkillSignalInput): string {
  const sourceSkill = normalizeSourceSkill(input.sourceSkill);
  const signalType = normalizeSignalType(input.signalType);
  switch (sourceSkill) {
    case 'training':
      return `Training signal (${signalType}) suggests a possible personal lesson. Use only as an anonymized, user-approved content angle.`;
    case 'finance':
      return `Finance signal (${signalType}) suggests a planning constraint. Do not include private numbers or account details without approval.`;
    case 'secretary':
      return `Secretary signal (${signalType}) affects content cadence and production feasibility. Avoid exposing private calendar details.`;
    case 'cooking':
      return `Cooking signal (${signalType}) suggests a routine or preparation lesson. Avoid health claims without review.`;
    case 'chat':
      return `Chat signal (${signalType}) reflects a recurring user theme. Use only tenant-scoped summary context.`;
  }
}

function reasonCodesForSignal(sourceSkill: ContentCrossSkillSource, signalType: string): string[] {
  const codes = [`content_consumed_${sourceSkill}_signal`];
  if (sourceSkill === 'training' && /milestone|progress|streak/.test(signalType)) codes.push('training_milestone_content_opportunity');
  if (sourceSkill === 'secretary') codes.push('secretary_capacity_affects_content_cadence');
  if (sourceSkill === 'finance') codes.push('finance_constraint_affects_content_workflow');
  if (sourceSkill === 'chat' && /recurring_question|repeated_theme/.test(signalType)) codes.push('chat_recurring_question_content_signal');
  if (sourceSkill === 'cooking') codes.push('cooking_lifestyle_pattern_content_signal');
  return codes;
}

function downstreamImplicationsForSignal(
  sourceSkill: ContentCrossSkillSource,
  signalType: string,
  input: ContentCrossSkillSignalInput,
): string[] {
  if (sourceSkill === 'secretary') {
    const feasibility = productionFeasibilityForSignal(sourceSkill, signalType, input);
    return [
      feasibility < 0.45
        ? 'Reduce content cadence or schedule smaller production blocks through Secretary.'
        : 'Secretary capacity supports normal content planning.',
    ];
  }
  if (sourceSkill === 'finance') {
    return ['Prefer low-cost content production, reuse existing references, and avoid spend-heavy shoots until Finance clears the constraint.'];
  }
  if (sourceSkill === 'training') {
    return ['Treat the training signal as a possible story/lesson angle, not as raw health data.'];
  }
  if (sourceSkill === 'chat') {
    return ['Recurring user questions can become radar signals or FAQ-style content ideas.'];
  }
  if (sourceSkill === 'cooking') {
    return ['Cooking routines can become practical lifestyle/process content when safe and source-limited.'];
  }
  return [];
}

function sourceQualityForSkill(sourceSkill: ContentCrossSkillSource): number {
  switch (sourceSkill) {
    case 'training':
      return 0.74;
    case 'cooking':
      return 0.7;
    case 'finance':
      return 0.68;
    case 'secretary':
      return 0.76;
    case 'chat':
      return 0.64;
  }
}

function crossSkillRelevanceForSignal(sourceSkill: ContentCrossSkillSource, signalType: string): number {
  if (sourceSkill === 'training' && /milestone|lesson|progress|streak/.test(signalType)) return 0.9;
  if (sourceSkill === 'chat' && /recurring_question|unresolved_idea|repeated_theme/.test(signalType)) return 0.88;
  if (sourceSkill === 'secretary' && /availability|cadence|publishing|deep_work|workload/.test(signalType)) return 0.84;
  if (sourceSkill === 'finance') return 0.72;
  if (sourceSkill === 'cooking') return 0.74;
  return 0.62;
}

function productionFeasibilityForSignal(
  sourceSkill: ContentCrossSkillSource,
  signalType: string,
  input: ContentCrossSkillSignalInput,
): number {
  if (typeof input.productionFeasibility === 'number') return clamp01(input.productionFeasibility);
  if (sourceSkill === 'secretary') {
    const payloadCapacity = typeof input.auditMetadata?.capacityScore === 'number'
      ? input.auditMetadata.capacityScore
      : undefined;
    return clamp01(payloadCapacity ?? (/workload|low_capacity/.test(signalType) ? 0.35 : 0.68));
  }
  if (sourceSkill === 'finance' && /constraint|budget/.test(signalType)) return 0.52;
  return 0.68;
}

function strategicValueForSignal(sourceSkill: ContentCrossSkillSource, signalType: string): number {
  if (sourceSkill === 'training' && /milestone|lesson/.test(signalType)) return 0.82;
  if (sourceSkill === 'chat' && /recurring_question|repeated_theme/.test(signalType)) return 0.8;
  if (sourceSkill === 'secretary' && /publishing|cadence/.test(signalType)) return 0.76;
  return 0.64;
}

function stableSourceReferenceId(input: ContentCrossSkillSignalInput): string {
  const sourceSkill = normalizeSourceSkill(input.sourceSkill);
  const signalType = normalizeSignalType(input.signalType);
  const entity = input.sourceEntityId != null ? String(input.sourceEntityId) : sanitizeTopic(input.topic).toLowerCase();
  return `${sourceSkill}:${signalType}:${entity}`;
}

function normalizeSourceSkill(value: string): ContentCrossSkillSource {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'triathlon') return 'training';
  return SOURCE_SKILLS.has(normalized as ContentCrossSkillSource)
    ? normalized as ContentCrossSkillSource
    : 'chat';
}

function normalizeSignalType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sanitizeTopic(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new Error('CONTENT_CROSS_SKILL_SIGNAL: topic is required');
  return trimmed.slice(0, 240);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function titleForSecretarySignal(title: string, signalType: string): string {
  switch (signalType) {
    case 'writing_block':
      return `Write: ${title}`;
    case 'editing_block':
      return `Edit: ${title}`;
    case 'publishing_deadline':
      return `Publish: ${title}`;
    case 'review_task':
      return `Review: ${title}`;
    case 'radar_review_block':
      return `Review content radar: ${title}`;
    default:
      return title;
  }
}

function defaultDurationForSecretarySignal(signalType: string): number {
  switch (signalType) {
    case 'writing_block':
      return 90;
    case 'editing_block':
      return 60;
    case 'review_task':
    case 'radar_review_block':
      return 30;
    case 'publishing_deadline':
      return 20;
    default:
      return 60;
  }
}

function reasonForSecretarySignal(signalType: string): string {
  switch (signalType) {
    case 'writing_block':
      return 'Content Creation requested protected writing time; Secretary owns schedule placement.';
    case 'editing_block':
      return 'Content Creation requested editing time before publishing.';
    case 'publishing_deadline':
      return 'Content Creation has a publishing deadline that Secretary should place and monitor.';
    case 'review_task':
      return 'Content Creation needs a human review task before workflow progression.';
    case 'radar_review_block':
      return 'Content Creation needs time to review radar opportunities without flooding the agenda.';
    default:
      return 'Content Creation requested a schedule block through Secretary.';
  }
}

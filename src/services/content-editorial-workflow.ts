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
  assessClaimsGrounding,
  getContentOutputProvenance,
  recordContentOutputProvenance,
  type ContentRegisteredReference,
  type ContentOutputProvenance,
  type ContentProvenanceClaimInput,
} from './content-reference-provenance';
import {
  recordContentRepurpose,
  type ContentRepurposeRecord,
  type ContentTransformationType,
} from './content-novelty-reuse';
import {
  validateGenerationReadiness,
  type ContentDomainObjectInput,
  type ContentObjectType,
} from './content-domain-ontology';
import type {
  SecretaryIntentFlexibility,
  SecretarySchedulingDecision,
  SecretarySchedulingIntent,
  SecretaryTimeWindow,
} from './secretary-scheduling-arbitrator';
import { previewSecretarySchedulingIntent, submitSecretarySchedulingIntent } from './secretary-scheduling-arbitrator';

export const CONTENT_EDITORIAL_STATES = [
  'idea',
  'researched',
  'selected',
  'outlined',
  'drafted',
  'reviewed',
  'revised',
  'approved',
  'scheduled',
  'published',
  'archived',
  'repurposed',
  'rejected',
  'stale',
] as const;

export type ContentEditorialState = typeof CONTENT_EDITORIAL_STATES[number];

export const CONTENT_RADAR_LIFECYCLE_STATES = [
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
] as const;

export type ContentRadarLifecycleState = typeof CONTENT_RADAR_LIFECYCLE_STATES[number];

export const CONTENT_REFERENCE_LIFECYCLE_STATES = [
  'added',
  'indexed',
  'pending_review',
  'active',
  'stale',
  'broken',
  'archived',
] as const;

export type ContentReferenceLifecycleState = typeof CONTENT_REFERENCE_LIFECYCLE_STATES[number];

export type ContentWorkflowAction =
  | 'convert_radar_to_idea'
  | 'convert_radar_to_script'
  | 'convert_idea_to_outline'
  | 'convert_outline_to_script'
  | 'refine_script'
  | 'approve_draft'
  | 'schedule_content'
  | 'mark_published'
  | 'archive'
  | 'reject'
  | 'repurpose_content'
  | 'delete_draft'
  | 'mark_stale';

export type ContentApprovalType =
  | 'publish'
  | 'schedule_tenant_shared'
  | 'delete_draft'
  | 'low_confidence_sources'
  | 'unsupported_claims'
  | 'brand_voice_change'
  | 'sensitive_cross_skill_signal'
  | 'external_send_publish';

export interface ContentWorkflowObject {
  id: number;
  tenantId: number;
  ownerUserId: number;
  visibilityScope: ContentVisibilityScope | string;
  objectType: string;
  title: string;
  editorialState: ContentEditorialState;
  approvalState: string;
  reviewRequired: boolean;
  reviewReasonCodes: string[];
  secretaryIntentId: string | null;
  secretaryAgendaItemId: string | null;
  metadata: Record<string, unknown>;
  workflowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContentWorkflowObjectInput {
  userId: number;
  tenantId?: number;
  visibilityScope?: ContentVisibilityScope;
  objectType: ContentObjectType | string;
  title: string;
  summary?: string | null;
  editorialState?: ContentEditorialState;
  lifecycleState?: string;
  platformId?: string | null;
  formatId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ContentApprovalEvaluationInput {
  action: ContentWorkflowAction | 'publish' | 'delete_draft' | 'change_brand_voice' | 'external_send_publish';
  targetState?: ContentEditorialState;
  currentState?: ContentEditorialState;
  visibilityScope?: ContentVisibilityScope | string | null;
  references?: readonly ContentRegisteredReference[];
  claims?: readonly ContentProvenanceClaimInput[];
  usesSensitiveCrossSkillSignals?: boolean;
  changesBrandVoice?: boolean;
  sendsExternally?: boolean;
}

export interface ContentApprovalEvaluation {
  approvalRequired: boolean;
  approvalTypes: ContentApprovalType[];
  reasonCodes: string[];
  reviewRequired: boolean;
}

export interface TransitionContentWorkflowInput extends ContentApprovalEvaluationInput {
  userId: number;
  tenantId?: number;
  objectId: number | string;
  objectType?: string;
  action: ContentWorkflowAction;
  targetState?: ContentEditorialState;
  actorUserId?: number;
  approvalConfirmed?: boolean;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ContentWorkflowTransitionResult {
  ok: boolean;
  status: 'transitioned' | 'approval_required' | 'invalid_transition' | 'not_found' | 'version_conflict';
  object: ContentWorkflowObject | null;
  fromState: ContentEditorialState | null;
  toState: ContentEditorialState | null;
  approval: ContentApprovalEvaluation;
  reasonCodes: string[];
  secretaryIntent?: SecretarySchedulingIntent;
}

export type ContentSourceReviewDecision = 'approved' | 'needs_revision' | 'rejected';
export type ContentApprovalDecision = 'approved' | 'rejected';

export interface ReviewContentSourcesInput {
  userId: number;
  tenantId?: number;
  objectId: number | string;
  objectType?: string;
  decision?: ContentSourceReviewDecision;
  references?: readonly ContentRegisteredReference[];
  claims?: readonly ContentProvenanceClaimInput[];
  sourceSummaries?: string[];
  notes?: string | null;
  actorUserId?: number;
  metadata?: Record<string, unknown>;
}

export interface ReviewContentSourcesResult {
  ok: boolean;
  status: 'reviewed' | 'approval_required' | 'rejected' | 'not_found' | 'unauthorized_reference';
  object: ContentWorkflowObject | null;
  provenance: ContentOutputProvenance | null;
  approval: ContentApprovalEvaluation;
  reasonCodes: string[];
}

export interface DecideContentApprovalInput {
  userId: number;
  tenantId?: number;
  objectId: number | string;
  approvalType?: ContentApprovalType | string;
  decision: ContentApprovalDecision;
  reason?: string | null;
  actorUserId?: number;
  metadata?: Record<string, unknown>;
}

export interface DecideContentApprovalResult {
  ok: boolean;
  status: 'approved' | 'rejected' | 'not_found';
  object: ContentWorkflowObject | null;
  approvalRecords: Array<Record<string, unknown>>;
  reasonCodes: string[];
}

export interface RepurposeContentWorkflowInput {
  userId: number;
  tenantId?: number;
  sourceObjectId: number | string;
  targetObjectType?: ContentObjectType | string;
  title: string;
  summary?: string | null;
  transformationType: ContentTransformationType | string;
  fromPlatformId?: string | null;
  toPlatformId?: string | null;
  referencesPreserved?: readonly (string | number)[];
  referencesChanged?: readonly (string | number)[];
  noveltyScore?: number;
  reasonCodes?: readonly string[];
  approvalConfirmed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RepurposeContentWorkflowResult {
  ok: boolean;
  status: 'repurposed' | 'approval_required' | 'invalid_transition' | 'not_found';
  sourceObject: ContentWorkflowObject | null;
  reusedObject: ContentWorkflowObject | null;
  reuseRecord: ContentRepurposeRecord | null;
  transition: ContentWorkflowTransitionResult;
  reasonCodes: string[];
}

export interface ContentScheduleRequestInput {
  userId: number;
  tenantId?: number;
  objectId: number | string;
  title: string;
  durationMinutes?: number;
  minimumDurationMinutes?: number;
  preferredWindows?: SecretaryTimeWindow[];
  unavailableWindows?: SecretaryTimeWindow[];
  protectedWindows?: SecretaryTimeWindow[];
  deadline?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | number;
  flexibility?: SecretaryIntentFlexibility;
  reason?: string | null;
  approvalConfirmed?: boolean;
}

export interface ConvertRadarSignalInput {
  userId: number;
  tenantId?: number;
  radarSignalId: number | string;
  actorUserId?: number;
  title?: string | null;
  summary?: string | null;
  visibilityScope?: ContentVisibilityScope;
  metadata?: Record<string, unknown>;
}

export interface ConvertRadarSignalResult {
  ok: boolean;
  status: 'converted' | 'not_found' | 'invalid_transition' | 'approval_required';
  radarSignalId: string;
  radarFromState: ContentRadarLifecycleState | null;
  radarToState: ContentRadarLifecycleState | null;
  object: ContentWorkflowObject | null;
  reasonCodes: string[];
}

const CONTENT_TRANSITIONS: Record<ContentEditorialState, ContentEditorialState[]> = {
  idea: ['researched', 'selected', 'outlined', 'rejected', 'archived', 'stale'],
  researched: ['selected', 'outlined', 'rejected', 'archived', 'stale'],
  selected: ['outlined', 'drafted', 'scheduled', 'rejected', 'archived', 'stale'],
  outlined: ['drafted', 'reviewed', 'rejected', 'archived', 'stale'],
  drafted: ['reviewed', 'revised', 'approved', 'rejected', 'archived', 'stale'],
  reviewed: ['revised', 'approved', 'rejected', 'archived', 'stale'],
  revised: ['reviewed', 'approved', 'rejected', 'archived', 'stale'],
  approved: ['scheduled', 'published', 'repurposed', 'archived', 'stale'],
  scheduled: ['published', 'revised', 'archived', 'stale'],
  published: ['repurposed', 'archived'],
  archived: [],
  repurposed: ['scheduled', 'published', 'archived'],
  rejected: ['archived'],
  stale: ['researched', 'revised', 'archived', 'rejected'],
};

const ACTION_TARGETS: Partial<Record<ContentWorkflowAction, ContentEditorialState>> = {
  convert_radar_to_idea: 'idea',
  convert_radar_to_script: 'drafted',
  convert_idea_to_outline: 'outlined',
  convert_outline_to_script: 'drafted',
  refine_script: 'revised',
  approve_draft: 'approved',
  schedule_content: 'scheduled',
  mark_published: 'published',
  archive: 'archived',
  reject: 'rejected',
  repurpose_content: 'repurposed',
  delete_draft: 'archived',
  mark_stale: 'stale',
};

const RADAR_TRANSITIONS: Record<ContentRadarLifecycleState, ContentRadarLifecycleState[]> = {
  detected: ['scored', 'review_required', 'dismissed', 'expired'],
  scored: ['review_required', 'shortlisted', 'dismissed', 'expired'],
  review_required: ['shortlisted', 'dismissed', 'expired'],
  shortlisted: ['converted_to_idea', 'converted_to_outline', 'converted_to_script', 'converted_to_calendar_item', 'scheduled', 'dismissed', 'expired'],
  dismissed: [],
  converted_to_idea: ['scheduled'],
  converted_to_outline: ['converted_to_script', 'scheduled'],
  converted_to_script: ['scheduled'],
  converted_to_calendar_item: ['scheduled'],
  scheduled: [],
  expired: [],
};

const REFERENCE_TRANSITIONS: Record<ContentReferenceLifecycleState, ContentReferenceLifecycleState[]> = {
  added: ['indexed', 'pending_review', 'broken', 'archived'],
  indexed: ['active', 'pending_review', 'stale', 'broken', 'archived'],
  pending_review: ['active', 'stale', 'broken', 'archived'],
  active: ['stale', 'broken', 'archived'],
  stale: ['indexed', 'pending_review', 'archived'],
  broken: ['indexed', 'archived'],
  archived: [],
};

export function ensureContentEditorialWorkflowTables(db: any = getDb()): void {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      approval_state TEXT NOT NULL DEFAULT 'not_required',
      review_required INTEGER NOT NULL DEFAULT 0,
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      actor_user_id INTEGER NOT NULL,
      secretary_intent_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS content_approval_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      approval_type TEXT NOT NULL,
      approval_state TEXT NOT NULL DEFAULT 'required',
      required_reason_codes_json TEXT NOT NULL DEFAULT '[]',
      requested_by INTEGER NOT NULL,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_by INTEGER,
      approved_at TEXT,
      rejected_by INTEGER,
      rejected_at TEXT,
      rejection_reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(tenant_id, owner_user_id, object_type, object_id, approval_type)
    );
    CREATE TABLE IF NOT EXISTS content_source_review_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      review_state TEXT NOT NULL,
      grounding_status TEXT,
      reason_codes_json TEXT NOT NULL DEFAULT '[]',
      reviewed_by INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
}

export function createContentWorkflowObject(input: CreateContentWorkflowObjectInput): ContentWorkflowObject {
  const db = getDb();
  ensureContentEditorialWorkflowTables(db);
  ensureDomainObjectColumns(db);
  const scope = contentScopeForInsert(input.userId, input.tenantId, input.visibilityScope ?? 'user_private');
  const editorialState = input.editorialState ?? defaultEditorialState(input.objectType);
  const lifecycleState = input.lifecycleState ?? editorialState;
  const result = db.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, lifecycle_state, editorial_state, approval_state,
      review_required, review_reason_codes_json, title, summary,
      platform_id, format_id, ontology_metadata_json, ontology_schema_version,
      created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'content-ontology-v1', ?, ?, ?)
  `).run(
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.scopeStatus,
    input.objectType,
    lifecycleState,
    editorialState,
    'not_required',
    0,
    '[]',
    input.title,
    input.summary ?? null,
    input.platformId ?? null,
    input.formatId ?? null,
    JSON.stringify(input.metadata ?? {}),
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
  );

  const object = getContentWorkflowObject(input.userId, Number(result.lastInsertRowid), input.tenantId);
  if (!object) throw new Error('Failed to create content workflow object');
  writeWorkflowEvent(db, scope, {
    objectType: object.objectType,
    objectId: String(object.id),
    action: 'create',
    fromState: null,
    toState: object.editorialState,
    approvalState: object.approvalState,
    reviewRequired: object.reviewRequired,
    reasonCodes: [],
    actorUserId: input.userId,
    metadata: input.metadata ?? {},
  });
  return object;
}

export function getContentWorkflowObject(
  userId: number,
  objectId: number | string,
  tenantId?: number,
): ContentWorkflowObject | null {
  const db = getDb();
  ensureContentEditorialWorkflowTables(db);
  ensureDomainObjectColumns(db);
  const row = db.prepare(`
    SELECT *
      FROM content_domain_objects
     WHERE id = ?
       AND ${contentDirectScopePredicate()}
     LIMIT 1
  `).get(objectId, ...contentScopeParams(userId, tenantId)) as any;
  return row ? mapWorkflowObject(row) : null;
}

function contentApprovalActorAuthorized(
  object: ContentWorkflowObject,
  input: TransitionContentWorkflowInput,
): boolean {
  const actor = input.actorUserId ?? input.userId;
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  // Until Nexus has a tenant-member approver role table, the only safe
  // approver is the owner of the content object inside the active tenant.
  return actor === object.ownerUserId && input.userId === object.ownerUserId && tenantId === object.tenantId;
}

function visibilityRank(scope: string | null | undefined): number {
  switch (scope) {
    case 'user_private': return 0;
    case 'tenant_admin_visible': return 1;
    case 'tenant_shared': return 2;
    case 'public_published': return 3;
    case 'platform_internal': return 4;
    default: return 0;
  }
}

export function transitionContentWorkflow(input: TransitionContentWorkflowInput): ContentWorkflowTransitionResult {
  const db = getDb();
  ensureContentEditorialWorkflowTables(db);
  ensureDomainObjectColumns(db);
  const object = getContentWorkflowObject(input.userId, input.objectId, input.tenantId);
  if (!object) {
    return emptyTransition('not_found', input, null, null, evaluateContentApprovalRequirements(input));
  }

  const fromState = object.editorialState;
  const toState = input.targetState ?? ACTION_TARGETS[input.action];
  if (!toState || !canTransitionContent(fromState, toState)) {
    return emptyTransition('invalid_transition', input, object, toState ?? null, evaluateContentApprovalRequirements(input));
  }

  const approval = evaluateContentApprovalRequirements({
    ...input,
    currentState: fromState,
    targetState: toState,
    visibilityScope: object.visibilityScope,
  });
  const reasonCodes = [...approval.reasonCodes];

  if (
    (approval.approvalRequired && input.approvalConfirmed) || input.action === 'approve_draft'
  ) {
    if (!contentApprovalActorAuthorized(object, input)) {
      reasonCodes.push('approval_actor_not_authorized');
      requestApprovalRecords(db, object, input, approval);
      writeWorkflowEvent(db, contentScopeForInsert(input.userId, input.tenantId, object.visibilityScope as ContentVisibilityScope), {
        objectType: object.objectType,
        objectId: String(object.id),
        action: input.action,
        fromState,
        toState: fromState,
        approvalState: 'required',
        reviewRequired: true,
        reasonCodes,
        actorUserId: input.actorUserId ?? input.userId,
        metadata: input.metadata ?? {},
      });
      return {
        ok: false,
        status: 'approval_required',
        object: { ...object, approvalState: 'required', reviewRequired: true, reviewReasonCodes: reasonCodes },
        fromState,
        toState: fromState,
        approval: { ...approval, approvalRequired: true, reviewRequired: true, reasonCodes },
        reasonCodes,
      };
    }
  }

  if (approval.approvalRequired && !input.approvalConfirmed) {
    requestApprovalRecords(db, object, input, approval);
    db.prepare(`
      UPDATE content_domain_objects
         SET approval_state = 'required',
             review_required = 1,
             review_reason_codes_json = ?,
             updated_by = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(
      JSON.stringify(reasonCodes),
      input.actorUserId ?? input.userId,
      object.id,
    );
    writeWorkflowEvent(db, contentScopeForInsert(input.userId, input.tenantId, object.visibilityScope as ContentVisibilityScope), {
      objectType: object.objectType,
      objectId: String(object.id),
      action: input.action,
      fromState,
      toState: fromState,
      approvalState: 'required',
      reviewRequired: true,
      reasonCodes,
      actorUserId: input.actorUserId ?? input.userId,
      metadata: input.metadata ?? {},
    });
    return {
      ok: false,
      status: 'approval_required',
      object: { ...object, approvalState: 'required', reviewRequired: true, reviewReasonCodes: reasonCodes },
      fromState,
      toState: fromState,
      approval,
      reasonCodes,
    };
  }

  const approvalState = input.action === 'approve_draft' || input.approvalConfirmed ? 'approved' : approval.approvalRequired ? 'approved' : object.approvalState;
  const secretaryIntent = input.action === 'schedule_content'
    ? buildContentSecretarySchedulingIntent({
        userId: input.userId,
        tenantId: input.tenantId,
        objectId: object.id,
        title: object.title,
        reason: input.reason ?? null,
      })
    : undefined;
  const update = db.prepare(`
    UPDATE content_domain_objects
       SET editorial_state = ?,
           lifecycle_state = ?,
           approval_state = ?,
           review_required = ?,
           review_reason_codes_json = ?,
           approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
           approved_at = CASE WHEN ? = 'approved' THEN datetime('now') ELSE approved_at END,
           rejected_reason = CASE WHEN ? = 'rejected' THEN ? ELSE rejected_reason END,
           archived_at = CASE WHEN ? = 'archived' THEN datetime('now') ELSE archived_at END,
           secretary_intent_id = COALESCE(?, secretary_intent_id),
           updated_by = ?,
           updated_at = datetime('now'),
           workflow_version = workflow_version + 1
     WHERE id = ?
       AND workflow_version = ?
  `).run(
    toState,
    toState,
    approvalState,
    approval.reviewRequired ? 1 : 0,
    JSON.stringify(reasonCodes),
    approvalState,
    input.actorUserId ?? input.userId,
    approvalState,
    toState,
    input.reason ?? null,
    toState,
    secretaryIntent?.intentId ?? null,
    input.actorUserId ?? input.userId,
    object.id,
    object.workflowVersion,
  );
  if (update.changes < 1) {
    return {
      ok: false,
      status: 'version_conflict',
      object: getContentWorkflowObject(input.userId, object.id, input.tenantId),
      fromState,
      toState: fromState,
      approval,
      reasonCodes: [...reasonCodes, 'workflow_version_conflict'],
      secretaryIntent,
    };
  }

  approveRecordsIfConfirmed(db, object, input, approval);
  const updated = getContentWorkflowObject(input.userId, object.id, input.tenantId);
  writeWorkflowEvent(db, contentScopeForInsert(input.userId, input.tenantId, object.visibilityScope as ContentVisibilityScope), {
    objectType: object.objectType,
    objectId: String(object.id),
    action: input.action,
    fromState,
    toState,
    approvalState,
    reviewRequired: approval.reviewRequired,
    reasonCodes,
    actorUserId: input.actorUserId ?? input.userId,
    metadata: input.metadata ?? {},
  });

  return {
    ok: true,
    status: 'transitioned',
    object: updated,
    fromState,
    toState,
    approval,
    reasonCodes,
    secretaryIntent,
  };
}

export function evaluateContentApprovalRequirements(input: ContentApprovalEvaluationInput): ContentApprovalEvaluation {
  const approvalTypes: ContentApprovalType[] = [];
  const reasonCodes: string[] = [];

  const action = input.action;
  const targetState = input.targetState;
  if (action === 'mark_published' || action === 'publish' || targetState === 'published' || input.sendsExternally || action === 'external_send_publish') {
    approvalTypes.push('publish');
    reasonCodes.push('publish_requires_human_approval');
  }
  if ((action === 'schedule_content' || targetState === 'scheduled') && input.visibilityScope === 'tenant_shared') {
    approvalTypes.push('schedule_tenant_shared');
    reasonCodes.push('tenant_shared_scheduling_requires_approval');
  }
  if (action === 'delete_draft' || (action === 'archive' && ['drafted', 'reviewed', 'revised'].includes(input.currentState ?? ''))) {
    approvalTypes.push('delete_draft');
    reasonCodes.push('draft_removal_requires_confirmation');
  }
  if (input.references?.some((ref) => ref.reviewRequired || ref.confidenceScore < 0.5 || ref.qualityScore < 0.5)) {
    approvalTypes.push('low_confidence_sources');
    reasonCodes.push('low_confidence_source_requires_review');
  }
  if (input.claims?.length && !input.references?.length) {
    approvalTypes.push('unsupported_claims');
    reasonCodes.push('unsupported_claim_requires_review');
  } else if (input.claims && input.references) {
    const grounding = assessClaimsGrounding(input.claims, input.references);
    if (grounding.unsupportedClaims.length > 0) {
      approvalTypes.push('unsupported_claims');
      reasonCodes.push('unsupported_claim_requires_review');
    }
  }
  if (input.changesBrandVoice || action === 'change_brand_voice') {
    approvalTypes.push('brand_voice_change');
    reasonCodes.push('brand_voice_change_requires_approval');
  }
  if (input.usesSensitiveCrossSkillSignals) {
    approvalTypes.push('sensitive_cross_skill_signal');
    reasonCodes.push('sensitive_cross_skill_signal_requires_review');
  }

  const uniqueTypes = Array.from(new Set(approvalTypes));
  return {
    approvalRequired: uniqueTypes.length > 0,
    approvalTypes: uniqueTypes,
    reasonCodes: Array.from(new Set(reasonCodes)),
    reviewRequired: uniqueTypes.length > 0,
  };
}

export function reviewContentSources(input: ReviewContentSourcesInput): ReviewContentSourcesResult {
  const db = getDb();
  ensureContentEditorialWorkflowTables(db);
  ensureDomainObjectColumns(db);
  const object = getContentWorkflowObject(input.userId, input.objectId, input.tenantId);
  if (!object || (input.objectType && object.objectType !== input.objectType)) {
    return {
      ok: false,
      status: 'not_found',
      object: null,
      provenance: null,
      approval: evaluateContentApprovalRequirements({ action: 'approve_draft' }),
      reasonCodes: ['content_object_not_found_or_unauthorized'],
    };
  }

  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  const references = [...(input.references ?? [])];
  if (references.some((ref) => !isReferenceAuthorizedForReview(ref, input.userId, tenantId))) {
    return {
      ok: false,
      status: 'unauthorized_reference',
      object,
      provenance: getContentOutputProvenance(input.userId, object.objectType, object.id, input.tenantId),
      approval: evaluateContentApprovalRequirements({ action: 'approve_draft' }),
      reasonCodes: ['unauthorized_reference_for_source_review'],
    };
  }

  let provenance: ContentOutputProvenance | null = null;
  if (input.references || input.claims || input.sourceSummaries) {
    recordContentOutputProvenance({
      userId: input.userId,
      tenantId: input.tenantId,
      visibilityScope: object.visibilityScope as ContentVisibilityScope,
      outputObjectType: object.objectType,
      outputId: object.id,
      referencesUsed: references,
      claims: [...(input.claims ?? [])],
      sourceSummaries: input.sourceSummaries,
    });
  }
  provenance = getContentOutputProvenance(input.userId, object.objectType, object.id, input.tenantId);

  const approval = evaluateContentApprovalRequirements({
    action: 'approve_draft',
    currentState: object.editorialState,
    targetState: 'reviewed',
    visibilityScope: object.visibilityScope,
    references,
    claims: input.claims,
  });
  const reasonCodes = Array.from(new Set([
    ...approval.reasonCodes,
    ...(provenance?.reviewRequired ? ['source_provenance_requires_review'] : []),
    ...(input.decision === 'needs_revision' ? ['source_review_requested_revision'] : []),
    ...(input.decision === 'rejected' ? ['source_review_rejected'] : []),
  ]));
  const actor = input.actorUserId ?? input.userId;

  if (approval.approvalRequired || provenance?.reviewRequired || input.decision === 'needs_revision' || input.decision === 'rejected') {
    requestApprovalRecords(db, object, {
      ...input,
      action: 'approve_draft',
      metadata: input.metadata,
    }, {
      approvalRequired: true,
      approvalTypes: approval.approvalTypes.length > 0 ? approval.approvalTypes : ['low_confidence_sources'],
      reasonCodes,
      reviewRequired: true,
    });
    updateObjectReviewState(db, object.id, {
      approvalState: 'required',
      reviewRequired: true,
      reasonCodes,
      actorUserId: actor,
    });
    writeSourceReviewRecord(db, object, {
      reviewState: input.decision === 'rejected' ? 'rejected' : 'approval_required',
      groundingStatus: provenance?.groundingStatus ?? null,
      reasonCodes,
      actorUserId: actor,
      notes: input.notes ?? null,
      metadata: input.metadata ?? {},
    });
    writeWorkflowEvent(db, contentScopeForInsert(input.userId, input.tenantId, object.visibilityScope as ContentVisibilityScope), {
      objectType: object.objectType,
      objectId: String(object.id),
      action: 'source_review',
      fromState: object.editorialState,
      toState: object.editorialState,
      approvalState: 'required',
      reviewRequired: true,
      reasonCodes,
      actorUserId: actor,
      metadata: {
        ...(input.metadata ?? {}),
        groundingStatus: provenance?.groundingStatus ?? null,
        sourceReviewDecision: input.decision ?? 'needs_revision',
      },
    });
    return {
      ok: false,
      status: input.decision === 'rejected' ? 'rejected' : 'approval_required',
      object: getContentWorkflowObject(input.userId, object.id, input.tenantId),
      provenance,
      approval: { ...approval, approvalRequired: true, reviewRequired: true, reasonCodes },
      reasonCodes,
    };
  }

  const toState: ContentEditorialState = canTransitionContent(object.editorialState, 'reviewed')
    ? 'reviewed'
    : object.editorialState;
  db.prepare(`
    UPDATE content_domain_objects
       SET editorial_state = ?,
           lifecycle_state = ?,
           approval_state = CASE WHEN approval_state = 'required' THEN 'not_required' ELSE approval_state END,
           review_required = 0,
           review_reason_codes_json = '[]',
           updated_by = ?,
           updated_at = datetime('now'),
           workflow_version = workflow_version + 1
     WHERE id = ?
       AND tenant_id = ?
       AND owner_user_id = ?
  `).run(
    toState,
    toState,
    actor,
    object.id,
    object.tenantId,
    object.ownerUserId,
  );
  writeSourceReviewRecord(db, object, {
    reviewState: 'reviewed',
    groundingStatus: provenance?.groundingStatus ?? null,
    reasonCodes: [],
    actorUserId: actor,
    notes: input.notes ?? null,
    metadata: input.metadata ?? {},
  });
  writeWorkflowEvent(db, contentScopeForInsert(input.userId, input.tenantId, object.visibilityScope as ContentVisibilityScope), {
    objectType: object.objectType,
    objectId: String(object.id),
    action: 'source_review',
    fromState: object.editorialState,
    toState,
    approvalState: object.approvalState === 'required' ? 'not_required' : object.approvalState,
    reviewRequired: false,
    reasonCodes: [],
    actorUserId: actor,
    metadata: {
      ...(input.metadata ?? {}),
      groundingStatus: provenance?.groundingStatus ?? null,
      sourceReviewDecision: input.decision ?? 'approved',
    },
  });
  return {
    ok: true,
    status: 'reviewed',
    object: getContentWorkflowObject(input.userId, object.id, input.tenantId),
    provenance,
    approval,
    reasonCodes: [],
  };
}

export function decideContentApproval(input: DecideContentApprovalInput): DecideContentApprovalResult {
  const db = getDb();
  ensureContentEditorialWorkflowTables(db);
  ensureDomainObjectColumns(db);
  const object = getContentWorkflowObject(input.userId, input.objectId, input.tenantId);
  if (!object) {
    return {
      ok: false,
      status: 'not_found',
      object: null,
      approvalRecords: [],
      reasonCodes: ['content_object_not_found_or_unauthorized'],
    };
  }

  const actor = input.actorUserId ?? input.userId;
  const approvalTypes = input.approvalType
    ? [String(input.approvalType)]
    : listContentApprovalRecords({ userId: input.userId, tenantId: input.tenantId, objectType: object.objectType, objectId: object.id })
      .filter((row) => row.approval_state === 'required')
      .map((row) => String(row.approval_type));
  const uniqueTypes = Array.from(new Set(approvalTypes.length > 0 ? approvalTypes : ['publish']));

  for (const type of uniqueTypes) {
    if (input.decision === 'approved') {
      db.prepare(`
        INSERT INTO content_approval_records (
          tenant_id, owner_user_id, visibility_scope, scope_status,
          object_type, object_id, approval_type, approval_state,
          required_reason_codes_json, requested_by, approved_by, approved_at, metadata_json
        )
        VALUES (?, ?, ?, 'active', ?, ?, ?, 'approved', '[]', ?, ?, datetime('now'), ?)
        ON CONFLICT(tenant_id, owner_user_id, object_type, object_id, approval_type)
        DO UPDATE SET
          approval_state = 'approved',
          approved_by = excluded.approved_by,
          approved_at = datetime('now'),
          rejected_by = NULL,
          rejected_at = NULL,
          rejection_reason = NULL,
          metadata_json = excluded.metadata_json
      `).run(
        object.tenantId,
        object.ownerUserId,
        object.visibilityScope,
        object.objectType,
        String(object.id),
        type,
        actor,
        actor,
        JSON.stringify(input.metadata ?? {}),
      );
    } else {
      db.prepare(`
        INSERT INTO content_approval_records (
          tenant_id, owner_user_id, visibility_scope, scope_status,
          object_type, object_id, approval_type, approval_state,
          required_reason_codes_json, requested_by, rejected_by, rejected_at, rejection_reason, metadata_json
        )
        VALUES (?, ?, ?, 'active', ?, ?, ?, 'rejected', '[]', ?, ?, datetime('now'), ?, ?)
        ON CONFLICT(tenant_id, owner_user_id, object_type, object_id, approval_type)
        DO UPDATE SET
          approval_state = 'rejected',
          rejected_by = excluded.rejected_by,
          rejected_at = datetime('now'),
          rejection_reason = excluded.rejection_reason,
          metadata_json = excluded.metadata_json
      `).run(
        object.tenantId,
        object.ownerUserId,
        object.visibilityScope,
        object.objectType,
        String(object.id),
        type,
        actor,
        actor,
        input.reason ?? null,
        JSON.stringify(input.metadata ?? {}),
      );
    }
  }

  const remaining = db.prepare(`
    SELECT COUNT(*) AS count
      FROM content_approval_records
     WHERE tenant_id = ?
       AND owner_user_id = ?
       AND object_type = ?
       AND object_id = ?
       AND approval_state = 'required'
  `).get(object.tenantId, object.ownerUserId, object.objectType, String(object.id)) as { count?: number } | undefined;
  const hasRemainingRequired = Number(remaining?.count ?? 0) > 0;
  updateObjectReviewState(db, object.id, {
    approvalState: input.decision,
    reviewRequired: input.decision === 'rejected' || hasRemainingRequired,
    reasonCodes: input.decision === 'rejected' ? ['approval_rejected'] : [],
    actorUserId: actor,
  });
  writeWorkflowEvent(db, contentScopeForInsert(input.userId, input.tenantId, object.visibilityScope as ContentVisibilityScope), {
    objectType: object.objectType,
    objectId: String(object.id),
    action: `approval_${input.decision}`,
    fromState: object.editorialState,
    toState: object.editorialState,
    approvalState: input.decision,
    reviewRequired: input.decision === 'rejected' || hasRemainingRequired,
    reasonCodes: input.decision === 'rejected' ? ['approval_rejected'] : [],
    actorUserId: actor,
    metadata: {
      ...(input.metadata ?? {}),
      approvalTypes: uniqueTypes,
      rejectionReason: input.reason ?? null,
    },
  });

  return {
    ok: true,
    status: input.decision,
    object: getContentWorkflowObject(input.userId, object.id, input.tenantId),
    approvalRecords: listContentApprovalRecords({
      userId: input.userId,
      tenantId: input.tenantId,
      objectType: object.objectType,
      objectId: object.id,
    }),
    reasonCodes: input.decision === 'rejected' ? ['approval_rejected'] : [],
  };
}

export function repurposeContentWorkflowObject(input: RepurposeContentWorkflowInput): RepurposeContentWorkflowResult {
  const source = getContentWorkflowObject(input.userId, input.sourceObjectId, input.tenantId);
  const missingTransition = emptyTransition('not_found', {
    userId: input.userId,
    tenantId: input.tenantId,
    objectId: input.sourceObjectId,
    action: 'repurpose_content',
  }, null, 'repurposed', evaluateContentApprovalRequirements({ action: 'repurpose_content' }));
  if (!source) {
    return {
      ok: false,
      status: 'not_found',
      sourceObject: null,
      reusedObject: null,
      reuseRecord: null,
      transition: missingTransition,
      reasonCodes: ['content_object_not_found_or_unauthorized'],
    };
  }

  const transition = transitionContentWorkflow({
    userId: input.userId,
    tenantId: input.tenantId,
    objectId: source.id,
    action: 'repurpose_content',
    approvalConfirmed: input.approvalConfirmed,
    metadata: input.metadata,
  });
  if (!transition.ok) {
    return {
      ok: false,
      status: transition.status === 'approval_required' ? 'approval_required' : 'invalid_transition',
      sourceObject: transition.object,
      reusedObject: null,
      reuseRecord: null,
      transition,
      reasonCodes: transition.reasonCodes,
    };
  }

  const reused = createContentWorkflowObject({
    userId: input.userId,
    tenantId: input.tenantId,
    visibilityScope: source.visibilityScope as ContentVisibilityScope,
    objectType: input.targetObjectType ?? source.objectType,
    title: input.title,
    summary: input.summary ?? null,
    editorialState: defaultEditorialState(input.targetObjectType ?? source.objectType),
    platformId: input.toPlatformId ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      repurposedFromContentId: String(source.id),
      repurposedFromObjectType: source.objectType,
      repurposedFromTitle: source.title,
      transformationType: String(input.transformationType),
    },
  });
  const reuseRecord = recordContentRepurpose({
    userId: input.userId,
    tenantId: input.tenantId,
    visibilityScope: source.visibilityScope as ContentVisibilityScope,
    originalContentId: source.id,
    reusedContentId: reused.id,
    originalArtifactType: source.objectType,
    reusedArtifactType: reused.objectType,
    transformationType: input.transformationType,
    fromPlatformId: input.fromPlatformId ?? null,
    toPlatformId: input.toPlatformId ?? null,
    referencesPreserved: input.referencesPreserved ?? [],
    referencesChanged: input.referencesChanged ?? [],
    noveltyScore: input.noveltyScore,
    reasonCodes: input.reasonCodes ?? ['content_repurposed_with_lineage'],
    status: 'created',
    createdBy: input.userId,
    metadata: input.metadata ?? {},
  });

  return {
    ok: true,
    status: 'repurposed',
    sourceObject: getContentWorkflowObject(input.userId, source.id, input.tenantId),
    reusedObject: reused,
    reuseRecord,
    transition,
    reasonCodes: ['content_repurposed_with_lineage'],
  };
}

export function canTransitionContent(from: ContentEditorialState, to: ContentEditorialState): boolean {
  return CONTENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionRadar(from: ContentRadarLifecycleState, to: ContentRadarLifecycleState): boolean {
  return RADAR_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionReference(from: ContentReferenceLifecycleState, to: ContentReferenceLifecycleState): boolean {
  return REFERENCE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function buildContentSecretarySchedulingIntent(input: ContentScheduleRequestInput): SecretarySchedulingIntent {
  const tenantId = resolveContentTenantId(input.userId, input.tenantId);
  return {
    intentId: `content:${input.objectId}:schedule`,
    action: 'find_time_for_this',
    sourceSkill: 'content',
    sourceAction: 'schedule_content_block',
    sourceEntityId: input.objectId,
    sourceEntityType: 'content_domain_object',
    ownerUserId: input.userId,
    tenantId,
    title: input.title,
    requestedDurationMinutes: input.durationMinutes ?? 60,
    minimumDurationMinutes: input.minimumDurationMinutes,
    preferredWindows: input.preferredWindows,
    hardConstraints: input.unavailableWindows || input.protectedWindows
      ? {
          unavailableWindows: input.unavailableWindows,
          protectedWindows: input.protectedWindows,
        }
      : undefined,
    deadline: input.deadline ?? null,
    priority: input.priority ?? 'normal',
    flexibility: input.flexibility ?? 'flexible',
    reason: input.reason ?? 'Content editorial workflow requested a scheduled production block.',
    context: 'Content Creation owns the content; Secretary owns schedule placement.',
  };
}

export function requestContentScheduleThroughSecretary(
  input: ContentScheduleRequestInput,
): SecretarySchedulingDecision {
  const db = getDb();
  const object = getContentWorkflowObject(input.userId, input.objectId, input.tenantId);
  if (!object) {
    throw new Error('Content object not found or not authorized for scheduling');
  }
  if (object.editorialState !== 'scheduled' && !canTransitionContent(object.editorialState, 'scheduled')) {
    throw new Error(`Content object cannot be scheduled from state: ${object.editorialState}`);
  }
  const approval = evaluateContentApprovalRequirements({
    action: 'schedule_content',
    targetState: 'scheduled',
    currentState: object.editorialState,
    visibilityScope: object.visibilityScope,
  });
  if (approval.approvalRequired && !input.approvalConfirmed) {
    throw new Error(`Content scheduling requires approval: ${approval.reasonCodes.join(',')}`);
  }
  const intent = buildContentSecretarySchedulingIntent(input);
  const preview = previewSecretarySchedulingIntent(intent);
  if (!isAcceptedSecretarySchedule(preview.status) || !preview.recommendedSlot) {
    return {
      status: preview.status,
      agendaItem: {
        agendaItemId: `preview:${intent.intentId}`,
        sourceIntentId: intent.intentId,
        sourceSkill: 'content',
        sourceAction: intent.sourceAction ?? null,
        intentAction: intent.action ?? 'find_time_for_this',
        sourceEntityId: String(intent.sourceEntityId ?? ''),
        sourceEntityType: intent.sourceEntityType ?? null,
        ownerUserId: intent.ownerUserId,
        tenantId: String(intent.tenantId),
        lifecycleState: 'unscheduled',
        providerSyncState: 'not_synced',
        providerEventId: null,
        providerSource: null,
        version: 0,
        title: intent.title,
        startAt: null,
        endAt: null,
        durationMinutes: intent.requestedDurationMinutes ?? null,
        decisionAction: preview.status,
        decisionReasonCodes: preview.reasonCodes,
        decisionExplanation: 'Preview found no feasible Content slot.',
        sourceShapeHash: '',
        scheduledSegments: [],
        cancellationReason: null,
        supersededByAgendaItemId: null,
        createdAt: intent.createdAt ?? new Date().toISOString(),
        updatedAt: intent.updatedAt ?? new Date().toISOString(),
        completedAt: null,
        sourceCreatedAt: intent.createdAt ?? null,
        sourceUpdatedAt: intent.updatedAt ?? null,
        reasoningTrail: preview.reasoningTrail,
      },
      reasonCodes: preview.reasonCodes,
      explanation: 'Secretary preview found no feasible Content slot.',
      selectedSlot: null,
      alternativeSlots: preview.alternatives,
      conflicts: [],
      downstreamImplications: ['content should ask for another production window before scheduling.'],
      confidence: preview.confidence,
      feedback: {
        sourceSkill: 'content',
        sourceIntentId: intent.intentId,
        agendaItemId: `preview:${intent.intentId}`,
        ownerUserId: intent.ownerUserId,
        tenantId: String(intent.tenantId),
        agendaVersion: 0,
        status: preview.status,
        reasonCodes: preview.reasonCodes,
        scheduledStart: null,
        scheduledEnd: null,
        shouldRefreshSource: true,
        downstreamImplications: ['content should ask for another production window before scheduling.'],
      },
      reasoningTrail: preview.reasoningTrail,
    };
  }
  const decision = submitSecretarySchedulingIntent(intent);
  const accepted = isAcceptedSecretarySchedule(decision.status);
  const toState = accepted ? 'scheduled' : object.editorialState;
  const approvalState = approval.approvalRequired && input.approvalConfirmed ? 'approved' : object.approvalState;
  const reviewRequired = approval.approvalRequired && input.approvalConfirmed ? 0 : object.reviewRequired ? 1 : 0;
  const reviewReasonCodes = approval.approvalRequired && input.approvalConfirmed ? [] : object.reviewReasonCodes;

  if (approval.approvalRequired && input.approvalConfirmed) {
    approveRecordsIfConfirmed(db, object, {
      userId: input.userId,
      tenantId: input.tenantId,
      objectId: input.objectId,
      action: 'schedule_content',
      approvalConfirmed: true,
      reason: input.reason ?? null,
      metadata: {
        secretaryIntentId: intent.intentId,
        secretaryStatus: decision.status,
        agendaItemId: decision.agendaItem.agendaItemId,
      },
    }, approval);
  }

  db.prepare(`
    UPDATE content_domain_objects
       SET editorial_state = CASE WHEN ? = 1 THEN 'scheduled' ELSE editorial_state END,
           lifecycle_state = CASE WHEN ? = 1 THEN 'scheduled' ELSE lifecycle_state END,
           approval_state = ?,
           review_required = ?,
           review_reason_codes_json = ?,
           scheduled_for = COALESCE(?, scheduled_for),
           secretary_intent_id = ?,
           secretary_agenda_item_id = ?,
           updated_by = ?,
           updated_at = datetime('now'),
           workflow_version = workflow_version + 1
     WHERE id = ?
       AND tenant_id = ?
       AND owner_user_id = ?
  `).run(
    accepted ? 1 : 0,
    accepted ? 1 : 0,
    approvalState,
    reviewRequired,
    JSON.stringify(reviewReasonCodes),
    decision.selectedSlot?.start ?? null,
    intent.intentId,
    decision.agendaItem.agendaItemId,
    input.userId,
    object.id,
    object.tenantId,
    object.ownerUserId,
  );

  writeWorkflowEvent(db, contentScopeForInsert(input.userId, input.tenantId, object.visibilityScope as ContentVisibilityScope), {
    objectType: object.objectType,
    objectId: String(object.id),
    action: 'schedule_content',
    fromState: object.editorialState,
    toState,
    approvalState: object.approvalState,
    reviewRequired: object.reviewRequired,
    reasonCodes: decision.reasonCodes,
    actorUserId: input.userId,
    secretaryIntentId: intent.intentId,
    metadata: {
      agendaItemId: decision.agendaItem.agendaItemId,
      secretaryStatus: decision.status,
      selectedSlot: decision.selectedSlot,
      conflicts: decision.conflicts,
      downstreamImplications: decision.downstreamImplications,
    },
  });

  return decision;
}

export function convertRadarSignalToIdea(input: ConvertRadarSignalInput): ConvertRadarSignalResult {
  const db = getDb();
  ensureContentEditorialWorkflowTables(db);
  ensureDomainObjectColumns(db);
  ensureRadarLifecycleColumns(db);
  const row = db.prepare(`
    SELECT *
      FROM content_topic_feedback
     WHERE id = ?
       AND ${contentDirectScopePredicate()}
     LIMIT 1
  `).get(input.radarSignalId, ...contentScopeParams(input.userId, input.tenantId)) as any;

  if (!row) {
    return {
      ok: false,
      status: 'not_found',
      radarSignalId: String(input.radarSignalId),
      radarFromState: null,
      radarToState: null,
      object: null,
      reasonCodes: ['radar_signal_not_found_or_unauthorized'],
    };
  }

  const fromState = normalizeRadarState(row.radar_lifecycle_state ?? 'detected');
  const toState: ContentRadarLifecycleState = 'converted_to_idea';
  if (!canTransitionRadar(fromState, toState)) {
    return {
      ok: false,
      status: 'invalid_transition',
      radarSignalId: String(input.radarSignalId),
      radarFromState: fromState,
      radarToState: toState,
      object: null,
      reasonCodes: ['invalid_radar_lifecycle_transition'],
    };
  }

  const sourceVisibility = (row.visibility_scope ?? 'user_private') as ContentVisibilityScope;
  const requestedVisibility = input.visibilityScope ?? sourceVisibility;
  if (visibilityRank(requestedVisibility) > visibilityRank(sourceVisibility)) {
    return {
      ok: false,
      status: 'approval_required',
      radarSignalId: String(input.radarSignalId),
      radarFromState: fromState,
      radarToState: fromState,
      object: null,
      reasonCodes: ['visibility_scope_elevation_requires_explicit_approval'],
    };
  }

  const object = createContentWorkflowObject({
    userId: input.userId,
    tenantId: input.tenantId,
    visibilityScope: requestedVisibility,
    objectType: 'idea',
    title: input.title ?? row.topic ?? row.title ?? `Radar signal ${input.radarSignalId}`,
    summary: input.summary ?? row.reason ?? row.feedback_text ?? null,
    editorialState: 'idea',
    metadata: {
      ...(input.metadata ?? {}),
      generatedFromRadarSignalId: String(input.radarSignalId),
      radarFromState: fromState,
    },
  });

  db.prepare(`
    UPDATE content_topic_feedback
       SET radar_lifecycle_state = ?,
           converted_to_object_id = ?,
           converted_to_object_type = 'idea',
           converted_at = datetime('now'),
           updated_by = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(
    toState,
    object.id,
    input.actorUserId ?? input.userId,
    input.radarSignalId,
  );

  writeWorkflowEvent(db, contentScopeForInsert(input.userId, input.tenantId, object.visibilityScope as ContentVisibilityScope), {
    objectType: object.objectType,
    objectId: String(object.id),
    action: 'convert_radar_to_idea',
    fromState,
    toState: object.editorialState,
    approvalState: object.approvalState,
    reviewRequired: object.reviewRequired,
    reasonCodes: ['radar_signal_converted_to_idea'],
    actorUserId: input.actorUserId ?? input.userId,
    metadata: { radarSignalId: String(input.radarSignalId) },
  });

  return {
    ok: true,
    status: 'converted',
    radarSignalId: String(input.radarSignalId),
    radarFromState: fromState,
    radarToState: toState,
    object,
    reasonCodes: ['radar_signal_converted_to_idea'],
  };
}

export function listContentWorkflowEvents(input: {
  userId: number;
  tenantId?: number;
  objectType?: string;
  objectId?: string | number;
}): Array<Record<string, unknown>> {
  const db = getDb();
  ensureContentEditorialWorkflowTables(db);
  const filters: string[] = [contentDirectScopePredicate()];
  const params: unknown[] = [...contentScopeParams(input.userId, input.tenantId)];
  if (input.objectType) {
    filters.push('object_type = ?');
    params.push(input.objectType);
  }
  if (input.objectId != null) {
    filters.push('object_id = ?');
    params.push(String(input.objectId));
  }
  return db.prepare(`
    SELECT *
      FROM content_workflow_events
     WHERE ${filters.join(' AND ')}
     ORDER BY id ASC
  `).all(...params) as Array<Record<string, unknown>>;
}

export function listContentApprovalRecords(input: {
  userId: number;
  tenantId?: number;
  objectType?: string;
  objectId?: string | number;
}): Array<Record<string, unknown>> {
  const db = getDb();
  ensureContentEditorialWorkflowTables(db);
  const filters: string[] = [contentDirectScopePredicate()];
  const params: unknown[] = [...contentScopeParams(input.userId, input.tenantId)];
  if (input.objectType) {
    filters.push('object_type = ?');
    params.push(input.objectType);
  }
  if (input.objectId != null) {
    filters.push('object_id = ?');
    params.push(String(input.objectId));
  }
  return db.prepare(`
    SELECT *
      FROM content_approval_records
     WHERE ${filters.join(' AND ')}
     ORDER BY id ASC
  `).all(...params) as Array<Record<string, unknown>>;
}

function emptyTransition(
  status: ContentWorkflowTransitionResult['status'],
  input: TransitionContentWorkflowInput,
  object: ContentWorkflowObject | null,
  toState: ContentEditorialState | null,
  approval: ContentApprovalEvaluation,
): ContentWorkflowTransitionResult {
  return {
    ok: false,
    status,
    object,
    fromState: object?.editorialState ?? null,
    toState,
    approval,
    reasonCodes: status === 'invalid_transition' ? ['invalid_lifecycle_transition'] : [],
  };
}

function isAcceptedSecretarySchedule(status: SecretarySchedulingDecision['status']): boolean {
  return status === 'scheduled' || status === 'reflowed' || status === 'compressed';
}

function defaultEditorialState(objectType: string): ContentEditorialState {
  if (objectType === 'radar_signal') return 'idea';
  if (objectType === 'outline') return 'outlined';
  if (objectType === 'script' || objectType === 'caption' || objectType === 'carousel' || objectType === 'thread') return 'drafted';
  if (objectType === 'content_calendar_item') return 'scheduled';
  return 'idea';
}

function mapWorkflowObject(row: any): ContentWorkflowObject {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    ownerUserId: Number(row.owner_user_id),
    visibilityScope: row.visibility_scope,
    objectType: row.object_type,
    title: row.title,
    editorialState: normalizeEditorialState(row.editorial_state ?? row.lifecycle_state ?? 'idea'),
    approvalState: row.approval_state ?? 'not_required',
    reviewRequired: row.review_required === 1,
    reviewReasonCodes: parseJsonArray(row.review_reason_codes_json),
    secretaryIntentId: row.secretary_intent_id ?? null,
    secretaryAgendaItemId: row.secretary_agenda_item_id ?? null,
    metadata: parseJsonObject(row.ontology_metadata_json),
    workflowVersion: Number(row.workflow_version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requestApprovalRecords(
  db: any,
  object: ContentWorkflowObject,
  input: TransitionContentWorkflowInput,
  approval: ContentApprovalEvaluation,
): void {
  for (const type of approval.approvalTypes) {
    db.prepare(`
      INSERT INTO content_approval_records (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, approval_type, approval_state,
        required_reason_codes_json, requested_by, metadata_json
      )
      VALUES (?, ?, ?, 'active', ?, ?, ?, 'required', ?, ?, ?)
      ON CONFLICT(tenant_id, owner_user_id, object_type, object_id, approval_type)
      DO UPDATE SET
        approval_state = 'required',
        required_reason_codes_json = excluded.required_reason_codes_json,
        requested_by = excluded.requested_by,
        requested_at = datetime('now'),
        metadata_json = excluded.metadata_json
    `).run(
      object.tenantId,
      object.ownerUserId,
      object.visibilityScope,
      object.objectType,
      String(object.id),
      type,
      JSON.stringify(approval.reasonCodes),
      input.actorUserId ?? input.userId,
      JSON.stringify(input.metadata ?? {}),
    );
  }
}

function approveRecordsIfConfirmed(
  db: any,
  object: ContentWorkflowObject,
  input: TransitionContentWorkflowInput,
  approval: ContentApprovalEvaluation,
): void {
  if (!input.approvalConfirmed && input.action !== 'approve_draft') return;
  for (const type of approval.approvalTypes.length > 0 ? approval.approvalTypes : ['publish' as ContentApprovalType]) {
    db.prepare(`
      INSERT INTO content_approval_records (
        tenant_id, owner_user_id, visibility_scope, scope_status,
        object_type, object_id, approval_type, approval_state,
        required_reason_codes_json, requested_by, approved_by, approved_at, metadata_json
      )
      VALUES (?, ?, ?, 'active', ?, ?, ?, 'approved', ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(tenant_id, owner_user_id, object_type, object_id, approval_type)
      DO UPDATE SET
        approval_state = 'approved',
        approved_by = excluded.approved_by,
        approved_at = datetime('now'),
        metadata_json = excluded.metadata_json
    `).run(
      object.tenantId,
      object.ownerUserId,
      object.visibilityScope,
      object.objectType,
      String(object.id),
      type,
      JSON.stringify(approval.reasonCodes),
      input.userId,
      input.actorUserId ?? input.userId,
      JSON.stringify(input.metadata ?? {}),
    );
  }
}

function writeWorkflowEvent(
  db: any,
  scope: ReturnType<typeof contentScopeForInsert>,
  input: {
    objectType: string;
    objectId: string;
    action: string;
    fromState: string | null;
    toState: string | null;
    approvalState: string;
    reviewRequired: boolean;
    reasonCodes: string[];
    actorUserId: number;
    secretaryIntentId?: string | null;
    metadata?: Record<string, unknown>;
  },
): void {
  db.prepare(`
    INSERT INTO content_workflow_events (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, object_id, action, from_state, to_state,
      approval_state, review_required, reason_codes_json, actor_user_id,
      secretary_intent_id, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scope.tenantId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.scopeStatus,
    input.objectType,
    input.objectId,
    input.action,
    input.fromState,
    input.toState,
    input.approvalState,
    input.reviewRequired ? 1 : 0,
    JSON.stringify(input.reasonCodes),
    input.actorUserId,
    input.secretaryIntentId ?? null,
    JSON.stringify(input.metadata ?? {}),
  );
}

function updateObjectReviewState(
  db: any,
  objectId: number | string,
  input: {
    approvalState: string;
    reviewRequired: boolean;
    reasonCodes: string[];
    actorUserId: number;
  },
): void {
  db.prepare(`
    UPDATE content_domain_objects
       SET approval_state = ?,
           review_required = ?,
           review_reason_codes_json = ?,
           updated_by = ?,
           updated_at = datetime('now'),
           workflow_version = workflow_version + 1
     WHERE id = ?
  `).run(
    input.approvalState,
    input.reviewRequired ? 1 : 0,
    JSON.stringify(input.reasonCodes),
    input.actorUserId,
    objectId,
  );
}

function writeSourceReviewRecord(
  db: any,
  object: ContentWorkflowObject,
  input: {
    reviewState: string;
    groundingStatus: string | null;
    reasonCodes: string[];
    actorUserId: number;
    notes: string | null;
    metadata: Record<string, unknown>;
  },
): void {
  db.prepare(`
    INSERT INTO content_source_review_records (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, object_id, review_state, grounding_status,
      reason_codes_json, reviewed_by, notes, metadata_json
    )
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    object.tenantId,
    object.ownerUserId,
    object.visibilityScope,
    object.objectType,
    String(object.id),
    input.reviewState,
    input.groundingStatus,
    JSON.stringify(input.reasonCodes),
    input.actorUserId,
    input.notes,
    JSON.stringify(input.metadata),
  );
}

function isReferenceAuthorizedForReview(ref: ContentRegisteredReference, userId: number, tenantId: number): boolean {
  if (ref.tenantId !== tenantId) return false;
  if (ref.visibilityScope === 'user_private') return ref.ownerUserId === userId;
  if (ref.visibilityScope === 'tenant_shared' || ref.visibilityScope === 'public_published') return true;
  return false;
}

function ensureDomainObjectColumns(db: any): void {
  if (!tableExists(db, 'content_domain_objects')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_domain_objects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        visibility_scope TEXT NOT NULL DEFAULT 'user_private',
        scope_status TEXT NOT NULL DEFAULT 'active',
        object_type TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL DEFAULT 'captured',
        editorial_state TEXT DEFAULT 'idea',
        approval_state TEXT DEFAULT 'not_required',
        review_required INTEGER NOT NULL DEFAULT 0,
        review_reason_codes_json TEXT DEFAULT '[]',
        title TEXT NOT NULL,
        summary TEXT,
        platform_id TEXT,
        format_id TEXT,
        ontology_metadata_json TEXT NOT NULL DEFAULT '{}',
        ontology_schema_version TEXT NOT NULL DEFAULT 'content-ontology-v1',
        created_by INTEGER NOT NULL,
        updated_by INTEGER NOT NULL,
        audit_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_by INTEGER,
        approved_at TEXT,
        rejected_reason TEXT,
        archived_at TEXT,
        scheduled_for TEXT,
        secretary_intent_id TEXT,
        secretary_agenda_item_id TEXT,
        workflow_version INTEGER NOT NULL DEFAULT 1
      );
    `);
    return;
  }
  ensureColumn(db, 'content_domain_objects', 'editorial_state', "TEXT DEFAULT 'idea'");
  ensureColumn(db, 'content_domain_objects', 'approval_state', "TEXT DEFAULT 'not_required'");
  ensureColumn(db, 'content_domain_objects', 'review_required', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'content_domain_objects', 'review_reason_codes_json', "TEXT DEFAULT '[]'");
  ensureColumn(db, 'content_domain_objects', 'approved_by', 'INTEGER');
  ensureColumn(db, 'content_domain_objects', 'approved_at', 'TEXT');
  ensureColumn(db, 'content_domain_objects', 'rejected_reason', 'TEXT');
  ensureColumn(db, 'content_domain_objects', 'archived_at', 'TEXT');
  ensureColumn(db, 'content_domain_objects', 'scheduled_for', 'TEXT');
  ensureColumn(db, 'content_domain_objects', 'secretary_intent_id', 'TEXT');
  ensureColumn(db, 'content_domain_objects', 'secretary_agenda_item_id', 'TEXT');
  ensureColumn(db, 'content_domain_objects', 'workflow_version', 'INTEGER NOT NULL DEFAULT 1');
}

function ensureRadarLifecycleColumns(db: any): void {
  if (!tableExists(db, 'content_topic_feedback')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_topic_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        visibility_scope TEXT NOT NULL DEFAULT 'user_private',
        scope_status TEXT NOT NULL DEFAULT 'active',
        topic TEXT,
        reason TEXT,
        feedback_text TEXT,
        radar_lifecycle_state TEXT DEFAULT 'detected',
        converted_to_object_id INTEGER,
        converted_to_object_type TEXT,
        converted_at TEXT,
        created_by INTEGER,
        updated_by INTEGER,
        audit_metadata_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    return;
  }
  ensureColumn(db, 'content_topic_feedback', 'tenant_id', 'INTEGER');
  ensureColumn(db, 'content_topic_feedback', 'owner_user_id', 'INTEGER');
  ensureColumn(db, 'content_topic_feedback', 'visibility_scope', "TEXT DEFAULT 'user_private'");
  ensureColumn(db, 'content_topic_feedback', 'scope_status', "TEXT DEFAULT 'active'");
  ensureColumn(db, 'content_topic_feedback', 'radar_lifecycle_state', "TEXT DEFAULT 'detected'");
  ensureColumn(db, 'content_topic_feedback', 'converted_to_object_id', 'INTEGER');
  ensureColumn(db, 'content_topic_feedback', 'converted_to_object_type', 'TEXT');
  ensureColumn(db, 'content_topic_feedback', 'converted_at', 'TEXT');
  ensureColumn(db, 'content_topic_feedback', 'updated_by', 'INTEGER');
  ensureColumn(db, 'content_topic_feedback', 'updated_at', "TEXT DEFAULT (datetime('now'))");
}

function normalizeEditorialState(value: string): ContentEditorialState {
  return CONTENT_EDITORIAL_STATES.includes(value as ContentEditorialState) ? value as ContentEditorialState : 'idea';
}

function normalizeRadarState(value: string): ContentRadarLifecycleState {
  return CONTENT_RADAR_LIFECYCLE_STATES.includes(value as ContentRadarLifecycleState)
    ? value as ContentRadarLifecycleState
    : 'detected';
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

export function validateContentObjectGenerationReadiness(
  input: ContentDomainObjectInput,
) {
  return validateGenerationReadiness(input);
}

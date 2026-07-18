// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Deprecated editorial-workflow compatibility facade.
 *
 * The canonical Content workspace owns item lifecycle, artifacts, immutable
 * revisions, lineage, approvals, and scheduling. This module intentionally
 * contains no SQL writer for those concepts. It remains only while older
 * callers migrate from `/content/workflow/:id/*` to `/content/workspace/*`.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  ContentWorkspaceError,
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  getContentWorkspaceItemDetail,
  transitionContentWorkspaceItem,
  type ContentArtifact,
  type ContentArtifactType,
  type ContentProductionState,
  type ContentRevisionContent,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from './content-workspace';
import {
  recordContentWorkspaceProductSignal,
} from './content-workspace-observability';
import {
  assessClaimsGrounding,
  type ContentRegisteredReference,
  type ContentOutputProvenance,
  type ContentProvenanceClaimInput,
} from './content-reference-provenance';
import type {
  SecretaryIntentFlexibility,
  SecretarySchedulingDecision,
  SecretarySchedulingIntent,
  SecretaryTimeWindow,
} from './secretary-scheduling-arbitrator';
import type {
  ContentDomainObjectInput,
  ContentObjectType,
} from './content-domain-ontology';
import { validateGenerationReadiness } from './content-domain-ontology';
import type {
  ContentRepurposeRecord,
  ContentTransformationType,
} from './content-novelty-reuse';
import type { ContentVisibilityScope } from './content-tenant-scope';
import { resolveContentTenantId } from './content-tenant-scope';
import {
  CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
  CONTENT_EDITORIAL_WORKFLOW_EXIT,
} from './content-editorial-workspace-exit';

export {
  CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
  CONTENT_EDITORIAL_WORKFLOW_EXIT,
};

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
  | 'content_review'
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
  productionState: ContentProductionState;
  artifactPhase: string;
  currentArtifactId: number | null;
  approvalState: string;
  reviewRequired: boolean;
  reviewReasonCodes: string[];
  secretaryIntentId: string | null;
  secretaryAgendaItemId: string | null;
  metadata: Record<string, unknown>;
  workflowVersion: number;
  nextAction: ContentWorkspaceItem['nextAction'];
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
  content?: ContentRevisionContent;
  idempotencyKey?: string;
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
  expectedWorkflowVersion?: number;
  idempotencyKey?: string;
}

export interface ContentWorkflowReplacement {
  code: string;
  message: string;
  canonicalRoutes: Partial<typeof CONTENT_EDITORIAL_WORKFLOW_EXIT.canonicalRoutes>;
  publicationExecution: 'not_performed';
  recovery: string;
}

export interface ContentWorkflowTransitionResult {
  ok: boolean;
  status: 'transitioned' | 'approval_required' | 'invalid_transition' | 'not_found' | 'version_conflict' | 'replacement_required';
  object: ContentWorkflowObject | null;
  fromState: ContentEditorialState | null;
  toState: ContentEditorialState | null;
  approval: ContentApprovalEvaluation;
  reasonCodes: string[];
  replacement?: ContentWorkflowReplacement;
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
  status: 'reviewed' | 'approval_required' | 'rejected' | 'not_found' | 'unauthorized_reference' | 'replacement_required';
  object: ContentWorkflowObject | null;
  provenance: ContentOutputProvenance | null;
  approval: ContentApprovalEvaluation;
  reasonCodes: string[];
  replacement?: ContentWorkflowReplacement;
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
  expectedWorkflowVersion?: number;
  idempotencyKey?: string;
}

export interface DecideContentApprovalResult {
  ok: boolean;
  status: 'approved' | 'rejected' | 'not_found' | 'version_conflict' | 'replacement_required' | 'invalid_transition';
  object: ContentWorkflowObject | null;
  approvalRecords: Array<Record<string, unknown>>;
  reasonCodes: string[];
  replacement?: ContentWorkflowReplacement;
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
  status: 'repurposed' | 'approval_required' | 'invalid_transition' | 'not_found' | 'replacement_required';
  sourceObject: ContentWorkflowObject | null;
  reusedObject: ContentWorkflowObject | null;
  reuseRecord: ContentRepurposeRecord | null;
  transition: ContentWorkflowTransitionResult;
  reasonCodes: string[];
  replacement?: ContentWorkflowReplacement;
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
  additionalBusyWindows?: SecretaryTimeWindow[];
  liveBusyWindowsDegraded?: boolean;
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

export class ContentEditorialCompatibilityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentEditorialCompatibilityError';
  }
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

const SAFE_LEGACY_CREATE_STATES = new Set<ContentEditorialState>([
  'idea',
  'researched',
  'selected',
  'outlined',
  'drafted',
  'reviewed',
]);

/** Schema ownership moved to migrations 090, 092, 239, and 246. */
export function ensureContentEditorialWorkflowTables(): void {
  // Deliberate no-op retained only for binary/source compatibility.
}

export function getContentEditorialCompatibility(itemId: number | string) {
  const id = String(itemId);
  return {
    ...CONTENT_EDITORIAL_WORKFLOW_EXIT,
    canonicalRoutes: Object.fromEntries(Object.entries(CONTENT_EDITORIAL_WORKFLOW_EXIT.canonicalRoutes)
      .map(([key, value]) => [key, value.replace(':itemId', id)])),
  };
}

export function createContentWorkflowObject(input: CreateContentWorkflowObjectInput): ContentWorkflowObject {
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_mutation');
  const scope = workflowScope(input.userId, input.tenantId);
  requirePrivateCompatibilityScope(input.visibilityScope);
  const idempotencyKey = requireCompatibilityIdempotencyKey(input.idempotencyKey);
  const requestedState = input.editorialState ?? defaultEditorialState(input.objectType);
  if (!SAFE_LEGACY_CREATE_STATES.has(requestedState)) {
    throw replacementError(
      'CONTENT_EDITORIAL_CREATE_STATE_UNSUPPORTED',
      'Legacy creation cannot manufacture approval, schedule, publication, archive, or rejection state.',
      409,
      replacementFor('create_artifact'),
    );
  }

  const created = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: input.title,
    summary: input.summary ?? null,
    platformId: input.platformId ?? null,
    formatId: input.formatId ?? null,
    idempotencyKey,
  });
  let item = created.value;
  const artifactType = artifactTypeForLegacyObject(input.objectType);
  const artifactIdempotencyKey = internalIdempotencyKey('editorial-artifact', idempotencyKey);
  const artifactExpectedVersion = created.replayed
    ? originalArtifactExpectedVersion(scope, item.id, artifactIdempotencyKey) ?? item.workflowVersion
    : item.workflowVersion;
  const artifact = createContentArtifact({
    scope,
    itemId: item.id,
    expectedWorkflowVersion: artifactExpectedVersion,
    artifactType,
    title: input.title,
    platformId: input.platformId ?? null,
    formatId: input.formatId ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      legacyObjectType: String(input.objectType),
      compatibilityOrigin: 'legacy_editorial_create',
      requestedEditorialState: requestedState,
    },
    initialContent: input.content,
    changeSummary: input.content ? 'Imported through the deprecated editorial compatibility facade.' : null,
    actorType: 'user',
    actorId: String(input.userId),
    provenance: { source: 'legacy_editorial_compatibility', instructionsTrusted: false },
    idempotencyKey: artifactIdempotencyKey,
  }).value;
  item = getContentWorkspaceItem(scope, item.id) ?? item;

  // Review is a safe, canonical, review-required state only when an actual
  // saved revision exists. Approval is always a separate user action.
  if (requestedState === 'reviewed' && artifact.currentRevision && item.productionState === 'active') {
    item = transitionContentWorkspaceItem({
      scope,
      itemId: item.id,
      targetState: 'review',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: internalIdempotencyKey('editorial-review', idempotencyKey),
    }).value;
  }

  const object = getContentWorkflowObject(input.userId, item.id, input.tenantId);
  if (!object) throw new ContentEditorialCompatibilityError(
    'CONTENT_WORKSPACE_WRITE_FAILED',
    'The canonical Content item could not be read after creation.',
    500,
    { recovery: 'reload_workspace', publicationExecution: 'not_performed' },
  );
  return object;
}

export function getContentWorkflowObject(
  userId: number,
  objectId: number | string,
  tenantId?: number,
): ContentWorkflowObject | null {
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_read');
  const id = positiveIntegerOrNull(objectId);
  if (id == null) return null;
  const scope = workflowScope(userId, tenantId);
  let detail;
  try {
    detail = getContentWorkspaceItemDetail(scope, id);
  } catch (error) {
    if (error instanceof ContentWorkspaceError && error.code === 'CONTENT_VALIDATION_FAILED') return null;
    throw error;
  }
  if (!detail) return null;
  const currentArtifact = detail.artifacts.find((artifact) => artifact.id === detail.currentArtifactId) ?? null;
  const row = getDb().prepare(`
    SELECT approval_state, review_required, review_reason_codes_json,
           ontology_metadata_json, audit_metadata_json
      FROM content_domain_objects
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
       AND object_type IN ('content_item', 'project')
     LIMIT 1
  `).get(id, scope.tenantId, scope.userId) as any;
  if (!row) return null;
  return mapCompatibilityObject(scope, detail, currentArtifact, row);
}

export function transitionContentWorkflow(input: TransitionContentWorkflowInput): ContentWorkflowTransitionResult {
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_mutation');
  const object = getContentWorkflowObject(input.userId, input.objectId, input.tenantId);
  const approval = evaluateContentApprovalRequirements({
    ...input,
    currentState: object?.editorialState,
    visibilityScope: object?.visibilityScope,
  });
  if (!object) return emptyTransition('not_found', input, null, null, approval, ['content_object_not_found_or_unauthorized']);
  if (!approvalActorAuthorized(object, input.actorUserId ?? input.userId, input.userId)) {
    return emptyTransition('not_found', input, null, null, approval, ['content_object_not_found_or_unauthorized']);
  }

  const replacement = replacementFor(input.action);
  const targetState = canonicalTargetForLegacyAction(input.action);
  if (!targetState) {
    return emptyTransition(
      'replacement_required',
      input,
      object,
      legacyTargetForAction(input.action),
      approval,
      [replacement.code],
      replacement,
    );
  }
  if (approval.approvalRequired && input.approvalConfirmed !== true) {
    return emptyTransition(
      'approval_required',
      input,
      object,
      editorialStateForTarget(targetState, object.artifactPhase),
      approval,
      approval.reasonCodes,
    );
  }
  if (!validConcurrency(input.expectedWorkflowVersion, input.idempotencyKey)) {
    const concurrencyReplacement = replacementFor('canonical_concurrency');
    return emptyTransition(
      'replacement_required',
      input,
      object,
      editorialStateForTarget(targetState, object.artifactPhase),
      approval,
      [concurrencyReplacement.code],
      concurrencyReplacement,
    );
  }

  try {
    const mutation = transitionContentWorkspaceItem({
      scope: workflowScope(input.userId, input.tenantId),
      itemId: object.id,
      targetState,
      expectedWorkflowVersion: input.expectedWorkflowVersion!,
      idempotencyKey: input.idempotencyKey!,
    });
    const updated = getContentWorkflowObject(input.userId, object.id, input.tenantId);
    return {
      ok: true,
      status: 'transitioned',
      object: updated,
      fromState: object.editorialState,
      toState: updated?.editorialState ?? editorialStateForTarget(targetState, object.artifactPhase),
      approval,
      reasonCodes: mutation.replayed ? ['canonical_idempotent_replay'] : [],
    };
  } catch (error) {
    return transitionFailure(error, input, object, approval, targetState);
  }
}

export function evaluateContentApprovalRequirements(input: ContentApprovalEvaluationInput): ContentApprovalEvaluation {
  const approvalTypes: ContentApprovalType[] = [];
  const reasonCodes: string[] = [];
  if (
    input.action === 'mark_published'
    || input.action === 'publish'
    || input.targetState === 'published'
    || input.sendsExternally
    || input.action === 'external_send_publish'
  ) {
    approvalTypes.push('publish');
    reasonCodes.push('publish_requires_human_approval');
  }
  if ((input.action === 'schedule_content' || input.targetState === 'scheduled') && input.visibilityScope === 'tenant_shared') {
    approvalTypes.push('schedule_tenant_shared');
    reasonCodes.push('tenant_shared_scheduling_requires_approval');
  }
  if (input.action === 'delete_draft' || (input.action === 'archive' && ['drafted', 'reviewed', 'revised'].includes(input.currentState ?? ''))) {
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
  if (input.changesBrandVoice || input.action === 'change_brand_voice') {
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
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_mutation');
  const object = getContentWorkflowObject(input.userId, input.objectId, input.tenantId);
  const approval = evaluateContentApprovalRequirements({
    action: 'approve_draft',
    currentState: object?.editorialState,
    visibilityScope: object?.visibilityScope,
    references: input.references,
    claims: input.claims,
  });
  if (!object || (input.objectType && !legacyObjectTypeMatches(object, input.objectType))) {
    return { ok: false, status: 'not_found', object: null, provenance: null, approval, reasonCodes: ['content_object_not_found_or_unauthorized'] };
  }
  const scope = workflowScope(input.userId, input.tenantId);
  if (input.references?.some((reference) => !referenceAuthorized(reference, scope))) {
    return {
      ok: false,
      status: 'unauthorized_reference',
      object,
      provenance: null,
      approval,
      reasonCodes: ['unauthorized_reference_for_source_review'],
    };
  }
  const replacement = replacementFor('source_review');
  return {
    ok: false,
    status: 'replacement_required',
    object,
    provenance: null,
    approval,
    reasonCodes: [replacement.code],
    replacement,
  };
}

export function decideContentApproval(input: DecideContentApprovalInput): DecideContentApprovalResult {
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_mutation');
  const object = getContentWorkflowObject(input.userId, input.objectId, input.tenantId);
  if (!object || !approvalActorAuthorized(object, input.actorUserId ?? input.userId, input.userId)) {
    return { ok: false, status: 'not_found', object: null, approvalRecords: [], reasonCodes: ['content_object_not_found_or_unauthorized'] };
  }
  if (input.approvalType !== 'content_review') {
    const replacement = input.approvalType === 'publish'
      ? replacementFor('mark_published')
      : replacementFor('approval_type');
    return {
      ok: false,
      status: 'replacement_required',
      object,
      approvalRecords: listContentApprovalRecords({ userId: input.userId, tenantId: input.tenantId, objectId: object.id }),
      reasonCodes: [replacement.code],
      replacement,
    };
  }
  if (!validConcurrency(input.expectedWorkflowVersion, input.idempotencyKey)) {
    const replacement = replacementFor('canonical_concurrency');
    return {
      ok: false,
      status: 'replacement_required',
      object,
      approvalRecords: listContentApprovalRecords({ userId: input.userId, tenantId: input.tenantId, objectId: object.id }),
      reasonCodes: [replacement.code],
      replacement,
    };
  }
  const transition = transitionContentWorkflow({
    userId: input.userId,
    tenantId: input.tenantId,
    objectId: object.id,
    action: input.decision === 'approved' ? 'approve_draft' : 'reject',
    actorUserId: input.actorUserId,
    expectedWorkflowVersion: input.expectedWorkflowVersion,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
    reason: input.reason,
  });
  const status: DecideContentApprovalResult['status'] = transition.status === 'transitioned'
    ? input.decision
    : transition.status === 'version_conflict'
      ? 'version_conflict'
      : transition.status === 'not_found'
        ? 'not_found'
        : transition.status === 'replacement_required'
          ? 'replacement_required'
          : 'invalid_transition';
  return {
    ok: transition.ok,
    status,
    object: transition.object,
    approvalRecords: listContentApprovalRecords({ userId: input.userId, tenantId: input.tenantId, objectId: object.id }),
    reasonCodes: transition.reasonCodes,
    ...(transition.replacement ? { replacement: transition.replacement } : {}),
  };
}

export function repurposeContentWorkflowObject(input: RepurposeContentWorkflowInput): RepurposeContentWorkflowResult {
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_mutation');
  const source = getContentWorkflowObject(input.userId, input.sourceObjectId, input.tenantId);
  const approval = evaluateContentApprovalRequirements({ action: 'repurpose_content' });
  const replacement = replacementFor('repurpose_content');
  const transition = emptyTransition(
    source ? 'replacement_required' : 'not_found',
    { action: 'repurpose_content' },
    source,
    source?.editorialState ?? null,
    approval,
    source ? [replacement.code] : ['content_object_not_found_or_unauthorized'],
    source ? replacement : undefined,
  );
  return {
    ok: false,
    status: source ? 'replacement_required' : 'not_found',
    sourceObject: source,
    reusedObject: null,
    reuseRecord: null,
    transition,
    reasonCodes: transition.reasonCodes,
    ...(source ? { replacement } : {}),
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

/** Pure preview-shape helper retained for old diagnostics; it never schedules. */
export function buildContentSecretarySchedulingIntent(input: ContentScheduleRequestInput): SecretarySchedulingIntent {
  return {
    intentId: `content-workspace:${input.objectId}:work`,
    action: 'find_time_for_this',
    sourceSkill: 'content',
    sourceAction: 'schedule_content_work_block',
    sourceEntityId: input.objectId,
    sourceEntityType: 'content_workspace_item',
    ownerUserId: input.userId,
    tenantId: resolveContentTenantId(input.userId, input.tenantId),
    title: input.title,
    requestedDurationMinutes: input.durationMinutes ?? 60,
    minimumDurationMinutes: input.minimumDurationMinutes,
    preferredWindows: input.preferredWindows,
    hardConstraints: input.unavailableWindows || input.protectedWindows
      ? { unavailableWindows: input.unavailableWindows, protectedWindows: input.protectedWindows }
      : undefined,
    deadline: input.deadline ?? null,
    priority: input.priority ?? 'normal',
    flexibility: input.flexibility ?? 'flexible',
    reason: input.reason ?? 'Preview a private Content work block.',
    context: 'Content owns the item. Secretary owns time placement. This intent never publishes content.',
  };
}

/**
 * Removed single-step scheduling boundary. Callers must preview and then
 * explicitly confirm through content-workspace-scheduling.
 */
export function requestContentScheduleThroughSecretary(
  input: ContentScheduleRequestInput,
): SecretarySchedulingDecision {
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_mutation');
  const object = getContentWorkflowObject(input.userId, input.objectId, input.tenantId);
  if (!object) {
    throw new ContentEditorialCompatibilityError(
      'CONTENT_ITEM_NOT_FOUND',
      'Content item not found.',
      404,
      { publicationExecution: 'not_performed' },
    );
  }
  throw replacementError(
    'CONTENT_WORKFLOW_SCHEDULING_MOVED',
    'Legacy single-step scheduling is retired. Preview a Content work block, review the exact effect, then confirm it explicitly.',
    426,
    replacementFor('schedule_content'),
  );
}

export function convertRadarSignalToIdea(input: ConvertRadarSignalInput): ConvertRadarSignalResult {
  const db = getDb();
  const scope = workflowScope(input.userId, input.tenantId);
  const row = db.prepare(`
    SELECT * FROM content_topic_feedback
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
       AND visibility_scope = 'user_private' AND scope_status = 'active'
     LIMIT 1
  `).get(input.radarSignalId, scope.tenantId, scope.userId) as any;
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
  if (fromState === toState && row.converted_to_object_id) {
    return {
      ok: true,
      status: 'converted',
      radarSignalId: String(input.radarSignalId),
      radarFromState: fromState,
      radarToState: toState,
      object: getContentWorkflowObject(input.userId, row.converted_to_object_id, input.tenantId),
      reasonCodes: ['canonical_idempotent_replay'],
    };
  }
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
  if (input.visibilityScope && input.visibilityScope !== 'user_private') {
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

  return db.transaction((): ConvertRadarSignalResult => {
    const object = createContentWorkflowObject({
      userId: input.userId,
      tenantId: input.tenantId,
      visibilityScope: 'user_private',
      objectType: 'idea',
      title: input.title ?? row.topic ?? row.title ?? `Radar signal ${input.radarSignalId}`,
      summary: input.summary ?? row.reason ?? row.feedback_text ?? null,
      editorialState: 'idea',
      metadata: {
        ...(input.metadata ?? {}),
        generatedFromRadarSignalId: String(input.radarSignalId),
        radarFromState: fromState,
      },
      idempotencyKey: internalIdempotencyKey('radar-idea', `${scope.tenantId}:${scope.userId}:${input.radarSignalId}`),
    });
    const update = db.prepare(`
      UPDATE content_topic_feedback
         SET radar_lifecycle_state = ?, converted_to_object_id = ?,
             converted_to_object_type = 'content_item', converted_at = datetime('now'),
             updated_by = ?
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
         AND radar_lifecycle_state = ?
    `).run(toState, object.id, input.actorUserId ?? input.userId, input.radarSignalId, scope.tenantId, scope.userId, fromState);
    if (update.changes !== 1) throw new ContentEditorialCompatibilityError(
      'CONTENT_RADAR_VERSION_CONFLICT',
      'The radar signal changed while it was being converted.',
      409,
      { recovery: 'reload_radar_signal', publicationExecution: 'not_performed' },
    );
    return {
      ok: true,
      status: 'converted',
      radarSignalId: String(input.radarSignalId),
      radarFromState: fromState,
      radarToState: toState,
      object,
      reasonCodes: ['radar_signal_converted_to_canonical_idea'],
    };
  }).immediate();
}

export function listContentWorkflowEvents(input: {
  userId: number;
  tenantId?: number;
  objectType?: string;
  objectId?: string | number;
}): Array<Record<string, unknown>> {
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_read');
  const scope = workflowScope(input.userId, input.tenantId);
  const filters = [
    "tenant_id = ?",
    "owner_user_id = ?",
    "visibility_scope = 'user_private'",
    "scope_status = 'active'",
  ];
  const params: unknown[] = [scope.tenantId, scope.userId];
  if (input.objectId != null) {
    filters.push('object_id = ?');
    params.push(String(input.objectId));
  } else if (input.objectType) {
    filters.push('object_type = ?');
    params.push(input.objectType);
  }
  return getDb().prepare(`
    SELECT * FROM content_workflow_events
     WHERE ${filters.join(' AND ')}
     ORDER BY id ASC
  `).all(...params) as Array<Record<string, unknown>>;
}

/** Historical audit evidence only. Migration 249 blocks every runtime write. */
export function listContentApprovalRecords(input: {
  userId: number;
  tenantId?: number;
  objectType?: string;
  objectId?: string | number;
}): Array<Record<string, unknown>> {
  recordContentWorkspaceProductSignal('legacy_editorial_compatibility_read');
  const scope = workflowScope(input.userId, input.tenantId);
  const filters = [
    'tenant_id = ?',
    'owner_user_id = ?',
    "visibility_scope = 'user_private'",
    "scope_status = 'active'",
  ];
  const params: unknown[] = [scope.tenantId, scope.userId];
  if (input.objectId != null) {
    filters.push('object_id = ?');
    params.push(String(input.objectId));
  } else if (input.objectType) {
    filters.push('object_type = ?');
    params.push(input.objectType);
  }
  return getDb().prepare(`
    SELECT * FROM content_approval_records
     WHERE ${filters.join(' AND ')}
     ORDER BY id ASC
  `).all(...params) as Array<Record<string, unknown>>;
}

export function validateContentObjectGenerationReadiness(input: ContentDomainObjectInput) {
  return validateGenerationReadiness(input);
}

function mapCompatibilityObject(
  scope: ContentWorkspaceScope,
  item: ReturnType<typeof getContentWorkspaceItemDetail> extends infer T ? Exclude<T, null> : never,
  artifact: ContentArtifact | null,
  row: any,
): ContentWorkflowObject {
  const productionState = item.productionState;
  const editorialState = editorialStateForTarget(productionState, item.artifactPhase);
  const approvalState = productionState === 'review'
    ? 'required'
    : productionState === 'approved'
      ? 'approved'
      : productionState === 'rejected'
        ? 'rejected'
        : 'not_required';
  const metadata = {
    ...parseObject(row.ontology_metadata_json),
    ...parseObject(row.audit_metadata_json),
    ...(artifact?.metadata ?? {}),
    compatibility: getContentEditorialCompatibility(item.id),
  };
  return {
    id: item.id,
    tenantId: scope.tenantId,
    ownerUserId: scope.userId,
    visibilityScope: 'user_private',
    objectType: legacyObjectType(artifact),
    title: item.title,
    editorialState,
    productionState,
    artifactPhase: item.artifactPhase,
    currentArtifactId: item.currentArtifactId,
    approvalState,
    reviewRequired: productionState === 'review',
    reviewReasonCodes: productionState === 'review' ? parseStringArray(row.review_reason_codes_json) : [],
    // Canonical scheduling truth is exposed only by the schedule read model;
    // legacy Secretary ids are intentionally never projected as authority.
    secretaryIntentId: null,
    secretaryAgendaItemId: null,
    metadata,
    workflowVersion: item.workflowVersion,
    nextAction: item.nextAction,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function transitionFailure(
  error: unknown,
  input: TransitionContentWorkflowInput,
  object: ContentWorkflowObject,
  approval: ContentApprovalEvaluation,
  targetState: ContentProductionState,
): ContentWorkflowTransitionResult {
  if (error instanceof ContentWorkspaceError) {
    const current = getContentWorkflowObject(input.userId, object.id, input.tenantId);
    const reasonCodes = [error.code, ...stringArray(error.details?.reasonCodes)];
    if (error.code === 'CONTENT_WORKFLOW_VERSION_CONFLICT') {
      return emptyTransition('version_conflict', input, current, current?.editorialState ?? object.editorialState, approval, reasonCodes);
    }
    if (error.code === 'CONTENT_ITEM_NOT_FOUND') {
      return emptyTransition('not_found', input, null, null, approval, reasonCodes);
    }
    return emptyTransition(
      'invalid_transition',
      input,
      current ?? object,
      editorialStateForTarget(targetState, object.artifactPhase),
      approval,
      reasonCodes,
    );
  }
  throw error;
}

function emptyTransition(
  status: ContentWorkflowTransitionResult['status'],
  input: Pick<TransitionContentWorkflowInput, 'action'>,
  object: ContentWorkflowObject | null,
  toState: ContentEditorialState | null,
  approval: ContentApprovalEvaluation,
  reasonCodes: string[],
  replacement?: ContentWorkflowReplacement,
): ContentWorkflowTransitionResult {
  return {
    ok: false,
    status,
    object,
    fromState: object?.editorialState ?? null,
    toState,
    approval,
    reasonCodes,
    ...(replacement ? { replacement } : {}),
  };
}

function canonicalTargetForLegacyAction(action: ContentWorkflowAction): ContentProductionState | null {
  if (action === 'approve_draft') return 'approved';
  if (action === 'archive') return 'archived';
  if (action === 'reject') return 'rejected';
  return null;
}

function legacyTargetForAction(action: ContentWorkflowAction): ContentEditorialState | null {
  const targets: Partial<Record<ContentWorkflowAction, ContentEditorialState>> = {
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
  return targets[action] ?? null;
}

function replacementFor(action: ContentWorkflowAction | 'source_review' | 'approval_type' | 'create_artifact' | 'canonical_concurrency'): ContentWorkflowReplacement {
  const routes = CONTENT_EDITORIAL_WORKFLOW_EXIT.canonicalRoutes;
  switch (action) {
    case 'schedule_content':
      return {
        code: 'CONTENT_WORKFLOW_SCHEDULING_MOVED',
        message: 'Create a schedule preview and explicitly confirm one slot. This schedules work only and never publishes.',
        canonicalRoutes: { schedulePreview: routes.schedulePreview, scheduleConfirm: routes.scheduleConfirm },
        publicationExecution: 'not_performed',
        recovery: 'create_schedule_preview_then_confirm',
      };
    case 'mark_published':
      return {
        code: 'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED',
        message: 'Publication cannot be inferred from a legacy state change. No publication was performed.',
        canonicalRoutes: { item: routes.item },
        publicationExecution: 'not_performed',
        recovery: 'confirm_external_publication_in_a_dedicated_tracking_flow',
      };
    case 'source_review':
      return {
        code: 'CONTENT_SOURCE_REVIEW_MOVED',
        message: 'Register private sources and record immutable lineage against the exact saved revision.',
        canonicalRoutes: { sources: routes.sources, lineage: routes.lineage },
        publicationExecution: 'not_performed',
        recovery: 'register_sources_then_record_revision_lineage',
      };
    case 'repurpose_content':
      return {
        code: 'CONTENT_REPURPOSE_MOVED',
        message: 'Create a canonical target item and record a derived, variant, or remix relationship.',
        canonicalRoutes: { item: routes.item, relationships: routes.relationships },
        publicationExecution: 'not_performed',
        recovery: 'create_target_item_then_record_relationship',
      };
    case 'delete_draft':
      return {
        code: 'CONTENT_DELETE_MOVED',
        message: 'Use the recoverable workspace Trash operation with the current workflow version.',
        canonicalRoutes: { item: routes.item },
        publicationExecution: 'not_performed',
        recovery: 'soft_delete_with_cas_and_idempotency',
      };
    case 'canonical_concurrency':
      return {
        code: 'CONTENT_WORKFLOW_CANONICAL_CONCURRENCY_REQUIRED',
        message: 'Reload the item and provide expectedWorkflowVersion plus an idempotency key.',
        canonicalRoutes: { item: routes.item, state: routes.state },
        publicationExecution: 'not_performed',
        recovery: 'reload_and_retry_with_cas_and_idempotency',
      };
    case 'approval_type':
      return {
        code: 'CONTENT_APPROVAL_TYPE_REQUIRED',
        message: 'Only an explicit content_review approval can use this compatibility adapter.',
        canonicalRoutes: { item: routes.item, state: routes.state },
        publicationExecution: 'not_performed',
        recovery: 'submit_explicit_content_review_decision',
      };
    case 'create_artifact':
    case 'convert_radar_to_idea':
    case 'convert_radar_to_script':
    case 'convert_idea_to_outline':
    case 'convert_outline_to_script':
    case 'refine_script':
      return {
        code: 'CONTENT_ARTIFACT_WORKFLOW_MOVED',
        message: 'Create the next typed artifact or save a new immutable revision in the workspace.',
        canonicalRoutes: { artifacts: routes.artifacts, revisions: routes.revisions },
        publicationExecution: 'not_performed',
        recovery: 'create_typed_artifact_or_save_revision',
      };
    case 'mark_stale':
      return {
        code: 'CONTENT_STALE_STATE_RETIRED',
        message: 'The parallel stale lifecycle is retired. Use status, deadline, and next-action workspace fields.',
        canonicalRoutes: { item: routes.item },
        publicationExecution: 'not_performed',
        recovery: 'update_workspace_metadata',
      };
    default:
      return {
        code: 'CONTENT_WORKFLOW_ACTION_MOVED',
        message: 'This legacy editorial action has moved to the canonical Content workspace.',
        canonicalRoutes: { item: routes.item, state: routes.state },
        publicationExecution: 'not_performed',
        recovery: 'use_canonical_workspace_contract',
      };
  }
}

function replacementError(code: string, message: string, status: number, replacement: ContentWorkflowReplacement) {
  return new ContentEditorialCompatibilityError(code, message, status, {
    ...replacement,
    compatibilitySchemaVersion: CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
  });
}

function workflowScope(userId: number, tenantId?: number): ContentWorkspaceScope {
  if (!Number.isInteger(userId) || userId <= 0) throw new ContentEditorialCompatibilityError(
    'CONTENT_SCOPE_REQUIRED',
    'A valid authenticated user is required.',
    401,
    { publicationExecution: 'not_performed' },
  );
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  if (!Number.isInteger(resolvedTenantId) || resolvedTenantId <= 0) throw new ContentEditorialCompatibilityError(
    'CONTENT_SCOPE_REQUIRED',
    'A valid tenant is required.',
    401,
    { publicationExecution: 'not_performed' },
  );
  return { tenantId: resolvedTenantId, userId };
}

function requirePrivateCompatibilityScope(scope: ContentVisibilityScope | undefined): void {
  if (scope == null || scope === 'user_private') return;
  throw replacementError(
    'CONTENT_SHARED_WORKFLOW_ROLE_REQUIRED',
    'The canonical workspace is private until explicit tenant collaboration roles and approvals exist.',
    409,
    replacementFor('create_artifact'),
  );
}

function requireCompatibilityIdempotencyKey(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 200) {
    throw replacementError(
      'CONTENT_IDEMPOTENCY_KEY_REQUIRED',
      'An idempotency key between 8 and 200 characters is required.',
      409,
      replacementFor('canonical_concurrency'),
    );
  }
  return value.trim();
}

function validConcurrency(version: number | undefined, idempotencyKey: string | undefined): boolean {
  return Number.isInteger(version) && Number(version) > 0
    && typeof idempotencyKey === 'string'
    && idempotencyKey.trim().length >= 8
    && idempotencyKey.trim().length <= 200;
}

function internalIdempotencyKey(prefix: string, seed: string): string {
  return `${prefix}:${createHash('sha256').update(seed).digest('hex')}`;
}

function originalArtifactExpectedVersion(
  scope: ContentWorkspaceScope,
  itemId: number,
  idempotencyKey: string,
): number | null {
  const db = getDb();
  const receipt = db.prepare(`
    SELECT resource_id
      FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
     LIMIT 1
  `).get(scope.tenantId, scope.userId, `create_artifact:${itemId}`, idempotencyKey) as {
    resource_id: string;
  } | undefined;
  if (!receipt) return null;
  const events = db.prepare(`
    SELECT metadata_json
      FROM content_workflow_events
     WHERE tenant_id = ? AND owner_user_id = ?
       AND object_type = 'content_item' AND object_id = ?
       AND action = 'workspace_artifact_created'
     ORDER BY id ASC
  `).all(scope.tenantId, scope.userId, String(itemId)) as Array<{ metadata_json: string }>;
  for (const event of events) {
    const metadata = parseObject(event.metadata_json);
    if (String(metadata.artifactId ?? '') !== receipt.resource_id) continue;
    const version = Number(metadata.expectedWorkflowVersion);
    if (Number.isSafeInteger(version) && version > 0) return version;
  }
  throw new ContentEditorialCompatibilityError(
    'CONTENT_IDEMPOTENCY_RECEIPT_INCONSISTENT',
    'The prior compatibility write cannot be verified safely.',
    500,
    { recovery: 'reload_workspace_item', publicationExecution: 'not_performed' },
  );
}

function artifactTypeForLegacyObject(objectType: string): ContentArtifactType {
  switch (objectType) {
    case 'idea': return 'idea_note';
    case 'brief': return 'brief';
    case 'outline': return 'outline';
    case 'script': return 'script';
    case 'caption': return 'caption';
    case 'shot_list': return 'shot_list';
    case 'platform_variant': return 'platform_variant';
    case 'research_notes': return 'research_notes';
    default: return 'other';
  }
}

function legacyObjectType(artifact: ContentArtifact | null): string {
  const explicit = artifact?.metadata?.legacyObjectType;
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  switch (artifact?.artifactType) {
    case 'idea_note': return 'idea';
    case 'brief': return 'brief';
    case 'outline': return 'outline';
    case 'script': return 'script';
    case 'caption': return 'caption';
    case 'shot_list': return 'shot_list';
    case 'platform_variant': return 'platform_variant';
    case 'research_notes': return 'research_notes';
    default: return 'content_item';
  }
}

function legacyObjectTypeMatches(object: ContentWorkflowObject, requested: string): boolean {
  return object.objectType === requested || requested === 'content_item';
}

function editorialStateForTarget(state: ContentProductionState, artifactPhase: string): ContentEditorialState {
  if (state === 'review') return 'reviewed';
  if (state === 'approved') return 'approved';
  if (state === 'scheduled') return 'scheduled';
  if (state === 'published') return 'published';
  if (state === 'archived') return 'archived';
  if (state === 'rejected') return 'rejected';
  if (artifactPhase === 'outline') return 'outlined';
  if (artifactPhase === 'draft' || artifactPhase === 'final') return 'drafted';
  return 'idea';
}

function defaultEditorialState(objectType: string): ContentEditorialState {
  if (objectType === 'outline') return 'outlined';
  if (['script', 'caption', 'carousel', 'thread'].includes(objectType)) return 'drafted';
  if (objectType === 'content_calendar_item') return 'selected';
  return 'idea';
}

function approvalActorAuthorized(object: ContentWorkflowObject, actor: number, userId: number): boolean {
  return actor === userId && object.ownerUserId === userId && object.visibilityScope === 'user_private';
}

function referenceAuthorized(reference: ContentRegisteredReference, scope: ContentWorkspaceScope): boolean {
  return reference.tenantId === scope.tenantId
    && reference.ownerUserId === scope.userId
    && reference.visibilityScope === 'user_private';
}

function positiveIntegerOrNull(value: number | string): number | null {
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeRadarState(value: string): ContentRadarLifecycleState {
  return CONTENT_RADAR_LIFECYCLE_STATES.includes(value as ContentRadarLifecycleState)
    ? value as ContentRadarLifecycleState
    : 'detected';
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return stringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

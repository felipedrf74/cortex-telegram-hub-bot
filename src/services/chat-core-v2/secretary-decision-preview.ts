// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  buildNormalizedDecisionAction,
  type DecisionActionResourceRef,
  type NormalizedDecisionAction,
} from '../decision-action-contract';
import { revalidateNormalizedDecisionAction } from '../decision-preexecution-revalidator';
import { createDecisionIntent } from '../decision-center';
import type { NotificationPriority, NotificationPrivacyPolicy } from '../notification-orchestrator';
import { getChatCoreV2Capability, isChatCoreV2CapabilityEnabled } from './capability-registry';
import {
  secretaryCandidateMaterialEvidenceIds,
  type SecretaryReasoningCandidate,
} from './secretary-candidate-schema';
import type { SecretaryContextFact, SecretaryContextSnapshot } from './secretary-context-snapshot';
import type {
  ConflictAuthority,
  ConflictComparisonAction,
  ConflictEvaluation,
} from '../decision-conflict-evaluator';
import { hmacTenantScopedEvidenceFingerprint } from './cloud-allowlist-packet';

export interface SecretaryDecisionPreviewResult {
  status: 'created' | 'blocked' | 'suppressed' | 'failed' | 'not_applicable';
  userFacingText: string;
  decisionId?: string;
  action?: NormalizedDecisionAction;
  conflictEvaluation?: ConflictEvaluation;
  reasonCodes: string[];
}

export interface CreateSecretaryDecisionPreviewInput {
  candidate: SecretaryReasoningCandidate;
  snapshot: SecretaryContextSnapshot;
  userId: number;
  tenantId: number;
  locale?: string | null;
  now?: Date;
}

/** Deterministic adapter from an evidence-bound proposal to the shared action contract. */
export function mapSecretaryCandidateToNormalizedAction(input: {
  candidate: SecretaryReasoningCandidate;
  snapshot: SecretaryContextSnapshot;
  tenantId: number;
}): NormalizedDecisionAction {
  const { candidate, snapshot, tenantId } = input;
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || snapshot.tenantId !== tenantId) {
    throw new Error('SECRETARY_DECISION_PREVIEW_SCOPE_MISMATCH');
  }
  if ((candidate.behavior !== 'decision_center' && candidate.behavior !== 'conflict_review')
    || !candidate.actionDraft || !candidate.capabilityId) {
    throw new Error('SECRETARY_DECISION_PREVIEW_CANDIDATE_REQUIRED');
  }
  const capability = getChatCoreV2Capability(candidate.capabilityId);
  if (!capability
    || !isChatCoreV2CapabilityEnabled(candidate.capabilityId, {
      scope: { userId: snapshot.userId, tenantId },
    })
    || capability.support.preview === 'blocked'
    || capability.support.preview === 'not_applicable') {
    throw new Error('SECRETARY_DECISION_PREVIEW_CAPABILITY_UNAVAILABLE');
  }
  const factsById = new Map(snapshot.facts.map((fact) => [fact.evidenceId, fact]));
  const targets = candidate.actionDraft.targetEvidenceIds.map((evidenceId) => {
    const fact = factsById.get(evidenceId);
    if (!fact) throw new Error('SECRETARY_DECISION_PREVIEW_EVIDENCE_MISSING');
    return {
      type: entityTypeForFact(fact),
      id: privacySafeEvidenceToken(snapshot.tenantId, 'secretary_target', `${snapshot.userId}:${fact.source}:${fact.sourceRef ?? fact.evidenceId}`),
      version: privacySafeEvidenceToken(snapshot.tenantId, 'entity_version', fact.entityVersion),
    };
  });
  const targetFacts = candidate.actionDraft.targetEvidenceIds
    .map((evidenceId) => factsById.get(evidenceId))
    .filter((fact): fact is SecretaryContextFact => !!fact);
  if (targets.length === 0) throw new Error('SECRETARY_DECISION_PREVIEW_TARGET_REQUIRED');
  const resources = resourcesFor(capability.commandType ?? capability.capabilityId, targetFacts);
  const targetRef = `${targets[0].type}:${targets[0].id}`;
  const risk = capability.risk === 'restricted' ? 'critical' : capability.risk;
  // Chat Core v2 registers deterministic undo, but no generic compensation
  // contract. Do not persist a compensatable claim that execution cannot honor.
  const reversibility = capability.undoPolicy.supported
    ? 'reversible'
    : 'irreversible';
  return buildNormalizedDecisionAction({
    intent: capability.commandType ?? capability.capabilityId,
    targetEntities: targets,
    affectedResources: resources,
    ...(candidate.actionDraft.requestedWindow ? { requestedWindow: candidate.actionDraft.requestedWindow } : {}),
    // Generic evidence-version preconditions are not executable invariants in
    // the current registry. Entity versions remain on the scoped target refs;
    // Decision Center revalidates the context and conflict sources before use.
    preconditions: [],
    expectedEffects: [{ type: 'review_required', targetRef }],
    prohibitedEffects: [
      { type: 'automatic_execution', targetRef },
      { type: 'automatic_external_mutation', targetRef },
    ],
    dependencies: [
      `capability:${capability.capabilityId}`,
      `permission_snapshot:${snapshot.permissionSnapshotVersion}`,
    ],
    exclusivityKeys: resources.map((resource) => `${resource.type}:${tenantId}`),
    // This record is review-only; execution authorization is intentionally not
    // copied from model output or inferred from the proposed domain capability.
    authorizationScope: ['decision_center:read'],
    risk,
    reversibility,
    contextVersion: snapshot.contextVersion,
  });
}

export async function createSecretaryDecisionPreview(
  input: CreateSecretaryDecisionPreviewInput,
): Promise<SecretaryDecisionPreviewResult> {
  const pt = String(input.locale ?? '').toLowerCase().startsWith('pt');
  if (input.candidate.behavior !== 'decision_center' && input.candidate.behavior !== 'conflict_review') {
    return {
      status: 'not_applicable',
      userFacingText: input.candidate.userFacingText,
      reasonCodes: ['candidate_does_not_require_decision_center'],
    };
  }
  if (!validScope(input)) {
    return failedResult(pt, ['decision_preview_scope_invalid']);
  }

  let action: NormalizedDecisionAction;
  try {
    action = mapSecretaryCandidateToNormalizedAction({
      candidate: input.candidate,
      snapshot: input.snapshot,
      tenantId: input.tenantId,
    });
  } catch {
    return failedResult(pt, ['decision_preview_mapping_failed']);
  }

  const now = input.now ?? new Date();
  const evidenceComparisons = secretaryEvidenceConflictComparisons(
    input.candidate,
    input.snapshot,
    action,
  );
  let revalidation: ReturnType<typeof revalidateNormalizedDecisionAction>;
  try {
    revalidation = revalidateNormalizedDecisionAction({
      scope: { userId: input.userId, tenantId: input.tenantId },
      action,
      additionalExisting: evidenceComparisons,
      contextExpiresAt: input.snapshot.expiresAt,
      candidateCreatedAt: input.snapshot.observedAt,
      confidence: input.candidate.factors.confidence,
      now,
    });
  } catch {
    return failedResult(pt, ['decision_preview_revalidation_failed'], action);
  }
  const conflict = revalidation.conflictEvaluation;
  if (conflict.disposition === 'suppress_duplicate') {
    return {
      status: 'suppressed',
      userFacingText: pt
        ? 'Esta proposta já está no Decision Center. Não criei uma notificação repetida e não alterei nada.'
        : 'This proposal is already in Decision Center. I did not create a duplicate notification or change anything.',
      action,
      conflictEvaluation: conflict,
      reasonCodes: conflict.reasonCodes.length ? conflict.reasonCodes : ['duplicate_preview_suppressed'],
    };
  }

  const capability = getChatCoreV2Capability(input.candidate.capabilityId!);
  if (!capability) return failedResult(pt, ['decision_preview_capability_missing']);
  const requestedWindow = action.requestedWindow;
  const hasTimeConflict = conflict.findings.some((finding) => finding.class === 'time_overlap');
  const copy = fixedPreviewCopy(capability.commandType ?? capability.capabilityId, pt);
  const priority = notificationPriority(action, now);
  const reviewExpiresAt = durableReviewExpiry(action, priority, now);
  try {
    const result = await createDecisionIntent({
      userId: input.userId,
      tenantId: input.tenantId,
      sourceSkill: 'secretary',
      type: input.candidate.behavior === 'conflict_review' || conflict.findings.length > 0
        ? 'conflict_detected'
        : 'decision_required',
      priority,
      relatedEntityId: action.candidateFingerprint,
      relatedEntityType: 'secretary_candidate',
      title: copy.title,
      body: copy.body,
      actionButtons: [{ id: 'open_detail', label: pt ? 'Rever proposta' : 'Review proposal', style: 'primary' }],
      expiresAt: reviewExpiresAt,
      decisionDeadline: reviewExpiresAt,
      dedupeKey: `secretary:structured-preview:${action.candidateFingerprint}:${action.contextVersion}`,
      requiresUserAction: true,
      deliveryPolicy: 'in_app_only',
      quietHoursPolicy: 'respect',
      privacyPolicy: privacyPolicy(capability.sensitivity),
      visibilityScope: 'user_private',
      decisionContext: {
        entityTitle: copy.entityTitle,
        ...(hasTimeConflict && requestedWindow ? {
          currentStartAt: requestedWindow.start,
          currentEndAt: requestedWindow.end,
        } : {}),
        ...(requestedWindow ? {
          recommendedStartAt: requestedWindow.start,
          recommendedEndAt: requestedWindow.end,
          timezone: requestedWindow.timezone,
        } : {}),
        reasonCodes: [...new Set([
          ...conflict.reasonCodes,
          'structured_secretary_preview',
          'preview_only',
          'context_revalidation_required',
        ])],
        sourceState: conflict.disposition,
        contextObservedAt: input.snapshot.observedAt,
        contextExpiresAt: input.snapshot.expiresAt,
        evidenceConfidence: evidenceConfidence(input.candidate, input.snapshot),
        candidateConfidence: input.candidate.factors.confidence,
        evidenceReferences: privacySafeEvidenceReferences(input.candidate, input.snapshot),
        sourceHealthSnapshot: input.snapshot.sourceHealth.map((source) => ({
          source: source.source,
          status: source.status,
          observedAt: source.observedAt,
          staleAfter: source.staleAfter ?? null,
          reasonCode: source.reasonCode ?? null,
        })),
        deadlineAt: reviewExpiresAt,
        locale: input.locale ?? null,
        recipe: 'secretary_structured_preview_v1',
        normalizedAction: action,
        conflictEvaluation: conflict,
        ...(evidenceComparisons.length > 0 ? { conflictComparisons: evidenceComparisons } : {}),
      },
    });
    if (!result.item) {
      const blocked = conflict.disposition === 'block'
        || conflict.disposition === 'stale'
        || result.eligibility.reasons.some((reason) => reason.startsWith('quality_gate:'));
      return {
        status: blocked ? 'blocked' : 'suppressed',
        userFacingText: blocked
          ? (pt
            ? 'A proposta não tinha contexto seguro suficiente para criar um item acionável. Não alterei nada.'
            : 'The proposal did not have enough safe context for an actionable review item. I did not change anything.')
          : (pt
            ? 'A proposta foi suprimida pelo Decision Center para evitar repetição. Não alterei nada.'
            : 'Decision Center suppressed the proposal to avoid repetition. I did not change anything.'),
        action,
        conflictEvaluation: conflict,
        reasonCodes: [...new Set([...conflict.reasonCodes, ...result.eligibility.reasons])],
      };
    }
    const blocked = conflict.disposition === 'block' || conflict.disposition === 'stale';
    return {
      status: blocked ? 'blocked' : 'created',
      userFacingText: blocked
        ? (pt
          ? 'Criei um item bloqueado no Decision Center para rever o conflito. Nada foi executado nem alterado.'
          : 'I created a blocked Decision Center item so you can review the conflict. Nothing was executed or changed.')
        : (pt
          ? 'Criei um item de revisão no Decision Center. Nada foi executado nem alterado.'
          : 'I created a review-only item in Decision Center. Nothing was executed or changed.'),
      decisionId: result.item.decisionId,
      action,
      conflictEvaluation: conflict,
      reasonCodes: conflict.reasonCodes.length ? conflict.reasonCodes : ['decision_preview_created'],
    };
  } catch {
    return failedResult(pt, ['decision_preview_persistence_failed'], action, conflict);
  }
}

/**
 * Convert only deterministic, evidence-bound constraint signals into the
 * shared comparison contract. Free text never becomes an executable effect:
 * it can only make a review stricter. Negative explicit instructions block;
 * existing commitments and explicitly model-flagged preference/goal tensions
 * require review. Unknown model effect codes are ignored.
 */
function secretaryEvidenceConflictComparisons(
  candidate: SecretaryReasoningCandidate,
  snapshot: SecretaryContextSnapshot,
  action: NormalizedDecisionAction,
): ConflictComparisonAction[] {
  const materialIds = new Set(secretaryCandidateMaterialEvidenceIds(candidate));
  const assumptionIds = new Set(candidate.assumptions.flatMap((assumption) => assumption.evidenceIds));
  const effectCodes = new Set(candidate.actionDraft?.prohibitedEffectCodes ?? []);
  const comparisons: ConflictComparisonAction[] = [];
  for (const fact of snapshot.facts) {
    if (!materialIds.has(fact.evidenceId) || fact.freshness === 'stale') continue;
    let authority: ConflictAuthority | null = null;
    let approved = false;
    let hardInstruction = false;
    if (fact.category === 'explicit_user_instruction' && isNegativeExplicitInstruction(fact.value)) {
      authority = 'explicit_user_instruction';
      approved = true;
      hardInstruction = true;
    } else if (fact.category === 'existing_commitment') {
      authority = 'approved_commitment';
      approved = true;
    } else if (fact.category === 'preference'
        && assumptionIds.has(fact.evidenceId)
        && effectCodes.has('conflicts_with_preference')) {
      authority = 'configured_preference';
    } else if (fact.category === 'inferred_intent'
        && assumptionIds.has(fact.evidenceId)
        && effectCodes.has('conflicts_with_inferred_goal')) {
      authority = 'inferred_goal';
    }
    if (!authority) continue;

    const opaqueFactId = privacySafeEvidenceToken(
      snapshot.tenantId,
      'secretary_constraint',
      `${fact.source}:${fact.sourceRef ?? fact.evidenceId}:${fact.entityVersion}`,
    );
    const constraintAction = buildNormalizedDecisionAction({
      intent: `preserve_${authority}`,
      targetEntities: [{ type: 'secretary_constraint', id: opaqueFactId, version: fact.entityVersion }],
      affectedResources: action.affectedResources,
      ...(action.requestedWindow ? { requestedWindow: action.requestedWindow } : {}),
      preconditions: [],
      expectedEffects: [{ type: 'preserve_constraint', targetRef: `secretary_constraint:${opaqueFactId}` }],
      prohibitedEffects: hardInstruction ? action.expectedEffects : [],
      dependencies: [],
      exclusivityKeys: action.exclusivityKeys,
      authorizationScope: ['decision_center:read'],
      risk: hardInstruction ? 'high' : 'medium',
      reversibility: 'irreversible',
      contextVersion: `constraint_${opaqueFactId}`,
    });
    comparisons.push({
      action: constraintAction,
      decisionId: `evidence:${opaqueFactId}`,
      authority,
      approved,
      createdAt: fact.observedAt,
      updatedAt: fact.observedAt,
      ...(fact.expiresAt ? { validUntil: fact.expiresAt } : {}),
    });
  }
  return comparisons;
}

function isNegativeExplicitInstruction(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\b(do\s+not|don't|never|must\s+not|cannot|can't|nao|não|nunca|jamais|no\s+quiero|nunca)\b/.test(normalized);
}

function resourcesFor(commandType: string, facts: SecretaryContextFact[]): DecisionActionResourceRef[] {
  const resources = new Map<string, DecisionActionResourceRef>();
  const add = (type: string, id = 'primary') => resources.set(`${type}:${id}`, { type, id });
  const command = commandType.toLowerCase();
  if (/schedule|calendar|event|meeting|agenda/.test(command)) add('calendar_timeline');
  if (/task|todo/.test(command)) add('task_store');
  if (/remind/.test(command)) add('reminder_store');
  if (/mail|email|inbox/.test(command)) add('mailbox');
  if (/training|readiness|garmin|workout/.test(command)) add('training_state');
  for (const fact of facts) {
    if (fact.source === 'calendar') add('calendar_timeline');
    else if (fact.source === 'tasks') add('task_store');
    else if (fact.source === 'reminders') add('reminder_store');
    else if (fact.source === 'mail') add('mailbox');
    else if (fact.source === 'readiness' || fact.source === 'garmin' || fact.source === 'training') add('training_state');
  }
  if (resources.size === 0) add('secretary_review');
  return [...resources.values()].sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
}

function entityTypeForFact(fact: SecretaryContextFact): string {
  if (fact.source === 'calendar') return 'calendar_event';
  if (fact.source === 'tasks') return 'task';
  if (fact.source === 'reminders') return 'reminder';
  if (fact.source === 'mail') return 'mail_pressure';
  if (fact.source === 'readiness' || fact.source === 'garmin') return 'readiness_summary';
  return 'secretary_evidence';
}

function notificationPriority(action: NormalizedDecisionAction, now: Date): NotificationPriority {
  if (action.risk === 'critical') return 'critical';
  const start = action.requestedWindow ? Date.parse(action.requestedWindow.start) : Number.NaN;
  if (Number.isFinite(start) && start <= now.getTime() + 24 * 60 * 60_000) return 'time_sensitive';
  return 'active';
}

/** Mirrors the existing Decision Center defaults while allowing an earlier action window to win. */
function durableReviewExpiry(action: NormalizedDecisionAction, priority: NotificationPriority, now: Date): string {
  const defaultHours = priority === 'critical' || priority === 'time_sensitive' ? 48 : 7 * 24;
  const policyExpiry = now.getTime() + defaultHours * 60 * 60_000;
  const requestedStart = action.requestedWindow ? Date.parse(action.requestedWindow.start) : Number.NaN;
  const expiry = Number.isFinite(requestedStart) && requestedStart > now.getTime()
    ? Math.min(requestedStart, policyExpiry)
    : policyExpiry;
  return new Date(expiry).toISOString();
}

function privacyPolicy(sensitivity: string): NotificationPrivacyPolicy {
  if (sensitivity === 'financial') return 'financial';
  if (sensitivity === 'health_adjacent') return 'health';
  if (sensitivity === 'credential_adjacent') return 'private_content';
  return sensitivity === 'normal' ? 'standard' : 'sensitive';
}

function fixedPreviewCopy(commandType: string, pt: boolean): { title: string; body: string; entityTitle: string } {
  const calendar = /schedule|calendar|event|meeting|agenda/i.test(commandType);
  if (calendar) return pt
    ? {
      title: 'Rever uma proposta de agenda com escopo definido',
      body: 'Uma proposta estruturada de calendário precisa ser comparada com os compromissos atuais antes de qualquer alteração.',
      entityTitle: 'Mudança de calendário proposta pela Secretary',
    }
    : {
      title: 'Review a scoped schedule proposal',
      body: 'A structured calendar proposal must be compared with current commitments before any change.',
      entityTitle: 'Calendar change proposed by Secretary',
    };
  return pt
    ? {
      title: 'Rever uma proposta estruturada da Secretary',
      body: 'Uma proposta estruturada está pronta para revisão antes de qualquer alteração.',
      entityTitle: 'Proposta estruturada da Secretary',
    }
    : {
      title: 'Review a structured Secretary proposal',
      body: 'A structured proposal is ready for review before any state changes.',
      entityTitle: 'Structured Secretary proposal',
    };
}

function failedResult(
  pt: boolean,
  reasonCodes: string[],
  action?: NormalizedDecisionAction,
  conflictEvaluation?: ConflictEvaluation,
): SecretaryDecisionPreviewResult {
  return {
    status: 'failed',
    userFacingText: pt
      ? 'Não consegui criar o item de revisão com segurança. Nada foi executado nem alterado.'
      : 'I could not safely create the review item. Nothing was executed or changed.',
    ...(action ? { action } : {}),
    ...(conflictEvaluation ? { conflictEvaluation } : {}),
    reasonCodes,
  };
}

function validScope(input: CreateSecretaryDecisionPreviewInput): boolean {
  return Number.isSafeInteger(input.userId)
    && input.userId > 0
    && Number.isSafeInteger(input.tenantId)
    && input.tenantId > 0
    && input.snapshot.userId === input.userId
    && input.snapshot.tenantId === input.tenantId;
}

function privacySafeEvidenceReferences(
  candidate: SecretaryReasoningCandidate,
  snapshot: SecretaryContextSnapshot,
): NonNullable<import('../decision-center-logic-v2').DecisionLogicContext['evidenceReferences']> {
  const allowed = new Set(secretaryCandidateMaterialEvidenceIds(candidate));
  return snapshot.facts.filter((fact) => allowed.has(fact.evidenceId)).slice(0, 24).map((fact) => ({
    evidenceId: privacySafeEvidenceToken(snapshot.tenantId, 'secretary_evidence', fact.evidenceId),
    source: fact.source,
    observedAt: fact.observedAt,
    freshness: fact.freshness,
    reliability: fact.reliability,
    entityVersion: privacySafeEvidenceToken(snapshot.tenantId, 'entity_version', fact.entityVersion),
    expiresAt: fact.expiresAt ?? null,
  }));
}

function evidenceConfidence(candidate: SecretaryReasoningCandidate, snapshot: SecretaryContextSnapshot): number {
  const allowed = new Set(secretaryCandidateMaterialEvidenceIds(candidate));
  const values = snapshot.facts.filter((fact) => allowed.has(fact.evidenceId)).map((fact) => fact.confidence);
  // Preserve the authoritative evidence floor as-is. The model's ordinal
  // confidence is stored separately as candidateConfidence and may only lower
  // presentation/ranking through deterministic policy; it must not invent a
  // new numeric calibration threshold.
  const evidenceFloor = values.length > 0 ? Math.min(...values) : 0;
  return Math.max(0, Math.min(1, evidenceFloor));
}

function privacySafeEvidenceToken(tenantId: number, sourceType: string, value: string): string {
  const hmacSecret = process.env.CHAT_CORE_V2_DECISION_EVIDENCE_HMAC_SECRET?.trim() ?? '';
  if (!hmacSecret) throw new Error('SECRETARY_DECISION_PREVIEW_HMAC_SECRET_REQUIRED');
  return hmacTenantScopedEvidenceFingerprint({
    tenantId: String(tenantId),
    hmacSecret,
    sourceType,
    sourceValue: value,
  });
}

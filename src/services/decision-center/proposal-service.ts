// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Physically extracted Decision Center proposal service implementation.
 * Keep persistence, authorization, and projection behavior in its owning module.
 */

import { createHash, randomUUID } from 'node:crypto';

import { DateTime } from 'luxon';

import { getDb } from '../database';

import { emitDomainEvent } from '../event-outbox';

import { incrementTrainingGenerationCounter } from '../training-generation-observability';

import { trainingOperationLockPublicError } from '../training-operation-locks';

import {
  buildSkillNotificationFixtureIntent,
  createNotificationIntent,
  getNotificationProfileIfExists,
  getOrCreateNotificationProfile,
  getNotificationReliabilityDashboard,
  listNotificationCenterItems,
  markNotificationCenterItemRead,
  updateNotificationProfile,
  NotificationProposalCommitError,
  type NotificationActionButton,
  type NotificationCenterItem,
  type NotificationEvaluationResult,
  type NotificationIntentInput,
  type NotificationIntentType,
  type NotificationPriority,
  type NotificationPrivacyPolicy,
  type NotificationProfile,
  type NotificationSourceSkill,
} from '../notification-orchestrator';

import { listNotificationApnsActionExposures } from '../notification-contracts';

import {
  decideContentWorkspaceReview as decideContentApproval,
  getContentDecisionWorkspaceObject as getContentWorkflowObject,
} from '../content-workspace-decision-adapter';

import {
  getSecretaryAgendaItemById,
  type ReasoningTrailNode,
  type SecretaryAgendaItem,
} from '../secretary-scheduling-arbitrator';

import { secretaryAgendaStateRevision } from '../secretary-agenda-state-revision';

import {
  getMealPlan,
  setMealPlan,
} from '../cooking-chef';

import {
  getTaxEvents,
  markTaxPaid,
} from '../finance-tracker';

import { listTasksForUser } from '../task-store/task-service';

import { priorityToImportance } from '../task-store/task-priority';

import type { NormalizedTask } from '../task-store/types';

import {
  clearPendingChatConfirmation,
  getPendingChatConfirmation,
} from '../chat-pending-confirmations';

import { isValidTenantUserId, recordTenantScopeAnomaly } from '../tenant-scope-observability';

import { logger } from '../../utils/logger';

import { normalizeSupportedLang } from '../../utils/i18n';

import { getDecisionConflictPolicyV1Mode, isDecisionCenterCommandBusEnabled, isDecisionCenterFatigueCapsEnabled, isDecisionCenterGuidanceSkillEnabled, isDecisionCenterGuidanceV1Enabled, isDecisionChoiceOptionsEnabled, isDecisionConflictPolicyV1Enabled, isDecisionEvidenceFreshnessGateEnabled, isDecisionFeedbackSuppressionEnabled, isDecisionFlowV1EnforceEnabled, isDecisionHumanReviewGateEnabled, isDecisionLowRiskAutoResolutionEnabled, isDecisionReconnectAffordanceEnabled, isDecisionRefreshEnabled, isDecisionRollbackSnapshotProtectionEnabled, isDecisionSemanticDedupEnabled, isDecisionSemanticSupersedeEnabled, isDecisionSkillCardsEnabled, isDecisionStreakV1Enabled, isDecisionTypeSuppressionEnabled, isTrainingDecisionFlowV1EnforceEnabled } from '../runtime-flags';

import { buildDecisionConflictSummary, type ConflictEvaluation, type DecisionConflictSummary } from '../decision-conflict-evaluator';

import {
  buildNormalizedDecisionAction,
  logicalActionAttemptHash,
  normalizeDecisionAction,
  type NormalizedDecisionAction,
} from '../decision-action-contract';

import { isLowRiskAutoReflowEligible, revalidateNormalizedDecisionAction } from '../decision-preexecution-revalidator';

import { directOwnedContentObjectForDecision } from '../decision-command-effects';

import {
  contentWorkflowStateRevision,
  cookingMealSlotStateRevision,
  financeTaxEventStateRevision,
} from '../decision-domain-state-revision';

import { decisionRelationshipSemantics, type DecisionRelationshipKind, type DecisionRelationshipType } from '../decision-relationship-types';

import { buildDecisionDedupKey, classifyDecisionDedup } from '../decision-center-semantic-dedup';

import type { SecretaryTodaySummaryModel } from '../secretary-orchestrator';

import { secretaryTodayLabels } from '../secretary-today-copy';

import {
  buildDecisionActionTruthTableEntry,
  isDecisionActionAllowedFromApns,
  isDecisionActionExecutable,
  type DecisionActionTruthTableEntry,
} from '../decision-center-action-truth-table';

import {
  getLearningCase,
  learningReviewApprovalReferenceForExecution,
  recordLearningCaseReviewApproval,
} from '../product-learning';

import {
  adviseSecretaryDecision,
  buildDecisionLogicV2,
  formatDecisionWindow,
  rankDecision,
  type AutomationEligibility,
  type DecisionFrontendActionState,
  type DecisionFrontendDisplayMode,
  type DecisionLogicContext,
  type DecisionLogicV2,
  type DecisionQualityGateResult,
  type SecretaryAvailableSlot,
  type SecretaryDecisionAdvice,
  type DecisionVisibilityScope,
  type DecisionWhatWillChange,
  type DecisionWhy,
} from '../decision-center-logic-v2';

import { resolveDecisionDeferUntil } from './defer-time';

import { ensureDecisionCenterTables } from './repository-readiness';

import {
  createDecisionCenterEngineSelector,
  resolveDecisionCenterRewriteMode,
} from './engine-selector';

import {
  evaluateDecisionApnsActionPolicy,
  type DecisionApnsActionPolicyDecision,
  type DecisionApnsExactFetchResult,
} from './apns-action-policy';

import { findDecisionExecutor, hasDecisionExecutor } from './execution-registry';

import { invalidatePlanningAfterVerifiedDecisionSourceMutation } from './planning-cache-invalidation';

import {
  createDecisionMutationCommand,
  type DecisionMutationApproval,
  type DecisionMutationChannel,
  type DecisionMutationCommand,
} from './contracts';

import {
  DECISION_RANK_SNAPSHOT_UNIVERSE_FINGERPRINT,
  materializeDecisionRankSnapshot,
} from './rank-snapshot-service';

import type { DecisionRankSnapshot } from './rank-snapshot-repository';

import {
  DECISION_RANKING_POLICY,
  DECISION_RANKING_VERSION,
  rankDecisionPriority,
  type DecisionPrioritySnapshot,
  type DecisionPriorityTier,
  type DecisionRankingInputs,
} from './ranking-policy';

import {
  actionOutcomeFromRecord,
  applyDecisionFatigueCaps,
  computeActionEffectiveStatus,
  computeActionability,
  computeConfidenceExplanation,
  computeDecisionKind,
  computeEffectiveStatus,
  gateActionabilityForHumanReview,
  gateActionabilityForStaleEvidence,
  isDecisionItemPolicyFloored,
  isHumanReviewQueueAvailable,
  legacyStatusToLifecycle,
  type DecisionFatiguePolicy,
} from './projection-policy';

import {
  DecisionActionError,
  actionsForRecord,
  normalizeDecisionMutationChannel,
  performDecisionAction,
} from './command-service';
import {
  addDecisionDependency,
  emitDecisionLifecycleEvent,
  persistDecisionCreatedLifecycleEventStrict,
  recordDecisionQualityGateEvent,
  resolveDecisionConflictAudit,
  supersedeDecision,
} from './lifecycle-preferences-jobs';
import {
  conflictMaterialKey,
  conflictMaterialShape,
  decisionContextForIntentInput,
  decisionContextForRecord,
  decisionLogicForIntentInput,
  formatDecisionItemForApi,
  getDecisionItem,
  getDecisionRecord,
  isDecisionExpired,
  materializeDecisionRankSnapshotForScope,
} from './read-projection-ranking-service';
import {
  DECISION_TYPES,
  NON_DECISION_TYPES,
  appNowIso,
  assertDecisionScopedUpdateApplied,
  assertScope,
  decisionFlowV1EnforcedForIntent,
  isDecisionRecord,
  isVisiblePushEligible,
  safeParseJson,
  urgencyForPriority,
} from './repository';
import {
  DecisionApiItem,
  DecisionEligibilityPolicyInput,
  DecisionEligibilityResult,
  DecisionIntentCommandInput,
  DecisionProposalCommand,
  DecisionProposalReceipt,
  DurableDecisionState,
} from './types';


export function evaluateDecisionEligibility(input: DecisionEligibilityPolicyInput): DecisionEligibilityResult {
  const reasons: string[] = [];
  const requiresUserAction = input.requiresUserAction === true;
  const urgency = urgencyForPriority(input.priority);

  if (NON_DECISION_TYPES.has(input.type) && !requiresUserAction) {
    reasons.push(`${input.type} is routine notification/insight, not a user decision`);
    if ((input.actionButtons ?? []).some((action) => action.id !== 'open_detail')) {
      reasons.push('notification action buttons do not imply a user decision without explicit requiresUserAction');
    }
    return { classification: input.type === 'insight' ? 'insight' : 'notification', reasons, apnsEligible: false, urgency };
  }

  if (input.type === 'schedule_changed' && !requiresUserAction) {
    reasons.push('schedule_changed without a required choice is a notification');
    return { classification: 'notification', reasons, apnsEligible: false, urgency };
  }

  if (DECISION_TYPES.has(input.type) || requiresUserAction) {
    reasons.push('requires judgment, approval, correction, or meaningful choice');
    return {
      classification: 'decision',
      reasons,
      apnsEligible: isVisiblePushEligible(input.priority, input.type, requiresUserAction),
      urgency,
    };
  }

  reasons.push('no user action required');
  return { classification: 'ignore', reasons, apnsEligible: false, urgency };
}



/** Active decisions' dedup-key fields, used to detect semantic conflicts at creation time (B3 acting). */
export function listActiveDedupCandidates(userId: number, tenantId: number, excludeId: string): Array<{
  decisionId: string; sourceSkill: NotificationSourceSkill; type: NotificationIntentType; relatedEntityId: string | null; dedupeKey: string | null; createdAt: string;
}> {
  // Active AND not-yet-expired (mirrors the A1 expiry predicate so we never link to an expired-but-unswept
  // decision), bounded + recency-ordered so this stays cheap on the hot creation path even past the
  // ~50-active-per-user product ceiling (recent decisions are the ones that can share a time window).
  return getDb().prepare(`
    SELECT items.item_id AS decisionId, items.source_skill AS sourceSkill, items.type AS type,
           intents.related_entity_id AS relatedEntityId, items.dedupe_key AS dedupeKey, items.created_at AS createdAt
      FROM notification_center_items items
      LEFT JOIN notification_intents intents ON intents.intent_id = items.intent_id
     WHERE items.user_id = ? AND items.tenant_id = ? AND items.item_id != ?
       AND items.status IN ('unread', 'read', 'snoozed', 'failed', 'open')
       AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime(?))
     ORDER BY items.created_at DESC
     LIMIT 200
  `).all(userId, tenantId, excludeId, appNowIso()) as Array<{ decisionId: string; sourceSkill: NotificationSourceSkill; type: NotificationIntentType; relatedEntityId: string | null; dedupeKey: string | null; createdAt: string }>;
}



/**
 * B3 acting (first slice): when a newly-created decision SEMANTICALLY conflicts with an existing active
 * decision (overlapping target entity + same window, both unresolved asks), record a `conflicts_with`
 * relationship between them. ADDITIVE + advisory — only `blocks` prevents action, so a conflict link
 * never hides or blocks a decision; the hiding verdicts (same_recommendation / supersedes) are a
 * deliberate later slice. Non-fatal: any failure must never break decision creation. Uses the new
 * decision's stored created_at (DB clock) so candidate and existing windows are compared consistently.
 */
export function linkConflictingDecisionsOnCreate(
  newId: string,
  input: NotificationIntentInput,
  userId: number,
  tenantId: number,
  createdAt: string,
  options: { strict?: boolean } = {},
): { collapsedToExistingId?: string } {
  // B3 hiding (flag-gated, decoupled from linking): when ON, the two collapsing verdicts mutate state —
  // newer_recommendation_supersedes_old supersedes the OLDER same-recipe decision; same_recommendation_
  // update_existing drops the new duplicate and returns the existing (collapsedToExistingId tells the
  // caller to return the existing item). Both NEVER touch a policy-floored or a different decision.
  const supersedeEnabled = isDecisionSemanticSupersedeEnabled(process.env, { userId, tenantId });
  let collapsedToExistingId: string | undefined;
  try {
    const timezone = getOrCreateNotificationProfile(userId, tenantId).timezone;
    const candidate = buildDecisionDedupKey({
      sourceSkill: input.sourceSkill,
      type: input.type,
      relatedEntityId: input.relatedEntityId == null ? null : String(input.relatedEntityId),
      dedupeKey: input.dedupeKey ?? null,
      createdAt,
      timezone,
    });
    for (const existing of listActiveDedupCandidates(userId, tenantId, newId)) {
      // Per-candidate isolation: a single pairing that throws (e.g. addDecisionDependency racing a
      // candidate that was swept/dismissed between the scan and its record check) must NOT abandon the
      // remaining candidates — otherwise a user with several same-entity decisions would see only the
      // ones before the failure linked. Each iteration fails independently; the outer catch still guards
      // candidate-key building and the iterator so linking can never break decision creation.
      try {
        const existingKey = buildDecisionDedupKey({
          sourceSkill: existing.sourceSkill,
          type: existing.type,
          relatedEntityId: existing.relatedEntityId,
          dedupeKey: existing.dedupeKey,
          createdAt: existing.createdAt,
          timezone,
        });
        const verdict = classifyDecisionDedup(candidate, [existingKey]).verdict;
        // Map the dedup verdict to an ADVISORY relationship type (only `blocks` prevents action, so
        // neither hides nor blocks a decision): a cross-skill conflict on the same entity+window =>
        // conflicts_with (warns the user); a cross-skill, non-conflicting decision on the same
        // entity+window => affects_same_entity (groups them for context). Written reciprocally so BOTH
        // decisions surface the link; idempotent via addDecisionDependency's INSERT OR IGNORE.
        const linkType: DecisionRelationshipType | null = verdict === 'conflicting_recommendation_link' ? 'conflicts_with'
          : verdict === 'same_issue_cluster' ? 'affects_same_entity'
          : null;
        if (linkType) {
          addDecisionDependency({ decisionId: newId, dependsOnDecisionId: existing.decisionId, userId, tenantId, relationship: linkType, materializeSnapshot: false });
          addDecisionDependency({ decisionId: existing.decisionId, dependsOnDecisionId: newId, userId, tenantId, relationship: linkType, materializeSnapshot: false });
        } else if (supersedeEnabled && (verdict === 'newer_recommendation_supersedes_old' || verdict === 'same_recommendation_update_existing')) {
          // HIDING slice. The matched `existing` is the OLDER same-recipe row (listActiveDedupCandidates
          // excludes newId and orders newest-first; the new row's createdAt is the latest by DB clock).
          const existingRecord = getDecisionRecord(existing.decisionId, userId, tenantId);
          if (existingRecord && isDecisionRecord(existingRecord)) {
            const existingFloored = isDecisionItemPolicyFloored(formatDecisionItemForApi(existingRecord));
            if (verdict === 'newer_recommendation_supersedes_old') {
              // Supersede the OLDER decision — but NEVER a policy-floored one (fail open: keep both).
              // (A later same-skill candidate may additionally same_recommendation-collapse this new row into
              // a third existing one in the same pass; the result — oldest hidden, newest kept — is invariant-safe.)
              if (!existingFloored) {
                supersedeDecision(existingRecord, 'semantic_superseded_by_newer_recommendation');
                addDecisionDependency({ decisionId: newId, dependsOnDecisionId: existing.decisionId, userId, tenantId, relationship: 'supersedes', materializeSnapshot: false });
              }
            } else {
              // same_recommendation: drop the NEW duplicate and return the existing — UNLESS the new is
              // floored and the existing is not (then fail open — never hide the floored new one).
              const newRecord = getDecisionRecord(newId, userId, tenantId);
              const newFloored = newRecord && isDecisionRecord(newRecord) ? isDecisionItemPolicyFloored(formatDecisionItemForApi(newRecord)) : false;
              if (!(newFloored && !existingFloored) && newRecord && isDecisionRecord(newRecord)) {
                supersedeDecision(newRecord, 'semantic_duplicate_of_existing');
                collapsedToExistingId = existing.decisionId;
                break; // the new row is now superseded — stop scanning further candidates for it
              }
            }
          }
        }
      } catch (pairErr) {
        logger.warn({ err: pairErr instanceof Error ? pairErr.message : String(pairErr), newId, existingId: existing.decisionId }, 'B3 conflict-linking pair failed (non-fatal; other pairs continue)');
        if (options.strict) throw pairErr;
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), newId }, 'B3 conflict-linking failed (non-fatal)');
    if (options.strict) throw err;
  }
  return { collapsedToExistingId };
}



export const DECISION_PROPOSAL_RECEIPT_SCHEMA_VERSION = 'decision_proposal_receipt@1.0.0' as const;



export function decisionProposalCommand(input: DecisionIntentCommandInput): DecisionProposalCommand | null {
  if (input.idempotencyKey == null) return null;
  if (typeof input.idempotencyKey !== 'string') {
    throw new DecisionActionError('IDEMPOTENCY_KEY_INVALID', 'Decision proposal idempotency key must be a string.', 400);
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new DecisionActionError(
      'IDEMPOTENCY_KEY_INVALID',
      'Decision proposal idempotency key must contain 1 to 200 characters.',
      400,
    );
  }
  const tenantId = input.tenantId ?? input.userId;
  const keyDigest = createHash('sha256')
    .update(`${tenantId}:${input.userId}:create_intent:${idempotencyKey}`)
    .digest('hex');
  const suppliedFingerprint = input.proposalRequestFingerprint;
  if (suppliedFingerprint != null && !/^[a-f0-9]{64}$/i.test(suppliedFingerprint)) {
    throw new DecisionActionError(
      'DECISION_MUTATION_INVALID',
      'Decision proposal request fingerprint is invalid.',
      400,
    );
  }
  const {
    idempotencyKey: _omitted,
    proposalRequestFingerprint: _fingerprintOmitted,
    ...proposal
  } = input;
  const proposalFingerprint = suppliedFingerprint ?? createHash('sha256')
    .update(stableDecisionProposalJson(proposal))
    .digest('hex');
  const requestFingerprint = createHash('sha256').update(stableDecisionProposalJson({
    schemaVersion: DECISION_PROPOSAL_RECEIPT_SCHEMA_VERSION,
    scope: { userId: input.userId, tenantId },
    proposalFingerprint,
  })).digest('hex');
  return {
    eventId: `decision-proposal-${keyDigest}`,
    intentId: `dci_${keyDigest}`,
    requestFingerprint,
    userId: input.userId,
    tenantId,
    contract: createDecisionMutationCommand({
      commandId: `decision-proposal:${keyDigest}`,
      decisionId: `dci_${keyDigest}`,
      operation: 'create_intent',
      actionId: 'create_intent',
      scope: { userId: input.userId, tenantId },
      channel: normalizeDecisionMutationChannel(input.channel),
      idempotencyKey,
      recordVersion: null,
      contextVersion: null,
      approval: { requiredLevel: 'none', evidence: null },
      execution: {
        executorId: 'decision-center.proposal.atomic',
        strategy: 'background',
        riskLevel: 'low',
        reversible: true,
        supportsIdempotency: true,
      },
      readback: {
        verifierId: 'decision-center.proposal.exact',
        entityType: 'notification_intent',
        entityId: `dci_${keyDigest}`,
        mode: 'exact',
        expectedState: { requestFingerprint },
      },
      payload: { requestFingerprint },
      requestedAt: appNowIso(),
    }),
  };
}



export function stableDecisionProposalJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableDecisionProposalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableDecisionProposalJson(record[key])}`
  )).join(',')}}`;
}



export const DECISION_ACTION_REQUEST_FINGERPRINT_VERSION = 'decision_action_request@1.0.0' as const;



export function decisionActionRequestFingerprint(input: {
  decisionId: string;
  actionId: string;
  userId: number;
  tenantId: number;
  opts: {
    payload?: Record<string, unknown>;
    channel?: string;
    expectedVersion?: number;
    contextVersion?: string;
    automaticResolution?: boolean;
  };
}): string {
  return createHash('sha256').update(stableDecisionProposalJson({
    schemaVersion: DECISION_ACTION_REQUEST_FINGERPRINT_VERSION,
    decisionId: input.decisionId,
    actionId: input.actionId,
    scope: { userId: input.userId, tenantId: input.tenantId },
    payload: input.opts.payload ?? {},
    channel: input.opts.automaticResolution === true
      ? 'automation'
      : normalizeDecisionMutationChannel(input.opts.channel),
    recordVersion: input.opts.expectedVersion ?? null,
    contextVersion: input.opts.contextVersion ?? null,
  })).digest('hex');
}



export function assertDecisionActionReplayFingerprint(
  execution: any,
  requestFingerprint: string,
): void {
  const expectedEffect = safeParseJson<Record<string, unknown>>(execution?.expected_effect_json, {});
  const storedFingerprint = expectedEffect.idempotencyRequestFingerprint;
  // Execution rows written by predecessor binaries have no fingerprint. They
  // remain replayable for additive compatibility; every row created by the
  // rewrite is bound to the complete request below.
  if (storedFingerprint == null) return;
  if (storedFingerprint !== requestFingerprint) {
    throw new DecisionActionError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used with different Decision Center mutation parameters.',
      409,
    );
  }
}



export function readDecisionProposalReceipt(command: DecisionProposalCommand): DecisionProposalReceipt | null {
  const row = getDb().prepare(`
    SELECT metadata_json AS metadataJson
      FROM decision_lifecycle_events
     WHERE event_id = ? AND user_id = ? AND tenant_id = ?
       AND event = 'mutation_receipt' AND action_id = 'create_intent'
     LIMIT 1
  `).get(command.eventId, command.userId, command.tenantId) as { metadataJson: string } | undefined;
  if (!row) return null;
  try {
    const receipt = JSON.parse(row.metadataJson) as Partial<DecisionProposalReceipt>;
    if (receipt.schemaVersion !== DECISION_PROPOSAL_RECEIPT_SCHEMA_VERSION
        || typeof receipt.requestFingerprint !== 'string'
        || !receipt.eligibility
        || typeof receipt.eligibility !== 'object'
        || !receipt.commandContract
        || receipt.commandContract.operation !== 'create_intent') throw new Error('invalid proposal receipt');
    return receipt as DecisionProposalReceipt;
  } catch (cause) {
    throw new DecisionActionError(
      'DECISION_MUTATION_RECEIPT_INVALID',
      'The stored Decision Center proposal receipt is invalid.',
      500,
      { cause: cause instanceof Error ? cause.name : 'unknown' },
    );
  }
}



export function replayDecisionProposalReceipt(
  command: DecisionProposalCommand,
  receipt: DecisionProposalReceipt,
): { item: DecisionApiItem | null; eligibility: DecisionEligibilityResult } {
  if (receipt.requestFingerprint !== command.requestFingerprint) {
    throw new DecisionActionError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different Decision Center proposal.',
      409,
    );
  }
  if (!receipt.decisionId) return { item: null, eligibility: receipt.eligibility };
  const record = getDecisionRecord(receipt.decisionId, command.userId, command.tenantId);
  if (!record) {
    throw new DecisionActionError(
      'DECISION_READBACK_MISMATCH',
      'The original Decision Center proposal can no longer be read back.',
      409,
      { decisionId: receipt.decisionId },
    );
  }
  return { item: formatDecisionItemForApi(record), eligibility: receipt.eligibility };
}



export function persistDecisionProposalReceipt(
  command: DecisionProposalCommand,
  result: { decisionId: string | null; eligibility: DecisionEligibilityResult },
): void {
  const { idempotencyKey, ...privacySafeCommandContract } = command.contract;
  const receipt: DecisionProposalReceipt = {
    schemaVersion: DECISION_PROPOSAL_RECEIPT_SCHEMA_VERSION,
    requestFingerprint: command.requestFingerprint,
    decisionId: result.decisionId,
    eligibility: result.eligibility,
    commandContract: {
      ...privacySafeCommandContract,
      idempotencyKeyHash: createHash('sha256').update(idempotencyKey).digest('hex'),
    },
  };
  getDb().prepare(`
    INSERT INTO decision_lifecycle_events (
      event_id, decision_id, user_id, tenant_id, event, action_id,
      reason, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'mutation_receipt', 'create_intent',
              'idempotent_proposal_receipt', ?, ?)
  `).run(
    command.eventId,
    result.decisionId ?? command.intentId,
    command.userId,
    command.tenantId,
    JSON.stringify(receipt),
    appNowIso(),
  );
}



export function persistOrReplayDecisionProposalReceipt(
  command: DecisionProposalCommand,
  response: { item: DecisionApiItem | null; eligibility: DecisionEligibilityResult },
): { item: DecisionApiItem | null; eligibility: DecisionEligibilityResult } {
  try {
    persistDecisionProposalReceipt(command, {
      decisionId: response.item?.decisionId ?? null,
      eligibility: response.eligibility,
    });
    return response;
  } catch (err) {
    // A concurrent process can win after our initial read. Its receipt is
    // authoritative; exact replay succeeds and altered reuse is rejected.
    const replay = readDecisionProposalReceipt(command);
    if (replay) return replayDecisionProposalReceipt(command, replay);
    throw err;
  }
}



export async function createDecisionIntent(input: DecisionIntentCommandInput): Promise<{ item: DecisionApiItem | null; eligibility: DecisionEligibilityResult }> {
  assertScope(input.userId, input.tenantId ?? input.userId, 'create_decision_intent', { sourceSkill: input.sourceSkill, type: input.type });
  ensureDecisionCenterTables();
  const proposalCommand = decisionProposalCommand(input);
  if (proposalCommand) {
    const replay = readDecisionProposalReceipt(proposalCommand);
    if (replay) return replayDecisionProposalReceipt(proposalCommand, replay);
    // The durable transport key is the proposal identity. Overriding an
    // optional caller intentId prevents two processes from creating distinct
    // rows with the same key before either can observe the other's receipt.
    input = { ...input, intentId: proposalCommand.intentId };
  }
  input = retainExecutableDecisionActions(applyConflictPolicyToIntentInput(input));
  const eligibility = evaluateDecisionEligibility({
    sourceSkill: input.sourceSkill,
    type: input.type,
    priority: input.priority,
    requiresUserAction: input.requiresUserAction,
    actionButtons: input.actionButtons,
    deliveryPolicy: input.deliveryPolicy,
  });
  if (eligibility.classification !== 'decision') {
    const response = { item: null, eligibility };
    return proposalCommand
      ? persistOrReplayDecisionProposalReceipt(proposalCommand, response)
      : response;
  }

  const conflictEvaluation = decisionContextForIntentInput(input).conflictEvaluation;
  const flowEnforced = decisionFlowV1EnforcedForIntent(input);
  const conflictPolicyEnforced = getDecisionConflictPolicyV1Mode(process.env, {
    userId: input.userId,
    tenantId: input.tenantId ?? input.userId,
  }) === 'active' || flowEnforced;
  // An exact logical duplicate is safe to collapse even when an independent
  // authoritative context source is temporarily unavailable. The unavailable
  // source still blocks execution of the canonical decision; it must not cause
  // a second equivalent item or delivery to escape the atomic proposal.
  const policyDuplicateCanonicalId = conflictPolicyEnforced
      && conflictEvaluation?.findings.some((finding) => finding.class === 'duplicate')
    ? conflictEvaluation.winnerDecisionId ?? null
    : null;

  if (shouldSuppressRepeatedRejectedCandidate(input)) {
    const response = {
      item: null,
      eligibility: {
        ...eligibility,
        apnsEligible: false,
        reasons: [...eligibility.reasons, 'candidate_rejection_cooldown'],
      },
    };
    return proposalCommand
      ? persistOrReplayDecisionProposalReceipt(proposalCommand, response)
      : response;
  }

  const quality = decisionLogicForIntentInput(input).quality;
  if (!quality.safeToShowUser) {
    const response = {
      item: null,
      eligibility: {
        ...eligibility,
        reasons: [...eligibility.reasons, `quality_gate:${quality.status}:${quality.missingFields.join(',')}`],
        apnsEligible: false,
      },
    };
    // The quality event and replay receipt are one local commit. A retry never
    // inflates the blocked-candidate denominator.
    return getDb().transaction(() => {
      if (proposalCommand) {
        const replay = readDecisionProposalReceipt(proposalCommand);
        if (replay) return replayDecisionProposalReceipt(proposalCommand, replay);
      }
      recordDecisionQualityGateEvent(input, quality);
      if (proposalCommand) persistDecisionProposalReceipt(proposalCommand, {
        decisionId: null,
        eligibility: response.eligibility,
      });
      return response;
    })();
  }

  let qualityRecordedInProposal = false;
  let proposalReceiptRecordedInProposal = false;
  let collapsedToExistingId: string | undefined;
  let policyDuplicateCollapsed = false;
  let result: NotificationEvaluationResult;
  try {
    result = await createNotificationIntent({
      ...input,
      requiresUserAction: true,
      deliveryPolicy: input.deliveryPolicy ?? (eligibility.apnsEligible ? 'auto' : 'in_app_only'),
    }, {
      atomicItemProposal: true,
      onItemPersistedInTransaction: ({ item: persistedItem }) => {
        // This callback is inside the notification item's INSERT transaction.
        // If metadata or the initial lifecycle entry fails, the item is rolled
        // back and Notification Orchestrator never reaches APNs delivery.
        recordDecisionQualityGateEvent(input, quality);
        qualityRecordedInProposal = true;
        persistDecisionFlowMetadata(persistedItem.itemId, persistedItem.intentId, input);
        persistDecisionCreatedLifecycleEventStrict(
          persistedItem.itemId,
          input.userId,
          input.tenantId ?? input.userId,
          persistedItem.status,
        );

        let deliverySuppression: { suppressDelivery: true; reason: string } | undefined;
        if (policyDuplicateCanonicalId) {
          const canonical = getDecisionRecord(
            policyDuplicateCanonicalId,
            input.userId,
            input.tenantId ?? input.userId,
          );
          const duplicate = getDecisionRecord(
            persistedItem.itemId,
            input.userId,
            input.tenantId ?? input.userId,
          );
          if (canonical && duplicate
              && isDecisionRecord(canonical) && isDecisionRecord(duplicate)
              && !isDecisionExpired(canonical)) {
            supersedeDecision(duplicate, 'conflict_policy_exact_duplicate');
            addDecisionDependency({
              decisionId: persistedItem.itemId,
              dependsOnDecisionId: canonical.itemId,
              userId: input.userId,
              tenantId: input.tenantId ?? input.userId,
              relationship: 'duplicate_of',
              materializeSnapshot: false,
            });
            collapsedToExistingId = canonical.itemId;
            policyDuplicateCollapsed = true;
            deliverySuppression = {
              suppressDelivery: true,
              reason: `conflict-policy duplicate of canonical decision ${canonical.itemId}`,
            };
            logger.info({
              event: 'decision.candidate_suppressed',
              userId: input.userId,
              tenantId: input.tenantId ?? input.userId,
              sourceSkill: input.sourceSkill,
              reason: 'exact_duplicate',
              canonicalDecisionId: canonical.itemId,
            }, 'Persisted and suppressed duplicate Decision Center candidate');
          }
        }

        // Conflict resolution and semantic linking are proposal state, not a
        // post-delivery side effect. Keep every edge, supersession, audit
        // receipt, and possible collapse in this transaction so no worker or
        // APNs process can observe a half-classified proposal.
        if (conflictEvaluation && conflictPolicyEnforced) {
          for (const priorDecisionId of [...new Set(conflictEvaluation.findings
            .filter((finding) => finding.class === 'supersedes')
            .map((finding) => finding.conflictingDecisionId)
            .filter((value): value is string => !!value))]) {
            const prior = getDecisionRecord(priorDecisionId, input.userId, input.tenantId ?? input.userId);
            if (prior && !isDecisionItemPolicyFloored(formatDecisionItemForApi(prior))) {
              supersedeDecision(prior, 'normalized_action_superseded_by_newer_context');
              addDecisionDependency({
                decisionId: persistedItem.itemId,
                dependsOnDecisionId: priorDecisionId,
                userId: input.userId,
                tenantId: input.tenantId ?? input.userId,
                relationship: 'supersedes',
                materializeSnapshot: false,
              });
              resolveDecisionConflictAudit(
                priorDecisionId,
                input.userId,
                input.tenantId ?? input.userId,
                'superseded',
                false,
                { strict: true },
              );
            }
          }
        }

        if (!collapsedToExistingId && isDecisionSemanticDedupEnabled(process.env, {
          userId: input.userId,
          tenantId: input.tenantId ?? input.userId,
        })) {
          const linkResult = linkConflictingDecisionsOnCreate(
            persistedItem.itemId,
            input,
            input.userId,
            input.tenantId ?? input.userId,
            persistedItem.createdAt,
            { strict: true },
          );
          collapsedToExistingId = linkResult.collapsedToExistingId;
          if (collapsedToExistingId) {
            deliverySuppression = {
              suppressDelivery: true as const,
              reason: `semantic duplicate of canonical decision ${collapsedToExistingId}`,
            };
          }
        }

        // The immutable ranked card universe is proposal state. Creating it
        // here means an insert/metadata/conflict/snapshot/job failure rolls the
        // whole proposal back before any provider can observe it.
        materializeDecisionRankSnapshotForScope(
          input.userId,
          input.tenantId ?? input.userId,
        );
        if (proposalCommand) {
          persistDecisionProposalReceipt(proposalCommand, {
            decisionId: collapsedToExistingId ?? persistedItem.itemId,
            eligibility: policyDuplicateCollapsed
              ? {
                  ...eligibility,
                  apnsEligible: false,
                  reasons: [...eligibility.reasons, 'conflict_policy:duplicate'],
                }
              : eligibility,
          });
          proposalReceiptRecordedInProposal = true;
        }
        return deliverySuppression;
      },
    });
  } catch (err) {
    if (!(err instanceof NotificationProposalCommitError)) throw err;
    if (proposalCommand) {
      const replay = readDecisionProposalReceipt(proposalCommand);
      if (replay) return replayDecisionProposalReceipt(proposalCommand, replay);
    }
    logger.error({
      event: 'decision.proposal_commit_failed',
      err: err.cause,
      intentId: err.intentId,
      userId: input.userId,
      tenantId: input.tenantId ?? input.userId,
    }, 'Decision proposal transaction rolled back before delivery');
    return {
      item: null,
      eligibility: {
        ...eligibility,
        apnsEligible: false,
        reasons: [...eligibility.reasons, 'decision_flow_metadata_persistence_failed'],
      },
    };
  }
  // C4: record the passing evaluation only for a genuinely new decision, not for a
  // deduped retry of an already-active decision (which would inflate the rejection-rate denominator).
  if (result.intent.status !== 'deduped' && !qualityRecordedInProposal) {
    recordDecisionQualityGateEvent(input, quality);
  }
  // A semantic duplicate commits its own audit trail as superseded but returns
  // the canonical live decision. The orchestrator suppressed its delivery job
  // in the same transaction, so only the canonical proposal can interrupt.
  let item = collapsedToExistingId
    ? getDecisionItem(collapsedToExistingId, input.userId, input.tenantId ?? input.userId, { recordExposure: false })
    : result.item
      ? getDecisionItem(result.item.itemId, input.userId, input.tenantId ?? input.userId, { recordExposure: false })
      : null;
  if (item && result.intent.status !== 'deduped' && !collapsedToExistingId) {
    item = await maybeAutoResolveLowRiskSecretaryDecision(item) ?? item;
  }
  const response = {
    item,
    eligibility: policyDuplicateCollapsed
      ? {
          ...eligibility,
          apnsEligible: false,
          reasons: [...eligibility.reasons, 'conflict_policy:duplicate'],
        }
      : eligibility,
  };
  if (proposalCommand && !proposalReceiptRecordedInProposal) {
    return persistOrReplayDecisionProposalReceipt(proposalCommand, response);
  }
  return response;
}



/**
 * Decision Center never advertises a control that lacks a real executor and
 * read-back contract. Historical rows remain decodable, but new proposals
 * omit unsupported actions such as retry/choose_priority until the execution
 * registry can prove them end to end.
 */
export function retainExecutableDecisionActions(input: NotificationIntentInput): NotificationIntentInput {
  const current = input.actionButtons ?? [];
  const normalized = current.map((action): NotificationActionButton => (
    input.type === 'sync_failure' && action.id === 'retry'
      ? { ...action, id: 'reconnect', label: 'Reconnect', mutating: false }
      : action
  ));
  const seen = new Set<string>();
  const executable = normalized.filter((action) => {
    if (!hasDecisionExecutor(action.id) || seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
  const unchanged = executable.length === current.length
    && executable.every((action, index) => action.id === current[index]?.id);
  return unchanged ? input : { ...input, actionButtons: executable };
}



export async function maybeAutoResolveLowRiskSecretaryDecision(item: DecisionApiItem): Promise<DecisionApiItem | null> {
  if (item.sourceSkill !== 'secretary') return null;
  const record = getDecisionRecord(item.decisionId, item.userId, item.tenantId);
  if (!record || record.relatedEntityType !== 'secretary_agenda_item' || !record.relatedEntityId) return null;
  const context = decisionContextForRecord(record);
  if (getDecisionConflictPolicyV1Mode(process.env, {
    userId: record.userId,
    tenantId: record.tenantId,
  }) !== 'active') return null;
  const action = normalizeDecisionAction(context.normalizedAction);
  const conflict = context.conflictEvaluation;
  const actionButton = actionsForRecord(record).find((candidate) => candidate.id === 'accept_reflow');
  const agenda = getSecretaryAgendaItemById({
    agendaItemId: record.relatedEntityId,
    ownerUserId: record.userId,
    tenantId: record.tenantId,
  });
  if (!action || !conflict || !actionButton || !agenda) return null;
  if (!isLowRiskAutoReflowEligible({
    action,
    conflictEvaluation: conflict,
    persistedUserOptIn: lowRiskAutoResolutionPreference(record.userId, record.tenantId),
    runtimeEnabled: isDecisionLowRiskAutoResolutionEnabled(process.env, {
      userId: record.userId,
      tenantId: record.tenantId,
    }),
    undoAvailable: agenda.agendaItemId === record.relatedEntityId
      && typeof secretaryAgendaStateRevision(agenda) === 'string',
  })) return null;

  try {
    const result = await performDecisionAction(record.itemId, 'accept_reflow', record.userId, record.tenantId, {
      idempotencyKey: `auto_reflow:${action.candidateFingerprint}:${action.contextVersion}`,
      expectedVersion: record.recordVersion,
      contextVersion: action.contextVersion,
      channel: 'automation',
      automaticResolution: true,
    });
    return result.item;
  } catch (err) {
    logger.error({
      event: 'decision.auto_resolution_failed',
      err,
      decisionId: record.itemId,
      userId: record.userId,
      tenantId: record.tenantId,
      policyVersion: conflict.policyVersion,
    }, 'Opted-in low-risk Secretary auto-resolution failed safely');
    const current = getDecisionRecord(record.itemId, record.userId, record.tenantId);
    return current ? formatDecisionItemForApi(current) : null;
  }
}



export function lowRiskAutoResolutionAuthorized(userId: number, tenantId: number): boolean {
  return isDecisionLowRiskAutoResolutionEnabled(process.env, { userId, tenantId })
    && lowRiskAutoResolutionPreference(userId, tenantId);
}



export function lowRiskAutoResolutionPreference(userId: number, tenantId: number): boolean {
  try {
    const row = getDb().prepare(`
      SELECT allow_low_risk_auto_reflow AS enabled
        FROM decision_flow_preferences
       WHERE user_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(userId, tenantId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  } catch {
    return false;
  }
}



export function applyConflictPolicyToIntentInput(input: NotificationIntentInput): NotificationIntentInput {
  const tenantId = input.tenantId ?? input.userId;
  const mode = getDecisionConflictPolicyV1Mode(process.env, { userId: input.userId, tenantId });
  const flowEnforced = decisionFlowV1EnforcedForIntent(input);
  if (mode === 'off' && !flowEnforced) return input;
  const initialContext = decisionContextForIntentInput(input);
  const derivedAction = normalizeDecisionAction(initialContext.normalizedAction)
    ?? deriveNormalizedActionForKnownProducer(input, initialContext);
  const context: DecisionLogicContext = derivedAction
    ? {
        ...initialContext,
        normalizedAction: derivedAction,
        contextObservedAt: initialContext.contextObservedAt ?? appNowIso(),
      }
    : initialContext;
  const action = normalizeDecisionAction(context.normalizedAction);
  if (!action) {
    if (knownProducerMutationRequiresSourceContract(input)) {
      return {
        ...input,
        actionButtons: (input.actionButtons ?? []).filter((button) => button.id === 'open_detail'),
        decisionContext: {
          ...initialContext,
          reasonCodes: [...new Set([...(initialContext.reasonCodes ?? []), 'authoritative_source_contract_unavailable'])],
        },
      };
    }
    return input;
  }
  const revalidation = revalidateNormalizedDecisionAction({
    scope: { userId: input.userId, tenantId },
    action,
    additionalExisting: context.conflictComparisons ?? undefined,
    contextExpiresAt: context.contextExpiresAt ?? input.expiresAt ?? undefined,
    candidateCreatedAt: context.contextObservedAt ?? context.providerSyncUpdatedAt ?? undefined,
    confidence: context.candidateConfidence ?? undefined,
    allowLowRiskAutoResolution: mode === 'active'
      && lowRiskAutoResolutionAuthorized(input.userId, tenantId),
  });
  const producerEvaluation = context.conflictEvaluation;
  // Current deterministic authorization, preconditions, source health, and
  // persisted comparison actions are authoritative. A producer evaluation is
  // retained only as drift telemetry; choosing by finding count could let two
  // advisory soft findings erase one hard permission/precondition failure.
  const evaluation = revalidation.conflictEvaluation;
  const producerDrift = producerEvaluation?.contextVersion === action.contextVersion
    && conflictMaterialKey(producerEvaluation) !== conflictMaterialKey(evaluation);
  logger.info({
    event: 'decision.conflict_evaluated',
    mode,
    userScope: `${input.userId}:${tenantId}`,
    sourceSkill: input.sourceSkill,
    disposition: evaluation.disposition,
    conflictClasses: evaluation.findings.map((finding) => finding.class),
    producerDrift,
    policyVersion: evaluation.policyVersion,
  }, 'Decision conflict policy evaluated candidate');
  if (mode === 'shadow' && !flowEnforced) return input;
  return {
    ...input,
    decisionContext: {
      ...context,
      normalizedAction: action,
      conflictEvaluation: evaluation,
    },
  };
}



export function knownProducerMutationRequiresSourceContract(input: NotificationIntentInput): boolean {
  const relatedEntityType = typeof input.relatedEntityType === 'string' ? input.relatedEntityType : null;
  const relatedEntityId = input.relatedEntityId == null ? null : String(input.relatedEntityId);
  const actionIds = new Set((input.actionButtons ?? []).map((action) => action.id));
  return (input.sourceSkill === 'finance'
      && relatedEntityType === 'finance_tax_event'
      && !!relatedEntityId
      && /^\d{4}-(0[1-9]|1[0-2])$/.test(relatedEntityId)
      && actionIds.has('mark_paid'))
    || (input.sourceSkill === 'content'
      && relatedEntityType === 'content_workflow_object'
      && !!relatedEntityId
      && /^\d+$/.test(relatedEntityId)
      && (actionIds.has('approve_script') || actionIds.has('request_rewrite')))
    || (input.sourceSkill === 'cooking'
      && relatedEntityType === 'meal_plan'
      && !!relatedEntityId
      && /^\d{4}-\d{2}-\d{2}:[a-z][a-z0-9_-]{0,39}$/i.test(relatedEntityId)
      && actionIds.has('add_meal'));
}



/**
 * Deterministically normalize only serving actions that already have a scoped
 * executor and read-back verifier. This adapter cannot authorize a mutation:
 * execution still passes lifecycle, permission, source-state, conflict, and
 * domain ownership checks. Unknown producer/action combinations remain
 * unnormalized and therefore cannot accidentally become executable.
 */
export function deriveNormalizedActionForKnownProducer(
  input: NotificationIntentInput,
  context: DecisionLogicContext,
): NormalizedDecisionAction | null {
  const tenantId = input.tenantId ?? input.userId;
  const relatedEntityType = typeof input.relatedEntityType === 'string' ? input.relatedEntityType : null;
  const relatedEntityId = input.relatedEntityId == null ? null : String(input.relatedEntityId);
  const actionIds = new Set((input.actionButtons ?? []).map((action) => action.id));

  if (input.sourceSkill === 'finance'
      && relatedEntityType === 'finance_tax_event'
      && relatedEntityId && /^\d{4}-(0[1-9]|1[0-2])$/.test(relatedEntityId)
      && actionIds.has('mark_paid')) {
    const sourceVersion = financeTaxEventStateRevision({ userId: input.userId, tenantId }, relatedEntityId);
    if (!sourceVersion) return null;
    return buildNormalizedDecisionAction({
      intent: 'finance.mark_tax_paid',
      targetEntities: [{ type: 'finance_tax_event', id: relatedEntityId, version: sourceVersion }],
      affectedResources: [{ type: 'finance_tax_event', id: relatedEntityId }],
      preconditions: [{
        type: 'finance_tax_state',
        ref: relatedEntityId,
        expectedVersion: sourceVersion,
        required: true,
      }],
      expectedEffects: [{ type: 'mark_tax_paid', targetRef: `finance_tax_event:${relatedEntityId}` }],
      prohibitedEffects: [{ type: 'modify_different_tax_event', targetRef: `finance_tax_event:${relatedEntityId}` }],
      dependencies: [],
      exclusivityKeys: [`finance_tax_event:${tenantId}:${relatedEntityId}`],
      authorizationScope: ['decision_center:write'],
      risk: 'high',
      reversibility: 'irreversible',
      contextVersion: producerContextVersion('finance', relatedEntityType, relatedEntityId, sourceVersion, context),
    });
  }

  const contentAction = actionIds.has('approve_script')
    ? 'approve_script'
    : actionIds.has('request_rewrite') ? 'request_rewrite' : null;
  if (input.sourceSkill === 'content'
      && relatedEntityType === 'content_workflow_object'
      && relatedEntityId && /^\d+$/.test(relatedEntityId)
      && contentAction) {
    const sourceVersion = contentWorkflowStateRevision({ userId: input.userId, tenantId }, relatedEntityId);
    if (!sourceVersion) return null;
    const targetApproval = contentAction === 'approve_script' ? 'approved' : 'rewrite_requested';
    return buildNormalizedDecisionAction({
      intent: `content.${contentAction}`,
      targetEntities: [{ type: 'content_workflow_object', id: relatedEntityId, version: sourceVersion }],
      affectedResources: [{ type: 'content_workflow_object', id: relatedEntityId }],
      preconditions: [{
        type: 'content_workflow_state',
        ref: relatedEntityId,
        expectedVersion: sourceVersion,
        required: true,
      }],
      expectedEffects: [{
        type: 'set_content_approval_state',
        targetRef: `content_workflow_object:${relatedEntityId}`,
        value: targetApproval,
      }],
      prohibitedEffects: [{
        type: 'set_content_approval_state',
        targetRef: `content_workflow_object:${relatedEntityId}`,
        value: targetApproval === 'approved' ? 'rewrite_requested' : 'approved',
      }],
      dependencies: [],
      exclusivityKeys: [`content_workflow_object:${tenantId}:${relatedEntityId}`],
      authorizationScope: ['decision_center:write'],
      risk: 'medium',
      reversibility: 'compensatable',
      contextVersion: producerContextVersion('content', relatedEntityType, relatedEntityId, sourceVersion, context),
    });
  }

  if (input.sourceSkill === 'cooking'
      && relatedEntityType === 'meal_plan'
      && relatedEntityId && /^\d{4}-\d{2}-\d{2}:[a-z][a-z0-9_-]{0,39}$/i.test(relatedEntityId)
      && actionIds.has('add_meal')) {
    const sourceVersion = cookingMealSlotStateRevision({ userId: input.userId, tenantId }, relatedEntityId);
    if (!sourceVersion) return null;
    return buildNormalizedDecisionAction({
      intent: 'cooking.add_meal',
      targetEntities: [{ type: 'meal_plan', id: relatedEntityId, version: sourceVersion }],
      affectedResources: [{ type: 'meal_plan', id: relatedEntityId }],
      preconditions: [{
        type: 'meal_plan_slot_state',
        ref: relatedEntityId,
        expectedVersion: sourceVersion,
        required: true,
      }],
      expectedEffects: [{ type: 'upsert_meal_plan_slot', targetRef: `meal_plan:${relatedEntityId}` }],
      prohibitedEffects: [{ type: 'modify_different_meal_slot', targetRef: `meal_plan:${relatedEntityId}` }],
      dependencies: [],
      exclusivityKeys: [`meal_plan:${tenantId}:${relatedEntityId}`],
      authorizationScope: ['decision_center:write'],
      risk: 'low',
      reversibility: 'reversible',
      contextVersion: producerContextVersion('cooking', relatedEntityType, relatedEntityId, sourceVersion, context),
    });
  }

  return null;
}



export function producerContextVersion(
  sourceSkill: string,
  relatedEntityType: string,
  relatedEntityId: string,
  sourceVersion: string,
  context: DecisionLogicContext,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    sourceSkill,
    relatedEntityType,
    relatedEntityId,
    sourceVersion,
    sourceState: context.sourceState ?? null,
    providerSyncState: context.providerSyncState ?? null,
    providerSyncUpdatedAt: context.providerSyncUpdatedAt ?? null,
  })).digest('hex').slice(0, 32);
  return `ctx_${sourceSkill}_${digest}`;
}



export function shouldSuppressRepeatedRejectedCandidate(input: NotificationIntentInput): boolean {
  const tenantId = input.tenantId ?? input.userId;
  if (!isDecisionFeedbackSuppressionEnabled(process.env, { userId: input.userId, tenantId })) return false;
  if (input.priority === 'critical' || input.priority === 'time_sensitive') return false;
  const action = normalizeDecisionAction(decisionContextForIntentInput(input).normalizedAction);
  if (!action || action.risk === 'high' || action.risk === 'critical') return false;
  const rawDays = Number(process.env.DECISION_CANDIDATE_REJECTION_COOLDOWN_DAYS ?? 0);
  if (!Number.isSafeInteger(rawDays) || rawDays < 1 || rawDays > 90) return false;
  const cooldownDays = rawDays;
  try {
    const currentMaterialKey = rejectionMaterialKey(input, action);
    const priors = getDb().prepare(`
      SELECT items.item_id AS itemId, items.priority,
             intents.normalized_action_json AS normalizedActionJson,
             intents.decision_context_json AS decisionContextJson
        FROM notification_intents intents
        JOIN notification_center_items items
          ON items.intent_id = intents.intent_id
         AND items.user_id = intents.user_id
         AND items.tenant_id = intents.tenant_id
         WHERE intents.user_id = ? AND intents.tenant_id = ?
         AND intents.candidate_fingerprint = ?
         AND (items.decision_state = 'rejected' OR items.status = 'dismissed')
         AND datetime(items.updated_at) >= datetime(?, ?)
       ORDER BY items.updated_at DESC
       LIMIT 25
    `).all(
      input.userId,
      tenantId,
      action.candidateFingerprint,
      appNowIso(),
      `-${cooldownDays} days`,
    ) as Array<{
      itemId: string;
      priority: NotificationPriority;
      normalizedActionJson: string | null;
      decisionContextJson: string | null;
    }>;
    const repeated = priors.some((prior) => {
      const priorAction = normalizeDecisionAction(safeParseJson(prior.normalizedActionJson, null));
      if (!priorAction) return false;
      const priorContext = safeParseJson<DecisionLogicContext>(prior.decisionContextJson, {});
      return rejectionMaterialKey({
        ...input,
        priority: prior.priority,
        decisionContext: priorContext,
      }, priorAction) === currentMaterialKey;
    });
    if (!repeated) return false;
    logger.info({
      userId: input.userId,
      tenantId,
      sourceSkill: input.sourceSkill,
      type: input.type,
      cooldownDays,
    }, 'Suppressed repeated rejected Decision Center candidate');
    return true;
  } catch (err) {
    logger.warn({ err, userId: input.userId, tenantId }, 'Candidate rejection cooldown check failed open');
    return false;
  }
}



export function rejectionMaterialKey(input: NotificationIntentInput, action: NormalizedDecisionAction): string {
  const conflict = decisionContextForIntentInput(input).conflictEvaluation;
  const material = {
    candidateFingerprint: action.candidateFingerprint,
    targetEntities: action.targetEntities,
    requestedWindow: action.requestedWindow ?? null,
    preconditions: action.preconditions,
    expectedEffects: action.expectedEffects,
    prohibitedEffects: action.prohibitedEffects,
    authorizationScope: action.authorizationScope,
    risk: action.risk,
    reversibility: action.reversibility,
    priority: input.priority,
    conflict: conflict ? conflictMaterialShape(conflict) : null,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}



export function persistDecisionFlowMetadata(itemId: string, intentId: string, input: NotificationIntentInput): void {
  const tenantId = input.tenantId ?? input.userId;
  const context = decisionContextForIntentInput(input);
  const normalizedAction = normalizeDecisionAction(context.normalizedAction);
  const conflict = context.conflictEvaluation;
  const contextVersion = normalizedAction?.contextVersion
    ?? conflict?.contextVersion
    ?? fallbackDecisionContextVersion(input);
  ensureDecisionCenterTables();
  getDb().transaction(() => {
      const intentUpdate = getDb().prepare(`
        UPDATE notification_intents
           SET context_version = ?,
               context_observed_at = ?,
               candidate_fingerprint = ?,
               normalized_action_json = ?
         WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
      `).run(
        contextVersion,
        context.contextObservedAt ?? conflict?.evaluatedAt ?? appNowIso(),
        normalizedAction?.candidateFingerprint ?? null,
        normalizedAction ? JSON.stringify(normalizedAction) : null,
        intentId,
        input.userId,
        tenantId,
      );
      assertDecisionScopedUpdateApplied(intentUpdate, 'persist_decision_flow_intent_metadata', {
        itemId,
        intentId,
        userId: input.userId,
        tenantId,
      });
      const itemUpdate = getDb().prepare(`
        UPDATE notification_center_items
           SET decision_state = COALESCE(decision_state, ?),
               updated_at = COALESCE(updated_at, created_at)
         WHERE item_id = ? AND user_id = ? AND tenant_id = ?
      `).run(decisionStateForConflictEvaluation(conflict), itemId, input.userId, tenantId);
      assertDecisionScopedUpdateApplied(itemUpdate, 'persist_decision_flow_item_metadata', {
        itemId,
        intentId,
        userId: input.userId,
        tenantId,
      });
      if (conflict && normalizedAction && conflict.contextVersion === normalizedAction.contextVersion) {
        const relatedDecisionIds = [...new Set(conflict.findings
          .map((finding) => finding.conflictingDecisionId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
        const conflictInsert = getDb().prepare(`
          INSERT INTO decision_conflict_evaluations (
            conflict_evaluation_id, decision_id, user_id, tenant_id, policy_version,
            context_version, disposition, hard_conflict_count, soft_conflict_count,
            reason_codes_json, related_decision_ids_json, precedence_trace_json,
            winner_decision_id, automatically_resolved
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `dce_${randomUUID()}`,
          itemId,
          input.userId,
          tenantId,
          conflict.policyVersion,
          conflict.contextVersion,
          conflict.disposition,
          conflict.findings.filter((finding) => finding.severity === 'hard').length,
          conflict.findings.filter((finding) => finding.severity === 'soft').length,
          JSON.stringify([...new Set(conflict.reasonCodes)].sort()),
          JSON.stringify(relatedDecisionIds),
          JSON.stringify(conflict.precedenceTrace ?? []),
          conflict.winnerDecisionId ?? null,
          conflict.autoResolved ? 1 : 0,
        );
        assertDecisionScopedUpdateApplied(conflictInsert, 'persist_decision_conflict_evaluation', {
          itemId,
          intentId,
          userId: input.userId,
          tenantId,
        });
      }
  })();
}



export function fallbackDecisionContextVersion(input: NotificationIntentInput): string {
  const stableContext = {
    userId: input.userId,
    tenantId: input.tenantId ?? input.userId,
    sourceSkill: input.sourceSkill,
    type: input.type,
    relatedEntityId: input.relatedEntityId == null ? null : String(input.relatedEntityId),
    relatedEntityType: input.relatedEntityType ?? null,
    dedupeKey: input.dedupeKey ?? null,
  };
  return `ctx_notification_${createHash('sha256')
    .update(JSON.stringify(stableContext))
    .digest('hex')
    .slice(0, 32)}`;
}



export function failClosedDecisionFlowMetadata(itemId: string, intentId: string, input: NotificationIntentInput): void {
  const tenantId = input.tenantId ?? input.userId;
  ensureDecisionCenterTables();
  getDb().transaction(() => {
    const intentUpdate = getDb().prepare(`
      UPDATE notification_intents
         SET status = 'failed', requires_user_action = 0,
             action_buttons_json = '[]', delivery_policy = 'in_app_only'
       WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
    `).run(intentId, input.userId, tenantId);
    assertDecisionScopedUpdateApplied(intentUpdate, 'fail_closed_decision_flow_intent', {
      itemId,
      intentId,
      userId: input.userId,
      tenantId,
    });
    const itemUpdate = getDb().prepare(`
      UPDATE notification_center_items
         SET status = 'failed', decision_state = 'blocked', requires_user_action = 0,
             actions_json = '[]', action_result_json = ?,
             record_version = record_version + 1, updated_at = datetime('now')
       WHERE item_id = ? AND user_id = ? AND tenant_id = ?
         AND status NOT IN ('actioned', 'dismissed', 'expired', 'superseded')
    `).run(
      JSON.stringify({ errorCode: 'DECISION_FLOW_METADATA_PERSISTENCE_FAILED', retryRequiresNewProposal: true }),
      itemId,
      input.userId,
      tenantId,
    );
    assertDecisionScopedUpdateApplied(itemUpdate, 'fail_closed_decision_flow_item', {
      itemId,
      intentId,
      userId: input.userId,
      tenantId,
    });
  })();
  emitDecisionLifecycleEvent({
    decisionId: itemId,
    userId: input.userId,
    tenantId,
    event: 'blocked',
    toStatus: 'blocked',
    reason: 'decision_flow_metadata_persistence_failed',
  });
}



export function decisionStateForConflictEvaluation(conflict?: ConflictEvaluation | null): DurableDecisionState {
  if (!conflict) return 'ready_for_review';
  if (conflict.disposition === 'block' || conflict.disposition === 'stale') return 'blocked';
  if (conflict.disposition === 'suppress_duplicate') return 'superseded';
  if (conflict.disposition === 'needs_confirmation') return 'ready_for_review';
  if (conflict.disposition === 'supersede') return 'ready_for_review';
  return 'ready_for_review';
}



export function buildSkillDecisionFixtureIntent(
  sourceSkill: NotificationSourceSkill,
  userId: number,
  overrides: Partial<NotificationIntentInput> = {},
): NotificationIntentInput {
  const base = buildSkillNotificationFixtureIntent(sourceSkill, userId, overrides);
  if (sourceSkill === 'training') {
    return {
      ...base,
      type: 'decision_required',
      title: 'Training plan needs race date',
      body: 'Add a race date or switch to continuous training before the next plan update.',
      actionButtons: [
        { id: 'open_detail', label: 'Review', style: 'primary' },
      ],
      requiresUserAction: true,
      decisionDeadline: overrides.decisionDeadline ?? new Date(Date.now() + 24 * 3_600_000).toISOString(),
      decisionContext: {
        ...(base.decisionContext ?? {}),
        entityTitle: 'Race date',
        sourceState: 'missing_required_input',
        deadlineAt: overrides.decisionDeadline ?? new Date(Date.now() + 24 * 3_600_000).toISOString(),
      },
      dedupeKey: overrides.dedupeKey ?? `training:missing-race-date:${userId}:demo`,
      ...overrides,
    };
  }
  return {
    ...base,
    requiresUserAction: overrides.requiresUserAction ?? true,
    ...overrides,
  };
}

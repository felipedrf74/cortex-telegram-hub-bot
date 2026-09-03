// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Physically extracted Decision Center types implementation.
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
  DECISION_DISMISS_REASONS,
} from './command-service';
import {
  DECISION_PROPOSAL_RECEIPT_SCHEMA_VERSION,
} from './proposal-service';
import {
  freshnessLabel,
  recommendedAction,
} from './read-projection-ranking-service';



export type DecisionClassification = 'decision' | 'notification' | 'task' | 'insight' | 'ignore';


export type DecisionUrgency = 'urgent' | 'today' | 'this_week' | 'optional';


export type DecisionActionStatus = 'succeeded' | 'failed' | 'blocked' | 'idempotent';



// ── Layered status model (Foundation) ──────────────────────────────────────
// The legacy flat `status` (NotificationCenterStatus) stays authoritative for
// back-compat; these express the distinct concerns it conflated. Effective
// statuses are COMPUTED, never persisted as the source of truth.
/** Where the decision is in its lifecycle (distinct from the action outcome). */
export type DecisionLifecycleStatus =
  | 'created' | 'surfaced' | 'viewed' | 'snoozed' | 'dismissed' | 'expired' | 'superseded' | 'completed';


/** Durable review state. NULL on legacy rows means derive from the legacy notification status. */
export type DurableDecisionState =
  | 'proposed' | 'needs_input' | 'blocked' | 'ready_for_review' | 'approved'
  | 'rejected' | 'deferred' | 'superseded' | 'expired' | 'cancelled';


/** Item-level outcome of the decision's action. Distinct from the per-execution DecisionActionStatus above. */
export type DecisionActionOutcomeStatus =
  | 'none' | 'started' | 'succeeded' | 'failed' | 'partially_failed' | 'rolled_back';


export type DecisionApprovalLevel = 'none' | 'user_confirmation' | 'strong_confirmation' | 'admin_review' | 'unavailable';


export interface DecisionEffectResult {
  effectId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'compensated' | 'unknown';
  reasonCode?: string;
}


export interface DecisionExecutionSummary {
  status: DecisionActionOutcomeStatus;
  lastAttemptId?: string;
  effectResults: DecisionEffectResult[];
  recoveryActions: NotificationActionButton[];
  message?: string;
}


/** Computed: how the client should render the item. Never persisted as source of truth. */
export type DecisionEffectiveStatus =
  | 'needs_action' | 'waiting_on_dependency' | 'waiting_on_system' | 'snoozed'
  | 'in_progress' | 'completed' | 'failed_retryable' | 'failed_terminal'
  | 'expired' | 'superseded' | 'dismissed' | 'unavailable';


/** Computed per-action render state. */
export interface DecisionActionEffectiveStatus {
  actionId: string;
  effective:
    | 'enabled' | 'disabled_unsupported' | 'disabled_not_implemented' | 'disabled_blocked_by_dependency'
    | 'disabled_expired' | 'disabled_superseded' | 'disabled_already_actioned' | 'disabled_missing_details'
    // A2: an unwired sync-retry on a connection/sync_failure decision — disabled, but the client should
    // route to connection settings (reconnect) rather than show a dead retry. Emitted only under the
    // DECISION_RECONNECT_AFFORDANCE flag; OFF falls back to disabled_not_implemented (byte-identical).
    | 'disabled_requires_reconnect';
  implemented: boolean;
  capabilityReason: string | null;
}



/** What kind of item this is, for differentiated client rendering. */
export type DecisionKind =
  | 'insight' | 'recommendation' | 'action_proposal' | 'choice_required'
  | 'risk_alert' | 'blocked_action' | 'status_update';


/** How the client should treat acting on this decision (computed; never persisted). */
export type Actionability =
  | 'read_only' | 'preview_available' | 'confirmation_required' | 'execute_with_undo'
  | 'requires_human_review' | 'blocked' | 'unavailable';



/** "Evidence strength" — confidence promoted to an explanation. label/sourceFreshness are always safe;
 *  basis/uncertainty are privacy-gated (only when decision evidence is exposable). */
export interface ConfidenceExplanation {
  value: number;
  label: 'high' | 'medium' | 'low';
  basis: string[];
  uncertainty: string[];
  sourceFreshness: 'live' | 'fresh' | 'stale' | 'unknown';
}



/**
 * Compact list/overview card (API v2). Projected from the full DecisionApiItem so list
 * surfaces ship ~22 fields/item instead of ~70. Full item is served only on detail.
 */
/** Compact evidence-strength signal for the v2 list card — derived ONLY from the always-safe
 *  confidence label + source freshness (never the privacy-gated basis/uncertainty). */
export type EvidenceStrengthLabel = 'strong' | 'moderate' | 'weak' | 'stale' | 'unverified';



export interface DecisionCardSummary {
  schemaVersion: string;
  decisionId: string;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  status: string;
  effectiveStatus?: DecisionEffectiveStatus;
  decisionKind?: DecisionKind;
  actionability?: Actionability;
  prioritySnapshot?: DecisionPrioritySnapshot;
  urgency: DecisionUrgency;
  timingLabel: string | null;
  priorityScore: number;
  sectionKey: DecisionTimelineSectionKey;
  isCarryover?: boolean;
  groupKey: string;
  displayMode: DecisionFrontendDisplayMode;
  frontendActionState: DecisionFrontendActionState;
  impactLevel: 'low' | 'medium' | 'high';
  safePreviewTitle: string;
  safePreviewBody: string;
  recommendedActionLabel: string | null;
  primaryActionLabel: string;
  deadlineAt: string | null;
  expiresAt: string | null;
  badgeContribution: boolean;
  confidence: number;
  /** Optional compact evidence-strength label (omitted when the item has no confidenceExplanation). */
  evidenceStrengthLabel?: EvidenceStrengthLabel;
  /** Additive conflict-policy summary. Omitted unless the v1 policy flag is enabled for this scope. */
  conflictSummary?: DecisionConflictSummary;
  /** Version of the authoritative context used to evaluate the proposal. */
  contextVersion?: string;
  contextObservedAt?: string;
  contextFreshness?: DecisionAnalysisBundle['sourceFreshness'];
  mutualExclusionGroupId?: string;
  supersededByDecisionId?: string;
  requiredPermissions?: string[];
  approvalLevel?: DecisionApprovalLevel;
  /** True only when the versioned review endpoint is enabled for this scope and this proposal can be reviewed. */
  reviewSupported?: boolean;
  /** Structured proposal fields the backend permits this client to edit. */
  editableProposalFields?: string[];
  reversibility?: NormalizedDecisionAction['reversibility'];
  execution?: DecisionExecutionSummary;
  /** Whether the token-zero refresh/revalidation route is available for this scope. */
  refreshSupported?: boolean;
  /** Optimistic concurrency version for proposal/lifecycle mutations. */
  recordVersion?: number;
  /** Durable review state; legacy rows are projected without rewriting them. */
  decisionState?: DurableDecisionState;
}



/** Paginated list envelope (API v2 cursor mode — always compact cards). nextCursor omitted when no further page. */
export interface DecisionListResponse {
  schemaVersion: string;
  count: number;
  openCount: number;
  items: DecisionCardSummary[];
  nextCursor?: string;
  pageSize: number;
  snapshotId?: string;
  rankingAsOf?: string;
  rankingVersion?: number;
  degradationReasons?: Array<{ code: string; message: string }>;
}



export interface DecisionOutcomeMetrics {
  userId: number;
  tenantId: number;
  totalOutcomes: number;
  decisionQualityScore: number | null;
  decisionSpecificityScore: number | null;
  decisionActionabilityScore: number | null;
  acceptedCount: number;
  dismissedCount: number;
  deferredCount: number;
  snoozedCount: number;
  askedNexusCount: number;
  explanationOpenCount: number;
  genericBlockedCount: number;
  totalQualityGateEvents: number;
  qualityGateByStatus: Record<string, number>;
  undoUsedCount: number;
  primaryActionCount: number;
  failedActionCount: number;
  partialFailureCount: number;
  autoHandledCount: number;
  averageTimeToActionMs: number | null;
  primaryActionRate: number;
  dismissRate: number;
  deferRate: number;
  snoozeRate: number;
  explanationOpenRate: number;
  genericBlockedRate: number;
  failedActionRate: number;
  partialFailureRate: number;
  bySourceSkill: Record<string, number>;
  bySourceSkillOutcome: Record<string, {
    total: number;
    accepted: number;
    dismissed: number;
    deferred: number;
  }>;
}



export interface DecisionEligibilityPolicyInput {
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  priority: NotificationPriority;
  requiresUserAction?: boolean;
  actionButtons?: NotificationActionButton[];
  deliveryPolicy?: string | null;
}



export interface DecisionEligibilityResult {
  classification: DecisionClassification;
  reasons: string[];
  apnsEligible: boolean;
  urgency: DecisionUrgency;
}



/**
 * Additive write contract for Decision Center proposals. Notification
 * Orchestrator deliberately remains unaware of the transport key: this layer
 * turns it into a scoped durable receipt and a deterministic internal intent
 * identity before handing the proposal to the notification substrate.
 */
export type DecisionIntentCommandInput = NotificationIntentInput & {
  idempotencyKey?: string;
  channel?: DecisionMutationChannel;
  /** Pre-normalization transport fingerprint; set only by trusted REST adapters. */
  proposalRequestFingerprint?: string;
};



export interface DecisionApiItem {
  decisionId: string;
  itemId: string;
  id: string;
  intentId: string;
  decisionLogId: string | null;
  userId: number;
  tenantId: number;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  status: string;
  lifecycleStatus?: DecisionLifecycleStatus;
  actionOutcomeStatus?: DecisionActionOutcomeStatus;
  effectiveStatus?: DecisionEffectiveStatus;
  actionEffectiveStatuses?: DecisionActionEffectiveStatus[];
  decisionKind?: DecisionKind;
  actionability?: Actionability;
  prioritySnapshot?: DecisionPrioritySnapshot;
  urgency: DecisionUrgency;
  timingLabel: string | null;
  priorityScore: number;
  title: string;
  summary: string;
  deeplink: string | null;
  safePreviewTitle: string;
  safePreviewBody: string;
  recommendedActionLabel: string | null;
  recommendedAction: NotificationActionButton | null;
  alternativeActions: NotificationActionButton[];
  whySummary: string;
  whyDetails: Array<{ label: string; value: string }>;
  explanation?: DecisionExplanation | null;
  problemStatement: string;
  recommendation: string;
  expectedEffect: string;
  impactIfIgnored: string;
  impactLevel: 'low' | 'medium' | 'high';
  primaryActionLabel: string;
  secondaryActionLabels: string[];
  urgencyReason: string;
  why: DecisionWhy;
  actionPreview: DecisionWhatWillChange[];
  whatWillChange: DecisionWhatWillChange[];
  alternatives: DecisionAlternativeOption[];
  /** D — structured domain choices (e.g. secretary slot picks) with tradeoffs. Optional + flag-gated:
   *  undefined (omitted from JSON) unless DECISION_CHOICE_OPTIONS is enabled AND the decision has real
   *  options, so existing clients see a byte-identical payload. */
  options?: DecisionOption[];
  /** D — skill-specific cards (content / training / finance). All optional + flag-gated (DECISION_SKILL_CARDS);
   *  each is undefined/omitted unless enabled AND the decision has a real backing domain object. */
  contentCard?: DecisionContentCard;
  trainingCard?: DecisionTrainingCard;
  financeCard?: DecisionFinanceCard;
  automationEligibility: AutomationEligibility;
  autopilotPolicy: string;
  readBackVerifier: string | null;
  handledByNexus: boolean;
  handledAt: string | null;
  outcomeSummary: string | null;
  failureReason: string | null;
  retryActions: NotificationActionButton[];
  notificationEligibility: string;
  apnsInterruptionLevel: 'passive' | 'active' | 'time-sensitive';
  collapseKey: string | null;
  badgeContribution: boolean;
  quality: DecisionQualityGateResult;
  relatedEntities: Array<{ type: string; id: string }>;
  relatedEntitiesSafe: Array<{ type: string; label: string }>;
  sourceTraceSummary: string | null;
  sourceTrace: DecisionSourceTrace | null;
  dependencyGraphSummary: string | null;
  actionTruthTableEntry: DecisionActionTruthTableEntry | null;
  askNexusContext: DecisionAskNexusContext | null;
  deadlineAt: string | null;
  expiresAt: string | null;
  confidence: number;
  analysis: DecisionAnalysisBundle;
  confidenceExplanation?: ConfidenceExplanation;
  conflictSummary?: DecisionConflictSummary;
  contextVersion?: string;
  contextObservedAt?: string;
  contextFreshness?: DecisionAnalysisBundle['sourceFreshness'];
  /** Stable privacy-safe grouping identity for decisions competing for the same exclusivity resource. */
  mutualExclusionGroupId?: string;
  /** Canonical replacement when this decision has been superseded. */
  supersededByDecisionId?: string;
  requiredPermissions: string[];
  approvalLevel: DecisionApprovalLevel;
  reviewSupported: boolean;
  editableProposalFields: string[];
  /** Canonical UTC proposal window persisted in the decision context. */
  recommendedStartAt: string | null;
  recommendedEndAt: string | null;
  reversibility: NormalizedDecisionAction['reversibility'] | null;
  execution: DecisionExecutionSummary;
  /** Whether the token-zero refresh/revalidation route is available for this scope. */
  refreshSupported: boolean;
  recordVersion: number;
  decisionState: DurableDecisionState;
  riskLevel: 'low' | 'medium' | 'high';
  groupKey: string;
  sectionKey: DecisionTimelineSectionKey;
  /** Older unresolved work, separated from the user's current local day by new clients. */
  isCarryover?: boolean;
  displayMode: DecisionFrontendDisplayMode;
  frontendActionState: DecisionFrontendActionState;
  privacyClassification: NotificationPrivacyPolicy;
  visibilityScope: 'user_private' | 'tenant_shared' | 'tenant_admin' | 'system_admin';
  createdAt: string;
  updatedAt: string;
  snoozedUntil: string | null;
  actions: NotificationActionButton[];
  dependsOnDecisionIds: string[];
  blockedByDecisionIds: string[];
  /** C6: typed relationship edges to other decisions (only `blocks` is action-preventing; the rest are advisory). */
  relationships: DecisionRelationship[];
  rollbackAvailable: boolean;
  rollbackActionId: string | null;
}



/** A typed relationship edge surfaced to the client (C6). `type` is the raw stored relationship; `kind`/`label` come from decisionRelationshipSemantics. */
export interface DecisionRelationship {
  decisionId: string;
  type: string;
  kind: DecisionRelationshipKind;
  label: string;
}



export type DecisionExplanationStepStatus = 'done' | 'needs_user' | 'pending' | 'blocked';


export type DecisionExplanationDisplaySection = 'decision_needed' | 'what_will_change' | 'why_it_matters' | 'options' | 'verification' | 'debug';



export interface DecisionExplanationStep {
  label: string;
  detail: string;
  status: DecisionExplanationStepStatus;
}



export interface DecisionExplanationActionLabels {
  primary: string;
  secondary: string[];
}



export interface DecisionExplanation {
  headline: string;
  whatHappened: string;
  whyItMatters: string;
  nexusAction: string;
  userAction: string;
  result: string;
  verification: string;
  nextStep: string;
  steps: DecisionExplanationStep[];
  recommendedMove?: string;
  ifIgnored?: string;
  actionLabels?: DecisionExplanationActionLabels;
  displaySections?: DecisionExplanationDisplaySection[];
}



export interface DecisionAnalysisBundle {
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  sourceFreshness: 'live' | 'fresh' | 'stale' | 'unknown';
  freshnessLabel: string;
  whyNow: string;
  expectedOutcome: string;
  costOfDelay: string;
  tradeoffs: string[];
  uncertainty: string[];
  rollbackConfidence: 'high' | 'medium' | 'low' | 'none';
}



export type DecisionTimelineSectionKey = 'urgent' | 'today' | 'tomorrow' | 'this_week' | 'waiting_on_systems' | 'handled' | 'history';



export interface DecisionAlternativeOption {
  id: string;
  label: string;
  rank: 'best' | 'good' | 'not_recommended';
  reason: string;
  actionId: string | null;
  available: boolean;
  source: 'recipe' | 'system_default';
}



/**
 * A structured CHOICE option for a `choice_required`-style decision (e.g. secretary "move to which slot?").
 * Distinct from DecisionAlternativeOption (which-button): an option is a domain choice carrying its own
 * tradeoffs + a LIGHTWEIGHT intent (which existing action + payload to invoke). It deliberately carries NO
 * baked command preview — that goes stale — so the client requests a fresh confirmation at selection time
 * through the normal performDecisionAction path. Additive/optional on the item (Codable-backward-compatible).
 */
export interface DecisionOption {
  optionId: string;
  title: string;
  summary: string;
  tradeoffs: string[];
  recommended: boolean;
  risk: 'low' | 'medium' | 'high';
  /** Lightweight intent: the existing decision action this option maps to (e.g. 'choose_another_time'). */
  actionId: string;
  /** Optional payload the action needs at selection time (e.g. the chosen window). Not a baked preview. */
  actionPayload?: { startAt?: string; endAt?: string };
}



/**
 * D (content) — a skill-specific card surfacing the content pipeline state a content decision is about, so
 * the client can render "Script · Drafted · Review required · [Approve]" instead of inferring it. Every
 * field is read straight from the content workflow object (objectType / editorialState / approvalState /
 * reviewRequired) — no free text — so it cannot be tainted by injected evidence. Additive/optional on the
 * item (Codable-backward-compatible); flag-gated.
 */
export interface DecisionContentCard {
  objectType: string;
  pipelineStage: string;
  approvalState: string;
  reviewRequired: boolean;
  nextActionLabel: string | null;
}



/**
 * D (training) — a structured before/after card for a training-origin reflow decision: the current
 * (before) and recommended (after) schedule windows, a conservative risk label derived ONLY from the
 * agenda's structured decisionReasonCodes (never free text, so injected evidence can't move it), and undo
 * availability. Read-only; flag-gated; undefined (no hollow card) unless the decision truly anchors a
 * training agenda item with a real before window.
 */
export interface DecisionTrainingCard {
  beforeWindowLabel: string | null;
  afterWindowLabel: string | null;
  beforeStartAt: string | null;
  beforeEndAt: string | null;
  afterStartAt: string | null;
  afterEndAt: string | null;
  risk: 'low' | 'medium' | 'high';
  undoAvailable: boolean;
}



/**
 * D (finance) — a READ-ONLY, privacy-safe card for a finance tax-event decision. Surfaces ONLY safe
 * labels: the tax month, the payment status enum, a freshness label, and the next action. It NEVER
 * carries any amount (tax_due / inss_due / gross_income / taxable_income) and uses no overconfident copy.
 * Flag-gated; undefined (no hollow card) unless a real matching tax event exists.
 */
export interface DecisionFinanceCard {
  taxMonth: string;
  paymentStatus: string;
  freshnessLabel: string;
  nextActionLabel: string | null;
}



export interface DecisionSourceTrace {
  originatingSkill: NotificationSourceSkill;
  originatingSignal: NotificationIntentType;
  sourceEntityIds: string[];
  sourceTimestamp: string;
  enrichmentService: string;
  orchestrator: string;
  executor: string | null;
  verifier: string | null;
  relatedStateReadModels: string[];
  confidenceSource: string;
  dataFreshness: 'live' | 'cached' | 'unknown';
  /**
   * C2 workstream: ordered reasoning breadcrumbs from the Secretary
   * scheduling arbitrator. Only populated for `secretary_agenda_item`
   * related entities; empty for non-secretary decisions. iOS Codable
   * decoder treats this as optional.
   *
   * Privacy: nodes carry ONLY enum codes + ISO slot strings + numeric
   * weights. Never user copy. Pinned by W-E privacy test.
   */
  reasoningTrail?: ReasoningTrailNode[];
}



export interface DecisionAskNexusContext {
  decisionId: string;
  sourceSkill: NotificationSourceSkill;
  type: NotificationIntentType;
  prompt: string;
}



export interface DecisionSummary {
  openCount: number;
  urgentCount: number;
  todayCount: number;
  handledTodayCount: number;
  topDecisionTitle: string | null;
  topDecisionSourceSkill: NotificationSourceSkill | null;
  topDecisionUrgency: DecisionUrgency | null;
  topDecisionWhy: string | null;
  topSuggestion: DecisionCenterTopSuggestion | null;
  ctaLabel: string;
  previewItems: DecisionApiItem[];
  badgeCount: number;
  gamification: DecisionGamificationSummary | null;
}



export interface DecisionCenterTopSuggestion {
  decisionId: string;
  title: string;
  actionLabel: string | null;
  whyNow: string;
  expectedOutcome: string;
  riskIfIgnored: string;
  sourceSkill: NotificationSourceSkill;
  urgency: DecisionUrgency;
}



export interface DecisionCenterOverview {
  count: number;
  openCount: number;
  handledCount: number;
  staleCount: number;
  supersededCount: number;
  generatedAt: string;
  summary: DecisionSummary;
  topSuggestion: DecisionCenterTopSuggestion | null;
  partial: {
    items: boolean;
    handled: boolean;
    summary: boolean;
  };
  secretaryToday: SecretaryTodaySummaryModel;
  /** C5: present ONLY when fatigue caps are active — lets the client split `items` into pinned primary cards + a "More" bucket. */
  fatigue?: { primaryCount: number; moreCount: number; cappedCount: number };
  /**
   * BE-1 (Content Studio): present ONLY when the overview was requested with a
   * `sourceSkill` filter. `items` is then the skill-scoped open slice and
   * `sourceSkillTotalCount` is the pre-limit open total for that skill (the
   * client's "+N more" overflow count). Counters, summary and secretaryToday
   * stay GLOBAL; unfiltered responses are byte-identical to before.
   */
  sourceSkillFilter?: NotificationSourceSkill;
  sourceSkillTotalCount?: number;
  items: DecisionApiItem[];
  handled: HandledByNexusItem[];
}



export interface DecisionGamificationSummary {
  currentStreakDays: number;
  bestStreakDays: number;
  last14Days: Array<{
    date: string;
    cleared: boolean;
    reachedZeroAt: string | null;
  }>;
  decisionsLeft: number;
  hoursLeftToday: number;
  atRisk: boolean;
}



export interface DecisionActionResult {
  actionId: string;
  status: DecisionActionStatus;
  idempotent: boolean;
  item: DecisionApiItem;
  verification: {
    readBackOk: boolean;
    expectedEffect: Record<string, unknown>;
    actualEffect: Record<string, unknown>;
    message: string;
  };
}



export interface HandledByNexusItem {
  itemId: string;
  /** Originating Decision Center ID used for scoped lifecycle/conflict history. */
  decisionId: string;
  userId: number;
  tenantId: number;
  sourceSkill: NotificationSourceSkill;
  title: string;
  summary: string;
  explanation?: DecisionExplanation | null;
  actionTaken: string;
  whyBrief: string;
  relatedEntities: Array<{ type: string; id: string }>;
  rollbackAvailable: boolean;
  /** Fresh versioned command contract; absent for legacy/unsupported handled rows. */
  rollbackAction?: {
    actionId: string;
    recordVersion: number;
    contextVersion: string | null;
  };
  execution?: DecisionExecutionSummary;
  reconciliationAvailable?: boolean;
  changedRuleOption: string | null;
  createdAt: string;
  privacyClassification: NotificationPrivacyPolicy;
}



export interface DecisionRecord extends NotificationCenterItem {
  relatedEntityId: string | null;
  relatedEntityType: string | null;
  decisionContext: DecisionLogicContext | null;
  requiresUserAction: boolean;
  decisionDeadline: string | null;
  privacyPolicy: NotificationPrivacyPolicy;
  deliveryPolicy: string | null;
  snoozedUntil: string | null;
  priorityScore: number | null;
  actionedAt: string | null;
  decisionLogActionTaken: string | null;
  actionResult: Record<string, unknown> | null;
  recordVersion: number;
  decisionState: DurableDecisionState | null;
  updatedAt: string;
  supersededByItemId: string | null;
  contextObservedAt: string | null;
  storedContextVersion: string | null;
}



export type DecisionUserFacingFilterReason =
  | 'visible'
  | 'guidance_disabled'
  | 'admin_visibility_scope'
  | 'internal_only'
  | 'smoke_decision'
  | 'unsafe_quality'
  | 'unsafe_frontend_action'
  | 'stale_action_source'
  | 'incomplete_guidance';



export interface DecisionUserFacingFilterVerdict {
  visible: boolean;
  reason: DecisionUserFacingFilterReason;
}



export interface DecisionHandledHistoryStats {
  writeFailures: number;
  backfillRuns: number;
  backfilled: number;
  backfillFailures: number;
}



export interface DecisionGuidanceStats {
  emitted: number;
  nullGuidance: number;
  partial: number;
  bannedTermsCaught: number;
  bannedTermsByTerm: Record<string, number>;
  filteredFromUserView: number;
  filteredByReason: Record<string, number>;
}



export interface DecisionHandledHistoryBackfillResult {
  inspected: number;
  backfilled: number;
  skipped: number;
  failed: number;
}



export interface DecisionCenterSmokeCleanupResult {
  inspected: number;
  expired: number;
  dryRun: boolean;
  countsByStatus: Record<string, number>;
  countsByVisibilityScope: Record<string, number>;
}



export interface DecisionProposalCommand {
  eventId: string;
  intentId: string;
  requestFingerprint: string;
  userId: number;
  tenantId: number;
  contract: DecisionMutationCommand;
}



export interface DecisionProposalReceipt {
  schemaVersion: typeof DECISION_PROPOSAL_RECEIPT_SCHEMA_VERSION;
  requestFingerprint: string;
  decisionId: string | null;
  eligibility: DecisionEligibilityResult;
  commandContract: Omit<DecisionMutationCommand, 'idempotencyKey'> & {
    idempotencyKeyHash: string;
  };
}



export interface DecisionRefreshOptions {
  /** Stable client journal key. Omitted only by existing internal callers. */
  idempotencyKey?: string;
  expectedVersion?: number;
  contextVersion?: string;
  channel?: string;
}



export interface DecisionRefreshReceipt {
  refreshedAt: string;
  requestFingerprint: string;
}



export interface DecisionExpirySweepResult {
  inspected: number;
  expired: number;
  remaining: number;
  batches: number;
  durationMs: number;
}



export interface DecisionLedgerRetentionPruneResult {
  outcomeLedgerPruned: number;
  qualityGateEventsPruned: number;
  conflictEvaluationsPruned: number;
  terminalExclusivityClaimsPruned: number;
  rankSnapshotsPruned: number;
  outcomeLedgerRemaining: number;
  qualityGateEventsRemaining: number;
  conflictEvaluationsRemaining: number;
  terminalExclusivityClaimsRemaining: number;
  rankSnapshotsRemaining: number;
  /** Combined bounded batch-pass count across every raw table. */
  batches: number;
  durationMs: number;
}



export interface DecisionRankSnapshotBackfillResult {
  inspectedScopes: number;
  materializedScopes: number;
  failedScopes: number;
  failures: Array<{ userId: number; tenantId: number; errorName: string }>;
}



export type DecisionReviewOutcome = 'approve' | 'reject' | 'defer';


export type DecisionReplacementChoice = 'keep_existing_commitment' | 'replace_with_candidate' | 'choose_another_time' | 'review_tradeoff';


export type DecisionDismissReason = typeof DECISION_DISMISS_REASONS[number];



export interface DecisionGuidanceSanitizationResult {
  sanitized: string;
  rejectedTerms: string[];
}



/** Ordered decision lifecycle events. 'surfaced' records the first list/get exposure for an active decision. */
export type DecisionLifecycleEvent =
  | 'created' | 'surfaced' | 'detail_opened' | 'viewed' | 'snoozed' | 'dismissed'
  | 'approved' | 'rejected' | 'deferred' | 'revised' | 'blocked'
  | 'revalidation_failed'
  | 'action_previewed' | 'action_started' | 'action_retryable' | 'action_succeeded' | 'action_failed' | 'action_partially_failed' | 'verified'
  | 'expired' | 'superseded' | 'rolled_back' | 'unblocked' | 'execution_reconciled' | 'auto_resolved';



export interface DecisionLifecycleEventRow {
  event: string;
  toStatus: string | null;
  actionId: string | null;
  reason: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}



export interface DecisionMetricsDailyRow {
  metricDate: string;
  tenantId: number;
  sourceSkill: string;
  createdCount: number;
  surfacedCount: number;
  viewedCount: number;
  dismissedCount: number;
  snoozedCount: number;
  actionSucceededCount: number;
  actionFailedCount: number;
  expiredCount: number;
  gateBlockedCount: number;
  computedAt: string;
}



export interface DecisionMetricsLocalDayWindow {
  localDate: string;
  timezone: string;
  startUtc: string;
  endUtc: string;
}



export interface DecisionReleaseGateStatus {
  /** Active rows whose hard deadline has passed but the expiry sweep has not yet flipped them. Sweep-health signal. */
  expiredButVisible: number;
  /** Decisions presented as actionable whose primary action has no deterministic executor. Must be 0 (invariant tripwire). */
  unimplementedActionableCtas: number;
  /** Generic Notification Center attempts blocked because the action belongs to a Decision Center/domain executor. */
  unsupportedNotificationActions: number;
  /** Active notification rows whose deeplink cannot route to a supported destination. */
  deadDeeplinks: number;
  /** Latest client-reported badge drift. Null means no client badge report has been observed in the window. */
  badgeDrift: number | null;
  /** Mutating generic notification actions that incorrectly reported success. Must be 0. */
  genericMutatingActionSuccesses: number;
  /** APNs categories/contracts exposing actions that the truth table disallows from lock screen. */
  apnsMutatingActionsExposed: number;
  /** Stale action-source decisions still visible through the Notification Center inbox path. */
  staleSourceVisibleInInbox: number;
  /** APNs delivery claims that have not reached a terminal receipt yet. Must be 0 before release/cleanup. */
  unreconciledDeliveryAttempts: number;
  /** Terminalized APNs claims whose provider outcome could not be proven. Must be 0 before release/cleanup. */
  deliveryOutcomeUnknownAttempts: number;
  pass: boolean;
}



/** Active-decision breakdowns for the operator dashboard (counts by domain / persisted type / status). */
export interface DecisionActiveBreakdowns {
  total: number;
  byDomain: Record<string, number>;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}



export type DecisionTypeSuppressionMode = 'dont_show_type' | 'snooze_type';



export interface DecisionTypeSuppression {
  sourceSkill: string;
  type: string;
  recipe: string | null;
  mode: DecisionTypeSuppressionMode;
  until: string | null;
  createdAt: string;
}



export interface DecisionFeedbackSignal {
  sourceSkill: string;
  type: string | null;
  surfaced: number;
  dismissed: number;
  snoozed: number;
  actionSucceeded: number;
  dismissRate: number;
  dontShowTypeCount: number;
  topDismissReasons: Array<{ reason: string; count: number }>;
}



export type DecisionExecutionReconciliationOutcome = 'applied' | 'not_applied' | 'unknown' | 'none';

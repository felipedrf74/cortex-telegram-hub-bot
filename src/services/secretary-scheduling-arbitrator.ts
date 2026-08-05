// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary scheduling arbitrator.
 *
 * This service is the first runtime layer over migration 083's
 * `secretary_agenda_items` ledger. It gives skills a typed way to ask
 * Secretary for time without writing provider events directly.
 *
 * Scope of this layer:
 * - normalize scheduling intents from skills,
 * - choose a feasible slot using explicit capacity inputs,
 * - persist agenda ownership/lifecycle state,
 * - expose source-skill feedback and decision reasons.
 *
 * Provider sync is performed by `secretary-agenda-provider-sync` using the
 * persisted agenda item and provider_sync_state fields, so retries stay
 * idempotent and the scheduling engine remains provider-agnostic.
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { cancelRemindersForAgendaItem } from '../state/reminders';
import { filterKnownReasonCodes, type SecretaryReasonCode } from './secretary-reason-codes';
import { emitSecretaryFeedback } from './secretary-feedback-bus';
import { emitDomainEvent } from './event-outbox';
import {
  TRAINING_SECRETARY_FEEDBACK_EVENT_TYPE,
  TRAINING_SECRETARY_FEEDBACK_SCHEMA_VERSION,
} from './training-secretary-feedback-consumer';
import {
  SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE,
  SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_VERSION,
  SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION,
} from './secretary-source-skill-feedback-consumers';
import {
  findSecretaryPreemptionWinnerReplay,
  persistSecretaryPreemptionGraph,
  secretaryAgendaPreemptionSchemaReady,
  type SecretaryPreemptionLoserEvidence,
} from './secretary-agenda-preemption';
import { requestSecretaryPreemptionCancellation } from './secretary-agenda-preemption-worker';
import './secretary-source-skill-feedback-consumers';

export type SecretarySourceSkill = 'secretary' | 'training' | 'cooking' | 'finance' | 'content';

export type SecretarySchedulingIntentAction =
  | 'schedule_this'
  | 'reschedule_this'
  | 'cancel_this'
  | 'find_time_for_this'
  | 'protect_time_for_this'
  | 'create_reminder'
  | 'create_follow_up'
  | 'request_clarification';

export type SecretaryAgendaLifecycleState =
  | 'proposed'
  | 'scheduled'
  | 'synced'
  | 'reflowed'
  | 'compressed'
  | 'deferred'
  | 'canceled'
  | 'superseded'
  | 'unscheduled'
  | 'failed_sync'
  | 'completed';

export type SecretaryProviderSyncState =
  | 'not_synced'
  | 'synced'
  | 'create_failed'
  | 'update_failed'
  | 'delete_failed'
  | 'readback_failed'
  | 'deleted';

export type SecretarySchedulingDecisionStatus =
  | 'scheduled'
  | 'reflowed'
  | 'compressed'
  | 'deferred'
  | 'unscheduled'
  | 'rejected'
  | 'needs_more_context';

export type SecretaryIntentPriority = 'low' | 'normal' | 'high' | 'urgent' | number;
export type SecretaryIntentFlexibility = 'fixed' | 'flexible' | 'compressible' | 'splittable';

export const SECRETARY_ARBITRATION_RANK_POLICY_VERSION = 'secretary-arbitration-rank-policy.v1' as const;

/**
 * Stable, privacy-bounded metadata for comparing scheduling intents under one
 * policy version. This is an additive prerequisite only: it does not authorize
 * cross-skill preemption or provider mutation.
 */
export interface SecretaryIntentArbitrationRank {
  score: number;
  deadlineAt: string | null;
  flexibility: SecretaryIntentFlexibility;
  policyVersion: typeof SECRETARY_ARBITRATION_RANK_POLICY_VERSION;
  tieBreakerIntentId: string;
}

export interface SecretaryTimeWindow {
  start: string;
  end: string;
  label?: string;
  hard?: boolean;
  /**
   * Privacy-bounded durable identity from a live provider read. This is never
   * inferred from title/time. Missing or ambiguous identity keeps the window
   * hard-busy.
   */
  providerIdentity?: SecretaryProviderEventIdentity;
}

export interface SecretaryProviderEventIdentity {
  providerEventId: string;
  providerSource: 'google' | 'outlook';
  ownerUserId: number;
  tenantId: string;
  agendaItemId: string | null;
  trainingIdentity: {
    planId: number | null;
    planVersion: number | null;
    sessionId: number | null;
    sessionIdentityKey: string | null;
    sessionShapeHash: string | null;
  } | null;
}

/**
 * Training goal phase used for dynamic priority weighting (C3 workstream).
 * Matches the `BlockPhase` type from `coach-kernel/types.ts:5-12` but kept as
 * a string union here to avoid a Secretary→coach-kernel hard dependency at
 * the type level. Training callers should pass `inferPhase(athlete, weekStart)`
 * from `coach-kernel/planner-engine.ts:59`.
 */
export type SecretaryGoalPhase =
  | 'base'
  | 'build'
  | 'peak'
  | 'taper'
  | 'race'
  | 'deload'
  | 'maintenance';

export interface SecretarySchedulingIntent {
  intentId: string;
  action?: SecretarySchedulingIntentAction;
  sourceSkill: SecretarySourceSkill;
  sourceAction?: string | null;
  sourceEntityId?: string | number | null;
  sourceEntityType?: string | null;
  ownerUserId: number;
  tenantId: string | number;
  /**
   * Calendar provider selected before this intent is persisted. Provider
   * workers may execute only against this durable target; they must never
   * infer a target from whichever connection happens to be available later.
   */
  providerTarget?: 'google' | 'outlook' | null;
  title: string;
  requestedDurationMinutes?: number | null;
  minimumDurationMinutes?: number | null;
  preferredWindows?: SecretaryTimeWindow[];
  hardConstraints?: {
    unavailableWindows?: SecretaryTimeWindow[];
    protectedWindows?: SecretaryTimeWindow[];
    hardCommitments?: SecretaryTimeWindow[];
  };
  softPreferences?: Record<string, unknown>;
  deadline?: string | null;
  priority?: SecretaryIntentPriority;
  flexibility?: SecretaryIntentFlexibility;
  recurrence?: unknown;
  dependencies?: string[];
  energyCost?: number | null;
  reason?: string | null;
  context?: string | null;
  /**
   * Optional goal-phase signal for dynamic priority weighting (C3 workstream).
   * When set, Secretary up-weights or down-weights the source skill's base
   * priority during arbitration:
   *  - training: build +2, peak +3, taper -2, race -4, deload -3 (else 0)
   *  - other skills: 0 (signal ignored)
   * Phase = null/undefined → boost = 0 (graceful default, no behavior change).
   * Finance deadline boost (+18) dominates phase boost so a tax deadline
   * still outranks Training in race week.
   */
  goalPhase?: SecretaryGoalPhase | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SecretaryAgendaItem {
  agendaItemId: string;
  sourceIntentId: string;
  sourceSkill: SecretarySourceSkill;
  sourceAction: string | null;
  intentAction: SecretarySchedulingIntentAction;
  sourceEntityId: string | null;
  sourceEntityType: string | null;
  ownerUserId: number;
  tenantId: string;
  lifecycleState: SecretaryAgendaLifecycleState;
  providerSyncState: SecretaryProviderSyncState;
  providerEventId: string | null;
  providerSource: string | null;
  providerTarget: 'google' | 'outlook' | null;
  providerSyncFailureDisposition: 'terminal' | 'retryable' | 'reconcile' | null;
  providerSyncRetryAfterAt: string | null;
  version: number;
  /**
   * Migration 280 rank snapshot. Legacy NULL values are intentionally
   * protected from future priority preemption.
   */
  arbitrationScore: number | null;
  arbitrationDeadlineAt: string | null;
  arbitrationFlexibility: SecretaryIntentFlexibility | null;
  arbitrationPolicyVersion: string | null;
  title: string;
  startAt: string | null;
  endAt: string | null;
  durationMinutes: number | null;
  decisionAction: SecretarySchedulingDecisionStatus;
  decisionReasonCodes: string[];
  decisionExplanation: string | null;
  sourceShapeHash: string;
  scheduledSegments: SecretaryTimeWindow[];
  cancellationReason: string | null;
  supersededByAgendaItemId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  /**
   * Persisted reasoning trail (W-E). Read from `reasoning_trail_json`
   * column. Always an array — empty when the row predates the trail
   * column or when persistence was skipped.
   */
  reasoningTrail: ReasoningTrailNode[];
  /**
   * Consecutive provider-sync failures (migration 220). Rows at/over the
   * dead-letter threshold are skipped by the cleanup loop. Decodes to 0
   * on pre-migration rows.
   */
  providerSyncFailureCount: number;
  /**
   * Provider-sync short-circuit state (migration 224). Fingerprint of what
   * was last pushed to the provider (source|shape-hash|slot|version) and
   * when the provider event was last verified. Decode to null on
   * pre-migration rows, which forces a full sync.
   */
  lastSyncedFingerprint: string | null;
  lastSyncedVerifiedAt: string | null;
}

export interface SecretarySchedulingDecision {
  status: SecretarySchedulingDecisionStatus;
  agendaItem: SecretaryAgendaItem;
  /**
   * Reason codes for the arbitration outcome. Producers emit
   * `SecretaryReasonCode` (compiler-enforced); historical legacy rows from
   * pre-W-A persistence may contain unknown strings — consumers use
   * `isKnownReasonCode` from `./secretary-reason-codes` to branch safely.
   */
  reasonCodes: SecretaryReasonCode[];
  explanation: string;
  selectedSlot: SecretaryTimeWindow | null;
  alternativeSlots: SecretaryTimeWindow[];
  conflicts: string[];
  downstreamImplications: string[];
  confidence: 'low' | 'medium' | 'high';
  feedback: SecretarySourceSkillFeedback;
  /**
   * Ordered breadcrumbs the arbitrator left while making this decision
   * (W-E workstream). Capped at 12 nodes via `capReasoningTrail`; preserves
   * outcome markers (`chosen`/`rejected`/`deferred`/`unscheduled`) over
   * setup nodes when overflowing. Privacy: enum + slot + weight only,
   * never user copy.
   */
  reasoningTrail: ReasoningTrailNode[];
}

export interface SecretarySourceSkillFeedback {
  sourceSkill: SecretarySourceSkill;
  sourceIntentId: string;
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string;
  agendaVersion: number;
  status: SecretarySchedulingDecisionStatus;
  reasonCodes: SecretaryReasonCode[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  shouldRefreshSource: boolean;
  downstreamImplications: string[];
}

/**
 * Reasoning-trail node kinds (W-E workstream).
 *
 * Each scheduling decision emits an ordered list of breadcrumbs that
 * Secretary used to arrive at the outcome. Surfaced through Decision Center
 * detail (C2) and Telegram `/why_last` so users get a "why moved my run?"
 * answer.
 *
 * Privacy: trail nodes carry ONLY enum codes + structured slot objects +
 * numeric weights. NEVER free-text titles, NEVER user descriptions. The
 * single `detail` field is a short structured tag (e.g. `dur:60`,
 * `weight:14`) — not user copy.
 */
export type ReasoningTrailNodeKind =
  | 'validation'
  | 'candidate'
  | 'busy_block'
  | 'priority'
  | 'phase_boost'
  | 'compression'
  | 'reflow'
  | 'considered'
  | 'chosen'
  | 'rejected'
  | 'deferred'
  | 'unscheduled';

export interface ReasoningTrailNode {
  kind: ReasoningTrailNodeKind;
  reasonCode?: SecretaryReasonCode;
  slot?: { start: string; end: string };
  weight?: number;
  /**
   * Short structured tag, NOT free-text. Examples: `dur:60`, `min:45`,
   * `cand_count:3`, `busy_count:5`. Cap 32 chars; never contains user copy.
   */
  detail?: string;
}

/** Hard cap on stored trail length to bound row width. */
const REASONING_TRAIL_MAX_NODES = 12;

/**
 * Cap a trail at `REASONING_TRAIL_MAX_NODES` while preserving terminal
 * `chosen`/`rejected`/`deferred`/`unscheduled` nodes — these are the
 * outcome markers users actually want to see. Earlier `considered`/`candidate`
 * nodes are dropped first.
 */
function capReasoningTrail(trail: ReasoningTrailNode[]): ReasoningTrailNode[] {
  if (trail.length <= REASONING_TRAIL_MAX_NODES) return trail;
  const terminal = trail.filter((node) =>
    node.kind === 'chosen' || node.kind === 'rejected' || node.kind === 'deferred' || node.kind === 'unscheduled',
  );
  const remaining = REASONING_TRAIL_MAX_NODES - terminal.length;
  if (remaining <= 0) {
    // Edge case: more than 12 terminal nodes (shouldn't happen). Keep the
    // last 12 terminal nodes.
    return terminal.slice(-REASONING_TRAIL_MAX_NODES);
  }
  const nonTerminal = trail.filter((node) =>
    node.kind !== 'chosen' && node.kind !== 'rejected' && node.kind !== 'deferred' && node.kind !== 'unscheduled',
  );
  // Keep the first `remaining` non-terminal nodes (decision setup is more
  // useful than mid-flow considerations when overflowing) plus all terminal
  // nodes appended.
  return [...nonTerminal.slice(0, remaining), ...terminal];
}

export interface SecretarySchedulingBatchResult {
  decisions: SecretarySchedulingDecision[];
  scheduledCount: number;
  unscheduledCount: number;
  feedbackBySourceSkill: Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]>;
}

export interface SecretarySchedulingOptions {
  existingAgendaItems?: Array<Pick<SecretaryAgendaItem, 'startAt' | 'endAt' | 'lifecycleState' | 'title'>>;
  additionalBusyWindows?: SecretaryTimeWindow[];
  now?: string;
  /**
   * F24: hand an already-owned Training provider event to the replacement
   * agenda version in the same transaction that supersedes the prior row.
   * This prevents the cleanup loop from deleting an event now owned by vN+1.
   */
  providerMappingTransfer?: {
    providerEventId: string;
    providerSource: 'google' | 'outlook';
  };
}

export interface SecretarySchedulingPreemptionCandidate {
  agendaItemId: string;
  localWindow: SecretaryTimeWindow;
  liveWindow: SecretaryTimeWindow;
}

export interface SecretarySchedulingCapacityPlan {
  /** Full submit-time capacity. Stage 1 never removes a loser from this set. */
  hardBusyWindows: SecretaryTimeWindow[];
  /** Preview-only capacity after exact, safe preemption candidates are disregarded. */
  previewBusyWindows: SecretaryTimeWindow[];
  preemptionCandidates: SecretarySchedulingPreemptionCandidate[];
}

export interface SecretarySchedulingCapacityPlanInput {
  intent: SecretarySchedulingIntent;
  localAgendaItems: SecretaryAgendaItem[];
  existingAgendaItems?: SecretarySchedulingOptions['existingAgendaItems'];
  additionalBusyWindows?: SecretaryTimeWindow[];
  acceptedBusyWindows?: SecretaryTimeWindow[];
}

type SecretaryScheduleMode = 'persist' | 'preview';

type SecretaryInternalSchedulingDecision = SecretarySchedulingDecision & {
  previewPreemptedCount?: number;
  /** Durable Stage 2 feedback is emitted only after exact loser cleanup. */
  deferFeedback?: true;
};

type NormalizedWindow = {
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  label?: string;
};

type CandidateSlot = {
  startMs: number;
  endMs: number;
  durationMinutes: number;
  sourceWindow: NormalizedWindow;
};

const ACTIVE_BUSY_STATES = new Set<SecretaryAgendaLifecycleState>([
  // A proposed row with a concrete slot is a two-phase preemption reservation.
  // Provider sync deliberately excludes it until every exact cleanup edge is
  // satisfied; local scheduling must nevertheless keep the slot hard-busy.
  'proposed',
  'scheduled',
  'synced',
  'reflowed',
  'compressed',
  'failed_sync',
]);

const NON_REUSABLE_AGENDA_LIFECYCLE_STATES = new Set<SecretaryAgendaLifecycleState>([
  'canceled',
  'superseded',
  'unscheduled',
]);

const VALID_SOURCE_SKILLS = new Set<SecretarySourceSkill>([
  'secretary',
  'training',
  'cooking',
  'finance',
  'content',
]);

const SKILL_PRIORITY_WEIGHT: Record<SecretarySourceSkill, number> = {
  finance: 16,
  training: 12,
  secretary: 10,
  cooking: 8,
  content: 6,
};

/**
 * Compute the canonical v1 arbitration rank used by both batch ordering and
 * persisted agenda metadata. Keep this function pure and version-bump before
 * changing any weight or tie-break rule.
 */
export function computeSecretaryIntentArbitrationRank(
  intent: SecretarySchedulingIntent,
): SecretaryIntentArbitrationRank {
  const base = typeof intent.priority === 'number'
    ? intent.priority
    : intent.priority === 'urgent'
      ? 100
      : intent.priority === 'high'
        ? 70
        : intent.priority === 'low'
          ? 20
          : 45;
  const deadlineMs = intent.deadline ? Date.parse(intent.deadline) : Number.NaN;
  const deadlineAt = Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null;
  const deadlineBoost = deadlineAt ? 18 : 0;
  const fixedBoost = intent.flexibility === 'fixed' ? 8 : 0;
  const phaseBoost = phaseBoostFor(intent.sourceSkill, intent.goalPhase ?? null);
  return {
    score: base + SKILL_PRIORITY_WEIGHT[intent.sourceSkill] + deadlineBoost + fixedBoost + phaseBoost,
    deadlineAt,
    flexibility: intent.flexibility ?? 'flexible',
    policyVersion: SECRETARY_ARBITRATION_RANK_POLICY_VERSION,
    tieBreakerIntentId: intent.intentId,
  };
}

/**
 * Guard for the later preemption planner. A row without a complete current
 * rank snapshot is legacy/unknown-policy state and must remain a hard block.
 */
export function hasCompleteSecretaryAgendaArbitrationMetadata(
  item: Pick<
    SecretaryAgendaItem,
    'arbitrationScore' | 'arbitrationDeadlineAt' | 'arbitrationFlexibility' | 'arbitrationPolicyVersion'
  >,
): boolean {
  return item.arbitrationScore != null
    && Number.isFinite(item.arbitrationScore)
    && item.arbitrationFlexibility != null
    && ['fixed', 'flexible', 'compressible', 'splittable'].includes(item.arbitrationFlexibility)
    && item.arbitrationPolicyVersion === SECRETARY_ARBITRATION_RANK_POLICY_VERSION;
}

function assertSecretaryAgendaSchemaReady(db = getDb()): void {
  const columns = db.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const missing = ['decision_explanation', 'reasoning_trail_json'].filter((column) => !names.has(column));
  if (missing.length > 0) {
    throw new Error(`SECRETARY_AGENDA_SCHEMA_MISSING:${missing.join(',')}`);
  }
}

export function submitSecretarySchedulingIntent(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions = {},
): SecretarySchedulingDecision {
  assertSecretaryTenantScope(intent);
  assertSecretaryAgendaSchemaReady();
  const decision = scheduleOne(intent, options, []);
  // W-B: emit feedback to registered consumers. Synchronous emit; bad
  // consumers are caught inside the bus so arbitration is never blocked.
  if (!decision.deferFeedback) emitSecretaryFeedback(decision.feedback);
  return decision;
}

/**
 * Non-persisting probe (C1 workstream). Lets callers ask Secretary
 * "what slot would you assign this intent?" without writing an agenda
 * item. Used by Training to detect conflicts BEFORE the user sees a
 * Decision Center card.
 *
 * Returns a synthetic decision shape with `noPersist: true` marker. The
 * caller MUST follow up with `submitSecretarySchedulingIntent(intent)`
 * to actually persist. Preview ≠ submit can drift if a concurrent write
 * lands between the calls — that's acceptable because preview is a HINT,
 * not a contract.
 *
 * Plan reference: Wave 1 workstream C1.
 */
export function previewSecretarySchedulingIntent(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions = {},
): SecretarySchedulingPreview {
  assertSecretaryTenantScope(intent);
  assertSecretaryAgendaSchemaReady();
  // Use the canonical scheduleOne machinery in read-only preview mode. The
  // decision is fully shaped (including feedback/trail), but no agenda row is
  // inserted, superseded, or canceled. Preview is a hint; submit remains the
  // contract.
  const decision = scheduleOne(intent, options, [], 'preview');
  return {
    status: decision.status,
    recommendedSlot: decision.selectedSlot,
    alternatives: decision.alternativeSlots,
    reasonCodes: decision.reasonCodes,
    confidence: decision.confidence,
    wouldReflow: decision.status === 'reflowed',
    wouldCompress: decision.status === 'compressed',
    ...(decision.previewPreemptedCount && decision.previewPreemptedCount > 0 ? {
      wouldPreempt: true as const,
      preemptedCount: decision.previewPreemptedCount,
    } : {}),
    // W-E: preview returns the trail so callers (Training, Decision Center)
    // can render "if you pick this slot, here's why" copy without a submit.
    reasoningTrail: decision.reasoningTrail,
    noPersist: true,
  };
}

export interface SecretarySchedulingPreview {
  status: SecretarySchedulingDecisionStatus;
  recommendedSlot: SecretaryTimeWindow | null;
  alternatives: SecretaryTimeWindow[];
  reasonCodes: SecretaryReasonCode[];
  confidence: 'low' | 'medium' | 'high';
  wouldReflow: boolean;
  wouldCompress: boolean;
  /** Stage 1 dry-run disclosure; present only when the recommended slot uses a safely identified loser. */
  wouldPreempt?: true;
  /** Count only; agenda/provider identifiers never cross the preview boundary. */
  preemptedCount?: number;
  /**
   * W-E reasoning trail attached to the preview decision. Same shape +
   * cap as a real submit; useful for "what would Secretary explain?"
   * before the user accepts a Decision Center card.
   */
  reasoningTrail: ReasoningTrailNode[];
  /** Marker — always `true` for preview returns; absent on submit results. */
  noPersist: true;
}

export function arbitrateSecretarySchedulingIntents(
  intents: SecretarySchedulingIntent[],
  options: SecretarySchedulingOptions = {},
): SecretarySchedulingBatchResult {
  for (const intent of intents) assertSecretaryTenantScope(intent);
  assertSecretaryAgendaSchemaReady();
  const ordered = [...intents].sort(compareIntentPriority);
  const acceptedBusyWindows: SecretaryTimeWindow[] = [];
  const decisions: SecretaryInternalSchedulingDecision[] = [];

  for (const intent of ordered) {
    const decision = scheduleOne(intent, options, acceptedBusyWindows);
    decisions.push(decision);
    if (decision.selectedSlot && ['scheduled', 'reflowed', 'compressed'].includes(decision.status)) {
      acceptedBusyWindows.push(decision.selectedSlot);
    }
    // W-B: emit feedback per decision (not at end of batch) so consumers
    // can react incrementally if needed.
    if (!decision.deferFeedback) emitSecretaryFeedback(decision.feedback);
  }

  // A two-phase winner is a durable reservation, not yet source feedback.
  // Its finalizer emits the authoritative event after every exact edge.
  const feedbackBySourceSkill = buildFeedbackBySourceSkill(
    decisions.filter((decision) => !decision.deferFeedback),
  );
  return {
    decisions,
    scheduledCount: decisions.filter((decision) => ['scheduled', 'reflowed', 'compressed'].includes(decision.status)).length,
    unscheduledCount: decisions.filter((decision) => ['unscheduled', 'deferred', 'rejected', 'needs_more_context'].includes(decision.status)).length,
    feedbackBySourceSkill,
  };
}

export function listSecretaryAgendaItems(scope: {
  ownerUserId: number;
  tenantId: string | number;
  includeInactive?: boolean;
}): SecretaryAgendaItem[] {
  const db = getDb();
  assertSecretaryAgendaSchemaReady(db);
  const tenantId = normalizeTenantId(scope.tenantId);
  const rows = scope.includeInactive
    ? db.prepare(`
        SELECT * FROM secretary_agenda_items
        WHERE owner_user_id = ? AND tenant_id = ?
        ORDER BY COALESCE(start_at, updated_at) ASC, version ASC
      `).all(scope.ownerUserId, tenantId)
    : db.prepare(`
        SELECT * FROM secretary_agenda_items
        WHERE owner_user_id = ? AND tenant_id = ?
          AND lifecycle_state NOT IN ('canceled', 'superseded', 'completed')
        ORDER BY COALESCE(start_at, updated_at) ASC, version ASC
      `).all(scope.ownerUserId, tenantId);
  return rows.map(rowToAgendaItem);
}

export function getSecretaryAgendaItemById(scope: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
}): SecretaryAgendaItem | null {
  assertSecretaryAgendaSchemaReady();
  const row = getDb().prepare(`
    SELECT *
    FROM secretary_agenda_items
    WHERE agenda_item_id = ?
      AND owner_user_id = ?
      AND tenant_id = ?
  `).get(scope.agendaItemId, scope.ownerUserId, normalizeTenantId(scope.tenantId));
  return row ? rowToAgendaItem(row) : null;
}

export function markSecretaryAgendaProviderSyncSatisfied(scope: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
  providerEventId: string;
  providerSource: 'google' | 'outlook';
  now?: string;
}): SecretaryAgendaItem | null {
  const nowIso = normalizeNow(scope.now);
  assertSecretaryAgendaSchemaReady();
  const hasProviderTarget = secretaryAgendaProviderTargetColumnExists();
  getDb().prepare(`
    UPDATE secretary_agenda_items
       SET provider_event_id = ?,
           provider_source = ?,
           ${hasProviderTarget ? 'provider_target = COALESCE(provider_target, ?),' : ''}
           provider_sync_state = 'synced',
           lifecycle_state = CASE
             WHEN lifecycle_state IN ('scheduled', 'reflowed', 'compressed', 'synced', 'failed_sync')
             THEN 'synced'
             ELSE lifecycle_state
           END,
           updated_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
       ${hasProviderTarget ? 'AND (provider_target IS NULL OR provider_target = ?)' : ''}
  `).run(
    scope.providerEventId,
    scope.providerSource,
    ...(hasProviderTarget ? [scope.providerSource] : []),
    nowIso,
    scope.agendaItemId,
    scope.ownerUserId,
    normalizeTenantId(scope.tenantId),
    ...(hasProviderTarget ? [scope.providerSource] : []),
  );
  const updated = getSecretaryAgendaItemById(scope);
  if (updated) {
    recordAgendaProviderSyncFingerprint(updated, scope.providerSource, nowIso);
  }
  return getSecretaryAgendaItemById(scope);
}

export function markSecretaryAgendaProviderCleanupRequired(scope: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
  providerEventId?: string | null;
  providerSource?: 'google' | 'outlook' | null;
  providerSyncState?: Extract<SecretaryProviderSyncState, 'create_failed' | 'delete_failed' | 'readback_failed' | 'deleted'>;
  lifecycleState?: Extract<SecretaryAgendaLifecycleState, 'canceled' | 'unscheduled' | 'superseded' | 'deferred'>;
  reason?: string | null;
  clearProviderMapping?: boolean;
  now?: string;
}): SecretaryAgendaItem | null {
  const nowIso = normalizeNow(scope.now);
  const clearProviderMapping = scope.clearProviderMapping === true;
  const providerSyncState = scope.providerSyncState ?? 'deleted';
  const lifecycleState = scope.lifecycleState ?? 'unscheduled';
  assertSecretaryAgendaSchemaReady();
  getDb().prepare(`
    UPDATE secretary_agenda_items
       SET provider_event_id = CASE
             WHEN ? THEN NULL
             ELSE COALESCE(?, provider_event_id)
           END,
           provider_source = CASE
             WHEN ? THEN NULL
             ELSE COALESCE(?, provider_source)
           END,
           provider_sync_state = ?,
           lifecycle_state = ?,
           cancellation_reason = COALESCE(?, cancellation_reason),
           updated_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
       AND lifecycle_state NOT IN ('completed')
  `).run(
    clearProviderMapping ? 1 : 0,
    scope.providerEventId ?? null,
    clearProviderMapping ? 1 : 0,
    scope.providerSource ?? null,
    providerSyncState,
    lifecycleState,
    scope.reason ?? null,
    nowIso,
    scope.agendaItemId,
    scope.ownerUserId,
    normalizeTenantId(scope.tenantId),
  );
  cancelRemindersForAgendaItem(scope.ownerUserId, scope.agendaItemId, scope.tenantId);
  return getSecretaryAgendaItemById(scope);
}

export function cancelSecretaryAgendaItem(scope: {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string | number;
  reason?: string | null;
  now?: string;
}): SecretaryAgendaItem | null {
  const nowIso = normalizeNow(scope.now);
  assertSecretaryAgendaSchemaReady();
  const db = getDb();
  const tenantId = normalizeTenantId(scope.tenantId);
  const cancel = db.transaction(() => {
    db.prepare(`
      UPDATE secretary_agenda_items
      SET lifecycle_state = 'canceled',
          cancellation_reason = COALESCE(?, cancellation_reason),
          updated_at = ?
      WHERE agenda_item_id = ?
        AND owner_user_id = ?
        AND tenant_id = ?
        AND lifecycle_state NOT IN ('canceled', 'completed')
    `).run(
      scope.reason ?? null,
      nowIso,
      scope.agendaItemId,
      scope.ownerUserId,
      tenantId,
    );
    const row = db.prepare(`
      SELECT version FROM secretary_agenda_items
       WHERE agenda_item_id = ? AND owner_user_id = ? AND tenant_id = ?
    `).get(scope.agendaItemId, scope.ownerUserId, tenantId) as { version: number } | undefined;
    if (row) {
      requestSecretaryPreemptionCancellation({
        agendaItemId: scope.agendaItemId,
        agendaVersion: Number(row.version),
        ownerUserId: scope.ownerUserId,
        tenantId,
        nowIso,
      }, db);
    }
  });
  cancel();
  cancelRemindersForAgendaItem(scope.ownerUserId, scope.agendaItemId, scope.tenantId);
  return getSecretaryAgendaItemById(scope);
}

function scheduleOne(
  intent: SecretarySchedulingIntent,
  options: SecretarySchedulingOptions,
  acceptedBusyWindows: SecretaryTimeWindow[],
  mode: SecretaryScheduleMode = 'persist',
): SecretaryInternalSchedulingDecision {
  const nowIso = normalizeNow(options.now);
  // W-E: collect reasoning breadcrumbs as we go. Privacy-safe — only
  // enum codes, slot ISO strings, and numeric weights/counts.
  const trail: ReasoningTrailNode[] = [];
  const validation = validateIntent(intent);
  if (validation.length > 0) {
    for (const code of validation) {
      trail.push({ kind: 'validation', reasonCode: code });
    }
    const validationStatus: SecretarySchedulingDecisionStatus =
      validation.includes('invalid_source_skill') || validation.includes('invalid_owner_scope')
        ? 'rejected'
        : 'needs_more_context';
    trail.push({ kind: validationStatus === 'rejected' ? 'rejected' : 'unscheduled' });
    return persistDecision({
      intent,
      nowIso,
      status: validationStatus,
      lifecycleState: validation.includes('invalid_source_skill') || validation.includes('invalid_owner_scope')
        ? 'unscheduled'
        : 'proposed',
      reasonCodes: validation,
      explanation: explainDecision(intent, validation.includes('invalid_source_skill') ? 'rejected' : 'needs_more_context', validation),
      selectedSlot: null,
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: downstreamFor(intent, validation.includes('missing_duration') ? 'needs_more_context' : 'rejected'),
      reasoningTrail: trail,
      persist: mode === 'persist',
      providerMappingTransfer: options.providerMappingTransfer,
    });
  }

  const latest = findLatestAgendaItemForIntent(intent);
  const sourceShapeHash = computeSourceShapeHash(intent);
  if (mode === 'persist' && secretaryAgendaPreemptionSchemaReady()) {
    const replay = findSecretaryPreemptionWinnerReplay({
      ownerUserId: intent.ownerUserId,
      tenantId: normalizeTenantId(intent.tenantId),
      sourceSkill: intent.sourceSkill,
      sourceIntentId: intent.intentId,
      sourceShapeHash,
    });
    if (replay) {
      const replayedAgendaItem = findAgendaItemById(replay.agendaItemId);
      if (!replayedAgendaItem || replayedAgendaItem.version !== replay.agendaVersion) {
        throw new Error('SECRETARY_PREEMPTION_REPLAY_ROW_MISSING');
      }
      const replayStatus = replayedAgendaItem.decisionAction;
      const replayReasons = filterKnownReasonCodes(replayedAgendaItem.decisionReasonCodes);
      return {
        ...decisionFromExisting(
          intent,
          replayedAgendaItem,
          replayStatus,
          replayReasons,
          replayedAgendaItem.decisionExplanation ?? explainDecision(intent, replayStatus, replayReasons),
          [],
          downstreamFor(intent, replayStatus),
          replayedAgendaItem.reasoningTrail,
        ),
        deferFeedback: true,
      };
    }
  }
  const duration = Math.max(1, Math.round(Number(intent.requestedDurationMinutes)));
  const localAgendaItems = listSecretaryAgendaItems({
    ownerUserId: intent.ownerUserId,
    tenantId: intent.tenantId,
  });
  const capacityPlan = planSecretarySchedulingCapacity({
    intent,
    localAgendaItems,
    existingAgendaItems: options.existingAgendaItems,
    additionalBusyWindows: options.additionalBusyWindows,
    acceptedBusyWindows,
  });
  const durablePreemptionEnabled = mode === 'persist'
    && intent.providerTarget != null
    && secretaryAgendaPreemptionSchemaReady();
  const busyWindows = normalizeWindows(
    mode === 'preview' || durablePreemptionEnabled
      ? capacityPlan.previewBusyWindows
      : capacityPlan.hardBusyWindows,
  );
  const candidateWindows = normalizeWindows(intent.preferredWindows ?? []);
  // W-E: priority weight + phase boost are inputs to arbitration ordering;
  // log them so users can see "why this won over the cooking intent".
  trail.push({
    kind: 'priority',
    weight: SKILL_PRIORITY_WEIGHT[intent.sourceSkill],
    detail: `skill:${intent.sourceSkill}`,
  });
  const phaseBoost = phaseBoostFor(intent.sourceSkill, intent.goalPhase ?? null);
  if (phaseBoost !== 0) {
    trail.push({
      kind: 'phase_boost',
      weight: phaseBoost,
      detail: `phase:${intent.goalPhase ?? 'none'}`,
    });
  }
  trail.push({ kind: 'candidate', detail: `cand:${candidateWindows.length}` });
  if (busyWindows.length > 0) {
    trail.push({ kind: 'busy_block', detail: `busy:${busyWindows.length}` });
  }
  const exactSlot = findFirstAvailableSlot(candidateWindows, busyWindows, duration);

  if (exactSlot) {
    const reflowed = latest
      && isReusableAgendaItemForIntent(latest)
      && latest.startAt
      && latest.endAt
      && (Date.parse(latest.startAt) !== exactSlot.startMs || Date.parse(latest.endAt) !== exactSlot.endMs);
    const status: SecretarySchedulingDecisionStatus = reflowed ? 'reflowed' : 'scheduled';
    const usedPreemptionCandidates = mode === 'preview' || durablePreemptionEnabled
      ? capacityPlan.preemptionCandidates.filter((candidate) => preemptionCandidateOverlapsSlot(candidate, exactSlot))
      : [];
    const reasonCodes: SecretaryReasonCode[] = reflowed
      ? ['reflowed_to_available_window', ...slotReasonCodes(intent, exactSlot)]
      : ['scheduled_in_available_window', ...slotReasonCodes(intent, exactSlot)];
    if (usedPreemptionCandidates.length > 0) {
      reasonCodes.push(mode === 'preview' ? 'priority_preemption_candidate' : 'priority_preemption_applied');
      trail.push({
        kind: 'priority',
        reasonCode: mode === 'preview' ? 'priority_preemption_candidate' : 'priority_preemption_applied',
        detail: `preempt:${usedPreemptionCandidates.length}`,
      });
    }

    const selectedSlot = slotToWindow(exactSlot);
    if (reflowed) {
      trail.push({ kind: 'reflow', reasonCode: 'reflowed_to_available_window' });
    }
    // Capture alternatives as `considered` before the `chosen` marker so the
    // cap-policy preserves the chosen tail.
    const alternatives = candidateWindowsToAlternatives(candidateWindows, exactSlot);
    for (const alt of alternatives) {
      trail.push({ kind: 'considered', slot: { start: alt.start, end: alt.end } });
    }
    trail.push({
      kind: 'chosen',
      slot: { start: selectedSlot.start, end: selectedSlot.end },
      reasonCode: reflowed ? 'reflowed_to_available_window' : 'scheduled_in_available_window',
      detail: `dur:${minutesBetween(selectedSlot.start, selectedSlot.end)}`,
    });

    const decision = persistDecision({
      intent,
      nowIso,
      status,
      lifecycleState: reflowed ? 'reflowed' : 'scheduled',
      reasonCodes,
      explanation: explainDecision(intent, status, reasonCodes),
      selectedSlot,
      alternativeSlots: alternatives,
      conflicts: conflictSummaries(busyWindows),
      downstreamImplications: downstreamFor(intent, status),
      latest,
      sourceShapeHash,
      reasoningTrail: trail,
      persist: mode === 'persist',
      providerMappingTransfer: options.providerMappingTransfer,
      preemptionCandidates: mode === 'persist' ? usedPreemptionCandidates : [],
    });
    return usedPreemptionCandidates.length > 0
      ? { ...decision, previewPreemptedCount: usedPreemptionCandidates.length }
      : decision;
  }

  if ((intent.flexibility ?? 'flexible') === 'compressible') {
    const minimumDuration = Math.max(
      15,
      Math.min(duration, Math.round(Number(intent.minimumDurationMinutes ?? Math.ceil(duration * 0.6)))),
    );
    const compressedSlot = findLargestAvailableSlot(candidateWindows, busyWindows, minimumDuration, duration);
    if (compressedSlot) {
      const usedPreemptionCandidates = mode === 'preview' || durablePreemptionEnabled
        ? capacityPlan.preemptionCandidates.filter((candidate) => preemptionCandidateOverlapsSlot(candidate, compressedSlot))
        : [];
      const reasonCodes: SecretaryReasonCode[] = ['compressed_to_fit_capacity', ...slotReasonCodes(intent, compressedSlot)];
      if (usedPreemptionCandidates.length > 0) {
        reasonCodes.push(mode === 'preview' ? 'priority_preemption_candidate' : 'priority_preemption_applied');
        trail.push({
          kind: 'priority',
          reasonCode: mode === 'preview' ? 'priority_preemption_candidate' : 'priority_preemption_applied',
          detail: `preempt:${usedPreemptionCandidates.length}`,
        });
      }
      const selectedSlot = slotToWindow(compressedSlot);
      trail.push({ kind: 'compression', reasonCode: 'compressed_to_fit_capacity', detail: `min:${minimumDuration}` });
      const alternatives = candidateWindowsToAlternatives(candidateWindows, compressedSlot);
      for (const alt of alternatives) {
        trail.push({ kind: 'considered', slot: { start: alt.start, end: alt.end } });
      }
      trail.push({
        kind: 'chosen',
        slot: { start: selectedSlot.start, end: selectedSlot.end },
        reasonCode: 'compressed_to_fit_capacity',
        detail: `dur:${minutesBetween(selectedSlot.start, selectedSlot.end)}`,
      });
      const decision = persistDecision({
        intent,
        nowIso,
        status: 'compressed',
        lifecycleState: 'compressed',
        reasonCodes,
        explanation: explainDecision(intent, 'compressed', reasonCodes),
        selectedSlot,
        alternativeSlots: alternatives,
        conflicts: conflictSummaries(busyWindows),
        downstreamImplications: downstreamFor(intent, 'compressed'),
        latest,
        sourceShapeHash,
        reasoningTrail: trail,
        persist: mode === 'persist',
        providerMappingTransfer: options.providerMappingTransfer,
        preemptionCandidates: mode === 'persist' ? usedPreemptionCandidates : [],
      });
      return usedPreemptionCandidates.length > 0
        ? { ...decision, previewPreemptedCount: usedPreemptionCandidates.length }
        : decision;
    }
  }

  const hasFutureDeadline = hasDeadlineAfterWindows(intent.deadline, candidateWindows);
  const status: SecretarySchedulingDecisionStatus = hasFutureDeadline && (intent.flexibility ?? 'flexible') === 'flexible'
    ? 'deferred'
    : 'unscheduled';
  const reasonCodes: SecretaryReasonCode[] = [
    status === 'deferred' ? 'deferred_due_to_current_capacity' : 'unscheduled_no_capacity',
    candidateWindows.length === 0 ? 'missing_availability' : 'no_valid_slot',
    ...priorityReasonCodes(intent),
  ];
  trail.push({
    kind: status === 'deferred' ? 'deferred' : 'unscheduled',
    reasonCode: status === 'deferred' ? 'deferred_due_to_current_capacity' : 'unscheduled_no_capacity',
  });

  return persistDecision({
    intent,
    nowIso,
    status,
    lifecycleState: status,
    reasonCodes,
    explanation: explainDecision(intent, status, reasonCodes),
    selectedSlot: null,
    alternativeSlots: candidateWindows.map((window) => ({ start: window.start, end: window.end, label: window.label })),
    conflicts: conflictSummaries(busyWindows),
    downstreamImplications: downstreamFor(intent, status),
    latest,
    sourceShapeHash,
    reasoningTrail: trail,
    persist: mode === 'persist',
    providerMappingTransfer: options.providerMappingTransfer,
  });
}

function persistDecision(input: {
  intent: SecretarySchedulingIntent;
  nowIso: string;
  status: SecretarySchedulingDecisionStatus;
  lifecycleState: SecretaryAgendaLifecycleState;
  reasonCodes: SecretaryReasonCode[];
  explanation: string;
  selectedSlot: SecretaryTimeWindow | null;
  alternativeSlots: SecretaryTimeWindow[];
  conflicts: string[];
  downstreamImplications: string[];
  latest?: SecretaryAgendaItem | null;
  sourceShapeHash?: string;
  /**
   * W-E: optional reasoning trail collected by `scheduleOne`. Capped via
   * `capReasoningTrail` before persistence so row width stays bounded.
   */
  reasoningTrail?: ReasoningTrailNode[];
  /**
   * C1 preview mode: build the same decision shape without writing or
   * superseding `secretary_agenda_items`.
   */
  persist?: boolean;
  providerMappingTransfer?: SecretarySchedulingOptions['providerMappingTransfer'];
  preemptionCandidates?: SecretarySchedulingPreemptionCandidate[];
}): SecretaryInternalSchedulingDecision {
  const db = getDb();
  const tenantId = normalizeTenantId(input.intent.tenantId);
  const latest = input.latest ?? findLatestAgendaItemForIntent(input.intent);
  const sourceShapeHash = input.sourceShapeHash ?? computeSourceShapeHash(input.intent);
  const cappedTrail = capReasoningTrail(input.reasoningTrail ?? []);
  const shouldPersist = input.persist !== false;

  if (
    shouldPersist
    && latest
    && latest.sourceShapeHash === sourceShapeHash
    && isReusableAgendaItemForIntent(latest)
    && agendaSlotMatches(latest, input.selectedSlot)
  ) {
    return decisionFromExisting(
      input.intent, latest, input.status, input.reasonCodes, input.explanation,
      input.conflicts, input.downstreamImplications, cappedTrail,
    );
  }

  if (!shouldPersist) {
    return decisionFromPreview(input, sourceShapeHash, cappedTrail, latest);
  }

  if ((input.preemptionCandidates?.length ?? 0) > 0) {
    return persistPreemptiveDecision({
      ...input,
      latest,
      sourceShapeHash,
      reasoningTrail: cappedTrail,
      preemptionCandidates: input.preemptionCandidates!,
    });
  }

  const version = latest ? latest.version + 1 : 1;
  const agendaItemId = buildAgendaItemId(input.intent, version);
  const startAt = input.selectedSlot?.start ?? null;
  const endAt = input.selectedSlot?.end ?? null;
  const durationMinutes = input.selectedSlot
    ? minutesBetween(input.selectedSlot.start, input.selectedSlot.end)
    : input.intent.requestedDurationMinutes != null
      ? Math.round(Number(input.intent.requestedDurationMinutes))
      : null;
  const scheduledSegments = decisionScheduledSegments(input.selectedSlot, input.alternativeSlots);
  const reasoningTrailJson = cappedTrail.length > 0 ? JSON.stringify(cappedTrail) : null;
  const arbitrationRank = computeSecretaryIntentArbitrationRank(input.intent);
  const providerMappingTransfer = input.providerMappingTransfer;
  const providerTarget = input.intent.providerTarget ?? providerMappingTransfer?.providerSource ?? null;
  const hasProviderTargetColumns = secretaryAgendaProviderTargetColumnExists(db);
  if (
    latest?.providerTarget
    && providerTarget
    && latest.providerTarget !== providerTarget
    && hasUnsafePriorProviderTargetVersion(input.intent, providerTarget, db)
  ) {
    // A logical Secretary intent is single-provider. Switching the target by
    // creating a newer agenda version can leave the older provider event live
    // and authorize a second create on another provider.
    throw new Error('SECRETARY_PROVIDER_TARGET_IMMUTABLE');
  }
  if (providerMappingTransfer) {
    const transferHasSafeDecision = Boolean(
      input.selectedSlot
      && ['scheduled', 'reflowed', 'compressed'].includes(input.status)
      && (input.intent.preferredWindows ?? []).some((window) =>
        Date.parse(window.start) === Date.parse(input.selectedSlot!.start)
        && Date.parse(window.end) === Date.parse(input.selectedSlot!.end),
      ),
    );
    // Mapping transfer happens before the provider PATCH. Never move the live
    // id onto an unscheduled/alternate agenda row: its cleanup worker could
    // delete the still-canonical event while Training is retrying reflow.
    if (!transferHasSafeDecision) {
      throw new Error('SECRETARY_PROVIDER_MAPPING_TRANSFER_UNSAFE_DECISION');
    }
    if (input.intent.sourceSkill !== 'training'
        || (providerTarget != null && providerTarget !== providerMappingTransfer.providerSource)
        || (latest?.providerEventId != null
          && latest.providerEventId !== providerMappingTransfer.providerEventId)
        || (latest?.providerSource != null
          && latest.providerSource !== providerMappingTransfer.providerSource)) {
      throw new Error('SECRETARY_PROVIDER_MAPPING_TRANSFER_MISMATCH');
    }
  }

  const writeAgendaItem = db.transaction(() => {
    const adoptedMappings = providerMappingTransfer
      ? resolveScopedTrainingProviderMappingAdoption({
        intent: input.intent,
        latest,
        providerEventId: providerMappingTransfer.providerEventId,
        providerSource: providerMappingTransfer.providerSource,
        nowIso: input.nowIso,
      }, db)
      : [];
    const adoptedAgendaIds = new Set<string>();
    for (const adopted of adoptedMappings) {
      const cleared = db.prepare(`
        UPDATE secretary_agenda_items
           SET lifecycle_state = CASE
                 WHEN lifecycle_state IN (
                   'proposed', 'scheduled', 'synced', 'reflowed',
                   'compressed', 'failed_sync'
                 ) THEN 'superseded'
                 ELSE lifecycle_state
               END,
               provider_sync_state = 'deleted',
               provider_event_id = NULL,
               provider_source = NULL,
               superseded_by_agenda_item_id = ?,
               updated_at = ?
         WHERE agenda_item_id = ?
           AND version = ?
           AND owner_user_id = ?
           AND tenant_id = ?
           AND source_skill = 'training'
           AND provider_event_id = ?
           AND provider_source = ?
      `).run(
        agendaItemId,
        input.nowIso,
        adopted.agendaItemId,
        adopted.version,
        input.intent.ownerUserId,
        tenantId,
        providerMappingTransfer!.providerEventId,
        providerMappingTransfer!.providerSource,
      );
      if (cleared.changes !== 1) {
        throw new Error('SECRETARY_PROVIDER_MAPPING_TRANSFER_STALE');
      }
      adoptedAgendaIds.add(adopted.agendaItemId);
      cancelRemindersForAgendaItem(
        input.intent.ownerUserId,
        adopted.agendaItemId,
        input.intent.tenantId,
      );
    }

    if (latest && latest.lifecycleState !== 'superseded') {
      db.prepare(`
        UPDATE secretary_agenda_items
        SET lifecycle_state = 'superseded',
            provider_sync_state = CASE
              WHEN ? = 1 THEN 'deleted'
              WHEN provider_sync_state = 'not_synced' THEN 'not_synced'
              ELSE provider_sync_state
            END,
            provider_event_id = CASE WHEN ? = 1 THEN NULL ELSE provider_event_id END,
            provider_source = CASE WHEN ? = 1 THEN NULL ELSE provider_source END,
            superseded_by_agenda_item_id = ?,
            updated_at = ?
        WHERE agenda_item_id = ?
      `).run(
        providerMappingTransfer ? 1 : 0,
        providerMappingTransfer ? 1 : 0,
        providerMappingTransfer ? 1 : 0,
        agendaItemId,
        input.nowIso,
        latest.agendaItemId,
      );
      if (!adoptedAgendaIds.has(latest.agendaItemId)) {
        cancelRemindersForAgendaItem(input.intent.ownerUserId, latest.agendaItemId, input.intent.tenantId);
      }
    }

    db.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id,
        lifecycle_state, provider_sync_state, provider_event_id, provider_source,
        version, title, start_at, end_at, duration_minutes, decision_action,
        decision_reason_codes_json, decision_explanation, source_shape_hash, scheduled_segments_json,
        cancellation_reason, superseded_by_agenda_item_id, created_at, updated_at,
        completed_at, source_created_at, source_updated_at, reasoning_trail_json
        ${hasProviderTargetColumns
          ? ', provider_target, provider_sync_failure_disposition, provider_sync_retry_after_at'
          : ''}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_synced', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?
        ${hasProviderTargetColumns ? ', ?, NULL, NULL' : ''})
    `).run(
      agendaItemId,
      input.intent.intentId,
      input.intent.sourceSkill,
      input.intent.sourceAction ?? null,
      input.intent.action ?? defaultActionForStatus(input.status),
      input.intent.sourceEntityId != null ? String(input.intent.sourceEntityId) : null,
      input.intent.sourceEntityType ?? null,
      input.intent.ownerUserId,
      tenantId,
      input.lifecycleState,
      providerMappingTransfer?.providerEventId ?? null,
      providerMappingTransfer?.providerSource ?? null,
      version,
      input.intent.title.trim(),
      startAt,
      endAt,
      durationMinutes,
      input.status,
      JSON.stringify(input.reasonCodes),
      input.explanation,
      sourceShapeHash,
      JSON.stringify(scheduledSegments),
      input.nowIso,
      input.nowIso,
      input.intent.createdAt ?? null,
      input.intent.updatedAt ?? null,
      reasoningTrailJson,
      ...(hasProviderTargetColumns ? [providerTarget] : []),
    );

    // The pinned target is inserted with the agenda row when migration 281 is
    // present. Migration 282's provider-source trigger deliberately rejects a
    // transient source-without-target row, including mapping-transfer paths.

    if (secretaryAgendaArbitrationMetadataColumnsExist(db)) {
      db.prepare(`
        UPDATE secretary_agenda_items
           SET arbitration_score = ?,
               arbitration_deadline_at = ?,
               arbitration_flexibility = ?,
               arbitration_policy_version = ?
         WHERE agenda_item_id = ?
      `).run(
        Number.isFinite(arbitrationRank.score) ? arbitrationRank.score : null,
        arbitrationRank.deadlineAt,
        arbitrationRank.flexibility,
        arbitrationRank.policyVersion,
        agendaItemId,
      );
    }

    if (input.intent.sourceSkill === 'training') {
      // F23: the agenda version and its durable Training feedback request are
      // one atomic graph. event_outbox requires a positive numeric tenant;
      // this repo's authenticated user partition is ownerUserId, while the
      // exact legacy-compatible Secretary tenant stays in the payload and is
      // revalidated against the agenda row by the direct-effect consumer.
      emitDomainEvent({
        tenantId: input.intent.ownerUserId,
        userId: input.intent.ownerUserId,
        sourceSkill: 'secretary',
        eventType: TRAINING_SECRETARY_FEEDBACK_EVENT_TYPE,
        entityType: 'secretary_agenda_item',
        entityId: agendaItemId,
        entityVersion: version,
        schemaVersion: TRAINING_SECRETARY_FEEDBACK_SCHEMA_VERSION,
        payload: { agendaTenantId: tenantId },
        privacyClassification: 'health',
        idempotencyKey: `secretary.training_feedback.requested:${agendaItemId}:${version}`,
      }, db);
    } else if (['cooking', 'finance', 'content'].includes(input.intent.sourceSkill)) {
      // F23: generic source-skill feedback has the same atomicity and
      // monotonic-version guarantees as Training. The event is ID-only; its
      // consumer re-reads the exact scoped agenda row before projecting it.
      emitDomainEvent({
        tenantId: input.intent.ownerUserId,
        userId: input.intent.ownerUserId,
        sourceSkill: 'secretary',
        eventType: SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_TYPE,
        entityType: 'secretary_agenda_item',
        entityId: agendaItemId,
        entityVersion: version,
        eventVersion: SECRETARY_SOURCE_SKILL_FEEDBACK_EVENT_VERSION,
        schemaVersion: SECRETARY_SOURCE_SKILL_FEEDBACK_SCHEMA_VERSION,
        payload: { agendaTenantId: tenantId },
        privacyClassification: input.intent.sourceSkill === 'finance'
          ? 'financial'
          : input.intent.sourceSkill === 'content'
            ? 'private_content'
            : 'internal',
        idempotencyKey: `secretary.source_feedback.requested:${agendaItemId}:${version}`,
      }, db);
    }
  });

  writeAgendaItem();

  const agendaItem = findAgendaItemById(agendaItemId);
  if (!agendaItem) {
    logger.error({ agendaItemId }, 'Secretary agenda item insert succeeded but row could not be read back');
    throw new Error('Secretary agenda item insert read-back failed');
  }

  return {
    status: input.status,
    agendaItem,
    reasonCodes: input.reasonCodes,
    explanation: input.explanation,
    selectedSlot: input.selectedSlot,
    alternativeSlots: input.alternativeSlots,
    conflicts: input.conflicts,
    downstreamImplications: input.downstreamImplications,
    confidence: confidenceFor(input.status, input.reasonCodes),
    feedback: buildFeedback(input.intent, agendaItem, input.status, input.reasonCodes, input.downstreamImplications),
    reasoningTrail: cappedTrail,
  };
}

type SecretaryProviderMappingAdoptionRow = {
  agendaItemId: string;
  version: number;
  sourceIntentId: string;
  sourceEntityId: string | null;
  sourceEntityType: string | null;
};

/**
 * Authorizes a Training provider-id adoption without title/time inference.
 * Cross-version reuse requires an older active ownership row with the exact
 * stable identity key and material shape. A same-version sibling session can
 * never borrow the event sideways even if corrupt data duplicated its keys.
 */
function resolveScopedTrainingProviderMappingAdoption(input: {
  intent: SecretarySchedulingIntent;
  latest: SecretaryAgendaItem | null;
  providerEventId: string;
  providerSource: 'google' | 'outlook';
  nowIso: string;
}, db: Database.Database): SecretaryProviderMappingAdoptionRow[] {
  const tenantId = normalizeTenantId(input.intent.tenantId);
  const latestIsExact = Boolean(
    input.latest
    && input.latest.providerEventId === input.providerEventId
    && input.latest.providerSource === input.providerSource,
  );
  const scopedAuthoritySessionIds = new Set<number>();
  let scopedTrainingAuthority = false;
  let currentPlanId: number | null = null;

  const parsedIntent = parseTrainingAgendaSourceIntent(input.intent.intentId);
  const sourceEntityId = positiveTrainingScopeInteger(input.intent.sourceEntityId);
  const numericTenantId = positiveTrainingScopeInteger(tenantId);
  if (
    parsedIntent
    && sourceEntityId === parsedIntent.sessionId
    && input.intent.sourceEntityType === 'training_session'
    && numericTenantId != null
    && trainingProviderMappingAuthoritySchemaReady(db)
  ) {
    const current = db.prepare(`
      SELECT session.id AS sessionId,
             session.plan_id AS planId,
             session.calendar_event_id AS calendarEventId,
             session.calendar_source AS calendarSource,
             session.session_identity_key AS sessionIdentityKey,
             session.session_shape_hash AS sessionShapeHash,
             plan.plan_version AS planVersion
        FROM training_sessions AS session
        JOIN fitness_training_plans AS plan
          ON plan.id = session.plan_id
         AND plan.user_id = ?
         AND plan.tenant_id = ?
       WHERE session.id = ?
         AND session.plan_id = ?
         AND session.tenant_id = ?
         AND plan.plan_version = ?
       LIMIT 1
    `).get(
      input.intent.ownerUserId,
      numericTenantId,
      parsedIntent.sessionId,
      parsedIntent.planId,
      numericTenantId,
      parsedIntent.planVersion,
    ) as {
      sessionId: number;
      planId: number;
      calendarEventId: string | null;
      calendarSource: string | null;
      sessionIdentityKey: string | null;
      sessionShapeHash: string | null;
      planVersion: number;
    } | undefined;

    if (current) {
      currentPlanId = Number(current.planId);
      if (
        current.calendarEventId === input.providerEventId
        && current.calendarSource === input.providerSource
      ) {
        scopedTrainingAuthority = true;
        scopedAuthoritySessionIds.add(Number(current.sessionId));
      }
      const ownershipRows = db.prepare(`
        SELECT ownership.session_id AS sessionId
          FROM training_agenda_event_ownership AS ownership
         WHERE ownership.plan_id = ?
           AND ownership.plan_version <= ?
           AND ownership.user_id = ?
           AND ownership.tenant_id = ?
           AND ownership.calendar_event_id = ?
           AND ownership.calendar_source = ?
           AND ownership.status = 'active'
           AND ownership.session_id IS NOT NULL
           AND (
             ownership.session_id = ?
             OR (
               ownership.plan_version < ?
               AND length(trim(COALESCE(ownership.session_identity_key, ''))) > 0
               AND length(trim(COALESCE(ownership.session_shape_hash, ''))) > 0
               AND length(trim(COALESCE(?, ''))) > 0
               AND length(trim(COALESCE(?, ''))) > 0
               AND ownership.session_identity_key = ?
               AND ownership.session_shape_hash = ?
             )
           )
      `).all(
        current.planId,
        current.planVersion,
        input.intent.ownerUserId,
        numericTenantId,
        input.providerEventId,
        input.providerSource,
        current.sessionId,
        current.planVersion,
        current.sessionIdentityKey,
        current.sessionShapeHash,
        current.sessionIdentityKey,
        current.sessionShapeHash,
      ) as Array<{ sessionId: number }>;
      for (const ownership of ownershipRows) {
        const authorizedSessionId = Number(ownership.sessionId);
        if (Number.isSafeInteger(authorizedSessionId) && authorizedSessionId > 0) {
          scopedTrainingAuthority = true;
          scopedAuthoritySessionIds.add(authorizedSessionId);
        }
      }
    }
  }

  if (!latestIsExact && !scopedTrainingAuthority) {
    throw new Error('SECRETARY_PROVIDER_MAPPING_TRANSFER_MISMATCH');
  }

  const mappedRows = db.prepare(`
    SELECT agenda_item_id AS agendaItemId,
           version,
           source_skill AS sourceSkill,
           source_intent_id AS sourceIntentId,
           source_entity_id AS sourceEntityId,
           source_entity_type AS sourceEntityType
      FROM secretary_agenda_items
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND provider_event_id = ?
       AND provider_source = ?
     ORDER BY version ASC, agenda_item_id ASC
  `).all(
    input.intent.ownerUserId,
    tenantId,
    input.providerEventId,
    input.providerSource,
  ) as Array<SecretaryProviderMappingAdoptionRow & { sourceSkill: string }>;

  for (const mapped of mappedRows) {
    const isExactLatest = Boolean(
      latestIsExact
      && input.latest?.agendaItemId === mapped.agendaItemId
      && input.latest.version === Number(mapped.version)
      && input.latest.sourceIntentId === mapped.sourceIntentId,
    );
    if (mapped.sourceSkill !== 'training') {
      throw new Error('SECRETARY_PROVIDER_MAPPING_TRANSFER_MISMATCH');
    }
    if (isExactLatest) continue;
    const mappedIntent = parseTrainingAgendaSourceIntent(mapped.sourceIntentId);
    const mappedSessionId = positiveTrainingScopeInteger(mapped.sourceEntityId);
    if (
      !scopedTrainingAuthority
      || currentPlanId == null
      || !mappedIntent
      || mappedIntent.planId !== currentPlanId
      || mapped.sourceEntityType !== 'training_session'
      || mappedSessionId !== mappedIntent.sessionId
      || !scopedAuthoritySessionIds.has(mappedIntent.sessionId)
    ) {
      throw new Error('SECRETARY_PROVIDER_MAPPING_TRANSFER_MISMATCH');
    }
  }

  if (secretaryProviderMappingAdoptionHasUnsafeWork({
    ownerUserId: input.intent.ownerUserId,
    tenantId,
    providerEventId: input.providerEventId,
    providerSource: input.providerSource,
    nowIso: input.nowIso,
    mappedRows,
  }, db)) {
    throw new Error('SECRETARY_PROVIDER_MAPPING_TRANSFER_BUSY');
  }

  return mappedRows.map((row) => ({
    agendaItemId: row.agendaItemId,
    version: Number(row.version),
    sourceIntentId: row.sourceIntentId,
    sourceEntityId: row.sourceEntityId,
    sourceEntityType: row.sourceEntityType,
  }));
}

function secretaryProviderMappingAdoptionHasUnsafeWork(input: {
  ownerUserId: number;
  tenantId: string;
  providerEventId: string;
  providerSource: 'google' | 'outlook';
  nowIso: string;
  mappedRows: SecretaryProviderMappingAdoptionRow[];
}, db: Database.Database): boolean {
  if (sqliteTableExists('secretary_agenda_provider_effect_recovery', db)) {
    const pendingEffect = db.prepare(`
      SELECT 1
        FROM secretary_agenda_provider_effect_recovery
       WHERE owner_user_id = ?
         AND tenant_id = ?
         AND provider_source = ?
         AND provider_event_id = ?
         AND resolution_state = 'pending'
       LIMIT 1
    `).get(input.ownerUserId, input.tenantId, input.providerSource, input.providerEventId);
    if (pendingEffect) return true;
  }

  for (const mapped of input.mappedRows) {
    if (sqliteTableExists('secretary_agenda_provider_sync_claims', db)) {
      const liveClaim = db.prepare(`
        SELECT 1
          FROM secretary_agenda_provider_sync_claims
         WHERE owner_user_id = ?
           AND tenant_id = ?
           AND provider_source = ?
           AND agenda_item_id = ?
           AND agenda_version = ?
           AND datetime(lease_expires_at) > datetime(?)
         LIMIT 1
      `).get(
        input.ownerUserId,
        input.tenantId,
        input.providerSource,
        mapped.agendaItemId,
        mapped.version,
        input.nowIso,
      );
      if (liveClaim) return true;
    }

    if (sqliteTableExists('secretary_agenda_provider_create_reconciliation', db)) {
      const unresolvedCreate = db.prepare(`
        SELECT 1
          FROM secretary_agenda_provider_create_reconciliation
         WHERE owner_user_id = ?
           AND tenant_id = ?
           AND provider_source = ?
           AND source_skill = 'training'
           AND source_intent_id = ?
           AND agenda_item_id = ?
           AND agenda_version = ?
           AND resolution_state IN ('in_flight', 'unknown', 'known')
         LIMIT 1
      `).get(
        input.ownerUserId,
        input.tenantId,
        input.providerSource,
        mapped.sourceIntentId,
        mapped.agendaItemId,
        mapped.version,
      );
      if (unresolvedCreate) return true;
    }

    if (secretaryAgendaPreemptionSchemaReady(db)) {
      const lockedOperation = db.prepare(`
        SELECT 1
          FROM secretary_agenda_preemption_operations AS operation
         WHERE operation.owner_user_id = ?
           AND operation.tenant_id = ?
           AND operation.state NOT IN ('completed', 'canceled')
           AND (
             (operation.winner_agenda_item_id = ? AND operation.winner_agenda_version = ?)
             OR (
               operation.prior_winner_agenda_item_id = ?
               AND operation.prior_winner_agenda_version = ?
             )
           )
         LIMIT 1
      `).get(
        input.ownerUserId,
        input.tenantId,
        mapped.agendaItemId,
        mapped.version,
        mapped.agendaItemId,
        mapped.version,
      );
      if (lockedOperation) return true;

      // Completed/canceled operations are safe only after every dependency is
      // satisfied. Terminal graphs remain mutation-locked for manual repair.
      const unsettledDependency = db.prepare(`
        SELECT 1
          FROM secretary_agenda_preemption_dependencies AS dependency
          JOIN secretary_agenda_preemption_operations AS operation
            ON operation.operation_id = dependency.operation_id
           AND operation.owner_user_id = dependency.owner_user_id
           AND operation.tenant_id = dependency.tenant_id
         WHERE dependency.owner_user_id = ?
           AND dependency.tenant_id = ?
           AND dependency.state <> 'satisfied'
           AND (
             (dependency.loser_agenda_item_id = ? AND dependency.loser_agenda_version = ?)
             OR (
               dependency.loser_replacement_agenda_item_id = ?
               AND dependency.loser_replacement_version = ?
             )
           )
         LIMIT 1
      `).get(
        input.ownerUserId,
        input.tenantId,
        mapped.agendaItemId,
        mapped.version,
        mapped.agendaItemId,
        mapped.version,
      );
      if (unsettledDependency) return true;
    }
  }

  return false;
}

function parseTrainingAgendaSourceIntent(
  value: string,
): { planId: number; planVersion: number; sessionId: number } | null {
  const match = value.match(/^training:(\d+):(\d+):(\d+)$/);
  if (!match) return null;
  const planId = positiveTrainingScopeInteger(match[1]);
  const planVersion = positiveTrainingScopeInteger(match[2]);
  const sessionId = positiveTrainingScopeInteger(match[3]);
  return planId != null && planVersion != null && sessionId != null
    ? { planId, planVersion, sessionId }
    : null;
}

function positiveTrainingScopeInteger(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') return null;
  const numeric = typeof normalized === 'number' ? normalized : Number(normalized);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function trainingProviderMappingAuthoritySchemaReady(db: Database.Database): boolean {
  return sqliteTableExists('fitness_training_plans', db)
    && sqliteTableExists('training_sessions', db)
    && sqliteTableExists('training_agenda_event_ownership', db)
    && sqliteTableHasColumns('fitness_training_plans', ['id', 'user_id', 'tenant_id', 'plan_version'], db)
    && sqliteTableHasColumns('training_sessions', [
      'id', 'plan_id', 'tenant_id', 'calendar_event_id', 'calendar_source',
      'session_identity_key', 'session_shape_hash',
    ], db)
    && sqliteTableHasColumns('training_agenda_event_ownership', [
      'plan_id', 'plan_version', 'session_id', 'user_id', 'tenant_id',
      'calendar_event_id', 'calendar_source', 'status',
      'session_identity_key', 'session_shape_hash',
    ], db);
}

function sqliteTableExists(tableName: string, db: Database.Database): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = ?
     LIMIT 1
  `).get(tableName));
}

function sqliteTableHasColumns(
  tableName: string,
  requiredColumns: string[],
  db: Database.Database,
): boolean {
  if (!sqliteTableExists(tableName, db)) return false;
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => Boolean(name)),
  );
  return requiredColumns.every((column) => columns.has(column));
}

function hasUnsafePriorProviderTargetVersion(
  intent: SecretarySchedulingIntent,
  providerTarget: 'google' | 'outlook',
  db: Database.Database,
): boolean {
  const existingRows = db.prepare(`
    SELECT agenda_item_id AS agendaItemId,
           version,
           provider_event_id AS providerEventId,
           provider_source AS providerSource,
           provider_sync_state AS providerSyncState,
           lifecycle_state AS lifecycleState
      FROM secretary_agenda_items AS existing
     WHERE existing.owner_user_id = ?
       AND existing.tenant_id = ?
       AND existing.source_skill = ?
       AND existing.source_intent_id = ?
       AND existing.provider_target IS NOT NULL
       AND existing.provider_target <> ?
  `).all(
    intent.ownerUserId,
    normalizeTenantId(intent.tenantId),
    intent.sourceSkill,
    intent.intentId,
    providerTarget,
  ) as Array<{
    agendaItemId: string;
    version: number;
    providerEventId: string | null;
    providerSource: string | null;
    providerSyncState: string;
    lifecycleState: string;
  }>;
  const tenantId = normalizeTenantId(intent.tenantId);
  for (const existing of existingRows) {
    if (
      existing.providerEventId != null
      || existing.providerSource != null
      || existing.providerSyncState !== 'deleted'
      || !['canceled', 'superseded', 'unscheduled', 'deferred', 'completed'].includes(existing.lifecycleState)
    ) {
      return true;
    }
    if (sqliteTableExists('secretary_agenda_provider_sync_claims', db)) {
      const liveClaim = db.prepare(`
        SELECT 1 FROM secretary_agenda_provider_sync_claims
         WHERE owner_user_id = ? AND tenant_id = ?
           AND agenda_item_id = ? AND agenda_version = ?
           AND datetime(lease_expires_at) > datetime('now')
         LIMIT 1
      `).get(intent.ownerUserId, tenantId, existing.agendaItemId, existing.version);
      if (liveClaim) return true;
    }
    if (sqliteTableExists('secretary_agenda_provider_effect_recovery', db)) {
      const pendingEffect = db.prepare(`
        SELECT 1 FROM secretary_agenda_provider_effect_recovery
         WHERE owner_user_id = ? AND tenant_id = ?
           AND agenda_item_id = ? AND agenda_version = ?
           AND resolution_state = 'pending'
         LIMIT 1
      `).get(intent.ownerUserId, tenantId, existing.agendaItemId, existing.version);
      if (pendingEffect) return true;
    }
    if (secretaryAgendaPreemptionSchemaReady(db)) {
      const lockedGraph = db.prepare(`
        SELECT 1 FROM secretary_agenda_preemption_operations AS operation
         WHERE operation.owner_user_id = ? AND operation.tenant_id = ?
           AND operation.state NOT IN ('completed', 'canceled')
           AND (
             (operation.winner_agenda_item_id = ? AND operation.winner_agenda_version = ?)
             OR (operation.prior_winner_agenda_item_id = ? AND operation.prior_winner_agenda_version = ?)
           )
         LIMIT 1
      `).get(
        intent.ownerUserId,
        tenantId,
        existing.agendaItemId,
        existing.version,
        existing.agendaItemId,
        existing.version,
      );
      if (lockedGraph) return true;
    }
  }
  return false;
}

function persistPreemptiveDecision(input: {
  intent: SecretarySchedulingIntent;
  nowIso: string;
  status: SecretarySchedulingDecisionStatus;
  lifecycleState: SecretaryAgendaLifecycleState;
  reasonCodes: SecretaryReasonCode[];
  explanation: string;
  selectedSlot: SecretaryTimeWindow | null;
  alternativeSlots: SecretaryTimeWindow[];
  conflicts: string[];
  downstreamImplications: string[];
  latest: SecretaryAgendaItem | null;
  sourceShapeHash: string;
  reasoningTrail: ReasoningTrailNode[];
  preemptionCandidates: SecretarySchedulingPreemptionCandidate[];
}): SecretaryInternalSchedulingDecision {
  if (!input.selectedSlot
      || !['scheduled', 'reflowed', 'compressed'].includes(input.status)
      || !input.intent.providerTarget) {
    throw new Error('SECRETARY_PREEMPTION_INVALID_WINNER');
  }
  const loserEvidence: SecretaryPreemptionLoserEvidence[] = input.preemptionCandidates.map((candidate) => {
    const identity = candidate.liveWindow.providerIdentity;
    if (!identity) throw new Error('SECRETARY_PREEMPTION_PROVIDER_IDENTITY_MISSING');
    return {
      agendaItemId: candidate.agendaItemId,
      providerSource: identity.providerSource,
      providerEventId: identity.providerEventId,
    };
  });
  const rank = computeSecretaryIntentArbitrationRank(input.intent);
  const durationMinutes = minutesBetween(input.selectedSlot.start, input.selectedSlot.end);
  const graph = persistSecretaryPreemptionGraph({
    winner: {
      ownerUserId: input.intent.ownerUserId,
      tenantId: normalizeTenantId(input.intent.tenantId),
      sourceSkill: input.intent.sourceSkill,
      sourceIntentId: input.intent.intentId,
      sourceAction: input.intent.sourceAction ?? null,
      intentAction: input.intent.action ?? defaultActionForStatus(input.status),
      sourceEntityId: input.intent.sourceEntityId != null ? String(input.intent.sourceEntityId) : null,
      sourceEntityType: input.intent.sourceEntityType ?? null,
      providerTarget: input.intent.providerTarget,
      title: input.intent.title.trim(),
      startAt: input.selectedSlot.start,
      endAt: input.selectedSlot.end,
      durationMinutes,
      decisionAction: input.status as 'scheduled' | 'reflowed' | 'compressed',
      decisionReasonCodes: input.reasonCodes,
      decisionExplanation: input.explanation,
      sourceShapeHash: input.sourceShapeHash,
      scheduledSegments: decisionScheduledSegments(input.selectedSlot, input.alternativeSlots),
      sourceCreatedAt: input.intent.createdAt ?? null,
      sourceUpdatedAt: input.intent.updatedAt ?? null,
      reasoningTrail: input.reasoningTrail,
      rank,
    },
    losers: loserEvidence,
    nowIso: input.nowIso,
  });
  const agendaItem = findAgendaItemById(graph.winnerAgendaItemId);
  if (!agendaItem || agendaItem.version !== graph.winnerAgendaVersion) {
    throw new Error('SECRETARY_PREEMPTION_WINNER_READBACK_FAILED');
  }
  return {
    status: input.status,
    agendaItem,
    reasonCodes: input.reasonCodes,
    explanation: input.explanation,
    selectedSlot: input.selectedSlot,
    alternativeSlots: input.alternativeSlots,
    conflicts: input.conflicts,
    downstreamImplications: input.downstreamImplications,
    confidence: confidenceFor(input.status, input.reasonCodes),
    feedback: buildFeedback(
      input.intent,
      agendaItem,
      input.status,
      input.reasonCodes,
      input.downstreamImplications,
    ),
    reasoningTrail: input.reasoningTrail,
    deferFeedback: true,
  };
}

function decisionFromPreview(
  input: {
    intent: SecretarySchedulingIntent;
    nowIso: string;
    status: SecretarySchedulingDecisionStatus;
    lifecycleState: SecretaryAgendaLifecycleState;
    reasonCodes: SecretaryReasonCode[];
    explanation: string;
    selectedSlot: SecretaryTimeWindow | null;
    alternativeSlots: SecretaryTimeWindow[];
    conflicts: string[];
    downstreamImplications: string[];
  },
  sourceShapeHash: string,
  reasoningTrail: ReasoningTrailNode[],
  latest: SecretaryAgendaItem | null,
): SecretarySchedulingDecision {
  const arbitrationRank = computeSecretaryIntentArbitrationRank(input.intent);
  const startAt = input.selectedSlot?.start ?? null;
  const endAt = input.selectedSlot?.end ?? null;
  const durationMinutes = input.selectedSlot
    ? minutesBetween(input.selectedSlot.start, input.selectedSlot.end)
    : input.intent.requestedDurationMinutes != null
      ? Math.round(Number(input.intent.requestedDurationMinutes))
      : null;
  const agendaItem: SecretaryAgendaItem = {
    agendaItemId: `sec_preview_${sha256(`${input.intent.ownerUserId}:${normalizeTenantId(input.intent.tenantId)}:${input.intent.sourceSkill}:${input.intent.intentId}:${sourceShapeHash}`).slice(0, 24)}`,
    sourceIntentId: input.intent.intentId,
    sourceSkill: input.intent.sourceSkill,
    sourceAction: input.intent.sourceAction ?? null,
    intentAction: input.intent.action ?? defaultActionForStatus(input.status),
    sourceEntityId: input.intent.sourceEntityId != null ? String(input.intent.sourceEntityId) : null,
    sourceEntityType: input.intent.sourceEntityType ?? null,
    ownerUserId: input.intent.ownerUserId,
    tenantId: normalizeTenantId(input.intent.tenantId),
    lifecycleState: input.lifecycleState,
    providerSyncState: 'not_synced',
    providerEventId: null,
    providerSource: null,
    providerTarget: input.intent.providerTarget ?? null,
    providerSyncFailureDisposition: null,
    providerSyncRetryAfterAt: null,
    version: latest ? latest.version + 1 : 1,
    arbitrationScore: Number.isFinite(arbitrationRank.score) ? arbitrationRank.score : null,
    arbitrationDeadlineAt: arbitrationRank.deadlineAt,
    arbitrationFlexibility: arbitrationRank.flexibility,
    arbitrationPolicyVersion: arbitrationRank.policyVersion,
    title: input.intent.title.trim(),
    startAt,
    endAt,
    durationMinutes,
    decisionAction: input.status,
    decisionReasonCodes: [...input.reasonCodes],
    decisionExplanation: input.explanation,
    sourceShapeHash,
    scheduledSegments: decisionScheduledSegments(input.selectedSlot, input.alternativeSlots),
    cancellationReason: null,
    supersededByAgendaItemId: null,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    completedAt: null,
    sourceCreatedAt: input.intent.createdAt ?? null,
    sourceUpdatedAt: input.intent.updatedAt ?? null,
    reasoningTrail,
    providerSyncFailureCount: 0,
    lastSyncedFingerprint: null,
    lastSyncedVerifiedAt: null,
  };
  return {
    status: input.status,
    agendaItem,
    reasonCodes: input.reasonCodes,
    explanation: input.explanation,
    selectedSlot: input.selectedSlot,
    alternativeSlots: input.alternativeSlots,
    conflicts: input.conflicts,
    downstreamImplications: input.downstreamImplications,
    confidence: confidenceFor(input.status, input.reasonCodes),
    feedback: buildFeedback(input.intent, agendaItem, input.status, input.reasonCodes, input.downstreamImplications),
    reasoningTrail,
  };
}

function decisionScheduledSegments(
  selectedSlot: SecretaryTimeWindow | null,
  alternativeSlots: SecretaryTimeWindow[],
): SecretaryTimeWindow[] {
  const segments: SecretaryTimeWindow[] = [];
  const add = (slot?: SecretaryTimeWindow | null) => {
    if (!slot?.start || !slot.end) return;
    if (!Number.isFinite(Date.parse(slot.start)) || !Number.isFinite(Date.parse(slot.end)) || Date.parse(slot.start) >= Date.parse(slot.end)) return;
    if (segments.some((existing) => existing.start === slot.start && existing.end === slot.end)) return;
    segments.push({
      start: slot.start,
      end: slot.end,
      ...(slot.label ? { label: slot.label } : {}),
      ...(slot.hard != null ? { hard: slot.hard } : {}),
    });
  };
  add(selectedSlot);
  for (const slot of alternativeSlots) add(slot);
  return segments.slice(0, 6);
}

function agendaSlotMatches(agendaItem: SecretaryAgendaItem, selectedSlot: SecretaryTimeWindow | null): boolean {
  if (!selectedSlot) return agendaItem.startAt === null && agendaItem.endAt === null;
  return agendaItem.startAt === selectedSlot.start && agendaItem.endAt === selectedSlot.end;
}

function isReusableAgendaItemForIntent(agendaItem: SecretaryAgendaItem): boolean {
  return !NON_REUSABLE_AGENDA_LIFECYCLE_STATES.has(agendaItem.lifecycleState);
}

function decisionFromExisting(
  intent: SecretarySchedulingIntent,
  agendaItem: SecretaryAgendaItem,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: SecretaryReasonCode[],
  explanation: string,
  conflicts: string[],
  downstreamImplications: string[],
  fallbackTrail: ReasoningTrailNode[] = [],
): SecretarySchedulingDecision {
  const selectedSlot = agendaItem.startAt && agendaItem.endAt
    ? { start: agendaItem.startAt, end: agendaItem.endAt }
    : null;
  const alternativeSlots = agendaItem.scheduledSegments.filter((segment) => (
    !selectedSlot || segment.start !== selectedSlot.start || segment.end !== selectedSlot.end
  ));
  const resolvedStatus = agendaItem.decisionAction || status;
  // Coerce legacy DB-shape `string[]` to typed reason codes at the read boundary;
  // unknown legacy values are filtered out (see secretary-reason-codes.ts W-A).
  const persistedReasonCodes = agendaItem.decisionReasonCodes.length > 0
    ? filterKnownReasonCodes(agendaItem.decisionReasonCodes)
    : reasonCodes;
  // W-E: prefer the persisted trail from the agenda item (canonical row
  // truth); fall back to the in-flight trail from this scheduleOne pass when
  // the row predates the column or persistence was skipped.
  const reasoningTrail = agendaItem.reasoningTrail.length > 0
    ? agendaItem.reasoningTrail
    : fallbackTrail;
  return {
    status: resolvedStatus,
    agendaItem,
    reasonCodes: persistedReasonCodes,
    explanation,
    selectedSlot,
    alternativeSlots,
    conflicts,
    downstreamImplications,
    confidence: confidenceFor(resolvedStatus, persistedReasonCodes),
    feedback: buildFeedback(intent, agendaItem, resolvedStatus, persistedReasonCodes, downstreamImplications),
    reasoningTrail,
  };
}

function validateIntent(intent: SecretarySchedulingIntent): SecretaryReasonCode[] {
  const reasonCodes: SecretaryReasonCode[] = [];
  if (!Number.isFinite(intent.ownerUserId) || intent.ownerUserId <= 0) reasonCodes.push('invalid_owner_scope');
  if (!normalizeTenantId(intent.tenantId)) reasonCodes.push('invalid_tenant_scope');
  if (!VALID_SOURCE_SKILLS.has(intent.sourceSkill)) reasonCodes.push('invalid_source_skill');
  if (!intent.intentId?.trim()) reasonCodes.push('missing_intent_id');
  if (!intent.title?.trim()) reasonCodes.push('missing_title');
  if (!Number.isFinite(Number(intent.requestedDurationMinutes)) || Number(intent.requestedDurationMinutes) <= 0) {
    reasonCodes.push('missing_duration');
  }
  if (!Array.isArray(intent.preferredWindows) || intent.preferredWindows.length === 0) {
    reasonCodes.push('missing_availability');
  }
  return reasonCodes;
}

function assertSecretaryTenantScope(intent: SecretarySchedulingIntent): void {
  if (!normalizeTenantId(intent.tenantId)) {
    throw new Error('SECRETARY_INVALID_TENANT_SCOPE: tenantId is required for agenda persistence');
  }
}

function findLatestAgendaItemForIntent(intent: SecretarySchedulingIntent): SecretaryAgendaItem | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT *
    FROM secretary_agenda_items
    WHERE owner_user_id = ?
      AND tenant_id = ?
      AND source_skill = ?
      AND source_intent_id = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(
    intent.ownerUserId,
    normalizeTenantId(intent.tenantId),
    intent.sourceSkill,
    intent.intentId,
  );
  return row ? rowToAgendaItem(row) : null;
}

function findAgendaItemById(agendaItemId: string): SecretaryAgendaItem | null {
  const db = getDb();
  assertSecretaryAgendaSchemaReady(db);
  const row = db.prepare('SELECT * FROM secretary_agenda_items WHERE agenda_item_id = ?').get(agendaItemId);
  return row ? rowToAgendaItem(row) : null;
}

/**
 * Shared Stage 1 capacity planner. It is pure: no loser mutation, provider
 * write, or agenda persistence occurs here. The full hard set remains the
 * submit contract; only preview may disregard an exactly identified,
 * lower-ranked local/provider pair.
 */
export function planSecretarySchedulingCapacity(
  input: SecretarySchedulingCapacityPlanInput,
): SecretarySchedulingCapacityPlan {
  const tenantId = normalizeTenantId(input.intent.tenantId);
  const localAgendaItems = input.localAgendaItems
    .filter((item) => item.ownerUserId === input.intent.ownerUserId && item.tenantId === tenantId)
    .filter((item) => item.sourceSkill !== input.intent.sourceSkill || item.sourceIntentId !== input.intent.intentId)
    .filter((item) => ACTIVE_BUSY_STATES.has(item.lifecycleState) && item.startAt && item.endAt);
  const localWindows = localAgendaItems.map((item) => ({
    start: item.startAt!,
    end: item.endAt!,
    label: item.title,
  }));
  const existingWindows = (input.existingAgendaItems ?? [])
    .filter((item) => ACTIVE_BUSY_STATES.has(item.lifecycleState) && item.startAt && item.endAt)
    .map((item) => ({
      start: item.startAt!,
      end: item.endAt!,
      label: item.title,
    }));
  const additionalBusyWindows = input.additionalBusyWindows ?? [];
  const hardBusyWindows = [
    ...localWindows,
    ...existingWindows,
    ...additionalBusyWindows,
    ...(input.acceptedBusyWindows ?? []),
    ...(input.intent.hardConstraints?.unavailableWindows ?? []),
    ...(input.intent.hardConstraints?.protectedWindows ?? []),
    ...(input.intent.hardConstraints?.hardCommitments ?? []),
  ].filter(isValidSecretaryTimeWindow);

  const localWindowByAgendaItemId = new Map<string, SecretaryTimeWindow>();
  for (let index = 0; index < localAgendaItems.length; index += 1) {
    const window = localWindows[index];
    if (window && isValidSecretaryTimeWindow(window)) {
      localWindowByAgendaItemId.set(localAgendaItems[index].agendaItemId, window);
    }
  }

  const liveWindowsByProviderIdentity = new Map<string, SecretaryTimeWindow[]>();
  for (const window of additionalBusyWindows) {
    const identity = window.providerIdentity;
    if (!identity) continue;
    const key = providerIdentityKey(identity.providerSource, identity.providerEventId);
    const matching = liveWindowsByProviderIdentity.get(key) ?? [];
    matching.push(window);
    liveWindowsByProviderIdentity.set(key, matching);
  }

  const localItemsByProviderIdentity = new Map<string, SecretaryAgendaItem[]>();
  for (const item of localAgendaItems) {
    if (!isSupportedProviderSource(item.providerSource) || !String(item.providerEventId || '').trim()) continue;
    const key = providerIdentityKey(item.providerSource, item.providerEventId!);
    const matching = localItemsByProviderIdentity.get(key) ?? [];
    matching.push(item);
    localItemsByProviderIdentity.set(key, matching);
  }

  const preemptionCandidates: SecretarySchedulingPreemptionCandidate[] = [];
  for (const item of localAgendaItems) {
    if (!isLowerRankedPreemptionCandidate(input.intent, item)) continue;
    if (!isSupportedProviderSource(item.providerSource) || !String(item.providerEventId || '').trim()) continue;
    const key = providerIdentityKey(item.providerSource, item.providerEventId!);
    if ((localItemsByProviderIdentity.get(key) ?? []).length !== 1) continue;
    const liveWindows = liveWindowsByProviderIdentity.get(key) ?? [];
    if (liveWindows.length !== 1) continue;
    const liveWindow = liveWindows[0];
    if (!isExactPreemptionProviderEvidence(input.intent, item, liveWindow)) continue;
    const localWindow = localWindowByAgendaItemId.get(item.agendaItemId);
    if (!localWindow) continue;
    preemptionCandidates.push({ agendaItemId: item.agendaItemId, localWindow, liveWindow });
  }

  const previewRemovals = new Set<SecretaryTimeWindow>();
  for (const candidate of preemptionCandidates) {
    previewRemovals.add(candidate.localWindow);
    previewRemovals.add(candidate.liveWindow);
  }
  return {
    hardBusyWindows,
    previewBusyWindows: hardBusyWindows.filter((window) => !previewRemovals.has(window)),
    preemptionCandidates,
  };
}

function isLowerRankedPreemptionCandidate(
  incoming: SecretarySchedulingIntent,
  item: SecretaryAgendaItem,
): boolean {
  if (item.sourceSkill === incoming.sourceSkill) return false;
  if (!hasCompleteSecretaryAgendaArbitrationMetadata(item)) return false;
  if (item.arbitrationFlexibility === 'fixed') return false;
  if (item.providerSyncState !== 'synced') return false;
  const incomingRank = computeSecretaryIntentArbitrationRank(incoming);
  if (incomingRank.score !== item.arbitrationScore) return incomingRank.score > item.arbitrationScore!;
  const incomingDeadline = incomingRank.deadlineAt
    ? Date.parse(incomingRank.deadlineAt)
    : Number.POSITIVE_INFINITY;
  const itemDeadline = item.arbitrationDeadlineAt
    ? Date.parse(item.arbitrationDeadlineAt)
    : Number.POSITIVE_INFINITY;
  if (incomingDeadline !== itemDeadline) return incomingDeadline < itemDeadline;
  return incomingRank.tieBreakerIntentId.localeCompare(item.sourceIntentId) < 0;
}

function isExactPreemptionProviderEvidence(
  incoming: SecretarySchedulingIntent,
  item: SecretaryAgendaItem,
  liveWindow: SecretaryTimeWindow,
): boolean {
  if (liveWindow.hard === true) return false;
  const identity = liveWindow.providerIdentity;
  if (!identity || !isSupportedProviderSource(item.providerSource)) return false;
  if (identity.ownerUserId !== incoming.ownerUserId || identity.ownerUserId !== item.ownerUserId) return false;
  const tenantId = normalizeTenantId(incoming.tenantId);
  if (identity.tenantId !== tenantId || item.tenantId !== tenantId) return false;
  if (identity.providerEventId !== item.providerEventId || identity.providerSource !== item.providerSource) return false;

  if (item.sourceSkill === 'training') {
    if (identity.agendaItemId && identity.agendaItemId !== item.agendaItemId) return false;
    return trainingIdentityMatchesSourceIntent(identity.trainingIdentity, item.sourceIntentId);
  }
  return identity.agendaItemId === item.agendaItemId;
}

function trainingIdentityMatchesSourceIntent(
  identity: SecretaryProviderEventIdentity['trainingIdentity'],
  sourceIntentId: string,
): boolean {
  if (!identity) return false;
  const match = /^training:(\d+):(\d+):(\d+)$/.exec(sourceIntentId);
  if (!match) return false;
  return identity.planId === Number(match[1])
    && identity.planVersion === Number(match[2])
    && identity.sessionId === Number(match[3]);
}

function isSupportedProviderSource(value: string | null): value is 'google' | 'outlook' {
  return value === 'google' || value === 'outlook';
}

function providerIdentityKey(source: 'google' | 'outlook', eventId: string): string {
  return `${source}:${eventId.trim()}`;
}

function isValidSecretaryTimeWindow(window: SecretaryTimeWindow): boolean {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

function preemptionCandidateOverlapsSlot(
  candidate: SecretarySchedulingPreemptionCandidate,
  slot: CandidateSlot,
): boolean {
  return [candidate.localWindow, candidate.liveWindow].some((window) => {
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    return startMs < slot.endMs && endMs > slot.startMs;
  });
}

function normalizeWindows(windows: SecretaryTimeWindow[]): NormalizedWindow[] {
  const normalized: NormalizedWindow[] = [];
  for (const window of windows) {
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const item: NormalizedWindow = {
      startMs,
      endMs,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    };
    if (window.label) item.label = window.label;
    normalized.push(item);
  }
  return normalized.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function findFirstAvailableSlot(
  windows: NormalizedWindow[],
  busyWindows: NormalizedWindow[],
  durationMinutes: number,
): CandidateSlot | null {
  const durationMs = durationMinutes * 60_000;
  for (const window of windows) {
    const slot = findSlotInWindow(window, busyWindows, durationMs, durationMs);
    if (slot) return slot;
  }
  return null;
}

function findLargestAvailableSlot(
  windows: NormalizedWindow[],
  busyWindows: NormalizedWindow[],
  minimumDurationMinutes: number,
  requestedDurationMinutes: number,
): CandidateSlot | null {
  const minimumMs = minimumDurationMinutes * 60_000;
  const requestedMs = requestedDurationMinutes * 60_000;
  let best: CandidateSlot | null = null;
  for (const window of windows) {
    const slot = findSlotInWindow(window, busyWindows, minimumMs, requestedMs);
    if (!slot) continue;
    if (!best || slot.durationMinutes > best.durationMinutes) best = slot;
  }
  return best;
}

function findSlotInWindow(
  window: NormalizedWindow,
  busyWindows: NormalizedWindow[],
  minimumMs: number,
  preferredMs: number,
): CandidateSlot | null {
  let cursor = window.startMs;
  const overlaps = busyWindows
    .filter((busy) => busy.endMs > window.startMs && busy.startMs < window.endMs)
    .sort((left, right) => left.startMs - right.startMs);

  for (const busy of overlaps) {
    const gapEnd = Math.min(busy.startMs, window.endMs);
    const gapMs = gapEnd - cursor;
    if (gapMs >= minimumMs) {
      const durationMs = Math.min(preferredMs, gapMs);
      return {
        startMs: cursor,
        endMs: cursor + durationMs,
        durationMinutes: Math.round(durationMs / 60_000),
        sourceWindow: window,
      };
    }
    cursor = Math.max(cursor, busy.endMs);
    if (cursor >= window.endMs) break;
  }

  const tailMs = window.endMs - cursor;
  if (tailMs >= minimumMs) {
    const durationMs = Math.min(preferredMs, tailMs);
    return {
      startMs: cursor,
      endMs: cursor + durationMs,
      durationMinutes: Math.round(durationMs / 60_000),
      sourceWindow: window,
    };
  }
  return null;
}

function slotToWindow(slot: CandidateSlot): SecretaryTimeWindow {
  return {
    start: new Date(slot.startMs).toISOString(),
    end: new Date(slot.endMs).toISOString(),
    label: slot.sourceWindow.label,
  };
}

function candidateWindowsToAlternatives(
  windows: NormalizedWindow[],
  selected: CandidateSlot,
): SecretaryTimeWindow[] {
  return windows
    .filter((window) => window.startMs !== selected.sourceWindow.startMs || window.endMs !== selected.sourceWindow.endMs)
    .slice(0, 3)
    .map((window) => ({ start: window.start, end: window.end, label: window.label }));
}

function conflictSummaries(busyWindows: NormalizedWindow[]): string[] {
  return busyWindows
    .slice(0, 5)
    .map((busy) => busy.label ? `${busy.label}: ${busy.start} - ${busy.end}` : `${busy.start} - ${busy.end}`);
}

function compareIntentPriority(left: SecretarySchedulingIntent, right: SecretarySchedulingIntent): number {
  const leftRank = computeSecretaryIntentArbitrationRank(left);
  const rightRank = computeSecretaryIntentArbitrationRank(right);
  if (leftRank.score !== rightRank.score) return rightRank.score - leftRank.score;
  const leftDeadline = leftRank.deadlineAt ? Date.parse(leftRank.deadlineAt) : Number.POSITIVE_INFINITY;
  const rightDeadline = rightRank.deadlineAt ? Date.parse(rightRank.deadlineAt) : Number.POSITIVE_INFINITY;
  return leftDeadline - rightDeadline || leftRank.tieBreakerIntentId.localeCompare(rightRank.tieBreakerIntentId);
}

/**
 * Dynamic priority phase boost (C3 workstream).
 *
 * Training is the only skill that adapts to goal phase today; other skills
 * pass `goalPhase` through harmlessly with a 0 boost. Finance's deadline
 * boost (+18) remains the dominant signal so a tax deadline still outranks
 * Training even in race week (race phase = -4 + base 12 = 8 < Finance 16).
 *
 * Phase = null/undefined → 0 (graceful default; pre-C3 behavior).
 */
function phaseBoostFor(sourceSkill: SecretarySourceSkill, phase: SecretaryGoalPhase | null): number {
  if (phase == null) return 0;
  if (sourceSkill !== 'training') return 0;
  switch (phase) {
    case 'build': return 2;
    case 'peak': return 3;
    case 'taper': return -2;
    case 'race': return -4;
    case 'deload': return -3;
    case 'base':
    case 'maintenance':
      return 0;
    default: return 0;
  }
}

function priorityReasonCodes(intent: SecretarySchedulingIntent): SecretaryReasonCode[] {
  const codes: SecretaryReasonCode[] = [];
  if (intent.priority === 'urgent' || intent.priority === 'high' || Number(intent.priority) >= 70) {
    codes.push('high_priority_intent');
  }
  if (intent.deadline) codes.push('deadline_present');
  if (intent.sourceSkill === 'finance' && intent.deadline) codes.push('finance_deadline_priority');
  if (intent.sourceSkill === 'training') codes.push('training_schedule_request');
  if (intent.sourceSkill === 'cooking') codes.push('cooking_support_request');
  if (intent.sourceSkill === 'content') codes.push('content_focus_request');
  return codes;
}

function slotReasonCodes(intent: SecretarySchedulingIntent, slot: CandidateSlot): SecretaryReasonCode[] {
  const codes = priorityReasonCodes(intent);
  if (slot.durationMinutes < Number(intent.requestedDurationMinutes)) codes.push('duration_reduced');
  if (intent.flexibility === 'fixed') codes.push('fixed_intent_respected');
  return codes;
}

function hasDeadlineAfterWindows(deadline: string | null | undefined, windows: NormalizedWindow[]): boolean {
  if (!deadline || windows.length === 0) return false;
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) return false;
  const latestWindowEnd = Math.max(...windows.map((window) => window.endMs));
  return deadlineMs > latestWindowEnd;
}

function explainDecision(
  intent: SecretarySchedulingIntent,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: readonly SecretaryReasonCode[],
): string {
  const title = intent.title.trim() || 'This item';
  switch (status) {
    case 'scheduled':
      return `${title} was scheduled in an available window.`;
    case 'reflowed':
      return `${title} was moved to a new available window because the previous placement no longer fit.`;
    case 'compressed':
      return `${title} was compressed to fit the available capacity.`;
    case 'deferred':
      return `${title} was deferred because current windows are full but the deadline leaves room to revisit it.`;
    case 'unscheduled':
      return `${title} was left unscheduled because no valid slot was available.`;
    case 'rejected':
      return `${title} was rejected because the scheduling request failed policy or ownership validation.`;
    case 'needs_more_context':
      return reasonCodes.includes('missing_duration')
        ? `${title} needs a duration before Secretary can schedule it.`
        : `${title} needs clearer availability before Secretary can schedule it.`;
    default:
      return `${title} produced a scheduling decision.`;
  }
}

function downstreamFor(
  intent: SecretarySchedulingIntent,
  status: SecretarySchedulingDecisionStatus,
): string[] {
  const implications: string[] = [];
  if (status === 'unscheduled') {
    implications.push(`${intent.sourceSkill} should treat this as not placed on the agenda.`);
  }
  if (status === 'deferred') {
    implications.push(`${intent.sourceSkill} should refresh the intent before the deadline window closes.`);
  }
  if (status === 'compressed') {
    implications.push(`${intent.sourceSkill} should adapt the workload to the shorter scheduled block.`);
  }
  if (status === 'reflowed') {
    implications.push(`${intent.sourceSkill} should refresh any user-facing time copy for this item.`);
  }
  if (status === 'needs_more_context') {
    implications.push(`${intent.sourceSkill} should provide the missing scheduling context or ask the user a targeted question.`);
  }
  return implications;
}

function defaultActionForStatus(status: SecretarySchedulingDecisionStatus): SecretarySchedulingIntentAction {
  if (status === 'needs_more_context') return 'request_clarification';
  if (status === 'unscheduled') return 'find_time_for_this';
  return 'schedule_this';
}

function buildFeedback(
  intent: SecretarySchedulingIntent,
  agendaItem: SecretaryAgendaItem,
  status: SecretarySchedulingDecisionStatus,
  reasonCodes: readonly SecretaryReasonCode[],
  downstreamImplications: string[],
): SecretarySourceSkillFeedback {
  return {
    sourceSkill: intent.sourceSkill,
    sourceIntentId: intent.intentId,
    agendaItemId: agendaItem.agendaItemId,
    ownerUserId: agendaItem.ownerUserId,
    tenantId: agendaItem.tenantId,
    agendaVersion: agendaItem.version,
    status,
    reasonCodes: [...reasonCodes],
    scheduledStart: agendaItem.startAt,
    scheduledEnd: agendaItem.endAt,
    shouldRefreshSource: ['reflowed', 'compressed', 'deferred', 'unscheduled', 'needs_more_context'].includes(status),
    downstreamImplications,
  };
}

function buildFeedbackBySourceSkill(decisions: SecretarySchedulingDecision[]): Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]> {
  const empty: Record<SecretarySourceSkill, SecretarySourceSkillFeedback[]> = {
    secretary: [],
    training: [],
    cooking: [],
    finance: [],
    content: [],
  };
  for (const decision of decisions) {
    empty[decision.feedback.sourceSkill].push(decision.feedback);
  }
  return empty;
}

function confidenceFor(status: SecretarySchedulingDecisionStatus, reasonCodes: readonly SecretaryReasonCode[]): 'low' | 'medium' | 'high' {
  if (status === 'scheduled' || status === 'reflowed') return 'high';
  if (status === 'compressed' || status === 'deferred') return 'medium';
  if (reasonCodes.includes('missing_duration') || reasonCodes.includes('missing_availability')) return 'low';
  return 'medium';
}

function computeSourceShapeHash(intent: SecretarySchedulingIntent): string {
  return sha256(stableStringify({
    action: intent.action ?? 'schedule_this',
    sourceSkill: intent.sourceSkill,
    sourceEntityId: intent.sourceEntityId ?? null,
    sourceEntityType: intent.sourceEntityType ?? null,
    title: intent.title,
    requestedDurationMinutes: intent.requestedDurationMinutes ?? null,
    minimumDurationMinutes: intent.minimumDurationMinutes ?? null,
    preferredWindows: intent.preferredWindows ?? [],
    hardConstraints: intent.hardConstraints ?? {},
    deadline: intent.deadline ?? null,
    priority: intent.priority ?? 'normal',
    flexibility: intent.flexibility ?? 'flexible',
    dependencies: intent.dependencies ?? [],
    energyCost: intent.energyCost ?? null,
    providerTarget: intent.providerTarget ?? null,
  })).slice(0, 32);
}

function buildAgendaItemId(intent: SecretarySchedulingIntent, version: number): string {
  return `sec_agenda_${sha256(`${intent.ownerUserId}:${normalizeTenantId(intent.tenantId)}:${intent.sourceSkill}:${intent.intentId}:${version}`).slice(0, 24)}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function normalizeTenantId(value: string | number): string {
  return String(value ?? '').trim();
}

/**
 * Canonical provider-sync fingerprint for a secretary agenda item. This is
 * the single source of truth shared by the sync engine's short-circuit
 * comparison (secretary-agenda-provider-sync.ts) and the fingerprint written
 * when Training satisfies the provider sync directly — the two must never
 * drift, or satisfied items fall back to per-tick provider round-trips.
 */
export function computeSecretaryAgendaProviderSyncFingerprint(
  item: Pick<SecretaryAgendaItem, 'sourceShapeHash' | 'startAt' | 'endAt' | 'version'>,
  providerSource: 'google' | 'outlook',
): string {
  return [
    providerSource,
    item.sourceShapeHash,
    item.startAt ?? '',
    item.endAt ?? '',
    String(item.version),
  ].join('|');
}

function recordAgendaProviderSyncFingerprint(
  item: SecretaryAgendaItem,
  providerSource: 'google' | 'outlook',
  nowIso: string,
): void {
  const db = getDb();
  if (
    !secretaryAgendaColumnExists('last_synced_fingerprint', db)
    || !secretaryAgendaColumnExists('last_synced_verified_at', db)
  ) {
    return;
  }
  const fingerprint = computeSecretaryAgendaProviderSyncFingerprint(item, providerSource);
  db.prepare(`
    UPDATE secretary_agenda_items
       SET last_synced_fingerprint = ?,
           last_synced_verified_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
  `).run(
    fingerprint,
    nowIso,
    item.agendaItemId,
    item.ownerUserId,
    item.tenantId,
  );
}

function secretaryAgendaColumnExists(columnName: string, db = getDb()): boolean {
  const columns = db.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name?: string }>;
  return columns.some((column) => column.name === columnName);
}

function secretaryAgendaArbitrationMetadataColumnsExist(db = getDb()): boolean {
  const required = new Set([
    'arbitration_score',
    'arbitration_deadline_at',
    'arbitration_flexibility',
    'arbitration_policy_version',
  ]);
  const columns = db.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name?: string }>;
  for (const column of columns) {
    if (column.name) required.delete(column.name);
  }
  return required.size === 0;
}

function secretaryAgendaProviderTargetColumnExists(db = getDb()): boolean {
  return secretaryAgendaColumnExists('provider_target', db);
}

function normalizeNow(now?: string): string {
  if (now) {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function minutesBetween(start: string, end: string): number {
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
}

function rowToAgendaItem(row: any): SecretaryAgendaItem {
  return {
    agendaItemId: row.agenda_item_id,
    sourceIntentId: row.source_intent_id,
    sourceSkill: row.source_skill,
    sourceAction: row.source_action ?? null,
    intentAction: row.intent_action,
    sourceEntityId: row.source_entity_id ?? null,
    sourceEntityType: row.source_entity_type ?? null,
    ownerUserId: Number(row.owner_user_id),
    tenantId: String(row.tenant_id),
    lifecycleState: row.lifecycle_state,
    providerSyncState: row.provider_sync_state,
    providerEventId: row.provider_event_id ?? null,
    providerSource: row.provider_source ?? null,
    providerTarget: row.provider_target === 'google' || row.provider_target === 'outlook'
      ? row.provider_target
      : null,
    providerSyncFailureDisposition:
      row.provider_sync_failure_disposition === 'terminal'
      || row.provider_sync_failure_disposition === 'retryable'
      || row.provider_sync_failure_disposition === 'reconcile'
        ? row.provider_sync_failure_disposition
        : null,
    providerSyncRetryAfterAt: row.provider_sync_retry_after_at ?? null,
    version: Number(row.version),
    arbitrationScore: row.arbitration_score == null ? null : Number(row.arbitration_score),
    arbitrationDeadlineAt: row.arbitration_deadline_at ?? null,
    arbitrationFlexibility: row.arbitration_flexibility ?? null,
    arbitrationPolicyVersion: row.arbitration_policy_version ?? null,
    title: row.title,
    startAt: row.start_at ?? null,
    endAt: row.end_at ?? null,
    durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    decisionAction: row.decision_action,
    decisionReasonCodes: safeParseArray(row.decision_reason_codes_json),
    decisionExplanation: row.decision_explanation ?? null,
    sourceShapeHash: row.source_shape_hash,
    scheduledSegments: safeParseArray(row.scheduled_segments_json),
    cancellationReason: row.cancellation_reason ?? null,
    supersededByAgendaItemId: row.superseded_by_agenda_item_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
    sourceCreatedAt: row.source_created_at ?? null,
    sourceUpdatedAt: row.source_updated_at ?? null,
    // W-E: legacy rows (pre-column-add) decode to []. The PRAGMA add is
    // idempotent so this is the only place that needs to be defensive.
    reasoningTrail: safeParseArray<ReasoningTrailNode>(row.reasoning_trail_json),
    providerSyncFailureCount: Number(row.provider_sync_failure_count ?? 0) || 0,
    lastSyncedFingerprint: row.last_synced_fingerprint ?? null,
    lastSyncedVerifiedAt: row.last_synced_verified_at ?? null,
  };
}

function safeParseArray<T = any>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

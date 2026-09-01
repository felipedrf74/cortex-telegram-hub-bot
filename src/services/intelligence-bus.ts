// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

/**
 * Intelligence Bus — shared signal system for the Content Agent Mesh.
 *
 * This module has zero project imports (same pattern as telemetry.ts)
 * to avoid circular dependencies. Uses setDbProvider() callback
 * initialized from src/index.ts after database is ready.
 */

// ─── Types ──────────────────────────────────────────────────────────

export type SignalPriority = 'urgent' | 'normal' | 'background';
export type SignalStatus = 'active' | 'consumed' | 'dismissed' | 'expired';
export type MeshPriority = 1 | 2 | 3 | 4;

export interface SignalProvenance {
  producerVersion: string;
  source: 'runtime' | 'user-feedback' | 'measured-outcome' | 'trusted-external' | 'human-approved';
  observedAt: string;
}

export interface SignalWriteInput {
  source_agent: string;
  signal_type: SignalType;
  payload: Record<string, any>;
  priority?: SignalPriority;
  expires_at?: string;
  /** Telegram user ID for per-user signals. Omit for global content signals. */
  user_id?: number;
  /**
   * Tenant/workspace ID. Governed callers should pass this whenever the
   * authenticated tenant is known. Omission deliberately falls back to
   * user_id only for legacy single-user boundaries.
   */
  tenant_id?: number;
  /** Strength/certainty metric (0.0–1.0). Default 0.5. */
  confidence?: number;
  /** Content format: 'reel', 'youtube', 'short', etc. */
  format_tag?: string;
  /** Content pillar: 'tech', 'fitness', 'politics', etc. */
  pillar_tag?: string;
  /** Number of observations backing this signal. Default 1. */
  evidence_count?: number;
  meshPriority?: MeshPriority;
  /** Optional only for the deprecated compatibility writer. */
  provenance?: SignalProvenance;
}

export type GovernedSignalWriteInput = Omit<SignalWriteInput, 'provenance'> & {
  provenance: SignalProvenance;
};

export type GovernedSignalWriteErrorCode =
  | 'invalid_provenance'
  | 'invalid_confidence'
  | 'invalid_tenant_scope'
  | 'missing_user_scope'
  | 'unexpected_user_scope'
  | 'invalid_expiry'
  | 'expired_signal'
  | 'write_rejected';

/**
 * A governed write is a production contract, so rejection must be observable.
 * The error intentionally carries only signal identity and a stable code; it
 * never includes the payload or other potentially private signal data.
 */
export class GovernedSignalWriteError extends Error {
  readonly code: GovernedSignalWriteErrorCode;
  readonly signalType: SignalType;
  readonly sourceAgent: string;

  constructor(
    code: GovernedSignalWriteErrorCode,
    signal: Pick<SignalWriteInput, 'signal_type' | 'source_agent'>,
  ) {
    super(`Governed signal write rejected (${code}) for ${signal.source_agent}:${signal.signal_type}`);
    this.name = 'GovernedSignalWriteError';
    this.code = code;
    this.signalType = signal.signal_type;
    this.sourceAgent = signal.source_agent;
  }
}

export type SignalType =
  // ─── Content mesh signals (GLOBAL — user_id IS NULL) ──────────────
  | 'hook_effectiveness'
  | 'pillar_performance'
  | 'retention_pattern'
  // Voice signals are per creator. They carry tenant/user scope because a
  // creator's phrasing and edits are private behavioral data.
  | 'voice_pattern'
  | 'voice_phrase_trend'
  | 'voice_analysis_fingerprint'
  | 'channel_dna'
  | 'book_knowledge'
  | 'book_reference_effective'
  | 'trending_spike'
  | 'competitor_upload'
  | 'keyword_rank_change'
  | 'keyword_opportunity'
  | 'pipeline_bottleneck'
  | 'pipeline_capacity'
  | 'content_sprint_mode'
  | 'reaction_opportunity'
  | 'content_published'
  // Cross-agent learning signals (v2)
  // Platform-wide synthesis of global-only inputs. Creator-specific digests
  // use creator_learning_digest so private voice data can never be persisted
  // into a row visible to every user in a tenant.
  | 'learning_digest'
  | 'creator_learning_digest'
  | 'content_formula'
  | 'audience_insight'
  // ─── Training signals (PER-USER — user_id REQUIRED) ───────────────
  // Load markers — a just-completed session's stress footprint, read by
  // sibling coaches to downgrade their next prescription for the same user.
  | 'gym_load_today'         // gym coach wrote after a session (RPE, volume)
  | 'running_load_today'     // running coach wrote after a run (distance, RPE)
  | 'cycling_load_today'     // cycle coach wrote after a ride (TSS, NP)
  | 'swim_load_today'        // swim coach wrote after a session (distance)
  // High-specificity load signals — triggers for concrete cross-sport rules
  | 'high_leg_load'          // gym/running: any leg-heavy session at RPE >= 8
  | 'high_shoulder_load'     // gym/swim: overhead press or volume swim
  // Garmin/wellness signals — wellness layer writes, any coach reads
  | 'low_sleep'              // < 60 sleep score or < 6 h total
  | 'low_hrv'                // HRV below 7-day baseline
  | 'low_readiness'          // Garmin training readiness < 40
  | 'safety_red_flag'        // structured health intake says hard training should pause
  // Planning signals — forward-looking intent for cross-sport coordination
  | 'planned_hard_run'       // running coach scheduled a hard session today/tomorrow
  | 'planned_hard_ride'      // cycle coach scheduled a hard session today/tomorrow
  | 'planned_race_this_week' // any sport coach: race on the calendar within 7 days
  // Calendar lifecycle invalidation
  | 'training_plan_canceled'      // training plan cancellation invalidates schedule + cross-skill context
  // ─── Phase 4 Slice C — Adherence signals ─────────────────────────
  // Computed from weekly session completion data vs the active plan's
  // planned session count. Published daily (or on any training tab
  // open) with a 24h TTL so they refresh themselves as the week
  // progresses. Sport coaches read these to auto-deload a user who
  // keeps missing sessions OR push harder for a user who's perfect.
  | 'low_adherence'               // < 60% of planned sessions completed this week
  | 'high_adherence'              // 100% completed AND planned >= 3 sessions
  // ─── Phase 4 Slice G — Plan drift signal ─────────────────────────
  // The user's ACTUAL sport distribution over the past 4 weeks
  // diverges from the sport their active plan is built around.
  // Example: the plan is a hybrid block, but every logged session
  // has been running for three straight weeks. Sport coaches read
  // this to either (a) gently nudge the user back toward plan
  // balance or (b) pivot the plan to match what the user is
  // actually doing. Published daily via the weekly-activity fetch,
  // with a 48h TTL so it refreshes as new sessions land.
  | 'plan_drift'
  // ─── Stage 2 mesh signals ───────────────────────────────────────
  | 'training_load_forecast'
  | 'training_completion_summary'
  | 'recovery_state'
  | 'session_prescription'
  | 'session_immovability'
  | 'fueling_requirements'
  | 'rest_day_scheduled'
  | 'meal_plan_window'
  | 'fueling_support_status'
  | 'meal_execution_readiness'
  | 'fueling_gap_risk'
  | 'grocery_spend_forecast'
  | 'batch_cook_day'
  | 'content_capture_opportunity'
  | 'shoot_day_locked'
  | 'publishing_commitment'
  | 'sponsor_deliverable_due'
  | 'calendar_busy_blocks'
  | 'calendar_fragmentation'
  | 'travel_window'
  | 'inbox_pressure'
  | 'meeting_criticality'
  | 'deadline_pressure'
  | 'task_portability'
  | 'budget_remaining'
  | 'tax_deadline'
  | 'subscription_renewal_due'
  | 'expense_anomaly';

export interface AgentSignal {
  id: number;
  source_agent: string;
  signal_type: SignalType;
  payload: Record<string, any>;
  priority: SignalPriority;
  consumed_by: string[];
  status: SignalStatus;
  created_at: string;
  expires_at: string;
  /** Telegram user ID, or null for global signals (content mesh). */
  user_id: number | null;
  /** Tenant/workspace ID. Null means legacy platform-global/system signal. */
  tenant_id: number | null;
  /** Privacy-safe identity of the signal meaning and scope. */
  signal_identity: string | null;
  /** Strength/certainty metric (0.0–1.0). Higher = more reliable. (Migration 060) */
  confidence: number;
  /** Content format tag: 'reel', 'youtube', 'short', etc. (Migration 060) */
  format_tag: string | null;
  /** Content pillar tag: 'tech', 'fitness', 'politics', etc. (Migration 060) */
  pillar_tag: string | null;
  /** How many observations/data points back this signal. (Migration 060) */
  evidence_count: number;
  /** Producer identity and evidence origin, persisted with the payload. */
  provenance?: SignalProvenance;
  /** Stage 2 mesh coordination priority. Optional for backward compatibility. */
  meshPriority?: MeshPriority;
}

/** A ranked signal with a computed relevance score. */
export interface RankedSignal extends AgentSignal {
  /** Combined rank = confidence × freshness × priority_weight. Range 0–1. */
  relevanceScore: number;
  /** Age in hours since creation. */
  ageHours: number;
}

export interface AgentRunRecord {
  id: number;
  agent_name: string;
  status: string;
  signals_produced: number;
  signals_consumed: number;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface ScopeAnomalyReport {
  layer: 'intelligence_bus';
  operation: 'write_signal' | 'read_signals';
  reason: 'missing_user_scope' | 'invalid_user_scope' | 'unexpected_user_scope';
  userId: number | null;
  signalType?: SignalType;
  details?: Record<string, unknown>;
}

// ─── Signal Expiry Defaults (hours) ─────────────────────────────────

const EXPIRY_HOURS: Record<SignalType, number> = {
  // Content mesh
  trending_spike: 24,
  competitor_upload: 48,
  hook_effectiveness: 60 * 24,      // 60 days
  pillar_performance: 60 * 24,
  retention_pattern: 60 * 24,
  voice_pattern: 90 * 24,           // 90 days
  voice_phrase_trend: 90 * 24,
  voice_analysis_fingerprint: 370 * 24,
  channel_dna: 30 * 24,             // 30 days
  book_knowledge: 365 * 24 * 10,    // effectively never
  book_reference_effective: 60 * 24,
  keyword_rank_change: 14 * 24,     // 14 days
  keyword_opportunity: 14 * 24,
  pipeline_bottleneck: 7 * 24,      // 7 days
  pipeline_capacity: 7 * 24,
  content_sprint_mode: 7 * 24,      // default, can be overridden
  reaction_opportunity: 48,          // 48 hours — reactions lose value fast
  content_published: 30 * 24,        // 30 days — for performance tracking
  // Cross-agent learning signals (v2)
  learning_digest: 7 * 24,           // 7 days — weekly digest cycle
  creator_learning_digest: 7 * 24,   // 7 days — private creator digest cycle
  content_formula: 90 * 24,          // 90 days — validated formulas are durable
  audience_insight: 30 * 24,         // 30 days — audience behavior shifts
  // ─── Training signals — shorter, training context is hour-level ───
  // Load markers: the "stress footprint" of a session only matters for
  // the next 24-36 hours for cross-sport interference. After that, the
  // body has moved on.
  gym_load_today:         36,       // 1.5 days — covers next-day training decisions
  running_load_today:     36,
  cycling_load_today:     36,
  swim_load_today:        36,
  high_leg_load:          48,       // 2 days — tendon/CNS fatigue lingers
  high_shoulder_load:     48,
  // Wellness signals: sleep/HRV/readiness readings are daily. They
  // should expire at roughly the boundary of "today" in the user's TZ.
  low_sleep:              24,
  low_hrv:                24,
  low_readiness:          24,
  safety_red_flag:        24,
  // Planning signals: forward intent has natural shelf life up to the
  // planned session itself. We default to 48h; specific writers can
  // override with an explicit expires_at tied to the session start.
  planned_hard_run:       48,
  planned_hard_ride:      48,
  planned_race_this_week: 7 * 24,
  // Calendar lifecycle invalidation
  training_plan_canceled:     7 * 24, // 7 days — gives downstream skills time to repair cached context
  // Adherence — reset daily. Re-computed on every training tab open
  // (via the /activity/weekly endpoint), so if the user finishes a
  // session and their adherence flips, the next fetch supersedes
  // the previous signal. 24h ensures a stale signal can't linger
  // past midnight if the trigger path isn't hit for a day.
  low_adherence:              24,
  high_adherence:             24,
  // Plan drift — slower-moving than daily adherence. A user who
  // drifts from strength to running won't flip back in 24h, so the
  // 48h TTL lets the signal persist across a missed fetch while
  // still auto-expiring if the pattern corrects itself.
  plan_drift:                 48,
  // ─── Stage 2 mesh signals ───────────────────────────────────────
  training_load_forecast:     48,
  training_completion_summary: 7 * 24,
  recovery_state:             24,
  session_prescription:       48,
  session_immovability:       48,
  fueling_requirements:       48,
  rest_day_scheduled:         7 * 24,
  meal_plan_window:           7 * 24,
  fueling_support_status:     48,
  meal_execution_readiness:   7 * 24,
  fueling_gap_risk:           48,
  grocery_spend_forecast:     7 * 24,
  batch_cook_day:             7 * 24,
  content_capture_opportunity: 72,
  shoot_day_locked:           7 * 24,
  publishing_commitment:      7 * 24,
  sponsor_deliverable_due:    14 * 24,
  calendar_busy_blocks:       7 * 24,
  calendar_fragmentation:     7 * 24,
  travel_window:              14 * 24,
  inbox_pressure:             24,
  meeting_criticality:        48,
  deadline_pressure:          24,
  task_portability:           24,
  budget_remaining:           7 * 24,
  tax_deadline:               30 * 24,
  subscription_renewal_due:   30 * 24,
  expense_anomaly:            7 * 24,
};

const ALLOWED_SIGNAL_SOURCE_AGENTS = new Set([
  'book-extractor',
  'channel-learner',
  'content-analysis',
  'content.pipeline',
  'content.test',
  'cooking.fueling',
  'finance.training',
  'garmin.sync',
  'learning-digest',
  'performance-agent',
  'pipeline',
  'pipeline-agent',
  'portal',
  'reaction-radar',
  'secretary.calendar',
  'seo-agent',
  'session.analytics',
  'training-cross-skill-smoke.fixture',
  'training.test',
  'voice-evolution',
  // Focused unit-test fixture agents. Production paths should use the
  // stable domain prefixes below or an explicit entry in this allowlist.
  'a',
  'b',
  'c',
  'bulk',
  'agent-a',
  'agent-b',
  'mesh-agent',
  'test',
  'test-agent',
]);

const ALLOWED_SIGNAL_SOURCE_PREFIXES = [
  'mesh.',
  'triathlon.',
  'training.',
  'cooking.',
  'finance.',
  'content.',
  'secretary.',
  'session.',
  'test.',
];

export function isAllowedSignalSourceAgent(sourceAgent: string): boolean {
  const normalized = sourceAgent.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(normalized)) return false;
  if (ALLOWED_SIGNAL_SOURCE_AGENTS.has(normalized)) return true;
  return ALLOWED_SIGNAL_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// ─── Database Provider (lazy, avoids circular imports) ───────────────

interface DbLike {
  prepare(sql: string): {
    run(...args: any[]): any;
    get(...args: any[]): any;
    all(...args: any[]): any[];
  };
}

type DbProvider = () => DbLike;
let _getDb: DbProvider | null = null;
type PlanningInvalidator = (userId?: number) => void;
let _invalidatePlanningCaches: PlanningInvalidator | null = null;
let _reportScopeAnomaly: ((report: ScopeAnomalyReport) => void) | null = null;

export function setDbProvider(fn: DbProvider): void {
  _getDb = fn;
}

export function setPlanningInvalidator(fn: PlanningInvalidator): void {
  _invalidatePlanningCaches = fn;
}

export function setScopeAnomalyReporter(fn: ((report: ScopeAnomalyReport) => void) | null): void {
  _reportScopeAnomaly = fn;
}

/** One SQLite transaction for replacing a coherent group of governed signals. */
export function runSignalWriteTransaction<T>(operation: () => T): T {
  const d = db();
  if (!d || typeof (d as any).transaction !== 'function') {
    throw new Error('INTELLIGENCE_BUS_TRANSACTION_UNAVAILABLE');
  }
  return (d as any).transaction(operation)();
}

export interface GovernedSignalSetReconcileInput {
  sourceAgent: string;
  userId: number;
  tenantId: number;
  /** Signal rows produced by the current complete producer snapshot. */
  keepSignalIds: readonly number[];
}

/**
 * Retire every active row omitted from one producer's complete snapshot.
 *
 * Callers that also write replacement signals must wrap both operations in
 * `runSignalWriteTransaction` so an incomplete producer run cannot publish a
 * partial set or erase the last coherent set.
 */
export function reconcileGovernedSignalSet(input: GovernedSignalSetReconcileInput): number {
  const sourceAgent = input.sourceAgent.trim();
  if (!isAllowedSignalSourceAgent(sourceAgent)) {
    throw new Error('INTELLIGENCE_BUS_INVALID_RECONCILE_SOURCE');
  }
  if (!hasValidScopedUserId(input.userId) || !hasValidTenantId(input.tenantId)) {
    throw new Error('INTELLIGENCE_BUS_INVALID_RECONCILE_SCOPE');
  }
  const keepSignalIds = [...new Set(input.keepSignalIds)];
  if (keepSignalIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('INTELLIGENCE_BUS_INVALID_RECONCILE_SIGNAL_ID');
  }

  const d = db();
  if (!d) throw new Error('INTELLIGENCE_BUS_RECONCILE_UNAVAILABLE');
  if (!tableHasColumn(d, 'agent_signals', 'tenant_id')) {
    // Never broaden a tenant-scoped replacement when additive schema is not
    // ready yet. The weekly planner will degrade and preserve existing rows.
    throw new Error('INTELLIGENCE_BUS_RECONCILE_TENANT_SCOPE_UNAVAILABLE');
  }

  const keepClause = keepSignalIds.length > 0
    ? `AND id NOT IN (${keepSignalIds.map(() => '?').join(', ')})`
    : '';
  const result = d.prepare(`
    UPDATE agent_signals
       SET status = 'dismissed'
     WHERE source_agent = ?
       AND tenant_id = ?
       AND user_id = ?
       AND status = 'active'
       ${keepClause}
  `).run(sourceAgent, input.tenantId, input.userId, ...keepSignalIds);
  return (result as any).changes ?? 0;
}

function db(): DbLike | null {
  if (!_getDb) return null;
  try { return _getDb(); } catch { return null; }
}

const GLOBAL_SIGNAL_TYPES = new Set<SignalType>([
  'hook_effectiveness',
  'pillar_performance',
  'retention_pattern',
  'channel_dna',
  'book_knowledge',
  'book_reference_effective',
  'trending_spike',
  'competitor_upload',
  'keyword_rank_change',
  'keyword_opportunity',
  // Pipeline guidance is derived from one creator's private workspace and
  // therefore requires explicit tenant/user scope. It must never be promoted
  // into a platform-global signal.
  'content_sprint_mode',
  'reaction_opportunity',
  'content_published',
  'learning_digest',
  'content_formula',
  'audience_insight',
]);

function hasValidScopedUserId(userId: number | undefined): userId is number {
  return typeof userId === 'number' && Number.isFinite(userId) && userId > 0;
}

function hasValidTenantId(tenantId: number | undefined | null): tenantId is number {
  return typeof tenantId === 'number' && Number.isFinite(tenantId) && tenantId > 0;
}

function resolveSignalTenantId(userId?: number, tenantId?: number | null): number | undefined {
  if (hasValidTenantId(tenantId)) return tenantId;
  if (hasValidScopedUserId(userId)) return userId;
  return undefined;
}

function tableHasColumn(d: DbLike, table: string, column: string): boolean {
  try {
    return d.prepare(`PRAGMA table_info(${table})`).all().some((row: any) => row?.name === column);
  } catch {
    return false;
  }
}

function signalRequiresUserScope(signalType: SignalType): boolean {
  return !GLOBAL_SIGNAL_TYPES.has(signalType);
}

function reportScopeAnomaly(report: ScopeAnomalyReport): void {
  try {
    _reportScopeAnomaly?.(report);
  } catch {
    // Observability must never break signal reads/writes.
  }
}

const SIGNAL_PROVENANCE_SOURCES = new Set<SignalProvenance['source']>([
  'runtime',
  'user-feedback',
  'measured-outcome',
  'trusted-external',
  'human-approved',
]);

// Producer identities are deliberately independent of package versions. A
// producer must advance this suffix whenever the meaning of its signal output
// changes, for example `weekly-plan-orchestrator.v2`.
const VERSIONED_SIGNAL_PRODUCER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}[.-]v[1-9]\d*$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && ISO_TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function isValidSignalProvenance(value: unknown): value is SignalProvenance {
  if (value == null || typeof value !== 'object') return false;
  const provenance = value as Partial<SignalProvenance>;
  return typeof provenance.producerVersion === 'string'
    && VERSIONED_SIGNAL_PRODUCER_PATTERN.test(provenance.producerVersion)
    && typeof provenance.source === 'string'
    && SIGNAL_PROVENANCE_SOURCES.has(provenance.source as SignalProvenance['source'])
    && isValidIsoTimestamp(provenance.observedAt);
}

function governedSignalInvariantFailure(
  signal: GovernedSignalWriteInput,
): GovernedSignalWriteErrorCode | null {
  if (!isValidSignalProvenance(signal.provenance)) return 'invalid_provenance';

  if (signal.confidence !== undefined
    && (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1)) {
    return 'invalid_confidence';
  }

  if (signal.tenant_id !== undefined && !hasValidTenantId(signal.tenant_id)) {
    return 'invalid_tenant_scope';
  }

  const requiresUserScope = signalRequiresUserScope(signal.signal_type);
  if (requiresUserScope && !hasValidScopedUserId(signal.user_id)) return 'missing_user_scope';
  if (!requiresUserScope && signal.user_id !== undefined) return 'unexpected_user_scope';

  if (signal.expires_at !== undefined) {
    if (!isValidIsoTimestamp(signal.expires_at)) return 'invalid_expiry';
    const expiresAt = Date.parse(signal.expires_at);
    const observedAt = Date.parse(signal.provenance.observedAt);
    if (expiresAt <= observedAt || expiresAt <= Date.now()) return 'expired_signal';
  }

  return null;
}

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Write a new signal to the bus through the legacy compatibility path.
 * Returns the signal ID, or -1 on failure.
 *
 * Content mesh signals (channel-wide truths) leave `user_id` undefined
 * and write as GLOBAL rows. Training signals MUST pass a user_id so the
 * bus can isolate one user's training state from another's.
 *
 * @deprecated Legacy/test compatibility only. Production callers must use
 * `writeGovernedSignal`, which requires and validates explicit provenance.
 */
export function writeSignal(signal: SignalWriteInput): number {
  return writeSignalInternal(signal);
}

/**
 * Write a governed signal with explicit, versioned provenance.
 *
 * Invalid provenance, scope, confidence, or expiry data is rejected before
 * persistence. Runtime producers must use `source: 'runtime'` unless they
 * genuinely possess one of the stronger evidence classes.
 */
export function writeGovernedSignal(signal: GovernedSignalWriteInput, database?: DbLike): number {
  const validationFailure = governedSignalInvariantFailure(signal);
  if (validationFailure) {
    if (
      validationFailure === 'invalid_tenant_scope'
      || validationFailure === 'missing_user_scope'
      || validationFailure === 'unexpected_user_scope'
    ) {
      reportScopeAnomaly({
        layer: 'intelligence_bus',
        operation: 'write_signal',
        reason: validationFailure === 'invalid_tenant_scope'
          ? 'invalid_user_scope'
          : validationFailure,
        userId: signal.user_id ?? null,
        signalType: signal.signal_type,
        details: {
          sourceAgent: signal.source_agent,
          governedWrite: true,
          validationFailure,
        },
      });
    }
    throw new GovernedSignalWriteError(validationFailure, signal);
  }

  const signalId = writeSignalInternal(signal, database);
  if (signalId < 1) {
    throw new GovernedSignalWriteError('write_rejected', signal);
  }
  return signalId;
}

function writeSignalInternal(signal: SignalWriteInput, database?: DbLike): number {
  const d = database ?? db();
  if (!d) return -1;
  try {
    if (!isAllowedSignalSourceAgent(signal.source_agent)) {
      reportScopeAnomaly({
        layer: 'intelligence_bus',
        operation: 'write_signal',
        reason: 'invalid_user_scope',
        userId: signal.user_id ?? null,
        signalType: signal.signal_type,
        details: {
          sourceAgent: signal.source_agent,
          invalidSourceAgent: true,
        },
      });
      return -1;
    }

    const requiresUserScope = signalRequiresUserScope(signal.signal_type);
    const scopedUserId = hasValidScopedUserId(signal.user_id) ? signal.user_id : undefined;
    const hasTenantColumn = tableHasColumn(d, 'agent_signals', 'tenant_id');
    const hasSignalIdentityColumn = tableHasColumn(d, 'agent_signals', 'signal_identity');
    const hasProvenanceColumn = tableHasColumn(d, 'agent_signals', 'provenance_json');
    const scopedTenantId = resolveSignalTenantId(scopedUserId, signal.tenant_id);

    if (requiresUserScope && (scopedUserId == null || scopedTenantId == null)) {
      reportScopeAnomaly({
        layer: 'intelligence_bus',
        operation: 'write_signal',
        reason: signal.user_id == null || signal.tenant_id == null ? 'missing_user_scope' : 'invalid_user_scope',
        userId: signal.user_id ?? null,
        signalType: signal.signal_type,
        details: {
          sourceAgent: signal.source_agent,
        },
      });
      return -1;
    }

    if (!requiresUserScope && signal.user_id != null) {
      reportScopeAnomaly({
        layer: 'intelligence_bus',
        operation: 'write_signal',
        reason: 'unexpected_user_scope',
        userId: signal.user_id,
        signalType: signal.signal_type,
        details: {
          sourceAgent: signal.source_agent,
        },
      });
    }

    const priority = signal.priority || 'normal';
    const expiryHours = EXPIRY_HOURS[signal.signal_type] || 7 * 24;
    const expires_at = signal.expires_at ||
      new Date(Date.now() + expiryHours * 3600_000).toISOString();
    const normalizedUserId = requiresUserScope ? scopedUserId! : null;
    const normalizedTenantId = hasTenantColumn ? (scopedTenantId ?? null) : undefined;
    const provenance: SignalProvenance = signal.provenance ?? {
      producerVersion: 'legacy-unknown',
      source: 'runtime',
      observedAt: new Date().toISOString(),
    };
    const persistedPayload = { ...signal.payload, _signalProvenance: provenance };
    const signalIdentity = createSignalIdentity({
      sourceAgent: signal.source_agent,
      signalType: signal.signal_type,
      payload: signal.payload,
      tenantId: normalizedTenantId ?? null,
      userId: normalizedUserId,
    });
    const columns = [
      'source_agent',
      'signal_type',
      'payload',
      'priority',
      'expires_at',
    ];
    const values: unknown[] = [
      signal.source_agent,
      signal.signal_type,
      JSON.stringify(persistedPayload),
      priority,
      expires_at,
    ];
    if (hasTenantColumn) {
      columns.push('tenant_id');
      values.push(normalizedTenantId);
    }
    columns.push(
      'user_id',
      'confidence',
      'format_tag',
      'pillar_tag',
      'evidence_count',
      'mesh_priority',
    );
    values.push(
      normalizedUserId,
      signal.confidence ?? 0.5,
      signal.format_tag ?? null,
      signal.pillar_tag ?? null,
      signal.evidence_count ?? 1,
      signal.meshPriority ?? null,
    );
    if (hasSignalIdentityColumn) {
      columns.push('signal_identity');
      values.push(signalIdentity);
    }
    if (hasProvenanceColumn) {
      columns.push('provenance_json');
      values.push(JSON.stringify(provenance));
    }
    const result = d.prepare(`
      INSERT INTO agent_signals (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `).run(...values);
    const meshPriority = signal.meshPriority ?? null;
    if (meshPriority === 1) {
      if (_invalidatePlanningCaches) {
        _invalidatePlanningCaches(normalizedUserId ?? undefined);
      }
    }
    return (result as any).lastInsertRowid ?? -1;
  } catch {
    return -1;
  }
}

/**
 * Read active signals of the given types that haven't been consumed by this consumer.
 *
 * If `userId` is passed, results are filtered to GLOBAL signals (user_id IS NULL)
 * PLUS signals owned by that specific user. This is the path training coaches
 * take — they isolate one athlete's state from another while still picking up
 * any globally relevant content.
 *
 * If `userId` is omitted (default), only GLOBAL signals are returned. This
 * preserves existing content-agent behavior — no agent that passes `undefined`
 * for userId accidentally sees another user's training data.
 */
export function readSignals(
  consumer: string,
  signalTypes: SignalType[],
  limit = 50,
  userId?: number,
  maxAgeDays?: number,
  tenantId?: number,
): AgentSignal[] {
  const d = db();
  if (!d) return [];
  try {
    const placeholders = signalTypes.map(() => '?').join(',');
    const scopedUserId = hasValidScopedUserId(userId) ? userId : undefined;
    const hasTenantColumn = tableHasColumn(d, 'agent_signals', 'tenant_id');
    const scopedTenantId = resolveSignalTenantId(scopedUserId, tenantId);
    if (userId !== undefined && scopedUserId == null) {
      reportScopeAnomaly({
        layer: 'intelligence_bus',
        operation: 'read_signals',
        reason: 'invalid_user_scope',
        userId: userId ?? null,
        details: {
          consumer,
          signalTypes,
        },
      });
    }
    const scopeClauses: string[] = [];
    const scopeParams: any[] = [];
    if (hasTenantColumn) {
      if (scopedTenantId !== undefined) {
        scopeClauses.push('AND (tenant_id IS NULL OR tenant_id = ?)');
        scopeParams.push(scopedTenantId);
        scopeClauses.push(scopedUserId !== undefined ? 'AND (user_id IS NULL OR user_id = ?)' : 'AND user_id IS NULL');
        if (scopedUserId !== undefined) scopeParams.push(scopedUserId);
      } else {
        scopeClauses.push('AND tenant_id IS NULL AND user_id IS NULL');
      }
    } else {
      scopeClauses.push(scopedUserId !== undefined ? 'AND (user_id IS NULL OR user_id = ?)' : 'AND user_id IS NULL');
      if (scopedUserId !== undefined) scopeParams.push(scopedUserId);
    }
    // Capture one application clock value for the whole read. SQLite's
    // `now` is independent from the injected/fake JavaScript clock used by
    // request-scoped planning, which could otherwise make a freshly written
    // signal appear expired during deterministic midnight/DST evaluation.
    const readAt = new Date();
    const readAtIso = readAt.toISOString();
    const maxAgeCutoffIso = maxAgeDays != null && maxAgeDays > 0
      ? new Date(readAt.getTime() - Math.floor(maxAgeDays) * 86_400_000).toISOString()
      : null;
    const ageClause = maxAgeCutoffIso ? 'AND created_at > ?' : '';
    const params: any[] = [readAtIso, ...signalTypes];
    params.push(...scopeParams);
    if (maxAgeCutoffIso) params.push(maxAgeCutoffIso);
    params.push(limit);

    const rows = d.prepare(`
      SELECT * FROM agent_signals
      WHERE status = 'active'
        AND julianday(expires_at) > julianday(?)
        AND signal_type IN (${placeholders})
        ${scopeClauses.join('\n        ')}
        ${ageClause}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT ?
    `).all(...params) as any[];

    return rows
      .map(parseSignalRow)
      .filter(s => !s.consumed_by.includes(consumer));
  } catch {
    return [];
  }
}

/**
 * Mark a signal as consumed by a specific consumer.
 * The signal stays active — other consumers can still read it.
 */
export function markConsumed(signalId: number, consumer: string): void {
  const d = db();
  if (!d) return;
  try {
    const row = d.prepare('SELECT consumed_by FROM agent_signals WHERE id = ?').get(signalId) as any;
    if (!row) return;
    const consumed: string[] = JSON.parse(row.consumed_by || '[]');
    if (!consumed.includes(consumer)) consumed.push(consumer);
    d.prepare('UPDATE agent_signals SET consumed_by = ? WHERE id = ?')
      .run(JSON.stringify(consumed), signalId);
  } catch { /* non-critical */ }
}

/**
 * Dismiss a signal (manual override from Mission Control).
 */
export function dismissSignal(signalId: number, userId?: number, tenantId?: number): number {
  const d = db();
  if (!d) return 0;
  try {
    const hasTenantColumn = tableHasColumn(d, 'agent_signals', 'tenant_id');
    if (hasTenantColumn) {
      if (userId === undefined) {
        if (tenantId === undefined) {
          const result = d.prepare(`
            UPDATE agent_signals
            SET status = 'dismissed'
            WHERE id = ?
              AND tenant_id IS NULL
              AND user_id IS NULL
          `).run(signalId);
          return (result as any).changes ?? 0;
        }
        if (!hasValidTenantId(tenantId)) return 0;
        const result = d.prepare(`
          UPDATE agent_signals
          SET status = 'dismissed'
          WHERE id = ?
            AND tenant_id = ?
            AND user_id IS NULL
        `).run(signalId, tenantId);
        return (result as any).changes ?? 0;
      }
      if (!hasValidScopedUserId(userId)) return 0;
      const scopedTenantId = resolveSignalTenantId(userId, tenantId);
      if (scopedTenantId === undefined) return 0;
      const result = d.prepare(`
        UPDATE agent_signals
        SET status = 'dismissed'
        WHERE id = ?
          AND tenant_id = ?
          AND (user_id IS NULL OR user_id = ?)
      `).run(signalId, scopedTenantId, userId);
      return (result as any).changes ?? 0;
    }
    if (userId !== undefined) {
      const result = d.prepare(`
        UPDATE agent_signals
        SET status = 'dismissed'
        WHERE id = ?
          AND (user_id IS NULL OR user_id = ?)
      `).run(signalId, userId);
      return (result as any).changes ?? 0;
    }
    const result = d.prepare("UPDATE agent_signals SET status = 'dismissed' WHERE id = ? AND user_id IS NULL").run(signalId);
    return (result as any).changes ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Expire stale signals. Run on startup and hourly.
 * Returns count of expired signals.
 */
export function expireStaleSignals(): number {
  const d = db();
  if (!d) return 0;
  try {
    const result = d.prepare(`
      UPDATE agent_signals
      SET status = 'expired'
      WHERE status = 'active'
        AND julianday(expires_at) <= julianday('now')
    `).run();
    return (result as any).changes ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get count of active signals.
 */
export function getActiveSignalCount(userId?: number, tenantId?: number): number {
  const d = db();
  if (!d) return 0;
  try {
    const hasTenantColumn = tableHasColumn(d, 'agent_signals', 'tenant_id');
    const clauses = ["status = 'active'", "julianday(expires_at) > julianday('now')"];
    const params: any[] = [];
    if (hasTenantColumn) {
      const scopedTenantId = resolveSignalTenantId(userId, tenantId);
      if (scopedTenantId !== undefined) {
        clauses.push('tenant_id = ?');
        params.push(scopedTenantId);
        clauses.push(userId !== undefined ? '(user_id IS NULL OR user_id = ?)' : 'user_id IS NULL');
        if (userId !== undefined) params.push(userId);
      } else {
        clauses.push('tenant_id IS NULL');
        clauses.push('user_id IS NULL');
      }
    } else if (userId !== undefined) {
      clauses.push('(user_id IS NULL OR user_id = ?)');
      params.push(userId);
    } else {
      clauses.push('user_id IS NULL');
    }
    const row = d.prepare(`SELECT COUNT(*) as cnt FROM agent_signals WHERE ${clauses.join(' AND ')}`).get(...params) as any;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get recent signal log (for Mission Control).
 */
export function getSignalLog(limit = 100, userId?: number, tenantId?: number): AgentSignal[] {
  const d = db();
  if (!d) return [];
  try {
    const hasTenantColumn = tableHasColumn(d, 'agent_signals', 'tenant_id');
    const clauses: string[] = [];
    const params: any[] = [];
    if (hasTenantColumn) {
      const scopedTenantId = resolveSignalTenantId(userId, tenantId);
      if (scopedTenantId !== undefined) {
        clauses.push('tenant_id = ?');
        params.push(scopedTenantId);
        clauses.push(userId !== undefined ? '(user_id IS NULL OR user_id = ?)' : 'user_id IS NULL');
        if (userId !== undefined) params.push(userId);
      } else {
        clauses.push('tenant_id IS NULL');
        clauses.push('user_id IS NULL');
      }
    } else if (userId !== undefined) {
      clauses.push('(user_id IS NULL OR user_id = ?)');
      params.push(userId);
    } else {
      clauses.push('user_id IS NULL');
    }
    params.push(limit);
    const rows = d.prepare(`
      SELECT * FROM agent_signals
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as any[];
    return rows.map(parseSignalRow);
  } catch {
    return [];
  }
}

/**
 * Get agent stats (last run, signal counts, status).
 */
export function getAgentStats(): {
  agent: string;
  last_run: string | null;
  last_status: string;
  signals_produced: number;
  total_runs: number;
}[] {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(`
      SELECT
        agent_name as agent,
        MAX(created_at) as last_run,
        (SELECT status FROM agent_runs r2 WHERE r2.agent_name = r1.agent_name ORDER BY created_at DESC LIMIT 1) as last_status,
        SUM(signals_produced) as signals_produced,
        COUNT(*) as total_runs
      FROM agent_runs r1
      GROUP BY agent_name
      ORDER BY last_run DESC
    `).all() as any[];
  } catch {
    return [];
  }
}

/**
 * Log an agent run to the agent_runs table.
 */
export function logAgentRun(
  agentName: string,
  status: 'success' | 'error' | 'skipped',
  signalsProduced: number,
  signalsConsumed: number,
  durationMs: number,
  errorMessage?: string,
): void {
  const d = db();
  if (!d) return;
  try {
    d.prepare(`
      INSERT INTO agent_runs (agent_name, status, signals_produced, signals_consumed, duration_ms, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(agentName, status, signalsProduced, signalsConsumed, durationMs, errorMessage ?? null);
  } catch { /* non-critical */ }
}

// ─── Helpers ────────────────────────────────────────────────────────

function parseSignalRow(row: any): AgentSignal {
  const storedPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const { _signalProvenance, ...payload } = storedPayload ?? {};
  const persistedProvenance = parsePersistedSignalProvenance(row.provenance_json)
    ?? parsePersistedSignalProvenance(_signalProvenance)
    ?? {
      producerVersion: 'legacy-unknown',
      source: 'runtime' as const,
      observedAt: row.created_at,
    };
  return {
    id: row.id,
    source_agent: row.source_agent,
    signal_type: row.signal_type,
    payload,
    priority: row.priority,
    consumed_by: typeof row.consumed_by === 'string' ? JSON.parse(row.consumed_by) : row.consumed_by,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    user_id: row.user_id ?? null,
    tenant_id: row.tenant_id ?? null,
    signal_identity: typeof row.signal_identity === 'string' && row.signal_identity.length > 0
      ? row.signal_identity
      : null,
    confidence: row.confidence ?? 0.5,
    format_tag: row.format_tag ?? null,
    pillar_tag: row.pillar_tag ?? null,
    evidence_count: row.evidence_count ?? 1,
    provenance: persistedProvenance,
    meshPriority: row.mesh_priority ?? undefined,
  };
}

function createSignalIdentity(input: {
  sourceAgent: string;
  signalType: SignalType;
  payload: Record<string, any>;
  tenantId: number | null;
  userId: number | null;
}): string {
  const material = stableSignalStringify({
    payload: input.payload,
    scope: { tenantId: input.tenantId, userId: input.userId },
    signalType: input.signalType,
    sourceAgent: input.sourceAgent,
  });
  return `sig_${createHash('sha256').update(material).digest('hex')}`;
}

function stableSignalStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(stableSignalStringify).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSignalStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function parsePersistedSignalProvenance(value: unknown): SignalProvenance | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<SignalProvenance>;
  if (
    typeof candidate.producerVersion !== 'string'
    || candidate.producerVersion.length === 0
    || candidate.producerVersion.length > 128
    || typeof candidate.source !== 'string'
    || !SIGNAL_PROVENANCE_SOURCES.has(candidate.source as SignalProvenance['source'])
    || !isValidIsoTimestamp(candidate.observedAt)
  ) {
    return null;
  }
  return {
    producerVersion: candidate.producerVersion,
    source: candidate.source as SignalProvenance['source'],
    observedAt: candidate.observedAt,
  };
}

// ─── Ranked Signal Reader ──────────────────────────────────────────
//
// Unlike readSignals() which returns flat results ordered by priority
// then creation time, readRankedSignals() computes a relevance score
// for each signal: confidence × freshness × priority_weight.
//
// This is the primary read path for content-intelligence consumers
// that need the BEST signals, not just the newest.

const PRIORITY_WEIGHT: Record<string, number> = {
  urgent: 1.0,
  normal: 0.7,
  background: 0.3,
};

/**
 * Compute freshness score: exponential decay from 1.0 (just created)
 * toward 0.0 as the signal approaches its expiry. Signals past 90%
 * of their TTL score below 0.1.
 */
function freshnessScore(createdAt: string, expiresAt: string): number {
  const created = new Date(createdAt).getTime();
  const expires = new Date(expiresAt).getTime();
  const now = Date.now();

  if (expires <= created) return 0; // guard against bad data
  const totalLife = expires - created;
  const age = now - created;
  const pctRemaining = Math.max(0, 1 - age / totalLife);

  // Exponential decay curve: fresh signals keep high score,
  // stale signals drop sharply
  return Math.pow(pctRemaining, 0.5);
}

/**
 * Read signals ranked by relevance = confidence × freshness × priority.
 *
 * Optional filters:
 *   - pillar: only signals tagged with this pillar (or untagged)
 *   - format: only signals tagged with this format (or untagged)
 *   - minConfidence: floor (default 0.1 — filter out noise)
 *
 * Returns RankedSignal[] sorted by relevanceScore DESC.
 */
export function readRankedSignals(
  consumer: string,
  signalTypes: SignalType[],
  opts: {
    limit?: number;
    userId?: number;
    tenantId?: number;
    pillar?: string;
    format?: string;
    minConfidence?: number;
  } = {},
): RankedSignal[] {
  const d = db();
  if (!d) return [];

  const limit = opts.limit ?? 20;
  const minConfidence = opts.minConfidence ?? 0.1;

  try {
    const placeholders = signalTypes.map(() => '?').join(',');
    const clauses: string[] = [
      "status = 'active'",
      "julianday(expires_at) > julianday('now')",
      `signal_type IN (${placeholders})`,
      `confidence >= ?`,
    ];
    const params: any[] = [...signalTypes, minConfidence];

    // Tenant/user scoping
    const hasTenantColumn = tableHasColumn(d, 'agent_signals', 'tenant_id');
    const scopedTenantId = resolveSignalTenantId(opts.userId, opts.tenantId);
    if (hasTenantColumn) {
      if (scopedTenantId !== undefined) {
        clauses.push('tenant_id = ?');
        params.push(scopedTenantId);
        clauses.push(opts.userId !== undefined ? '(user_id IS NULL OR user_id = ?)' : 'user_id IS NULL');
        if (opts.userId !== undefined) params.push(opts.userId);
      } else {
        clauses.push('tenant_id IS NULL');
        clauses.push('user_id IS NULL');
      }
    } else if (opts.userId !== undefined) {
      clauses.push('(user_id IS NULL OR user_id = ?)');
      params.push(opts.userId);
    } else {
      clauses.push('user_id IS NULL');
    }

    // Pillar filter (include untagged signals too)
    if (opts.pillar) {
      clauses.push('(pillar_tag IS NULL OR pillar_tag = ?)');
      params.push(opts.pillar);
    }

    // Format filter (include untagged signals too)
    if (opts.format) {
      clauses.push('(format_tag IS NULL OR format_tag = ?)');
      params.push(opts.format);
    }

    // Fetch more than needed, then rank and trim
    params.push(limit * 3);

    const rows = d.prepare(`
      SELECT * FROM agent_signals
      WHERE ${clauses.join(' AND ')}
      ORDER BY confidence DESC, created_at DESC
      LIMIT ?
    `).all(...params) as any[];

    const signals = rows
      .map(parseSignalRow)
      .filter(s => !s.consumed_by.includes(consumer));

    // Compute relevance scores
    const ranked: RankedSignal[] = signals.map(s => {
      const fresh = freshnessScore(s.created_at, s.expires_at);
      const priorityW = PRIORITY_WEIGHT[s.priority] ?? 0.5;
      const ageMs = Date.now() - new Date(s.created_at).getTime();

      return {
        ...s,
        relevanceScore: Math.round(s.confidence * fresh * priorityW * 1000) / 1000,
        ageHours: Math.round(ageMs / 3600_000 * 10) / 10,
      };
    });

    // Sort by relevance score DESC, then confidence DESC
    ranked.sort((a, b) => b.relevanceScore - a.relevanceScore || b.confidence - a.confidence);

    return ranked.slice(0, limit);
  } catch {
    return [];
  }
}

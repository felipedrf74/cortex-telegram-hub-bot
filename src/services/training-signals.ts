// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training Signals Service — Phase 1 Slice B
 *
 * Typed wrapper around the generic intelligence-bus for the cross-sport
 * training signal flows. This file is what every sport coach, garmin
 * sync, and secretary calendar code should import — it hides the bus
 * primitives behind domain-meaningful names like `publishLegFatigue()`
 * or `readTrainingContext()`.
 *
 * Three cross-skill signal flows live here (Phase 1 decision 1.4 — the
 * user said "all 3, this is a must for our product"):
 *
 *   A. Leg fatigue  : gym coach → running/cycle coach
 *      gym publishes `high_leg_load` after heavy squats/deads at RPE >= 8,
 *      running + cycle coaches read it before prescribing for today/tomorrow.
 *
 *   B. Sleep/readiness : wellness (Garmin) → all sport coaches
 *      garmin sync publishes `low_sleep` / `low_hrv` / `low_readiness`
 *      when nightly sync pulls a poor reading. Any coach reads before
 *      generating a prescription and downgrades intensity.
 *
 *   C. Calendar conflict : sport coach → secretary (and back)
 *      sport coach publishes `training_session_scheduled` after adding
 *      a session to the calendar. Secretary reads these when checking
 *      for conflicts with user-created events and publishes
 *      `calendar_conflict` back.
 *
 * All signals here are PER-USER — they carry a userId and readers filter
 * to their own user. The content mesh agents are unaffected; they still
 * use the generic bus with global signals.
 */

import {
  writeSignal,
  readSignals,
  markConsumed,
  type SignalType,
  type AgentSignal,
  type SignalPriority,
} from './intelligence-bus';
import { isTrainingCrossSkillSignalsEnabled } from './training-operational-switches';
import { logger } from '../utils/logger';

// ─── Source identifiers ─────────────────────────────────────────────

/** Stable source identifiers so readers can filter / consumers can attribute. */
export const TRAINING_SOURCE = {
  GYM_COACH: 'triathlon.gym',
  RUNNING_COACH: 'triathlon.running',
  CYCLE_COACH: 'triathlon.cycle',
  SWIM_COACH: 'triathlon.swim',
  WELLNESS_SYNC: 'garmin.sync',
  SECRETARY_CALENDAR: 'secretary.calendar',
  COOKING_FUELING: 'cooking.fueling',
  FINANCE_PLANNING: 'finance.training',
} as const;

export type TrainingSource = (typeof TRAINING_SOURCE)[keyof typeof TRAINING_SOURCE];

function writeTrainingSignal(signal: Parameters<typeof writeSignal>[0]): number {
  if (!isTrainingCrossSkillSignalsEnabled()) {
    logger.warn(
      {
        userId: signal.user_id,
        sourceAgent: signal.source_agent,
        signalType: signal.signal_type,
      },
      'Training cross-skill signal skipped by operational switch',
    );
    return -1;
  }
  return writeSignal(signal);
}

// ─── Publisher helpers (write path) ─────────────────────────────────

/**
 * Publish a generic load-marker signal after a session completes.
 * The sport coach calls this on session log. Downstream coaches use it
 * to decide whether to downgrade tomorrow's prescription.
 */
export function publishSessionLoad(opts: {
  userId: number;
  sport: 'gym' | 'running' | 'cycling' | 'swim';
  rpe: number;                    // 1-10 perceived exertion
  duration_min?: number;
  distance_km?: number;
  notes?: string;
}): number {
  const signalType: SignalType =
    opts.sport === 'gym' ? 'gym_load_today'
    : opts.sport === 'running' ? 'running_load_today'
    : opts.sport === 'cycling' ? 'cycling_load_today'
    : 'swim_load_today';

  const source: TrainingSource =
    opts.sport === 'gym' ? TRAINING_SOURCE.GYM_COACH
    : opts.sport === 'running' ? TRAINING_SOURCE.RUNNING_COACH
    : opts.sport === 'cycling' ? TRAINING_SOURCE.CYCLE_COACH
    : TRAINING_SOURCE.SWIM_COACH;

  return writeTrainingSignal({
    source_agent: source,
    signal_type: signalType,
    payload: {
      sport: opts.sport,
      rpe: opts.rpe,
      duration_min: opts.duration_min,
      distance_km: opts.distance_km,
      notes: opts.notes,
    },
    user_id: opts.userId,
    priority: 'normal',
  });
}

/**
 * Publish signal A: high leg load — a heavy squat/deadlift/lunge session
 * that will interfere with tomorrow's run or ride. Only fires at RPE >= 8.
 */
export function publishHighLegLoad(opts: {
  userId: number;
  tenantId?: number;
  source: 'gym' | 'running';
  rpe: number;
  details?: { lifts?: string[]; mileage?: number; notes?: string };
}): number {
  if (opts.rpe < 8) {
    logger.debug({ userId: opts.userId, rpe: opts.rpe }, 'RPE below threshold, not publishing high_leg_load');
    return -1;
  }
  return writeTrainingSignal({
    source_agent: opts.source === 'gym' ? TRAINING_SOURCE.GYM_COACH : TRAINING_SOURCE.RUNNING_COACH,
    signal_type: 'high_leg_load',
    payload: { source: opts.source, rpe: opts.rpe, ...opts.details },
    user_id: opts.userId,
    tenant_id: opts.tenantId,
    priority: 'urgent',
  });
}

/**
 * Publish signal from the gym coach when a shoulder-heavy session is logged.
 * Swim coach reads this to avoid paddle work the next day.
 */
export function publishHighShoulderLoad(opts: {
  userId: number;
  rpe: number;
  details?: { lifts?: string[]; notes?: string };
}): number {
  if (opts.rpe < 8) return -1;
  return writeTrainingSignal({
    source_agent: TRAINING_SOURCE.GYM_COACH,
    signal_type: 'high_shoulder_load',
    payload: { rpe: opts.rpe, ...opts.details },
    user_id: opts.userId,
    priority: 'urgent',
  });
}

/**
 * Publish signal B part 1: low sleep. Called from the Garmin sync
 * when the nightly sleep score drops below a threshold.
 */
export function publishLowSleep(opts: {
  userId: number;
  score: number;          // 0-100 Garmin sleep score (or 0-100 normalized)
  totalHours?: number;
  source?: string;        // defaults to WELLNESS_SYNC
}): number {
  return writeTrainingSignal({
    source_agent: opts.source ?? TRAINING_SOURCE.WELLNESS_SYNC,
    signal_type: 'low_sleep',
    payload: { score: opts.score, total_hours: opts.totalHours },
    user_id: opts.userId,
    priority: 'urgent',
  });
}

/**
 * Publish signal B part 2: low HRV (morning reading below baseline).
 */
export function publishLowHrv(opts: {
  userId: number;
  hrv_ms: number;
  baseline_ms: number;
  source?: string;
}): number {
  return writeTrainingSignal({
    source_agent: opts.source ?? TRAINING_SOURCE.WELLNESS_SYNC,
    signal_type: 'low_hrv',
    payload: { hrv_ms: opts.hrv_ms, baseline_ms: opts.baseline_ms, delta_pct: ((opts.hrv_ms - opts.baseline_ms) / opts.baseline_ms) * 100 },
    user_id: opts.userId,
    priority: 'urgent',
  });
}

/**
 * Publish signal B part 3: low Garmin training readiness (< 40 typically).
 */
export function publishLowReadiness(opts: {
  userId: number;
  score: number;
  reason?: string;
  source?: string;
}): number {
  return writeTrainingSignal({
    source_agent: opts.source ?? TRAINING_SOURCE.WELLNESS_SYNC,
    signal_type: 'low_readiness',
    payload: { score: opts.score, reason: opts.reason },
    user_id: opts.userId,
    priority: 'urgent',
  });
}

/**
 * Publish signal C part 1: sport coach just scheduled a training session
 * on the calendar. Secretary reads these to flag conflicts with user events.
 */
export function publishTrainingSessionScheduled(opts: {
  userId: number;
  sport: 'gym' | 'running' | 'cycling' | 'swim';
  sessionId: number | string;
  startTimeIso: string;
  endTimeIso: string;
  title: string;
  calendarEventId?: string;
}): number {
  const source: TrainingSource =
    opts.sport === 'gym' ? TRAINING_SOURCE.GYM_COACH
    : opts.sport === 'running' ? TRAINING_SOURCE.RUNNING_COACH
    : opts.sport === 'cycling' ? TRAINING_SOURCE.CYCLE_COACH
    : TRAINING_SOURCE.SWIM_COACH;

  return writeTrainingSignal({
    source_agent: source,
    signal_type: 'training_session_scheduled',
    payload: {
      sport: opts.sport,
      session_id: opts.sessionId,
      start: opts.startTimeIso,
      end: opts.endTimeIso,
      title: opts.title,
      calendar_event_id: opts.calendarEventId,
    },
    user_id: opts.userId,
    priority: 'normal',
    expires_at: opts.endTimeIso, // expire when session itself is over
  });
}

// ─── Phase 4 Slice C — Adherence publishers ─────────────────────

/**
 * Publish `low_adherence` — the user has completed fewer than 60% of
 * planned sessions this week. Sport coaches read this to suggest a
 * deload, check in on motivation, or adjust the plan.
 *
 * Urgent priority because a missed-session pattern is time-sensitive:
 * the longer the coach waits to acknowledge it, the further the user
 * drifts. Re-publishing is the caller's responsibility — the
 * adherence-signals orchestrator checks for existing active rows.
 */
export function publishLowAdherence(opts: {
  userId: number;
  completed: number;
  planned: number;
  weekStart: string;
  weekEnd: string;
  reason?: string;
}): number {
  return writeTrainingSignal({
    source_agent: 'session.analytics',
    signal_type: 'low_adherence',
    payload: {
      completed: opts.completed,
      planned: opts.planned,
      adherence_pct: opts.planned > 0
        ? Math.round((opts.completed / opts.planned) * 100)
        : 0,
      week_start: opts.weekStart,
      week_end: opts.weekEnd,
      reason: opts.reason ?? null,
    },
    user_id: opts.userId,
    priority: 'urgent',
  });
}

/**
 * Publish `high_adherence` — the user has hit 100% of planned sessions
 * this week AND the plan had at least 3 sessions (so a 1/1 week
 * doesn't trigger false positives). Sport coaches read this to push
 * harder, add volume, or congratulate the user.
 */
export function publishHighAdherence(opts: {
  userId: number;
  completed: number;
  planned: number;
  weekStart: string;
  weekEnd: string;
}): number {
  return writeTrainingSignal({
    source_agent: 'session.analytics',
    signal_type: 'high_adherence',
    payload: {
      completed: opts.completed,
      planned: opts.planned,
      adherence_pct: 100,
      week_start: opts.weekStart,
      week_end: opts.weekEnd,
    },
    user_id: opts.userId,
    priority: 'normal',
  });
}

// ─── Phase 4 Slice G — Plan drift publisher ─────────────────────

/**
 * Publish `plan_drift` — the user's actual sport distribution in
 * recent completions diverges significantly from the sport their
 * active plan is built around.
 *
 * Example payload shapes:
 *
 *   { plan_sport: 'strength', dominant_sport: 'running', drift_pct: 78 }
 *   → user has a strength plan but 78% of last 4 weeks were runs.
 *
 *   { plan_sport: 'hybrid', dominant_sport: 'running', drift_pct: 92 }
 *   → user's hybrid plan is supposed to be balanced, but 92% of
 *     sessions in the last 4 weeks have been running.
 *
 * Normal priority (not urgent) — plan drift is a slow-moving
 * pattern, not a same-day intervention. Sport coaches read this
 * before generating their next prescription so they can decide
 * whether to nudge the user back to balance or pivot the plan.
 *
 * Idempotency is the caller's responsibility: the adherence
 * orchestrator in `adherence-signals.ts` checks for an existing
 * active `plan_drift` row before publishing a new one, so a user
 * who opens the training tab 20 times in an hour still only gets
 * one drift signal on the bus.
 */
export function publishPlanDrift(opts: {
  userId: number;
  planSport: string;
  dominantSport: string;
  driftPct: number;
  sessionsInWindow: number;
  windowWeeks: number;
  /** TTL in hours from now. Defaults to 48 so the signal refreshes
   *  every two days as new sessions land. */
  ttlHours?: number;
}): number {
  const ttl = opts.ttlHours ?? 48;
  return writeTrainingSignal({
    source_agent: 'session.analytics',
    signal_type: 'plan_drift',
    payload: {
      plan_sport: opts.planSport,
      dominant_sport: opts.dominantSport,
      drift_pct: Math.round(opts.driftPct),
      sessions_in_window: opts.sessionsInWindow,
      window_weeks: opts.windowWeeks,
    },
    user_id: opts.userId,
    priority: 'normal',
    expires_at: new Date(Date.now() + ttl * 3600 * 1000).toISOString(),
  });
}

/**
 * Publish signal C part 2: secretary detected a conflict between a user
 * event and a scheduled training session. Sport coaches read this next
 * time the user asks about today's plan.
 */
export function publishCalendarConflict(opts: {
  userId: number;
  trainingSessionId: number | string;
  conflictingEventId: string;
  conflictingEventTitle: string;
  overlapStartIso: string;
  overlapEndIso: string;
}): number {
  return writeTrainingSignal({
    source_agent: TRAINING_SOURCE.SECRETARY_CALENDAR,
    signal_type: 'calendar_conflict',
    payload: {
      training_session_id: opts.trainingSessionId,
      conflict_event_id: opts.conflictingEventId,
      conflict_event_title: opts.conflictingEventTitle,
      overlap_start: opts.overlapStartIso,
      overlap_end: opts.overlapEndIso,
    },
    user_id: opts.userId,
    priority: 'urgent',
  });
}

/**
 * Secretary/agenda lifecycle signal: the current training schedule no
 * longer matches calendar truth. Coaches should reflow/resync instead
 * of presenting the old plan as authoritative.
 */
export function publishTrainingScheduleStale(opts: {
  userId: number;
  reason: string;
  affectedSessionIds?: Array<number | string>;
  dates?: string[];
  source?: string;
  ttlHours?: number;
}): number {
  const ttl = opts.ttlHours ?? 24;
  return writeTrainingSignal({
    source_agent: opts.source ?? TRAINING_SOURCE.SECRETARY_CALENDAR,
    signal_type: 'training_schedule_stale',
    payload: {
      reason: opts.reason,
      affected_session_ids: opts.affectedSessionIds ?? [],
      dates: opts.dates ?? [],
      requires_reflow: true,
      requires_agenda_resync: true,
    },
    user_id: opts.userId,
    priority: 'urgent',
    expires_at: new Date(Date.now() + ttl * 3600 * 1000).toISOString(),
  });
}

/**
 * Cooking signal: planned training demand is not matched by meal/fueling
 * coverage. Training consumes this as one deduped input and can lower,
 * move, or request food prep instead of repeating generic fuel warnings.
 */
export function publishFuelingGapRisk(opts: {
  userId: number;
  hardDatesMissingMeals?: string[];
  trainingDatesMissingMeals?: string[];
  status?: 'partial' | 'at_risk' | 'unsupported';
  ttlHours?: number;
}): number {
  const ttl = opts.ttlHours ?? 48;
  const hardDates = opts.hardDatesMissingMeals ?? [];
  const trainingDates = opts.trainingDatesMissingMeals ?? [];
  return writeTrainingSignal({
    source_agent: TRAINING_SOURCE.COOKING_FUELING,
    signal_type: 'fueling_gap_risk',
    payload: {
      status: opts.status ?? (hardDates.length > 0 ? 'at_risk' : 'partial'),
      hard_dates_missing_meals: hardDates,
      training_dates_missing_meals: trainingDates,
    },
    user_id: opts.userId,
    priority: hardDates.length > 0 ? 'urgent' : 'normal',
    expires_at: new Date(Date.now() + ttl * 3600 * 1000).toISOString(),
  });
}

/**
 * Finance signal: training spend should respect current budget posture.
 * Coaches use this to avoid gear/subscription/supplement asks when the
 * Finance skill has already marked the month as constrained.
 */
export function publishTrainingBudgetConstraint(opts: {
  userId: number;
  month: string;
  budgetMode: 'tight' | 'controlled' | 'comfortable' | 'unknown';
  trainingSpendMode?: string;
  supplementMode?: string;
  remainingRatio?: number | null;
  ttlHours?: number;
}): number {
  const ttl = opts.ttlHours ?? 7 * 24;
  return writeTrainingSignal({
    source_agent: TRAINING_SOURCE.FINANCE_PLANNING,
    signal_type: 'budget_remaining',
    payload: {
      month: opts.month,
      budgetMode: opts.budgetMode,
      trainingSpendMode: opts.trainingSpendMode ?? null,
      supplementMode: opts.supplementMode ?? null,
      remainingRatio: opts.remainingRatio ?? null,
    },
    user_id: opts.userId,
    priority: opts.budgetMode === 'tight' ? 'urgent' : 'normal',
    expires_at: new Date(Date.now() + ttl * 3600 * 1000).toISOString(),
  });
}

// ─── Reader helpers (read path + consume) ───────────────────────────

/** Signals any sport coach should read before generating a prescription. */
const UNIVERSAL_COACH_INPUTS: SignalType[] = [
  'low_sleep',
  'low_hrv',
  'low_readiness',
  'planned_race_this_week',
  'calendar_conflict',
  'training_schedule_stale',
  'fueling_gap_risk',
  'budget_remaining',
  'subscription_renewal_due',
  'publishing_commitment',
  // Phase 4 Slice C — adherence flags inform intensity AND tone.
  // Every sport coach benefits from knowing the user is on-track or
  // off-track — they shape prescriptions AND check-in language.
  'low_adherence',
  'high_adherence',
  // Phase 4 Slice G — plan drift tells a coach "the user has been
  // doing a different sport than your plan prescribes". Every sport
  // coach should see this so they can either nudge the user back or
  // propose a plan pivot instead of blindly prescribing more of the
  // plan's sport.
  'plan_drift',
];

/** Additional signals specific to each sport coach. */
const SPORT_SPECIFIC_INPUTS: Record<'gym' | 'running' | 'cycling' | 'swim', SignalType[]> = {
  gym: [
    'running_load_today',
    'cycling_load_today',
  ],
  running: [
    'high_leg_load',
    'gym_load_today',
    'cycling_load_today',
    'planned_hard_ride',
  ],
  cycling: [
    'high_leg_load',
    'gym_load_today',
    'running_load_today',
    'planned_hard_run',
  ],
  swim: [
    'high_shoulder_load',
    'gym_load_today',
  ],
};

export interface TrainingContext {
  /** All matching signals, newest first, urgent first. */
  signals: AgentSignal[];
  /** Convenience booleans — set if any matching signal is active. */
  flags: {
    lowSleep: boolean;
    lowHrv: boolean;
    lowReadiness: boolean;
    highLegLoad: boolean;
    highShoulderLoad: boolean;
    raceThisWeek: boolean;
    /** Phase 4 Slice C — plan adherence flags. */
    lowAdherence: boolean;
    highAdherence: boolean;
    /** Phase 4 Slice G — plan drift flag. Set when the user's
     *  actual sport distribution diverges from the plan's sport. */
    planDrift: boolean;
    /** Secretary/agenda says the active schedule is stale or conflicted. */
    calendarConflict: boolean;
    scheduleStale: boolean;
    /** Cooking says planned training lacks meal/fueling support. */
    fuelingGap: boolean;
    /** Finance says training cost or supplement/equipment asks need constraint. */
    budgetConstraint: boolean;
    /** Content has a publishing or execution commitment Training should respect. */
    contentCommitment: boolean;
    /** Sum of RPE from load signals of OTHER sports today. */
    otherSportRpeToday: number;
  };
}

/**
 * Read the full training context for a sport coach. Call this ONCE per
 * message before generating a prescription. The returned object can be
 * serialized into the system prompt as a "current state" block.
 *
 * Does NOT mark signals as consumed — readTrainingContext is idempotent
 * so it's safe to call multiple times in one message. If you want to
 * acknowledge a signal so it stops appearing, call `consumeSignal()`.
 */
export function readTrainingContext(opts: {
  userId: number;
  sport: 'gym' | 'running' | 'cycling' | 'swim';
}): TrainingContext {
  const consumer = `triathlon.${opts.sport}`;
  const signalTypes: SignalType[] = [
    ...UNIVERSAL_COACH_INPUTS,
    ...SPORT_SPECIFIC_INPUTS[opts.sport],
  ];

  const signals = readSignals(consumer, signalTypes, 20, opts.userId);

  const flags = {
    lowSleep: signals.some((s) => s.signal_type === 'low_sleep'),
    lowHrv: signals.some((s) => s.signal_type === 'low_hrv'),
    lowReadiness: signals.some((s) => s.signal_type === 'low_readiness'),
    highLegLoad: signals.some((s) => s.signal_type === 'high_leg_load'),
    highShoulderLoad: signals.some((s) => s.signal_type === 'high_shoulder_load'),
    raceThisWeek: signals.some((s) => s.signal_type === 'planned_race_this_week'),
    lowAdherence: signals.some((s) => s.signal_type === 'low_adherence'),
    highAdherence: signals.some((s) => s.signal_type === 'high_adherence'),
    planDrift: signals.some((s) => s.signal_type === 'plan_drift'),
    calendarConflict: signals.some((s) => s.signal_type === 'calendar_conflict'),
    scheduleStale: signals.some((s) => s.signal_type === 'training_schedule_stale'),
    fuelingGap: signals.some((s) => s.signal_type === 'fueling_gap_risk'),
    budgetConstraint: signals.some((s) => s.signal_type === 'budget_remaining'),
    contentCommitment: signals.some((s) => s.signal_type === 'publishing_commitment'),
    otherSportRpeToday: signals
      .filter((s) => s.signal_type.endsWith('_load_today'))
      .reduce((sum, s) => sum + (Number(s.payload?.rpe) || 0), 0),
  };

  return { signals, flags };
}

/**
 * Universal reader — read ALL training signals for a user, across every
 * sport. Useful when the triathlon domain handler doesn't yet know which
 * sport persona the user's message targets and wants to inject the full
 * cross-skill state into the prompt.
 *
 * Returns the same TrainingContext shape as `readTrainingContext` so the
 * formatter can render either one identically.
 */
export function readTrainingContextAll(opts: { userId: number; tenantId?: number }): TrainingContext {
  const consumer = 'triathlon.all';
  const allTrainingSignalTypes: SignalType[] = [
    'low_sleep', 'low_hrv', 'low_readiness', 'planned_race_this_week',
    'gym_load_today', 'running_load_today', 'cycling_load_today', 'swim_load_today',
    'high_leg_load', 'high_shoulder_load',
    'planned_hard_run', 'planned_hard_ride',
    // Phase 4 Slice C — adherence signals are universal inputs.
    'low_adherence', 'high_adherence',
    // Phase 4 Slice G — plan drift universal input.
    'plan_drift',
    // Training-centered cross-skill orchestration inputs.
    'calendar_conflict', 'training_schedule_stale',
    'fueling_gap_risk',
    'budget_remaining', 'subscription_renewal_due',
    'publishing_commitment',
  ];
  const signals = readSignals(consumer, allTrainingSignalTypes, 40, opts.userId, undefined, opts.tenantId);

  const flags = {
    lowSleep: signals.some((s) => s.signal_type === 'low_sleep'),
    lowHrv: signals.some((s) => s.signal_type === 'low_hrv'),
    lowReadiness: signals.some((s) => s.signal_type === 'low_readiness'),
    highLegLoad: signals.some((s) => s.signal_type === 'high_leg_load'),
    highShoulderLoad: signals.some((s) => s.signal_type === 'high_shoulder_load'),
    raceThisWeek: signals.some((s) => s.signal_type === 'planned_race_this_week'),
    lowAdherence: signals.some((s) => s.signal_type === 'low_adherence'),
    highAdherence: signals.some((s) => s.signal_type === 'high_adherence'),
    planDrift: signals.some((s) => s.signal_type === 'plan_drift'),
    calendarConflict: signals.some((s) => s.signal_type === 'calendar_conflict'),
    scheduleStale: signals.some((s) => s.signal_type === 'training_schedule_stale'),
    fuelingGap: signals.some((s) => s.signal_type === 'fueling_gap_risk'),
    budgetConstraint: signals.some((s) => s.signal_type === 'budget_remaining'),
    contentCommitment: signals.some((s) => s.signal_type === 'publishing_commitment'),
    otherSportRpeToday: signals
      .filter((s) => s.signal_type.endsWith('_load_today'))
      .reduce((sum, s) => sum + (Number(s.payload?.rpe) || 0), 0),
  };

  return { signals, flags };
}

/**
 * Secretary reader: get all training sessions scheduled in a time window.
 * Secretary calendar code calls this before adding a user event to check
 * if it would collide with planned training.
 */
export function readScheduledTrainingSessions(opts: {
  userId: number;
  windowStartIso: string;
  windowEndIso: string;
}): AgentSignal[] {
  const consumer = TRAINING_SOURCE.SECRETARY_CALENDAR;
  const sessions = readSignals(consumer, ['training_session_scheduled'], 100, opts.userId);
  const winStart = Date.parse(opts.windowStartIso);
  const winEnd = Date.parse(opts.windowEndIso);
  return sessions.filter((s) => {
    const start = Date.parse(String(s.payload?.start ?? ''));
    const end = Date.parse(String(s.payload?.end ?? ''));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    // Overlap check: session overlaps window iff it ends after window start
    // AND starts before window end.
    return end > winStart && start < winEnd;
  });
}

/** Mark a signal as consumed by the given consumer. Thin pass-through. */
export function consumeSignal(signalId: number, consumer: string): void {
  markConsumed(signalId, consumer);
}

/**
 * Format a TrainingContext as a short, prompt-friendly block. Used by
 * the coach prompt injection layer — renders into the "current state"
 * portion of the system prompt so the LLM can see it plainly.
 */
export function formatTrainingContextForPrompt(ctx: TrainingContext, sport: string): string {
  if (ctx.signals.length === 0) {
    return `No cross-skill signals active for ${sport} right now.`;
  }
  const lines: string[] = [];
  lines.push(`<cross_skill_state sport="${sport}">`);
  if (ctx.flags.lowSleep) lines.push('- LOW SLEEP detected — downgrade intensity one notch.');
  if (ctx.flags.lowHrv) lines.push('- LOW HRV vs baseline — consider rest or easy work.');
  if (ctx.flags.lowReadiness) lines.push('- LOW training readiness — skip any planned hard session.');
  if (ctx.flags.highLegLoad) lines.push('- HIGH LEG LOAD recently — avoid heavy lower-body today.');
  if (ctx.flags.highShoulderLoad) lines.push('- HIGH SHOULDER LOAD recently — reduce overhead/paddle work.');
  if (ctx.flags.raceThisWeek) lines.push('- RACE THIS WEEK — taper, no new stimulus.');
  if (ctx.flags.calendarConflict) {
    const conflict = ctx.signals.find((s) => s.signal_type === 'calendar_conflict');
    const title = String(conflict?.payload?.conflict_event_title ?? 'calendar event');
    lines.push(`- CALENDAR CONFLICT — ${title} overlaps training. Reflow the session and resync agenda before claiming the schedule is final.`);
  }
  if (ctx.flags.scheduleStale) {
    const stale = ctx.signals.find((s) => s.signal_type === 'training_schedule_stale');
    const reason = String(stale?.payload?.reason ?? 'availability changed');
    lines.push(`- TRAINING SCHEDULE STALE — ${reason}. Do not show stale sessions as active; rebuild or resync the plan lifecycle first.`);
  }
  if (ctx.flags.fuelingGap) {
    const gap = ctx.signals.find((s) => s.signal_type === 'fueling_gap_risk');
    const hardDates = Array.isArray(gap?.payload?.hard_dates_missing_meals)
      ? gap.payload.hard_dates_missing_meals.filter((value): value is string => typeof value === 'string')
      : [];
    lines.push(
      hardDates.length > 0
        ? `- FUELING GAP — hard training lacks meal coverage on ${hardDates.join(', ')}. Move/lower the hard work or ask Cooking to cover prep; do not repeat generic fueling warnings.`
        : '- FUELING GAP — training-day meals are incomplete. Keep guidance concrete and deduped.',
    );
  }
  if (ctx.flags.budgetConstraint) {
    const budget = ctx.signals.find((s) => s.signal_type === 'budget_remaining');
    const mode = String(budget?.payload?.budgetMode ?? 'constrained');
    const trainingSpendMode = budget?.payload?.trainingSpendMode ? ` / training spend: ${budget.payload.trainingSpendMode}` : '';
    lines.push(`- FINANCE CONSTRAINT — budget mode is ${mode}${trainingSpendMode}. Avoid paid gear, subscriptions, and supplement asks unless explicitly needed.`);
  }
  if (ctx.flags.contentCommitment) {
    const commitment = ctx.signals.find((s) => s.signal_type === 'publishing_commitment');
    const date = commitment?.payload?.nextDate ? ` due ${commitment.payload.nextDate}` : '';
    lines.push(`- CONTENT COMMITMENT${date} — account for creator workload before adding hard doubles or high-friction training.`);
  }
  // Phase 4 Slice C — adherence adaptation cues
  if (ctx.flags.lowAdherence) {
    lines.push('- LOW ADHERENCE this week — do not add volume. Lead with empathy, offer a deload or shorter rescue session.');
  }
  if (ctx.flags.highAdherence) {
    lines.push('- CRUSHING IT — consistent week, small progressive overload is earned. Acknowledge briefly before prescribing.');
  }
  // Phase 4 Slice G — plan drift awareness. Render the specific
  // plan_sport / dominant_sport pair from the payload so the coach
  // can name exactly what the user has been doing instead.
  const driftSignal = ctx.signals.find((s) => s.signal_type === 'plan_drift');
  if (ctx.flags.planDrift && driftSignal) {
    const planSport = String(driftSignal.payload?.plan_sport ?? 'unknown');
    const dominant = String(driftSignal.payload?.dominant_sport ?? 'unknown');
    const pct = Math.round(Number(driftSignal.payload?.drift_pct ?? 0));
    lines.push(
      `- PLAN DRIFT — plan is ${planSport} but user has been ${pct}% ${dominant} over the last 4 weeks. Either rebalance the plan toward ${dominant} or name the drift and ask if they want to pivot.`,
    );
  }
  if (ctx.flags.otherSportRpeToday > 0) {
    lines.push(`- Sibling-sport RPE sum today: ${ctx.flags.otherSportRpeToday}. Factor this into volume.`);
  }
  lines.push('</cross_skill_state>');
  return lines.join('\n');
}

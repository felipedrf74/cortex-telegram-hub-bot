// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Signal Observability — Phase 3 Slice B
 *
 * Turns the internal cross-skill signal bus into a user-facing view.
 * The Phase 1 intelligence bus + Phase 2 context injection are
 * invisible to the user: the coach adapts to low_sleep / high_leg_load
 * / etc. but the user has no way to see what the system is actually
 * reading right now.
 *
 * This module is the bridge. It calls `readTrainingContextAll()` to
 * get the raw signal rows, then maps each signal_type to a
 * human-readable title + summary that the iOS client can render as
 * a pill / card without client-side knowledge of signal semantics.
 *
 * ZERO TOKENS: this is a pure SQL read + in-memory formatting. It's
 * called on every Training tab open, so it must be cheap.
 */

import { readTrainingContextAll } from './training-signals';
import { readSignals, type SignalType, type AgentSignal, type SignalPriority } from './intelligence-bus';

// ─── Response shapes ────────────────────────────────────────────────

export interface FormattedSignal {
  /** Primary key for iOS list rendering. */
  id: number;
  /** Raw signal_type — used by the client for icons / deep-linking. */
  type: SignalType;
  /** Short human-readable title (< 30 chars) suitable for a pill/chip. */
  title: string;
  /** Longer summary (< 120 chars) explaining what happened and why the coach cares. */
  summary: string;
  priority: SignalPriority;
  /** Producer of the signal, e.g. "garmin.sync" or "triathlon.gym". */
  source: string;
  createdAt: string;
  expiresAt: string;
  /** Original payload kept for power users / debug panels. */
  payload: Record<string, any>;
}

/** Mirrors the `flags` object from training-signals.ts readTrainingContextAll. */
export interface SignalFlags {
  lowSleep: boolean;
  lowHrv: boolean;
  lowReadiness: boolean;
  highLegLoad: boolean;
  highShoulderLoad: boolean;
  raceThisWeek: boolean;
  /** Phase 4 Slice C — adherence flags. */
  lowAdherence: boolean;
  highAdherence: boolean;
  /** Phase 4 Slice G — plan drift flag. */
  planDrift: boolean;
  otherSportRpeToday: number;
}

export interface ActiveSignalsResponse {
  userId: number;
  timestamp: string;
  counts: {
    total: number;
    urgent: number;
  };
  flags: SignalFlags;
  signals: FormattedSignal[];
}

// ─── Per-type formatting ────────────────────────────────────────────

interface TypeMeta {
  title: string;
  summarize: (payload: Record<string, any>) => string;
}

/**
 * Map each SignalType to a human-readable title + summarizer. New
 * signal types should add an entry here; unknown types fall back to
 * a safe generic summary.
 *
 * Titles are SHORT (pill-sized, ≤ 30 chars). Summaries are longer
 * (under 120 chars) and explain the "what" plus hint at the "why"
 * so the user can make sense of a coach's adaptation without reading
 * the raw payload.
 */
const TYPE_META: Partial<Record<SignalType, TypeMeta>> = {
  low_sleep: {
    title: 'Low sleep',
    summarize: (p) => {
      const score = typeof p.score === 'number' ? `score ${p.score}` : 'score low';
      const hours = typeof p.total_hours === 'number' ? `${p.total_hours.toFixed(1)}h` : null;
      const details = hours ? `${score} (${hours})` : score;
      return `${details} — coach will downgrade today's intensity.`;
    },
  },
  low_hrv: {
    title: 'Low HRV',
    summarize: (p) => {
      const delta = typeof p.delta_pct === 'number' ? `${p.delta_pct.toFixed(0)}%` : 'below baseline';
      return `HRV ${delta} vs 7-day average — expect easier work today.`;
    },
  },
  low_readiness: {
    title: 'Low readiness',
    summarize: (p) => {
      const score = typeof p.score === 'number' ? p.score : null;
      const base = score != null ? `Garmin readiness ${score}/100` : 'Garmin readiness low';
      return `${base} — coach will skip any planned hard session.`;
    },
  },
  high_leg_load: {
    title: 'High leg load',
    summarize: (p) => {
      const rpe = typeof p.rpe === 'number' ? `RPE ${p.rpe}` : 'hard';
      const src = typeof p.source === 'string' ? p.source : 'training';
      return `${rpe} ${src} session recently — tomorrow's legs will be easier.`;
    },
  },
  high_shoulder_load: {
    title: 'High shoulder load',
    summarize: (p) => {
      const rpe = typeof p.rpe === 'number' ? `RPE ${p.rpe}` : 'hard';
      return `${rpe} overhead / paddle work — swim coach will reduce pull volume.`;
    },
  },
  gym_load_today: {
    title: 'Gym done today',
    summarize: (p) => {
      const rpe = typeof p.rpe === 'number' ? `RPE ${p.rpe}` : 'logged';
      return `Gym session ${rpe} today — other coaches factor this into tomorrow.`;
    },
  },
  running_load_today: {
    title: 'Run done today',
    summarize: (p) => {
      const rpe = typeof p.rpe === 'number' ? `RPE ${p.rpe}` : 'logged';
      const km = typeof p.distance_km === 'number' ? `, ${p.distance_km}km` : '';
      return `Run ${rpe}${km} today — lower-body coaches adjust tomorrow.`;
    },
  },
  cycling_load_today: {
    title: 'Ride done today',
    summarize: (p) => {
      const rpe = typeof p.rpe === 'number' ? `RPE ${p.rpe}` : 'logged';
      return `Ride ${rpe} today — other coaches factor this in.`;
    },
  },
  swim_load_today: {
    title: 'Swim done today',
    summarize: (p) => {
      const rpe = typeof p.rpe === 'number' ? `RPE ${p.rpe}` : 'logged';
      return `Swim ${rpe} today — factored into this week's shoulder volume.`;
    },
  },
  planned_hard_run: {
    title: 'Hard run planned',
    summarize: () => 'Hard running session scheduled — other sports stay easier around it.',
  },
  planned_hard_ride: {
    title: 'Hard ride planned',
    summarize: () => 'Hard ride scheduled — gym and running will be tapered around it.',
  },
  planned_race_this_week: {
    title: 'Race this week',
    summarize: () => 'Race on the calendar within 7 days — coaches will taper, no new stimulus.',
  },
  training_session_scheduled: {
    title: 'Session scheduled',
    summarize: (p) => {
      const sport = typeof p.sport === 'string' ? p.sport : 'training';
      const title = typeof p.title === 'string' ? `: ${p.title}` : '';
      return `${sport[0].toUpperCase()}${sport.slice(1)} session${title} — on the calendar.`;
    },
  },
  calendar_conflict: {
    title: 'Calendar conflict',
    summarize: (p) => {
      const event = typeof p.conflict_event_title === 'string' ? p.conflict_event_title : 'event';
      return `"${event}" overlaps a scheduled training session — consider moving one.`;
    },
  },
  // ─── Phase 4 Slice C — Adherence ──────────────────────────────
  low_adherence: {
    title: 'Low adherence',
    summarize: (p) => {
      const completed = typeof p.completed === 'number' ? p.completed : 0;
      const planned = typeof p.planned === 'number' ? p.planned : 0;
      const pct = typeof p.adherence_pct === 'number' ? p.adherence_pct : 0;
      return `${completed}/${planned} sessions this week (${pct}%) — coach will adjust or check in.`;
    },
  },
  high_adherence: {
    title: 'Crushing it',
    summarize: (p) => {
      const completed = typeof p.completed === 'number' ? p.completed : 0;
      const planned = typeof p.planned === 'number' ? p.planned : 0;
      return `${completed}/${planned} sessions done this week — coach may push harder.`;
    },
  },
  // ─── Phase 4 Slice G — Plan drift ─────────────────────────────
  plan_drift: {
    title: 'Plan drift',
    summarize: (p) => {
      const dominant = typeof p.dominant_sport === 'string' ? p.dominant_sport : 'other sports';
      const planSport = typeof p.plan_sport === 'string' ? p.plan_sport : 'current plan';
      const pct = typeof p.drift_pct === 'number' ? `${p.drift_pct}%` : 'most sessions';
      return `${pct} ${dominant} over 4 weeks — diverging from your ${planSport} plan.`;
    },
  },
};

function formatSignal(raw: AgentSignal): FormattedSignal {
  const meta = TYPE_META[raw.signal_type];
  const title = meta?.title ?? raw.signal_type.replace(/_/g, ' ');
  const summary = meta
    ? meta.summarize(raw.payload)
    : `${raw.signal_type} signal from ${raw.source_agent}.`;

  return {
    id: raw.id,
    type: raw.signal_type,
    title,
    summary,
    priority: raw.priority,
    source: raw.source_agent,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    payload: raw.payload,
  };
}

// ─── Public entry point ─────────────────────────────────────────────

/**
 * All training-scoped signal types the observability view surfaces.
 *
 * Broader than `readTrainingContextAll`'s coach-reader set: we ALSO
 * include `training_session_scheduled` and `calendar_conflict` so the
 * user sees scheduled sessions + secretary-flagged conflicts in one
 * place. Content-mesh signals (hook_effectiveness etc.) are omitted
 * because they're global, not per-user.
 */
const OBSERVABILITY_TYPES: SignalType[] = [
  // Wellness
  'low_sleep',
  'low_hrv',
  'low_readiness',
  // Load markers
  'gym_load_today',
  'running_load_today',
  'cycling_load_today',
  'swim_load_today',
  'high_leg_load',
  'high_shoulder_load',
  // Planning
  'planned_hard_run',
  'planned_hard_ride',
  'planned_race_this_week',
  // Calendar coordination — EXCLUDED from readTrainingContextAll but
  // shown here because the user benefits from seeing them.
  'training_session_scheduled',
  'calendar_conflict',
  // Phase 4 Slice C — adherence.
  'low_adherence',
  'high_adherence',
  // Phase 4 Slice G — plan drift.
  'plan_drift',
];

/**
 * Build the /api/v1/signals/active response for a user.
 *
 * Does TWO reads into the signal bus:
 *   1. `readTrainingContextAll` — used for the `flags` object (so
 *      the UI can light up "Low Sleep" badges deterministically from
 *      the same logic the sport coaches use).
 *   2. A broader `readSignals(OBSERVABILITY_TYPES, userId)` — used for
 *      the full signals list, including calendar-coordination signals
 *      that the coach readers don't consume but the user wants to see.
 *
 * The observability reads use a dedicated consumer key ('ios.signals.view')
 * so they never mark signals as consumed from the sport coaches'
 * perspective — the coach's internal dedup stays intact.
 *
 * Signals are sorted urgent→normal→background, then by createdAt DESC.
 */
export function buildActiveSignalsResponse(userId: number): ActiveSignalsResponse {
  const ctx = readTrainingContextAll({ userId });

  // Broader read for the signals list, using a distinct consumer key
  // so we don't flip any signal's consumed_by state on either the
  // sport coaches or the secretary.
  const rawSignals = readSignals('ios.signals.view', OBSERVABILITY_TYPES, 100, userId);

  // Sort: urgent first, then normal, then background. Within each
  // priority, newest first. readSignals returns priority-ordered
  // results but not guaranteed newest-first within a priority bucket,
  // so we re-sort here for a stable API contract.
  const priorityRank: Record<SignalPriority, number> = {
    urgent: 0,
    normal: 1,
    background: 2,
  };
  const sorted = [...rawSignals].sort((a, b) => {
    const p = priorityRank[a.priority] - priorityRank[b.priority];
    if (p !== 0) return p;
    return b.created_at.localeCompare(a.created_at);
  });

  const signals = sorted.map(formatSignal);
  const urgent = signals.filter((s) => s.priority === 'urgent').length;

  return {
    userId,
    timestamp: new Date().toISOString(),
    counts: {
      total: signals.length,
      urgent,
    },
    // Flags come from readTrainingContextAll, which is the canonical
    // source of the coach-side boolean state. Keeping it there means
    // the observability UI and the coach's behavior can never drift
    // on "is the user low-sleep right now".
    flags: ctx.flags,
    signals,
  };
}

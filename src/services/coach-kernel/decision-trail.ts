// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, Session, Sport, TrainingDecisionReason, WeeklyPlan } from './types';
import { COACH_NON_DIAGNOSTIC_DISCLAIMER } from './safety-guardrails';

const AUTO_NOTE_PREFIXES = [
  'Weekly structure:',
  'Readiness decision:',
  'Readiness confidence:',
  'Adherence decision:',
  'Plan adjustment:',
  'Secretary:',
  'Maintenance/recovery rationale:',
  'Pain-management boundary:',
];

/**
 * Minimal Secretary agenda shape needed to summarize the week (C8). Mirrors
 * the relevant fields of `SecretaryAgendaItem` without importing from the
 * Secretary service — keeps coach-kernel layering clean.
 */
export interface SecretaryAgendaSummaryInput {
  startAt: string | null;
  endAt: string | null;
  lifecycleState: string;
  sourceSkill: string;
  decisionAction: string;
  // Title is intentionally NOT required so callers may strip it before
  // passing the summary input — keeps the surface PII-light.
  title?: string;
}

/**
 * Build a one-line Secretary summary for the week, e.g.:
 *   "compressed 2 sessions; reflowed 1; long run protected"
 *
 * Returns `null` when no Secretary activity happened in the window — the
 * caller drops the line entirely (no "Secretary: 0 changes" noise).
 *
 * Plan reference: Wave 1 workstream C8 in graceful-stirring-scone.md.
 */
export function buildSecretaryWeeklySummary(
  items: ReadonlyArray<SecretaryAgendaSummaryInput>,
  weekStartIso: string,
): string | null {
  const weekStartMs = Date.parse(weekStartIso);
  if (!Number.isFinite(weekStartMs)) return null;
  const weekEndMs = weekStartMs + 7 * 24 * 60 * 60 * 1000;

  let compressed = 0;
  let reflowed = 0;
  let deferred = 0;
  let trainingLongRunProtected = false;

  for (const item of items) {
    if (!item.startAt) continue;
    const startMs = Date.parse(item.startAt);
    if (!Number.isFinite(startMs) || startMs < weekStartMs || startMs >= weekEndMs) continue;
    if (item.lifecycleState === 'compressed' || item.decisionAction === 'compressed') compressed += 1;
    else if (item.lifecycleState === 'reflowed' || item.decisionAction === 'reflowed') reflowed += 1;
    else if (item.lifecycleState === 'deferred' || item.decisionAction === 'deferred') deferred += 1;
    // Heuristic: a training intent that survived as `scheduled` (not
    // compressed/reflowed) AND has a clearly long block (>=90 min) likely
    // represents a protected long run. Title-free check; if a future
    // caller wants tighter detection it can pass title.
    if (
      item.sourceSkill === 'training'
      && (item.lifecycleState === 'scheduled' || item.lifecycleState === 'synced')
      && item.endAt
    ) {
      const dur = (Date.parse(item.endAt) - startMs) / 60_000;
      if (Number.isFinite(dur) && dur >= 90) trainingLongRunProtected = true;
    }
  }

  const parts: string[] = [];
  if (compressed > 0) parts.push(`compressed ${compressed} session${compressed === 1 ? '' : 's'}`);
  if (reflowed > 0) parts.push(`reflowed ${reflowed}`);
  if (deferred > 0) parts.push(`deferred ${deferred}`);
  if (trainingLongRunProtected) parts.push('long run protected');
  if (parts.length === 0) return null;
  return parts.join('; ');
}

export function dedupeDecisionLines(lines: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = decisionLineKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

export function buildWeeklyDecisionNotes(
  plan: WeeklyPlan,
  athlete: AthleteState,
  secretarySummary?: string | null,
): string[] {
  const activeSessions = plan.sessions.filter((session) => session.sessionType !== 'rest' && session.durationMinutes > 0);
  const trainingDays = new Set(activeSessions.map((session) => session.dayOfWeek)).size;
  const totalMinutes = activeSessions.reduce((sum, session) => sum + session.durationMinutes, 0);
  const sportBreakdown = formatSportBreakdown(activeSessions);
  const readinessAction = readinessActionFor(athlete);
  const staleAutoNotesRemoved = plan.notes.filter((note) => !isAutoDecisionNote(note));
  // C8: weave Secretary's weekly contribution into the notes. Optional —
  // only included when the caller computed a non-empty summary line.
  const secretaryLine = secretarySummary && secretarySummary.trim().length > 0
    ? [`Secretary: ${secretarySummary.trim()}.`]
    : [];

  return dedupeDecisionLines([
    `Weekly structure: ${activeSessions.length} sessions across ${trainingDays} training day${trainingDays === 1 ? '' : 's'} (${sportBreakdown}, ${totalMinutes} min total) for ${plan.discipline} focus in ${plan.phase} phase.`,
    `Readiness decision: ${athlete.readiness.level}/${athlete.readiness.score} ${readinessAction}.`,
    ...readinessConfidenceNotes(athlete),
    adherenceDecisionNote(athlete),
    ...recoveryRationaleNotes(plan, athlete),
    ...secretaryLine,
    ...decisionReasonNotes(plan),
    ...staleAutoNotesRemoved,
  ]);
}

function recoveryRationaleNotes(plan: WeeklyPlan, athlete: AthleteState): string[] {
  if (plan.phase !== 'deload' && plan.phase !== 'maintenance') return [];

  const hasDeclaredInjury = athlete.constraints.some((constraint) => constraint.type === 'injury');
  const hasPainFlag = (athlete.readiness.painFlags ?? []).length > 0;
  if (hasDeclaredInjury || hasPainFlag) {
    return [
      `Maintenance/recovery rationale: the ${plan.phase} phase remains recovery-led while declared pain or injury constraints are active; reassess before resuming build phases.`,
    ];
  }

  if (athlete.feedbackAnalysis?.progressionState === 'reentry') {
    const misses = athlete.compliance.consecutiveMisses;
    return [
      `Maintenance/recovery rationale: the ${plan.phase} phase is an adherence re-entry after ${misses} consecutive miss${misses === 1 ? '' : 'es'}; keep work easy and repeatable until consistency returns.`,
    ];
  }

  if (
    athlete.feedbackAnalysis?.progressionState === 'deload'
    || athlete.readiness.level === 'orange'
    || athlete.readiness.level === 'red'
  ) {
    return [
      `Maintenance/recovery rationale: the ${plan.phase} phase remains recovery-led while readiness or fatigue signals are constrained; reassess before resuming build phases.`,
    ];
  }

  return [];
}

/**
 * Public, typed safety evidence for a declared injury/pain constraint.
 * The same reason is aggregated onto the plan response, so preview/create
 * clients do not have to rely on private persisted week-note rows to render
 * the professional boundary.
 */
export function buildInjurySafetyDecisionReasons(athlete: AthleteState): TrainingDecisionReason[] {
  const hasDeclaredInjury = athlete.constraints.some((constraint) => constraint.type === 'injury');
  const hasPainFlag = (athlete.readiness.painFlags ?? []).length > 0;
  if (!hasDeclaredInjury && !hasPainFlag) return [];

  return [{
    code: 'pain_flag',
    text: `Pain-management boundary: keep every session pain-free and stop if symptoms worsen. ${COACH_NON_DIAGNOSTIC_DISCLAIMER}`,
    severity: 'warning',
    affectedEntity: { type: 'week' },
    sourceConstraint: {
      type: 'safety',
      label: 'declared pain or injury constraint',
    },
    preservedIntent: 'Preserve safe training continuity without diagnosing or overriding professional care.',
    evidence: ['declared_injury_or_pain_constraint', 'non_diagnostic_professional_boundary'],
  }];
}

function readinessConfidenceNotes(athlete: AthleteState): string[] {
  if (athlete.readiness.confidence === 'stale_provider' || athlete.readiness.isStale === true) {
    return [
      'Readiness confidence: provider data is stale; avoid aggressive progression and use a manual check-in before hard work.',
    ];
  }
  if (athlete.readiness.confidence === 'no_data') {
    return [
      'Readiness confidence: no fresh wearable or manual readiness data; use perceived effort (RPE) to pace conservative defaults and complete a manual check-in before hard work.',
    ];
  }
  return [];
}

function adherenceDecisionNote(athlete: AthleteState): string {
  const compliancePct = Math.round(athlete.compliance.trailing14DayCompliance * 100);
  const misses = athlete.compliance.consecutiveMisses;
  if (compliancePct <= 0) {
    if (misses > 0) {
      return `Adherence decision: reset week after ${misses} consecutive miss${misses === 1 ? '' : 'es'} — restart with one short, safe session instead of chasing missed volume.`;
    }
    return 'Adherence decision: fresh tracking week — use the next short session to establish the baseline.';
  }
  return `Adherence decision: ${compliancePct}% trailing 14-day compliance with ${misses} consecutive miss${misses === 1 ? '' : 'es'}.`;
}

function decisionReasonNotes(plan: WeeklyPlan): string[] {
  return (plan.decisionReasons ?? [])
    .filter((reason) => reason.severity !== 'info')
    .map((reason) => `Plan adjustment: ${reason.text}`);
}

function decisionLineKey(value: string): string {
  return value
    .replace(/^✳\s*/u, '')
    .replace(/\s+/gu, ' ')
    .replace(/[.!]+$/u, '')
    .trim()
    .toLowerCase();
}

function isAutoDecisionNote(value: string): boolean {
  return AUTO_NOTE_PREFIXES.some((prefix) => value.trim().startsWith(prefix));
}

function formatSportBreakdown(sessions: Session[]): string {
  if (sessions.length === 0) return 'no active sessions';
  const counts = sessions.reduce<Partial<Record<Sport, number>>>((acc, session) => {
    acc[session.sport] = (acc[session.sport] ?? 0) + 1;
    return acc;
  }, {});

  return (Object.entries(counts) as Array<[Sport, number]>)
    .map(([sport, count]) => `${count} ${sport}`)
    .join(', ');
}

function readinessActionFor(athlete: AthleteState): string {
  switch (athlete.readiness.level) {
    case 'green':
      return 'supports normal progression';
    case 'yellow':
      return 'supports the plan with normal recovery monitoring';
    case 'orange':
      return 'requires density and intensity protection before hard work';
    case 'red':
      return 'requires recovery-first substitutions or a deload';
  }
}

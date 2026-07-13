// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Rich training session description builder.
 *
 * Given a generated plan, the current week, the current session, and the
 * athlete's profile, produces:
 *
 *   - `text`: a plain-text body used as the calendar event description.
 *     This is what Outlook/Google email when the invite is delivered.
 *   - `sections`: a structured JSON form persisted on the session row
 *     (`training_sessions.description_json`) so iOS can render typed
 *     section cards instead of treating the body as opaque text.
 *
 * Both surfaces are derived from the same `SessionSections` structure
 * — the text serializer is the single owner of that mapping, so the
 * email body and the iOS view never drift.
 *
 * The builder is deterministic. No AI calls. All inputs are already
 * available at plan-persistence time.
 */
import { logger } from '../utils/logger';
import { TRAINING_NON_CATALOG_INSTRUCTIONAL_TEXT_POLICY } from './training-exercise-identity';
import type { TrainingExerciseIdentityV1Mode } from './runtime-flags';

// ── Inputs ─────────────────────────────────────────────────────────

export interface SessionDescriptionInput {
  /** Plan name (e.g., "Lisbon Marathon Plan"). */
  planName: string;
  /** User-provided objective text used as a fallback when planName is generic. */
  objective: string;
  /** Total weeks in the plan — needed for "pre-race taper" detection. */
  totalWeeks: number;
  /** ISO date (YYYY-MM-DD) of plan week 1 — used to label progression dates. */
  startDate: string;
  /** Sport label from the plan (e.g., "running", "hybrid"). */
  sport: string;
  /** Periodization label from the plan (e.g., "block", "linear"). */
  periodization?: string;
  /** Current week number (1-indexed). */
  weekNumber: number;
  /** Current week focus (e.g., "base", "build", "deload"). */
  weekFocus?: string;
  /** Current week intensity percentage. */
  weekIntensityPct?: number;
  /** All weeks in the plan — used to render WEEKLY PROGRESSION. */
  allWeeks: PlanWeekSummary[];
  /** The session being described. */
  session: SessionInput;
  /** Optional athlete profile data — gates pace/HR zone rendering. */
  profiles?: AthleteProfiles;
  /** Controls additive identity-policy metadata only. Off preserves the
   * legacy serialized section shape. */
  exerciseIdentityMode?: TrainingExerciseIdentityV1Mode;
}

export interface PlanWeekSummary {
  weekNumber: number;
  focus?: string;
  intensityPct?: number;
  sessions?: Array<{
    sessionType?: string;
    title?: string;
    durationMinutes?: number;
    dayOfWeek?: string;
  }>;
}

export interface SessionInput {
  sessionType: string;
  title: string;
  durationMinutes: number;
  /** Optional AI-supplied free text — appended verbatim under NOTES. */
  description?: string | null;
  exercises?: Array<{
    name?: string;
    sets?: number;
    reps?: string | number;
    weight?: string | number;
    rpe?: string | number;
    rest_sec?: number;
    rest?: string;
    note?: string;
    distance_km?: number;
    pace?: string;
    exerciseId?: string;
    tempo?: string;
    selectionReason?: {
      pickedBecause?: string[];
    };
    progressionSummary?: string;
  progressionReason?: string;
  progressionState?: string;
  progressionConfidence?: string;
  }>;
  splitCode?: string;
  splitSlot?: string;
  focus?: string;
  primaryMuscles?: string[];
  secondaryMuscles?: string[];
  movementPatterns?: string[];
  sections?: Array<{
    type?: string;
    exercises?: Array<{
      name?: string;
      sets?: number;
      reps?: string | number;
      rir?: number;
      rpe?: string | number;
      restSec?: number;
      rest_sec?: number;
      note?: string;
    }>;
  }>;
  /** Day name as canonicalized by the planner ("Monday" etc). */
  dayOfWeek: string;
  sessionRole?: string;
  sessionRoleLabel?: string;
  sessionRoleSummary?: string;
  keySessionLabel?: string;
  intensitySummary?: {
    primaryZone?: string;
    lowPct?: number;
    moderatePct?: number;
    highPct?: number;
    estimatedLoad?: number;
    targetSummaryText?: string;
  };
  decisionReasons?: Array<{ text?: string; severity?: string; code?: string }>;
}

export interface AthleteProfiles {
  fitnessProfile?: Record<string, any> | null;
  runProfile?: Record<string, any> | null;
  gymProfile?: Record<string, any> | null;
  cyclingProfile?: Record<string, any> | null;
  swimProfile?: Record<string, any> | null;
}

// ── Output ─────────────────────────────────────────────────────────

export interface RichSessionDescription {
  text: string;
  sections: SessionSections;
}

export interface SessionSections {
  /** Plan + phase header line. */
  header: {
    planName: string;
    phase?: string;
  };
  /** Big visual chip — emoji, day eyebrow, focus title. */
  badge: {
    emoji: string;
    eyebrow: string;
    title: string;
  };
  /** 1-row-per-week progression table for sessions of this type. */
  weeklyProgression?: Array<{
    weekNumber: number;
    weekStart: string;
    summary: string;
    note?: string;
  }>;
  /** Pace/HR/RPE/etc. — sport- and session-type-specific. */
  execution?: Array<{ label: string; value: string; note?: string }>;
  /** Compact user-facing explanations derived from backend decision data. */
  coachInsights?: Array<{
    presentationLevel: 'user_facing';
    label: string;
    value: string;
    reasonCode?: string;
  }>;
  blocks?: Array<{
    id: string;
    type: string;
    title?: string;
    subtitle?: string;
    summary?: string;
    items?: string[];
    metrics?: Array<{ label: string; value: string; note?: string }>;
    warnings?: string[];
    notes?: string;
  }>;
  /** Numbered gym exercise list (only present for strength sessions). */
  exercises?: Array<{
    index: number;
    name: string;
    detail: string;
    note?: string;
  }>;
  /** Warm-up block (head + bullet items + optional duration). */
  warmup?: {
    headline: string;
    items: string[];
    newlyPrescribable?: false;
    mediaEligible?: false;
  };
  /** Cool-down (single line is fine). */
  cooldown?: {
    headline: string;
    items: string[];
    newlyPrescribable?: false;
    mediaEligible?: false;
  };
  /** ⚠️ IMPORTANT callouts — deload reminders, hard-day warnings. */
  important?: string[];
  /** Free-text AI commentary (if the planner supplied any). */
  notes?: string;
  /** "~65-70 min total" — last line. */
  totalMinutesText: string;
}

// ── Public entry point ─────────────────────────────────────────────

export function buildRichSessionDescription(input: SessionDescriptionInput): RichSessionDescription {
  try {
    const sections = buildSections(input);
    const text = renderSectionsAsText(sections);
    return { text, sections };
  } catch (err) {
    // Builder must never throw at persistence time — falling back to
    // a minimal description preserves the prior behavior so plan
    // generation never fails on description rendering.
    logger.warn({ err, sessionType: input.session.sessionType }, 'Rich session description builder failed; using minimal fallback');
    const fallback = buildMinimalFallback(input);
    return {
      text: renderSectionsAsText(fallback),
      sections: fallback,
    };
  }
}

// ── Section assembly ───────────────────────────────────────────────

function buildSections(input: SessionDescriptionInput): SessionSections {
  const sport = sportFamilyForSession(input.session.sessionType, input.sport, input.session);

  return {
    header: {
      planName: normalizePlanName(input.planName, input.objective),
      phase: undefined,
    },
    badge: buildBadge(input),
    blocks: buildDynamicBlocks(input.session),
    weeklyProgression: undefined,
    execution: buildExecution(input, sport),
    coachInsights: buildCoachInsights(input),
    exercises: buildExercises(input.session.exercises),
    warmup: markInstructionalTextAsNonCatalog(
      buildWarmup(input.session.sessionType, sport),
      input.exerciseIdentityMode,
    ),
    cooldown: markInstructionalTextAsNonCatalog(
      buildCooldown(input.session.sessionType, sport),
      input.exerciseIdentityMode,
    ),
    important: buildImportant(input, sport),
    notes: cleanFreeText(input.session.description, sport),
    totalMinutesText: buildTotalMinutesText(input.session.durationMinutes),
  };
}

function buildMinimalFallback(input: SessionDescriptionInput): SessionSections {
  return {
    header: { planName: normalizePlanName(input.planName, input.objective) },
    badge: {
      emoji: emojiForSessionType(input.session.sessionType),
      eyebrow: input.session.dayOfWeek.toUpperCase(),
      title: input.session.title || 'Training session',
    },
    blocks: [],
    totalMinutesText: buildTotalMinutesText(input.session.durationMinutes),
  };
}

// ── Header / badge ─────────────────────────────────────────────────

function normalizePlanName(planName: string | undefined, objective: string): string {
  const trimmed = (planName || '').trim();
  if (trimmed.length > 0) return trimmed;
  return objective?.trim() || 'Training Plan';
}

function phaseLabel(focus: string | undefined, weekNumber: number, totalWeeks: number): string | undefined {
  const normalized = (focus || '').trim().toLowerCase();
  if (!normalized) return undefined;

  const phaseFamily = (() => {
    switch (normalized) {
      case 'base': return 'Phase 1: Base';
      case 'build': return 'Phase 2: Build';
      case 'peak': return 'Phase 3: Peak';
      case 'taper': return 'Phase 4: Taper';
      case 'race': return 'Race Week';
      case 'deload': return 'Deload';
      case 'maintenance': return 'Maintenance';
      case 'recovery': return 'Recovery';
      default: return capitalize(normalized);
    }
  })();

  // Append "(week N of M)" so the user sees their progress on the line.
  return `${phaseFamily} — week ${weekNumber} of ${totalWeeks}`;
}

function buildBadge(input: SessionDescriptionInput): SessionSections['badge'] {
  const emoji = emojiForSessionType(input.session.sessionType);
  const day = input.session.dayOfWeek.trim().toUpperCase();
  const sessionTitle = input.session.title?.trim() || sessionTypeReadableName(input.session.sessionType);
  const eyebrow = `${day} ${sessionTypeReadableName(input.session.sessionType).toUpperCase()}`.trim();
  return {
    emoji,
    eyebrow: eyebrow || day || 'TRAINING',
    title: sessionTitle,
  };
}

// ── Weekly progression ─────────────────────────────────────────────

function buildWeeklyProgression(input: SessionDescriptionInput): SessionSections['weeklyProgression'] {
  if (!input.allWeeks || input.allWeeks.length === 0) return undefined;
  const targetType = input.session.sessionType;
  const startDate = parseDate(input.startDate);
  if (!startDate) return undefined;

  const rows: NonNullable<SessionSections['weeklyProgression']> = [];

  for (const week of input.allWeeks) {
    if (typeof week.weekNumber !== 'number') continue;
    const weekStart = addDays(startDate, (week.weekNumber - 1) * 7);
    const matching = (week.sessions ?? []).filter((s) => s.sessionType === targetType);
    if (matching.length === 0) {
      // For weeks where this session type doesn't appear (e.g., a deload
      // week dropping a session entirely), still emit the row so the user
      // sees the plan's macro shape rather than a hole in the table.
      rows.push({
        weekNumber: week.weekNumber,
        weekStart: shortMonthDay(weekStart),
        summary: weekDropSummary(week.focus),
        note: noteForWeek(week.focus, week.weekNumber, input.totalWeeks),
      });
      continue;
    }

    const summary = summarizeSessionsForWeek(matching, targetType);
    rows.push({
      weekNumber: week.weekNumber,
      weekStart: shortMonthDay(weekStart),
      summary,
      note: noteForWeek(week.focus, week.weekNumber, input.totalWeeks),
    });
  }

  return rows.length > 0 ? rows : undefined;
}

function summarizeSessionsForWeek(
  sessions: Array<{ durationMinutes?: number; title?: string }>,
  sessionType: string,
): string {
  const totalMinutes = sessions.reduce(
    (acc, s) => acc + (typeof s.durationMinutes === 'number' ? s.durationMinutes : 0),
    0,
  );
  if (sessions.length === 1) {
    const s = sessions[0];
    if (typeof s.durationMinutes === 'number' && s.durationMinutes > 0) {
      const easyOrType = sessionTypeAdjective(sessionType);
      return `${s.durationMinutes} min ${easyOrType}`.trim();
    }
    return s.title?.trim() || sessionTypeReadableName(sessionType);
  }
  if (totalMinutes > 0) {
    return `${sessions.length} sessions · ${totalMinutes} min total`;
  }
  return `${sessions.length} sessions`;
}

function weekDropSummary(focus?: string): string {
  if ((focus || '').toLowerCase() === 'deload') return 'Deload — no session this type';
  return 'No session of this type this week';
}

function noteForWeek(focus: string | undefined, weekNumber: number, totalWeeks: number): string | undefined {
  const normalizedFocus = (focus || '').toLowerCase();
  if (normalizedFocus === 'deload') return 'DELOAD WEEK';
  if (normalizedFocus === 'taper' || (totalWeeks > 0 && weekNumber === totalWeeks)) return 'Pre-race taper';
  if (normalizedFocus === 'race') return 'RACE WEEK';
  return undefined;
}

// ── Execution (pace/HR/RPE/etc.) ───────────────────────────────────

function buildExecution(
  input: SessionDescriptionInput,
  sport: SportFamily,
): SessionSections['execution'] {
  switch (sport) {
    case 'running':
      return runningExecution(input);
    case 'cycling':
      return cyclingExecution(input);
    case 'swimming':
      return swimmingExecution(input);
    case 'strength':
      return strengthExecution(input);
    default:
      return undefined;
  }
}

function runningExecution(input: SessionDescriptionInput): SessionSections['execution'] {
  const items: NonNullable<SessionSections['execution']> = [];
  const sessionType = input.session.sessionType;
  const profile = input.profiles?.runProfile ?? {};
  const fitness = input.profiles?.fitnessProfile ?? {};

  const thresholdPace = paceFromProfile(profile.threshold_pace);
  const maxHr = numericOrUndefined(fitness.max_heart_rate);
  const lthr = numericOrUndefined(fitness.threshold_heart_rate);

  const intent = runIntentForSessionType(sessionType);

  // Pace
  if (thresholdPace) {
    const targetPace = paceForRunIntent(intent, thresholdPace);
    if (targetPace) {
      items.push({ label: 'Pace', value: targetPace, note: paceNote(intent) });
    }
  } else {
    items.push({ label: 'Effort', value: paceNote(intent) || 'Conversational' });
  }

  // HR
  if (maxHr || lthr) {
    const hrRange = hrRangeForRunIntent(intent, lthr ?? Math.round((maxHr ?? 180) * 0.85), maxHr ?? 0);
    if (hrRange) items.push({ label: 'HR', value: hrRange });
  }

  // RPE
  items.push({ label: 'RPE', value: rpeForRunIntent(intent), note: rpeNoteForRunIntent(intent) });

  // Walk-break / drift rule for very-easy first weeks
  if (intent === 'easy') {
    items.push({
      label: 'Walk breaks',
      value: 'OK in the first 2 weeks if HR drifts above the upper bound',
    });
  }

  return items.length > 0 ? items : undefined;
}

function cyclingExecution(input: SessionDescriptionInput): SessionSections['execution'] {
  const items: NonNullable<SessionSections['execution']> = [];
  const sessionType = input.session.sessionType;
  const profile = input.profiles?.runProfile ?? {};
  const fitness = input.profiles?.fitnessProfile ?? {};

  const ftp = numericOrUndefined(profile.ftp_watts ?? fitness.ftp_watts);
  const maxHr = numericOrUndefined(fitness.max_heart_rate);
  const lthr = numericOrUndefined(fitness.threshold_heart_rate);
  const intent = rideIntentForSessionType(sessionType);

  if (ftp && ftp > 0) {
    const range = powerForRideIntent(intent, ftp);
    if (range) items.push({ label: 'Power', value: range, note: rideNote(intent) });
  } else {
    items.push({ label: 'Effort', value: rideNote(intent) || 'Conversational' });
  }

  if (maxHr || lthr) {
    const hrRange = hrRangeForRideIntent(intent, lthr ?? Math.round((maxHr ?? 180) * 0.85), maxHr ?? 0);
    if (hrRange) items.push({ label: 'HR', value: hrRange });
  }

  items.push({ label: 'RPE', value: rpeForRideIntent(intent) });
  return items.length > 0 ? items : undefined;
}

function swimmingExecution(input: SessionDescriptionInput): SessionSections['execution'] {
  const fitness = input.profiles?.fitnessProfile ?? {};
  const css = numericOrUndefined(fitness.swim_css_seconds_per_100m);
  const items: NonNullable<SessionSections['execution']> = [];
  const intent = swimIntentForSessionType(input.session.sessionType);

  if (css && css > 0) {
    const target = paceForSwimIntent(intent, css);
    if (target) items.push({ label: 'Pace', value: `${target}/100m`, note: swimNote(intent) });
  } else {
    items.push({ label: 'Effort', value: swimNote(intent) || 'Easy and technique-focused' });
  }
  items.push({ label: 'RPE', value: rpeForSwimIntent(intent) });
  return items.length > 0 ? items : undefined;
}

function strengthExecution(_input: SessionDescriptionInput): SessionSections['execution'] {
  // For strength sessions the EXERCISES section carries the prescription;
  // the EXECUTION block stays empty so we don't duplicate sets/reps.
  return undefined;
}

// ── Exercises ──────────────────────────────────────────────────────

function buildExercises(
  exercises: SessionInput['exercises'],
): SessionSections['exercises'] {
  if (!exercises || exercises.length === 0) return undefined;
  return exercises.map((ex, idx) => ({
    index: idx + 1,
    name: ex.name?.trim() || 'Exercise',
    detail: formatExerciseDetail(ex),
    note: ex.note?.trim() || undefined,
  }));
}

function formatExerciseDetail(ex: NonNullable<SessionInput['exercises']>[number]): string {
  const parts: string[] = [];

  if (ex.sets != null && ex.reps != null) {
    parts.push(`${ex.sets}×${ex.reps}`);
  } else if (ex.sets != null) {
    parts.push(`${ex.sets} sets`);
  } else if (ex.reps != null) {
    parts.push(`${ex.reps} reps`);
  }

  if (ex.weight) parts.push(`@ ${ex.weight}`);
  if (ex.rpe != null) parts.push(`@ RPE ${ex.rpe}`);
  if (ex.distance_km != null) parts.push(`— ${ex.distance_km}km`);
  if (ex.pace) parts.push(`@ ${ex.pace}`);

  const restText = ex.rest?.trim() || (typeof ex.rest_sec === 'number' ? formatRest(ex.rest_sec) : '');
  if (restText) parts.push(`| ${restText} rest`);

  return parts.join(' ');
}

function formatRest(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds % 60 === 0) {
    const mins = seconds / 60;
    return `${mins} min`;
  }
  return `${seconds}s`;
}

// ── Dynamic split / structure blocks ───────────────────────────────

function buildDynamicBlocks(session: SessionInput): SessionSections['blocks'] {
  const blocks: NonNullable<SessionSections['blocks']> = [];
  const splitCode = String(session.splitCode || '').trim();
  const splitSlot = String(session.splitSlot || '').trim();
  if (splitCode && splitSlot) {
    blocks.push({
      id: `split-${splitCode}-${splitSlot}`,
      type: 'why_this_session',
      title: 'WHY THIS SESSION',
      subtitle: `${splitCode} slot ${splitSlot}`,
      summary: session.focus || 'Coach-selected strength split slot.',
      items: [
        listLine('Primary muscles', session.primaryMuscles),
        listLine('Secondary muscles', session.secondaryMuscles),
        listLine('Movement patterns', session.movementPatterns),
      ].filter((item): item is string => Boolean(item)),
      metrics: [
        { label: 'Split', value: `${splitCode} ${splitSlot}` },
        ...(session.sections?.length ? [{ label: 'Sections', value: String(session.sections.length) }] : []),
      ],
      warnings: [],
      notes: 'This structure is deterministic and validated before the plan is saved.',
    });
  }

  const sectionLines = (session.sections ?? [])
    .map((section) => {
      const type = String(section.type || '').replace(/_/g, ' ').toUpperCase();
      const exercises = (section.exercises ?? [])
        .map((exercise) => {
          const setRep = exercise.sets && exercise.reps ? `${exercise.sets}×${exercise.reps}` : exercise.reps;
          const effort = exercise.rir != null ? `RIR ${exercise.rir}` : exercise.rpe != null ? `RPE ${exercise.rpe}` : null;
          const rest = exercise.restSec ?? exercise.rest_sec;
          return [
            exercise.name,
            setRep,
            effort,
            rest ? `${rest}s rest` : null,
          ].filter(Boolean).join(' · ');
        })
        .filter(Boolean);
      return exercises.length > 0 ? `${type}: ${exercises.join('; ')}` : null;
    })
    .filter((line): line is string => Boolean(line));

  if (sectionLines.length > 0) {
    blocks.push({
      id: 'structured-prescription',
      type: 'session_prescription',
      title: 'SESSION STRUCTURE',
      summary: 'Warm-up, main work, accessories, core, and cooldown are preserved as explicit sections.',
      items: sectionLines,
      metrics: [],
      warnings: [],
    });
  }

  return blocks;
}

function listLine(label: string, values: string[] | undefined): string | null {
  const cleaned = (values ?? []).map((value) => String(value || '').replace(/_/g, ' ').trim()).filter(Boolean);
  return cleaned.length > 0 ? `${label}: ${cleaned.join(', ')}` : null;
}

// ── Warm-up / cool-down ────────────────────────────────────────────

function buildWarmup(sessionType: string, sport: SportFamily): SessionSections['warmup'] {
  switch (sport) {
    case 'running': {
      if (runIntentForSessionType(sessionType) === 'easy') {
        return { headline: 'WARM-UP', items: ['5 min brisk walk before starting'] };
      }
      return {
        headline: 'WARM-UP (10 min)',
        items: [
          '5 min very easy jog',
          'Dynamic mobility: leg swings, hip openers, A-skips',
          '4 × 20s strides at 5k pace',
        ],
      };
    }
    case 'cycling':
      return {
        headline: 'WARM-UP (10 min)',
        items: ['5 min easy spin', '3 × 30s pickups at threshold cadence', '2 min easy spin into the main set'],
      };
    case 'swimming':
      return {
        headline: 'WARM-UP',
        items: ['200 m easy swim, mixed strokes', '4 × 25 m drill / 25 m swim', '2 × 50 m build to threshold'],
      };
    case 'strength': {
      if (sessionType === 'strength_max') {
        return {
          headline: 'WARM-UP (10 min)',
          items: [
            '5 min walk/bike',
            'Hip 90/90 stretches, banded hip circles',
            '2 warm-up squat sets at 50% and 70%',
          ],
        };
      }
      return {
        headline: 'WARM-UP (8 min)',
        items: ['5 min walk/bike', 'Movement prep specific to today\'s lifts', '1 light warm-up set per main lift'],
      };
    }
    default:
      return undefined;
  }
}

function buildCooldown(sessionType: string, sport: SportFamily): SessionSections['cooldown'] {
  switch (sport) {
    case 'running':
      return { headline: 'COOL-DOWN', items: ['5 min walk + calf, hip, and hamstring mobility'] };
    case 'cycling':
      return { headline: 'COOL-DOWN', items: ['5 min easy spin to flush legs'] };
    case 'swimming':
      return { headline: 'COOL-DOWN', items: ['100-200 m easy swim, focus on breathing'] };
    case 'strength': {
      if (sessionType === 'strength_max' || sessionType === 'strength_hypertrophy') {
        return {
          headline: 'COOL-DOWN',
          items: ['8-10 min mobility for hips, T-spine, hamstrings, and the muscles trained'],
        };
      }
      return { headline: 'COOL-DOWN', items: ['5 min mobility for the muscles trained'] };
    }
    default:
      return undefined;
  }
}

function markInstructionalTextAsNonCatalog<T extends SessionSections['warmup'] | SessionSections['cooldown']>(
  block: T,
  mode: TrainingExerciseIdentityV1Mode | undefined,
): T {
  if (!block || mode !== 'active') return block;
  return {
    ...block,
    ...TRAINING_NON_CATALOG_INSTRUCTIONAL_TEXT_POLICY,
  } as T;
}

// ── ⚠️ Important callouts ──────────────────────────────────────────

function buildImportant(input: SessionDescriptionInput, sport: SportFamily): SessionSections['important'] {
  const notes: string[] = [];
  const focus = (input.weekFocus || '').toLowerCase();
  const sessionType = input.session.sessionType;

  if (focus === 'deload') {
    notes.push('Deload week — drop volume to ~60% and keep form sharp. Do not chase intensity.');
  }
  if (focus === 'taper') {
    notes.push('Taper week — keep intensity, cut volume. The hard work is already in the bank.');
  }
  if (focus === 'race') {
    notes.push('Race week — only easy efforts and short tune-ups. Sleep, hydrate, fuel.');
  }

  if (sport === 'strength' && sessionType === 'strength_max') {
    notes.push('This is the heaviest lower body day. Cardio later today should feel easy.');
    notes.push('Do NOT increase squat weight if morning runs feel heavy.');
  }

  if (sport === 'running' && runIntentForSessionType(sessionType) === 'easy') {
    notes.push('Strict Zone 2 — if HR drifts above the upper bound, take walk breaks rather than slowing pace below conversation level.');
  }

  if (sport === 'running' && runIntentForSessionType(sessionType) === 'long') {
    notes.push('Time on feet first, pace second. If sleep was poor, drop the planned pace by 10-20s/km.');
  }

  return notes.length > 0 ? notes : undefined;
}

function buildCoachInsights(input: SessionDescriptionInput): SessionSections['coachInsights'] {
  const insights: NonNullable<SessionSections['coachInsights']> = [];
  const addInsight = (label: string, value: string | null | undefined, reasonCode?: string): void => {
    const cleaned = String(value ?? '').trim();
    if (!cleaned) return;
    const key = `${label}|${cleaned}`.toLowerCase();
    if (insights.some((item) => `${item.label}|${item.value}`.toLowerCase() === key)) return;
    insights.push({
      presentationLevel: 'user_facing',
      label,
      value: cleaned,
      reasonCode,
    });
  };

  addInsight('Training role', input.session.sessionRoleLabel, input.session.sessionRole);
  addInsight('Coach intent', input.session.sessionRoleSummary, 'session_role_summary');
  addInsight('Key session', input.session.keySessionLabel, 'key_session_label');
  addInsight('Intensity target', input.session.intensitySummary?.targetSummaryText, 'intensity_summary');

  for (const reason of input.session.decisionReasons ?? []) {
    if (!reason || reason.severity === 'info') continue;
    addInsight('Why this changed', reason.text, reason.code);
  }

  for (const exercise of input.session.exercises ?? []) {
    const selection = exercise.selectionReason?.pickedBecause?.[0];
    if (selection) {
      addInsight(`${exercise.name ?? 'Exercise'} selection`, selection, 'exercise_selection');
    }
    if (exercise.progressionSummary) {
      addInsight(`${exercise.name ?? 'Exercise'} progression`, exercise.progressionSummary, exercise.progressionState);
    }
  }

  return insights.length > 0 ? insights.slice(0, 6) : undefined;
}

// ── Total minutes / notes ──────────────────────────────────────────

function buildTotalMinutesText(durationMinutes: number): string {
  if (!durationMinutes || durationMinutes <= 0) return 'Time: see plan';
  // Express a friendly "~A-B min total" range for sessions ≥30 min
  // because actual session length varies with warm-up/cool-down.
  if (durationMinutes >= 60) {
    const lower = Math.max(durationMinutes - 5, 0);
    return `~${lower}-${durationMinutes} min total`;
  }
  return `~${durationMinutes} min total`;
}

function cleanFreeText(text: string | null | undefined, sport: SportFamily): string | undefined {
  const trimmed = (text || '').trim();
  if (!trimmed) return undefined;

  const cleaned = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isRawCoachDebugLine(line))
    .filter((line) => !isModalityMismatchedFreeText(line, sport))
    .join('\n\n');
  if (!cleaned) return undefined;

  // Collapse runs of blank lines but preserve paragraph breaks.
  return cleaned.replace(/\n{3,}/g, '\n\n');
}

// ── Text serializer ────────────────────────────────────────────────

export function renderSectionsAsText(sections: SessionSections): string {
  const lines: string[] = [];

  // Header
  const headerLine = sections.header.phase
    ? `${sections.header.planName} — ${sections.header.phase}`
    : sections.header.planName;
  lines.push(headerLine);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  // Badge
  lines.push(`${sections.badge.emoji} ${sections.badge.eyebrow} — ${sections.badge.title}`);
  lines.push('');

  // Weekly progression
  if (sections.weeklyProgression && sections.weeklyProgression.length > 0) {
    lines.push('WEEKLY PROGRESSION:');
    for (const row of sections.weeklyProgression) {
      const noteSuffix = row.note ? ` | ${row.note}` : '';
      lines.push(`• Wk${row.weekNumber} (${row.weekStart}): ${row.summary}${noteSuffix}`);
    }
    lines.push('');
  }

  if (sections.warmup) {
    lines.push(`${sections.warmup.headline}:`);
    for (const item of sections.warmup.items) {
      lines.push(`• ${item}`);
    }
    lines.push('');
  }

  // Main workout content (running/cycling/swim execution cues OR
  // strength exercises). This intentionally appears before internal
  // notes/metadata so calendar invite emails are useful at a glance.
  if (sections.execution && sections.execution.length > 0) {
    lines.push('MAIN WORKOUT — EXECUTION:');
    for (const item of sections.execution) {
      const noteSuffix = item.note ? ` — ${item.note}` : '';
      lines.push(`• ${item.label}: ${item.value}${noteSuffix}`);
    }
    lines.push('');
  }

  if (sections.exercises && sections.exercises.length > 0) {
    lines.push('MAIN WORKOUT — EXERCISES:');
    for (const ex of sections.exercises) {
      const noteSuffix = ex.note ? ` (${ex.note})` : '';
      lines.push(`${ex.index}. ${ex.name} — ${ex.detail}${noteSuffix}`);
    }
    lines.push('');
  }

  if (sections.cooldown) {
    const head = sections.cooldown.headline;
    if (sections.cooldown.items.length === 1) {
      lines.push(`${head}: ${sections.cooldown.items[0]}`);
    } else {
      lines.push(`${head}:`);
      for (const item of sections.cooldown.items) {
        lines.push(`• ${item}`);
      }
    }
    lines.push('');
  }

  if (sections.blocks && sections.blocks.length > 0) {
    for (const block of sections.blocks) {
      lines.push(`${(block.title || block.type || 'DETAILS').toUpperCase()}:`);
      if (block.subtitle) lines.push(`• ${block.subtitle}`);
      if (block.summary) lines.push(`• ${block.summary}`);
      for (const metric of block.metrics ?? []) {
        lines.push(`• ${metric.label}: ${metric.value}${metric.note ? ` — ${metric.note}` : ''}`);
      }
      const items = block.type === 'session_prescription' ? [] : block.items ?? [];
      for (const item of items) {
        lines.push(`• ${item}`);
      }
      for (const warning of block.warnings ?? []) {
        lines.push(`• ${warning}`);
      }
      if (block.notes && block.type !== 'session_prescription') lines.push(`• ${block.notes}`);
      lines.push('');
    }
  }

  if (sections.coachInsights && sections.coachInsights.length > 0) {
    lines.push('COACH INSIGHTS:');
    for (const item of sections.coachInsights) {
      lines.push(`• ${item.label}: ${item.value}`);
    }
    lines.push('');
  }

  if (sections.important && sections.important.length > 0) {
    lines.push('TIPS / RECOMMENDATIONS:');
    for (const item of sections.important) {
      lines.push(`• ${item}`);
    }
    lines.push('');
  }

  if (sections.notes) {
    lines.push('NOTES:');
    lines.push(sections.notes);
    lines.push('');
  }

  lines.push(`TIME: ${sections.totalMinutesText}`);

  return lines.join('\n').trimEnd() + '\n';
}

// ── Sport family + intent helpers ──────────────────────────────────

type SportFamily = 'running' | 'cycling' | 'swimming' | 'strength' | 'other';

function sportFamilyForSession(
  sessionType: string,
  planSport: string,
  session?: Pick<SessionInput, 'title' | 'exercises'>,
): SportFamily {
  const t = (sessionType || '').toLowerCase();
  if (hasStrengthSessionEvidence(session) && !hasEnduranceOnlySessionType(t)) return 'strength';
  if (t.includes('run') || t === 'brick') return 'running';
  if (t.includes('ride') || t.includes('cycle') || t.includes('bike')) return 'cycling';
  if (t.includes('swim')) return 'swimming';
  if (t.includes('strength') || t.includes('lift') || t === 'mobility') return 'strength';

  // Fall through to plan-level sport hint.
  const s = (planSport || '').toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'cycling') return 'cycling';
  if (s === 'swimming' || s === 'swim') return 'swimming';
  if (s === 'strength' || s === 'gym' || s === 'lifting') return 'strength';
  return 'other';
}

function hasEnduranceOnlySessionType(sessionType: string): boolean {
  return sessionType === 'brick'
    || sessionType.includes('ride')
    || sessionType.includes('cycle')
    || sessionType.includes('bike')
    || sessionType.includes('swim');
}

function hasStrengthSessionEvidence(session?: Pick<SessionInput, 'title' | 'exercises'>): boolean {
  if (!session) return false;
  const title = (session.title || '').toLowerCase();
  const titleLooksStrength = /\b(strength|força|gym|lift|hypertrophy|hipertrofia|lower|upper|push|pull|legs|core|squats?|deadlifts?|bench|mobility)\b|\b(bench|overhead|strict|push|shoulder|military)\s+press\b/i
    .test(title);
  if (titleLooksStrength) return true;

  const exercises = session.exercises ?? [];
  if (exercises.length === 0) return false;
  const strengthPrescriptions = exercises.filter((ex) =>
    ex.sets != null
    || ex.reps != null
    || ex.rpe != null
    || ex.rest_sec != null
    || Boolean(ex.rest)
  ).length;
  const endurancePrescriptions = exercises.filter((ex) =>
    ex.distance_km != null
    || Boolean(ex.pace)
  ).length;
  return strengthPrescriptions > 0 && endurancePrescriptions === 0;
}

function isRawCoachDebugLine(line: string): boolean {
  return /\b(calendar_busy_blocks|session_prescription|fueling_gap_risk|coach_decision|decision_trail|source_trace)\b/i.test(line)
    || /\bmp\d+\b/i.test(line)
    || /·\s*mp\d+/i.test(line);
}

function isModalityMismatchedFreeText(line: string, sport: SportFamily): boolean {
  const value = line.toLowerCase();
  switch (sport) {
    case 'strength':
      return /\b(zone\s*2|walk breaks?|conversational|pace|\/km|hr drift|heart rate drift)\b/i.test(value);
    case 'running':
      return /\b(hypertrophy|reps in reserve|rir|sets?\s*[x×]\s*reps|barbell|dumbbell)\b/i.test(value);
    case 'cycling':
      return /\b(squats?|lunges?|deadlifts?|bench press|reps in reserve|rir|hypertrophy)\b/i.test(value);
    case 'swimming':
      return /\b(ftp|watts?|power zone|cadence|squats?|lunges?|deadlifts?)\b/i.test(value);
    default:
      return false;
  }
}

type RunIntent = 'easy' | 'long' | 'tempo' | 'threshold' | 'interval' | 'recovery';

function runIntentForSessionType(sessionType: string): RunIntent {
  switch (sessionType) {
    case 'easy_run': return 'easy';
    case 'long_run': return 'long';
    case 'tempo_run':
    case 'threshold_run': return 'tempo';
    case 'interval_run': return 'interval';
    case 'recovery_run': return 'recovery';
    default: return 'easy';
  }
}

function paceFromProfile(value: unknown): number | undefined {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value === 'string') {
    const parts = value.trim().split(':').map((p) => Number(p));
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
      return parts[0] * 60 + parts[1];
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return undefined;
}

function paceForRunIntent(intent: RunIntent, thresholdSecPerKm: number): string | undefined {
  // Multipliers anchored on threshold (1.00). Lower number = faster.
  const map: Record<RunIntent, [number, number]> = {
    recovery: [1.30, 1.40],
    easy: [1.20, 1.28],
    long: [1.15, 1.22],
    tempo: [1.02, 1.05],
    threshold: [1.00, 1.02],
    interval: [0.92, 0.97],
  };
  const [lo, hi] = map[intent];
  const lower = formatSecondsAsPace(thresholdSecPerKm * lo);
  const upper = formatSecondsAsPace(thresholdSecPerKm * hi);
  if (!lower || !upper) return undefined;
  return `${lower}-${upper}/km`;
}

function paceNote(intent: RunIntent): string | undefined {
  switch (intent) {
    case 'easy': return 'STRICT Zone 2, conversational';
    case 'long': return 'Steady, conversational, fuel mid-run';
    case 'tempo': return 'Comfortably hard — controlled';
    case 'threshold': return 'Sustained hard effort — not all-out';
    case 'interval': return 'Hard reps — full recovery between';
    case 'recovery': return 'Very easy shakeout';
  }
}

function rpeForRunIntent(intent: RunIntent): string {
  switch (intent) {
    case 'easy': return '4-5/10';
    case 'long': return '5-6/10';
    case 'tempo': return '7/10';
    case 'threshold': return '8/10';
    case 'interval': return '9/10 on reps, 4/10 between';
    case 'recovery': return '3-4/10';
  }
}

function rpeNoteForRunIntent(intent: RunIntent): string | undefined {
  switch (intent) {
    case 'easy': return 'You should be able to hold a conversation';
    case 'recovery': return 'Easier than you think it should feel';
    default: return undefined;
  }
}

function hrRangeForRunIntent(
  intent: RunIntent,
  lthr: number,
  maxHr: number,
): string | undefined {
  if (lthr <= 0 && maxHr <= 0) return undefined;

  // Estimate from LTHR primarily; fall back to MaxHR ratios.
  const estimate = (loFactor: number, hiFactor: number): string => {
    const lo = Math.round((lthr > 0 ? lthr : maxHr * 0.85) * loFactor);
    const hi = Math.round((lthr > 0 ? lthr : maxHr * 0.85) * hiFactor);
    return `${lo}-${hi} bpm`;
  };

  switch (intent) {
    case 'recovery': return estimate(0.65, 0.75);
    case 'easy': return estimate(0.78, 0.88);
    case 'long': return estimate(0.80, 0.90);
    case 'tempo': return estimate(0.95, 1.00);
    case 'threshold': return estimate(0.99, 1.04);
    case 'interval': return estimate(1.02, 1.08);
  }
}

type RideIntent = 'recovery' | 'endurance' | 'tempo' | 'threshold' | 'vo2';

function rideIntentForSessionType(sessionType: string): RideIntent {
  switch (sessionType) {
    case 'recovery_ride': return 'recovery';
    case 'endurance_ride': return 'endurance';
    case 'tempo_ride': return 'tempo';
    case 'threshold_ride': return 'threshold';
    case 'vo2_ride': return 'vo2';
    default: return 'endurance';
  }
}

function powerForRideIntent(intent: RideIntent, ftp: number): string {
  const map: Record<RideIntent, [number, number]> = {
    recovery: [0.40, 0.55],
    endurance: [0.56, 0.75],
    tempo: [0.76, 0.90],
    threshold: [0.91, 1.05],
    vo2: [1.06, 1.20],
  };
  const [lo, hi] = map[intent];
  return `${Math.round(ftp * lo)}-${Math.round(ftp * hi)} W (${Math.round(lo * 100)}-${Math.round(hi * 100)}% FTP)`;
}

function rideNote(intent: RideIntent): string | undefined {
  switch (intent) {
    case 'recovery': return 'Spin the legs, stay below conversational';
    case 'endurance': return 'All-day pace, conversational';
    case 'tempo': return 'Controlled pressure on the pedals';
    case 'threshold': return 'Sustained hard effort';
    case 'vo2': return 'Hard intervals with full recovery';
  }
}

function rpeForRideIntent(intent: RideIntent): string {
  switch (intent) {
    case 'recovery': return '2-3/10';
    case 'endurance': return '4-5/10';
    case 'tempo': return '6-7/10';
    case 'threshold': return '8/10';
    case 'vo2': return '9/10 on reps';
  }
}

function hrRangeForRideIntent(
  intent: RideIntent,
  lthr: number,
  maxHr: number,
): string | undefined {
  if (lthr <= 0 && maxHr <= 0) return undefined;
  const base = lthr > 0 ? lthr : maxHr * 0.85;
  const map: Record<RideIntent, [number, number]> = {
    recovery: [0.55, 0.70],
    endurance: [0.70, 0.82],
    tempo: [0.82, 0.92],
    threshold: [0.95, 1.02],
    vo2: [1.00, 1.05],
  };
  const [lo, hi] = map[intent];
  return `${Math.round(base * lo)}-${Math.round(base * hi)} bpm`;
}

type SwimIntent = 'recovery' | 'aerobic' | 'threshold' | 'speed' | 'technique';

function swimIntentForSessionType(sessionType: string): SwimIntent {
  switch (sessionType) {
    case 'recovery_swim': return 'recovery';
    case 'aerobic_swim': return 'aerobic';
    case 'threshold_swim': return 'threshold';
    case 'speed_swim': return 'speed';
    case 'technique_swim': return 'technique';
    default: return 'aerobic';
  }
}

function paceForSwimIntent(intent: SwimIntent, cssSec: number): string | undefined {
  const map: Record<SwimIntent, [number, number]> = {
    recovery: [1.20, 1.30],
    aerobic: [1.05, 1.15],
    threshold: [1.00, 1.03],
    speed: [0.92, 0.98],
    technique: [1.10, 1.20],
  };
  const [lo, hi] = map[intent];
  const lower = formatSecondsAsPace(cssSec * lo);
  const upper = formatSecondsAsPace(cssSec * hi);
  if (!lower || !upper) return undefined;
  return `${lower}-${upper}`;
}

function swimNote(intent: SwimIntent): string | undefined {
  switch (intent) {
    case 'recovery': return 'Easy and smooth';
    case 'aerobic': return 'Steady aerobic pace, even pacing';
    case 'threshold': return 'Hard but controlled';
    case 'speed': return 'Fast intervals, full recovery between';
    case 'technique': return 'Drill-focused, no chasing the clock';
  }
}

function rpeForSwimIntent(intent: SwimIntent): string {
  switch (intent) {
    case 'recovery': return '3/10';
    case 'aerobic': return '5/10';
    case 'threshold': return '7-8/10';
    case 'speed': return '9/10 on reps';
    case 'technique': return '4-5/10';
  }
}

// ── Generic helpers ────────────────────────────────────────────────

function formatSecondsAsPace(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function numericOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function emojiForSessionType(sessionType: string): string {
  const t = (sessionType || '').toLowerCase();
  if (t.includes('strength') || t.includes('lift') || t === 'mobility') return '💪';
  if (t.includes('run') || t === 'brick') return '🏃';
  if (t.includes('ride') || t.includes('cycle') || t.includes('bike')) return '🚴';
  if (t.includes('swim')) return '🏊';
  return '🏋️';
}

function sessionTypeReadableName(sessionType: string): string {
  const t = (sessionType || '').toLowerCase();
  switch (t) {
    case 'easy_run': return 'Easy run';
    case 'long_run': return 'Long run';
    case 'tempo_run': return 'Tempo run';
    case 'threshold_run': return 'Threshold run';
    case 'interval_run': return 'Interval run';
    case 'recovery_run': return 'Recovery run';
    case 'recovery_ride': return 'Recovery ride';
    case 'endurance_ride': return 'Endurance ride';
    case 'tempo_ride': return 'Tempo ride';
    case 'threshold_ride': return 'Threshold ride';
    case 'vo2_ride': return 'VO2 ride';
    case 'recovery_swim': return 'Recovery swim';
    case 'aerobic_swim': return 'Aerobic swim';
    case 'threshold_swim': return 'Threshold swim';
    case 'speed_swim': return 'Speed swim';
    case 'technique_swim': return 'Technique swim';
    case 'strength_max': return 'Strength — max';
    case 'strength_hypertrophy': return 'Strength — hypertrophy';
    case 'strength_maintenance': return 'Strength — maintenance';
    case 'mobility': return 'Mobility';
    case 'brick': return 'Brick';
    default: return sessionType?.replace(/_/g, ' ').trim() || 'Training';
  }
}

function sessionTypeAdjective(sessionType: string): string {
  const intent = runIntentForSessionType(sessionType);
  switch (intent) {
    case 'easy': return 'easy';
    case 'long': return 'long';
    case 'tempo': return 'tempo';
    case 'threshold': return 'threshold';
    case 'interval': return 'intervals';
    case 'recovery': return 'recovery';
  }
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function parseDate(iso: string): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function shortMonthDay(date: Date): string {
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

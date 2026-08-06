// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { loadCoachKnowledge } from './knowledge-loader';
import {
  buildMobilityRecoveryExerciseList,
  MOBILITY_TARGET_MAX_MINUTES,
  MOBILITY_TARGET_MIN_MINUTES,
} from './mobility-recovery-builder';
import { estimateStrengthSessionMinutes, trimOverstuffedStrengthSessionToDuration, validateSessionCoherence } from './session-coherence';
import { replaceSessionIntensityMetadataWithFinalSteadyPrescription } from './session-intensity-metadata';
import type { AthleteState, ExercisePrescription, FatigueCost, IntensityZone, Session, SessionType, Sport } from './types';
import { clamp, dayIndex, durationToLoad } from './utils';

export type RecoveryScenario =
  | 'mild_fatigue'
  | 'high_soreness'
  | 'low_readiness'
  | 'post_intensity_fatigue'
  | 'low_adherence_fatigue'
  | 'travel_fatigue'
  | 'hybrid_modality_overload';

export interface PoorRecoveryContext {
  athlete: AthleteState;
  session: Session;
  weekSessions: Session[];
  sessionIndex: number;
}

export interface PoorRecoveryAdaptation {
  session: Session;
  scenario: RecoveryScenario;
  explanation: string;
}

interface RecoveryVariant {
  title: string;
  sessionType: SessionType;
  description: string;
  durationMultiplier: number;
  minMinutes: number;
  maxMinutes: number;
  intensityZone: IntensityZone;
  fatigueCost: FatigueCost;
  tags: string[];
  alternatives: string[];
}

const TRAVEL_TERMS = [
  'travel',
  'travelling',
  'trip',
  'hotel',
  'flight',
  'airport',
  'road week',
  'limited equipment',
];

function textSignals(athlete: AthleteState): string {
  return [
    ...athlete.constraints.map((constraint) => constraint.description),
    ...(athlete.equipment.notes ?? []),
    ...(athlete.readiness.notes ?? []),
    ...athlete.recentSessions.flatMap((session) => [
      session.missedReason ?? '',
      ...(session.feedbackTags ?? []),
    ]),
  ].join(' ').toLowerCase();
}

function hasTravelSignal(athlete: AthleteState): boolean {
  const haystack = textSignals(athlete);
  return TRAVEL_TERMS.some((term) => haystack.includes(term));
}

function hasHighSorenessSignal(athlete: AthleteState): boolean {
  return athlete.readiness.soreness === 'high'
    || athlete.readiness.painFlags.some((flag) => flag.severity === 'moderate' || flag.severity === 'high')
    || athlete.recentSessions.some((session) => (session.sorenessLevel ?? 0) >= 7);
}

function hasPostIntensityFatigue(athlete: AthleteState): boolean {
  return athlete.recentSessions.some((session) =>
    session.completed
    && (session.fatigueCost === 'high' || session.fatigueCost === 'very_high')
    && ((session.rpe ?? 0) >= 8 || session.keySession === true)
  );
}

function hasHybridOverload(athlete: AthleteState, weekSessions: Session[]): boolean {
  const plannedSports = new Set(weekSessions.filter((session) => session.sessionType !== 'rest').map((session) => session.sport));
  const highStressCount = weekSessions.filter((session) =>
    session.fatigueCost === 'high' || session.fatigueCost === 'very_high' || session.keySession
  ).length;
  return (athlete.goals.primaryFocus === 'hybrid' || athlete.goals.primaryFocus === 'triathlon' || plannedSports.size >= 2)
    && highStressCount >= 2;
}

export function classifyRecoveryScenario(context: PoorRecoveryContext): RecoveryScenario {
  const { athlete, weekSessions } = context;
  if (hasTravelSignal(athlete)) return 'travel_fatigue';
  if (hasHighSorenessSignal(athlete)) return 'high_soreness';
  if (hasPostIntensityFatigue(athlete)) return 'post_intensity_fatigue';
  if (athlete.readiness.level === 'red' || athlete.readiness.score <= 40) return 'low_readiness';
  if (athlete.compliance.trailing14DayCompliance < 0.7 || athlete.compliance.consecutiveMisses >= 2) {
    return 'low_adherence_fatigue';
  }
  if (hasHybridOverload(athlete, weekSessions)) return 'hybrid_modality_overload';
  return 'mild_fatigue';
}

function ordinalForSport(session: Session, weekSessions: Session[]): number {
  return weekSessions
    .filter((candidate) => candidate.sport === session.sport && dayIndex(candidate.dayOfWeek) <= dayIndex(session.dayOfWeek))
    .sort((left, right) => dayIndex(left.dayOfWeek) - dayIndex(right.dayOfWeek))
    .findIndex((candidate) => candidate.id === session.id);
}

function stableVariantIndex(context: PoorRecoveryContext, optionCount: number): number {
  if (optionCount <= 1) return 0;
  const roleIndex = rolePreferredVariantIndex(context.session);
  if (roleIndex != null) return Math.min(roleIndex, optionCount - 1);
  const sportOrdinal = Math.max(0, ordinalForSport(context.session, context.weekSessions));
  const seed = context.athlete.currentBlock.weekIndex
    + dayIndex(context.session.dayOfWeek)
    + context.sessionIndex
    + sportOrdinal
    + context.session.sessionType.length;
  return seed % optionCount;
}

function rolePreferredVariantIndex(session: Session): number | null {
  if (session.sport === 'running') {
    if (session.sessionType === 'threshold_run' || session.sessionType === 'interval_run') return 0;
    if (session.sessionType === 'long_run') return 1;
  }
  if (session.sport === 'cycling' && (session.sessionType === 'threshold_ride' || session.sessionType === 'vo2_ride')) {
    return 0;
  }
  return null;
}

function recoveryVariantsFor(session: Session, scenario: RecoveryScenario, athlete: AthleteState): RecoveryVariant[] {
  if (session.sport === 'cycling') {
    const offBikeTravel = scenario === 'travel_fatigue' && !athlete.equipment.hasBikeTrainer;
    return offBikeTravel
      ? [{
        title: 'Off-Bike Mobility + Walk Reset',
        sessionType: 'mobility',
        description: 'Travel constraints make a quality ride unrealistic. Use an easy walk plus hips, calves, and thoracic mobility to restore legs without pretending this is bike fitness.',
        durationMultiplier: 0.42,
        minMinutes: 20,
        maxMinutes: 35,
        intensityZone: 'recovery',
        fatigueCost: 'low',
        tags: ['recovery_variant', 'travel_fatigue', 'off_bike'],
        alternatives: ['Easy hotel-bike spin if available', 'Full rest if sleep or travel stress is still high'],
      }]
      : [
        {
          title: session.sessionType === 'threshold_ride' || session.sessionType === 'vo2_ride'
            ? 'Recovery Spin - Intensity Removed'
            : 'Recovery Spin',
          sessionType: 'recovery_ride',
          description: 'Keep this as a true recovery spin. No surges, no testing, and finish fresher than you started.',
          durationMultiplier: scenario === 'low_readiness' ? 0.48 : 0.58,
          minMinutes: 25,
          maxMinutes: 45,
          intensityZone: 'recovery',
          fatigueCost: 'low',
          tags: ['recovery_variant', 'bike_restore'],
          alternatives: ['Cadence technique spin', 'Full rest if legs stay heavy'],
        },
        {
          title: 'Cadence Technique Spin',
          sessionType: 'recovery_ride',
          description: 'Stay easy and vary cadence in short controlled blocks. The goal is pedaling quality, not load.',
          durationMultiplier: 0.55,
          minMinutes: 25,
          maxMinutes: 40,
          intensityZone: 'recovery',
          fatigueCost: 'low',
          tags: ['recovery_variant', 'bike_technique'],
          alternatives: ['Recovery spin', 'Walk + mobility reset'],
        },
        {
          title: 'Easy Endurance Flush Ride',
          sessionType: 'recovery_ride',
          description: 'Use the lowest aerobic gear you can hold smoothly. Keep torque low and skip any tempo or threshold work.',
          durationMultiplier: 0.62,
          minMinutes: 30,
          maxMinutes: 50,
          intensityZone: 'recovery',
          fatigueCost: 'low',
          tags: ['recovery_variant', 'bike_flush'],
          alternatives: ['Cadence technique spin', 'Short recovery spin'],
        },
      ];
  }

  if (session.sport === 'running') {
    const travelTitle = scenario === 'travel_fatigue' ? 'Travel Recovery Jog / Walk' : 'Run-Walk Aerobic Reset';
    return [
      {
        title: session.sessionType === 'threshold_run' || session.sessionType === 'interval_run'
          ? 'Recovery Run - Intensity Removed'
          : 'Recovery Jog',
        sessionType: 'recovery_run',
        description: 'Keep cadence light and stay far below threshold. If form gets heavy, switch to brisk walking.',
        durationMultiplier: scenario === 'low_readiness' ? 0.45 : 0.55,
        minMinutes: 20,
        maxMinutes: 40,
        intensityZone: 'recovery',
        fatigueCost: 'low',
        tags: ['recovery_variant', 'run_restore'],
        alternatives: ['Run-walk aerobic reset', 'Walk + mobility reset'],
      },
      {
        title: travelTitle,
        sessionType: 'recovery_run',
        description: 'Alternate relaxed jogging and walking so the session restores rhythm without adding fatigue.',
        durationMultiplier: 0.5,
        minMinutes: 20,
        maxMinutes: 35,
        intensityZone: 'recovery',
        fatigueCost: 'low',
        tags: ['recovery_variant', 'run_walk'],
        alternatives: ['Full rest if soreness rises', 'Mobility + easy walk'],
      },
      {
        title: 'Form Drills + Easy Run',
        sessionType: 'recovery_run',
        description: 'Keep the run short, then use relaxed skips or strides only if mechanics feel smooth. No speed work.',
        durationMultiplier: 0.52,
        minMinutes: 20,
        maxMinutes: 35,
        intensityZone: 'recovery',
        fatigueCost: 'low',
        tags: ['recovery_variant', 'run_technique'],
        alternatives: ['Recovery jog', 'Walk + mobility reset'],
      },
    ];
  }

  if (session.sport === 'swimming') {
    return [
      {
        title: 'Technique Recovery Swim',
        sessionType: 'recovery_swim',
        description: 'Use easy technique work and long rests. Keep the water session restorative, not aerobic pressure.',
        durationMultiplier: 0.55,
        minMinutes: 20,
        maxMinutes: 40,
        intensityZone: 'recovery',
        fatigueCost: 'low',
        tags: ['recovery_variant', 'swim_technique'],
        alternatives: ['Mobility + walk reset', 'Full rest if illness or fatigue is high'],
      },
    ];
  }

  return [
    {
      title: 'Technique Strength + Mobility',
      sessionType: 'strength_maintenance',
      description: 'Use light technique work, move slowly, and finish with mobility. The goal is tissue signal without fatigue.',
      durationMultiplier: scenario === 'low_readiness' ? 0.48 : 0.58,
      minMinutes: 20,
      maxMinutes: 35,
      intensityZone: 'recovery',
      fatigueCost: 'low',
      tags: ['recovery_variant', 'strength_technique'],
      alternatives: ['Mobility + core reset', 'Full rest if pain or soreness increases'],
    },
    {
      title: 'Mobility + Core Reset',
      sessionType: 'mobility',
      description: 'Use breathing, trunk control, hips, ankles, and gentle carries if available. Skip loaded compounds today.',
      durationMultiplier: 0.45,
      minMinutes: 18,
      maxMinutes: 30,
      intensityZone: 'recovery',
      fatigueCost: 'low',
      tags: ['recovery_variant', 'mobility_core'],
      alternatives: ['Technique strength if energy improves', 'Walk + mobility reset'],
    },
    {
      title: 'Minimum-Dose Strength',
      sessionType: 'strength_maintenance',
      description: 'Keep one easy push, pull, lower-body, and trunk pattern. Stop every set well before fatigue accumulates.',
      durationMultiplier: 0.52,
      minMinutes: 22,
      maxMinutes: 35,
      intensityZone: 'recovery',
      fatigueCost: 'low',
      tags: ['recovery_variant', 'minimum_dose'],
      alternatives: ['Technique strength + mobility', 'Full rest if recovery worsens'],
    },
  ];
}

function recoveryDuration(original: Session, variant: RecoveryVariant): number {
  return clamp(
    Math.round(original.durationMinutes * variant.durationMultiplier),
    variant.minMinutes,
    variant.maxMinutes,
  );
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function scenarioExplanation(scenario: RecoveryScenario, session: Session, variant: RecoveryVariant): string {
  switch (scenario) {
    case 'travel_fatigue':
      return `${session.title} became ${variant.title} because travel constraints call for lower setup burden and lower fatigue.`;
    case 'low_adherence_fatigue':
      return `${session.title} became ${variant.title} to keep the week achievable while rebuilding consistency.`;
    case 'hybrid_modality_overload':
      return `${session.title} became ${variant.title} because hybrid load is already competing across modalities this week.`;
    case 'high_soreness':
      return `${session.title} became ${variant.title} because soreness or pain flags require a lower-load option.`;
    case 'post_intensity_fatigue':
      return `${session.title} became ${variant.title} after recent high-intensity work so recovery catches up.`;
    case 'low_readiness':
      return `${session.title} became ${variant.title} because low readiness requires lower intensity than the original session.`;
    case 'mild_fatigue':
      return `${session.title} became ${variant.title} to preserve rhythm while reducing fatigue.`;
  }
}

export function adaptSessionForPoorRecovery(context: PoorRecoveryContext): PoorRecoveryAdaptation {
  const scenario = classifyRecoveryScenario(context);
  const variants = recoveryVariantsFor(context.session, scenario, context.athlete);
  const variant = variants[stableVariantIndex(context, variants.length)];
  let durationMinutes = recoveryDuration(context.session, variant);
  const explanation = scenarioExplanation(scenario, context.session, variant);
  const tags = dedupeStrings([
    ...context.session.tags.filter((tag) => !tag.startsWith('key_')),
    ...variant.tags,
    scenario,
    'readiness_adjusted',
  ]);

  // The original strength session's exercise list was sized for the
  // original (longer) duration. Recovery shrinks `durationMinutes` to
  // 20-35 min, but inheriting the original exercises produces an
  // overstuffed session — the pattern flagged by `time_volume_coherence`
  // in the eval baseline (e.g. "Technique Strength + Mobility: claimed
  // 20min, estimated 51min"). Recompute the exercise list so the
  // recovery slot is honest.
  let exercises: ExercisePrescription[] | undefined = context.session.exercises;
  if (context.session.sport === 'strength' && variant.sessionType === 'mobility') {
    // P2 follow-up (closed-beta backlog, 2026-05-04 night): instead of
    // an empty exercise list (which used to force the duration-honesty
    // shrink to ~13 min), populate the mobility recovery slot with a
    // catalog-grounded mobility flow whose estimated content matches
    // the variant's claimed minutes. Falls back to empty-block if the
    // catalog can't span ≥3 distinct warmupNeeds buckets, in which
    // case the existing shrink path keeps the duration credible.
    const knowledge = loadCoachKnowledge();
    const mobilityList = buildMobilityRecoveryExerciseList(knowledge, durationMinutes);
    if (mobilityList) {
      exercises = mobilityList;
      // Keep the claim aligned to the catalog-grounded content. This
      // prevents later capacity reconciliation from trimming a valid
      // 4-exercise mobility flow merely because the old multiplier
      // placeholder landed at the lower 18-minute bound.
      durationMinutes = Math.max(
        MOBILITY_TARGET_MIN_MINUTES,
        Math.min(MOBILITY_TARGET_MAX_MINUTES, estimateStrengthSessionMinutes({ exercises: mobilityList }, knowledge)),
      );
    } else {
      exercises = [];
    }
  }

  let session: Session = {
    ...context.session,
    sessionType: variant.sessionType,
    title: variant.title,
    // Persist the causal adaptation on the public session itself. The
    // separate `explanation` return value feeds internal guardrail metadata,
    // but read-model consumers cannot see it unless it travels with the
    // session description.
    description: `${variant.description} ${explanation}`,
    intensityZone: variant.intensityZone,
    fatigueCost: variant.fatigueCost,
    keySession: false,
    durationMinutes,
    plannedLoad: durationToLoad(durationMinutes, variant.intensityZone, variant.fatigueCost),
    tags,
    alternatives: dedupeStrings([
      ...(context.session.alternatives ?? []),
      ...variant.alternatives,
    ]),
    exercises,
  };

  // For strength sport, the session's content has now diverged from
  // the original (mobility variants emptied the list; strength_maintenance
  // variants kept the original list). Reconcile the claimed duration
  // with the actual content:
  //   1. Strength_maintenance with exercises: trim trailing accessory
  //      volume until claimed duration is honest.
  //   2. After trim (or for empty mobility blocks), if still
  //      underfilled, shrink the claim to match estimated content.
  //
  // This guarantees the planner emits a recovery session whose
  // displayed minutes credibly match what the user will do — closing
  // the `time_volume_coherence` gap the eval baseline pinned at 82.
  if (session.sport === 'strength') {
    const knowledge = loadCoachKnowledge();
    if (variant.sessionType === 'strength_maintenance' && session.exercises?.length) {
      session = trimOverstuffedStrengthSessionToDuration(session, knowledge, {
        tag: 'recovery_duration_coherent',
        alternative: 'Trailing strength volume was trimmed so the recovery session matches the shrunk duration.',
      }).session;
    }
    const verdict = validateSessionCoherence(session, knowledge);
    if (!verdict.ok && verdict.reason === 'underfilled') {
      // The variant's `minMinutes` is a soft preference; the absolute
      // floor is warmup + cooldown (~12 min) so we never claim a
      // sub-credible duration. Honesty wins over the variant's
      // aspirational range.
      const honestDuration = Math.max(12, verdict.estimatedMinutes);
      if (honestDuration < session.durationMinutes) {
        session = {
          ...session,
          durationMinutes: honestDuration,
          plannedLoad: durationToLoad(honestDuration, variant.intensityZone, variant.fatigueCost),
          tags: dedupeStrings([...session.tags, 'recovery_duration_coherent']),
          alternatives: dedupeStrings([
            ...(session.alternatives ?? []),
            'Recovery duration was reduced to match what the trimmed content can credibly deliver.',
          ]),
        };
      }
    }
  }

  session = replaceSessionIntensityMetadataWithFinalSteadyPrescription(session);
  return { session, scenario, explanation };
}

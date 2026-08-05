// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  AthleteState,
  RecentSession,
  Session,
  Sport,
  TrainingFeedbackAnalysis,
  TrainingFeedbackDecision,
  WeeklyPlan,
} from './types';
import { loadCoachKnowledge } from './knowledge-loader';
import { trimOverstuffedStrengthSessionToDuration } from './session-coherence';
import { replaceSessionIntensityMetadataWithFinalSteadyPrescription } from './session-intensity-metadata';
import { cloneSessions, durationToLoad, sumMinutes } from './utils';

type CompletionBucket = 'completed' | 'partial' | 'skipped';

interface NormalizedFeedbackSample {
  session: RecentSession;
  status: CompletionBucket;
  plannedMinutes: number;
  actualMinutes: number;
  durationRatio?: number;
  rpe?: number;
  rir?: number;
  soreness?: number;
  tags: Set<string>;
}

const HARD_RPE = 8.5;
const EASY_RPE = 5.5;
const HIGH_SORENESS = 7;
const TOO_LONG_RATIO = 1.25;
const PARTIAL_RATIO = 0.72;

export function analyzeTrainingFeedback(athlete: AthleteState, generatedAt: string = new Date().toISOString()): TrainingFeedbackAnalysis {
  const samples = athlete.recentSessions.map(normalizeSample);
  const completionCounts = samples.reduce(
    (acc, sample) => {
      acc[sample.status] += 1;
      return acc;
    },
    { completed: 0, partial: 0, skipped: 0 } as TrainingFeedbackAnalysis['completionCounts'],
  );

  const sampleSize = samples.length;
  const averageRpe = average(samples.map((sample) => sample.rpe));
  const averageSoreness = average(samples.map((sample) => sample.soreness));
  const averageDurationRatio = average(samples.map((sample) => sample.durationRatio));

  const hardSignals = samples.filter((sample) =>
    (sample.rpe ?? 0) >= HARD_RPE
    || (sample.rir != null && sample.rir <= 0)
    || sample.tags.has('too_hard')
    || sample.tags.has('pain')
  ).length;
  const easySignals = samples.filter((sample) =>
    (sample.rpe != null && sample.rpe <= EASY_RPE)
    || (sample.rir != null && sample.rir >= 4)
    || sample.tags.has('too_easy')
    || sample.tags.has('underload')
  ).length;
  const tooLongSignals = samples.filter((sample) =>
    (sample.durationRatio != null && sample.durationRatio >= TOO_LONG_RATIO)
    || sample.tags.has('too_long')
  ).length;
  const substitutionSignals = samples.filter((sample) => sample.tags.has('substitution')).length;
  const hardSignalThreshold = Math.max(1, Math.ceil(sampleSize * 0.3));

  const adherenceClass = classifyAdherence(athlete, completionCounts, sampleSize);
  const recoveryClass = classifyRecovery(athlete, averageSoreness);
  const difficultyBias = classifyDifficulty({ hardSignals, easySignals, tooLongSignals, sampleSize });
  const plateauSports = detectPlateauSports(athlete);
  const timeCompressed = hasTimeCompressionSignal(athlete, samples);

  const decisions: TrainingFeedbackDecision[] = [];

  if (recoveryClass === 'critical') {
    decisions.push({
      code: 'low_recovery_deload',
      severity: 'block',
      reason: 'Readiness or soreness indicates the next plan should protect recovery before adding load.',
      evidence: compact([
        `readiness=${athlete.readiness.level}/${athlete.readiness.score}`,
        averageSoreness != null ? `avg_soreness=${averageSoreness}` : null,
      ]),
      volumeMultiplier: 0.68,
      intensityMultiplier: 0.65,
      durationMultiplier: 0.72,
    });
  } else if (recoveryClass === 'strained') {
    decisions.push({
      code: 'high_soreness_downshift',
      severity: 'action',
      reason: 'Recovery is strained enough to reduce density and avoid stacking key work.',
      evidence: compact([
        `readiness=${athlete.readiness.level}/${athlete.readiness.score}`,
        averageSoreness != null ? `avg_soreness=${averageSoreness}` : null,
      ]),
      volumeMultiplier: 0.82,
      intensityMultiplier: 0.78,
      durationMultiplier: 0.85,
    });
  }

  if (adherenceClass === 'broken' || athlete.compliance.consecutiveMisses >= 2) {
    decisions.push({
      code: 'poor_adherence_reentry',
      severity: 'action',
      reason: 'Adherence is low enough that the next week should be easier to complete, not simply regenerated.',
      evidence: [
        `compliance=${Math.round(athlete.compliance.trailing14DayCompliance * 100)}%`,
        `consecutive_misses=${athlete.compliance.consecutiveMisses}`,
        `skipped=${completionCounts.skipped}`,
      ],
      volumeMultiplier: 0.72,
      intensityMultiplier: 0.82,
      durationMultiplier: 0.82,
    });
  }

  if (athlete.compliance.missedKeySessions > 0) {
    decisions.push({
      code: 'missed_key_session_rebuild',
      severity: 'watch',
      reason: 'A key session was missed, so the next plan should preserve rhythm without stacking catch-up intensity.',
      evidence: [`missed_key_sessions=${athlete.compliance.missedKeySessions}`],
      volumeMultiplier: 0.9,
      intensityMultiplier: 0.88,
    });
  }

  if (timeCompressed) {
    decisions.push({
      code: 'duration_compression',
      severity: 'action',
      reason: 'The user has declared or demonstrated time compression, so sessions should become shorter and denser.',
      evidence: ['time_constraint_or_feedback_detected'],
      durationMultiplier: 0.82,
      volumeMultiplier: 0.9,
    });
  } else if (tooLongSignals >= Math.max(1, Math.ceil(sampleSize * 0.25))) {
    decisions.push({
      code: 'too_long_duration_cap',
      severity: 'action',
      reason: 'Recent sessions are taking materially longer than planned.',
      evidence: compact([
        `too_long_signals=${tooLongSignals}`,
        averageDurationRatio != null ? `avg_duration_ratio=${averageDurationRatio}` : null,
      ]),
      durationMultiplier: 0.86,
    });
  }

  if (difficultyBias === 'too_hard' || (difficultyBias === 'too_long' && hardSignals >= hardSignalThreshold)) {
    decisions.push({
      code: 'too_hard_intensity_downshift',
      severity: 'action',
      reason: 'Recent feedback says the prescribed work is too hard.',
      evidence: compact([
        `hard_signals=${hardSignals}`,
        averageRpe != null ? `avg_rpe=${averageRpe}` : null,
      ]),
      intensityMultiplier: 0.82,
      durationMultiplier: 0.92,
    });
  }

  if (difficultyBias === 'too_easy' && adherenceClass === 'strong' && recoveryClass === 'ready') {
    decisions.push({
      code: 'too_easy_progression',
      severity: 'action',
      reason: 'The athlete is completing work easily with enough recovery, so progression can move forward.',
      evidence: compact([
        `easy_signals=${easySignals}`,
        averageRpe != null ? `avg_rpe=${averageRpe}` : null,
      ]),
      volumeMultiplier: 1.06,
      intensityMultiplier: 1.05,
      durationMultiplier: 1.04,
    });
  } else if (adherenceClass === 'strong' && recoveryClass === 'ready' && difficultyBias === 'balanced') {
    decisions.push({
      code: 'positive_progression',
      severity: 'info',
      reason: 'Adherence and recovery support a conservative progression.',
      evidence: [`compliance=${Math.round(athlete.compliance.trailing14DayCompliance * 100)}%`],
      volumeMultiplier: 1.04,
      intensityMultiplier: 1.03,
    });
  }

  for (const sport of plateauSports) {
    decisions.push({
      code: 'plateau_variation',
      severity: 'watch',
      sport,
      reason: `${sport} history is flat enough to warrant variation before more of the same work.`,
      evidence: [`${sport}_trailing4=${(athlete.trainingHistory.trailing4WeekMinutesBySport[sport] ?? []).join(',')}`],
      intensityMultiplier: 1.0,
    });
  }

  if (substitutionSignals >= 2) {
    decisions.push({
      code: 'repeated_substitution_review',
      severity: 'watch',
      reason: 'Repeated substitutions suggest equipment, pain, or preference mismatch.',
      evidence: [`substitution_signals=${substitutionSignals}`],
    });
  }

  const progressionState = classifyProgressionState(decisions, adherenceClass, recoveryClass);
  const notes = decisions.map(formatDecisionNote);

  return {
    generatedAt,
    sampleSize,
    completionCounts,
    adherenceClass,
    recoveryClass,
    difficultyBias,
    progressionState,
    averageRpe,
    averageSoreness,
    averageDurationRatio,
    decisions: dedupeDecisions(decisions),
    notes: dedupeStrings(notes),
  };
}

export function feedbackNotes(analysis?: TrainingFeedbackAnalysis): string[] {
  if (!analysis || analysis.decisions.length === 0) return [];
  return analysis.notes.map((note) => `Feedback loop: ${note}`);
}

export function applyFeedbackToAthleteState(athlete: AthleteState, analysis: TrainingFeedbackAnalysis): AthleteState {
  const shouldReduceSessionCount = analysis.adherenceClass === 'broken'
    || analysis.decisions.some((decision) =>
      decision.code === 'poor_adherence_reentry'
      || decision.code === 'duration_compression'
      || decision.code === 'too_long_duration_cap'
    );
  const adjustedTargets = { ...athlete.goals.weeklySessionsTarget };

  if (shouldReduceSessionCount) {
    for (const sport of Object.keys(adjustedTargets) as Sport[]) {
      const value = adjustedTargets[sport];
      if (typeof value === 'number' && value > 1) {
        adjustedTargets[sport] = Math.max(1, value - 1);
      }
    }
  }

  const targetPhase = analysis.progressionState === 'deload'
    ? 'deload'
    : analysis.progressionState === 'reentry'
      ? 'maintenance'
      : athlete.currentBlock.phase;

  return {
    ...athlete,
    feedbackAnalysis: analysis,
    goals: {
      ...athlete.goals,
      weeklySessionsTarget: adjustedTargets,
    },
    currentBlock: {
      ...athlete.currentBlock,
      phase: targetPhase,
      volumeProgressionPct: adjustedVolumeProgressionPct(athlete.currentBlock.volumeProgressionPct, analysis),
    },
    availability: {
      ...athlete.availability,
      maxSessionsPerDay: analysis.progressionState === 'reentry' ? 1 : athlete.availability.maxSessionsPerDay,
    },
  };
}

export interface ApplyFeedbackToWeeklyPlanOptions {
  /** Zero-based week position used to rotate recovery-only truncation. */
  strengthRecoveryRotationIndex?: number;
}

export function applyFeedbackToWeeklyPlan(
  plan: WeeklyPlan,
  analysis?: TrainingFeedbackAnalysis,
  options: ApplyFeedbackToWeeklyPlanOptions = {},
): WeeklyPlan {
  if (!analysis || analysis.decisions.length === 0) return plan;

  let sessions = cloneSessions(plan.sessions);
  const durationMultiplier = combinedMultiplier(analysis, 'durationMultiplier');
  const intensityMultiplier = combinedMultiplier(analysis, 'intensityMultiplier');
  const volumeMultiplier = combinedMultiplier(analysis, 'volumeMultiplier');
  const effectiveDurationMultiplier = combineDurationAndVolumeMultipliers(durationMultiplier, volumeMultiplier);
  const shouldProgress = analysis.decisions.some((decision) =>
    decision.code === 'too_easy_progression' || decision.code === 'positive_progression'
  );
  const shouldVary = new Set(
    analysis.decisions
      .filter((decision) => decision.code === 'plateau_variation' && decision.sport)
      .map((decision) => decision.sport as Sport),
  );

  if (effectiveDurationMultiplier !== 1 || intensityMultiplier < 1) {
    sessions = sessions.map((session) => adaptSessionLoad(
      session,
      effectiveDurationMultiplier,
      intensityMultiplier,
      analysis,
      plan.weekStart,
      options.strengthRecoveryRotationIndex,
    ));
  }

  if (shouldProgress) {
    sessions = sessions.map(progressSession);
  }

  if (shouldVary.size > 0) {
    sessions = sessions.map((session) => {
      if (!shouldVary.has(session.sport)) return session;
      return {
        ...session,
        title: session.title.includes('Variation') ? session.title : `${session.title} Variation`,
        tags: dedupeStrings([...session.tags, 'plateau_variation']),
        alternatives: dedupeStrings([...(session.alternatives ?? []), 'Rotate the main stimulus while preserving the session role']),
      };
    });
  }

  const nextPlan: WeeklyPlan = {
    ...plan,
    phase: analysis.progressionState === 'deload' ? 'deload' : plan.phase,
    sessions,
    notes: dedupeStrings([
      ...plan.notes,
      ...feedbackNotes(analysis),
    ]),
  };

  return nextPlan;
}

function normalizeSample(session: RecentSession): NormalizedFeedbackSample {
  const plannedMinutes = Math.max(0, session.plannedDurationMinutes ?? session.durationMinutes);
  const actualMinutes = Math.max(0, session.actualDurationMinutes ?? session.durationMinutes);
  const durationRatio = plannedMinutes > 0 && actualMinutes > 0
    ? round(actualMinutes / plannedMinutes, 2)
    : undefined;
  const status = normalizeStatus(session, durationRatio);
  return {
    session,
    status,
    plannedMinutes,
    actualMinutes,
    durationRatio,
    rpe: finiteNumber(session.rpe),
    rir: finiteNumber(session.rir),
    soreness: finiteNumber(session.sorenessLevel),
    tags: new Set(session.feedbackTags ?? []),
  };
}

function normalizeStatus(session: RecentSession, durationRatio?: number): CompletionBucket {
  if (session.completionStatus) return session.completionStatus;
  if (!session.completed) return 'skipped';
  if (durationRatio != null && durationRatio > 0 && durationRatio < PARTIAL_RATIO) return 'partial';
  return 'completed';
}

function classifyAdherence(
  athlete: AthleteState,
  counts: TrainingFeedbackAnalysis['completionCounts'],
  sampleSize: number,
): TrainingFeedbackAnalysis['adherenceClass'] {
  const compliance = athlete.compliance.trailing14DayCompliance;
  const skippedRatio = sampleSize > 0 ? counts.skipped / sampleSize : 0;
  if (compliance < 0.45 || athlete.compliance.consecutiveMisses >= 3 || skippedRatio >= 0.45) return 'broken';
  if (compliance < 0.7 || athlete.compliance.consecutiveMisses >= 1 || skippedRatio >= 0.25) return 'fragile';
  if (compliance >= 0.88 && counts.skipped === 0) return 'strong';
  return 'steady';
}

function classifyRecovery(
  athlete: AthleteState,
  averageSoreness?: number,
): TrainingFeedbackAnalysis['recoveryClass'] {
  if (athlete.readiness.level === 'red' || athlete.readiness.score < 40 || (averageSoreness ?? 0) >= 8.5) return 'critical';
  if (athlete.readiness.level === 'orange' || athlete.readiness.score < 58 || (averageSoreness ?? 0) >= HIGH_SORENESS) return 'strained';
  if (athlete.readiness.level === 'yellow' || athlete.readiness.score < 75 || (averageSoreness ?? 0) >= 5.5) return 'watch';
  return 'ready';
}

function classifyDifficulty(args: {
  hardSignals: number;
  easySignals: number;
  tooLongSignals: number;
  sampleSize: number;
}): TrainingFeedbackAnalysis['difficultyBias'] {
  const threshold = Math.max(1, Math.ceil(args.sampleSize * 0.3));
  if (args.tooLongSignals >= threshold) return 'too_long';
  if (args.hardSignals >= threshold && args.easySignals >= threshold) return 'mixed';
  if (args.hardSignals >= threshold) return 'too_hard';
  if (args.easySignals >= threshold) return 'too_easy';
  return 'balanced';
}

function classifyProgressionState(
  decisions: TrainingFeedbackDecision[],
  adherence: TrainingFeedbackAnalysis['adherenceClass'],
  recovery: TrainingFeedbackAnalysis['recoveryClass'],
): TrainingFeedbackAnalysis['progressionState'] {
  if (decisions.some((decision) => decision.code === 'low_recovery_deload' || decision.code === 'high_soreness_downshift')) return 'deload';
  if (decisions.some((decision) => decision.code === 'poor_adherence_reentry') || adherence === 'broken') return 'reentry';
  if (decisions.some((decision) => decision.code === 'plateau_variation')) return 'variation';
  if (recovery === 'watch' || adherence === 'fragile') return 'hold';
  if (decisions.some((decision) => decision.code === 'too_easy_progression' || decision.code === 'positive_progression')) return 'build';
  return 'hold';
}

function detectPlateauSports(athlete: AthleteState): Sport[] {
  const sports: Sport[] = ['running', 'cycling', 'swimming', 'strength'];
  return sports.filter((sport) => {
    const series = athlete.trainingHistory.trailing4WeekMinutesBySport[sport];
    if (!series || series.length < 4) return false;
    const nonZero = series.filter((value) => value > 0);
    if (nonZero.length < 3) return false;
    const first = nonZero[0];
    const last = nonZero[nonZero.length - 1];
    if (first <= 0) return false;
    const deltaPct = Math.abs((last - first) / first);
    return deltaPct <= 0.025 && athlete.compliance.trailing14DayCompliance >= 0.75;
  });
}

function hasTimeCompressionSignal(athlete: AthleteState, samples: NormalizedFeedbackSample[]): boolean {
  const hasHighTimeConstraint = athlete.constraints.some((constraint) => constraint.type === 'time' && constraint.severity === 'high');
  if (hasHighTimeConstraint) return true;
  return samples.some((sample) => sample.tags.has('time_loss') || sample.tags.has('travel'));
}

function applyIntensityDescription(session: Session, analysis: TrainingFeedbackAnalysis): string {
  if (analysis.progressionState === 'deload') {
    return `${session.description} Feedback loop: reduce load today and leave more reps in reserve.`;
  }
  if (analysis.difficultyBias === 'too_hard') {
    return `${session.description} Feedback loop: cap intensity before chasing extra volume.`;
  }
  if (analysis.difficultyBias === 'too_long') {
    return `${session.description} Feedback loop: keep transitions tight and stop at the prescribed time cap.`;
  }
  return session.description;
}

function adaptSessionLoad(
  session: Session,
  durationMultiplier: number,
  intensityMultiplier: number,
  analysis: TrainingFeedbackAnalysis,
  weekStart: string,
  strengthRecoveryRotationIndex?: number,
): Session {
  if (session.sessionType === 'rest') return session;
  const nextDuration = durationMultiplier < 1
    ? Math.max(20, Math.round(session.durationMinutes * durationMultiplier))
    : Math.round(session.durationMinutes * durationMultiplier);
  const downshift = intensityMultiplier < 0.9 || analysis.progressionState === 'deload';
  const nextIntensity = downshift && (session.intensityZone === 'threshold' || session.intensityZone === 'vo2')
    ? 'aerobic'
    : downshift && session.intensityZone === 'tempo'
      ? 'aerobic'
      : session.intensityZone;
  const nextFatigue = downshift && session.fatigueCost === 'very_high'
    ? 'medium'
    : downshift && session.fatigueCost === 'high'
      ? 'medium'
      : session.fatigueCost;
  let adapted: Session = {
    ...session,
    durationMinutes: nextDuration,
    intensityZone: nextIntensity,
    fatigueCost: nextFatigue,
    keySession: downshift && analysis.recoveryClass !== 'critical' ? false : session.keySession,
    description: applyIntensityDescription(session, analysis),
    plannedLoad: durationToLoad(nextDuration, nextIntensity, nextFatigue),
    tags: dedupeStrings([...session.tags, `feedback_${analysis.progressionState}`]),
  };

  adapted = applyReentryEnduranceIdentity(adapted, analysis);
  if (downshift && adapted.sport !== 'strength') {
    adapted = replaceSessionIntensityMetadataWithFinalSteadyPrescription(adapted);
  }
  adapted.plannedLoad = durationToLoad(
    adapted.durationMinutes,
    adapted.intensityZone,
    adapted.fatigueCost,
  );

  return enforceFeedbackStrengthCoherence(
    applyMinimumDoseStrengthFallback(adapted, analysis, weekStart),
    analysis.progressionState === 'deload' ? strengthRecoveryRotationIndex : undefined,
  );
}

function applyReentryEnduranceIdentity(
  session: Session,
  analysis: TrainingFeedbackAnalysis,
): Session {
  if (analysis.progressionState !== 'reentry' || session.sport === 'strength') return session;

  const identity = session.sport === 'running'
    ? { sessionType: 'easy_run' as const, title: 'Re-entry Easy Run' }
    : session.sport === 'cycling'
      ? { sessionType: 'recovery_ride' as const, title: 'Re-entry Recovery Ride' }
      : { sessionType: 'recovery_swim' as const, title: 'Re-entry Recovery Swim' };

  return {
    ...session,
    ...identity,
    description: `Adherence re-entry aerobic session replacing ${session.title}; keep the effort easy and finish able to repeat it.`,
    intensityZone: 'recovery',
    fatigueCost: 'low',
    keySession: false,
    sourceTemplateId: undefined,
    sessionRole: 'recovery',
    sessionRoleLabel: 'Recovery',
    sessionRoleSummary: 'Easy, repeatable work that rebuilds consistency after missed sessions.',
    keySessionLabel: undefined,
    intensityProfile: undefined,
    intensitySummary: undefined,
    tags: dedupeStrings(session.tags.filter((tag) =>
      !/(?:key_session|role_long|run_long|threshold|interval|tempo|vo2)/i.test(tag)
    ).concat(['reentry_easy', 'adherence_realistic'])),
  };
}

function progressSession(session: Session): Session {
  if (session.sessionType === 'rest') return session;
  if (session.sport === 'strength' && session.exercises?.length) {
    return {
      ...session,
      exercises: session.exercises.map((exercise, index) => ({
        ...exercise,
        sets: index < 2 ? Math.min(6, exercise.sets + 1) : exercise.sets,
        rir: exercise.rir != null ? Math.max(1, exercise.rir - 1) : 2,
        notes: exercise.notes
          ? `${exercise.notes} Progression: add load if all reps are clean.`
          : 'Progression: add load if all reps are clean.',
      })),
      tags: dedupeStrings([...session.tags, 'feedback_progression']),
    };
  }
  const nextDuration = Math.round(session.durationMinutes * 1.05);
  return {
    ...session,
    durationMinutes: nextDuration,
    plannedLoad: durationToLoad(nextDuration, session.intensityZone, session.fatigueCost),
    tags: dedupeStrings([...session.tags, 'feedback_progression']),
  };
}

function shouldUseMinimumDoseStrength(analysis: TrainingFeedbackAnalysis): boolean {
  return analysis.progressionState === 'reentry'
    || analysis.difficultyBias === 'too_long'
    || analysis.decisions.some((decision) =>
      decision.code === 'duration_compression'
      || decision.code === 'too_long_duration_cap'
      || decision.code === 'poor_adherence_reentry'
    );
}

function applyMinimumDoseStrengthFallback(
  session: Session,
  analysis: TrainingFeedbackAnalysis,
  weekStart: string,
): Session {
  if (!shouldUseMinimumDoseStrength(analysis)) return session;
  if (session.sport !== 'strength' || !session.exercises?.length) return session;

  const keepCount = analysis.progressionState === 'reentry' ? 2 : Math.min(3, session.exercises.length);
  const durationCap = analysis.progressionState === 'reentry' ? 20 : 25;
  const orderedExercises = rotateMinimumDoseExercises(session.exercises, keepCount, analysis, weekStart);
  const exercises = orderedExercises.slice(0, keepCount).map((exercise, index) => ({
    ...exercise,
    sets: Math.min(exercise.sets, 2),
    rir: exercise.rir != null ? Math.max(exercise.rir, 3) : 3,
    restSec: Math.min(exercise.restSec ?? (index === 0 ? 75 : 60), index === 0 ? 75 : 60),
    notes: exercise.notes
      ? `${exercise.notes} Minimum-dose fallback: keep quality high and stop while the session still feels repeatable.`
      : 'Minimum-dose fallback: keep quality high and stop while the session still feels repeatable.',
  }));
  const durationMinutes = Math.min(session.durationMinutes, durationCap);

  return {
    ...session,
    title: session.title.includes('Minimum Dose') ? session.title : `${session.title} - Minimum Dose`,
    description: `${session.description} Minimum-dose version: fewer movements, lower fatigue, and clear stopping point so the user can sustain the week.`,
    durationMinutes,
    fatigueCost: session.fatigueCost === 'very_high' || session.fatigueCost === 'high' ? 'medium' : session.fatigueCost,
    plannedLoad: durationToLoad(
      durationMinutes,
      session.intensityZone,
      session.fatigueCost === 'very_high' || session.fatigueCost === 'high' ? 'medium' : session.fatigueCost,
    ),
    exercises,
    alternatives: dedupeStrings([
      ...(session.alternatives ?? []),
      'If time is still tight, complete only the first exercise plus one core movement.',
    ]),
    tags: dedupeStrings([...session.tags, 'minimum_effective_dose', 'adherence_realistic']),
  };
}

function rotateMinimumDoseExercises(
  exercises: NonNullable<Session['exercises']>,
  keepCount: number,
  analysis: TrainingFeedbackAnalysis,
  weekStart: string,
): NonNullable<Session['exercises']> {
  if (analysis.progressionState !== 'reentry' || exercises.length <= keepCount) return exercises;
  const weekIndex = Math.floor(Date.parse(weekStart) / (7 * 24 * 60 * 60 * 1000));
  if (!Number.isFinite(weekIndex)) return exercises;
  const groupCount = Math.ceil(exercises.length / keepCount);
  const offset = (Math.abs(weekIndex) % groupCount) * keepCount;
  return exercises.map((_, index) => exercises[(offset + index) % exercises.length]);
}

function enforceFeedbackStrengthCoherence(
  session: Session,
  recoveryRotationIndex?: number,
): Session {
  if (session.sport !== 'strength' || !session.exercises?.length) return session;
  return trimOverstuffedStrengthSessionToDuration(session, loadCoachKnowledge(), {
    tag: 'feedback_duration_coherent',
    alternative: 'Feedback time cap trimmed trailing strength volume so the session matches the scheduled duration.',
    recoveryRotationIndex,
  }).session;
}

function adjustedVolumeProgressionPct(current: number, analysis: TrainingFeedbackAnalysis): number {
  if (analysis.progressionState === 'deload') return Math.min(current, -15);
  if (analysis.progressionState === 'reentry') return Math.min(current, 0);
  if (analysis.progressionState === 'build') return Math.max(current, 6);
  return Math.min(current, 3);
}

function combinedMultiplier(
  analysis: TrainingFeedbackAnalysis,
  field: 'volumeMultiplier' | 'intensityMultiplier' | 'durationMultiplier',
): number {
  const values = analysis.decisions
    .map((decision) => decision[field])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (values.length === 0) return 1;
  const product = values.reduce((acc, value) => acc * value, 1);
  return round(Math.max(0.55, Math.min(1.18, product)), 2);
}

function combineDurationAndVolumeMultipliers(durationMultiplier: number, volumeMultiplier: number): number {
  if (durationMultiplier === 1) return volumeMultiplier;
  if (volumeMultiplier === 1) return durationMultiplier;
  if (durationMultiplier < 1 || volumeMultiplier < 1) return Math.min(durationMultiplier, volumeMultiplier);
  return Math.max(durationMultiplier, volumeMultiplier);
}

function formatDecisionNote(decision: TrainingFeedbackDecision): string {
  const suffix = decision.evidence.length ? ` (${decision.evidence.join('; ')})` : '';
  return `${decision.reason}${suffix}`;
}

function dedupeDecisions(decisions: TrainingFeedbackDecision[]): TrainingFeedbackDecision[] {
  const seen = new Set<string>();
  return decisions.filter((decision) => {
    const key = `${decision.code}:${decision.sport ?? 'all'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function average(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return round(finite.reduce((sum, value) => sum + value, 0) / finite.length, 1);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

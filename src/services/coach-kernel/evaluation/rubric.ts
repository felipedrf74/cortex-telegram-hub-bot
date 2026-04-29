// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { loadCoachKnowledge } from '../knowledge-loader';
import { estimateStrengthSessionMinutes, suggestCorrection, validateSessionCoherence } from '../session-coherence';
import type { AthleteState, CoachKnowledgeBase, Exercise, Session, Sport, WeeklyPlan } from '../types';
import { DAY_ORDER } from '../utils';
import { exerciseConflictsWithUserPain, getExerciseComplexity, getExerciseSpinalLoading } from '../exercise-metadata';
import { isActiveTrainingSession } from '../capacity-reconciliation';
import type {
  TrainingEvalCase,
  TrainingEvalDimension,
  TrainingEvalDimensionScore,
} from './types';

export const TRAINING_EVAL_DIMENSION_WEIGHTS: Record<TrainingEvalDimension, number> = {
  profile_fit: 1.2,
  plan_coherence: 1.3,
  weekly_structure_quality: 1,
  session_role_differentiation: 1,
  variety_quality: 1,
  time_volume_coherence: 1.4,
  modality_quality: 1.1,
  progression_quality: 0.9,
  adaptability_quality: 1.2,
  substitution_quality: 1,
  biomechanics_quality: 1,
  adherence_realism: 1,
  explainability: 1,
  agenda_lifecycle_correctness: 1.2,
  warning_quality_deduplication: 0.8,
};

interface ScoreDraft {
  score: number;
  observations: string[];
  penalties: string[];
}

interface RubricContext {
  evalCase: TrainingEvalCase;
  plan: WeeklyPlan;
  nextVersionPlan?: WeeklyPlan;
  knowledge: CoachKnowledgeBase;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function score(dimension: TrainingEvalDimension, draft: ScoreDraft): TrainingEvalDimensionScore {
  return {
    dimension,
    score: clampScore(draft.score),
    weight: TRAINING_EVAL_DIMENSION_WEIGHTS[dimension],
    observations: draft.observations,
    penalties: draft.penalties,
  };
}

function countBySport(sessions: Session[]): Partial<Record<Sport, number>> {
  return sessions.reduce<Partial<Record<Sport, number>>>((acc, session) => {
    acc[session.sport] = (acc[session.sport] ?? 0) + 1;
    return acc;
  }, {});
}

function activeSessions(plan: WeeklyPlan): Session[] {
  return plan.sessions.filter(isActiveTrainingSession);
}

function uniqueCount(values: Array<string | undefined>): number {
  return new Set(values.filter((value): value is string => Boolean(value))).size;
}

function sessionsByDay(sessions: Session[]): Record<string, Session[]> {
  return sessions.reduce<Record<string, Session[]>>((acc, session) => {
    acc[session.dayOfWeek] ??= [];
    acc[session.dayOfWeek].push(session);
    return acc;
  }, {});
}

function sessionFitsWindow(athlete: AthleteState, session: Session): boolean {
  const windows = athlete.availability.weeklyWindows.filter((window) =>
    window.dayOfWeek === session.dayOfWeek
    && (!window.sports || window.sports.length === 0 || window.sports.includes(session.sport))
  );
  if (windows.length === 0) return false;
  if (!session.startTime || !session.endTime) return true;
  const toMinutes = (value: string): number => {
    const [h, m] = value.split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMinutes(session.startTime);
  const end = toMinutes(session.endTime);
  return windows.some((window) => start >= toMinutes(window.start) && end <= toMinutes(window.end));
}

function findExercise(id: string, knowledge: CoachKnowledgeBase): Exercise | undefined {
  return knowledge.exercises.find((exercise) => exercise.id === id);
}

function allExercisePrescriptions(plan: WeeklyPlan, knowledge: CoachKnowledgeBase): Array<{ session: Session; exercise: NonNullable<Session['exercises']>[number]; meta?: Exercise }> {
  return activeSessions(plan).flatMap((session) =>
    (session.exercises ?? []).map((exercise) => ({ session, exercise, meta: findExercise(exercise.exerciseId, knowledge) }))
  );
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function scoreProfileFit({ evalCase, plan }: RubricContext): TrainingEvalDimensionScore {
  const expected = evalCase.persona.expectations;
  const sessions = activeSessions(plan);
  const bySport = countBySport(sessions);
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];

  for (const sport of expected.expectedSports) {
    if ((bySport[sport] ?? 0) === 0) {
      value -= 22;
      penalties.push(`Expected ${sport} but plan has none.`);
    }
  }
  const unexpected = Object.keys(bySport).filter((sport) => !expected.expectedSports.includes(sport as Sport));
  if (unexpected.length > 0) {
    value -= unexpected.length * 8;
    penalties.push(`Unexpected sports surfaced: ${unexpected.join(', ')}.`);
  }
  if (expected.minStrengthSessions != null && (bySport.strength ?? 0) < expected.minStrengthSessions) {
    value -= 12;
    penalties.push(`Strength sessions below persona minimum (${bySport.strength ?? 0}/${expected.minStrengthSessions}).`);
  }
  if (expected.maxStrengthSessions != null && (bySport.strength ?? 0) > expected.maxStrengthSessions) {
    value -= 12;
    penalties.push(`Strength sessions above persona maximum (${bySport.strength ?? 0}/${expected.maxStrengthSessions}).`);
  }
  if (expected.minRunningSessions != null && (bySport.running ?? 0) < expected.minRunningSessions) {
    value -= 12;
    penalties.push(`Running sessions below persona minimum (${bySport.running ?? 0}/${expected.minRunningSessions}).`);
  }
  if (expected.minCyclingSessions != null && (bySport.cycling ?? 0) < expected.minCyclingSessions) {
    value -= 12;
    penalties.push(`Cycling sessions below persona minimum (${bySport.cycling ?? 0}/${expected.minCyclingSessions}).`);
  }
  observations.push(`Sports: ${Object.entries(bySport).map(([sport, count]) => `${sport}:${count}`).join(', ') || 'none'}.`);
  return score('profile_fit', { score: value, observations, penalties });
}

function scorePlanCoherence({ evalCase, plan }: RubricContext): TrainingEvalDimensionScore {
  const expected = evalCase.persona.expectations;
  const sessions = activeSessions(plan);
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  if (sessions.length === 0) {
    value -= 80;
    penalties.push('Plan has no active scheduled sessions.');
  }
  if (expected.minTotalSessions != null && sessions.length < expected.minTotalSessions) {
    value -= 12;
    penalties.push(`Active sessions below minimum (${sessions.length}/${expected.minTotalSessions}).`);
  }
  if (expected.maxTotalSessions != null && sessions.length > expected.maxTotalSessions) {
    value -= 12;
    penalties.push(`Active sessions above maximum (${sessions.length}/${expected.maxTotalSessions}).`);
  }
  const missingCore = sessions.filter((session) => !session.title || session.durationMinutes <= 0 || !session.sessionType);
  if (missingCore.length > 0) {
    value -= missingCore.length * 8;
    penalties.push(`${missingCore.length} sessions miss title, duration, or session type.`);
  }
  const negativeLoad = sessions.filter((session) => session.plannedLoad < 0);
  if (negativeLoad.length > 0) {
    value -= 20;
    penalties.push('Some sessions have negative planned load.');
  }
  observations.push(`${sessions.length} active sessions, ${sessions.reduce((sum, session) => sum + session.durationMinutes, 0)} scheduled minutes; ${plan.sessions.length - sessions.length} inactive/deferred.`);
  return score('plan_coherence', { score: value, observations, penalties });
}

function scoreWeeklyStructure({ evalCase, plan }: RubricContext): TrainingEvalDimensionScore {
  const sessions = activeSessions(plan);
  const maxPerDay = evalCase.scenario.expectations?.maxSessionsPerDay
    ?? evalCase.persona.expectations.maxSessionsPerDay
    ?? evalCase.athlete.availability.maxSessionsPerDay;
  const grouped = sessionsByDay(sessions);
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];

  for (const [day, sessions] of Object.entries(grouped)) {
    if (sessions.length > maxPerDay) {
      value -= 18;
      penalties.push(`${day} has ${sessions.length} sessions, above max ${maxPerDay}.`);
    }
  }

  const sortedDayIndexes = sessions.map((session) => DAY_ORDER.indexOf(session.dayOfWeek)).sort((a, b) => a - b);
  const consecutiveKeyDays = sessions
    .filter((session) => session.keySession)
    .map((session) => DAY_ORDER.indexOf(session.dayOfWeek))
    .sort((a, b) => a - b)
    .some((day, index, days) => index > 0 && day - days[index - 1] === 1);
  if (consecutiveKeyDays && sessions.length >= 4) {
    value -= 10;
    penalties.push('Key sessions are placed on consecutive days.');
  }

  const span = sortedDayIndexes.length > 0 ? sortedDayIndexes[sortedDayIndexes.length - 1] - sortedDayIndexes[0] : 0;
  if (sessions.length >= 4 && span < 3) {
    value -= 12;
    penalties.push('Weekly sessions are compressed into too narrow a day span.');
  }
  observations.push(`Sessions by day: ${Object.entries(grouped).map(([day, sessions]) => `${day}:${sessions.length}`).join(', ') || 'none'}.`);
  return score('weekly_structure_quality', { score: value, observations, penalties });
}

function scoreRoleDifferentiation({ plan }: RubricContext): TrainingEvalDimensionScore {
  const sessions = activeSessions(plan);
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const sessionTypes = uniqueCount(sessions.map((session) => session.sessionType));
  const titles = uniqueCount(sessions.map((session) => session.title));
  if (sessions.length >= 4 && sessionTypes < 3) {
    value -= 22;
    penalties.push(`Only ${sessionTypes} session types across ${sessions.length} active sessions.`);
  }
  if (sessions.length >= 4 && titles < 3) {
    value -= 14;
    penalties.push(`Only ${titles} unique titles across ${sessions.length} active sessions.`);
  }
  const tagDiversity = uniqueCount(sessions.flatMap((session) => session.tags));
  if (sessions.length >= 4 && tagDiversity < 3) {
    value -= 10;
    penalties.push('Tags do not differentiate session roles enough.');
  }
  observations.push(`Unique session types: ${sessionTypes}; unique titles: ${titles}; tag families: ${tagDiversity}.`);
  return score('session_role_differentiation', { score: value, observations, penalties });
}

function scoreVariety({ plan }: RubricContext): TrainingEvalDimensionScore {
  const sessions = activeSessions(plan);
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const signatureCounts = new Map<string, number>();
  for (const session of sessions) {
    const exerciseSig = (session.exercises ?? []).map((exercise) => exercise.exerciseId).join('|');
    const signature = `${session.sport}:${session.sessionType}:${exerciseSig || session.title}`;
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }
  const duplicates = [...signatureCounts.entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    value -= duplicates.reduce((sum, [, count]) => sum + (count - 1) * 16, 0);
    penalties.push(`Repeated session signatures: ${duplicates.map(([signature, count]) => `${signature}×${count}`).join(', ')}.`);
  }
  observations.push(`${signatureCounts.size} unique session signatures.`);
  return score('variety_quality', { score: value, observations, penalties });
}

function scoreTimeVolumeCoherence({ plan, knowledge }: RubricContext): TrainingEvalDimensionScore {
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  for (const session of activeSessions(plan)) {
    const verdict = validateSessionCoherence(session, knowledge);
    if (!verdict.ok) {
      const correction = suggestCorrection(verdict, session);
      value -= correction.type === 'rebuild' ? 28 : 14;
      penalties.push(`${session.title}: claimed ${verdict.claimedMinutes}min, estimated ${verdict.estimatedMinutes}min, action ${correction.type}.`);
    } else if (session.sport === 'strength') {
      observations.push(`${session.title}: ${estimateStrengthSessionMinutes(session, knowledge)}min estimated vs ${session.durationMinutes}min claimed.`);
    }
  }
  return score('time_volume_coherence', { score: value, observations, penalties });
}

function scoreModalityQuality({ evalCase, plan }: RubricContext): TrainingEvalDimensionScore {
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const sessions = activeSessions(plan);
  const bySport = countBySport(sessions);
  if ((bySport.running ?? 0) >= 3) {
    const types = new Set(sessions.filter((session) => session.sport === 'running').map((session) => session.sessionType));
    if (!types.has('long_run')) {
      value -= 14;
      penalties.push('Running week has 3+ runs but no long run.');
    }
    if (![...types].some((type) => type.includes('threshold') || type.includes('interval'))) {
      value -= 10;
      penalties.push('Running week lacks a quality run.');
    }
  }
  if ((bySport.cycling ?? 0) >= 3) {
    const types = new Set(sessions.filter((session) => session.sport === 'cycling').map((session) => session.sessionType));
    if (!types.has('endurance_ride')) {
      value -= 12;
      penalties.push('Cycling week lacks endurance ride.');
    }
    if (![...types].some((type) => type.includes('threshold') || type.includes('tempo') || type.includes('vo2'))) {
      value -= 10;
      penalties.push('Cycling week lacks quality ride.');
    }
  }
  if ((bySport.strength ?? 0) > 0) {
    const sparseStrength = sessions.filter((session) => session.sport === 'strength' && (session.exercises ?? []).length < 3 && session.durationMinutes >= 35);
    if (sparseStrength.length > 0) {
      value -= sparseStrength.length * 20;
      penalties.push(`${sparseStrength.length} strength sessions are sparse for their claimed duration.`);
    }
  }
  observations.push(`Expected sports: ${evalCase.persona.expectations.expectedSports.join(', ')}.`);
  return score('modality_quality', { score: value, observations, penalties });
}

function scoreProgression({ evalCase, plan }: RubricContext): TrainingEvalDimensionScore {
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const totalBySport = countMinutesBySport(activeSessions(plan));
  for (const [sport, planned] of Object.entries(totalBySport) as Array<[Sport, number]>) {
    const previous = evalCase.athlete.trainingHistory.lastWeekMinutesBySport[sport];
    if (!previous || previous <= 0) continue;
    const growth = (planned - previous) / previous;
    if (growth > 0.25 && plan.phase !== 'peak') {
      value -= 16;
      penalties.push(`${sport} planned volume jumps ${Math.round(growth * 100)}% from last week.`);
    }
    if (growth < -0.35 && plan.phase !== 'deload' && plan.phase !== 'taper') {
      value -= 10;
      penalties.push(`${sport} planned volume drops ${Math.round(Math.abs(growth) * 100)}% without deload/taper context.`);
    }
  }
  if (evalCase.athlete.currentBlock.weekIndex > 0 && !plan.notes.some((note) => /phase|week|readiness|compliance/i.test(note))) {
    value -= 8;
    penalties.push('Plan notes do not expose progression context.');
  }
  observations.push(`Phase: ${plan.phase}.`);
  return score('progression_quality', { score: value, observations, penalties });
}

function countMinutesBySport(sessions: Session[]): Partial<Record<Sport, number>> {
  return sessions.reduce<Partial<Record<Sport, number>>>((acc, session) => {
    acc[session.sport] = (acc[session.sport] ?? 0) + session.durationMinutes;
    return acc;
  }, {});
}

function scoreAdaptability({ evalCase, plan }: RubricContext): TrainingEvalDimensionScore {
  const sessions = activeSessions(plan);
  const expectations = evalCase.scenario.expectations;
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  if (expectations?.requiredPhase && plan.phase !== expectations.requiredPhase) {
    value -= 25;
    penalties.push(`Expected phase ${expectations.requiredPhase}, got ${plan.phase}.`);
  }
  if (expectations?.shouldRespectShortWindows) {
    const misses = sessions.filter((session) => !sessionFitsWindow(evalCase.athlete, session));
    if (misses.length > 0) {
      value -= misses.length * 16;
      penalties.push(`${misses.length} sessions do not fit declared short windows.`);
    }
  }
  if (expectations?.shouldReduceLoad || evalCase.athlete.compliance.trailing14DayCompliance < 0.6) {
    const plannedMinutes = sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
    const priorMinutes = Object.values(evalCase.athlete.trainingHistory.lastWeekMinutesBySport).reduce((sum, minutes) => sum + (minutes ?? 0), 0);
    if (priorMinutes > 0 && plannedMinutes > priorMinutes * 1.15) {
      value -= 18;
      penalties.push(`Scenario calls for caution but planned minutes increased from ${priorMinutes} to ${plannedMinutes}.`);
    }
  }
  observations.push(`Readiness ${evalCase.athlete.readiness.level}/${evalCase.athlete.readiness.score}; compliance ${Math.round(evalCase.athlete.compliance.trailing14DayCompliance * 100)}%.`);
  return score('adaptability_quality', { score: value, observations, penalties });
}

function scoreSubstitution({ evalCase, plan, knowledge }: RubricContext): TrainingEvalDimensionScore {
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const avoid = evalCase.persona.expectations.requiredEquipmentAvoidance ?? (evalCase.scenario.expectations?.shouldUseHotelGym ? ['barbell', 'rack'] : []);
  for (const { session, exercise, meta } of allExercisePrescriptions(plan, knowledge)) {
    const equipment = meta?.equipment ?? [];
    const conflict = avoid.find((item) => equipment.includes(item));
    if (conflict) {
      value -= 14;
      penalties.push(`${session.title}: ${exercise.name} requires avoided equipment ${conflict}.`);
    }
    if (!meta) {
      value -= 3;
      penalties.push(`${exercise.exerciseId} is missing from exercise catalog.`);
    }
  }
  if (plan.sessions.some((session) => session.sport === 'strength')) {
    observations.push(`Checked ${knowledge.exercises.length} exercise catalog entries for equipment/substitution compatibility.`);
  }
  return score('substitution_quality', { score: value, observations, penalties });
}

function scoreBiomechanics({ evalCase, plan, knowledge }: RubricContext): TrainingEvalDimensionScore {
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const painAreas = [
    ...(evalCase.persona.expectations.shouldAvoidPainAreas ?? []),
    ...(evalCase.scenario.expectations?.shouldAvoidPainAreas ?? []),
    ...evalCase.athlete.readiness.painFlags.map((flag) => flag.area),
  ];
  for (const session of activeSessions(plan).filter((item) => item.sport === 'strength')) {
    const exercises = session.exercises ?? [];
    for (const prescription of exercises) {
      const meta = findExercise(prescription.exerciseId, knowledge);
      if (!meta) continue;
      if (exerciseConflictsWithUserPain(meta, painAreas)) {
        value -= 22;
        penalties.push(`${session.title}: ${prescription.name} conflicts with pain areas ${painAreas.join(', ')}.`);
      }
      if (evalCase.athlete.profile.experienceLevel === 'novice' && (getExerciseComplexity(meta) === 'advanced' || getExerciseComplexity(meta) === 'expert')) {
        value -= 14;
        penalties.push(`${session.title}: novice received ${getExerciseComplexity(meta)} exercise ${prescription.name}.`);
      }
    }
    const orderedRanks = exercises.map((prescription) => {
      const meta = findExercise(prescription.exerciseId, knowledge);
      if (!meta) return 99;
      if (getExerciseSpinalLoading(meta) === 'high') return 0;
      if (['squat', 'hinge', 'push', 'pull', 'single_leg'].includes(meta.movementPattern)) return 1;
      if (meta.movementPattern === 'carry') return 2;
      if (meta.movementPattern === 'core') return 3;
      return 4;
    });
    if (orderedRanks.some((rank, index) => index > 0 && rank < orderedRanks[index - 1])) {
      value -= 10;
      penalties.push(`${session.title}: exercise ordering is not compound-to-support.`);
    }
  }
  observations.push(`Pain areas considered: ${[...new Set(painAreas)].join(', ') || 'none'}.`);
  return score('biomechanics_quality', { score: value, observations, penalties });
}

function scoreAdherence({ evalCase, plan }: RubricContext): TrainingEvalDimensionScore {
  const sessions = activeSessions(plan);
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const compliance = evalCase.athlete.compliance.trailing14DayCompliance;
  if (compliance < 0.6) {
    const keySessions = sessions.filter((session) => session.keySession).length;
    if (keySessions > 2) {
      value -= 14;
      penalties.push(`Low-adherence user received ${keySessions} key sessions.`);
    }
    if (sessions.length > 5) {
      value -= 14;
      penalties.push(`Low-adherence user received ${sessions.length} active sessions.`);
    }
  }
  observations.push(`Trailing 14-day compliance: ${Math.round(compliance * 100)}%.`);
  return score('adherence_realism', { score: value, observations, penalties });
}

function scoreExplainability({ evalCase, plan }: RubricContext): TrainingEvalDimensionScore {
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const explanatoryText = [...plan.notes, ...plan.guardrailResults.map((guardrail) => guardrail.message)].filter((text) => text.trim().length > 0);
  if (explanatoryText.length < 3) {
    value -= 16;
    penalties.push('Plan has too few explanation or guardrail lines.');
  }
  if (evalCase.scenario.expectations?.shouldSurfaceProfileGap && !explanatoryText.some((line) => /profile|threshold|equipment|confidence|missing|follow/i.test(line))) {
    value -= 18;
    penalties.push('Weak-profile scenario did not surface a profile/completeness gap.');
  }
  observations.push(`${explanatoryText.length} explanation/guardrail lines available.`);
  return score('explainability', { score: value, observations, penalties });
}

function scoreAgendaLifecycle({ plan, nextVersionPlan }: RubricContext): TrainingEvalDimensionScore {
  const sessions = activeSessions(plan);
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const ids = sessions.map((session) => session.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    value -= 35;
    penalties.push(`Duplicate session ids would break idempotent agenda ownership: ${[...new Set(duplicateIds)].join(', ')}.`);
  }
  const missingTimes = sessions.filter((session) => !session.startTime || !session.endTime);
  if (missingTimes.length > 0) {
    value -= missingTimes.length * 8;
    penalties.push(`${missingTimes.length} sessions miss calendar start/end times.`);
  }
  if (nextVersionPlan) {
    const nextSessions = activeSessions(nextVersionPlan);
    const nextIds = new Set(nextSessions.map((session) => session.id));
    const sameIdDifferentShape = sessions.filter((session) => {
      const next = nextSessions.find((candidate) => candidate.id === session.id);
      return next && (next.sessionType !== session.sessionType || next.dayOfWeek !== session.dayOfWeek || next.durationMinutes !== session.durationMinutes);
    });
    if (sameIdDifferentShape.length > 0) {
      value -= 18;
      penalties.push(`${sameIdDifferentShape.length} regenerated sessions reused ids for changed session shapes.`);
    }
    observations.push(`Regeneration comparison: ${nextIds.size} next-version ids.`);
  }
  observations.push(`${ids.length} session ids, ${new Set(ids).size} unique.`);
  return score('agenda_lifecycle_correctness', { score: value, observations, penalties });
}

function scoreWarnings({ plan }: RubricContext): TrainingEvalDimensionScore {
  let value = 100;
  const observations: string[] = [];
  const penalties: string[] = [];
  const messages = [...plan.notes, ...plan.guardrailResults.map((guardrail) => guardrail.message)].map(normalizeText).filter(Boolean);
  const duplicates = messages.filter((message, index) => messages.indexOf(message) !== index);
  if (duplicates.length > 0) {
    value -= duplicates.length * 12;
    penalties.push(`Duplicate warning/explanation text: ${[...new Set(duplicates)].join(' | ')}.`);
  }
  const genericWarnings = messages.filter((message) => message === 'readiness supports the planned week.' || message === 'phase: base');
  if (genericWarnings.length > 2) {
    value -= 8;
    penalties.push('Warnings are too generic/repetitive.');
  }
  observations.push(`${messages.length} warning/explanation strings, ${new Set(messages).size} unique.`);
  return score('warning_quality_deduplication', { score: value, observations, penalties });
}

export function evaluatePlanAgainstRubric(
  evalCase: TrainingEvalCase,
  plan: WeeklyPlan,
  nextVersionPlan?: WeeklyPlan,
): TrainingEvalDimensionScore[] {
  const knowledge = loadCoachKnowledge();
  const context: RubricContext = { evalCase, plan, nextVersionPlan, knowledge };
  return [
    scoreProfileFit(context),
    scorePlanCoherence(context),
    scoreWeeklyStructure(context),
    scoreRoleDifferentiation(context),
    scoreVariety(context),
    scoreTimeVolumeCoherence(context),
    scoreModalityQuality(context),
    scoreProgression(context),
    scoreAdaptability(context),
    scoreSubstitution(context),
    scoreBiomechanics(context),
    scoreAdherence(context),
    scoreExplainability(context),
    scoreAgendaLifecycle(context),
    scoreWarnings(context),
  ];
}

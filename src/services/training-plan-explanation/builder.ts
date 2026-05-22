// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DecisionWhy } from '../decision-center-logic-v2';
import { DECISION_CONFIDENCE_RUBRIC } from '../decision-center-logic-v2';
import type {
  EquipmentAccessResolution,
  EnduranceMinutesResolution,
  ExperienceLevelResolution,
  PrimaryFocusResolution,
  StrengthGoalResolution,
  TrainingGoalMode,
} from '../training-coach-kernel-plan-generator';
import type {
  BlockPhase,
  Goals,
  RaceEvent,
  ReadinessSnapshot,
  Sport,
  TrainingDecisionReason,
} from '../coach-kernel/types';
import type {
  PlanCreationExplanation,
  PlanExplanationAttentionItem,
  PlanExplanationCategory,
  PlanExplanationEvidence,
  PlanExplanationRespectedConstraint,
  PlanExplanationSeverity,
  PlanExplanationSmartPick,
} from './types';
import { PLAN_CREATION_EXPLANATION_SCHEMA_VERSION } from './types';

export interface TrainingPlanExplanationRequest {
  objective: string;
  startPolicy?: 'next_full_week' | 'today' | null;
  sessionsPerWeek: number;
  runSessionsPerWeek?: number | null;
  bikeSessionsPerWeek?: number | null;
  swimSessionsPerWeek?: number | null;
  strengthSessionsPerWeek: number;
  preferredCardioTime?: string | null;
  preferredStrengthTime?: string | null;
  longWorkoutDay?: string | null;
  twoADayPreference?: 'never' | 'optional' | 'preferred' | null;
  goalMode?: TrainingGoalMode | null;
}

export interface TrainingPlanExplanationTrace {
  primaryFocus: PrimaryFocusResolution;
  rawWeeklyTargets: Goals['weeklySessionsTarget'];
  shapedWeeklyTargets: Goals['weeklySessionsTarget'];
  equipment: EquipmentAccessResolution;
  runningHistory: EnduranceMinutesResolution;
  cyclingHistory: EnduranceMinutesResolution;
  strengthGoal: StrengthGoalResolution;
  experienceLevel: ExperienceLevelResolution;
  readiness: ReadinessSnapshot;
  raceCalendar: RaceEvent[];
  firstWeekPhase?: BlockPhase | string | null;
  maxSessionsPerDay: number;
  decisionReasons: TrainingDecisionReason[];
}

export interface BuildPlanCreationExplanationInput {
  request: TrainingPlanExplanationRequest;
  trace: TrainingPlanExplanationTrace;
  generatedAt?: Date;
  locale?: string;
}

const COACH_RULES = {
  periodization: 'endurance-periodization-by-goal-horizon',
  loadMonitoring: 'load-monitoring-multiple-signals',
  strength: 'strength-progressive-overload-with-deloads',
  communication: 'coach-communication-no-raw-dumps',
};

export function buildPlanCreationExplanation(
  input: BuildPlanCreationExplanationInput,
): PlanCreationExplanation {
  const smartPicks: PlanExplanationSmartPick[] = [];
  const respectedConstraints: PlanExplanationRespectedConstraint[] = [];
  const attentionItems: PlanExplanationAttentionItem[] = [];
  const generatedAt = input.generatedAt ?? new Date();

  addPrimaryFocusPick(smartPicks, attentionItems, input);
  addPeriodizationPick(smartPicks, input);
  addWeeklyVolumePick(smartPicks, input);
  addHistoryAndReadinessPicks(smartPicks, attentionItems, input);
  addProfilePicks(smartPicks, attentionItems, input);
  addGoalModePick(smartPicks, input);
  addTwoADayPick(smartPicks, input);
  addRespectedConstraints(respectedConstraints, input.request);

  return {
    schemaVersion: PLAN_CREATION_EXPLANATION_SCHEMA_VERSION,
    planId: null,
    generatedAt: generatedAt.toISOString(),
    locale: input.locale ?? 'en',
    summary: {
      smartPickCount: smartPicks.length,
      respectedConstraintCount: respectedConstraints.length,
      attentionItemCount: attentionItems.length,
      highestSeverity: highestSeverity(attentionItems),
    },
    smartPicks,
    respectedConstraints,
    attentionItems,
  };
}

export function withPlanCreationExplanationPlanId(
  explanation: PlanCreationExplanation | null | undefined,
  planId: number,
): PlanCreationExplanation | null {
  if (!explanation) return null;
  return { ...explanation, planId };
}

export function parsePlanCreationExplanationJson(value: unknown): PlanCreationExplanation | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schemaVersion !== PLAN_CREATION_EXPLANATION_SCHEMA_VERSION) return null;
    return parsed as PlanCreationExplanation;
  } catch {
    return null;
  }
}

function addPrimaryFocusPick(
  smartPicks: PlanExplanationSmartPick[],
  attentionItems: PlanExplanationAttentionItem[],
  input: BuildPlanCreationExplanationInput,
): void {
  const { primaryFocus } = input.trace;
  if (primaryFocus.source === 'objective_keyword') {
    smartPicks.push(smartPick({
      id: 'primary_focus_from_objective',
      category: 'primary_focus',
      labelKey: 'training.explanation.smartPick.primaryFocus',
      fallbackLabel: `Primary focus: ${primaryFocus.value}`,
      value: primaryFocus.value,
      source: 'objective_keyword',
      confidence: DECISION_CONFIDENCE_RUBRIC.highStructuredState,
      facts: [`Objective matched "${primaryFocus.matchedKeyword}".`],
      rules: ['Plan structure follows the detected primary sport.'],
      evidence: [{
        summary: `Matched objective keyword "${primaryFocus.matchedKeyword}"`,
        matchedKeyword: primaryFocus.matchedKeyword,
        rawInputSnippet: input.request.objective,
        sourceField: 'objective',
      }],
      coachRuleIds: [COACH_RULES.periodization],
    }));
    return;
  }

  if (primaryFocus.source === 'inferred_volume_split') {
    smartPicks.push(smartPick({
      id: 'primary_focus_from_volume_split',
      category: 'primary_focus',
      labelKey: 'training.explanation.smartPick.hybridFocus',
      fallbackLabel: 'Hybrid focus from your run + strength split',
      value: primaryFocus.value,
      source: 'inferred_volume_split',
      confidence: DECISION_CONFIDENCE_RUBRIC.mediumTrainingReview,
      facts: [
        `${input.request.sessionsPerWeek} total sessions with ${input.request.strengthSessionsPerWeek} strength sessions.`,
      ],
      rules: ['When endurance and strength are both explicit, the plan protects both instead of treating one as accessory work.'],
      tradeoffs: ['Hybrid planning may create two-a-day sessions when weekly volume is high.'],
      evidence: [{
        summary: 'Explicit endurance + strength volume split',
        sourceField: 'sessionsPerWeek/strengthSessionsPerWeek',
      }],
      coachRuleIds: [COACH_RULES.loadMonitoring],
    }));
    return;
  }

  attentionItems.push(attentionItem({
    id: 'primary_focus_fallback',
    category: 'primary_focus',
    severity: primaryFocus.reason === 'missing' ? 'warning' : 'notice',
    labelKey: 'training.explanation.attention.primaryFocusFallback',
    fallbackLabel: primaryFocus.reason === 'missing'
      ? 'Nexus could not read a clear training goal.'
      : 'Nexus used a hybrid plan because the goal wording was not recognized.',
    facts: primaryFocus.reason === 'missing'
      ? ['Objective was empty or missing.']
      : ['Objective did not match a known Training focus keyword.'],
    uncertainty: ['A clearer race, sport, or strength goal would make this recommendation more specific.'],
    evidence: [{
      summary: primaryFocus.reason,
      rawInputSnippet: primaryFocus.rawInput ?? input.request.objective,
      sourceField: 'objective',
    }],
    coachRuleIds: [COACH_RULES.communication],
  }));
}

function addPeriodizationPick(
  smartPicks: PlanExplanationSmartPick[],
  input: BuildPlanCreationExplanationInput,
): void {
  const phase = input.trace.firstWeekPhase ? String(input.trace.firstWeekPhase) : null;
  if (!phase) return;
  const source = input.trace.raceCalendar.length > 0 ? 'race_calendar' : 'system_inference';
  smartPicks.push(smartPick({
    id: 'first_week_phase',
    category: 'periodization_phase',
    labelKey: 'training.explanation.smartPick.periodizationPhase',
    fallbackLabel: `Starts in ${phase} phase`,
    value: phase,
    source,
    confidence: source === 'race_calendar'
      ? DECISION_CONFIDENCE_RUBRIC.highStructuredState
      : DECISION_CONFIDENCE_RUBRIC.mediumTrainingReview,
    facts: source === 'race_calendar'
      ? [`Race calendar includes ${input.trace.raceCalendar[0]?.date}.`]
      : ['No immediate race taper was required for week 1.'],
    rules: ['Training phases are chosen from race timing, goal mode, and block progression.'],
    evidence: [{
      summary: source === 'race_calendar' ? 'Race-calendar phase resolver' : 'Default block progression',
      sourceField: source === 'race_calendar' ? 'raceDate' : 'durationWeeks/startDate',
      rawInputSnippet: input.trace.raceCalendar[0]?.date ?? null,
    }],
    coachRuleIds: [COACH_RULES.periodization],
  }));
}

function addWeeklyVolumePick(
  smartPicks: PlanExplanationSmartPick[],
  input: BuildPlanCreationExplanationInput,
): void {
  const shaped = input.trace.shapedWeeklyTargets;
  const total = sumTargets(shaped);
  if (total <= 0) return;
  const capped = sumTargets(input.trace.rawWeeklyTargets) !== total;
  const inferredRunTarget = input.request.runSessionsPerWeek == null && (shaped.running ?? 0) > 0;
  const inferredBikeTarget = input.request.bikeSessionsPerWeek == null && (shaped.cycling ?? 0) > 0;
  const inferredSwimTarget = input.request.swimSessionsPerWeek == null && (shaped.swimming ?? 0) > 0;
  if (!capped && !inferredRunTarget && !inferredBikeTarget && !inferredSwimTarget) return;

  smartPicks.push(smartPick({
    id: capped ? 'goal_mode_volume_cap' : 'weekly_volume_inference',
    category: capped ? 'goal_mode_volume_cap' : 'weekly_volume',
    labelKey: capped
      ? 'training.explanation.smartPick.goalModeVolumeCap'
      : 'training.explanation.smartPick.weeklyVolume',
    fallbackLabel: capped
      ? `${input.request.goalMode} capped weekly volume to ${total} sessions`
      : `${total} weekly sessions balanced across modalities`,
    value: total,
    source: capped ? 'goal_mode_rule' : 'system_inference',
    confidence: capped
      ? DECISION_CONFIDENCE_RUBRIC.highStructuredState
      : DECISION_CONFIDENCE_RUBRIC.mediumTrainingReview,
    facts: [`Weekly target: ${targetSummary(shaped)}.`],
    rules: capped
      ? ['Maintenance and return-to-training modes intentionally reduce total load.']
      : ['Unspecified modality counts are inferred from the selected sport focus and total frequency.'],
    tradeoffs: capped ? ['Lower load protects consistency over maximal volume.'] : [],
    evidence: [{
      summary: capped
        ? `Raw ${sumTargets(input.trace.rawWeeklyTargets)} -> shaped ${total}`
        : targetSummary(shaped),
      sourceField: 'weeklyTargets',
    }],
    coachRuleIds: [COACH_RULES.loadMonitoring],
  }));
}

function addHistoryAndReadinessPicks(
  smartPicks: PlanExplanationSmartPick[],
  attentionItems: PlanExplanationAttentionItem[],
  input: BuildPlanCreationExplanationInput,
): void {
  const running = input.trace.runningHistory;
  const cycling = input.trace.cyclingHistory;
  if (running.source === 'profile_data' || cycling.source === 'profile_data') {
    smartPicks.push(smartPick({
      id: 'training_history_profile_data',
      category: 'training_history',
      labelKey: 'training.explanation.smartPick.trainingHistory',
      fallbackLabel: 'Recent training history informed the load ramp',
      value: 'profile_data',
      source: 'training_history',
      confidence: DECISION_CONFIDENCE_RUBRIC.highEntityReadBack,
      facts: [
        running.source === 'profile_data'
          ? `Running history: ${running.value} min/week.`
          : `Cycling history: ${cycling.value} min/week.`,
      ],
      rules: ['Recent volume anchors progression so week 1 is not an arbitrary jump.'],
      evidence: [{
        summary: running.source === 'profile_data'
          ? `${running.value} running min/week`
          : `${cycling.value} cycling min/week`,
        sourceField: running.source === 'profile_data' ? 'runProfile.weekly_mileage_km' : 'cyclingProfile.weekly_minutes',
      }],
      coachRuleIds: [COACH_RULES.loadMonitoring],
    }));
  }

  const readiness = input.trace.readiness;
  if (readiness.confidence && readiness.confidence !== 'no_data') {
    smartPicks.push(smartPick({
      id: 'readiness_baseline',
      category: 'readiness_baseline',
      labelKey: 'training.explanation.smartPick.readinessBaseline',
      fallbackLabel: `Readiness baseline: ${readiness.level}`,
      value: readiness.level,
      source: 'readiness_data',
      confidence: readiness.confidence === 'fresh_wearable'
        ? DECISION_CONFIDENCE_RUBRIC.highEntityReadBack
        : DECISION_CONFIDENCE_RUBRIC.mediumTrainingReview,
      facts: [`Readiness score ${readiness.score ?? 'unknown'} (${readiness.confidence}).`],
      rules: ['Readiness can adjust load when fatigue, HRV, or pain signals are present.'],
      uncertainty: readiness.isStale ? ['Readiness data is stale; load changes are conservative.'] : [],
      evidence: [{
        summary: `Readiness ${readiness.level}`,
        sourceField: readiness.dataSource ?? 'readiness',
      }],
      coachRuleIds: [COACH_RULES.loadMonitoring],
    }));
    if (readiness.isStale) {
      attentionItems.push(attentionItem({
        id: 'readiness_stale',
        category: 'readiness_baseline',
        severity: 'notice',
        labelKey: 'training.explanation.attention.readinessStale',
        fallbackLabel: 'Readiness data looks stale, so load choices were conservative.',
        facts: [`Readiness source: ${readiness.dataSource ?? 'unknown'}.`],
        uncertainty: ['A fresh wearable sync can improve day-to-day adjustments.'],
        evidence: [{ summary: 'stale_readiness', sourceField: readiness.dataSource ?? 'readiness' }],
        coachRuleIds: [COACH_RULES.loadMonitoring],
      }));
    }
    return;
  }

  attentionItems.push(attentionItem({
    id: 'readiness_missing',
    category: 'readiness_baseline',
    severity: 'notice',
    labelKey: 'training.explanation.attention.readinessMissing',
    fallbackLabel: 'No fresh readiness data was available.',
    facts: ['The plan used a neutral readiness baseline.'],
    uncertainty: ['Wearable data would make fatigue-sensitive adjustments more precise.'],
    evidence: [{ summary: 'no_readiness_data', sourceField: 'readiness' }],
    coachRuleIds: [COACH_RULES.loadMonitoring],
  }));
}

function addProfilePicks(
  smartPicks: PlanExplanationSmartPick[],
  attentionItems: PlanExplanationAttentionItem[],
  input: BuildPlanCreationExplanationInput,
): void {
  const { equipment, experienceLevel, strengthGoal } = input.trace;
  if (equipment.source !== 'fallback') {
    smartPicks.push(smartPick({
      id: 'equipment_profile',
      category: 'equipment_profile',
      labelKey: 'training.explanation.smartPick.equipmentProfile',
      fallbackLabel: equipment.value.hasGym ? 'Gym equipment was used in session design' : 'Equipment constraints shaped session design',
      value: equipment.value.hasGym ? 'gym' : 'limited_equipment',
      source: 'equipment_profile',
      confidence: DECISION_CONFIDENCE_RUBRIC.highEntityReadBack,
      facts: [equipment.value.hasGym ? 'Gym access is present.' : 'Limited equipment profile is present.'],
      rules: ['Exercise selection must match equipment access.'],
      evidence: [{ summary: equipment.matchedKeywords?.join(', ') || 'profile equipment', sourceField: 'fitnessProfile/gymProfile' }],
      coachRuleIds: [COACH_RULES.strength],
    }));
  } else {
    attentionItems.push(attentionItem({
      id: 'equipment_fallback',
      category: 'equipment_profile',
      severity: 'notice',
      labelKey: 'training.explanation.attention.equipmentFallback',
      fallbackLabel: 'Equipment access was unclear.',
      facts: ['Nexus used a conservative equipment profile.'],
      uncertainty: ['Adding gym/equipment details improves strength session specificity.'],
      evidence: [{ summary: equipment.reason, rawInputSnippet: equipment.rawInput ?? null, sourceField: 'fitnessProfile/gymProfile' }],
      coachRuleIds: [COACH_RULES.strength],
    }));
  }

  if (experienceLevel.source !== 'fallback') {
    smartPicks.push(smartPick({
      id: 'experience_level',
      category: 'experience_level',
      labelKey: 'training.explanation.smartPick.experienceLevel',
      fallbackLabel: `Experience level: ${experienceLevel.value}`,
      value: experienceLevel.value,
      source: 'experience_profile',
      confidence: DECISION_CONFIDENCE_RUBRIC.highEntityReadBack,
      facts: [`Matched experience signal "${experienceLevel.matchedKeyword}".`],
      rules: ['Exercise complexity and progression speed should fit training age.'],
      evidence: [{ summary: experienceLevel.matchedKeyword ?? experienceLevel.value, sourceField: 'fitnessProfile/gymProfile' }],
      coachRuleIds: [COACH_RULES.strength],
    }));
  }

  if (strengthGoal.source !== 'fallback') {
    smartPicks.push(smartPick({
      id: 'strength_goal',
      category: 'strength_goal',
      labelKey: 'training.explanation.smartPick.strengthGoal',
      fallbackLabel: `Strength goal: ${strengthGoal.value}`,
      value: strengthGoal.value,
      source: 'strength_profile',
      confidence: DECISION_CONFIDENCE_RUBRIC.mediumTrainingReview,
      facts: [`Matched strength goal "${strengthGoal.matchedKeyword}".`],
      rules: ['Strength sessions use different templates for hypertrophy, max strength, athletic support, and maintenance.'],
      evidence: [{ summary: strengthGoal.matchedKeyword ?? strengthGoal.value, sourceField: 'fitnessProfile/gymProfile/objective' }],
      coachRuleIds: [COACH_RULES.strength],
    }));
  }
}

function addGoalModePick(
  smartPicks: PlanExplanationSmartPick[],
  input: BuildPlanCreationExplanationInput,
): void {
  const reason = input.trace.decisionReasons.find((candidate) =>
    candidate.code === 'maintenance_volume_capped'
    || candidate.code === 'return_to_training_volume_capped'
    || candidate.code === 'continuous_plan_no_taper'
    || candidate.code === 'event_based_missing_race_date'
  );
  if (!reason) return;
  smartPicks.push(smartPick({
    id: `goal_mode_${reason.code}`,
    category: 'goal_mode_volume_cap',
    labelKey: `training.explanation.smartPick.${reason.code}`,
    fallbackLabel: reason.text,
    value: reason.code,
    source: 'goal_mode_rule',
    confidence: DECISION_CONFIDENCE_RUBRIC.highStructuredState,
    facts: reason.evidence?.length ? reason.evidence : [reason.text],
    rules: ['Goal mode changes the plan shape instead of being a cosmetic label.'],
    evidence: [{ summary: reason.text, sourceField: 'goalMode' }],
    coachRuleIds: [COACH_RULES.loadMonitoring],
  }));
}

function addTwoADayPick(
  smartPicks: PlanExplanationSmartPick[],
  input: BuildPlanCreationExplanationInput,
): void {
  if (input.trace.maxSessionsPerDay <= 1) return;
  smartPicks.push(smartPick({
    id: 'two_a_day_policy',
    category: 'two_a_day_policy',
    labelKey: 'training.explanation.smartPick.twoADayPolicy',
    fallbackLabel: 'Two-a-day sessions are allowed when needed',
    value: input.trace.maxSessionsPerDay,
    source: input.request.twoADayPreference === 'preferred' ? 'two_a_day_preference' : 'system_inference',
    confidence: input.request.twoADayPreference === 'preferred'
      ? DECISION_CONFIDENCE_RUBRIC.highStructuredState
      : DECISION_CONFIDENCE_RUBRIC.mediumTrainingReview,
    facts: [`Max sessions per day: ${input.trace.maxSessionsPerDay}.`],
    rules: ['High weekly volume may require two sessions on the same day to preserve recovery spacing.'],
    tradeoffs: ['Two-a-days increase logistics load; review the calendar before committing.'],
    evidence: [{ summary: input.request.twoADayPreference ?? 'volume_based', sourceField: 'twoADayPreference' }],
    coachRuleIds: [COACH_RULES.loadMonitoring],
  }));
}

function addRespectedConstraints(
  respectedConstraints: PlanExplanationRespectedConstraint[],
  request: TrainingPlanExplanationRequest,
): void {
  respectedConstraints.push(respectedConstraint({
    id: 'weekly_frequency',
    category: 'weekly_frequency',
    labelKey: 'training.explanation.constraint.weeklyFrequency',
    fallbackLabel: `${request.sessionsPerWeek} total sessions per week requested`,
    value: request.sessionsPerWeek,
    facts: [`User requested ${request.sessionsPerWeek} sessions/week.`],
  }));
  respectedConstraints.push(respectedConstraint({
    id: 'strength_sessions',
    category: 'modality_target',
    labelKey: 'training.explanation.constraint.strengthSessions',
    fallbackLabel: `${request.strengthSessionsPerWeek} strength sessions/week requested`,
    value: request.strengthSessionsPerWeek,
    facts: [`Strength target: ${request.strengthSessionsPerWeek}/week.`],
  }));
  if (request.runSessionsPerWeek != null) {
    respectedConstraints.push(respectedConstraint({
      id: 'run_sessions',
      category: 'modality_target',
      labelKey: 'training.explanation.constraint.runSessions',
      fallbackLabel: `${request.runSessionsPerWeek} run sessions/week requested`,
      value: request.runSessionsPerWeek,
      facts: [`Run target: ${request.runSessionsPerWeek}/week.`],
    }));
  }
  if (request.longWorkoutDay) {
    respectedConstraints.push(respectedConstraint({
      id: 'long_session_day',
      category: 'long_session_day',
      labelKey: 'training.explanation.constraint.longSessionDay',
      fallbackLabel: `Long session day: ${request.longWorkoutDay}`,
      value: request.longWorkoutDay,
      facts: [`Long session day requested: ${request.longWorkoutDay}.`],
    }));
  }
  if (request.preferredCardioTime) {
    respectedConstraints.push(respectedConstraint({
      id: 'preferred_cardio_time',
      category: 'schedule_preference',
      labelKey: 'training.explanation.constraint.preferredCardioTime',
      fallbackLabel: `Cardio preference: ${request.preferredCardioTime}`,
      value: request.preferredCardioTime,
      facts: [`Cardio sessions prefer ${request.preferredCardioTime}.`],
    }));
  }
  if (request.preferredStrengthTime) {
    respectedConstraints.push(respectedConstraint({
      id: 'preferred_strength_time',
      category: 'schedule_preference',
      labelKey: 'training.explanation.constraint.preferredStrengthTime',
      fallbackLabel: `Strength preference: ${request.preferredStrengthTime}`,
      value: request.preferredStrengthTime,
      facts: [`Strength sessions prefer ${request.preferredStrengthTime}.`],
    }));
  }
  respectedConstraints.push(respectedConstraint({
    id: 'start_policy',
    category: 'start_policy',
    labelKey: 'training.explanation.constraint.startPolicy',
    fallbackLabel: request.startPolicy === 'today' ? 'Start today' : 'Start next full training week',
    value: request.startPolicy ?? 'next_full_week',
    facts: [`Start policy: ${request.startPolicy ?? 'next_full_week'}.`],
  }));
}

function smartPick(input: {
  id: string;
  category: PlanExplanationCategory;
  labelKey: string;
  fallbackLabel: string;
  value: string | number | boolean | null;
  source: PlanExplanationSmartPick['source'];
  confidence: number;
  facts?: string[];
  preferences?: string[];
  rules?: string[];
  tradeoffs?: string[];
  uncertainty?: string[];
  evidence?: PlanExplanationEvidence[];
  coachRuleIds?: string[];
}): PlanExplanationSmartPick {
  return {
    id: input.id,
    category: input.category,
    labelKey: input.labelKey,
    fallbackLabel: sanitizeText(input.fallbackLabel, 120),
    value: input.value,
    source: input.source,
    confidence: clampConfidence(input.confidence),
    why: why(input),
    evidence: (input.evidence ?? []).map(sanitizeEvidence),
    coachRuleIds: input.coachRuleIds ?? [],
  };
}

function respectedConstraint(input: {
  id: string;
  category: PlanExplanationCategory;
  labelKey: string;
  fallbackLabel: string;
  value: string | number | boolean | null;
  facts?: string[];
}): PlanExplanationRespectedConstraint {
  return {
    id: input.id,
    category: input.category,
    labelKey: input.labelKey,
    fallbackLabel: sanitizeText(input.fallbackLabel, 120),
    value: input.value,
    source: 'request',
    why: why({
      facts: input.facts ?? [],
      preferences: ['This came directly from the plan request.'],
      rules: [],
      tradeoffs: [],
      uncertainty: [],
    }),
  };
}

function attentionItem(input: {
  id: string;
  category: PlanExplanationCategory;
  severity: PlanExplanationSeverity;
  labelKey: string;
  fallbackLabel: string;
  facts?: string[];
  rules?: string[];
  tradeoffs?: string[];
  uncertainty?: string[];
  evidence?: PlanExplanationEvidence[];
  coachRuleIds?: string[];
}): PlanExplanationAttentionItem {
  return {
    id: input.id,
    category: input.category,
    severity: input.severity,
    labelKey: input.labelKey,
    fallbackLabel: sanitizeText(input.fallbackLabel, 120),
    why: why(input),
    evidence: (input.evidence ?? []).map(sanitizeEvidence),
    coachRuleIds: input.coachRuleIds ?? [],
  };
}

function why(input: {
  facts?: string[];
  preferences?: string[];
  rules?: string[];
  tradeoffs?: string[];
  uncertainty?: string[];
}): DecisionWhy {
  return {
    facts: sanitizeList(input.facts),
    preferences: sanitizeList(input.preferences),
    rules: sanitizeList(input.rules),
    tradeoffs: sanitizeList(input.tradeoffs),
    uncertainty: sanitizeList(input.uncertainty),
  };
}

function sanitizeEvidence(input: PlanExplanationEvidence): PlanExplanationEvidence {
  return {
    summary: sanitizeText(input.summary, 120),
    matchedKeyword: sanitizeOptional(input.matchedKeyword, 64),
    rawInputSnippet: sanitizeOptional(input.rawInputSnippet, 120),
    sourceField: sanitizeOptional(input.sourceField, 72),
    coachRuleIds: Array.isArray(input.coachRuleIds)
      ? input.coachRuleIds.map((id) => sanitizeText(id, 80)).filter(Boolean)
      : undefined,
  };
}

function sanitizeList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => sanitizeText(value, 160)).filter(Boolean).slice(0, 4);
}

function sanitizeOptional(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = sanitizeText(value, maxLength);
  return sanitized || null;
}

function sanitizeText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return DECISION_CONFIDENCE_RUBRIC.mediumGenericDecision;
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function sumTargets(targets: Goals['weeklySessionsTarget']): number {
  return Object.values(targets ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function targetSummary(targets: Goals['weeklySessionsTarget']): string {
  const parts = (['running', 'cycling', 'swimming', 'strength'] as Sport[])
    .map((sport) => [sport, targets?.[sport] ?? 0] as const)
    .filter(([, value]) => value > 0)
    .map(([sport, value]) => `${sport}:${value}`);
  return parts.length ? parts.join(', ') : 'no active modality targets';
}

function highestSeverity(items: PlanExplanationAttentionItem[]): PlanExplanationSeverity {
  const order: Record<PlanExplanationSeverity, number> = {
    info: 0,
    notice: 1,
    warning: 2,
    block: 3,
  };
  let highest: PlanExplanationSeverity = 'info';
  for (const item of items) {
    if (order[item.severity] > order[highest]) highest = item.severity;
  }
  return highest;
}

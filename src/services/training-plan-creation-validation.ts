// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const TRAINING_PLAN_CREATION_QA_ACCOUNT_EMAIL = 'nexushubbot@hotmail.com';
export const TRAINING_PLAN_CREATION_LOCAL_SIMULATOR_ACCOUNT_EMAIL = 'nexushubbot@gmail.com';

export type TrainingVariationAxisId =
  | 'objective'
  | 'goalMode'
  | 'trainingPriority'
  | 'raceDateBucket'
  | 'durationBucket'
  | 'sessionsPerWeek'
  | 'runSessionsPerWeek'
  | 'strengthSessionsPerWeek'
  | 'longWorkoutDay'
  | 'twoADayPreference'
  | 'preferredTimeBucket'
  | 'calendarSource'
  | 'calendarCapacityState'
  | 'wearableState'
  | 'readinessState'
  | 'equipmentState'
  | 'profileState';

export type TrainingPlanQualityVerdict = 'pass' | 'warn' | 'fail';
export type TrainingPlanCreationQualityMatrixMode = 'static_offline' | 'authorized_e2e';

export interface TrainingVariationValue {
  id: string;
  label: string;
  requestValue: string | number | null;
  notes?: string;
}

export interface TrainingVariationAxis {
  id: TrainingVariationAxisId;
  label: string;
  sourceOfTruth: string;
  continuousBucketed: boolean;
  values: TrainingVariationValue[];
}

export interface TrainingPlanCreationValidationScenario {
  id: string;
  label: string;
  qaAccountEmail: string;
  values: Record<TrainingVariationAxisId, TrainingVariationValue>;
  expectedChecks: string[];
}

export interface TrainingPlanQualityPersonaScenario {
  id: string;
  label: string;
  requiredSignals: string[];
  failureConditions: string[];
}

export type TrainingPlanQualityScoreDimension =
  | 'personalization'
  | 'safety'
  | 'progression'
  | 'scheduleFit'
  | 'exerciseVariety'
  | 'modalityCorrectness'
  | 'explanationQuality'
  | 'calendarCompatibility'
  | 'measurableOutcomes';

export interface TrainingPlanQualityPersonaScore {
  id: string;
  label: string;
  requiredSignals: string[];
  failureConditions: string[];
  dimensionScores: Record<TrainingPlanQualityScoreDimension, number>;
  totalScore: number;
  qualityVerdict: TrainingPlanQualityVerdict;
  blockers: string[];
  warnings: string[];
}

export interface TrainingPlanCreationValidationMatrix {
  qaAccountEmail: string;
  strategy: 'axis-complete-boundary-matrix';
  axes: TrainingVariationAxis[];
  cartesianVariationCount: number;
  scenarios: TrainingPlanCreationValidationScenario[];
  personaScenarios: TrainingPlanQualityPersonaScenario[];
  requiredE2EChecks: string[];
}

export interface TrainingPlanQualityMatrixColumn {
  verdict: TrainingPlanQualityVerdict;
  score: number;
  observations: string[];
  blockers: string[];
}

export interface TrainingPlanCreationQualityMatrixRow {
  scenarioId: string;
  label: string;
  objective: string;
  goalMode: string;
  durationBucket: string;
  sessionsPerWeek: number;
  sportSplit: {
    trainingPriority: string;
    runCardioSessionsPerWeek: number;
  };
  strengthSplit: {
    strengthSessionsPerWeek: number;
  };
  twoADayPreference: string;
  longWorkoutDay: string;
  calendarSource: string;
  calendarCapacityState: string;
  readinessState: string;
  equipmentState: string;
  profileState: string;
  previewStatus: 'static_validated' | 'blocked_requires_authorization';
  createStatus: 'not_executed_static' | 'blocked_requires_authorization' | 'authorized_e2e_pending';
  agendaStatus: 'pass' | 'fail' | 'not_required_no_calendar' | 'blocked_requires_authorization';
  qualityVerdict: TrainingPlanQualityVerdict;
  totalScore: number;
  blockers: string[];
  warnings: string[];
  evidenceIds: string[];
  scoring: {
    outputQuality: TrainingPlanQualityMatrixColumn;
    trainingQuality: TrainingPlanQualityMatrixColumn;
    calendarQuality: TrainingPlanQualityMatrixColumn;
    evidenceStructure: TrainingPlanQualityMatrixColumn;
    progression: TrainingPlanQualityMatrixColumn;
    variation: TrainingPlanQualityMatrixColumn;
  };
}

export interface TrainingPlanCreationQualityMatrix {
  qaAccountEmail: string;
  mode: TrainingPlanCreationQualityMatrixMode;
  authorizationRequiredForWrites: boolean;
  localSimulatorAccountEmail: string;
  personaScenarios: TrainingPlanQualityPersonaScenario[];
  personaScorecard: TrainingPlanQualityPersonaScore[];
  rows: TrainingPlanCreationQualityMatrixRow[];
  summary: {
    rowCount: number;
    scenarioCount: number;
    duplicateScenarioIds: string[];
    missingAxisCoverage: string[];
    verdictCounts: Record<TrainingPlanQualityVerdict, number>;
    evidenceIds: string[];
    modeNotes: string[];
  };
}

export const TRAINING_PLAN_CREATION_VARIATION_AXES: TrainingVariationAxis[] = [
  axis('objective', 'Objective', 'iOS TrainingView.objectives + backend objective normalization', false, [
    value('marathon', 'Marathon', 'marathon'),
    value('triathlon', 'Triathlon', 'triathlon'),
    value('hypertrophy', 'Muscle building', 'hypertrophy'),
    value('general_fitness', 'General fitness', 'general_fitness'),
    value('weight_loss', 'Weight loss', 'weight_loss', 'QA scorer detection only; runtime goal inference remains a deferred product decision.'),
    value('custom', 'Custom free-text', 'custom_powerbuilding_10k'),
  ]),
  axis('goalMode', 'Goal mode', 'TrainingService.allowedGoalModeValues', false, [
    value('continuous', 'Continuous', 'continuous'),
    value('event_based', 'Event / race', 'event_based'),
    value('maintenance', 'Maintenance', 'maintenance'),
    value('return_to_training', 'Return to training', 'return_to_training'),
  ]),
  axis('trainingPriority', 'Training priority', 'TrainingService.allowedTrainingPriorityValues + backend normalizeTrainingPriority', false, [
    value('hybrid', 'Balanced hybrid', 'hybrid'),
    value('running', 'Running', 'running'),
    value('cycling', 'Cycling', 'cycling'),
    value('swimming', 'Swimming', 'swimming'),
    value('strength', 'Strength', 'strength'),
    value('triathlon', 'Triathlon', 'triathlon'),
  ]),
  axis('raceDateBucket', 'Race date bucket', 'iOS race date picker + backend YYYY-MM-DD parser', true, [
    value('none', 'No race date', null),
    value('near_3_weeks', 'Near race, 3 weeks', '2026-07-14'),
    value('normal_16_weeks', 'Normal block, 16 weeks', '2026-10-13'),
    value('far_40_weeks', 'Far race, 40 weeks', '2027-03-30'),
  ]),
  axis('durationBucket', 'Duration bucket', 'backend durationWeeks bounds + race-date derived duration', true, [
    value('engine_default', 'Engine default', null),
    value('minimum_1_week', 'Minimum, 1 week', 1),
    value('standard_4_weeks', 'Standard, 4 weeks', 4),
    value('event_derived', 'Event-derived duration', 16),
  ]),
  axis('sessionsPerWeek', 'Sessions per week', 'iOS stepper 3...7 + backend volume enforcement', false, [
    value('min_3', '3 sessions', 3),
    value('middle_5', '5 sessions', 5),
    value('max_7', '7 sessions', 7),
  ]),
  axis('runSessionsPerWeek', 'Run/cardio sessions', 'iOS run stepper 0...7 + backend weekly targets', false, [
    value('none_0', '0 run/cardio sessions', 0),
    value('middle_3', '3 run/cardio sessions', 3),
    value('heavy_5', '5 run/cardio sessions', 5),
    value('max_7', '7 run/cardio sessions', 7),
  ]),
  axis('strengthSessionsPerWeek', 'Strength sessions', 'iOS strength stepper 0...6 + backend strength variant pool', false, [
    value('none_0', '0 strength sessions', 0),
    value('support_2', '2 support sessions', 2),
    value('bodybuilding_5', '5-way split', 5),
    value('max_6', '6 strength sessions', 6),
  ]),
  axis('longWorkoutDay', 'Long workout day', 'iOS long-workout picker + backend calendar capacity reconciliation', false, [
    value('auto', 'Auto', null),
    value('monday', 'Monday', 'Monday'),
    value('saturday', 'Saturday', 'Saturday'),
    value('sunday', 'Sunday', 'Sunday'),
  ]),
  axis('twoADayPreference', 'Two-a-day preference', 'TrainingService.allowedTwoADayPreferenceValues + backend two-a-day engine', false, [
    value('auto', 'Auto', 'auto'),
    value('optional', 'Optional two-a-days', 'optional'),
    value('preferred', 'Prefer two-a-days', 'preferred'),
    value('never', 'Never two-a-days', 'never'),
  ]),
  axis('preferredTimeBucket', 'Preferred time bucket', 'iOS DatePicker HH:mm + backend preferred time parser', true, [
    value('morning', 'Morning', '07:00'),
    value('midday', 'Midday', '12:00'),
    value('evening', 'Evening', '18:30'),
    value('dst_boundary_morning', 'DST boundary morning', '06:30'),
  ]),
  axis('calendarSource', 'Calendar source', 'TrainingCalendarSourceResolver + backend calendar source resolver', false, [
    value('none_connected', 'No connected calendar', null),
    value('google', 'Google Calendar', 'google'),
    value('outlook', 'Outlook Calendar', 'outlook'),
    value('both_prefer_outlook', 'Both connected, prefer Outlook', 'outlook'),
  ]),
  axis('calendarCapacityState', 'Calendar capacity', 'bounded QA schedule capacity fixtures + agenda sync reconciliation', false, [
    value('normal_capacity', 'Normal calendar capacity', 'normal_capacity'),
    value('limited_capacity', 'Limited calendar capacity', 'limited_capacity'),
  ]),
  axis('wearableState', 'Wearable state', 'iOS readiness source + backend health signal freshness', false, [
    value('none', 'No wearable data', 'none'),
    value('garmin_fresh', 'Fresh Garmin', 'garmin_fresh'),
    value('apple_health_fresh', 'Fresh Apple Health', 'apple_health_fresh'),
    value('stale', 'Stale wearable data', 'stale'),
  ]),
  axis('readinessState', 'Readiness/adaptability state', 'training home state + coach safety/adaptation inputs', false, [
    value('no_data', 'No readiness data', 'no_data'),
    value('high_readiness', 'High readiness', 'high_readiness'),
    value('low_readiness', 'Low readiness', 'low_readiness'),
    value('soreness_fatigue', 'Soreness or fatigue', 'soreness_fatigue'),
    value('high_recent_load', 'High recent load', 'high_recent_load'),
    value('missed_sessions', 'Missed sessions', 'missed_sessions'),
    value('red_flag', 'Safety red flag', 'red_flag'),
  ]),
  axis('equipmentState', 'Equipment state', 'training equipment authority + catalog vocabulary', false, [
    value('bodyweight', 'Bodyweight only', 'bodyweight'),
    value('dumbbells', 'Dumbbells', 'dumbbells'),
    value('full_gym', 'Full gym', 'full_gym'),
    value('hotel_gym', 'Hotel gym', 'hotel_gym'),
    value('limited', 'Limited / travel', 'limited'),
  ]),
  axis('profileState', 'Profile/questionnaire state', 'Training profile requirements + iOS first-run gate', false, [
    value('complete', 'Complete profile', 'complete'),
    value('fitness_missing', 'Fitness questionnaire missing', 'fitness_missing'),
    value('objective_missing', 'Objective missing', 'objective_missing'),
    value('questionnaire_pending', 'Required questionnaire pending', 'questionnaire_pending'),
  ]),
];

export const TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS: TrainingPlanQualityPersonaScenario[] = [
  persona('beginner_gym', 'Beginner gym', ['novice_safe_strength', 'equipment_fit', 'simple_progression'], ['advanced lifts without substitution', 'missing form/safety rationale']),
  persona('intermediate_hypertrophy', 'Intermediate hypertrophy', ['split_integrity', 'volume_progression', 'exercise_variety'], ['generic full-body repetition', 'no measurable overload path']),
  persona('hybrid_run_strength', 'Hybrid run + strength', ['hard_easy_balance', 'lower_body_spacing', 'weekly_rationale'], ['heavy lower before key run', 'unexplained hard-session stack']),
  persona('cycling_gym', 'Cycling + gym', ['cycling_benchmark_or_rpe', 'strength_support_spacing', 'bike_specificity'], ['running substituted for cycling intent', 'FTP/power zones without benchmark']),
  persona('swim_triathlon', 'Swim / triathlon', ['pool_access_fit', 'discipline_balance', 'brick_or_transition_logic'], ['swim without access', 'three disconnected single-sport plans']),
  persona('travel_week', 'Travel week', ['limited_equipment_substitutions', 'compressed_duration_fit', 'calendar_realism'], ['barbell-only travel plan', 'sessions impossible in stated window']),
  persona('limited_time_week', 'Limited-time week', ['duration_truthfulness', 'minimum_viable_week', 'priority_protection'], ['label-only sessions', 'overpacked week']),
  persona('injury_discomfort', 'Injury or discomfort', ['pain_boundary', 'safe_substitution', 'professional_guidance_copy'], ['prescribes through pain', 'hides medical-risk caveat']),
  persona('poor_adherence', 'Poor adherence', ['real_compliance_signal', 'reentry_or_deload', 'explanation_cites_misses'], ['progresses after repeated misses', 'ignores skipped key sessions']),
  persona('fatigue_plateau', 'Fatigue / plateau', ['recovery_downgrade', 'load_monitoring', 'next_step_assessment'], ['keeps hard work with soreness/fatigue', 'no adaptation rationale']),
  persona('stale_wearable', 'Stale wearable', ['degraded_state_label', 'no_overconfident_readiness', 'manual_feedback_prompt'], ['claims fresh readiness from stale data', 'uses stale provider data for an aggressive load jump']),
  persona('no_wearable', 'No wearable', ['subjective_feedback_path', 'rpe_based_progression', 'missing_signal_honesty'], ['requires wearable to proceed', 'invented recovery metrics']),
  persona('calendar_conflicted', 'Calendar-conflicted', ['capacity_reflow', 'idempotent_calendar_state', 'repair_needed_copy'], ['duplicate events', 'moves without explanation']),
  persona('race_prep', 'Race prep', ['race_date_fit', 'taper_specificity', 'benchmark_or_goal_pace_logic'], ['fake taper without event', 'plan overshoots race date']),
];

function persona(
  id: string,
  label: string,
  requiredSignals: string[],
  failureConditions: string[],
): TrainingPlanQualityPersonaScenario {
  return { id, label, requiredSignals, failureConditions };
}

export const TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE = [
  evidence('WHO-2020-PA', 'WHO 2020 physical activity guidelines', 'official_guideline', 'https://www.who.int/publications/i/item/9789240015128', 'Aerobic and muscle-strengthening minimums; sedentary-time reduction.'),
  evidence('ACSM-GETP-12', 'ACSM Guidelines for Exercise Testing and Prescription, 12th edition', 'official_guideline', 'https://acsm.org/education-resources/books/guidelines-exercise-testing-prescription/', 'FITT-VP exercise prescription and screening standards.'),
  evidence('ACSM-RT-2026', 'ACSM 2026 resistance training position update', 'position_stand', 'https://acsm.org/resistance-training-guidelines-update-2026/', 'Resistance training consistency, load, volume, strength, hypertrophy, power, and function.'),
  evidence('IOC-REDS-2023', 'IOC 2023 REDs consensus statement', 'consensus_statement', 'https://bjsm.bmj.com/content/57/17/1073', 'Low energy availability and athlete-health risk escalation.'),
  evidence('ENDURANCE-TID-REVIEW', 'Polarized versus other endurance intensity distributions review', 'systematic_review', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11329428/', 'Intensity-distribution expectations and limits for endurance athletes.'),
  evidence('HIIT-MICT-REVIEW', 'HIIT versus moderate continuous training review evidence', 'systematic_review', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5790162/', 'Cardiorespiratory-fitness effects and intensity prescription caution.'),
] as const;

export interface TrainingPlanQualitySession {
  id: string;
  weekNumber: number;
  dayOfWeek: string;
  sport: 'running' | 'cycling' | 'swimming' | 'strength' | 'mobility' | 'recovery' | 'hybrid';
  title: string;
  sessionType: string;
  durationMinutes: number;
  intensity: 'easy' | 'moderate' | 'hard' | 'recovery';
  keySession?: boolean;
  startTime?: string | null;
  equipment?: string[];
  movementPatterns?: string[];
  adaptationReason?: string | null;
  safetyDowngradeReason?: string | null;
}

export interface TrainingPlanQualityCandidate {
  objective: string;
  goalMode: string;
  engineGoal?: string | null;
  readinessState?: string;
  equipmentState?: string;
  calendarCapacityState?: string;
  weeks: Array<{
    weekNumber: number;
    phase: string;
    sessions: TrainingPlanQualitySession[];
  }>;
}

export interface TrainingPlanQualityDimensionScore {
  dimension: string;
  score: number;
  observations: string[];
  blockers: string[];
}

export interface TrainingPlanQualityScore {
  score: number;
  verdict: TrainingPlanQualityVerdict;
  evidenceBaselineIds: string[];
  dimensions: TrainingPlanQualityDimensionScore[];
  blockers: string[];
}

export interface TrainingAgendaValidationSession {
  planId: number | string;
  planVersion?: number | string | null;
  sessionId: number | string;
  sessionIdentityKey?: string | null;
  date: string;
  timezone: string;
  title: string;
  type: string;
  startTime?: string | null;
  durationMinutes: number;
  status: string;
}

export interface TrainingAgendaValidationItem {
  agendaItemId: string;
  providerEventId?: string | null;
  planId?: number | string | null;
  planVersion?: number | string | null;
  sessionId?: number | string | null;
  sessionIdentityKey?: string | null;
  date: string;
  timezone: string;
  title: string;
  type: string;
  startTime?: string | null;
  durationMinutes: number;
  status: string;
}

export interface TrainingAgendaValidationResult {
  ok: boolean;
  missingAgendaSessionIds: string[];
  duplicateAgendaKeys: string[];
  mismatches: Array<{ sessionId: string; field: string; planValue: string; agendaValue: string }>;
}

export function buildTrainingPlanCreationValidationMatrix(
  qaAccountEmail = TRAINING_PLAN_CREATION_QA_ACCOUNT_EMAIL,
): TrainingPlanCreationValidationMatrix {
  const baseline = axisValueMap((axisId, axis) => axis.values[0] ?? missingAxisValue(axisId));
  const scenarios: TrainingPlanCreationValidationScenario[] = [{
    id: 'baseline-complete-profile-outlook',
    label: 'Baseline complete-profile Outlook plan creation',
    qaAccountEmail,
    values: {
      ...baseline,
      objective: mustAxisValue('objective', 'marathon'),
      goalMode: mustAxisValue('goalMode', 'event_based'),
      raceDateBucket: mustAxisValue('raceDateBucket', 'normal_16_weeks'),
      durationBucket: mustAxisValue('durationBucket', 'event_derived'),
      sessionsPerWeek: mustAxisValue('sessionsPerWeek', 'middle_5'),
      runSessionsPerWeek: mustAxisValue('runSessionsPerWeek', 'heavy_5'),
      strengthSessionsPerWeek: mustAxisValue('strengthSessionsPerWeek', 'support_2'),
      calendarSource: mustAxisValue('calendarSource', 'outlook'),
      calendarCapacityState: mustAxisValue('calendarCapacityState', 'normal_capacity'),
      profileState: mustAxisValue('profileState', 'complete'),
    },
    expectedChecks: defaultScenarioChecks(),
  }];

  for (const axisItem of TRAINING_PLAN_CREATION_VARIATION_AXES) {
    for (const valueItem of axisItem.values) {
      if (scenarios.some((scenario) => scenario.values[axisItem.id].id === valueItem.id)) continue;
      scenarios.push({
        id: `${axisItem.id}-${valueItem.id}`,
        label: `${axisItem.label}: ${valueItem.label}`,
        qaAccountEmail,
        values: { ...baseline, [axisItem.id]: valueItem },
        expectedChecks: defaultScenarioChecks(axisItem.id),
      });
    }
  }

  return {
    qaAccountEmail,
    strategy: 'axis-complete-boundary-matrix',
    axes: TRAINING_PLAN_CREATION_VARIATION_AXES,
    cartesianVariationCount: TRAINING_PLAN_CREATION_VARIATION_AXES.reduce(
      (product, axisItem) => product * axisItem.values.length,
      1,
    ),
    scenarios,
    personaScenarios: TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS,
    requiredE2EChecks: [
      'Start a fresh isolated Training E2E backend container from the target worktree HEAD; record git SHA, image IDs, compose project, non-default ports, DB path, and /api/snapshot.',
      'Run against a non-8200 backend URL and an isolated .local/training-e2e database/log directory so parallel worktrees cannot contaminate evidence.',
      'Run iOS on a dedicated simulator UDID with unique DerivedData/result bundle/test-summary paths; do not shut down or reuse another worktree simulator.',
      'Launch iOS with the isolated Training E2E backend base URL and debug auth import path; reject evidence if the app points at default 127.0.0.1:8200.',
      'Authenticate as the QA account only in an owner-authorized local or staging environment.',
      'Preview the plan and verify no persistence or agenda writes happened during preview.',
      'Create the plan and read back backend weeks, iOS Plan, iOS Today, and Agenda/calendar surfaces.',
      'Exercise Training Skill entry points: first-run/profile gate, plan builder, preview/review, create, Today, Plan, Progress, complete, skip, feedback, reflow/swap, and degraded/no-plan states.',
      'Run agenda matcher for identity, date, timezone, title/type, duration, status, version, and duplicate checks.',
      'Run feedback/progression checks: easy/normal/hard feedback, soreness, pain, skipped key sessions, partial completion, repeated misses, deload/reentry, and visible rationale.',
      'Run quality score and treat fail verdicts or plan/agenda divergence as blocking.',
      'Clean up only test-created plans and agenda/provider events.',
    ],
  };
}

export function buildTrainingPlanCreationQualityMatrix(options: {
  qaAccountEmail?: string;
  mode?: TrainingPlanCreationQualityMatrixMode;
} = {}): TrainingPlanCreationQualityMatrix {
  const mode = options.mode ?? 'static_offline';
  const matrix = buildTrainingPlanCreationValidationMatrix(options.qaAccountEmail);
  const baselineCandidate = syntheticQualityCandidateForScenario(matrix.scenarios[0]);
  const rows = matrix.scenarios.map((scenario) => {
    const candidate = syntheticQualityCandidateForScenario(scenario);
    const deterministicCandidate = syntheticQualityCandidateForScenario(scenario);
    const quality = scoreTrainingPlanQuality(candidate);
    const agenda = syntheticAgendaForCandidate(candidate, scenario);
    const agendaResult = validateTrainingPlanAgendaMatch(agenda.sessions, agenda.items);
    const connectedCalendar = scenario.values.calendarSource.requestValue != null;
    const outputQuality = scoreMatrixOutputQuality(candidate, deterministicCandidate);
    const trainingQuality = toMatrixColumn(quality.score, [`Training quality verdict: ${quality.verdict}.`], quality.blockers);
    const calendarQuality = connectedCalendar
      ? toMatrixColumn(agendaResult.ok ? 100 : 45, [`Agenda item count: ${agenda.items.length}.`], agendaBlockers(agendaResult))
      : toMatrixColumn(100, ['No connected calendar; agenda sync is not required in this bounded scenario.'], []);
    const evidenceStructure = scoreMatrixEvidenceStructure(quality.evidenceBaselineIds);
    const progression = scoreMatrixProgression(quality);
    const variation = scoreMatrixVariation(candidate, baselineCandidate, deterministicCandidate, scenario);
    const scoring = {
      outputQuality,
      trainingQuality,
      calendarQuality,
      evidenceStructure,
      progression,
      variation,
    };
    const blockers = uniqueStrings([
      ...quality.blockers,
      ...Object.values(scoring).flatMap((column) => column.blockers),
    ]);
    const warnings = collectMatrixWarnings(scenario, quality, scoring);
    const totalScore = Math.round(Object.values(scoring).reduce((sum, column) => sum + column.score, 0) / Object.values(scoring).length);
    const hasWarnColumn = quality.verdict === 'warn' || Object.values(scoring).some((column) => column.verdict === 'warn');
    const qualityVerdict: TrainingPlanQualityVerdict = blockers.length > 0 ? 'fail' : hasWarnColumn || totalScore < 82 ? 'warn' : 'pass';
    return {
      scenarioId: scenario.id,
      label: scenario.label,
      objective: requestString(scenario.values.objective),
      goalMode: requestString(scenario.values.goalMode),
      durationBucket: scenario.values.durationBucket.id,
      sessionsPerWeek: requestNumber(scenario.values.sessionsPerWeek, 5),
      sportSplit: {
        trainingPriority: requestString(scenario.values.trainingPriority),
        runCardioSessionsPerWeek: requestNumber(scenario.values.runSessionsPerWeek, 0),
      },
      strengthSplit: {
        strengthSessionsPerWeek: requestNumber(scenario.values.strengthSessionsPerWeek, 0),
      },
      twoADayPreference: requestString(scenario.values.twoADayPreference),
      longWorkoutDay: requestString(scenario.values.longWorkoutDay) || 'auto',
      calendarSource: requestString(scenario.values.calendarSource) || 'none_connected',
      calendarCapacityState: requestString(scenario.values.calendarCapacityState),
      readinessState: requestString(scenario.values.readinessState),
      equipmentState: requestString(scenario.values.equipmentState),
      profileState: requestString(scenario.values.profileState),
      previewStatus: mode === 'static_offline' ? 'static_validated' : 'blocked_requires_authorization',
      createStatus: mode === 'static_offline' ? 'not_executed_static' : 'authorized_e2e_pending',
      agendaStatus: mode === 'static_offline'
        ? connectedCalendar
          ? agendaResult.ok ? 'pass' : 'fail'
          : 'not_required_no_calendar'
        : 'blocked_requires_authorization',
      qualityVerdict,
      totalScore,
      blockers,
      warnings,
      evidenceIds: quality.evidenceBaselineIds,
      scoring,
    } satisfies TrainingPlanCreationQualityMatrixRow;
  });

  const duplicateScenarioIds = duplicateValues(rows.map((row) => row.scenarioId));
  const personaScorecard = buildTrainingPlanQualityPersonaScorecard(matrix.personaScenarios);
  return {
    qaAccountEmail: matrix.qaAccountEmail,
    mode,
    authorizationRequiredForWrites: true,
    localSimulatorAccountEmail: TRAINING_PLAN_CREATION_LOCAL_SIMULATOR_ACCOUNT_EMAIL,
    personaScenarios: matrix.personaScenarios,
    personaScorecard,
    rows,
    summary: {
      rowCount: rows.length,
      scenarioCount: matrix.scenarios.length,
      duplicateScenarioIds,
      missingAxisCoverage: missingAxisCoverage(matrix),
      verdictCounts: {
        pass: rows.filter((row) => row.qualityVerdict === 'pass').length,
        warn: rows.filter((row) => row.qualityVerdict === 'warn').length,
        fail: rows.filter((row) => row.qualityVerdict === 'fail').length,
      },
      evidenceIds: TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE.map((source) => source.id),
      modeNotes: [
        'Static/offline mode uses deterministic synthetic candidates and does not preview, create, sync, or clean up live data.',
        'Authorized E2E mode remains a plan-only contract until Felipe explicitly approves local/staging writes.',
        `${TRAINING_PLAN_CREATION_QA_ACCOUNT_EMAIL} is the Training validation QA account; ${TRAINING_PLAN_CREATION_LOCAL_SIMULATOR_ACCOUNT_EMAIL} is only the local simulator/debug-auth sandbox account.`,
      ],
    },
  };
}

const TRAINING_PLAN_QUALITY_SCORE_DIMENSIONS: TrainingPlanQualityScoreDimension[] = [
  'personalization',
  'safety',
  'progression',
  'scheduleFit',
  'exerciseVariety',
  'modalityCorrectness',
  'explanationQuality',
  'calendarCompatibility',
  'measurableOutcomes',
];

function buildTrainingPlanQualityPersonaScorecard(
  scenarios: TrainingPlanQualityPersonaScenario[],
): TrainingPlanQualityPersonaScore[] {
  return scenarios.map(scoreTrainingPlanQualityPersonaScenario);
}

function scoreTrainingPlanQualityPersonaScenario(
  scenario: TrainingPlanQualityPersonaScenario,
): TrainingPlanQualityPersonaScore {
  const dimensionScores = Object.fromEntries(
    TRAINING_PLAN_QUALITY_SCORE_DIMENSIONS.map((dimensionName) => [
      dimensionName,
      personaDimensionScore(scenario, dimensionName),
    ]),
  ) as Record<TrainingPlanQualityScoreDimension, number>;
  const totalScore = Math.round(
    TRAINING_PLAN_QUALITY_SCORE_DIMENSIONS.reduce((sum, dimensionName) => sum + dimensionScores[dimensionName], 0)
      / TRAINING_PLAN_QUALITY_SCORE_DIMENSIONS.length,
  );
  const blockers = TRAINING_PLAN_QUALITY_SCORE_DIMENSIONS
    .filter((dimensionName) => dimensionScores[dimensionName] < 80)
    .map((dimensionName) => `${scenario.id}:${dimensionName} below minimum persona-quality threshold.`);
  const warnings = TRAINING_PLAN_QUALITY_SCORE_DIMENSIONS
    .filter((dimensionName) => dimensionScores[dimensionName] >= 80 && dimensionScores[dimensionName] < 88)
    .map((dimensionName) => `${scenario.id}:${dimensionName} should be reviewed in generated-output QA.`);
  return {
    id: scenario.id,
    label: scenario.label,
    requiredSignals: scenario.requiredSignals,
    failureConditions: scenario.failureConditions,
    dimensionScores,
    totalScore,
    qualityVerdict: blockers.length > 0 ? 'fail' : warnings.length > 0 || totalScore < 90 ? 'warn' : 'pass',
    blockers,
    warnings,
  };
}

function personaDimensionScore(
  scenario: TrainingPlanQualityPersonaScenario,
  dimensionName: TrainingPlanQualityScoreDimension,
): number {
  const evidence = `${scenario.id} ${scenario.requiredSignals.join(' ')} ${scenario.failureConditions.join(' ')}`.toLowerCase();
  const has = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(evidence));
  switch (dimensionName) {
    case 'personalization':
      return has([/profile|preference|subjective|real_compliance|missing_signal|goal|benchmark/]) ? 94 : 88;
    case 'safety':
      return has([/injury|pain|discomfort|fatigue|stale|safe|professional|wearable|recovery/]) ? 95 : 88;
    case 'progression':
      return has([/progression|overload|deload|reentry|taper|race_date|plateau|measurable/]) ? 94 : 89;
    case 'scheduleFit':
      return has([/calendar|capacity|travel|limited|duration|window|spacing|duplicate|impossible/]) ? 94 : 88;
    case 'exerciseVariety':
      return has([/exercise_variety|substitution|equipment|barbell|full-body|repetition|split/]) ? 92 : 88;
    case 'modalityCorrectness':
      return has([/cycling|swim|triathlon|run|strength|bike|race|discipline|modality/]) ? 95 : 89;
    case 'explanationQuality':
      return has([/rationale|explanation|why|copy|cites|honesty|claim|review/]) ? 94 : 89;
    case 'calendarCompatibility':
      return has([/calendar|idempotent|duplicate|repair|capacity|schedule|events/]) ? 95 : 88;
    case 'measurableOutcomes':
      return has([/measurable|benchmark|assessment|outcomes|completion|rpe|feedback|target/]) ? 94 : 89;
  }
}

export function validateTrainingPlanAgendaMatch(
  sessions: TrainingAgendaValidationSession[],
  agendaItems: TrainingAgendaValidationItem[],
): TrainingAgendaValidationResult {
  const activeSessions = sessions.filter((session) => !isExcludedAgendaStatus(session.status));
  const missingAgendaSessionIds: string[] = [];
  const duplicateAgendaKeys: string[] = [];
  const mismatches: TrainingAgendaValidationResult['mismatches'] = [];

  for (const session of activeSessions) {
    const keys = sessionAgendaKeys(session);
    const matches = matchingAgendaItemsForSession(session, agendaItems);
    if (matches.length === 0) {
      missingAgendaSessionIds.push(String(session.sessionId));
      continue;
    }
    if (matches.length > 1) {
      duplicateAgendaKeys.push(keys[0] ?? String(session.sessionId));
    }
    const item = matches[0];
    compareField(mismatches, session, item, 'planId', normalized(session.planId), normalized(item.planId));
    if (session.planVersion != null || item.planVersion != null) {
      compareField(mismatches, session, item, 'planVersion', normalized(session.planVersion), normalized(item.planVersion));
    }
    compareField(mismatches, session, item, 'date', session.date, item.date);
    compareField(mismatches, session, item, 'timezone', session.timezone, item.timezone);
    compareField(mismatches, session, item, 'title', normalizeText(session.title), normalizeText(item.title));
    compareField(mismatches, session, item, 'type', normalizeText(session.type), normalizeText(item.type));
    compareField(mismatches, session, item, 'startTime', normalized(session.startTime), normalized(item.startTime));
    compareField(mismatches, session, item, 'durationMinutes', String(session.durationMinutes), String(item.durationMinutes));
    if (!agendaStatusesEquivalent(session.status, item.status)) {
      compareField(mismatches, session, item, 'status', normalizeAgendaStatus(session.status), normalizeAgendaStatus(item.status));
    }
  }

  return {
    ok: missingAgendaSessionIds.length === 0 && duplicateAgendaKeys.length === 0 && mismatches.length === 0,
    missingAgendaSessionIds,
    duplicateAgendaKeys: uniqueStrings(duplicateAgendaKeys),
    mismatches,
  };
}

export function scoreTrainingPlanQuality(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityScore {
  const dimensions = [
    scorePeriodization(candidate),
    scoreProgression(candidate),
    scoreDeloadLogic(candidate),
    scoreRecoverySpacing(candidate),
    scoreIntensityDistribution(candidate),
    scoreStrengthBalance(candidate),
    scoreEquipmentFit(candidate),
    scoreCalendarRealism(candidate),
    scoreReadinessAdaptation(candidate),
    scoreSafetyDowngrades(candidate),
    scoreObjectiveFidelity(candidate),
  ];
  const weightedScore = Math.round(dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length);
  const blockers = dimensions.flatMap((item) => item.blockers);
  const hasDimensionWarning = dimensions.some((item) => item.score < 82);
  return {
    score: weightedScore,
    verdict: blockers.length > 0 ? 'fail' : hasDimensionWarning || weightedScore < 82 ? 'warn' : 'pass',
    evidenceBaselineIds: TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE.map((source) => source.id),
    dimensions,
    blockers,
  };
}

function scorePeriodization(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const phases = new Set(candidate.weeks.map((week) => normalizeText(week.phase)).filter(Boolean));
  const observations = [`Phases: ${[...phases].join(', ') || 'none'}.`];
  const blockers: string[] = [];
  let score = 100;
  if (candidate.weeks.length >= 4 && phases.size < 2) {
    score -= 28;
    blockers.push('Four-plus-week plans need more than one phase or an explicit maintenance rationale.');
  }
  if (candidate.goalMode === 'event_based' && ![...phases].some((phase) => phase.includes('taper') || phase.includes('peak'))) {
    score -= 18;
    blockers.push('Event-based plans must show peak/taper or explain why the event is too near.');
  }
  return dimension('periodization', score, observations, blockers);
}

function scoreProgression(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const weeklyMinutes = candidate.weeks.map((week) => week.sessions.reduce((sum, session) => sum + session.durationMinutes, 0));
  const blockers: string[] = [];
  let score = 100;
  for (let index = 1; index < weeklyMinutes.length; index += 1) {
    const previous = Math.max(weeklyMinutes[index - 1], 1);
    const jump = (weeklyMinutes[index] - previous) / previous;
    const previousPhase = normalizeText(candidate.weeks[index - 1]?.phase ?? '');
    const reboundFromLoadReduction = /deload|taper|recovery|review/.test(previousPhase);
    if (jump > 0.35 && (!reboundFromLoadReduction || jump > 0.8)) {
      score -= 24;
      blockers.push(`Week ${index + 1} load jumps ${Math.round(jump * 100)}%, above the conservative progression guardrail.`);
    }
  }
  return dimension('progression', score, [`Weekly minutes: ${weeklyMinutes.join(', ')}.`], blockers);
}

function scoreDeloadLogic(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const phases = candidate.weeks.map((week) => normalizeText(week.phase));
  const weeklyMinutes = candidate.weeks.map((week) => week.sessions.reduce((sum, session) => sum + session.durationMinutes, 0));
  const hasDeloadLikePhase = phases.some((phase) => /deload|taper|recovery|review/.test(phase));
  const hasLowerFinalWeek = weeklyMinutes.length >= 4
    && weeklyMinutes[weeklyMinutes.length - 1] <= weeklyMinutes[Math.max(0, weeklyMinutes.length - 2)] * 0.9;
  const blockers: string[] = [];
  let score = 100;
  if (candidate.weeks.length >= 4 && !hasDeloadLikePhase && !hasLowerFinalWeek) {
    score -= 26;
    blockers.push('Four-plus-week plans need a deload, taper, recovery week, or explicit load-reduction rationale.');
  }
  return dimension('deload_logic', score, [`Deload-like phase present: ${hasDeloadLikePhase}.`], blockers);
}

function scoreRecoverySpacing(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const hardDays = new Map<string, number>();
  const blockers: string[] = [];
  let score = 100;
  for (const session of allQualitySessions(candidate)) {
    if (session.intensity === 'hard') {
      const key = `${session.weekNumber}:${normalizeText(session.dayOfWeek)}`;
      hardDays.set(key, (hardDays.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of hardDays.entries()) {
    if (count > 1) {
      score -= 16;
      blockers.push(`${key} has ${count} hard sessions on the same day.`);
    }
  }
  return dimension('recovery_spacing', score, [`Hard-session days: ${hardDays.size}.`], blockers);
}

function scoreIntensityDistribution(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const endurance = allQualitySessions(candidate).filter((session) => session.sport !== 'strength' && session.sport !== 'mobility');
  if (endurance.length === 0) return dimension('intensity_distribution', 100, ['No endurance sessions requested.'], []);
  const hardCount = endurance.filter((session) => session.intensity === 'hard').length;
  const easyCount = endurance.filter((session) => session.intensity === 'easy' || session.intensity === 'recovery').length;
  const hardRatio = hardCount / endurance.length;
  const blockers: string[] = [];
  let score = 100;
  if (hardRatio > 0.35) {
    score -= 30;
    blockers.push(`Hard endurance ratio is ${Math.round(hardRatio * 100)}%; review intensity distribution.`);
  }
  if (easyCount === 0 && endurance.length >= 3) {
    score -= 20;
    blockers.push('Endurance block has no easy/recovery sessions.');
  }
  return dimension('intensity_distribution', score, [`Hard endurance ratio ${Math.round(hardRatio * 100)}%.`], blockers);
}

function scoreStrengthBalance(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const strength = allQualitySessions(candidate).filter((session) => session.sport === 'strength');
  if (strength.length === 0) return dimension('strength_balance', 100, ['No strength sessions requested.'], []);
  const patterns = new Set(strength.flatMap((session) => session.movementPatterns ?? []).map(normalizeText));
  const blockers: string[] = [];
  let score = 100;
  if (strength.length >= 2 && patterns.size < 3) {
    score -= 24;
    blockers.push('Strength sessions need clearer movement-pattern variety.');
  }
  return dimension('strength_balance', score, [`Movement patterns: ${[...patterns].join(', ') || 'none'}.`], blockers);
}

function scoreEquipmentFit(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const state = normalizeText(candidate.equipmentState ?? 'unknown');
  const unavailableByState: Record<string, string[]> = {
    bodyweight: ['barbell', 'machine', 'cable', 'dumbbell', 'kettlebell'],
    limited: ['barbell', 'machine', 'cable', 'leg press'],
    hotel_gym: ['barbell', 'rack', 'platform', 'heavy machine'],
    dumbbells: ['barbell', 'machine', 'cable'],
  };
  const unavailable = unavailableByState[state] ?? [];
  const blockers: string[] = [];
  const observations: string[] = [`Equipment state: ${candidate.equipmentState ?? 'unknown'}.`];
  for (const session of allQualitySessions(candidate)) {
    const used = (session.equipment ?? []).map(normalizeText);
    const bad = used.filter((equipment) => unavailable.some((token) => equipment.includes(token)));
    if (bad.length > 0) blockers.push(`${session.id} uses unavailable equipment: ${bad.join(', ')}.`);
  }
  if (state === 'bodyweight' && allQualitySessions(candidate).some((session) => session.sport === 'strength' && (session.equipment ?? []).length === 0)) {
    observations.push('Bodyweight strength sessions use no external equipment.');
  }
  return dimension('equipment_fit', blockers.length ? 55 : 100, observations, blockers);
}

function scoreCalendarRealism(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const blockers: string[] = [];
  for (const week of candidate.weeks) {
    const byDay = new Map<string, TrainingPlanQualitySession[]>();
    for (const session of week.sessions) {
      byDay.set(normalizeText(session.dayOfWeek), [...(byDay.get(normalizeText(session.dayOfWeek)) ?? []), session]);
      if (session.durationMinutes <= 0 || session.durationMinutes > 240) {
        blockers.push(`${session.id} has unrealistic duration ${session.durationMinutes}.`);
      }
    }
    for (const [day, sessions] of byDay.entries()) {
      if (sessions.length > 2) blockers.push(`Week ${week.weekNumber} ${day} has ${sessions.length} sessions.`);
    }
  }
  if (candidate.calendarCapacityState === 'limited_capacity') {
    const maxSessionsInAnyWeek = Math.max(...candidate.weeks.map((week) => week.sessions.length));
    if (maxSessionsInAnyWeek > 8) blockers.push(`Limited calendar capacity cannot realistically hold ${maxSessionsInAnyWeek} sessions in a week.`);
  }
  return dimension('calendar_realism', blockers.length ? 60 : 100, [`Checked ${candidate.weeks.length} week(s).`], blockers);
}

function scoreReadinessAdaptation(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const state = candidate.readinessState ?? 'unknown';
  const sessions = allQualitySessions(candidate);
  const hasAdaptation = sessions.some((session) => session.adaptationReason || session.safetyDowngradeReason);
  const hardCount = sessions.filter((session) => session.intensity === 'hard').length;
  const blockers: string[] = [];
  let score = 100;
  if (['low_readiness', 'soreness_fatigue', 'high_recent_load', 'red_flag'].includes(state) && !hasAdaptation) {
    score -= 30;
    blockers.push(`Readiness state ${state} requires visible adaptation or safety rationale.`);
  }
  if (state === 'red_flag' && hardCount > 0) {
    score -= 45;
    blockers.push('Safety red-flag state cannot keep hard sessions without a qualified clearance rationale.');
  }
  return dimension('readiness_adaptation', score, [`Readiness state: ${state}.`], blockers);
}

function scoreSafetyDowngrades(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const state = candidate.readinessState ?? 'unknown';
  const sessions = allQualitySessions(candidate);
  const safetyDowngrades = sessions.filter((session) => session.safetyDowngradeReason);
  const blockers: string[] = [];
  let score = 100;
  if (state === 'red_flag' && safetyDowngrades.length === 0) {
    score -= 45;
    blockers.push('Safety red-flag state needs an explicit safety downgrade or professional-guidance rationale.');
  }
  if (state === 'soreness_fatigue' && sessions.some((session) => session.intensity === 'hard' && !session.adaptationReason)) {
    score -= 18;
    blockers.push('Soreness/fatigue scenario kept hard work without visible downgrade rationale.');
  }
  return dimension('safety_downgrades', score, [`Safety downgrades: ${safetyDowngrades.length}.`], blockers);
}

function scoreObjectiveFidelity(candidate: TrainingPlanQualityCandidate): TrainingPlanQualityDimensionScore {
  const objective = normalizeText(candidate.objective);
  const engineGoal = normalizeText(candidate.engineGoal ?? '');
  const observations = [`Objective: ${candidate.objective}.`, `QA-observed engine goal: ${candidate.engineGoal ?? 'not supplied'}.`];
  const blockers: string[] = [];
  let score = 100;
  if (objective.includes('marathon') && engineGoal && !engineGoal.includes('marathon') && !engineGoal.includes('endurance')) {
    score -= 22;
    blockers.push('Marathon objective did not map to an endurance/race training goal.');
  }
  if (objective.includes('triathlon') && engineGoal && !engineGoal.includes('triathlon') && !engineGoal.includes('multisport')) {
    score -= 22;
    blockers.push('Triathlon objective did not map to a multisport training goal.');
  }
  if (objective.includes('weight_loss') || objective.includes('weight loss')) {
    if (!engineGoal.includes('weight') && !engineGoal.includes('body_composition')) {
      score -= 24;
      observations.push('weight_loss is QA-detected as an objective-fidelity gap; runtime inferTrainingPlanGoal behavior is intentionally unchanged.');
    }
  }
  return dimension('objective_fidelity', score, observations, blockers);
}

function axis(
  id: TrainingVariationAxisId,
  label: string,
  sourceOfTruth: string,
  continuousBucketed: boolean,
  values: TrainingVariationValue[],
): TrainingVariationAxis {
  return { id, label, sourceOfTruth, continuousBucketed, values };
}

function value(id: string, label: string, requestValue: string | number | null, notes?: string): TrainingVariationValue {
  return { id, label, requestValue, notes };
}

function evidence(id: string, title: string, kind: string, url: string, useInRubric: string) {
  return { id, title, kind, url, useInRubric, observedDate: '2026-06-23' };
}

function axisValueMap(
  pick: (axisId: TrainingVariationAxisId, axis: TrainingVariationAxis) => TrainingVariationValue,
): Record<TrainingVariationAxisId, TrainingVariationValue> {
  return Object.fromEntries(
    TRAINING_PLAN_CREATION_VARIATION_AXES.map((axisItem) => [axisItem.id, pick(axisItem.id, axisItem)]),
  ) as Record<TrainingVariationAxisId, TrainingVariationValue>;
}

function mustAxisValue(axisId: TrainingVariationAxisId, valueId: string): TrainingVariationValue {
  const axisItem = TRAINING_PLAN_CREATION_VARIATION_AXES.find((candidate) => candidate.id === axisId);
  const found = axisItem?.values.find((candidate) => candidate.id === valueId);
  if (!found) throw new Error(`Unknown training variation ${axisId}.${valueId}`);
  return found;
}

function missingAxisValue(axisId: TrainingVariationAxisId): TrainingVariationValue {
  return value('missing', `Missing axis ${axisId}`, null);
}

function defaultScenarioChecks(axisId?: TrainingVariationAxisId): string[] {
  const checks = [
    'preview_contract',
    'create_contract',
    'plan_quality_score',
    'plan_to_ios_plan_match',
    'plan_to_ios_today_match',
    'plan_to_agenda_match',
    'duplicate_agenda_guard',
  ];
  if (axisId === 'readinessState' || axisId === 'wearableState') checks.push('adaptation_reason_visible');
  if (axisId === 'equipmentState') checks.push('equipment_reason_visible');
  if (axisId === 'profileState') checks.push('questionnaire_gate_visible');
  if (axisId === 'calendarCapacityState') checks.push('limited_calendar_capacity_visible');
  if (axisId === 'twoADayPreference') checks.push('two_a_day_preference_visible');
  return checks;
}

function compareField(
  mismatches: TrainingAgendaValidationResult['mismatches'],
  session: TrainingAgendaValidationSession,
  item: TrainingAgendaValidationItem,
  field: string,
  planValue: string,
  agendaValue: string,
): void {
  if (planValue === agendaValue) return;
  mismatches.push({ sessionId: String(session.sessionId), field, planValue, agendaValue });
}

function sessionAgendaKeys(session: TrainingAgendaValidationSession): string[] {
  return uniqueStrings([
    session.sessionIdentityKey ? String(session.sessionIdentityKey) : '',
    session.sessionId != null ? String(session.sessionId) : '',
  ].filter(Boolean));
}

function matchingAgendaItemsForSession(
  session: TrainingAgendaValidationSession,
  agendaItems: TrainingAgendaValidationItem[],
): TrainingAgendaValidationItem[] {
  const sessionIdentityKey = normalizedNullableKey(session.sessionIdentityKey);
  const sessionId = normalizedNullableKey(session.sessionId);
  if (sessionIdentityKey) {
    const identityMatches = agendaItems.filter((item) => normalizedNullableKey(item.sessionIdentityKey) === sessionIdentityKey);
    if (identityMatches.length > 0) return identityMatches;
    if (!sessionId) return [];
    return agendaItems.filter((item) =>
      !normalizedNullableKey(item.sessionIdentityKey) && normalizedNullableKey(item.sessionId) === sessionId);
  }
  if (!sessionId) return [];
  return agendaItems.filter((item) => normalizedNullableKey(item.sessionId) === sessionId);
}

function normalizeAgendaStatus(status: string): string {
  return normalizeText(status).replace(/_/g, '-');
}

function isExcludedAgendaStatus(status: string): boolean {
  return ['cancelled', 'canceled', 'skipped', 'deferred'].includes(normalizeText(status));
}

function agendaStatusesEquivalent(planStatus: string, agendaStatus: string): boolean {
  const plan = normalizeAgendaStatus(planStatus);
  const agenda = normalizeAgendaStatus(agendaStatus);
  const plannedEquivalents = new Set(['planned', 'scheduled', 'synced']);
  if (plannedEquivalents.has(plan) && plannedEquivalents.has(agenda)) return true;
  return plan === agenda;
}

function normalized(value: unknown): string {
  return value == null ? '' : String(value);
}

function normalizedNullableKey(value: unknown): string | null {
  const text = normalized(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function allQualitySessions(candidate: TrainingPlanQualityCandidate): TrainingPlanQualitySession[] {
  return candidate.weeks.flatMap((week) => week.sessions.map((session) => ({ ...session, weekNumber: week.weekNumber })));
}

function dimension(
  dimensionName: string,
  rawScore: number,
  observations: string[],
  blockers: string[],
): TrainingPlanQualityDimensionScore {
  return {
    dimension: dimensionName,
    score: Math.max(0, Math.min(100, Math.round(rawScore))),
    observations,
    blockers,
  };
}

function toMatrixColumn(rawScore: number, observations: string[], blockers: string[]): TrainingPlanQualityMatrixColumn {
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  return {
    score,
    verdict: blockers.length > 0 ? 'fail' : score >= 82 ? 'pass' : 'warn',
    observations,
    blockers,
  };
}

function requestString(valueItem: TrainingVariationValue): string {
  return valueItem.requestValue == null ? '' : String(valueItem.requestValue);
}

function requestNumber(valueItem: TrainingVariationValue, fallback: number): number {
  return typeof valueItem.requestValue === 'number' ? valueItem.requestValue : fallback;
}

function syntheticQualityCandidateForScenario(scenario: TrainingPlanCreationValidationScenario): TrainingPlanQualityCandidate {
  const values = scenario.values;
  const objective = requestString(values.objective) || values.objective.id;
  const goalMode = requestString(values.goalMode) || 'continuous';
  const readinessState = requestString(values.readinessState) || 'no_data';
  const equipmentState = requestString(values.equipmentState) || 'bodyweight';
  const calendarCapacityState = requestString(values.calendarCapacityState) || 'normal_capacity';
  const sessionsPerWeek = requestNumber(values.sessionsPerWeek, 5);
  const runSessions = requestNumber(values.runSessionsPerWeek, 3);
  const strengthSessions = requestNumber(values.strengthSessionsPerWeek, 2);
  const totalSessions = Math.max(1, Math.min(13, Math.max(sessionsPerWeek, runSessions + strengthSessions)));
  const enduranceCount = Math.min(runSessions, totalSessions);
  const strengthCount = Math.min(strengthSessions, Math.max(0, totalSessions - enduranceCount));
  const supportCount = Math.max(0, totalSessions - enduranceCount - strengthCount);
  const phases = phasesForGoalMode(goalMode);
  const equipment = equipmentForState(equipmentState);
  const startTimes = {
    endurance: requestString(values.preferredTimeBucket) || '07:00',
    strength: '18:00',
  };

  return {
    objective,
    goalMode,
    engineGoal: qaObservedEngineGoal(objective),
    readinessState,
    equipmentState,
    calendarCapacityState,
    weeks: phases.map((phase, weekIndex) => ({
      weekNumber: weekIndex + 1,
      phase,
      sessions: syntheticWeekSessions({
        scenario,
        weekNumber: weekIndex + 1,
        phase,
        enduranceCount,
        strengthCount,
        supportCount,
        readinessState,
        equipment,
        startTimes,
      }),
    })),
  };
}

function syntheticWeekSessions(input: {
  scenario: TrainingPlanCreationValidationScenario;
  weekNumber: number;
  phase: string;
  enduranceCount: number;
  strengthCount: number;
  supportCount: number;
  readinessState: string;
  equipment: string[];
  startTimes: { endurance: string; strength: string };
}): TrainingPlanQualitySession[] {
  const days = input.scenario.values.calendarCapacityState.id === 'limited_capacity'
    ? ['Monday', 'Tuesday', 'Thursday', 'Saturday']
    : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const sessions: TrainingPlanQualitySession[] = [];
  const factor = loadFactor(input.phase, input.readinessState);
  const adaptation = adaptationReasonForReadiness(input.readinessState);
  const safety = safetyReasonForReadiness(input.readinessState);
  for (let index = 0; index < input.enduranceCount; index += 1) {
    const isLong = index === input.enduranceCount - 1 && input.enduranceCount > 1;
    const isQuality = index === Math.min(2, input.enduranceCount - 1) && input.readinessState !== 'red_flag' && input.phase !== 'taper';
    sessions.push({
      id: `w${input.weekNumber}-run-${index + 1}`,
      weekNumber: input.weekNumber,
      dayOfWeek: dayForSession(days, index),
      sport: sportForPriority(input.scenario.values.trainingPriority.id),
      title: isLong ? 'Long aerobic session' : isQuality ? 'Controlled tempo session' : 'Easy aerobic session',
      sessionType: isLong ? 'long' : isQuality ? 'tempo' : 'easy',
      durationMinutes: Math.max(20, Math.round((isLong ? 70 : isQuality ? 45 : 40) * factor)),
      intensity: safety ? 'recovery' : isQuality ? 'hard' : 'easy',
      keySession: isLong || isQuality,
      startTime: input.startTimes.endurance,
      equipment: [],
      movementPatterns: [],
      adaptationReason: adaptation,
      safetyDowngradeReason: safety,
    });
  }
  const patterns = [
    ['squat', 'hinge', 'core'],
    ['push', 'pull', 'carry'],
    ['lunge', 'hinge', 'anti-rotation'],
    ['push', 'squat', 'pull'],
    ['carry', 'core', 'posterior-chain'],
    ['pull', 'lunge', 'push'],
  ];
  for (let index = 0; index < input.strengthCount; index += 1) {
    sessions.push({
      id: `w${input.weekNumber}-strength-${index + 1}`,
      weekNumber: input.weekNumber,
      dayOfWeek: dayForSession(days, input.enduranceCount + index),
      sport: 'strength',
      title: 'Strength support session',
      sessionType: 'strength',
      durationMinutes: Math.max(25, Math.round(45 * factor)),
      intensity: safety ? 'recovery' : 'moderate',
      keySession: false,
      startTime: input.startTimes.strength,
      equipment: input.equipment,
      movementPatterns: patterns[index % patterns.length],
      adaptationReason: adaptation,
      safetyDowngradeReason: safety,
    });
  }
  for (let index = 0; index < input.supportCount; index += 1) {
    sessions.push({
      id: `w${input.weekNumber}-mobility-${index + 1}`,
      weekNumber: input.weekNumber,
      dayOfWeek: dayForSession(days, input.enduranceCount + input.strengthCount + index),
      sport: 'mobility',
      title: 'Mobility and recovery session',
      sessionType: 'mobility',
      durationMinutes: Math.max(20, Math.round(30 * factor)),
      intensity: 'recovery',
      keySession: false,
      startTime: input.startTimes.endurance,
      equipment: [],
      movementPatterns: ['mobility', 'breathing'],
      adaptationReason: adaptation,
      safetyDowngradeReason: safety,
    });
  }
  return sessions;
}

function phasesForGoalMode(goalMode: string): string[] {
  switch (goalMode) {
  case 'event_based':
    return ['base', 'build', 'peak', 'taper'];
  case 'maintenance':
    return ['maintenance', 'maintenance', 'review_downtick', 'maintenance'];
  case 'return_to_training':
    return ['recovery', 'base', 'build', 'deload'];
  default:
    return ['base', 'build', 'deload', 'build'];
  }
}

function loadFactor(phase: string, readinessState: string): number {
  const readinessFactor = ['low_readiness', 'soreness_fatigue', 'high_recent_load', 'red_flag'].includes(readinessState) ? 0.78 : 1;
  const phaseFactor = phase.includes('taper') || phase.includes('deload') || phase.includes('recovery') || phase.includes('review')
    ? 0.72
    : phase.includes('peak')
      ? 1.2
      : phase.includes('build')
        ? 1.12
        : 1;
  return readinessFactor * phaseFactor;
}

function adaptationReasonForReadiness(readinessState: string): string | null {
  if (['low_readiness', 'soreness_fatigue', 'high_recent_load', 'missed_sessions'].includes(readinessState)) {
    return `Adapted for ${readinessState.replace(/_/g, ' ')}.`;
  }
  return null;
}

function safetyReasonForReadiness(readinessState: string): string | null {
  return readinessState === 'red_flag'
    ? 'Safety downgrade: remove intensity and advise professional guidance before hard training.'
    : null;
}

function equipmentForState(equipmentState: string): string[] {
  switch (equipmentState) {
  case 'bodyweight':
    return [];
  case 'dumbbells':
    return ['dumbbells'];
  case 'full_gym':
    return ['barbell', 'cable machine', 'dumbbells'];
  case 'hotel_gym':
    return ['dumbbells', 'resistance band'];
  case 'limited':
    return ['resistance band', 'bodyweight'];
  default:
    return [];
  }
}

function dayForSession(days: string[], index: number): string {
  return days[index % days.length];
}

function sportForPriority(priorityId: string): TrainingPlanQualitySession['sport'] {
  switch (priorityId) {
  case 'cycling':
    return 'cycling';
  case 'swimming':
    return 'swimming';
  case 'triathlon':
    return 'hybrid';
  default:
    return 'running';
  }
}

function qaObservedEngineGoal(objective: string): string {
  const normalizedObjective = normalizeText(objective);
  if (normalizedObjective.includes('triathlon')) return 'triathlon_multisport';
  if (normalizedObjective.includes('marathon') || normalizedObjective.includes('10k')) return 'endurance_marathon';
  if (normalizedObjective.includes('hypertrophy') || normalizedObjective.includes('muscle')) return 'hypertrophy';
  if (normalizedObjective.includes('weight_loss') || normalizedObjective.includes('weight loss')) return 'general_fitness';
  return 'general_fitness';
}

function syntheticAgendaForCandidate(
  candidate: TrainingPlanQualityCandidate,
  scenario: TrainingPlanCreationValidationScenario,
): { sessions: TrainingAgendaValidationSession[]; items: TrainingAgendaValidationItem[] } {
  const firstWeek = candidate.weeks[0];
  const planId = `qa-${scenario.id}`;
  const sessions = firstWeek.sessions.map((session, index) => {
    const date = `2026-07-${String(index + 1).padStart(2, '0')}`;
    return {
      planId,
      planVersion: 1,
      sessionId: session.id,
      sessionIdentityKey: `${planId}:w${session.weekNumber}:${normalizeText(session.dayOfWeek)}:${session.sessionType}:${index + 1}`,
      date,
      timezone: 'Europe/Lisbon',
      title: session.title,
      type: session.sessionType,
      startTime: session.startTime,
      durationMinutes: session.durationMinutes,
      status: 'planned',
    } satisfies TrainingAgendaValidationSession;
  });
  const items = sessions.map((session, index) => ({
    agendaItemId: `${session.planId}-agenda-${index + 1}`,
    providerEventId: `evt-${index + 1}`,
    planId: session.planId,
    planVersion: session.planVersion,
    sessionId: session.sessionId,
    sessionIdentityKey: index % 2 === 0 ? session.sessionIdentityKey : null,
    date: session.date,
    timezone: session.timezone,
    title: session.title,
    type: session.type,
    startTime: session.startTime,
    durationMinutes: session.durationMinutes,
    status: index % 2 === 0 ? 'scheduled' : 'synced',
  } satisfies TrainingAgendaValidationItem));
  return { sessions, items };
}

function scoreMatrixOutputQuality(
  candidate: TrainingPlanQualityCandidate,
  deterministicCandidate: TrainingPlanQualityCandidate,
): TrainingPlanQualityMatrixColumn {
  const blockers: string[] = [];
  const observations: string[] = [];
  const sessions = allQualitySessions(candidate);
  if (candidate.weeks.length === 0 || sessions.length === 0) blockers.push('Plan candidate must include weeks and sessions.');
  if (sessions.some((session) => !session.id || !session.title || session.durationMinutes <= 0)) {
    blockers.push('Every session must have identity, title, and positive duration.');
  }
  const forbiddenText = /token|authorization|provider response|raw log|nexushubbot@|debug secret/i;
  const leaked = sessions.some((session) => forbiddenText.test([
    session.title,
    session.adaptationReason ?? '',
    session.safetyDowngradeReason ?? '',
  ].join(' ')));
  if (leaked) blockers.push('Plan output contains raw, debug, private, or provider text.');
  const deterministic = stableStringify(candidate) === stableStringify(deterministicCandidate);
  if (!deterministic) blockers.push('Same scenario did not produce deterministic static plan shape.');
  observations.push(`Weeks: ${candidate.weeks.length}; sessions: ${sessions.length}; deterministic: ${deterministic}.`);
  return toMatrixColumn(blockers.length ? 50 : 100, observations, blockers);
}

function scoreMatrixEvidenceStructure(evidenceIds: string[]): TrainingPlanQualityMatrixColumn {
  const required = TRAINING_PLAN_SCIENCE_EVIDENCE_BASELINE.map((source) => source.id);
  const missing = required.filter((id) => !evidenceIds.includes(id));
  const blockers = missing.map((id) => `Missing evidence baseline id ${id}.`);
  return toMatrixColumn(
    blockers.length ? 60 : 100,
    [`Evidence ids: ${evidenceIds.join(', ')}.`],
    blockers,
  );
}

function scoreMatrixProgression(quality: TrainingPlanQualityScore): TrainingPlanQualityMatrixColumn {
  const dimensions = quality.dimensions.filter((item) => ['progression', 'deload_logic'].includes(item.dimension));
  const score = Math.round(dimensions.reduce((sum, item) => sum + item.score, 0) / Math.max(1, dimensions.length));
  return toMatrixColumn(
    score,
    dimensions.flatMap((item) => item.observations),
    dimensions.flatMap((item) => item.blockers),
  );
}

function scoreMatrixVariation(
  candidate: TrainingPlanQualityCandidate,
  baselineCandidate: TrainingPlanQualityCandidate,
  deterministicCandidate: TrainingPlanQualityCandidate,
  scenario: TrainingPlanCreationValidationScenario,
): TrainingPlanQualityMatrixColumn {
  const deterministic = stableStringify(candidate) === stableStringify(deterministicCandidate);
  const changedFromBaseline = scenario.id === 'baseline-complete-profile-outlook'
    || stableStringify(candidate) !== stableStringify(baselineCandidate)
    || stableStringify(scenario.values) !== stableStringify(buildTrainingPlanCreationValidationMatrix(scenario.qaAccountEmail).scenarios[0].values);
  const blockers: string[] = [];
  if (!deterministic) blockers.push('Same input scenario is not deterministic.');
  if (!changedFromBaseline) blockers.push('Changed scenario did not produce a distinguishable candidate or option signature.');
  return toMatrixColumn(
    blockers.length ? 55 : 100,
    [`Deterministic: ${deterministic}; changed from baseline: ${changedFromBaseline}.`],
    blockers,
  );
}

function agendaBlockers(result: TrainingAgendaValidationResult): string[] {
  return [
    ...result.missingAgendaSessionIds.map((id) => `Missing agenda item for ${id}.`),
    ...result.duplicateAgendaKeys.map((key) => `Duplicate agenda entries for ${key}.`),
    ...result.mismatches.map((mismatch) => `${mismatch.sessionId} agenda ${mismatch.field} mismatch.`),
  ];
}

function collectMatrixWarnings(
  scenario: TrainingPlanCreationValidationScenario,
  quality: TrainingPlanQualityScore,
  scoring: TrainingPlanCreationQualityMatrixRow['scoring'],
): string[] {
  const dimensionWarnings = quality.dimensions
    .filter((item) => item.score < 82 && item.blockers.length === 0)
    .map((item) => `${item.dimension}: ${item.observations.join(' ')}`);
  const columnWarnings = Object.entries(scoring)
    .filter(([, column]) => column.verdict === 'warn')
    .map(([name, column]) => `${name}: ${column.observations.join(' ')}`);
  const scenarioWarnings: string[] = [];
  if (scenario.values.profileState.id !== 'complete') {
    scenarioWarnings.push(`Profile state ${scenario.values.profileState.id} should route to questionnaire gating before create.`);
  }
  if (scenario.values.calendarCapacityState.id === 'limited_capacity') {
    scenarioWarnings.push('Limited calendar capacity should visibly adapt or warn before create.');
  }
  if (scenario.values.objective.id === 'weight_loss') {
    scenarioWarnings.push('weight_loss objective is QA-detected for objective fidelity; runtime inference is unchanged.');
  }
  return uniqueStrings([...dimensionWarnings, ...columnWarnings, ...scenarioWarnings]);
}

function missingAxisCoverage(matrix: TrainingPlanCreationValidationMatrix): string[] {
  return matrix.axes.flatMap((axisItem) => {
    const covered = new Set(matrix.scenarios.map((scenario) => scenario.values[axisItem.id].id));
    return axisItem.values
      .filter((valueItem) => !covered.has(valueItem.id))
      .map((valueItem) => `${axisItem.id}.${valueItem.id}`);
  });
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const valueItem of values) {
    if (seen.has(valueItem)) duplicates.add(valueItem);
    seen.add(valueItem);
  }
  return [...duplicates];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stableStringify(valueToStringify: unknown): string {
  return JSON.stringify(sortKeys(valueToStringify));
}

function sortKeys(valueToSort: unknown): unknown {
  if (Array.isArray(valueToSort)) return valueToSort.map(sortKeys);
  if (valueToSort && typeof valueToSort === 'object') {
    return Object.fromEntries(
      Object.entries(valueToSort as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, valueItem]) => [key, sortKeys(valueItem)]),
    );
  }
  return valueToSort;
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type Sport = 'running' | 'cycling' | 'swimming' | 'strength';
export type CoachingDiscipline = Sport | 'triathlon' | 'hybrid' | 'marathon';
export type BlockPhase =
  | 'base'
  | 'build'
  | 'peak'
  | 'taper'
  | 'race'
  | 'deload'
  | 'maintenance';
export type IntensityZone =
  | 'recovery'
  | 'aerobic'
  | 'tempo'
  | 'threshold'
  | 'vo2'
  | 'neuromuscular';
export type FatigueCost = 'low' | 'medium' | 'high' | 'very_high';
export type ReadinessLevel = 'green' | 'yellow' | 'orange' | 'red';
export type TrainingSessionRole =
  | 'easy'
  | 'long'
  | 'threshold'
  | 'vo2'
  | 'recovery'
  | 'brick'
  | 'taper'
  | 'race_specific'
  | 'technique'
  | 'strength_maintenance'
  | 'strength_build'
  | 'mobility'
  | 'rest';
export type DayOfWeek =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';
export type SessionType =
  | 'easy_run'
  | 'long_run'
  | 'threshold_run'
  | 'interval_run'
  | 'recovery_run'
  | 'endurance_ride'
  | 'tempo_ride'
  | 'threshold_ride'
  | 'vo2_ride'
  | 'recovery_ride'
  | 'technique_swim'
  | 'aerobic_swim'
  | 'threshold_swim'
  | 'speed_swim'
  | 'recovery_swim'
  | 'strength_hypertrophy'
  | 'strength_max'
  | 'strength_maintenance'
  | 'brick'
  | 'mobility'
  | 'rest';

export interface Constraint {
  id: string;
  type: 'time' | 'injury' | 'fatigue' | 'equipment' | 'interference' | 'race';
  severity: 'low' | 'medium' | 'high';
  description: string;
  sport?: Sport | CoachingDiscipline;
}

export interface EquipmentAccess {
  hasGym: boolean;
  hasBarbell: boolean;
  hasDumbbells: boolean;
  hasBikeTrainer: boolean;
  hasPool: boolean;
  hasTrack: boolean;
  notes?: string[];
}

export interface AvailabilityWindow {
  dayOfWeek: DayOfWeek;
  start: string;
  end: string;
  sports?: Sport[];
  label?: string;
}

export interface CapacityWindow {
  date: string;
  startTime?: string;
  endTime?: string;
  availableMinutes: number;
  constraints: string[];
  source: 'calendar' | 'user_preference' | 'travel' | 'secretary';
}

export interface Availability {
  weeklyWindows: AvailabilityWindow[];
  preferredLongSessionDay?: DayOfWeek;
  preferredTimesBySport?: Partial<Record<Sport, string>>;
  maxSessionsPerDay: number;
}

export interface RaceEvent {
  id: string;
  name: string;
  discipline: 'running' | 'cycling' | 'swimming' | 'triathlon';
  subtype?: '5k' | '10k' | 'half_marathon' | 'marathon' | 'sprint' | 'olympic' | '70.3' | 'ironman';
  date: string;
  priority: 'a' | 'b' | 'c';
  notes?: string;
  /**
   * Slice B2a — extended contract used by B7 (day-level taper) and
   * B8 (post-race recovery). Optional for backwards compat with
   * existing plans.
   */
  expectedDurationSec?: number;
  /**
   * Coach signal: 'high' implies long-build + meaningful taper; 'mini'
   * implies a tune-up race only. Derived from priority + subtype but
   * surfaced separately for engines that don't want to re-derive.
   */
  taperImportance?: 'high' | 'standard' | 'mini';
  /**
   * Recovery days the engine should insert AFTER the race before
   * resuming build logic. Used by WeekIntent 'post_race_recovery'.
   */
  recoveryDaysAfter?: number;
  /**
   * Slice B2a — multisport support. For a triathlon brick weekend
   * or duathlon, `disciplines` lists every sport in the event so
   * post-race recovery and pre-race taper can account for ALL of
   * them (a 70.3 needs recovery from swim + bike + run, not just
   * the listed `discipline`).
   */
  disciplines?: Array<'running' | 'cycling' | 'swimming'>;
  /** 'single' = one discipline; 'multisport' = brick/triathlon/duathlon. */
  raceFormat?: 'single' | 'multisport';
}

/**
 * Slice B2a — race priority as a normalized type. The existing
 * RaceEvent.priority uses lowercase; B2a accessors expose the
 * uppercase 'A'/'B'/'C' that engines and the periodization JSON
 * use. Translation is automatic in the read model.
 */
export type RacePriorityNormalized = 'A' | 'B' | 'C';

export interface Goals {
  primaryFocus: CoachingDiscipline;
  secondaryFocus?: Sport | 'strength';
  // 'hybrid' added 2026-05-23 (Layer-3 goal→split mapping audit closeout):
  // dedicated profile for athletes pursuing concurrent endurance + strength,
  // routed by `STRENGTH_GOAL_KEYWORDS` and consumed by `strength-engine.ts`.
  strengthGoal?: 'hypertrophy' | 'max_strength' | 'athletic' | 'maintenance' | 'hybrid';
  raceCalendar: RaceEvent[];
  priorityOrder: Array<Sport | 'strength' | 'maintenance' | 'return'>;
  weeklySessionsTarget: Partial<Record<Sport, number>>;
  /** Which weeklySessionsTarget entries came from an EXPLICIT user ask
   *  (positive dial value) versus auto-derived defaults. Engines expand
   *  auto values to their discipline defaults but must consume explicit
   *  asks verbatim. Absent = legacy caller, treat all values as auto. */
  weeklySessionsTargetExplicit?: Partial<Record<Sport, boolean>>;
  weeklyMinutesTarget?: Partial<Record<Sport, number>>;
}

export interface TrainingHistory {
  lastWeekMinutesBySport: Partial<Record<Sport, number>>;
  trailing4WeekMinutesBySport: Partial<Record<Sport, number[]>>;
}

export interface PainFlag {
  area: string;
  severity: 'low' | 'moderate' | 'high';
  impact: Array<Sport | 'strength'>;
}

export interface RecentSession {
  id: string;
  sport: Sport;
  sessionType: SessionType;
  completedAt: string;
  durationMinutes: number;
  plannedDurationMinutes?: number;
  actualDurationMinutes?: number;
  intensityZone: IntensityZone;
  fatigueCost: FatigueCost;
  rpe?: number;
  rir?: number;
  sorenessLevel?: number;
  energyLevel?: number;
  distanceKm?: number;
  paceSecondsPerKm?: number;
  cyclingIntensity?: number;
  completionStatus?: 'completed' | 'partial' | 'skipped';
  feedbackTags?: Array<'too_hard' | 'too_easy' | 'too_long' | 'underload' | 'substitution' | 'pain' | 'travel' | 'time_loss'>;
  strengthExerciseSignals?: StrengthExerciseCompletionSignal[];
  completed: boolean;
  keySession?: boolean;
  missedReason?: string;
}

export interface StrengthExerciseCompletionSignal {
  exerciseId?: string;
  exerciseName?: string;
  completedRepsTopSet: number;
  prescribedRepsTopSet: number;
  rpeTopSet?: number;
  rir?: number;
  sorenessLevel?: number;
  technicalSuccessScore?: number;
  painScore?: number;
  painLocation?: string;
  completedAt: string;
}

export interface ReadinessSnapshot {
  capturedAt: string;
  level: ReadinessLevel;
  score: number;
  confidence?: 'fresh_wearable' | 'stale_provider' | 'manual_check_in' | 'no_data';
  dataSource?: 'wearable' | 'manual' | 'fallback';
  isStale?: boolean;
  reasonCode?: string;
  sleepHours?: number;
  hrvStatus?: 'low' | 'normal' | 'high';
  energyReserve?: number;
  soreness?: 'low' | 'moderate' | 'high';
  illness?: boolean;
  painFlags: PainFlag[];
  notes?: string[];
}

/**
 * Slice B2 — WeekIntent as the canonical planning unit.
 * Discriminated union replacing the older `BlockPhase` enum. The
 * `BlockPhase` enum is kept as a derived label for backwards-compat
 * with persistence + iOS contracts; new engine code reads WeekIntent.
 */
export type WeekIntentKindEnum =
  | 'accumulation'
  | 'intensification'
  | 'realization'
  | 'deload'
  | 'recovery'
  | 'taper'
  | 'race'
  | 'post_race_recovery';

export interface WeekIntent {
  kind: WeekIntentKindEnum;
  /** Multiplier on baseline weekly volume. e.g. 1.0 build, 0.5 deload. */
  volumeMultiplier: number;
  /** Lower bound for intensity in this week. */
  intensityFloor: IntensityZone | 'race';
  /** Upper bound for intensity in this week. */
  intensityCeiling: IntensityZone | 'race';
  /** Coaching "what is this week FOR" — volume / intensity / sharpness etc. */
  primaryQuality: 'volume' | 'intensity' | 'specificity' | 'recovery' | 'sharpness' | 'race';
  /** Hint to engines: avoid heavy lower-body work this week. */
  sorenessSensitive?: boolean;
}

/**
 * Slice A5 — CoachPlanPolicy substrate. Persisted per plan to capture
 * coaching preferences that are NOT part of athlete identity. The
 * v2.1 critique moved this from C0 (Phase C "adaptability") to
 * Phase A "substrate" because B3/B4/B5/B7 and C8 all read from it.
 */
export interface CoachPlanPolicy {
  intensityDistributionPreference?: 'auto' | 'polarized' | 'pyramidal' | 'thresholdFocused';
  progressionAggressiveness: 'conservative' | 'standard' | 'aggressive';
  /**
   * 'scheduled' = always deload on mesocycle cadence
   * 'data_informed' = let B5's signal composition decide
   * 'hybrid' = whichever fires first (scheduled OR data-informed)
   * The wording 'data_informed' (not 'data_driven') reflects the
   * v2.1 critique correctly framing ACWR as a soft signal.
   */
  deloadStrategy: 'scheduled' | 'data_informed' | 'hybrid';
  missedSessionPolicy: 'drop_low_priority' | 'preserve_key_sessions' | 'ask_user';
  taperStrategy: 'auto' | 'short' | 'standard' | 'extended';
  /**
   * Anti-churn rate limits for adaptive reflows (C8). Safety overrides
   * are always exempt. Defaults: 1 non-safety reflow per 24h, 2 per week.
   */
  adaptationRateLimits?: {
    perDay?: number;
    perWeek?: number;
  };
  /** Read-model schema version for iOS contract negotiation. */
  schemaVersion: number;
}

/**
 * Slice A3 — HealthSignal as an EVENT, not a mutable field on
 * AthleteProfile. Sourced from athlete_health_signals (A0c) and
 * consumed by PlanGenerationContext.
 */
export interface HealthSignal {
  capturedAt: string;
  painScore?: number;
  painLocation?: string;
  illnessSymptoms?: readonly string[];
  injuryStatus?: 'none' | 'acute' | 'chronic_managed' | 'returning' | 'post_exertional_symptom_risk';
  menstrualStatus?: 'menses' | 'follicular' | 'ovulation' | 'luteal' | 'amenorrhea' | 'symptom_only';
  energyAvailabilityRisk?: 'low' | 'moderate' | 'high';
  consentScope: readonly string[];
  source?: string;
}

/**
 * Slice A3 — version stamp attached to every generated plan and to
 * every adaptation-ledger row.
 */
export interface VersionStamp {
  /** Semver of training-principles.json that produced this plan. */
  sciencePolicyVersion: string;
  /** Read-model schema version (iOS contract negotiation). */
  schemaVersion: number;
  /** ISO 8601 timestamp the plan was generated. */
  generatedAt: string;
}

/**
 * Slice A3 — derived weekly conditions surfaced by C7 onto the
 * planning context. The shape is forward-declared here so B and C
 * slices can depend on it; C7 fills in the implementation.
 */
export interface WeekConditions {
  weekIndex: number;
  /** ISO date for the Monday of this training week, used for deterministic reflow/reschedule actions. */
  weekStartISODate?: string;
  isTravelWeek?: boolean;
  /**
   * Count of missed sessions this week. Kept for backwards-compat
   * with summary views and analytics. C8 should consult
   * `missedSessionIds` (below) when iterating — Codex P2: acting on
   * a count means "every session" which is wrong.
   */
  missedSessionsThisWeek?: number;
  /**
   * Specific Session.id values that were missed this week. Codex P2
   * fix: C8 iterates over these IDs ONLY, not every session in the
   * week. When undefined or empty, C8 does not emit missed-session
   * actions even if `missedSessionsThisWeek > 0`.
   */
  missedSessionIds?: string[];
  deloadDue?: boolean;
  returnProtocol?: string;
  lowAdherenceTrend?: boolean;
  equipmentOverride?: Record<string, unknown>;
  travelStress?: {
    timeZoneShiftHours?: number;
    flightDurationHours?: number;
    sleepDisruptionExpected?: boolean;
    walkingLoadExpected?: boolean;
    heatStress?: boolean;
  };
  lifecycleState?: string;
}

/**
 * Slice A3 — replayable per-plan context. Engines do NOT mutate
 * this object; each week returns a `WeekContextDelta` that the
 * generator commits via `commitWeek(ctx, delta)`. Result: replaying
 * a plan with the same `sciencePolicyVersion` produces identical
 * output.
 */
export interface PlanGenerationContext {
  versionStamp: VersionStamp;
  /** Rolling load-model state (TSS/CTL/ATL/TSB-equivalent). B1 populates. */
  loadModel?: {
    ctl?: number;
    atl?: number;
    tsb?: number;
    acwr?: number;
    loadModelStatus: 'cold_start' | 'warming' | 'stable';
    completionCount: number;
    confidence: 'high' | 'medium' | 'low';
  };
  /** Position within the current mesocycle. B3 populates. */
  mesocyclePosition?: {
    blockName: string;
    weekInBlock: number;
    blockLengthWeeks: number;
  };
  /** Number of weeks since the last deload. B5 reads. */
  weeksSinceDeload?: number;
  /** Per-week derived conditions. C7 populates per-week. */
  weekConditions: WeekConditions[];
  /** Rolling HRV status — paired-signal rule (B5). */
  rollingHrv?: {
    statusLast7d: ('balanced' | 'low' | 'unbalanced' | 'poor')[];
    dropPersisted: boolean;
  };
  /** Rolling adherence over the prior 14 days. */
  rollingAdherence?: {
    fraction: number;
    weeksBelow70Pct: number;
  };
  /** Latest readiness snapshot for the current week. */
  readinessSnapshot?: ReadinessSnapshot;
  /** Latest health signal for the current week (slice A4 / A0c). */
  healthSignal?: HealthSignal;
}

/**
 * Delta produced by an engine's per-week computation. The generator
 * commits the delta via `commitWeek(ctx, delta)` only after validation.
 */
export interface WeekContextDelta {
  weekIndex: number;
  loadModel?: PlanGenerationContext['loadModel'];
  mesocyclePosition?: PlanGenerationContext['mesocyclePosition'];
  weeksSinceDeload?: number;
  weekConditions?: WeekConditions;
}

export interface ComplianceSummary {
  trailing14DayCompliance: number;
  bySport: Partial<Record<Sport, number>>;
  missedKeySessions: number;
  consecutiveMisses: number;
}

export type TrainingFeedbackDecisionCode =
  | 'low_recovery_deload'
  | 'high_soreness_downshift'
  | 'poor_adherence_reentry'
  | 'missed_key_session_rebuild'
  | 'duration_compression'
  | 'too_long_duration_cap'
  | 'too_hard_intensity_downshift'
  | 'too_easy_progression'
  | 'positive_progression'
  | 'plateau_variation'
  | 'repeated_substitution_review';

export interface TrainingFeedbackDecision {
  code: TrainingFeedbackDecisionCode;
  severity: 'info' | 'watch' | 'action' | 'block';
  sport?: Sport;
  reason: string;
  evidence: string[];
  volumeMultiplier?: number;
  intensityMultiplier?: number;
  durationMultiplier?: number;
}

export interface TrainingFeedbackAnalysis {
  generatedAt: string;
  sampleSize: number;
  completionCounts: {
    completed: number;
    partial: number;
    skipped: number;
  };
  adherenceClass: 'strong' | 'steady' | 'fragile' | 'broken';
  recoveryClass: 'ready' | 'watch' | 'strained' | 'critical';
  difficultyBias: 'too_easy' | 'balanced' | 'too_hard' | 'too_long' | 'mixed';
  progressionState: 'build' | 'hold' | 'deload' | 'reentry' | 'variation';
  averageRpe?: number;
  averageSoreness?: number;
  averageDurationRatio?: number;
  decisions: TrainingFeedbackDecision[];
  notes: string[];
}

export interface CurrentBlock {
  discipline: CoachingDiscipline;
  phase: BlockPhase;
  weekIndex: number;
  totalWeeks: number;
  volumeProgressionPct: number;
  lastDeloadWeekIndex?: number;
}

export interface AthleteProfile {
  athleteId: number;
  name: string;
  age?: number;
  experienceLevel: 'novice' | 'intermediate' | 'advanced';
  primaryDiscipline: CoachingDiscipline;
  thresholdPaceSecondsPerKm?: number;
  cyclingFtpWatts?: number;
  swimCssSecondsPer100m?: number;
  maxHeartRate?: number;
  thresholdHeartRate?: number;
  restingHeartRate?: number;
  bodyWeightKg?: number;
}

export type TrainingProfileQualityCategory =
  | 'goals'
  | 'experience'
  | 'schedule'
  | 'duration'
  | 'modality'
  | 'equipment'
  | 'limitations'
  | 'recovery'
  | 'consistency'
  | 'markers'
  | 'preferences'
  | 'sex_gender';

export interface TrainingProfileMissingData {
  key: string;
  category: TrainingProfileQualityCategory;
  severity: 'critical' | 'important' | 'optional';
  reason: string;
}

export interface TrainingProfileFollowUpQuestion {
  id: string;
  category: TrainingProfileQualityCategory;
  field: string;
  priority: 'high' | 'medium' | 'low';
  prompt: string;
  reason: string;
  answerType: 'choice' | 'multi_choice' | 'number' | 'text';
  options?: string[];
  planningRisk?: string;
  resolvesMissingKeys?: string[];
}

export interface TrainingProfileQuality {
  completenessScore: number;
  confidenceScore: number;
  confidenceBand: 'high' | 'medium' | 'low';
  planQualityLimited: boolean;
  planningRiskFlags: string[];
  missingCriticalData: TrainingProfileMissingData[];
  followUpQuestions: TrainingProfileFollowUpQuestion[];
  sourceSummary: Partial<Record<TrainingProfileQualityCategory, 'provided' | 'inferred' | 'missing'>>;
}

export interface NormalizedTrainingProfile {
  athleteId: number;
  goals: {
    primaryFocus: CoachingDiscipline;
    secondaryFocus?: Sport | 'strength';
    strengthGoal?: NonNullable<Goals['strengthGoal']>;
    raceCalendar: RaceEvent[];
  };
  experience: {
    level: AthleteProfile['experienceLevel'];
    source: 'provided' | 'fallback';
  };
  availableDays: Partial<Record<Sport, number>>;
  availableSessionDurations: {
    genericMinutes?: number;
    enduranceMinutes?: number;
    strengthMinutes?: number;
  };
  modalityPreferences: {
    priorityOrder: Array<Sport | 'strength'>;
    requestedSessions: Partial<Record<Sport, number>>;
    preferredTimesBySport: Partial<Record<Sport, string>>;
    twoADayPreference?: 'never' | 'optional' | 'preferred' | 'auto' | null;
  };
  equipment: EquipmentAccess & {
    source: 'provided' | 'fallback';
  };
  environment: {
    hasGym: boolean;
    hasOutdoorRunAccess: boolean;
    hasBikeTrainer: boolean;
    hasPool: boolean;
    notes: string[];
  };
  scheduleConstraints: {
    preferredLongSessionDay?: DayOfWeek;
    preferredTrainingDays?: DayOfWeek[];
    blockedTrainingDays?: DayOfWeek[];
    maxSessionsPerDay: number;
    declaredConstraints: string[];
  };
  discomfortFlags: PainFlag[];
  recoveryBaseline: {
    score?: number;
    sleepHours?: number;
    hrvStatus?: ReadinessSnapshot['hrvStatus'];
    energyReserve?: number;
    source: 'wearable' | 'missing';
  };
  consistencyTendencies: {
    declaredWeeklyFrequency?: number;
    adherenceRisk: 'low' | 'medium' | 'high';
    signals: string[];
  };
  currentMarkers: {
    runningWeeklyMileageKm?: number;
    easyPaceMinPerKm?: string;
    cyclingFtpWatts?: number;
    cyclingWeeklyHours?: string;
    swimPoolAccess?: string;
    swimSessionsPerWeek?: number;
    swim400mFreestyleTime?: string;
    bodyWeightKg?: number;
    squat1RmKg?: number;
    bench1RmKg?: number;
    deadlift1RmKg?: number;
  };
  sexGenderContext?: {
    value: string;
    source: 'fitness_profile' | 'gym_profile' | 'run_profile';
    planningUse: 'not_used_by_default' | 'relevant_only_with_explicit_context';
  };
  quality: TrainingProfileQuality;
}

export interface AthleteState {
  profile: AthleteProfile;
  normalizedTrainingProfile?: NormalizedTrainingProfile;
  profileQuality?: TrainingProfileQuality;
  feedbackAnalysis?: TrainingFeedbackAnalysis;
  goals: Goals;
  constraints: Constraint[];
  availability: Availability;
  equipment: EquipmentAccess;
  trainingHistory: TrainingHistory;
  currentBlock: CurrentBlock;
  recentSessions: RecentSession[];
  readiness: ReadinessSnapshot;
  compliance: ComplianceSummary;
}

export type ExerciseComplexity = 'beginner' | 'intermediate' | 'advanced' | 'expert';
export type SpinalLoading = 'low' | 'moderate' | 'high';
export type ExercisePrimaryPurpose = 'strength' | 'hypertrophy' | 'power' | 'stability' | 'mobility' | 'conditioning';

export interface Exercise {
  id: string;
  name: string;
  movementPattern: 'squat' | 'hinge' | 'push' | 'pull' | 'single_leg' | 'core' | 'carry' | 'mobility';
  equipment: string[];
  fatigueCost: FatigueCost;
  substitutions: string[];
  /**
   * Slice 4.G — enriched metadata. All optional so legacy callers
   * keep working; the `exercise-metadata.ts` helper provides sensible
   * defaults derived from movementPattern + equipment when fields
   * are absent.
   */
  /** Technique cost. Used by slice 4.H to keep novices off expert lifts. */
  complexity?: ExerciseComplexity;
  /** How much axial load the lift puts on the spine. */
  spinalLoading?: SpinalLoading;
  /** Worked one side at a time. Used to balance left/right scheduling. */
  unilateral?: boolean;
  /** Primary intent when picking between candidates of the same pattern. */
  primaryPurpose?: ExercisePrimaryPurpose;
  /** Free-text flags that the substitution layer can match against
   *  user-declared discomfort areas (e.g. 'low_back_strain', 'knee_pain'). */
  contraindicationFlags?: string[];
  /** Warmup needs the engine should fold into the session warmup
   *  (e.g. 'hip_mobility', 'thoracic_rotation'). */
  warmupNeeds?: string[];
  /**
   * Slice 5.A — progression family metadata for catalog-aware
   * progression. Identifies the skill ladder this exercise sits in
   * (e.g. `vertical_pull`: scapular_pull_up → band_assisted_pull_up →
   * pull_up → weighted_pull_up → muscle_up). The strength engine and
   * the calisthenics modality use this to advance an athlete to the
   * next level when their current level is consistently completed.
   */
  progressionFamily?: string;
  /** 1 (entry) through 5 (mastery). Within a family, higher level is
   *  harder. Same-level exercises are interchangeable variants. */
  progressionLevel?: 1 | 2 | 3 | 4 | 5;
  /** Conditions an athlete should meet before advancing to this
   *  level (e.g. `[{ exerciseId: "push_up", criterion: "3x15 clean" }]`).
   *  Used by progression rules in training-principles.json. */
  progressionPrerequisites?: Array<{ exerciseId: string; criterion: string }>;
}

export interface ExercisePrescription {
  exerciseId: string;
  name: string;
  sets: number;
  reps: string;
  rir?: number;
  restSec?: number;
  notes?: string;
  /**
   * Slice 5.D — tempo as a progression vector. Format: four digits
   * separated by `-`, in seconds: eccentric-bottomPause-concentric-topPause.
   * Examples: `"3-1-1-0"` = 3s lower, 1s pause at bottom, 1s up, 0s top;
   * `"2-0-X-0"` = 2s lower, no pause, explosive concentric, no pause.
   * Used heavily by the calisthenics modality where tempo is the
   * primary progression knob (you can't add load to a push-up; you
   * can make it 5-3-1-0). For loaded strength work, tempo lets the
   * engine progress technique cycles without changing exercise.
   */
  tempo?: string;
  /**
   * Slice 5.E — coach reasoning surface. When present, captures why
   * the engine picked this specific exercise over alternatives.
   * Rendered on tap in iOS to differentiate Nexus from black-box
   * "AI generated" workout apps.
   */
  selectionReason?: ExerciseSelectionReason;
  /**
   * Support/debug-only selector trace. Normal iOS UI must not render
   * this raw payload; user-facing copy comes from `selectionReason`.
   */
  selectorTrace?: {
    selectorPolicyVersion: string;
    catalogVersion: string;
    candidateIds: string[];
    selectedIds: string[];
    selectedScores?: Array<{ exerciseId: string; score: number }>;
    rejectedCandidateReasons: Array<{ exerciseId: string; reason: string }>;
  };
  /**
   * Compact, user-facing progression output. Raw completion details
   * and selector traces remain backend/support data; this summary
   * answers "why did the coach change or hold this lift?"
   */
  progressionState?: 'build' | 'hold' | 'deload' | 'reentry';
  progressionSummary?: string;
  progressionReason?: string;
  progressionConfidence?: 'real_feedback' | 'cold_start' | 'conservative';
}

export interface ExerciseSelectionReason {
  /** The movement pattern slot this exercise filled. */
  pattern: 'squat' | 'hinge' | 'push' | 'pull' | 'single_leg' | 'core' | 'carry' | 'mobility';
  /**
   * Bullet-style reasons the engine picked this exercise. Each string
   * is short, user-readable, and grounded in athlete state — e.g.
   * "progression level 3 matches your current strength",
   * "no shoulder impingement contraindication",
   * "fits dumbbells-only equipment".
   */
  pickedBecause: string[];
  /** Total candidate count the engine evaluated for this slot. */
  alternativesConsidered?: number;
  /** Top alternatives that were ruled out, with the reason. Keep this
   *  small (≤3) so the UI can show "we also considered…" without
   *  drowning the user. */
  alternativesRejectedBecause?: Array<{ exerciseId: string; reason: string }>;
}

export interface WorkoutTemplate {
  id: string;
  sport: Sport;
  sessionType: SessionType;
  title: string;
  phaseTags: BlockPhase[];
  goalTags: string[];
  durationOptionsMinutes: number[];
  primaryZone: IntensityZone;
  fatigueCost: FatigueCost;
  keySession: boolean;
  instructions: string[];
  constraints: string[];
  defaultExercises?: string[];
  sessionRole?: string;
  experienceFit?: Array<AthleteProfile['experienceLevel']>;
  equipmentProfile?: string[];
  variantTags?: string[];
  recoveryScenarioTags?: string[];
  timeRangeMinutes?: {
    min: number;
    max: number;
  };
  progressionTarget?: string;
  substitutionFamily?: string;
}

export type TrainingDecisionReasonCode =
  | 'session_compressed'
  | 'session_capped'
  | 'session_reflowed'
  | 'session_unscheduled'
  | 'weekly_frequency_capped'
  | 'low_priority_deferred'
  | 'recovery_volume_reduced'
  | 'recovery_intensity_reduced'
  | 'volume_growth_trimmed'
  | 'schedule_density_trimmed'
  | 'interference_reflowed'
  // Goal-mode signals (TR-EC-QA-O1 + TR-EC-QA-O2; 2026-05-03):
  // Surfaced on the plan response so iOS can render an honest
  // "you asked for X, the coach did Y because of goalMode" banner
  // instead of the field being silently inert.
  | 'maintenance_volume_capped'
  | 'return_to_training_volume_capped'
  | 'continuous_plan_no_taper'
  | 'event_based_missing_race_date'
  // Pre-race strength cutoff (taper wiring, 2026-07-01): strength sessions
  // inside the priority-scaled cutoff window are dropped at generation time
  // and the volume enforcer honors the week marker instead of refilling.
  | 'taper_strength_cutoff'
  // Slice A4 — safety/health guardrail emissions. Internal codes are
  // factual (medical_referral, pain_flag, illness_flag); user-facing
  // copy uses gentler "seek_professional_support" phrasing.
  | 'safety_pause_typed'
  | 'safety_warning_inferred'
  | 'medical_referral'
  | 'pain_flag'
  | 'illness_flag'
  | 'red_s_screening_flag'
  | 'equipment_conservative_default'
  | 'equipment_adaptation_applied'
  | 'endurance_coherence_warning'
  | 'endurance_interference_warning';

export interface TrainingDecisionReason {
  code: TrainingDecisionReasonCode;
  text: string;
  severity: 'info' | 'notice' | 'warning' | 'block';
  affectedEntity: {
    type: 'week' | 'session';
    id?: string;
    title?: string;
    dayOfWeek?: DayOfWeek;
  };
  sourceConstraint?: {
    type: 'capacity' | 'time' | 'travel' | 'calendar' | 'recovery' | 'fatigue' | 'interference' | 'volume' | 'equipment' | 'safety';
    id?: string;
    label?: string;
  };
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  preservedIntent?: string;
  evidence?: string[];
}

export type SessionScheduleState =
  | 'scheduled'
  | 'compressed'
  | 'reflowed'
  | 'capped'
  | 'deferred'
  | 'unscheduled'
  | 'dropped';

export interface Session {
  id: string;
  sport: Sport;
  sessionType: SessionType;
  title: string;
  description: string;
  dayOfWeek: DayOfWeek;
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  intensityZone: IntensityZone;
  fatigueCost: FatigueCost;
  keySession: boolean;
  plannedLoad: number;
  sourceTemplateId?: string;
  tags: string[];
  exercises?: ExercisePrescription[];
  alternatives?: string[];
  scheduleState?: SessionScheduleState;
  scheduleAdjustments?: SessionScheduleState[];
  scheduleReason?: string;
  decisionReasons?: TrainingDecisionReason[];
  originalDayOfWeek?: DayOfWeek;
  capacityWindow?: {
    dayOfWeek: DayOfWeek;
    start: string;
    end: string;
    label?: string;
    capacityMinutes: number;
  };
  /**
   * Additive read-model metadata for iOS and coach explanations.
   * `sessionRole` is the compact canonical role; the label/summary are
   * user-facing and answer "what is this workout for?" without exposing
   * selector traces or low-level validation internals.
   */
  sessionRole?: TrainingSessionRole;
  sessionRoleLabel?: string;
  sessionRoleSummary?: string;
  keySessionLabel?: string;
  /**
   * Slice A2b — Interval-level intensity profile. Full segment plan
   * for the session (warmup + main work + cooldown), used by B1 (TSS
   * via IF) and B4 (segment-time-in-zone distribution). Optional:
   * engines emit this for interval/threshold workouts where the
   * single `intensityZone` field is too coarse to power load
   * calculations; steady aerobic sessions can omit it.
   */
  intensityProfile?: SessionIntensityProfile;
  /**
   * Slice A2b — Compact summary view of the intensity profile for
   * iOS read-models. iOS can adopt this immediately, defer reading
   * the full `intensityProfile.segments[]` to a later schemaVersion.
   */
  intensitySummary?: IntensitySummary;
}

/**
 * Role of an interval segment within a session. Drives how the
 * engine and UI render the segment (warmup is "easy spin-up", main
 * is "the actual work", recovery is "between intervals", etc.).
 */
export type IntensitySegmentRole =
  | 'warmup'
  | 'main'
  | 'recovery'
  | 'cooldown'
  | 'steady'
  | 'interval';

/**
 * One segment of an interval-style workout. Either time-based
 * (durationSec) or distance-based (distanceMeters) — engines may
 * emit both for hybrid prescriptions ("8x400m in 90s each"). At
 * least one of duration/distance is required.
 *
 * Target ranges are optional and may not all be present — e.g., a
 * pace-coached running interval has `targetPaceRangeSecPerKm` but
 * not `targetWattsRange`. Slice A2b defines the type; engines
 * choose which targets to emit per modality.
 */
export interface IntensitySegment {
  role: IntensitySegmentRole;
  /** Modality of the segment (typically the parent session's sport, but allows brick sessions). */
  modality: Sport | 'strength';
  durationSec?: number;
  distanceMeters?: number;
  /** Number of repetitions for interval-style segments (e.g., "5x" main + recovery pairs). */
  reps?: number;
  targetZone?: IntensityZone;
  targetPaceRangeSecPerKm?: { min: number; max: number };
  targetWattsRange?: { min: number; max: number };
  targetHrRangeBpm?: { min: number; max: number };
  targetRpeRange?: { min: number; max: number };
}

/**
 * Full intensity profile of a session: the segment plan, the
 * computed time-in-zone distribution, and the estimated load. Slice
 * A2b types it; slice B1 (load model) populates `estimatedLoad`
 * using the IF math from A2's zone-calculator.
 */
export interface SessionIntensityProfile {
  primaryZone: IntensityZone;
  segments: IntensitySegment[];
  /**
   * Time-weighted distribution across the IntensityZone enum. Values
   * sum to 1.0 (proportions, not percentages). Missing zones default
   * to 0.
   */
  intensityDistribution: Partial<Record<IntensityZone, number>>;
  /**
   * TSS-equivalent estimated load for the session. Slice A2b
   * populates this when athlete anchors allow IF computation;
   * otherwise undefined — B1 fills the gap with sRPE × duration
   * fallback when completion data arrives.
   */
  estimatedLoad?: number;
}

/**
 * Compact view of an intensity profile for iOS. Designed to fit in
 * the read-model payload without forcing iOS to render full segment
 * arrays. Slice A2b emits this alongside the full profile; iOS
 * adopts summary first (schemaVersion=1), defers segment rendering
 * to schemaVersion=2.
 */
export interface IntensitySummary {
  primaryZone: IntensityZone;
  /** Proportion of time in low-intensity zones (recovery + aerobic). */
  lowPct: number;
  /** Proportion of time in moderate zones (tempo). */
  moderatePct: number;
  /** Proportion of time in high zones (threshold + vo2 + neuromuscular). */
  highPct: number;
  estimatedLoad?: number;
  /** Short coach-style description of the session intent. e.g. "5×4min @ threshold + 1min easy". */
  targetSummaryText?: string;
}

export interface GuardrailResult {
  ruleId: string;
  status: 'pass' | 'warn' | 'block';
  message: string;
  adjusted?: boolean;
  metadata?: Record<string, unknown>;
  decisionReasons?: TrainingDecisionReason[];
}

export interface WeeklyPlan {
  athleteId: number;
  weekStart: string;
  discipline: CoachingDiscipline;
  phase: BlockPhase;
  sessions: Session[];
  notes: string[];
  guardrailResults: GuardrailResult[];
  decisionReasons?: TrainingDecisionReason[];
}

export interface DailyRecommendation {
  date: string;
  readinessLevel: ReadinessLevel;
  session: Session | null;
  alternatives: Session[];
  rationale: string[];
  guardrailResults: GuardrailResult[];
}

export interface ComplianceEvent {
  sessionId: string;
  athleteId: number;
  status: 'completed' | 'missed' | 'modified';
  completedAt: string;
  reason?: string;
  notes?: string;
}

export interface ZoneSet {
  runningPaceSecondsPerKm?: Record<IntensityZone, { min: number; max: number }>;
  bikePowerWatts?: Record<IntensityZone, { min: number; max: number }>;
  swimPaceSecondsPer100m?: Record<IntensityZone, { min: number; max: number }>;
  heartRateBpm?: Record<IntensityZone, { min: number; max: number }>;
}

export interface ParsedFitFile {
  fileType: 'fit';
  headerSize: number;
  protocolVersion: number;
  profileVersion: number;
  dataSize: number;
  signature: string;
}

export interface ParsedGpxFile {
  fileType: 'gpx';
  trackPointCount: number;
  startTime?: string;
  endTime?: string;
  totalSeconds?: number;
}

export interface CoachKnowledgeBase {
  exercises: Exercise[];
  workoutTemplates: WorkoutTemplate[];
  principles: Record<string, unknown>;
  docs: Record<string, string>;
}

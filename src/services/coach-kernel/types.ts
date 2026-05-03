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
}

export interface Goals {
  primaryFocus: CoachingDiscipline;
  secondaryFocus?: Sport | 'strength';
  strengthGoal?: 'hypertrophy' | 'max_strength' | 'athletic' | 'maintenance';
  raceCalendar: RaceEvent[];
  priorityOrder: Array<Sport | 'strength'>;
  weeklySessionsTarget: Partial<Record<Sport, number>>;
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
  completed: boolean;
  keySession?: boolean;
  missedReason?: string;
}

export interface ReadinessSnapshot {
  capturedAt: string;
  level: ReadinessLevel;
  score: number;
  sleepHours?: number;
  hrvStatus?: 'low' | 'normal' | 'high';
  energyReserve?: number;
  soreness?: 'low' | 'moderate' | 'high';
  illness?: boolean;
  painFlags: PainFlag[];
  notes?: string[];
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
    twoADayPreference?: 'never' | 'optional' | 'preferred' | null;
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
  | 'interference_reflowed';

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
    type: 'capacity' | 'time' | 'travel' | 'calendar' | 'recovery' | 'fatigue' | 'interference' | 'volume' | 'equipment';
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

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
  intensityZone: IntensityZone;
  fatigueCost: FatigueCost;
  rpe?: number;
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

export interface AthleteState {
  profile: AthleteProfile;
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

export interface Exercise {
  id: string;
  name: string;
  movementPattern: 'squat' | 'hinge' | 'push' | 'pull' | 'single_leg' | 'core' | 'carry' | 'mobility';
  equipment: string[];
  fatigueCost: FatigueCost;
  substitutions: string[];
}

export interface ExercisePrescription {
  exerciseId: string;
  name: string;
  sets: number;
  reps: string;
  rir?: number;
  notes?: string;
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
}

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
}

export interface GuardrailResult {
  ruleId: string;
  status: 'pass' | 'warn' | 'block';
  message: string;
  adjusted?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WeeklyPlan {
  athleteId: number;
  weekStart: string;
  discipline: CoachingDiscipline;
  phase: BlockPhase;
  sessions: Session[];
  notes: string[];
  guardrailResults: GuardrailResult[];
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


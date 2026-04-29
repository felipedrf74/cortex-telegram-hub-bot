// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { AthleteState, Session, WeeklyPlan } from '../types';

export type TrainingEvalDimension =
  | 'profile_fit'
  | 'plan_coherence'
  | 'weekly_structure_quality'
  | 'session_role_differentiation'
  | 'variety_quality'
  | 'time_volume_coherence'
  | 'modality_quality'
  | 'progression_quality'
  | 'adaptability_quality'
  | 'substitution_quality'
  | 'biomechanics_quality'
  | 'adherence_realism'
  | 'explainability'
  | 'agenda_lifecycle_correctness'
  | 'warning_quality_deduplication';

export type TrainingEvalScenarioCategory =
  | 'baseline'
  | 'adaptation'
  | 'calendar_lifecycle'
  | 'feedback'
  | 'profile_completeness'
  | 'schedule'
  | 'safety'
  | 'travel';

export interface TrainingEvalPersonaExpectations {
  expectedSports: Array<Session['sport']>;
  primarySport?: Session['sport'];
  minTotalSessions?: number;
  maxTotalSessions?: number;
  minStrengthSessions?: number;
  maxStrengthSessions?: number;
  minRunningSessions?: number;
  maxRunningSessions?: number;
  minCyclingSessions?: number;
  maxCyclingSessions?: number;
  maxSessionsPerDay?: number;
  requiredEquipmentAvoidance?: string[];
  shouldAvoidPainAreas?: string[];
  explicitSexGenderContext?: boolean;
}

export interface TrainingEvalPersona {
  id: string;
  name: string;
  category: string;
  description: string;
  athlete: AthleteState;
  expectations: TrainingEvalPersonaExpectations;
  tags: string[];
  notes?: string[];
}

export interface TrainingEvalScenarioContext {
  persona: TrainingEvalPersona;
  baseWeekStart: string;
}

export interface TrainingEvalScenarioExpectations {
  maxTotalSessions?: number;
  maxSessionsPerDay?: number;
  requiredPhase?: WeeklyPlan['phase'];
  shouldReduceLoad?: boolean;
  shouldRespectShortWindows?: boolean;
  shouldUseHotelGym?: boolean;
  shouldShowFuelingGuidance?: boolean;
  shouldSurfaceProfileGap?: boolean;
  shouldAvoidPainAreas?: string[];
  compareWithNextVersion?: boolean;
}

export interface TrainingEvalScenario {
  id: string;
  name: string;
  category: TrainingEvalScenarioCategory;
  description: string;
  tags: string[];
  apply: (context: TrainingEvalScenarioContext) => AthleteState;
  expectations?: TrainingEvalScenarioExpectations;
}

export interface TrainingEvalCase {
  id: string;
  persona: TrainingEvalPersona;
  scenario: TrainingEvalScenario;
  athlete: AthleteState;
  weekStart: string;
}

export interface TrainingEvalDimensionScore {
  dimension: TrainingEvalDimension;
  score: number;
  weight: number;
  observations: string[];
  penalties: string[];
}

export interface TrainingEvalCaseResult {
  caseId: string;
  personaId: string;
  personaName: string;
  scenarioId: string;
  scenarioName: string;
  score: number;
  planSummary: {
    weekStart: string;
    phase: WeeklyPlan['phase'];
    discipline: WeeklyPlan['discipline'];
    totalSessions: number;
    sessionsBySport: Partial<Record<Session['sport'], number>>;
    totalMinutes: number;
    keySessions: number;
  };
  dimensionScores: TrainingEvalDimensionScore[];
  criticalFailures: string[];
}

export interface TrainingEvalAggregate {
  overallScore: number;
  caseCount: number;
  personaCount: number;
  scenarioCount: number;
  dimensionAverages: Record<TrainingEvalDimension, number>;
  lowestCases: Array<Pick<TrainingEvalCaseResult, 'caseId' | 'personaName' | 'scenarioName' | 'score' | 'criticalFailures'>>;
}

export interface TrainingEvalRunResult {
  generatedAt: string;
  weekStart: string;
  engine: {
    packageVersion: string;
    gitCommit?: string;
    gitBranch?: string;
  };
  aggregate: TrainingEvalAggregate;
  cases: TrainingEvalCaseResult[];
}


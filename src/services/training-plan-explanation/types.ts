// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DecisionWhy } from '../decision-center-logic-v2';

export const PLAN_CREATION_EXPLANATION_SCHEMA_VERSION = 1;

export type PlanExplanationCategory =
  | 'primary_focus'
  | 'periodization_phase'
  | 'weekly_volume'
  | 'training_history'
  | 'readiness_baseline'
  | 'equipment_profile'
  | 'experience_level'
  | 'strength_goal'
  | 'goal_mode_volume_cap'
  | 'two_a_day_policy'
  | 'start_policy'
  | 'long_session_day'
  | 'modality_target'
  | 'weekly_frequency'
  | 'schedule_preference'
  | 'data_quality';

export type PlanExplanationSeverity = 'info' | 'notice' | 'warning' | 'block';

export interface PlanExplanationEvidence {
  summary: string;
  matchedKeyword?: string | null;
  rawInputSnippet?: string | null;
  sourceField?: string | null;
  coachRuleIds?: string[];
}

export interface PlanExplanationSmartPick {
  id: string;
  category: PlanExplanationCategory;
  labelKey: string;
  fallbackLabel: string;
  value: string | number | boolean | null;
  source:
    | 'objective_keyword'
    | 'inferred_volume_split'
    | 'profile_data'
    | 'readiness_data'
    | 'training_history'
    | 'goal_mode_rule'
    | 'race_calendar'
    | 'equipment_profile'
    | 'experience_profile'
    | 'strength_profile'
    | 'two_a_day_preference'
    | 'system_inference';
  confidence: number;
  why: DecisionWhy;
  evidence: PlanExplanationEvidence[];
  coachRuleIds: string[];
}

export interface PlanExplanationRespectedConstraint {
  id: string;
  category: PlanExplanationCategory;
  labelKey: string;
  fallbackLabel: string;
  value: string | number | boolean | null;
  source: 'request';
  why: DecisionWhy;
}

export interface PlanExplanationAttentionItem {
  id: string;
  category: PlanExplanationCategory;
  severity: PlanExplanationSeverity;
  labelKey: string;
  fallbackLabel: string;
  why: DecisionWhy;
  evidence: PlanExplanationEvidence[];
  coachRuleIds: string[];
}

export interface PlanCreationExplanationSummary {
  smartPickCount: number;
  respectedConstraintCount: number;
  attentionItemCount: number;
  highestSeverity: PlanExplanationSeverity;
}

export interface PlanCreationExplanation {
  schemaVersion: typeof PLAN_CREATION_EXPLANATION_SCHEMA_VERSION;
  planId?: number | null;
  generatedAt: string;
  locale: string;
  summary: PlanCreationExplanationSummary;
  smartPicks: PlanExplanationSmartPick[];
  respectedConstraints: PlanExplanationRespectedConstraint[];
  attentionItems: PlanExplanationAttentionItem[];
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type TrainingCoachRuleCategory =
  | 'screening_safety'
  | 'strength_progression'
  | 'endurance_periodization'
  | 'hybrid_interference'
  | 'triathlon_balance'
  | 'load_monitoring'
  | 'fueling_scope'
  | 'coach_communication';

export interface TrainingCoachRule {
  id: string;
  category: TrainingCoachRuleCategory;
  appliesTo: Array<'running' | 'cycling' | 'swimming' | 'strength' | 'triathlon' | 'hybrid' | 'all'>;
  sourceAnchors: string[];
  userFacingPrinciple: string;
  implementationSignal: string;
}

export const TRAINING_COACH_RULES: readonly TrainingCoachRule[] = [
  {
    id: 'screening-red-flags-refer-out',
    category: 'screening_safety',
    appliesTo: ['all'],
    sourceAnchors: ['ACSM Guidelines', 'ACSM Preparticipation Screening'],
    userFacingPrinciple: 'Nexus can adapt training conservatively, but possible medical red flags require professional review.',
    implementationSignal: 'Block progression or ask for more information when injury, illness, chest pain, fainting, or unexplained symptoms are present.',
  },
  {
    id: 'strength-progressive-overload-with-deloads',
    category: 'strength_progression',
    appliesTo: ['strength', 'hybrid', 'triathlon'],
    sourceAnchors: ['ACSM Resistance Training', 'NSCA Standards'],
    userFacingPrinciple: 'Strength work should progress by volume, load, complexity, or density, then recover before quality drops.',
    implementationSignal: 'Rotate exercises, cap repeated identical sessions, and use RPE/RIR plus recovery weeks instead of repeating the same template blindly.',
  },
  {
    id: 'endurance-periodization-by-goal-horizon',
    category: 'endurance_periodization',
    appliesTo: ['running', 'cycling', 'swimming', 'triathlon', 'hybrid'],
    sourceAnchors: ['Periodization research', 'TrainingPeaks ATP'],
    userFacingPrinciple: 'Base, build, peak, taper, race, and recovery phases should follow the athlete’s goal horizon, not a fixed four-week label pattern.',
    implementationSignal: 'Use race date and goal mode to choose phase labels; continuous plans use rolling build/recovery cycles and never imply a race taper.',
  },
  {
    id: 'endurance-intensity-distribution',
    category: 'endurance_periodization',
    appliesTo: ['running', 'cycling', 'triathlon'],
    sourceAnchors: ['Seiler intensity distribution', 'VDOT', 'TrainingPeaks zones'],
    userFacingPrinciple: 'Most endurance work should be controlled, with hard sessions placed deliberately and calibrated from known zones or RPE.',
    implementationSignal: 'Prefer RPE when pace/HR/power zones are missing; ask for benchmark data rather than inventing precise paces.',
  },
  {
    id: 'hybrid-interference-protect-key-sessions',
    category: 'hybrid_interference',
    appliesTo: ['hybrid', 'triathlon', 'running'],
    sourceAnchors: ['Concurrent training research', 'Running strength reviews'],
    userFacingPrinciple: 'Heavy lower-body work and key endurance sessions need spacing so one does not blunt the other.',
    implementationSignal: 'Avoid heavy lower before long runs or threshold sessions unless explicitly intentional and explained.',
  },
  {
    id: 'triathlon-balance-and-bricks',
    category: 'triathlon_balance',
    appliesTo: ['triathlon'],
    sourceAnchors: ['World Triathlon coach education'],
    userFacingPrinciple: 'Triathlon plans must balance swim, bike, run, transition practice, and fatigue across disciplines.',
    implementationSignal: 'Surface bricks and discipline-specific stress clearly; avoid treating triathlon as three unrelated single-sport plans.',
  },
  {
    id: 'load-monitoring-multiple-signals',
    category: 'load_monitoring',
    appliesTo: ['all'],
    sourceAnchors: ['Training-load monitoring consensus', 'Recovery consensus'],
    userFacingPrinciple: 'No single wearable signal should overrule sleep, soreness, RPE, history, and schedule pressure.',
    implementationSignal: 'Use readiness as a modifier, label stale/missing data, and avoid overconfident claims when signals disagree.',
  },
  {
    id: 'fueling-support-within-scope',
    category: 'fueling_scope',
    appliesTo: ['running', 'cycling', 'triathlon', 'hybrid', 'strength'],
    sourceAnchors: ['ACSM/Academy/DC sports nutrition', 'IOC RED-S'],
    userFacingPrinciple: 'Nexus can suggest simple fueling support for hard or long sessions without making diagnosis or diet treatment claims.',
    implementationSignal: 'Create Cooking support or ask user preference for hard/long/two-a-day sessions; refer out for RED-S or medical-risk concerns.',
  },
  {
    id: 'coach-communication-no-raw-dumps',
    category: 'coach_communication',
    appliesTo: ['all'],
    sourceAnchors: ['International Sport Coaching Framework', 'World Triathlon Coaching Code'],
    userFacingPrinciple: 'Coach explanations should be short, respectful, specific, and actionable.',
    implementationSignal: 'Collapse source trace and never show raw JSON, IDs, provider errors, timing traces, or recommendation boilerplate in primary UI.',
  },
] as const;

export function listTrainingCoachRules(): readonly TrainingCoachRule[] {
  return TRAINING_COACH_RULES;
}

export function getTrainingCoachRuleById(id: string): TrainingCoachRule | null {
  return TRAINING_COACH_RULES.find((rule) => rule.id === id) ?? null;
}

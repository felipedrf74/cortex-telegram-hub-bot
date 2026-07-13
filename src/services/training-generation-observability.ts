// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type TrainingGenerationCounterName =
  | 'equipment_default_conservative_total'
  | 'unavailable_equipment_blocked_total'
  | 'selector_no_candidate_total'
  | 'final_validation_failure_total'
  | 'spec_needs_clarification_total'
  | 'tenant_scope_missing_blocked_total'
  | 'calendar_capacity_reflow_total'
  | 'safety_guardrail_triggered_total'
  | 'fallback_template_blocked_total'
  | 'revision_candidate_succeeded_total'
  | 'revision_candidate_failed_total'
  | 'revision_shadow_candidate_succeeded_total'
  | 'revision_shadow_candidate_skipped_total'
  | 'revision_activation_conflict_total'
  | 'revision_legacy_backfill_applied_total'
  | 'typed_plan_candidate_generated_total'
  | 'typed_workout_generated_total'
  | 'typed_phase_generated_total'
  | 'typed_quality_blocked_total'
  | 'typed_quality_repair_total'
  | 'typed_unknown_fallback_total'
  | 'typed_read_model_fallback_total'
  | 'adaptation_options_eligible_total'
  | 'adaptation_options_shown_total'
  | 'adaptation_options_suppressed_total'
  | 'adaptation_option_selected_total'
  | 'adaptation_scope_session_total'
  | 'adaptation_scope_week_total'
  | 'adaptation_scope_phase_total'
  | 'adaptation_scope_full_plan_total'
  | 'adaptation_repeated_tired_input_total'
  | 'adaptation_substitution_objective_match_total'
  | 'adaptation_suppressed_total'
  | 'adaptation_deferred_total'
  | 'adaptation_rejected_total'
  | 'adaptation_expired_total'
  | 'adaptation_activated_total';

export type TrainingProgressionStateName = 'build' | 'hold' | 'deload' | 'reentry';

export interface TrainingGenerationObservabilitySnapshot {
  counters: Record<TrainingGenerationCounterName, number>;
  progression_state_counts: Record<TrainingProgressionStateName, number>;
}

const COUNTER_NAMES: TrainingGenerationCounterName[] = [
  'equipment_default_conservative_total',
  'unavailable_equipment_blocked_total',
  'selector_no_candidate_total',
  'final_validation_failure_total',
  'spec_needs_clarification_total',
  'tenant_scope_missing_blocked_total',
  'calendar_capacity_reflow_total',
  'safety_guardrail_triggered_total',
  'fallback_template_blocked_total',
  'revision_candidate_succeeded_total',
  'revision_candidate_failed_total',
  'revision_shadow_candidate_succeeded_total',
  'revision_shadow_candidate_skipped_total',
  'revision_activation_conflict_total',
  'revision_legacy_backfill_applied_total',
  'typed_plan_candidate_generated_total',
  'typed_workout_generated_total',
  'typed_phase_generated_total',
  'typed_quality_blocked_total',
  'typed_quality_repair_total',
  'typed_unknown_fallback_total',
  'typed_read_model_fallback_total',
  'adaptation_options_eligible_total',
  'adaptation_options_shown_total',
  'adaptation_options_suppressed_total',
  'adaptation_option_selected_total',
  'adaptation_scope_session_total',
  'adaptation_scope_week_total',
  'adaptation_scope_phase_total',
  'adaptation_scope_full_plan_total',
  'adaptation_repeated_tired_input_total',
  'adaptation_substitution_objective_match_total',
  'adaptation_suppressed_total',
  'adaptation_deferred_total',
  'adaptation_rejected_total',
  'adaptation_expired_total',
  'adaptation_activated_total',
];

const PROGRESSION_STATES: TrainingProgressionStateName[] = ['build', 'hold', 'deload', 'reentry'];

const counters: Record<TrainingGenerationCounterName, number> = Object.fromEntries(
  COUNTER_NAMES.map((name) => [name, 0]),
) as Record<TrainingGenerationCounterName, number>;

const progressionStateCounts: Record<TrainingProgressionStateName, number> = Object.fromEntries(
  PROGRESSION_STATES.map((name) => [name, 0]),
) as Record<TrainingProgressionStateName, number>;

export function incrementTrainingGenerationCounter(
  name: TrainingGenerationCounterName,
  increment = 1,
): void {
  if (!Number.isFinite(increment) || increment <= 0) return;
  counters[name] += Math.floor(increment);
}

export function recordTrainingProgressionState(state: TrainingProgressionStateName | string | undefined): void {
  if (state === 'build' || state === 'hold' || state === 'deload' || state === 'reentry') {
    progressionStateCounts[state] += 1;
  }
}

export function getTrainingGenerationObservabilitySnapshot(): TrainingGenerationObservabilitySnapshot {
  return {
    counters: { ...counters },
    progression_state_counts: { ...progressionStateCounts },
  };
}

export function _resetTrainingGenerationObservabilityForTests(): void {
  for (const name of COUNTER_NAMES) counters[name] = 0;
  for (const state of PROGRESSION_STATES) progressionStateCounts[state] = 0;
}

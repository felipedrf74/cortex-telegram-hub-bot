// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Canonical typed discriminated union of Secretary arbitration reason codes.
 *
 * Wave 1 workstream W-A. Replaces stringly-typed `decisionReasonCodes` arrays
 * across the arbitrator, decision-center recipe, and provider-sync layers with
 * a single source of truth. Historical legacy rows (pre-W-A) decode through
 * `isKnownReasonCode` and pass through unchanged as `'unknown_legacy'` —
 * never throws.
 *
 * Design rules:
 *  - Producers must emit `SecretaryReasonCode` (compiler-enforced via this union).
 *  - Consumers branch with `isKnownReasonCode()` for safety on historical rows.
 *  - On-wire / on-disk format stays `string[]` JSON (no DB migration needed).
 *  - This file is the only place new reason codes are minted; reviewers grep
 *    this file when reading PRs that touch arbitrator reason emission.
 */

// Decision outcomes (one of these always appears in the array)
export type SecretaryOutcomeReasonCode =
  | 'scheduled_in_available_window'
  | 'reflowed_to_available_window'
  | 'compressed_to_fit_capacity'
  | 'deferred_due_to_current_capacity'
  | 'unscheduled_no_capacity'
  | 'removed_from_calendar_by_user'
  | 'priority_preempted_by_higher_rank';

// Validation failures (terminal — arbitration stops)
export type SecretaryValidationReasonCode =
  | 'invalid_owner_scope'
  | 'invalid_tenant_scope'
  | 'invalid_source_skill'
  | 'missing_intent_id'
  | 'missing_title'
  | 'missing_duration'
  | 'missing_availability'
  | 'no_valid_slot';

// Slot/intent context modifiers (appended after the outcome)
export type SecretarySlotModifierReasonCode =
  | 'duration_reduced'
  | 'fixed_intent_respected'
  | 'high_priority_intent'
  | 'deadline_present'
  | 'priority_preemption_candidate'
  | 'priority_preemption_applied';

// Source-skill hints (appended when a skill influences priority/intent)
export type SecretarySourceSkillReasonCode =
  | 'finance_deadline_priority'
  | 'cooking_support_request'
  | 'content_focus_request'
  | 'training_schedule_request';

// Future provider-sync / readback reason codes (W-E + W-B will extend)
export type SecretaryProviderSyncReasonCode =
  | 'provider_source_mismatch'
  | 'readback_mismatch'
  | 'readback_verified'
  | 'priority_preemption_dependency_terminal_failure'
  | 'preemption_winner_provider_terminal_failure'
  | 'preemption_canceled_before_provider_sync'
  | 'preemption_winner_expired_before_provider_sync';

export type SecretaryReasonCode =
  | SecretaryOutcomeReasonCode
  | SecretaryValidationReasonCode
  | SecretarySlotModifierReasonCode
  | SecretarySourceSkillReasonCode
  | SecretaryProviderSyncReasonCode;

const KNOWN_REASON_CODES = new Set<string>([
  // outcome
  'scheduled_in_available_window',
  'reflowed_to_available_window',
  'compressed_to_fit_capacity',
  'deferred_due_to_current_capacity',
  'unscheduled_no_capacity',
  'removed_from_calendar_by_user',
  'priority_preempted_by_higher_rank',
  // validation
  'invalid_owner_scope',
  'invalid_tenant_scope',
  'invalid_source_skill',
  'missing_intent_id',
  'missing_title',
  'missing_duration',
  'missing_availability',
  'no_valid_slot',
  // slot modifiers
  'duration_reduced',
  'fixed_intent_respected',
  'high_priority_intent',
  'deadline_present',
  'priority_preemption_candidate',
  'priority_preemption_applied',
  // source-skill hints
  'finance_deadline_priority',
  'cooking_support_request',
  'content_focus_request',
  'training_schedule_request',
  // provider sync
  'provider_source_mismatch',
  'readback_mismatch',
  'readback_verified',
  'priority_preemption_dependency_terminal_failure',
  'preemption_winner_provider_terminal_failure',
  'preemption_canceled_before_provider_sync',
  'preemption_winner_expired_before_provider_sync',
]);

/**
 * Type narrower for runtime reads of historical `decision_reason_codes_json`
 * rows. Returns `true` when the string is a recognized typed reason code;
 * otherwise the caller should treat the value as `'unknown_legacy'` (NOT
 * throw).
 */
export function isKnownReasonCode(value: string): value is SecretaryReasonCode {
  return KNOWN_REASON_CODES.has(value);
}

/**
 * Used by consumers to safely process historical reason codes. Returns the
 * canonical literal type if recognized, otherwise the sentinel
 * `'unknown_legacy'` so downstream switches can fall through without throw.
 */
export function asTypedReasonCode(value: string): SecretaryReasonCode | 'unknown_legacy' {
  return isKnownReasonCode(value) ? value : 'unknown_legacy';
}

/**
 * Returns the typed reason codes from a heterogeneous array, dropping any
 * legacy values that no longer match the canonical union. Use sparingly —
 * usually `asTypedReasonCode` per-element preserves more information.
 */
export function filterKnownReasonCodes(values: readonly string[]): SecretaryReasonCode[] {
  const out: SecretaryReasonCode[] = [];
  for (const value of values) {
    if (isKnownReasonCode(value)) out.push(value);
  }
  return out;
}

/**
 * Returns true if the array contains the given typed reason code.
 * Type-safe equivalent of `Array.includes(code)` for code paths that read
 * `decision_reason_codes_json` and want to branch.
 */
export function containsReasonCode(
  values: readonly string[],
  code: SecretaryReasonCode,
): boolean {
  for (const value of values) {
    if (value === code) return true;
  }
  return false;
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  asTypedReasonCode,
  containsReasonCode,
  filterKnownReasonCodes,
  isKnownReasonCode,
  type SecretaryReasonCode,
} from '../../src/services/secretary-reason-codes';

describe('SecretaryReasonCode union', () => {
  it('recognizes every outcome reason code', () => {
    const outcomes: SecretaryReasonCode[] = [
      'scheduled_in_available_window',
      'reflowed_to_available_window',
      'compressed_to_fit_capacity',
      'deferred_due_to_current_capacity',
      'unscheduled_no_capacity',
    ];
    for (const code of outcomes) {
      expect(isKnownReasonCode(code)).toBe(true);
    }
  });

  it('recognizes every validation reason code', () => {
    const validations: SecretaryReasonCode[] = [
      'invalid_owner_scope',
      'invalid_tenant_scope',
      'invalid_source_skill',
      'missing_intent_id',
      'missing_title',
      'missing_duration',
      'missing_availability',
      'no_valid_slot',
    ];
    for (const code of validations) {
      expect(isKnownReasonCode(code)).toBe(true);
    }
  });

  it('recognizes every source-skill hint reason code', () => {
    const hints: SecretaryReasonCode[] = [
      'finance_deadline_priority',
      'cooking_support_request',
      'content_focus_request',
      'training_schedule_request',
    ];
    for (const code of hints) {
      expect(isKnownReasonCode(code)).toBe(true);
    }
  });

  it('recognizes every slot-modifier reason code', () => {
    const modifiers: SecretaryReasonCode[] = [
      'duration_reduced',
      'fixed_intent_respected',
      'high_priority_intent',
      'deadline_present',
      'priority_preemption_candidate',
    ];
    for (const code of modifiers) {
      expect(isKnownReasonCode(code)).toBe(true);
    }
  });

  it('recognizes every provider-sync reason code', () => {
    const syncCodes: SecretaryReasonCode[] = [
      'provider_source_mismatch',
      'readback_mismatch',
      'readback_verified',
      'priority_preemption_dependency_terminal_failure',
      'preemption_winner_provider_terminal_failure',
      'preemption_canceled_before_provider_sync',
      'preemption_winner_expired_before_provider_sync',
    ];
    for (const code of syncCodes) {
      expect(isKnownReasonCode(code)).toBe(true);
    }
  });

  it('rejects unknown legacy strings without throwing', () => {
    // Pre-W-A historical reason codes that may live in DB rows.
    expect(isKnownReasonCode('capacity_exceeded')).toBe(false);
    expect(isKnownReasonCode('legacy_arbitration_code')).toBe(false);
    expect(isKnownReasonCode('')).toBe(false);
    // Sentinel for downstream consumers
    expect(asTypedReasonCode('capacity_exceeded')).toBe('unknown_legacy');
    expect(asTypedReasonCode('scheduled_in_available_window')).toBe('scheduled_in_available_window');
  });

  it('filterKnownReasonCodes drops legacy values without throwing', () => {
    const mixed = [
      'scheduled_in_available_window',
      'capacity_exceeded', // legacy
      'high_priority_intent',
      'some_garbage_code', // legacy
    ];
    const filtered = filterKnownReasonCodes(mixed);
    expect(filtered).toEqual(['scheduled_in_available_window', 'high_priority_intent']);
  });

  it('containsReasonCode is type-safe and tolerates legacy mix', () => {
    const mixed = ['capacity_exceeded', 'reflowed_to_available_window', 'unknown_code'];
    expect(containsReasonCode(mixed, 'reflowed_to_available_window')).toBe(true);
    expect(containsReasonCode(mixed, 'compressed_to_fit_capacity')).toBe(false);
  });
});

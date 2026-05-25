import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION,
  evaluateChatCoreV2TrainingSafetyPolicy,
  getChatCoreV2Capability,
  listChatCoreV2CapabilitiesByDomain,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 training safety policy', () => {
  it('attaches the versioned safety policy to every training capability', () => {
    for (const capability of listChatCoreV2CapabilitiesByDomain('training')) {
      expect(capability.domainSafetyPolicyVersion, capability.capabilityId)
        .toBe(CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION);
    }
  });

  it('keeps training writes preview-only behind medium-risk health-adjacent policy gates', () => {
    const capability = getChatCoreV2Capability('training.modify_session_preview');

    expect(capability?.support.preview).toBe('supported');
    expect(capability?.support.execute).toBe('preview_only');
    expect(capability?.risk).toBe('medium');
    expect(capability?.sensitivity).toBe('health_adjacent');
    expect(capability?.domainSafetyPolicyVersion).toBe(CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION);
  });

  it('allows safe single-session preview changes that reduce training load', () => {
    const verdict = evaluateChatCoreV2TrainingSafetyPolicy({
      operation: 'preview',
      changeTypes: ['move_session', 'reduce_intensity'],
      affectedSessionCount: 1,
      targetSessionIds: ['session_123'],
      increasesVolumePercent: -20,
      minRestHoursBefore: 36,
      minRestHoursAfter: 48,
    });

    expect(verdict).toMatchObject({
      ok: true,
      decision: 'allowed',
      maxAllowedOperation: 'preview',
      reasons: ['safe_preview_allowed'],
      policyVersion: CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION,
    });
  });

  it('blocks execution in v1 even when the preview proposal is safe', () => {
    const verdict = evaluateChatCoreV2TrainingSafetyPolicy({
      operation: 'execute',
      changeTypes: ['reduce_intensity'],
      affectedSessionCount: 1,
      targetSessionIds: ['session_123'],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe('blocked');
    expect(verdict.reasons).toEqual(['execution_not_enabled']);
  });

  it('requires clarification before guessing the target session or change type', () => {
    const verdict = evaluateChatCoreV2TrainingSafetyPolicy({
      operation: 'preview',
      changeTypes: [],
      affectedSessionCount: 0,
      targetSessionIds: [],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe('needs_clarification');
    expect(verdict.reasons).toEqual(['missing_change_type', 'missing_target_session']);
  });

  it('blocks proposals that conflict with injury, equipment, rest-day, or rest-window constraints', () => {
    const verdict = evaluateChatCoreV2TrainingSafetyPolicy({
      operation: 'preview',
      changeTypes: ['move_session', 'replace_exercise'],
      affectedSessionCount: 1,
      targetSessionIds: ['session_123'],
      conflictsWithInjury: true,
      injuryConflictLabels: ['knee pain'],
      requiresUnavailableEquipment: true,
      unavailableEquipmentLabels: ['barbell'],
      removesRestDay: true,
      minRestHoursBefore: 12,
      minRestHoursAfter: 18,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe('blocked');
    expect(verdict.reasons).toEqual([
      'injury_conflict',
      'equipment_unavailable',
      'rest_day_violation',
      'rest_window_violation',
    ]);
    expect(verdict.blockedLabels).toEqual(['knee pain', 'barbell']);
  });

  it('routes multi-session, goal-changing, or load-increasing proposals to human review', () => {
    const verdict = evaluateChatCoreV2TrainingSafetyPolicy({
      operation: 'preview',
      changeTypes: ['reflow_week', 'increase_intensity'],
      affectedSessionCount: 4,
      targetSessionIds: ['session_1', 'session_2', 'session_3', 'session_4'],
      affectsPlanGoal: true,
      userConfirmedGoalChange: false,
      increasesIntensity: true,
      increasesVolumePercent: 18,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe('requires_human_review');
    expect(verdict.humanReviewReason).toBe('training_plan_rewrite');
    expect(verdict.reasons).toEqual([
      'multi_session_change_requires_review',
      'goal_change_requires_review',
      'intensity_increase_requires_review',
      'volume_spike_requires_review',
    ]);
  });
});

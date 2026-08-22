import { describe, expect, it } from 'vitest';
import {
  SKILL_INFERENCE_PROFILE_VERSION,
  buildSkillInferenceSystemPolicy,
  getSkillInferenceProfile,
  listSkillInferenceProfiles,
  profileAllowsRisk,
} from '../../src/services/skill-inference-profiles';

describe('skill inference profiles', () => {
  it('defines one output-only profile for every Nexus skill', () => {
    expect(SKILL_INFERENCE_PROFILE_VERSION).toBe('nexus-skill-inference-v2');
    expect(listSkillInferenceProfiles().map((profile) => profile.skillId).sort()).toEqual([
      'content', 'cooking', 'finance', 'secretary', 'training', 'triathlon',
    ]);
    for (const profile of listSkillInferenceProfiles()) {
      expect(profile.toolPolicy).toBe('none');
      expect(profile.toolAllowlist).toEqual([]);
      expect(profile.memoryScope).toBe('server_compiled_tenant_request');
      expect(profile.validatorIds).toEqual(['non_empty_output', 'server_owned_schema']);
      expect(profile.fallbackPolicy).toEqual({
        maximumLocalSchemaRepairs: 1,
        publicCloudEscalation: 'explicit_authorization',
        privateCloudEscalation: 'forbidden',
      });
      expect(profile.systemPolicy).toContain('output-only inference boundary');
      expect(profile.systemPolicy).toContain('untrusted data');
      expect(profile.systemPolicy).toContain('another user or tenant');
      expect(profile.systemPolicy).toContain('paid or copyrighted material');
      expect(profile.systemPolicy).toContain('acute symptoms');
      expect(profile.systemPolicy).toContain('severe allergy');
      expect(profile.systemPolicy).toContain("user's language");
    }
    expect(getSkillInferenceProfile('content').maximumOutputTokens).toBe(6144);
    expect(listSkillInferenceProfiles()
      .filter((profile) => profile.skillId !== 'content')
      .every((profile) => profile.maximumOutputTokens === 4096)).toBe(true);
  });

  it('builds every production profile from the governed refusal policy', () => {
    for (const profile of listSkillInferenceProfiles()) {
      expect(profile.systemPolicy).toBe(buildSkillInferenceSystemPolicy(profile.skillId));
    }
  });

  it('keeps Finance low-risk and rejects high-risk or regulated local work globally', () => {
    const finance = getSkillInferenceProfile('finance');
    expect(profileAllowsRisk(finance, 'low')).toBe(true);
    expect(profileAllowsRisk(finance, 'medium')).toBe(false);
    for (const profile of listSkillInferenceProfiles()) {
      expect(profileAllowsRisk(profile, 'high')).toBe(false);
      expect(profileAllowsRisk(profile, 'regulated')).toBe(false);
      expect(profile.allowedExecutionClasses).not.toContain('action_proposal');
    }
  });
});

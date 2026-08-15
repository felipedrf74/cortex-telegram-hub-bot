import { describe, expect, it } from 'vitest';
import {
  getSkillInferenceProfile,
  listSkillInferenceProfiles,
  profileAllowsRisk,
} from '../../src/services/skill-inference-profiles';

describe('skill inference profiles', () => {
  it('defines one output-only profile for every Nexus skill', () => {
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
    }
    expect(getSkillInferenceProfile('content').maximumOutputTokens).toBe(6144);
    expect(listSkillInferenceProfiles()
      .filter((profile) => profile.skillId !== 'content')
      .every((profile) => profile.maximumOutputTokens === 4096)).toBe(true);
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

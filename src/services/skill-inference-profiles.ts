// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import profilePolicy from './skill-inference-profile-policy.json';

export const SKILL_INFERENCE_PROFILE_VERSION = profilePolicy.version;

export type SkillInferenceSkill =
  | 'secretary'
  | 'content'
  | 'training'
  | 'triathlon'
  | 'cooking'
  | 'finance';
export type SkillInferenceRiskClass = 'low' | 'medium' | 'high' | 'regulated';
export type SkillInferenceExecutionClass = 'interactive' | 'background' | 'action_proposal';
export type SkillInferenceValidatorId = 'non_empty_output' | 'server_owned_schema';

export interface SkillInferenceFallbackPolicy {
  maximumLocalSchemaRepairs: 1;
  publicCloudEscalation: 'explicit_authorization';
  privateCloudEscalation: 'forbidden';
}

export interface SkillInferenceProfile {
  skillId: SkillInferenceSkill;
  version: typeof SKILL_INFERENCE_PROFILE_VERSION;
  systemPolicy: string;
  maximumRiskClass: 'low' | 'medium';
  allowedExecutionClasses: readonly SkillInferenceExecutionClass[];
  contextPolicy: 'ordinary' | 'content';
  memoryScope: 'server_compiled_tenant_request';
  allowedSchemaIds: readonly string[];
  toolPolicy: 'none';
  toolAllowlist: readonly [];
  maximumOutputTokens: 4096 | 6144;
  validatorIds: readonly SkillInferenceValidatorId[];
  fallbackPolicy: SkillInferenceFallbackPolicy;
}

const SHARED_POLICY = profilePolicy.sharedPolicy.join(' ');

export function buildSkillInferenceSystemPolicy(skillId: SkillInferenceSkill): string {
  return `${SHARED_POLICY} ${profilePolicy.skillPolicy[skillId]}`;
}

const OUTPUT_ONLY_POLICY = {
  memoryScope: 'server_compiled_tenant_request' as const,
  toolPolicy: 'none' as const,
  toolAllowlist: [] as const,
  validatorIds: ['non_empty_output', 'server_owned_schema'] as const,
  fallbackPolicy: {
    maximumLocalSchemaRepairs: 1 as const,
    publicCloudEscalation: 'explicit_authorization' as const,
    privateCloudEscalation: 'forbidden' as const,
  },
};

const profiles: Record<SkillInferenceSkill, SkillInferenceProfile> = {
  secretary: {
    skillId: 'secretary',
    version: SKILL_INFERENCE_PROFILE_VERSION,
    systemPolicy: buildSkillInferenceSystemPolicy('secretary'),
    maximumRiskClass: 'medium',
    allowedExecutionClasses: ['interactive'],
    contextPolicy: 'ordinary',
    ...OUTPUT_ONLY_POLICY,
    maximumOutputTokens: 4096,
    allowedSchemaIds: ['text', 'generic_json', 'secretary_read_only'],
  },
  content: {
    skillId: 'content',
    version: SKILL_INFERENCE_PROFILE_VERSION,
    systemPolicy: buildSkillInferenceSystemPolicy('content'),
    maximumRiskClass: 'medium',
    allowedExecutionClasses: ['interactive', 'background'],
    contextPolicy: 'content',
    ...OUTPUT_ONLY_POLICY,
    maximumOutputTokens: 6144,
    allowedSchemaIds: ['text', 'generic_json', 'content_script', 'content_specialist_group'],
  },
  training: {
    skillId: 'training',
    version: SKILL_INFERENCE_PROFILE_VERSION,
    systemPolicy: buildSkillInferenceSystemPolicy('training'),
    maximumRiskClass: 'medium',
    allowedExecutionClasses: ['interactive'],
    contextPolicy: 'ordinary',
    ...OUTPUT_ONLY_POLICY,
    maximumOutputTokens: 4096,
    allowedSchemaIds: ['text', 'generic_json', 'training_explanation'],
  },
  triathlon: {
    skillId: 'triathlon',
    version: SKILL_INFERENCE_PROFILE_VERSION,
    systemPolicy: buildSkillInferenceSystemPolicy('triathlon'),
    maximumRiskClass: 'medium',
    allowedExecutionClasses: ['interactive'],
    contextPolicy: 'ordinary',
    ...OUTPUT_ONLY_POLICY,
    maximumOutputTokens: 4096,
    allowedSchemaIds: ['text', 'generic_json', 'triathlon_explanation'],
  },
  cooking: {
    skillId: 'cooking',
    version: SKILL_INFERENCE_PROFILE_VERSION,
    systemPolicy: buildSkillInferenceSystemPolicy('cooking'),
    maximumRiskClass: 'medium',
    allowedExecutionClasses: ['interactive'],
    contextPolicy: 'ordinary',
    ...OUTPUT_ONLY_POLICY,
    maximumOutputTokens: 4096,
    allowedSchemaIds: ['text', 'generic_json', 'cooking_guidance'],
  },
  finance: {
    skillId: 'finance',
    version: SKILL_INFERENCE_PROFILE_VERSION,
    systemPolicy: buildSkillInferenceSystemPolicy('finance'),
    maximumRiskClass: 'low',
    allowedExecutionClasses: ['interactive'],
    contextPolicy: 'ordinary',
    ...OUTPUT_ONLY_POLICY,
    maximumOutputTokens: 4096,
    allowedSchemaIds: ['text', 'generic_json', 'finance_summary'],
  },
};

export function isSkillInferenceSkill(value: unknown): value is SkillInferenceSkill {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(profiles, value);
}

export function getSkillInferenceProfile(skillId: SkillInferenceSkill): SkillInferenceProfile {
  return profiles[skillId];
}

export function listSkillInferenceProfiles(): SkillInferenceProfile[] {
  return Object.values(profiles);
}

export function profileAllowsRisk(
  profile: SkillInferenceProfile,
  riskClass: SkillInferenceRiskClass,
): boolean {
  if (riskClass === 'high' || riskClass === 'regulated') return false;
  if (profile.maximumRiskClass === 'low') return riskClass === 'low';
  return true;
}

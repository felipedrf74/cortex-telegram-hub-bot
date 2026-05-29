// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatCoreV2ModelResidencyRole =
  | 'planner_3b'
  | 'escalation_35b'
  | 'operational_rollback'
  | 'classifier_shadow';

export interface ChatCoreV2ModelResidencyPolicy {
  role: ChatCoreV2ModelResidencyRole;
  modelEnvKey: string;
  defaultModel: string;
  defaultKeepAlive: '-1' | '5m' | '0';
  foregroundAllowed: boolean;
  notes: string;
}

export interface ChatCoreV2ResolvedModelResidency {
  role: ChatCoreV2ModelResidencyRole;
  model: string;
  keepAlive: '-1' | '5m' | '0';
  foregroundAllowed: boolean;
}

export type ChatCoreV2ModelResidencyIssue =
  | 'missing_planner_model'
  | 'planner_not_always_loaded'
  | 'foreground_escalation_model_enabled';

export const CHAT_CORE_V2_MODEL_RESIDENCY_POLICIES: ChatCoreV2ModelResidencyPolicy[] = [
  {
    role: 'planner_3b',
    modelEnvKey: 'OLLAMA_CLASSIFIER_MODEL',
    defaultModel: 'qwen2.5:3b-instruct-q4_K_M',
    defaultKeepAlive: '-1',
    foregroundAllowed: true,
    notes: 'Always loaded hot path for bounded micro-planning.',
  },
  {
    role: 'escalation_35b',
    modelEnvKey: 'OLLAMA_MODEL',
    defaultModel: 'qwen3.6:35b-a3b-q4_K_M',
    defaultKeepAlive: '5m',
    foregroundAllowed: false,
    notes: 'Background/escalation only on CPU-only VPS unless GPU benchmark changes the gate.',
  },
  {
    role: 'operational_rollback',
    modelEnvKey: 'OLLAMA_OPERATIONAL_ROLLBACK_MODEL',
    defaultModel: 'qwen3.6:27b-q4_K_M',
    defaultKeepAlive: '0',
    foregroundAllowed: false,
    notes: 'Manual rollback only.',
  },
  {
    role: 'classifier_shadow',
    modelEnvKey: 'OLLAMA_CLASSIFIER_MODEL',
    defaultModel: 'qwen2.5:3b-instruct-q4_K_M',
    defaultKeepAlive: '5m',
    foregroundAllowed: false,
    notes: 'May share the 3B planner instance when prompt shape and queueing allow.',
  },
];

export function resolveChatCoreV2ModelResidencyConfig(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): ChatCoreV2ResolvedModelResidency[] {
  return CHAT_CORE_V2_MODEL_RESIDENCY_POLICIES.map((policy) => ({
    role: policy.role,
    model: (env[policy.modelEnvKey] ?? policy.defaultModel).trim() || policy.defaultModel,
    keepAlive: policy.defaultKeepAlive,
    foregroundAllowed: policy.foregroundAllowed,
  }));
}

export function validateChatCoreV2ModelResidencyConfig(
  config: ChatCoreV2ResolvedModelResidency[],
): ChatCoreV2ModelResidencyIssue[] {
  const issues = new Set<ChatCoreV2ModelResidencyIssue>();
  const planner = config.find((entry) => entry.role === 'planner_3b');
  if (!planner?.model) issues.add('missing_planner_model');
  if (planner && planner.keepAlive !== '-1') issues.add('planner_not_always_loaded');
  if (config.some((entry) => entry.role !== 'planner_3b' && entry.foregroundAllowed)) {
    issues.add('foreground_escalation_model_enabled');
  }
  return [...issues];
}

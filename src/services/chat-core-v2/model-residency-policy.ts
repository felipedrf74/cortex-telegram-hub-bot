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

/**
 * Pure role → keep-alive-seconds mapping (WP-02 D12 residency, closed in WP-15
 * for B8). Maps the declared `defaultKeepAlive` token of a residency role to the
 * integer second value Ollama's `keep_alive` field expects:
 *   '-1' → -1   (always loaded; the 3B planner hot path)
 *   '5m' → 300  (5-minute residency; the 35B background escalation path)
 *   '0'  → 0    (unload immediately after the call; operational rollback)
 * Unknown roles default to -1 (the safe "stay loaded" behavior). This is the
 * single source the background worker calls with `'escalation_35b'` so the only
 * path that runs 35B asserts a 300s residency (closes B8), while every other
 * caller (the foreground 3B planner) stays at -1.
 */
export function resolveKeepAliveForRole(
  role: ChatCoreV2ModelResidencyRole | string,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): number {
  const policy = CHAT_CORE_V2_MODEL_RESIDENCY_POLICIES.find((entry) => entry.role === role);
  const token = policy?.defaultKeepAlive ?? '-1';
  void env;
  switch (token) {
    case '5m':
      return 300;
    case '0':
      return 0;
    case '-1':
    default:
      return -1;
  }
}

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

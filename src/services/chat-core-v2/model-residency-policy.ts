// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { OLLAMA_SMALL_ONLY_MODEL } from '../ollama-model-policy';

export type ChatCoreV2ModelResidencyRole =
  | 'planner_3b'
  | 'background_escalation'
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
  | 'non_small_model_configured'
  | 'foreground_escalation_model_enabled';

export const CHAT_CORE_V2_MODEL_RESIDENCY_POLICIES: ChatCoreV2ModelResidencyPolicy[] = [
  {
    role: 'planner_3b',
    modelEnvKey: 'OLLAMA_CLASSIFIER_MODEL',
    defaultModel: OLLAMA_SMALL_ONLY_MODEL,
    defaultKeepAlive: '-1',
    foregroundAllowed: true,
    notes: 'Always loaded hot path for bounded micro-planning.',
  },
  {
    role: 'background_escalation',
    modelEnvKey: 'OLLAMA_MODEL',
    defaultModel: OLLAMA_SMALL_ONLY_MODEL,
    defaultKeepAlive: '0',
    foregroundAllowed: false,
    notes: 'No large local model. Approved cloud routing or visible failure handles complex work.',
  },
  {
    // Legacy role identifier retained for stored/test contract compatibility.
    // It resolves to the same 3B/no-residency policy and never selects 35B.
    role: 'escalation_35b',
    modelEnvKey: 'OLLAMA_MODEL',
    defaultModel: OLLAMA_SMALL_ONLY_MODEL,
    defaultKeepAlive: '0',
    foregroundAllowed: false,
    notes: 'Legacy alias for background_escalation; no large model is selectable.',
  },
  {
    // Legacy alias only. Rollback now disables Ollama and uses approved cloud
    // routing; there is no separate local rollback model.
    role: 'operational_rollback',
    modelEnvKey: 'OLLAMA_MODEL',
    defaultModel: OLLAMA_SMALL_ONLY_MODEL,
    defaultKeepAlive: '0',
    foregroundAllowed: false,
    notes: 'Legacy compatibility alias; does not select a rollback model.',
  },
  {
    role: 'classifier_shadow',
    modelEnvKey: 'OLLAMA_CLASSIFIER_MODEL',
    defaultModel: OLLAMA_SMALL_ONLY_MODEL,
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
 *   '5m' → 300  (short-lived 3B classifier shadow residency)
 *   '0'  → 0    (background/unknown roles unload immediately)
 * Unknown roles default to 0 so a stale caller cannot pin local memory. The
 * foreground 3B planner stays loaded; complex work uses the approved cloud
 * gate or fails visibly.
 */
export function resolveKeepAliveForRole(
  role: ChatCoreV2ModelResidencyRole | string,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): number {
  const policy = CHAT_CORE_V2_MODEL_RESIDENCY_POLICIES.find((entry) => entry.role === role);
  const token = policy?.defaultKeepAlive ?? '0';
  void env;
  switch (token) {
    case '5m':
      return 300;
    case '0':
      return 0;
    case '-1': return -1;
    default: return 0;
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
  if (config.some((entry) => entry.model !== OLLAMA_SMALL_ONLY_MODEL)) {
    issues.add('non_small_model_configured');
  }
  if (config.some((entry) => entry.role !== 'planner_3b' && entry.foregroundAllowed)) {
    issues.add('foreground_escalation_model_enabled');
  }
  return [...issues];
}

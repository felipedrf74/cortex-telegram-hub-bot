// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatCoreV2AutoRevertAction =
  | 'keep_current_mode'
  | 'flip_global_to_shadow'
  | 'flip_language_to_shadow'
  | 'pin_planner_to_repair_only'
  | 'page_operator';

export interface ChatCoreV2AutoRevertMetrics {
  legacyFallbackRate24h: number;
  ollamaHealthy: boolean;
  schemaComplianceRate1h: number;
  prepassRecallByLanguage?: Record<string, number>;
}

export interface ChatCoreV2AutoRevertDecision {
  actions: ChatCoreV2AutoRevertAction[];
  affectedLanguages: string[];
  reasonCodes: string[];
}

export function evaluateChatCoreV2AutoRevertPolicy(
  metrics: ChatCoreV2AutoRevertMetrics,
): ChatCoreV2AutoRevertDecision {
  const actions = new Set<ChatCoreV2AutoRevertAction>();
  const reasonCodes: string[] = [];
  const affectedLanguages: string[] = [];

  if (!metrics.ollamaHealthy) {
    actions.add('flip_global_to_shadow');
    reasonCodes.push('ollama_unhealthy');
  }
  if (metrics.legacyFallbackRate24h >= 0.15) {
    actions.add('page_operator');
    reasonCodes.push('legacy_fallback_rate_pager_threshold');
  }
  if (metrics.legacyFallbackRate24h >= 0.05) {
    actions.add('flip_global_to_shadow');
    reasonCodes.push('legacy_fallback_rate_auto_shadow_threshold');
  }
  if (metrics.schemaComplianceRate1h < 0.95) {
    // The repair-only pin is consumed by the shadow planner path: fresh planner
    // generation is skipped for the tenant while the pin is set. A schema breach
    // still ALSO demotes the tenant to shadow because the live-path stop is the
    // kill-switch seam; the pin controls planner generation after the demotion.
    actions.add('pin_planner_to_repair_only');
    actions.add('flip_global_to_shadow');
    reasonCodes.push('schema_compliance_below_95');
  }
  for (const [language, recall] of Object.entries(metrics.prepassRecallByLanguage ?? {})) {
    if (recall < 0.90) {
      actions.add('flip_language_to_shadow');
      affectedLanguages.push(language);
    }
  }
  if (affectedLanguages.length > 0) reasonCodes.push('prepass_recall_below_90_for_language');

  return {
    actions: actions.size > 0 ? [...actions] : ['keep_current_mode'],
    affectedLanguages,
    reasonCodes,
  };
}

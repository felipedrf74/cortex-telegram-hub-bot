// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Runtime flag catalog for the operator portal.
 *
 * `runtime-flags.ts` exposes ~70 env-driven feature flags as functions, which
 * is right for callers but invisible to an operator. This catalog names every
 * flag reader, the env keys it consults, and how to read it, so the portal can
 * render "what is on right now" without touching `process.env` values.
 *
 * Boundaries:
 *   - Readings return the flag's parsed value (boolean / mode / count), never
 *     the raw env string. Presence of an env key is reported as a boolean.
 *   - Env flags are read-only here. A runtime override would drift from the
 *     process environment and vanish on restart; mutable operator switches
 *     live in `hybrid-runtime-kill-switches.ts` (DB-backed) instead.
 *   - `__tests__/services/runtime-flags-catalog.test.ts` pins this list to the
 *     exports of `runtime-flags.ts` so a new flag cannot land without an entry
 *     (or an explicit exemption in RUNTIME_FLAG_NON_CATALOG_EXPORTS).
 */

import * as runtimeFlags from './runtime-flags';

export type RuntimeFlagSemantics = 'opt-in' | 'default-on' | 'dark-cohort' | 'mode' | 'boolean' | 'value' | 'derived';
export type RuntimeFlagValueType = 'boolean' | 'number' | 'list' | 'map' | 'tri-state' | 'mode';

export interface RuntimeFlagCatalogEntry {
  /** Exported reader name in runtime-flags.ts. */
  name: string;
  area: string;
  /** Env keys the reader consults (base keys; scoped readers also honor _USER_<id> / _TENANT_<id>). */
  envKeys: readonly string[];
  /** Accepts a RuntimeFlagScope (per-user / per-tenant override keys). */
  scoped: boolean;
  semantics: RuntimeFlagSemantics;
  valueType: RuntimeFlagValueType;
  /** Value is replaced by a count; the raw list may identify users. */
  redacted?: boolean;
}

/** Readers that need call-site arguments (plan mode, skill, flag key) and cannot be read generically. */
export const RUNTIME_FLAG_NON_CATALOG_EXPORTS: readonly string[] = Object.freeze([
  'isDecisionCenterGuidanceSkillEnabled',
  'isTrainingM4PlanCombinationAllowed',
  'isTrainingM4OwnedCombination',
  'isTrainingPlanRevisionV1ExplicitlyEnrolled',
  'isChatCoreV2RuntimeFlagEnabled',
  'resolveSecretaryPrimaryRouteEnvOverride',
]);

export const RUNTIME_FLAG_CATALOG: readonly RuntimeFlagCatalogEntry[] = Object.freeze([
  { name: 'isAnthropicRuntimeEnabled', area: 'providers', envKeys: ['ANTHROPIC_ENABLED'], scoped: false, semantics: 'boolean', valueType: 'boolean' },
  { name: 'canUseAnthropicRuntimeFallback', area: 'providers', envKeys: ['ANTHROPIC_ENABLED'], scoped: false, semantics: 'boolean', valueType: 'boolean' },
  { name: 'getAICallTimeoutMs', area: 'providers', envKeys: ['AI_CALL_TIMEOUT_MS'], scoped: false, semantics: 'value', valueType: 'number' },
  { name: 'areGlobalInvoiceVendorsEnabled', area: 'finance', envKeys: ['FISCAL_ENABLE_GLOBAL_BUILTIN_VENDORS'], scoped: false, semantics: 'boolean', valueType: 'boolean' },
  { name: 'getGeminiRoutingEnvOverride', area: 'providers', envKeys: ['GEMINI_ROUTING_ENABLED'], scoped: false, semantics: 'value', valueType: 'tri-state' },
  { name: 'getSecretaryPrimaryRouteEnvOverride', area: 'secretary', envKeys: ['SECRETARY_PRIMARY_ROUTE_ENABLED', 'GEMINI_INCLUDE_SECRETARY'], scoped: false, semantics: 'derived', valueType: 'tri-state' },
  { name: 'getGeminiIncludeSecretaryEnvOverride', area: 'providers', envKeys: ['SECRETARY_PRIMARY_ROUTE_ENABLED', 'GEMINI_INCLUDE_SECRETARY'], scoped: false, semantics: 'derived', valueType: 'tri-state' },
  { name: 'getGeminiDomainAllowlist', area: 'providers', envKeys: ['GEMINI_DOMAINS'], scoped: false, semantics: 'value', valueType: 'list' },
  { name: 'getDomainProviderExperimentOverrides', area: 'providers', envKeys: ['AI_DOMAIN_PROVIDER_OVERRIDES'], scoped: false, semantics: 'value', valueType: 'map' },
  { name: 'isSecretaryHaikuRoutingEnabled', area: 'secretary', envKeys: ['SECRETARY_HAIKU_ROUTING_ENABLED'], scoped: false, semantics: 'boolean', valueType: 'boolean' },
  { name: 'areModelProviderCallsDisabled', area: 'providers', envKeys: ['NEXUS_LOCAL_ALLOW_MODEL_CALLS', 'NEXUS_MODEL_FIXTURE_MODE'], scoped: false, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isContentForceDraftOnlyEnabled', area: 'content', envKeys: ['CONTENT_FORCE_DRAFT_ONLY'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isContentFreshResearchDisabled', area: 'content', envKeys: ['CONTENT_DISABLE_FRESH_RESEARCH'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isContentDeepResearchDisabled', area: 'content', envKeys: ['CONTENT_DISABLE_DEEP_RESEARCH'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isContentFullLongformDisabled', area: 'content', envKeys: ['CONTENT_DISABLE_FULL_YOUTUBE_LONGFORM'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isContentModelQualityAuditDisabled', area: 'content', envKeys: ['CONTENT_DISABLE_MODEL_QUALITY_AUDIT'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'getChatHybridPlannerMode', area: 'chat', envKeys: ['CHAT_HYBRID_SHADOW_MODE', 'CHAT_HYBRID_PLANNER_ENABLED'], scoped: true, semantics: 'mode', valueType: 'mode' },
  { name: 'isChatHybridPlannerEnabled', area: 'chat', envKeys: ['CHAT_HYBRID_PLANNER_ENABLED', 'CHAT_HYBRID_SHADOW_MODE'], scoped: true, semantics: 'derived', valueType: 'boolean' },
  { name: 'isChatLlmTier1Enabled', area: 'chat', envKeys: ['CHAT_LLM_TIER1_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatLlmTier2Enabled', area: 'chat', envKeys: ['CHAT_LLM_TIER2_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatEscalationReviewerEnabled', area: 'chat', envKeys: ['CHAT_ESCALATION_REVIEWER_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatOpenSurfaceHandoffEnabled', area: 'chat', envKeys: ['CHAT_OPEN_SURFACE_HANDOFF_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isHomeDayDialV1Enabled', area: 'home', envKeys: ['HOME_DAY_DIAL_V1_ENABLED'], scoped: true, semantics: 'default-on', valueType: 'boolean' },
  { name: 'isProviderPreferencesV1Enabled', area: 'home', envKeys: ['PROVIDER_PREFERENCES_V1_ENABLED'], scoped: true, semantics: 'default-on', valueType: 'boolean' },
  { name: 'isHomeFocusPillV1Enabled', area: 'home', envKeys: ['HOME_FOCUS_PILL_V1_ENABLED'], scoped: true, semantics: 'default-on', valueType: 'boolean' },
  { name: 'isDecisionStreakV1Enabled', area: 'decision-center', envKeys: ['DECISION_STREAK_V1_ENABLED'], scoped: true, semantics: 'default-on', valueType: 'boolean' },
  { name: 'isDecisionCenterGuidanceV1Enabled', area: 'decision-center', envKeys: ['DECISION_CENTER_GUIDANCE_V1_ENABLED'], scoped: true, semantics: 'default-on', valueType: 'boolean' },
  { name: 'isDecisionCenterDailyAttentionEnabled', area: 'decision-center', envKeys: ['DECISION_CENTER_DAILY_ATTENTION_ENABLED'], scoped: true, semantics: 'default-on', valueType: 'boolean' },
  { name: 'isSecretaryOrchestrationSnapshotV1Enabled', area: 'secretary', envKeys: ['SECRETARY_ORCHESTRATION_SNAPSHOT_V1_ENABLED'], scoped: true, semantics: 'default-on', valueType: 'boolean' },
  { name: 'isChatTurnContractEnabled', area: 'chat', envKeys: ['CHAT_TURN_CONTRACT_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatSkillResponsePolicyEnabled', area: 'chat', envKeys: ['CHAT_SKILL_RESPONSE_POLICY_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatContextCompilerEnabled', area: 'chat', envKeys: ['CHAT_CONTEXT_COMPILER_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatResearchRouterEnabled', area: 'chat', envKeys: ['CHAT_RESEARCH_ROUTER_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatQualityGateEnabled', area: 'chat', envKeys: ['CHAT_QUALITY_GATE_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatBilingualEvalGateEnabled', area: 'chat', envKeys: ['CHAT_BILINGUAL_EVAL_GATE_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatCoreV2ShadowRouteHookEnabled', area: 'chat-core-v2', envKeys: ['CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatCoreV2ShadowPlannerEnabled', area: 'chat-core-v2', envKeys: ['CHAT_CORE_V2_SHADOW_PLANNER_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isChatCoreV2Enabled', area: 'chat-core-v2', envKeys: ['CHAT_CORE_V2_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionCenterCommandBusEnabled', area: 'decision-center', envKeys: ['DECISION_CENTER_COMMAND_BUS_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionApiV2Enabled', area: 'decision-center', envKeys: ['DECISION_API_V2_ENABLED'], scoped: true, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isDecisionCenterFatigueCapsEnabled', area: 'decision-center', envKeys: ['DECISION_CENTER_FATIGUE_CAPS_ENABLED'], scoped: true, semantics: 'dark-cohort', valueType: 'boolean' },
  { name: 'isDecisionSemanticDedupEnabled', area: 'decision-center', envKeys: ['DECISION_SEMANTIC_DEDUP_ENABLED'], scoped: true, semantics: 'dark-cohort', valueType: 'boolean' },
  { name: 'isDecisionSemanticSupersedeEnabled', area: 'decision-center', envKeys: ['DECISION_SEMANTIC_SUPERSEDE_ENABLED'], scoped: true, semantics: 'dark-cohort', valueType: 'boolean' },
  { name: 'getDecisionConflictPolicyV1Mode', area: 'decision-center', envKeys: ['DECISION_CONFLICT_POLICY_V1_ENABLED'], scoped: true, semantics: 'mode', valueType: 'mode' },
  { name: 'isDecisionConflictPolicyV1Enabled', area: 'decision-center', envKeys: ['DECISION_CONFLICT_POLICY_V1_ENABLED'], scoped: true, semantics: 'derived', valueType: 'boolean' },
  { name: 'isDecisionConflictPolicyV1ShadowEnabled', area: 'decision-center', envKeys: ['DECISION_CONFLICT_POLICY_V1_ENABLED'], scoped: true, semantics: 'derived', valueType: 'boolean' },
  { name: 'isDecisionFlowV1EnforceEnabled', area: 'decision-center', envKeys: ['DECISION_FLOW_V1_ENFORCE_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isTrainingDecisionFlowV1EnforceEnabled', area: 'decision-center', envKeys: ['TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionLowRiskAutoResolutionEnabled', area: 'decision-center', envKeys: ['DECISION_LOW_RISK_AUTO_RESOLUTION_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'getSecretaryReasoningV1Mode', area: 'secretary', envKeys: ['SECRETARY_REASONING_V1_MODE'], scoped: true, semantics: 'mode', valueType: 'mode' },
  { name: 'getTrainingPlanRevisionV1Mode', area: 'training', envKeys: ['TRAINING_PLAN_REVISION_V1_MODE'], scoped: true, semantics: 'mode', valueType: 'mode' },
  { name: 'getTrainingExerciseIdentityV1Mode', area: 'training', envKeys: ['TRAINING_EXERCISE_IDENTITY_V1_MODE'], scoped: true, semantics: 'mode', valueType: 'mode' },
  { name: 'isTrainingTypedWorkoutV1Enabled', area: 'training', envKeys: ['TRAINING_TYPED_WORKOUT_V1_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'getTrainingAdaptationV1Mode', area: 'training', envKeys: ['TRAINING_ADAPTATION_V1_MODE'], scoped: true, semantics: 'mode', valueType: 'mode' },
  { name: 'isTrainingExerciseMediaV1Enabled', area: 'training', envKeys: ['TRAINING_EXERCISE_MEDIA_V1_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'getTrainingM4Allowlist', area: 'training', envKeys: ['TRAINING_PLAN_M4_ALLOWLIST'], scoped: true, semantics: 'value', valueType: 'list', redacted: true },
  { name: 'isTrainingM4ExplicitUserCapacityEnabled', area: 'training', envKeys: ['TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isTrainingPublicBetaV1Enabled', area: 'training', envKeys: ['TRAINING_PUBLIC_BETA_V1_ENABLED', 'TRAINING_TYPED_WORKOUT_V1_ENABLED', 'TRAINING_EXERCISE_MEDIA_V1_ENABLED', 'TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED'], scoped: false, semantics: 'boolean', valueType: 'boolean' },
  { name: 'isDecisionDashboardEnabled', area: 'decision-center', envKeys: ['DECISION_DASHBOARD_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionEvidenceFreshnessGateEnabled', area: 'decision-center', envKeys: ['DECISION_EVIDENCE_FRESHNESS_GATE_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionReconnectAffordanceEnabled', area: 'decision-center', envKeys: ['DECISION_RECONNECT_AFFORDANCE_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionChoiceOptionsEnabled', area: 'decision-center', envKeys: ['DECISION_CHOICE_OPTIONS_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionSkillCardsEnabled', area: 'decision-center', envKeys: ['DECISION_SKILL_CARDS_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionHumanReviewGateEnabled', area: 'decision-center', envKeys: ['DECISION_HUMAN_REVIEW_GATE_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionRefreshEnabled', area: 'decision-center', envKeys: ['DECISION_REFRESH_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionRollbackSnapshotProtectionEnabled', area: 'decision-center', envKeys: ['DECISION_ROLLBACK_SNAPSHOT_PROTECTION_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionTypeSuppressionEnabled', area: 'decision-center', envKeys: ['DECISION_TYPE_SUPPRESSION_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isNotificationPriorityShadowScoringEnabled', area: 'notifications', envKeys: ['NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED'], scoped: true, semantics: 'opt-in', valueType: 'boolean' },
  { name: 'isDecisionFeedbackSuppressionEnabled', area: 'decision-center', envKeys: ['DECISION_FEEDBACK_SUPPRESSION_ENABLED'], scoped: true, semantics: 'dark-cohort', valueType: 'boolean' },
]);

export type RuntimeFlagValue = boolean | number | string | string[] | Record<string, string> | null;

export interface RuntimeFlagReading extends RuntimeFlagCatalogEntry {
  value: RuntimeFlagValue;
  /** Whether each base env key is set at all (presence only, never the value). */
  envSet: Record<string, boolean>;
  /** Count of per-user / per-tenant override keys present for a scoped reader. */
  scopedOverrides: number;
  error?: string;
}

type FlagReader = (env: NodeJS.ProcessEnv) => unknown;

function normalizeValue(entry: RuntimeFlagCatalogEntry, raw: unknown): RuntimeFlagValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean' || typeof raw === 'number') return raw;
  if (typeof raw === 'string') return raw.slice(0, 64);
  if (Array.isArray(raw)) {
    if (entry.redacted) return `${raw.length} entries`;
    return raw.slice(0, 50).map((item) => String(item).slice(0, 64));
  }
  if (typeof raw === 'object') {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 50)) {
      out[String(key).slice(0, 64)] = String(value).slice(0, 64);
    }
    return out;
  }
  return String(raw).slice(0, 64);
}

function countScopedOverrides(entry: RuntimeFlagCatalogEntry, env: NodeJS.ProcessEnv): number {
  if (!entry.scoped) return 0;
  let count = 0;
  for (const key of Object.keys(env)) {
    for (const base of entry.envKeys) {
      if (key.startsWith(`${base}_USER_`) || key.startsWith(`${base}_TENANT_`)) count += 1;
    }
  }
  return count;
}

/** Reads every cataloged flag against `env` (defaults to process.env). Never throws. */
export function readRuntimeFlagCatalog(env: NodeJS.ProcessEnv = process.env): RuntimeFlagReading[] {
  const readers = runtimeFlags as unknown as Record<string, FlagReader | undefined>;
  return RUNTIME_FLAG_CATALOG.map((entry) => {
    const envSet: Record<string, boolean> = {};
    const reader = readers[entry.name];
    let value: RuntimeFlagValue = null;
    let error: string | undefined;
    let scopedOverrides = 0;
    try {
      for (const key of entry.envKeys) envSet[key] = env[key] !== undefined && env[key] !== '';
      scopedOverrides = countScopedOverrides(entry, env);
      if (typeof reader !== 'function') error = 'reader missing';
      else value = normalizeValue(entry, reader(env));
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 200) : 'read failed';
    }
    const reading: RuntimeFlagReading = { ...entry, value, envSet, scopedOverrides };
    if (error) reading.error = error;
    return reading;
  });
}

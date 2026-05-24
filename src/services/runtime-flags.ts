// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../config';

type RuntimeEnv = NodeJS.ProcessEnv;
const DEFAULT_AI_CALL_TIMEOUT_MS = 30_000;
export type ChatHybridPlannerMode = 'off' | 'shadow' | 'active';
export interface RuntimeFlagScope {
  userId?: number | string | null;
  tenantId?: number | string | null;
}

function parseOptionalBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

export function isAnthropicRuntimeEnabled(env: RuntimeEnv = process.env): boolean {
  return env.ANTHROPIC_ENABLED === 'true';
}

export function canUseAnthropicRuntimeFallback(env: RuntimeEnv = process.env): boolean {
  const explicitApiKeyProvided = Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY');
  const apiKey = explicitApiKeyProvided ? env.ANTHROPIC_API_KEY : config?.anthropic?.apiKey;
  return isAnthropicRuntimeEnabled(env) && Boolean(apiKey);
}

export function getAICallTimeoutMs(env: RuntimeEnv = process.env): number {
  const configuredFallback = config?.aiSafety?.callTimeoutMs ?? DEFAULT_AI_CALL_TIMEOUT_MS;
  const raw = env.AI_CALL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') {
    return configuredFallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : configuredFallback;
}

export function isTelegramLegacyDeliveryEnabled(env: RuntimeEnv = process.env): boolean {
  return env.TELEGRAM_LEGACY_DELIVERY === 'true';
}

export function areGlobalInvoiceVendorsEnabled(env: RuntimeEnv = process.env): boolean {
  return env.FISCAL_ENABLE_GLOBAL_BUILTIN_VENDORS === 'true';
}

export function getGeminiRoutingEnvOverride(env: RuntimeEnv = process.env): boolean | null {
  return parseOptionalBoolean(env.GEMINI_ROUTING_ENABLED);
}

export function getGeminiIncludeSecretaryEnvOverride(env: RuntimeEnv = process.env): boolean | null {
  return parseOptionalBoolean(env.GEMINI_INCLUDE_SECRETARY);
}

export function getGeminiDomainAllowlist(env: RuntimeEnv = process.env): string[] {
  const raw = env.GEMINI_DOMAINS;
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean);
}

export function getDomainProviderExperimentOverrides(env: RuntimeEnv = process.env): Record<string, string> {
  const raw = env.AI_DOMAIN_PROVIDER_OVERRIDES;
  if (!raw?.trim()) return {};
  const overrides: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const [domain, provider] = entry.split('=').map((part) => part?.trim());
    if (!domain || !provider) continue;
    overrides[domain] = provider;
  }
  return overrides;
}

export function isSecretaryHaikuRoutingEnabled(env: RuntimeEnv = process.env): boolean {
  return env.SECRETARY_HAIKU_ROUTING_ENABLED === 'true';
}

export function areModelProviderCallsDisabled(env: RuntimeEnv = process.env): boolean {
  return env.NEXUS_LOCAL_ALLOW_MODEL_CALLS === '0' || env.NEXUS_MODEL_FIXTURE_MODE === '1';
}

export function isContentForceDraftOnlyEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CONTENT_FORCE_DRAFT_ONLY', scope) === 'true';
}

export function isContentFreshResearchDisabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CONTENT_DISABLE_FRESH_RESEARCH', scope) === 'true';
}

export function isContentDeepResearchDisabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CONTENT_DISABLE_DEEP_RESEARCH', scope) === 'true';
}

export function isContentFullLongformDisabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CONTENT_DISABLE_FULL_YOUTUBE_LONGFORM', scope) === 'true';
}

export function isContentModelQualityAuditDisabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CONTENT_DISABLE_MODEL_QUALITY_AUDIT', scope) === 'true';
}

function scopedEnvValue(env: RuntimeEnv, key: string, scope?: RuntimeFlagScope): string | undefined {
  const userId = scope?.userId != null ? String(scope.userId).replace(/[^0-9A-Za-z_-]/g, '') : '';
  const tenantId = scope?.tenantId != null ? String(scope.tenantId).replace(/[^0-9A-Za-z_-]/g, '') : '';
  return (userId ? env[`${key}_USER_${userId}`] : undefined)
    ?? (tenantId ? env[`${key}_TENANT_${tenantId}`] : undefined)
    ?? env[key];
}

export function getChatHybridPlannerMode(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): ChatHybridPlannerMode {
  const raw = scopedEnvValue(env, 'CHAT_HYBRID_PLANNER_ENABLED', scope)?.trim().toLowerCase();
  if (raw === 'false' || raw === 'off' || raw === '0') return 'off';
  if (raw === 'shadow' || env.CHAT_HYBRID_SHADOW_MODE === 'true') return 'shadow';
  return 'active';
}

export function isChatHybridPlannerEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return getChatHybridPlannerMode(env, scope) !== 'off';
}

export function isChatLlmTier1Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_LLM_TIER1_ENABLED', scope) === 'true';
}

export function isChatLlmTier2Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_LLM_TIER2_ENABLED', scope) !== 'false';
}

export function isChatEscalationReviewerEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_ESCALATION_REVIEWER_ENABLED', scope) === 'true';
}

export function isChatOpenSurfaceHandoffEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_OPEN_SURFACE_HANDOFF_ENABLED', scope) !== 'false';
}

function scopedFlagEnabledByDefault(env: RuntimeEnv, key: string, scope?: RuntimeFlagScope): boolean {
  const raw = scopedEnvValue(env, key, scope)?.trim().toLowerCase();
  if (raw === 'false' || raw === 'off' || raw === '0') return false;
  return true;
}

export function isHomeDayDialV1Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByDefault(env, 'HOME_DAY_DIAL_V1_ENABLED', scope);
}

export function isProviderPreferencesV1Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByDefault(env, 'PROVIDER_PREFERENCES_V1_ENABLED', scope);
}

export function isHomeFocusPillV1Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByDefault(env, 'HOME_FOCUS_PILL_V1_ENABLED', scope);
}

export function isDecisionStreakV1Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByDefault(env, 'DECISION_STREAK_V1_ENABLED', scope);
}

export function isDecisionCenterGuidanceV1Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByDefault(env, 'DECISION_CENTER_GUIDANCE_V1_ENABLED', scope);
}

export function isDecisionCenterGuidanceSkillEnabled(
  sourceSkill: string | null | undefined,
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  const skillKey = String(sourceSkill ?? 'unknown')
    .trim()
    .replace(/[^0-9A-Za-z]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'UNKNOWN';
  return scopedFlagEnabledByDefault(env, `DECISION_CENTER_GUIDANCE_V1_${skillKey}_ENABLED`, scope);
}

export function isSecretaryOrchestrationSnapshotV1Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByDefault(env, 'SECRETARY_ORCHESTRATION_SNAPSHOT_V1_ENABLED', scope);
}

export function isChatTurnContractEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_TURN_CONTRACT_ENABLED', scope) !== 'false';
}

export function isChatSkillResponsePolicyEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_SKILL_RESPONSE_POLICY_ENABLED', scope) !== 'false';
}

export function isChatContextCompilerEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_CONTEXT_COMPILER_ENABLED', scope) !== 'false';
}

export function isChatResearchRouterEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_RESEARCH_ROUTER_ENABLED', scope) !== 'false';
}

export function isChatQualityGateEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_QUALITY_GATE_ENABLED', scope) !== 'false';
}

export function isChatBilingualEvalGateEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedEnvValue(env, 'CHAT_BILINGUAL_EVAL_GATE_ENABLED', scope) !== 'false';
}

export function isChatCoreV2ShadowRouteHookEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  const raw = scopedEnvValue(env, 'CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED', scope)?.trim().toLowerCase();
  return raw === 'true' || raw === 'on' || raw === '1' || raw === 'shadow';
}

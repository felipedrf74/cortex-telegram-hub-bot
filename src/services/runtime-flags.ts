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

export function isSecretaryHaikuRoutingEnabled(env: RuntimeEnv = process.env): boolean {
  return env.SECRETARY_HAIKU_ROUTING_ENABLED === 'true';
}

export function areModelProviderCallsDisabled(env: RuntimeEnv = process.env): boolean {
  return env.NEXUS_LOCAL_ALLOW_MODEL_CALLS === '0' || env.NEXUS_MODEL_FIXTURE_MODE === '1';
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

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

function scopedFlagEnabledByExplicitOptIn(env: RuntimeEnv, key: string, scope?: RuntimeFlagScope): boolean {
  const raw = scopedEnvValue(env, key, scope)?.trim().toLowerCase();
  return raw === 'true' || raw === 'on' || raw === '1' || raw === 'enabled';
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

export function isChatCoreV2Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'CHAT_CORE_V2_ENABLED', scope);
}

/**
 * Routes Decision Center actions through the committed Chat Core v2 Command Bus
 * (via decision-command-adapter) instead of the legacy in-module executors.
 * Default OFF; opt-in per user/tenant. A distinct flag (the CHAT_CORE_V2 regex
 * rejects this name) so it can be enabled for Decision Center independently.
 */
export function isDecisionCenterCommandBusEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_CENTER_COMMAND_BUS_ENABLED', scope);
}

/**
 * Honors the x-nexus-api-version: v2 Decision Center contract (compact cards on list/overview,
 * full item on detail, cursor pagination). Default OFF; opt-in per user/tenant so older iOS
 * clients keep the v1 shape until they ship v2 decoders.
 */
export function isDecisionApiV2Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_API_V2_ENABLED', scope);
}

/**
 * Applies C5 fatigue caps to the Decision Center OVERVIEW read path only: floored policy decisions
 * (floor_critical_deadline / floor_deadline_soon / floor_finance_risk / floor_connection_blocking /
 * floor_training_safety) ALWAYS surface, while non-floored items are bounded per-domain and to an
 * overall visible budget so the overview never floods. Pure post-ranking selection — never a re-rank.
 * The full `GET /decisions` list route stays UNCAPPED by design — it is the explicit "show everything"
 * view, distinct from the bounded overview dashboard. Default OFF; opt-in per user/tenant. When ON,
 * floored items count toward the visible budget but are never dropped (the total can exceed visibleCap
 * if floored.length does); non-floored items fill the remaining budget. Off => the existing
 * slice(0, limit) behavior is unchanged.
 */
export function isDecisionCenterFatigueCapsEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_CENTER_FATIGUE_CAPS_ENABLED', scope);
}

/**
 * Gates the B3 semantic-dedup classifier (decision-center-semantic-dedup.ts). The first slice is
 * classify-only with NO call sites, so this flag has no runtime effect yet; it reserves the name and
 * the scoped-opt-in shape for the later slice that wires the classifier into the creation/dedup path.
 * Default OFF; opt-in per user/tenant.
 */
export function isDecisionSemanticDedupEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_SEMANTIC_DEDUP_ENABLED', scope);
}

/**
 * Gates the B3 HIDING slice (decoupled from the advisory-linking slice above): on creation, a
 * newer_recommendation_supersedes_old verdict supersedes the OLDER same-recipe decision, and a
 * same_recommendation_update_existing verdict drops the new duplicate and returns the existing. Both are
 * same-skill+same-window+same-recipe ONLY (classifier-guaranteed) and NEVER supersede a policy-floored or a
 * different decision. Default OFF; opt-in per user/tenant — linking can stay ON without enabling hiding.
 */
export function isDecisionSemanticSupersedeEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_SEMANTIC_SUPERSEDE_ENABLED', scope);
}

/**
 * Gates the T14 operator dashboard read route (buildDecisionDashboardSnapshot). The route is
 * additionally admin-gated by the portal guard stack; this flag keeps the endpoint dark by default
 * until the dashboard is ready. Default OFF; opt-in per user/tenant.
 */
export function isDecisionDashboardEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_DASHBOARD_ENABLED', scope);
}

/**
 * Gates F2 evidence-freshness handling: when a decision's evidence is stale, the API downgrades a
 * write-capable actionability to preview_available so the client offers a Refresh affordance instead
 * of letting the user act on stale data. The gate only ever LOWERS actionability. Default OFF; opt-in
 * per user/tenant so the downgrade is a deliberate, reversible rollout.
 */
export function isDecisionEvidenceFreshnessGateEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_EVIDENCE_FRESHNESS_GATE_ENABLED', scope);
}

/**
 * Gates A2 reconnect-affordance: a `retry` action on a connection/sync-failure decision has no wired
 * deterministic executor, so instead of presenting a dead "retry" the API marks that action
 * `disabled_requires_reconnect` (a refinement within the existing disabled_* family) with reconnect
 * guidance, so the client can route the user to connection settings rather than a fake retry. The new
 * action effective-status value is only emitted when this flag is ON; OFF is byte-identical to today's
 * `disabled_not_implemented`. Default OFF; opt-in per user/tenant so iOS adds the case before the flip.
 */
export function isDecisionReconnectAffordanceEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_RECONNECT_AFFORDANCE_ENABLED', scope);
}

/**
 * Gates D (secretary choose-a-time) structured `DecisionOption[]` on the API item: the advisor's recommended
 * slot + ranked alternatives (each a window + tradeoff) surfaced as a choice UI, every option a lightweight
 * choose_another_time intent (no baked preview). Additive optional field — omitted from JSON when OFF, so
 * existing clients see a byte-identical payload. Default OFF; opt-in per user/tenant.
 */
export function isDecisionChoiceOptionsEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_CHOICE_OPTIONS_ENABLED', scope);
}

/**
 * Gates D (skill-specific) structured cards on the API item — the content pipeline card today (objectType /
 * editorialState / approvalState / reviewRequired / next action), extensible to finance/cooking later.
 * Additive optional field, omitted from JSON when OFF, so existing clients see a byte-identical payload.
 * Default OFF; opt-in per user/tenant.
 */
export function isDecisionSkillCardsEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_SKILL_CARDS_ENABLED', scope);
}

/**
 * Gates the F human-review fallback: when a decision's actionability is `requires_human_review` but no live
 * review queue exists, downgrade it to `unavailable` (manual-only) rather than show a review affordance that
 * can't be submitted. Defensive scaffolding (computeActionability does not emit requires_human_review today),
 * only ever LOWERS. Default OFF; opt-in per user/tenant.
 */
export function isDecisionHumanReviewGateEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_HUMAN_REVIEW_GATE_ENABLED', scope);
}

/**
 * Gates the Refresh-evidence endpoint (POST /decisions/:id/refresh): re-derives a decision's computed fields
 * (effectiveStatus / freshness / ranking / actionability) from CURRENT stored source state — token-zero, no
 * provider re-fetch — and returns the refreshed item. Read-only. Default OFF; opt-in per user/tenant.
 */
export function isDecisionRefreshEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_REFRESH_ENABLED', scope);
}

/**
 * B2 — gates rollback-snapshot protection: for a financial/sensitive decision, the secretary rollback
 * snapshot stored in action_result_json drops the free-text decision explanation (the most sensitive field),
 * keeping only the machine fields the rollback needs to restore state. Reduces sensitive plaintext at rest
 * without touching the undo path's correctness (the reader already tolerates a missing explanation). Default
 * OFF; opt-in per user/tenant. (Full at-rest encryption of the window/segments is a separate follow-up.)
 */
export function isDecisionRollbackSnapshotProtectionEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_ROLLBACK_SNAPSHOT_PROTECTION_ENABLED', scope);
}

/**
 * C3 — gates per-type suppression controls ("Don't show this type" / "Snooze this type"). When ON, the
 * user-facing Decision Center list + overview drop actively-suppressed (source_skill, type) recipes — EXCEPT
 * policy-floored decisions, which are never suppressible. Integrity/admin reads (release gate, dashboard
 * breakdowns, summary counts) are never filtered. OFF => the user-facing lists are unchanged. Default OFF.
 */
export function isDecisionTypeSuppressionEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_TYPE_SUPPRESSION_ENABLED', scope);
}


export function isChatCoreV2RuntimeFlagEnabled(
  flagKey: string,
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  const normalized = flagKey.trim().toUpperCase();
  if (!/^CHAT_CORE_V2_[0-9A-Z_]+$/.test(normalized)) return false;
  return scopedFlagEnabledByExplicitOptIn(env, normalized, scope);
}

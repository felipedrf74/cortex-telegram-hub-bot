// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../config';
import { getChatCapabilityRuntimeGuardStatus } from './chat-capability-runtime-guard';
import type { CoachingDiscipline } from './coach-kernel/types';
import type { TrainingPlanMode } from './training-workout-capability-registry';

type RuntimeEnv = NodeJS.ProcessEnv;
const DEFAULT_AI_CALL_TIMEOUT_MS = 30_000;
export type ChatHybridPlannerMode = 'off' | 'shadow' | 'active';
export interface RuntimeFlagScope {
  userId?: number | string | null;
  tenantId?: number | string | null;
}

export type SecretaryReasoningV1Mode = 'off' | 'shadow' | 'active';
export type DecisionConflictPolicyV1Mode = 'off' | 'shadow' | 'active';
export type TrainingPlanRevisionV1Mode = 'off' | 'shadow' | 'active';
export type TrainingAdaptationV1Mode = 'off' | 'shadow' | 'active';
export type TrainingExerciseIdentityV1Mode = 'off' | 'shadow' | 'active';
export const TRAINING_M4_PUBLIC_BETA_COMBINATIONS = [
  'event_based', 'continuous', 'maintenance', 'return_to_training',
].flatMap((mode) => [
  'running', 'cycling', 'swimming', 'strength', 'triathlon', 'hybrid', 'marathon',
].map((discipline) => `${mode}:${discipline}`)).sort();

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

function scopedDarkFlagEnabled(env: RuntimeEnv, key: string, scope?: RuntimeFlagScope): boolean {
  const raw = scopedEnvValue(env, key, scope)?.trim().toLowerCase();
  if (raw === 'true' || raw === 'on' || raw === '1' || raw === 'enabled') return true;
  if (raw === 'false' || raw === 'off' || raw === '0' || raw === 'disabled') return false;
  const cohortRaw = scopedEnvValue(env, `${key}_COHORT_PERCENT`, scope)
    ?? env.DECISION_CENTER_DARK_FLAGS_COHORT_PERCENT;
  const cohortPercent = Number.parseFloat(cohortRaw ?? '');
  if (!Number.isFinite(cohortPercent) || cohortPercent <= 0) return false;
  const subject = scope?.tenantId ?? scope?.userId;
  if (subject == null) return false;
  return stablePercentBucket(`${key}:${String(subject)}`) < Math.min(cohortPercent, 100);
}

function stablePercentBucket(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0;
  }
  return hash % 100;
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

export function isDecisionCenterDailyAttentionEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByDefault(env, 'DECISION_CENTER_DAILY_ATTENTION_ENABLED', scope);
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
  const enabled = raw === 'true' || raw === 'on' || raw === '1' || raw === 'shadow';
  if (!enabled) return false;
  return getChatCapabilityRuntimeGuardStatus(env).status !== 'forced_off';
}

export function isChatCoreV2ShadowPlannerEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  const raw = scopedEnvValue(env, 'CHAT_CORE_V2_SHADOW_PLANNER_ENABLED', scope)?.trim().toLowerCase();
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
 * full item on detail, cursor pagination). Only clients that explicitly send
 * the v2 header receive v2, so old clients retain v1 without a rollout flag.
 * The capability is active by default for explicit v2 callers. A global false
 * value is the authoritative emergency kill switch and cannot be overridden
 * by stale tenant/user opt-ins; otherwise the normal scoped precedence applies.
 */
export function isDecisionApiV2Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  const globalRaw = env.DECISION_API_V2_ENABLED?.trim().toLowerCase();
  if (globalRaw === 'false' || globalRaw === 'off' || globalRaw === '0' || globalRaw === 'disabled') return false;
  const raw = scopedEnvValue(env, 'DECISION_API_V2_ENABLED', scope)?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  if (raw === 'false' || raw === 'off' || raw === '0' || raw === 'disabled') return false;
  return raw === 'true' || raw === 'on' || raw === '1' || raw === 'enabled';
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
  return scopedDarkFlagEnabled(env, 'DECISION_CENTER_FATIGUE_CAPS_ENABLED', scope);
}

/**
 * Gates the B3 semantic-dedup classifier (decision-center-semantic-dedup.ts). The first slice is
 * classify-only with NO call sites, so this flag has no runtime effect yet; it reserves the name and
 * the scoped-opt-in shape for the later slice that wires the classifier into the creation/dedup path.
 * Default OFF; opt-in per user/tenant.
 */
export function isDecisionSemanticDedupEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedDarkFlagEnabled(env, 'DECISION_SEMANTIC_DEDUP_ENABLED', scope);
}

/**
 * Gates the B3 HIDING slice (decoupled from the advisory-linking slice above): on creation, a
 * newer_recommendation_supersedes_old verdict supersedes the OLDER same-recipe decision, and a
 * same_recommendation_update_existing verdict drops the new duplicate and returns the existing. Both are
 * same-skill+same-window+same-recipe ONLY (classifier-guaranteed) and NEVER supersede a policy-floored or a
 * different decision. Default OFF; opt-in per user/tenant — linking can stay ON without enabling hiding.
 */
export function isDecisionSemanticSupersedeEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedDarkFlagEnabled(env, 'DECISION_SEMANTIC_SUPERSEDE_ENABLED', scope);
}

/**
 * Staged normalized-action/conflict-policy rollout. Shadow performs the same scoped deterministic
 * classification and telemetry without changing persistence, visibility, or execution. Active may
 * persist the evaluation and change Decision Center presentation, but still grants no execution
 * authority. Only the documented off/shadow/active vocabulary is accepted;
 * boolean-like aliases fail closed to off.
 */
export function getDecisionConflictPolicyV1Mode(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): DecisionConflictPolicyV1Mode {
  const raw = scopedEnvValue(env, 'DECISION_CONFLICT_POLICY_V1_ENABLED', scope)?.trim().toLowerCase();
  if (raw === 'active') return 'active';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

export function isDecisionConflictPolicyV1Enabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return getDecisionConflictPolicyV1Mode(env, scope) === 'active';
}

export function isDecisionConflictPolicyV1ShadowEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return getDecisionConflictPolicyV1Mode(env, scope) === 'shadow';
}

/**
 * Enables optimistic record-version enforcement for Decision Center writes.
 * Supplying an expected version is always honored; this flag only controls
 * whether upgraded cohorts must supply one. Default OFF for legacy clients.
 */
export function isDecisionFlowV1EnforceEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_FLOW_V1_ENFORCE_ENABLED', scope);
}

function isExactPersonalRuntimeScope(scope?: RuntimeFlagScope): boolean {
  const userId = scope?.userId == null ? '' : String(scope.userId).trim();
  const tenantId = scope?.tenantId == null ? '' : String(scope.tenantId).trim();
  return Boolean(userId)
    && userId === tenantId
    && /^[0-9A-Za-z_-]+$/.test(userId);
}

/**
 * Training-only Decision Flow enforcement. Existing global/scoped Decision
 * enrollment remains authoritative for backward compatibility. The additive
 * Training flag can grant enforcement only to an exact personal scope, so it
 * cannot change non-Training or shared-tenant Decision Center behavior.
 */
export function isTrainingDecisionFlowV1EnforceEnabled(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  if (isDecisionFlowV1EnforceEnabled(env, scope)) return true;
  return isExactPersonalRuntimeScope(scope)
    && scopedFlagEnabledByExplicitOptIn(env, 'TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED', scope);
}

/** Global/scoped half of the two-key low-risk resolver gate. A persisted user preference is also required. */
export function isDecisionLowRiskAutoResolutionEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'DECISION_LOW_RISK_AUTO_RESOLUTION_ENABLED', scope);
}

/**
 * Structured Secretary reasoning rollout. `shadow` builds and observes the typed context snapshot
 * without changing the provider prompt; `active` requires a validated reasoning envelope before
 * serving a non-fastpath response. Default off and scope-overridable.
 */
export function getSecretaryReasoningV1Mode(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): SecretaryReasoningV1Mode {
  const raw = scopedEnvValue(env, 'SECRETARY_REASONING_V1_MODE', scope)?.trim().toLowerCase();
  if (raw === 'active') return 'active';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

/**
 * Additive Training plan-revision rollout. The default and every unrecognised
 * value fail closed to `off`. `shadow` may compute bounded diagnostics only;
 * durable revision writes and activation require the explicit `active` value.
 */
export function getTrainingPlanRevisionV1Mode(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): TrainingPlanRevisionV1Mode {
  const raw = scopedEnvValue(env, 'TRAINING_PLAN_REVISION_V1_MODE', scope)?.trim().toLowerCase();
  if (raw === 'active') return 'active';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

/**
 * Canonical Training exercise-identity rollout. The policy is deliberately
 * fail-closed: unset and unrecognised values are `off`; `shadow` may inspect
 * and report identity closure without rewriting or rejecting legacy payloads;
 * only the explicit `active` value may normalize or reject a new
 * prescription. Scope overrides follow the shared runtime-flag convention.
 */
export function getTrainingExerciseIdentityV1Mode(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): TrainingExerciseIdentityV1Mode {
  const raw = scopedEnvValue(env, 'TRAINING_EXERCISE_IDENTITY_V1_MODE', scope)?.trim().toLowerCase();
  if (raw === 'active') return 'active';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

/**
 * Milestone 2 typed phase/block/prescription generation and activation for
 * immutable revision candidates. It remains default off, scope-overridable,
 * and does not change legacy plan writers or existing active plans.
 */
export function isTrainingTypedWorkoutV1Enabled(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'TRAINING_TYPED_WORKOUT_V1_ENABLED', scope);
}

/**
 * Immutable Training adaptation proposals. `shadow` may evaluate policy and
 * telemetry only; proposal persistence, Decision binding, and activation all
 * require the explicit scoped `active` value. Unknown values fail closed.
 */
export function getTrainingAdaptationV1Mode(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): TrainingAdaptationV1Mode {
  const raw = scopedEnvValue(env, 'TRAINING_ADAPTATION_V1_MODE', scope)?.trim().toLowerCase();
  if (raw === 'active') return 'active';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

/**
 * Governs delivery of reviewed Training exercise-media metadata. The flag is
 * deliberately narrower than exercise identity and typed workouts: enabling
 * it cannot activate a draft manifest or bypass review/provenance/takedown
 * validation. Unset and unrecognised values remain off, with the standard
 * user/tenant override precedence.
 */
export function isTrainingExerciseMediaV1Enabled(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'TRAINING_EXERCISE_MEDIA_V1_ENABLED', scope);
}

/**
 * Milestone 4 mode/discipline enrollment. The value is an exact comma-separated
 * allowlist such as `maintenance:running,event_based:marathon`. Empty, wildcard
 * and malformed entries grant no authority. Scope resolution uses the same
 * user -> tenant -> global precedence as the parent Training flags.
 */
export function getTrainingM4Allowlist(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): string[] {
  const raw = scopedEnvValue(env, 'TRAINING_PLAN_M4_ALLOWLIST', scope);
  if (!raw?.trim()) return [];
  const modes = new Set(['event_based', 'continuous', 'maintenance', 'return_to_training']);
  const disciplines = new Set(['running', 'cycling', 'swimming', 'strength', 'triathlon', 'hybrid', 'marathon']);
  const entries = raw.split(',').map((entry) => entry.trim().toLowerCase());
  if (entries.some((entry) => {
    const parts = entry.split(':');
    return parts.length !== 2 || !modes.has(parts[0]) || !disciplines.has(parts[1]);
  })) return [];
  return [...new Set(entries)].sort();
}

/**
 * Optional provisional M4 availability path. It is deliberately independent
 * from M4 enrollment and default-off, so production can require complete
 * server-refreshed calendar conflict coverage for every candidate.
 */
export function isTrainingM4ExplicitUserCapacityEnabled(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED', scope);
}

export function isTrainingM4PlanCombinationAllowed(
  planMode: TrainingPlanMode,
  discipline: CoachingDiscipline,
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  return getTrainingM4Allowlist(env, scope).includes(`${planMode}:${discipline}`);
}

/** Modes introduced after the continuous single-discipline typed slice, plus
 * every composite discipline, always require explicit M4 enrollment even when
 * a client omits the additive M4 request fields. */
export function isTrainingM4OwnedCombination(
  planMode: TrainingPlanMode,
  discipline: CoachingDiscipline,
): boolean {
  if (!['event_based', 'continuous', 'maintenance', 'return_to_training'].includes(planMode)
      || !['running', 'marathon', 'cycling', 'swimming', 'strength', 'triathlon', 'hybrid'].includes(discipline)) {
    return false;
  }
  return planMode !== 'continuous'
    || discipline === 'triathlon'
    || discipline === 'hybrid'
    || discipline === 'marathon';
}

/**
 * All-or-nothing public-beta bundle. This helper intentionally reads global
 * values only; scoped overrides remain the separate explicit-enrollment path.
 * A malformed or partial bundle grants no authority.
 */
export function isTrainingPublicBetaV1Enabled(env: RuntimeEnv = process.env): boolean {
  const m4Allowlist = getTrainingM4Allowlist(env);
  return env.TRAINING_PUBLIC_BETA_V1_ENABLED?.trim().toLowerCase() === 'true'
    && getTrainingPlanRevisionV1Mode(env) === 'active'
    && env.TRAINING_TYPED_WORKOUT_V1_ENABLED?.trim().toLowerCase() === 'true'
    && getTrainingAdaptationV1Mode(env) === 'active'
    && getTrainingExerciseIdentityV1Mode(env) === 'active'
    && env.TRAINING_EXERCISE_MEDIA_V1_ENABLED?.trim().toLowerCase() === 'true'
    && env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED?.trim().toLowerCase() === 'true'
    && m4Allowlist.length === TRAINING_M4_PUBLIC_BETA_COMBINATIONS.length
    && m4Allowlist.every((entry, index) => entry === TRAINING_M4_PUBLIC_BETA_COMBINATIONS[index])
    && (env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY ?? '').length >= 32
    && !isTrainingM4ExplicitUserCapacityEnabled(env);
}

export function isTrainingPlanRevisionV1ExplicitlyEnrolled(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  const userId = scope?.userId != null ? String(scope.userId).replace(/[^0-9A-Za-z_-]/g, '') : '';
  const tenantId = scope?.tenantId != null ? String(scope.tenantId).replace(/[^0-9A-Za-z_-]/g, '') : '';
  const scopedRaw = (userId ? env[`TRAINING_PLAN_REVISION_V1_MODE_USER_${userId}`] : undefined)
    ?? (tenantId ? env[`TRAINING_PLAN_REVISION_V1_MODE_TENANT_${tenantId}`] : undefined);
  if (scopedRaw !== undefined) return scopedRaw.trim().toLowerCase() === 'active';
  return isExactPersonalRuntimeScope(scope) && isTrainingPublicBetaV1Enabled(env);
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
 * provider re-fetch — and persists changed context/lifecycle/version metadata. This is a mutation route.
 * Default OFF; opt-in per user/tenant.
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

/**
 * Shadow scoring for the notification priority model.
 *
 * When on, every evaluated intent is ALSO scored by
 * `notification-priority-model` and the verdict is recorded next to the
 * decision the delivery ladder actually took. Delivery is unchanged either way
 * — this exists so the model can be compared against real traffic before it is
 * allowed to decide anything.
 */
export function isNotificationPriorityShadowScoringEnabled(
  env: RuntimeEnv = process.env,
  scope?: RuntimeFlagScope,
): boolean {
  return scopedFlagEnabledByExplicitOptIn(env, 'NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED', scope);
}

/**
 * C3b/Phase 2 — uses aggregated feedback signals as a presentation-only
 * suppression input. Dark by default. Policy-floored decisions remain exempt.
 */
export function isDecisionFeedbackSuppressionEnabled(env: RuntimeEnv = process.env, scope?: RuntimeFlagScope): boolean {
  return scopedDarkFlagEnabled(env, 'DECISION_FEEDBACK_SUPPRESSION_ENABLED', scope);
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

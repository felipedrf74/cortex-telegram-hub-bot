// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Domain } from './types';

export type ChatCoreV2OrchestratorMode = 'off' | 'shadow' | 'canary' | 'on';

export type ChatCoreV2AllowedSurface = 'ios' | 'web';

export interface ChatCoreV2ActivationConfig {
  mode: ChatCoreV2OrchestratorMode;
  allowedSurfaces: ChatCoreV2AllowedSurface[];
  allowedDomains: ChatCoreV2Domain[];
  allowDeterministicReads: boolean;
  allowWritePreviews: boolean;
  allowWriteExecution: boolean;
  allowCloudFallback: boolean;
  disableNaturalLanguageTokenZero: boolean;
  forceClarificationOnPlanInvalid: boolean;
  forceEvidenceForFactualClaims: boolean;
  maxLocalPlannerMs: number;
  maxComposerMs: number;
  progressAfterMs: number;
  backgroundAfterMs: number;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_ALLOWED_SURFACES: ChatCoreV2AllowedSurface[] = ['ios', 'web'];
const DEFAULT_ALLOWED_DOMAINS: ChatCoreV2Domain[] = ['training', 'cooking', 'content', 'finance'];

const SURFACE_VALUES = new Set<ChatCoreV2AllowedSurface>(DEFAULT_ALLOWED_SURFACES);
const DOMAIN_VALUES = new Set<ChatCoreV2Domain>([
  'secretary',
  'tasks',
  'training',
  'content',
  'cooking',
  'finance',
  'connections',
  'notifications',
  'decision_center',
]);

export function resolveChatCoreV2ActivationConfig(env: EnvLike = process.env): ChatCoreV2ActivationConfig {
  const mode = parseMode(env.CHAT_CORE_V2_ORCHESTRATOR_MODE);
  const config: ChatCoreV2ActivationConfig = {
    mode,
    allowedSurfaces: parseEnumList(env.CHAT_CORE_V2_ALLOWED_SURFACES, SURFACE_VALUES, DEFAULT_ALLOWED_SURFACES),
    allowedDomains: parseEnumList(env.CHAT_CORE_V2_ALLOWED_DOMAINS, DOMAIN_VALUES, DEFAULT_ALLOWED_DOMAINS),
    allowDeterministicReads: parseBoolean(env.CHAT_CORE_V2_ALLOW_DETERMINISTIC_READS, true),
    allowWritePreviews: parseBoolean(env.CHAT_CORE_V2_ALLOW_WRITE_PREVIEWS, false),
    allowWriteExecution: parseBoolean(env.CHAT_CORE_V2_ALLOW_WRITE_EXECUTION, false),
    allowCloudFallback: parseBoolean(env.CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK, false),
    disableNaturalLanguageTokenZero: parseBoolean(env.CHAT_CORE_V2_DISABLE_NL_TOKEN_ZERO, true),
    forceClarificationOnPlanInvalid: parseBoolean(env.CHAT_CORE_V2_FORCE_CLARIFICATION_ON_PLAN_INVALID, true),
    forceEvidenceForFactualClaims: parseBoolean(env.CHAT_CORE_V2_FORCE_EVIDENCE_FOR_FACTUAL_CLAIMS, true),
    maxLocalPlannerMs: parsePositiveInt(env.CHAT_CORE_V2_MAX_LOCAL_PLANNER_MS, 15_000),
    maxComposerMs: parsePositiveInt(env.CHAT_CORE_V2_MAX_COMPOSER_MS, 15_000),
    progressAfterMs: parsePositiveInt(env.CHAT_CORE_V2_PROGRESS_AFTER_MS, 2_000),
    backgroundAfterMs: parsePositiveInt(env.CHAT_CORE_V2_BACKGROUND_AFTER_MS, 20_000),
  };

  if (mode !== 'off') return config;

  return {
    ...config,
    allowedSurfaces: [],
    allowedDomains: [],
    allowDeterministicReads: false,
    allowWritePreviews: false,
    allowWriteExecution: false,
    allowCloudFallback: false,
    disableNaturalLanguageTokenZero: false,
    forceClarificationOnPlanInvalid: false,
    forceEvidenceForFactualClaims: false,
  };
}

/**
 * Per-tenant runtime override record (WP-07, OD-1). An override may only DEMOTE
 * a tenant's serving (force it off/shadow, pin the planner to repair-only, or
 * shadow specific languages) — it can NEVER promote a tenant past the env mode.
 * The override is in-process only (intentionally wiped on restart; the durable
 * record is the persisted `chat_v2_auto_revert_decisions` row).
 */
export interface ChatCoreV2TenantOverride {
  /** A demotion target. 'off' or 'shadow' both force the live parsers off. */
  mode?: 'shadow' | 'off';
  /** Pin the local planner to schema-repair-only (no fresh generation). */
  plannerPinnedToRepairOnly?: boolean;
  /** Languages demoted to shadow for this tenant. */
  languageShadow?: string[];
  /**
   * Per-tenant allowedDomains narrowing (WP-16 §5.J). When present, the
   * orchestration gate intersects the global CHAT_CORE_V2_ALLOWED_DOMAINS with
   * this list for THIS tenant only — so a single tenant can be confined to a
   * subset of the global surface without touching any other tenant. Like every
   * other override field this can only NARROW (intersect), never expand past the
   * global set, so it can never promote a tenant past the env allowlist.
   */
  allowedDomains?: ChatCoreV2Domain[];
}

/**
 * Module-scoped per-tenant override Map (WP-07/§5.J), keyed by tenantId. A flip
 * for tenant A mutates ONLY tenant A's entry; tenant B is untouched. This is the
 * seam that lets the auto-revert valve stop a single tenant's live serving
 * WITHOUT a process restart, because the two live parsers route their kill-switch
 * decision through `isChatCoreV2MasterKillSwitchOff`, which consults this Map.
 */
const _runtimeOverrides = new Map<string /* tenantId */, ChatCoreV2TenantOverride>();

/** Set (replace) the per-tenant runtime override for a single tenant. */
export function setChatCoreV2RuntimeOverride(tenantId: string, override: ChatCoreV2TenantOverride): void {
  _runtimeOverrides.set(tenantId, { ...override });
}

/** Clear the per-tenant runtime override for a single tenant. */
export function clearChatCoreV2RuntimeOverride(tenantId: string): void {
  _runtimeOverrides.delete(tenantId);
}

/** Read the per-tenant runtime override for a single tenant (undefined = none). */
export function getChatCoreV2RuntimeOverride(tenantId: string): ChatCoreV2TenantOverride | undefined {
  const value = _runtimeOverrides.get(tenantId);
  return value ? { ...value } : undefined;
}

/** Whether this tenant's local planner is pinned to schema-repair-only. */
export function isPlannerPinnedToRepairOnly(tenantId: string): boolean {
  return _runtimeOverrides.get(tenantId)?.plannerPinnedToRepairOnly === true;
}

/** Whether this tenant has demoted the given language to shadow. */
export function isLanguageShadowOverrideSet(tenantId: string, language: string): boolean {
  const languages = _runtimeOverrides.get(tenantId)?.languageShadow;
  return Array.isArray(languages) && languages.includes(language);
}

/** Test-only: wipe every per-tenant runtime override (use in afterEach). */
export function _resetChatCoreV2RuntimeOverridesForTests(): void {
  _runtimeOverrides.clear();
}

/**
 * Whether a per-tenant runtime override DEMOTES this tenant's live serving off
 * (override mode is 'off' or 'shadow'). Either value forces the live parsers off
 * for that tenant: 'off' is a hard stop, 'shadow' demotes a live (enforce/on)
 * path back to observe-only, and a shadow path is already non-serving on the live
 * read/write fast paths.
 */
function isTenantOverrideForcingOff(tenantId: string | undefined): boolean {
  if (tenantId === undefined) return false;
  const mode = _runtimeOverrides.get(tenantId)?.mode;
  return mode === 'off' || mode === 'shadow';
}

/**
 * The single master kill-switch chokepoint for the live chat entry parsers
 * (resolveChatCoreV2LocalChatLlmMode / resolveChatCoreV2ActionGatewayMode).
 *
 * Returns true (kill) when EITHER:
 *  (a) CHAT_CORE_V2_ORCHESTRATOR_MODE is EXPLICITLY 'off' (existing behavior), OR
 *  (b) a tenantId is supplied AND that tenant's runtime override forces off/shadow
 *      (WP-07 per-tenant demotion — reaches the live path without a restart).
 *
 * KILL-SWITCH PRECEDENCE: an explicit env 'off' always wins. An override can only
 * DEMOTE (force off/shadow); it can NEVER promote — it cannot make an env-off path
 * active (the env check below already returns true for env-off regardless of the
 * Map, and the Map only ever ADDS a kill, never removes one).
 *
 * An ABSENT env mode is intentionally NOT a kill: it defers to the sub-mode flags
 * (action gateway / local-chat / the legacy CHAT_CORE_V2_ENABLED activation),
 * preserving existing behavior. The optional tenantId is additive — existing
 * 1-arg callers keep their exact behavior. Strict default-off subordination
 * (absent master => all sub-modes off) is a separate, deliberate change and is
 * intentionally NOT folded in here.
 */
export function isChatCoreV2MasterKillSwitchOff(env: EnvLike = process.env, tenantId?: string): boolean {
  if (String(env.CHAT_CORE_V2_ORCHESTRATOR_MODE ?? '').trim().toLowerCase() === 'off') return true;
  return isTenantOverrideForcingOff(tenantId);
}

function parseMode(raw: string | undefined): ChatCoreV2OrchestratorMode {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === 'shadow' || normalized === 'canary' || normalized === 'on' ? normalized : 'off';
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnumList<T extends string>(raw: string | undefined, allowed: ReadonlySet<T>, fallback: T[]): T[] {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value): value is T => allowed.has(value as T));
  return values.length > 0 ? [...new Set(values)] : [...fallback];
}

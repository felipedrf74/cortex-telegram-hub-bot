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

function parseMode(raw: string | undefined): ChatCoreV2OrchestratorMode {
  return raw === 'shadow' || raw === 'canary' || raw === 'on' ? raw : 'off';
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

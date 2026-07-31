// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';

export const CHAT_LIVE_EVAL_CONTRACT_VERSION = 'chat-live-eval-v1';

export const CHAT_LIVE_EVAL_LOCAL_BUDGET = Object.freeze({
  totalCeilingUsd: 0.000001,
  targetCeilingUsd: 0.000001,
  judgeCeilingUsd: 0,
});

export const CHAT_LIVE_EVAL_REAL_BUDGET = Object.freeze({
  totalCeilingUsd: 0.50,
  targetCeilingUsd: 0.45,
  judgeCeilingUsd: 0.05,
});

export const CHAT_LIVE_EVAL_SCENARIO_IDS = Object.freeze([
  'morning_planning',
  'training_adjustment',
  'cooking_fueling',
  'content_creator_day',
  'finance_schedule',
  'prompt_injection',
  'frustrated_contradictory',
] as const);

export type ChatLiveEvalMode = 'local_engine' | 'real_provider';
export type ChatLiveEvalPhase = 'preflight' | 'reset' | 'turn' | 'evidence';
export type ChatLiveEvalScenarioId = typeof CHAT_LIVE_EVAL_SCENARIO_IDS[number];

export const CHAT_LIVE_EVAL_REQUIRED_TARGET_PROVIDER_SCENARIO_ID: ChatLiveEvalScenarioId = 'content_creator_day';
const CHAT_LIVE_EVAL_REQUIRED_TARGET_PROVIDER_JOB_NAME =
  `chat_live_eval:${CHAT_LIVE_EVAL_REQUIRED_TARGET_PROVIDER_SCENARIO_ID}`;

export interface ChatLiveEvalBudget {
  totalCeilingUsd: number;
  targetCeilingUsd: number;
  judgeCeilingUsd: number;
}

export interface ChatLiveEvalRequestContext {
  version: typeof CHAT_LIVE_EVAL_CONTRACT_VERSION;
  mode: ChatLiveEvalMode;
  runId: string;
  scenarioId: ChatLiveEvalScenarioId | null;
  budget: ChatLiveEvalBudget;
  targetBaseCategory: 'chat_live_eval_local' | 'chat_live_eval_real';
  providerPolicy: 'ollama_only_zero_cloud' | 'metered_cloud_only';
  userId: number;
  tenantId: number;
  productionDataUsed: false;
}

export class ChatLiveEvalContractError extends Error {
  constructor(
    readonly code: 'CHAT_LIVE_EVAL_INVALID' | 'CHAT_LIVE_EVAL_DISABLED',
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
    this.name = 'ChatLiveEvalContractError';
  }
}

type HeaderReader = (name: string) => string | undefined;

const CONTRACT_HEADERS = [
  'x-nexus-chat-eval-contract',
  'x-nexus-chat-eval-mode',
  'x-nexus-chat-eval-run-id',
  'x-nexus-chat-eval-total-budget-usd',
  'x-nexus-chat-eval-target-budget-usd',
  'x-nexus-chat-eval-judge-budget-usd',
  'x-nexus-chat-eval-scenario-id',
] as const;

const ROUTING_KEYS = [
  'AI_CLASSIFY_PRIMARY', 'AI_CLASSIFY_FALLBACK',
  'AI_CHAT_PRIMARY', 'AI_CHAT_FALLBACK',
  'AI_TOOL_USE_PRIMARY', 'AI_TOOL_USE_FALLBACK',
] as const;

const CLOUD_CREDENTIAL_KEYS = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
] as const;

function header(readHeader: HeaderReader, name: string): string {
  return String(readHeader(name) ?? '').trim();
}

export function hasChatLiveEvalHeaders(readHeader: HeaderReader): boolean {
  return CONTRACT_HEADERS.some((name) => header(readHeader, name).length > 0);
}

function failInvalid(message: string): never {
  throw new ChatLiveEvalContractError('CHAT_LIVE_EVAL_INVALID', message, 400);
}

function failDisabled(message: string): never {
  throw new ChatLiveEvalContractError('CHAT_LIVE_EVAL_DISABLED', message, 403);
}

function exactNumber(value: string, expected: number): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === expected;
}

function normalizedEnv(env: NodeJS.ProcessEnv, key: string): string {
  return String(env[key] ?? '').trim().toLowerCase();
}

function assertCommonScope(input: {
  env: NodeJS.ProcessEnv;
  userId: number;
  tenantId: number;
  principalEmail: string | null;
}): void {
  if (
    normalizedEnv(input.env, 'NODE_ENV') === 'production'
    || normalizedEnv(input.env, 'NEXUS_ENV') === 'production'
  ) {
    failDisabled('Chat live evaluation is disabled in production.');
  }
  if (
    !Number.isSafeInteger(input.userId)
    || input.userId <= 0
    || input.tenantId !== input.userId
  ) {
    failDisabled('Chat live evaluation requires one authenticated dedicated user and tenant.');
  }
  if (!input.principalEmail) {
    failDisabled('Chat live evaluation requires an authenticated dedicated principal.');
  }
}

function assertLocalRuntime(input: {
  env: NodeJS.ProcessEnv;
  principalEmail: string;
  isLoopback: boolean;
  isLocalDockerGateway: boolean;
}): void {
  const explicitlyAllowedDockerGateway = input.isLocalDockerGateway
    && normalizedEnv(input.env, 'NODE_ENV') === 'development'
    && input.env.NEXUS_CHAT_EVAL_ALLOW_DOCKER_GATEWAY === '1';
  if (!input.isLoopback && !explicitlyAllowedDockerGateway) {
    failDisabled('Local chat evaluation is restricted to loopback requests.');
  }
  if (
    !['development', 'test'].includes(normalizedEnv(input.env, 'NODE_ENV'))
    || input.env.NEXUS_LOCAL_ALLOW_MODEL_CALLS !== '1'
    || normalizedEnv(input.env, 'OLLAMA_ENABLED') !== 'true'
  ) {
    failDisabled('Local chat evaluation requires the explicitly enabled non-production Ollama runtime.');
  }
  const expectedEmail = String(input.env.NEXUS_LOCAL_IOS_EMAIL || 'nexushubbot@gmail.com').trim().toLowerCase();
  if (input.principalEmail.trim().toLowerCase() !== expectedEmail) {
    failDisabled('Local chat evaluation requires the dedicated local debug principal.');
  }
  if (
    ROUTING_KEYS.some((key) => {
      const expected = key.endsWith('_PRIMARY') ? 'ollama' : 'none';
      return normalizedEnv(input.env, key) !== expected;
    })
    || CLOUD_CREDENTIAL_KEYS.some((key) => String(input.env[key] ?? '').trim().length > 0)
    || normalizedEnv(input.env, 'ANTHROPIC_ENABLED') === 'true'
  ) {
    failDisabled('Local chat evaluation requires Ollama-only routing with zero cloud credentials.');
  }
}

function assertRealRuntime(input: {
  env: NodeJS.ProcessEnv;
  userId: number;
  tenantId: number;
  principalEmail: string;
}): void {
  const staging = normalizedEnv(input.env, 'NODE_ENV') === 'staging'
    || normalizedEnv(input.env, 'STAGING') === 'true'
    || input.env.STAGING === '1';
  if (!staging) {
    failDisabled('Real-provider chat evaluation is restricted to staging.');
  }
  const dedicatedId = Number(String(input.env.CHAT_EVAL_DEDICATED_TENANT_ID ?? '').trim());
  if (
    !Number.isSafeInteger(dedicatedId)
    || dedicatedId <= 0
    || input.userId !== dedicatedId
    || input.tenantId !== dedicatedId
    || !input.principalEmail.trim().toLowerCase().endsWith('.invalid')
  ) {
    failDisabled('Real-provider chat evaluation requires the configured dedicated synthetic tenant.');
  }
  const routedProviders = ROUTING_KEYS
    .map((key) => normalizedEnv(input.env, key))
    .filter((value) => value && value !== 'none');
  if (
    routedProviders.length === 0
    || routedProviders.some((provider) => provider === 'ollama')
    || !CLOUD_CREDENTIAL_KEYS.some((key) => String(input.env[key] ?? '').trim().length > 0)
  ) {
    failDisabled('Real-provider chat evaluation requires configured metered cloud-only routing.');
  }
}

export function resolveChatLiveEvalRequest(input: {
  readHeader: HeaderReader;
  phase: ChatLiveEvalPhase;
  userId: number;
  tenantId: number;
  principalEmail: string | null;
  isLoopback: boolean;
  isLocalDockerGateway?: boolean;
  env?: NodeJS.ProcessEnv;
}): ChatLiveEvalRequestContext | null {
  const values = Object.fromEntries(CONTRACT_HEADERS.map((name) => [name, header(input.readHeader, name)]));
  const anyHeader = hasChatLiveEvalHeaders(input.readHeader);
  if (!anyHeader) return null;

  const env = input.env ?? process.env;
  assertCommonScope({ ...input, env });
  if (values['x-nexus-chat-eval-contract'] !== CHAT_LIVE_EVAL_CONTRACT_VERSION) {
    failInvalid('Chat live-evaluation contract version did not match.');
  }
  const mode = values['x-nexus-chat-eval-mode'];
  if (mode !== 'local_engine' && mode !== 'real_provider') {
    failInvalid('Chat live-evaluation mode did not match the governed contract.');
  }
  const runId = values['x-nexus-chat-eval-run-id'];
  if (!/^chat-eval-[a-zA-Z0-9._:-]{8,120}$/.test(runId)) {
    failInvalid('Chat live-evaluation run id is invalid.');
  }
  const budget = mode === 'local_engine' ? CHAT_LIVE_EVAL_LOCAL_BUDGET : CHAT_LIVE_EVAL_REAL_BUDGET;
  if (
    !exactNumber(values['x-nexus-chat-eval-total-budget-usd'], budget.totalCeilingUsd)
    || !exactNumber(values['x-nexus-chat-eval-target-budget-usd'], budget.targetCeilingUsd)
    || !exactNumber(values['x-nexus-chat-eval-judge-budget-usd'], budget.judgeCeilingUsd)
  ) {
    failInvalid('Chat live-evaluation budget headers did not match the exact governed split.');
  }

  const rawScenarioId = values['x-nexus-chat-eval-scenario-id'];
  const requiresScenario = input.phase === 'turn' || input.phase === 'reset';
  if (requiresScenario && !CHAT_LIVE_EVAL_SCENARIO_IDS.includes(rawScenarioId as ChatLiveEvalScenarioId)) {
    failInvalid('Chat live-evaluation scenario is missing or not allowlisted.');
  }
  if (!requiresScenario && rawScenarioId) {
    failInvalid('Chat live-evaluation scenario is not valid for this contract phase.');
  }

  if (mode === 'local_engine') {
    assertLocalRuntime({
      env,
      principalEmail: input.principalEmail!,
      isLoopback: input.isLoopback,
      isLocalDockerGateway: input.isLocalDockerGateway === true,
    });
  } else {
    assertRealRuntime({
      env,
      userId: input.userId,
      tenantId: input.tenantId,
      principalEmail: input.principalEmail!,
    });
  }

  return {
    version: CHAT_LIVE_EVAL_CONTRACT_VERSION,
    mode,
    runId,
    scenarioId: requiresScenario ? rawScenarioId as ChatLiveEvalScenarioId : null,
    budget,
    targetBaseCategory: mode === 'local_engine' ? 'chat_live_eval_local' : 'chat_live_eval_real',
    providerPolicy: mode === 'local_engine' ? 'ollama_only_zero_cloud' : 'metered_cloud_only',
    userId: input.userId,
    tenantId: input.tenantId,
    productionDataUsed: false,
  };
}

export interface ChatLiveEvalRunEvidence {
  version: typeof CHAT_LIVE_EVAL_CONTRACT_VERSION;
  runId: string;
  mode: ChatLiveEvalMode;
  attested: boolean;
  reasons: string[];
  productionDataUsed: false;
  totalCeilingUsd: number;
  judgeCeilingUsd: number;
  target: {
    ceilingUsd: number;
    actualSpendUsd: number;
    reservedAttemptCeilingUsd: number;
    committedCeilingUsd: number;
    usageCallCount: number;
    providerAttemptCount: number;
    unresolvedPricingCount: number;
    providers: string[];
  };
  preparation: {
    scenarioCount: number;
    scenarioIds: string[];
    seedProfileVersions: string[];
    seedProfileHashes: string[];
    aggregateResetCounts: Record<string, number>;
  };
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

export function readChatLiveEvalRunEvidence(
  db: Database.Database,
  context: ChatLiveEvalRequestContext,
): ChatLiveEvalRunEvidence {
  const reasons: string[] = [];
  const usageColumns = tableColumns(db, 'api_usage');
  const hasUsageTenantAttribution = usageColumns.has('tenant_id');
  if (!hasUsageTenantAttribution) {
    reasons.push('api_usage_tenant_attribution_unavailable');
  }
  const usageCategoryProjection = usageColumns.has('category')
    ? "lower(trim(COALESCE(category, '')))"
    : "''";
  const usageRows: Array<{
    provider: string;
    cost_usd: number;
    pricing_status: string;
    job_name: string;
    category: string;
  }> = hasUsageTenantAttribution
    ? db.prepare(`
        SELECT
          lower(trim(COALESCE(provider, ''))) AS provider,
          COALESCE(cost_usd, 0) AS cost_usd,
          lower(trim(COALESCE(pricing_status, ''))) AS pricing_status,
          trim(COALESCE(job_name, '')) AS job_name,
          ${usageCategoryProjection} AS category
        FROM api_usage
        WHERE user_id = ?
          AND request_source = ?
          AND base_category = ?
          AND run_id = ?
          AND tenant_id = ?
      `).all(
        context.userId,
        'interactive',
        context.targetBaseCategory,
        context.runId,
        context.tenantId,
      ) as Array<{
        provider: string;
        cost_usd: number;
        pricing_status: string;
        job_name: string;
        category: string;
      }>
    : [];

  const attemptRows = tableColumns(db, 'ai_provider_attempt_reservations').size > 0
    ? db.prepare(`
        SELECT
          lower(trim(COALESCE(provider, ''))) AS provider,
          COALESCE(reserved_cost_usd, 0) AS reserved_cost_usd,
          trim(COALESCE(job_name, '')) AS job_name
        FROM ai_provider_attempt_reservations
        WHERE user_id = ?
          AND request_source = ?
          AND base_category = ?
          AND run_id = ?
      `).all(context.userId, 'interactive', context.targetBaseCategory, context.runId) as Array<{
        provider: string;
        reserved_cost_usd: number;
        job_name: string;
      }>
    : [];

  const actualSpendUsd = roundUsd(usageRows.reduce((total, row) => total + Number(row.cost_usd || 0), 0));
  const reservedAttemptCeilingUsd = roundUsd(
    attemptRows.reduce((total, row) => total + Number(row.reserved_cost_usd || 0), 0),
  );
  const committedCeilingUsd = roundUsd(actualSpendUsd + reservedAttemptCeilingUsd);
  const providers = [...new Set([
    ...usageRows.map((row) => row.provider),
    ...attemptRows.map((row) => row.provider),
  ].filter(Boolean))].sort();
  const unresolvedPricingCount = context.mode === 'real_provider'
    ? usageRows.filter((row) => row.pricing_status !== 'resolved').length
    : 0;

  const preparationRows = tableColumns(db, 'chat_live_eval_preparations').size > 0
    ? db.prepare(`
        SELECT scenario_id, seed_profile_version, seed_profile_hash, reset_counts_json
          FROM chat_live_eval_preparations
         WHERE run_id = ? AND mode = ? AND user_id = ? AND tenant_id = ?
         ORDER BY scenario_id ASC
      `).all(context.runId, context.mode, context.userId, context.tenantId) as Array<{
        scenario_id: string;
        seed_profile_version: string;
        seed_profile_hash: string;
        reset_counts_json: string;
      }>
    : [];
  const aggregateResetCounts: Record<string, number> = {};
  for (const row of preparationRows) {
    try {
      const parsed = JSON.parse(row.reset_counts_json) as Record<string, unknown>;
      for (const [key, raw] of Object.entries(parsed)) {
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 0) continue;
        aggregateResetCounts[key] = (aggregateResetCounts[key] ?? 0) + value;
      }
    } catch {
      reasons.push('invalid_scenario_preparation_evidence');
    }
  }

  if (usageRows.length === 0) reasons.push('no_target_provider_usage');
  if (attemptRows.length === 0) reasons.push('no_target_provider_attempt');
  if (!usageRows.some((row) => row.job_name === CHAT_LIVE_EVAL_REQUIRED_TARGET_PROVIDER_JOB_NAME)) {
    reasons.push('missing_required_target_provider_scenario_usage');
  }
  if (!attemptRows.some((row) => row.job_name === CHAT_LIVE_EVAL_REQUIRED_TARGET_PROVIDER_JOB_NAME)) {
    reasons.push('missing_required_target_provider_scenario_attempt');
  }
  if (
    context.mode === 'local_engine'
    && !usageRows.some((row) => (
      row.job_name === CHAT_LIVE_EVAL_REQUIRED_TARGET_PROVIDER_JOB_NAME
      && row.provider === 'ollama'
      && row.category === 'chat_content_model_authored_short'
    ))
  ) {
    reasons.push('missing_required_local_model_authored_response_usage');
  }
  if (preparationRows.length === 0) reasons.push('no_scenario_preparation_evidence');
  if (unresolvedPricingCount > 0) reasons.push('unresolved_provider_pricing');
  if (committedCeilingUsd > context.budget.targetCeilingUsd + Number.EPSILON) {
    reasons.push('target_cost_ceiling_exceeded');
  }
  if (context.mode === 'local_engine') {
    if (providers.some((provider) => provider !== 'ollama')) {
      reasons.push('local_non_ollama_provider_observed');
    }
    if (actualSpendUsd !== 0 || reservedAttemptCeilingUsd !== 0) {
      reasons.push('local_nonzero_spend_observed');
    }
  } else if (providers.some((provider) => !['anthropic', 'gemini', 'openai'].includes(provider))) {
    reasons.push('real_non_cloud_provider_observed');
  }

  return {
    version: CHAT_LIVE_EVAL_CONTRACT_VERSION,
    runId: context.runId,
    mode: context.mode,
    attested: reasons.length === 0,
    reasons,
    productionDataUsed: false,
    totalCeilingUsd: context.budget.totalCeilingUsd,
    judgeCeilingUsd: context.budget.judgeCeilingUsd,
    target: {
      ceilingUsd: context.budget.targetCeilingUsd,
      actualSpendUsd,
      reservedAttemptCeilingUsd,
      committedCeilingUsd,
      usageCallCount: usageRows.length,
      providerAttemptCount: attemptRows.length,
      unresolvedPricingCount,
      providers,
    },
    preparation: {
      scenarioCount: preparationRows.length,
      scenarioIds: preparationRows.map((row) => row.scenario_id),
      seedProfileVersions: [...new Set(preparationRows.map((row) => row.seed_profile_version))].sort(),
      seedProfileHashes: [...new Set(preparationRows.map((row) => row.seed_profile_hash))].sort(),
      aggregateResetCounts,
    },
  };
}

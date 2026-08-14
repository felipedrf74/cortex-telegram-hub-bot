// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHmac } from 'crypto';
import Database from 'better-sqlite3';

import { config } from '../../config';
import { logger } from '../../utils/logger';
import {
  isChatCoreV2ShadowPlannerEnabled,
  isChatCoreV2ShadowRouteHookEnabled,
  type RuntimeFlagScope,
} from '../runtime-flags';
import { ensureActiveProvider } from '../provider-registry';
import { getDb } from '../database';
import {
  buildChatCoreV2WirePlannerSystemPrompt,
  CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS,
  CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA,
} from './plan-schema';
import {
  planChatCoreV2ShadowTurn,
  planChatCoreV2ShadowTurnWithPlanner,
  type ChatCoreV2ShadowRunPlanner,
  type ChatCoreV2ShadowTurnInput,
  type ChatCoreV2ShadowTurnResult,
} from './shadow-orchestrator';
import {
  recordChatCoreV2ShadowReplay,
  type ChatCoreV2ShadowReplayResponse,
} from './shadow-replay';
import { classifyShadowRoute, type ChatCoreV2ShadowRouteGuess } from './shadow-route-classifier';
import {
  buildRoutingDivergenceShadowRecord,
  type RoutingDivergenceShadowDeps,
  type RoutingDivergenceShadowRecord,
} from '../intent-resolution/divergence-shadow';
import { maybeEmitPrepassRecallMiss } from './prepass-miss-store';
import {
  resolveChatCoreV2ActivationConfig,
  isChatCoreV2MasterKillSwitchOff,
} from './activation-flags';
import { recordChatV2TraceSpan } from './trace-recorder';
import { runWithLocalInferenceSlot } from './local-inference-concurrency-gate';
import type { ChatV2TraceSpan } from './types';
import type { RoutingSyntheticQaTrafficProvenance } from '../routing-synthetic-qa-contract';
import { runWithSkillInferenceAccountAdmission } from '../skill-inference-service';

export const CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION = 'chat_core_v2_shadow_route_hook@1.0.0';
const CHAT_CORE_V2_SHADOW_ROUTE_HASH_VERSION = 'hmac_sha256@1';

export interface RunChatCoreV2ShadowRouteHookInput {
  normalizedText: string;
  userId: number;
  tenantId: number;
  chatRequestId: string;
  userMessageId: string;
  clientMessageId?: string | null;
  attachmentsCount?: number;
  locale?: string | null;
  timezone?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  db?: Database.Database;
  /**
   * Batch-A TESTABILITY SEAM (default undefined => production behavior).
   *
   * The live route NEVER sets these. When the triple-gated shadow-planner side
   * effect is dispatched (fire-and-forget), it is run through these injectable
   * deps so unit tests can:
   *   - substitute a fake planner (`shadowPlannerDeps.runPlanner`) so the real
   *     Ollama transport is never hit in tests, and
   *   - observe the background promise settling (`onShadowPlannerSettled`)
   *     WITHOUT the synchronous live caller ever awaiting it.
   *
   * Because the live route omits both, runtime behavior is identical to having
   * no seam at all; only the dispatched (already triple-gated) side effect is
   * affected. These NEVER cause a planner dispatch on their own — the triple
   * gate still has to pass first.
   */
  shadowPlannerDeps?: ShadowPlannerSideEffectDeps;
  onShadowPlannerSettled?: (promise: Promise<void>) => void;
  /**
   * Milestone 4 TESTABILITY SEAM (default undefined => production behavior).
   * The live route never sets this; tests inject a broken/fake resolver to
   * prove a resolver throw can never affect the recorded turn.
   */
  routingDivergenceDeps?: RoutingDivergenceShadowDeps;
  /** Validated staging-only provenance; omitted for every ordinary live turn. */
  trafficProvenance?: RoutingSyntheticQaTrafficProvenance | null;
  /** Internal cancellation fence for the detached local planner lifecycle. */
  abortSignal?: AbortSignal;
}

/**
 * Injectable dependencies for the fire-and-forget shadow-planner side effect.
 * Every field is optional; with none supplied the side effect builds the
 * production planner (local Ollama via the D3 concurrency slot) and persists the
 * planner span through the real trace recorder against `getDb()`.
 */
export interface ShadowPlannerSideEffectDeps {
  /**
   * Test/override seam for the local-LLM planner callback. When omitted the side
   * effect builds the production callback that wraps `dispatchLocalReasoning`
   * inside `runWithLocalInferenceSlot` (respecting the D3 cap). The packet is
   * bounded + text-free (see planChatCoreV2ShadowTurnWithPlanner).
   */
  runPlanner?: ChatCoreV2ShadowRunPlanner;
  /** Optional db override for the planner span + schema-compliance counter. */
  db?: Database.Database;
  /** Optional clock override (ISO timestamps + counter window). */
  now?: Date;
  /** Test seam: record the planner span (defaults to recordChatV2TraceSpan). */
  recordSpan?: (span: ChatV2TraceSpan, db?: Database.Database) => void;
}

export interface ChatCoreV2ShadowRouteHookResult {
  enabled: boolean;
  recorded: boolean;
  result?: ChatCoreV2ShadowTurnResult;
  replayBundleId?: string;
  trafficProvenanceRecorded?: boolean;
  errorCode?: 'shadow_route_hook_failed' | 'shadow_route_hook_missing_hmac_secret';
}

export function runChatCoreV2ShadowRouteHook(
  input: RunChatCoreV2ShadowRouteHookInput,
): ChatCoreV2ShadowRouteHookResult {
  const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };
  if (!isChatCoreV2ShadowRouteHookEnabled(input.env ?? process.env, scope)) {
    return { enabled: false, recorded: false };
  }

  try {
    const hmacSecret = resolveShadowRouteHmacSecret(input.env ?? process.env);
    if (!hmacSecret) {
      logger.warn(
        {
          chatRequestId: input.chatRequestId,
          tenantId: input.tenantId,
          userId: input.userId,
          shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
        },
        'Chat Core v2 shadow route hook skipped because no HMAC secret is configured',
      );
      return { enabled: true, recorded: false, errorCode: 'shadow_route_hook_missing_hmac_secret' };
    }

    const guess = classifyShadowRoute(input.normalizedText);
    const result = planChatCoreV2ShadowTurn({
      turnId: input.chatRequestId,
      tenantId: String(input.tenantId),
      userId: String(input.userId),
      intent: guess.intent,
      confidence: guess.confidence,
      domains: guess.domains,
      capabilityIds: guess.capabilityIds,
      unsupportedReason: guess.unsupportedReason,
      now: input.now,
    });
    // Milestone 4: additive resolver-vs-surface divergence telemetry. Computed
    // in its own try/catch (never blocks or mutates the live turn) and merged
    // additively into the existing replay contextPack row shape.
    const routingDivergence = buildRoutingDivergenceSafely(input, guess);
    const trafficProvenanceRequested = input.trafficProvenance !== undefined
      && input.trafficProvenance !== null;
    if (trafficProvenanceRequested && !routingDivergence?.trafficProvenance) {
      throw new Error('routing_synthetic_qa_provenance_not_recorded');
    }
    const replayInput = {
      result,
      contextPack: {
        ...buildShadowRouteContextPack(input, guess, hmacSecret),
        ...(routingDivergence ? { routingDivergence } : {}),
      },
      response: buildShadowRouteResponse(result),
      createdAt: input.now?.toISOString(),
    };
    const replay = input.db
      ? recordChatCoreV2ShadowReplay(replayInput, input.db)
      : recordChatCoreV2ShadowReplay(replayInput);

    // Active-mode-only prepass recall-miss emission (fire-and-forget). This runs
    // ONLY from the shadow observe flow, never from the OFF-mode live route;
    // maybeEmitPrepassRecallMiss additionally re-checks the orchestrator mode and
    // the per-tenant kill-switch, so it is a hard no-op when mode is off/absent.
    maybeEmitShadowPrepassRecallMiss(input, result);

    // Batch-A: triple-gated, DEFAULT-OFF, fire-and-forget local-LLM planner
    // observation. This is SPAWNED here and NEVER awaited — the synchronous hook
    // returns its EXISTING result UNCHANGED below regardless of the planner. When
    // any gate is off this is a hard no-op (no Ollama call, no planner span); the
    // returned value is byte-identical either way.
    maybeSpawnShadowPlannerSideEffect(input, guess);

    return {
      enabled: true,
      recorded: true,
      result,
      replayBundleId: replay.replayBundle.replayBundleId,
      ...(trafficProvenanceRequested ? { trafficProvenanceRecorded: true } : {}),
    };
  } catch (err) {
    logger.warn(
      {
        err,
        chatRequestId: input.chatRequestId,
        tenantId: input.tenantId,
        userId: input.userId,
        shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
      },
      'Chat Core v2 shadow route hook failed without affecting live chat',
    );
    return {
      enabled: true,
      recorded: false,
      ...(input.trafficProvenance !== undefined && input.trafficProvenance !== null
        ? { trafficProvenanceRecorded: false }
        : {}),
      errorCode: 'shadow_route_hook_failed',
    };
  }
}

/**
 * Milestone 4: build the resolver-vs-surface divergence record without ever
 * being able to affect the live turn.
 *
 * The deterministic resolver + surface calls run inside try/catch; any throw
 * is swallowed (debug-logged) and the hook records the turn exactly as
 * before, minus the additive field.
 */
function buildRoutingDivergenceSafely(
  input: RunChatCoreV2ShadowRouteHookInput,
  guess: ChatCoreV2ShadowRouteGuess,
): RoutingDivergenceShadowRecord | undefined {
  try {
    const env = input.env ?? process.env;
    const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };
    return buildRoutingDivergenceShadowRecord(
      input.normalizedText,
      { intent: guess.intent, domains: guess.domains },
      {
        ...(input.routingDivergenceDeps ?? {}),
        // This state is always evaluated from the hook's real runtime env and
        // scope. The test seam cannot replace it with a claimed state.
        recorderState: {
          userId: String(input.userId),
          tenantId: String(input.tenantId),
          shadowRouteHookEffective: isChatCoreV2ShadowRouteHookEnabled(env, scope),
          shadowPlannerEffective: isChatCoreV2ShadowPlannerEnabled(env, scope),
        },
        // Unlike test seams, provenance comes only from the validated live
        // request context. Supplying this after the spread prevents forgery.
        trafficProvenance: input.trafficProvenance ?? null,
      },
    );
  } catch (err) {
    logger.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        chatRequestId: input.chatRequestId,
        shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
      },
      'Chat Core v2 shadow routing-divergence telemetry skipped (resolver failed; live turn unaffected)',
    );
    return undefined;
  }
}

/**
 * Detect a Layer-1 prepass recall-miss from the shadow plan and, when one
 * occurred, emit a privacy-safe row (HMAC-only) through the mode-gated
 * maybeEmitPrepassRecallMiss. A recall-miss = the prepass ran and produced a
 * bounded candidate set, but at least one capability the route decision actually
 * SELECTED is absent from that candidate set (the prepass failed to recall it).
 *
 * This is fire-and-forget and active-mode-only: the emitter is a hard no-op when
 * CHAT_CORE_V2_ORCHESTRATOR_MODE is off/absent or the tenant is demoted off, so
 * the off-mode live route can never write a miss row.
 */
function maybeEmitShadowPrepassRecallMiss(
  input: RunChatCoreV2ShadowRouteHookInput,
  result: ChatCoreV2ShadowTurnResult,
): void {
  const decision = result.routeDecision;
  // Only meaningful when the prepass actually ran and emitted candidates.
  if (decision.prepassApplied !== true) return;
  const candidateIds = decision.prepassCandidateIds ?? [];
  const selectedIds = decision.selectedCapabilityIds ?? [];
  if (selectedIds.length === 0) return;

  const candidateSet = new Set(candidateIds);
  const missedIds = selectedIds.filter((id) => !candidateSet.has(id));
  if (missedIds.length === 0) return; // full recall — nothing to log.

  maybeEmitPrepassRecallMiss({
    turnId: input.chatRequestId,
    tenantId: String(input.tenantId),
    userId: String(input.userId),
    message: input.normalizedText,
    locale: input.locale ?? 'unknown',
    expectedCapabilityIds: missedIds,
    candidateCapabilityIds: candidateIds,
    reasonCodes: ['prepass_recall_miss'],
    finalCapabilityId: selectedIds[0],
    createdAt: input.now?.toISOString(),
    env: input.env,
    db: input.db,
  });
}

/**
 * Triple gate + fire-and-forget dispatch for the shadow-planner side effect.
 *
 * NON-BLOCKING + INERT BY CONSTRUCTION:
 *   1. NEW flag gate: isChatCoreV2ShadowPlannerEnabled (default FALSE).
 *   2. Orchestrator-mode gate: CHAT_CORE_V2_ORCHESTRATOR_MODE must be active
 *      (shadow/canary/on); off/absent => parsed as 'off' => no-op.
 *   3. Per-tenant kill-switch: isChatCoreV2MasterKillSwitchOff honors WP-07
 *      demotions reaching the live path without a restart.
 *
 * When all three pass, the planner work is SPAWNED as a void async task and the
 * background promise is handed to the optional `onShadowPlannerSettled` seam so
 * tests can await it. The live caller NEVER awaits it. Any rejection is
 * swallowed (`.catch`), so the planner can neither delay nor throw into the live
 * response.
 */
function maybeSpawnShadowPlannerSideEffect(
  input: RunChatCoreV2ShadowRouteHookInput,
  guess: ChatCoreV2ShadowRouteGuess,
): void {
  const env = input.env ?? process.env;
  const scope: RuntimeFlagScope = { userId: input.userId, tenantId: input.tenantId };

  // Gate 1 — NEW default-off flag.
  if (!isChatCoreV2ShadowPlannerEnabled(env, scope)) return;
  // Gate 2 — orchestrator mode must be active (off/absent => 'off' => no-op).
  if (resolveChatCoreV2ActivationConfig(env).mode === 'off') return;
  // Gate 3 — per-tenant master kill-switch / WP-07 demotion.
  if (isChatCoreV2MasterKillSwitchOff(env, String(input.tenantId))) return;

  // FIRE-AND-FORGET: spawn, never await. The synchronous hook returns its
  // existing result immediately after this call. `.catch` guarantees no
  // unhandled rejection and no throw can reach the live caller.
  const promise = runShadowPlannerSideEffect(input, guess, input.shadowPlannerDeps).catch(() => {
    // Intentionally swallowed: planner observation failures are observability
    // loss, never a live-turn failure.
  });
  input.onShadowPlannerSettled?.(promise);
}

/**
 * The exported, awaitable shadow-planner side effect. The live hook
 * fire-and-forgets this (see maybeSpawnShadowPlannerSideEffect); tests can call
 * and await it directly to assert the planner span + privacy posture WITHOUT the
 * live caller ever awaiting.
 *
 * Builds a bounded, text-free planner packet via planChatCoreV2ShadowTurnWithPlanner
 * (which derives candidates from the route decision and uses the fixed
 * `shadow_observe_only` placeholder — NO raw message text), invokes the planner
 * exactly once (plus at most one bounded repair), and persists the single
 * `shadow_planner` span (machine-readable enums only). This function never
 * throws into its caller on its own; the caller still wraps it in `.catch`.
 */
export async function runShadowPlannerSideEffect(
  input: RunChatCoreV2ShadowRouteHookInput,
  guess: ChatCoreV2ShadowRouteGuess,
  deps: ShadowPlannerSideEffectDeps = {},
): Promise<void> {
  try {
    const db = deps.db ?? input.db ?? getDb();
    await runWithSkillInferenceAccountAdmission({
      userId: input.userId,
      abortSignal: input.abortSignal,
    }, async (accountAbortSignal) => {
      const now = deps.now ?? input.now ?? new Date();
      const runPlanner = deps.runPlanner ?? buildLocalReasoningPlanner({
        ...input,
        abortSignal: accountAbortSignal,
      });
      if (!runPlanner) return; // No local provider configured => nothing to observe.

      const plannerInput = buildShadowPlannerTurnInput(input, guess, now);
      const result = await planChatCoreV2ShadowTurnWithPlanner(plannerInput, {
        runPlanner,
        schemaComplianceDb: db,
        now,
      });

      const recordSpan = deps.recordSpan ?? defaultRecordSpan;
      const span = result.traceSpans.find((s) => s.name === 'shadow_planner');
      if (span) recordSpan(span, db);
    }, db);
  } catch (err) {
    // Belt-and-suspenders: never throw out of the side effect. The live caller
    // also wraps this in `.catch`, but a planner observation failure is purely
    // observability loss and must never surface anywhere live.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        chatRequestId: input.chatRequestId,
        tenantId: input.tenantId,
        userId: input.userId,
        shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
      },
      'Chat Core v2 shadow planner side effect failed (swallowed; live turn unaffected)',
    );
  }
}

function defaultRecordSpan(span: ChatV2TraceSpan, db?: Database.Database): void {
  if (db) recordChatV2TraceSpan(span, db);
  else recordChatV2TraceSpan(span);
}

/**
 * Build the bounded shadow-turn input for the planner from the already-computed
 * route guess. Carries the route signal (intent/confidence/domains/capabilities)
 * but the RAW message is intentionally NOT forwarded into the planner packet —
 * planChatCoreV2ShadowTurnWithPlanner replaces it with the fixed safe placeholder.
 */
function buildShadowPlannerTurnInput(
  input: RunChatCoreV2ShadowRouteHookInput,
  guess: ChatCoreV2ShadowRouteGuess,
  now: Date,
): ChatCoreV2ShadowTurnInput {
  return {
    turnId: input.chatRequestId,
    tenantId: String(input.tenantId),
    userId: String(input.userId),
    intent: guess.intent,
    confidence: guess.confidence,
    domains: guess.domains,
    capabilityIds: guess.capabilityIds,
    unsupportedReason: guess.unsupportedReason,
    // NOTE: `message` is deliberately omitted. The shadow planner packet uses a
    // fixed text-free placeholder; passing raw text here would be a privacy
    // regression and is never needed (candidates derive from the route decision).
    now,
  };
}

/**
 * Build the production local-LLM planner callback: wraps `dispatchLocalReasoning`
 * inside `runWithLocalInferenceSlot` so the D3 concurrency cap is respected, and
 * bounds the task (think=false, ultra-compact ctx/predict/temperature). Returns
 * null when no local provider is configured (the side effect then no-ops).
 *
 * PROVEN WIRE METHOD (doctrine #10 — schema validation backstops Ollama format
 * enforcement on every planner response). The dispatch carries:
 *   - systemContext: buildChatCoreV2WirePlannerSystemPrompt() — STATIC
 *     instruction text only (no user data, no packet contents), telling the
 *     model to emit the tiny WIRE JSON shape.
 *   - outputSchema: CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA — enforced via Ollama
 *     `format=`, so the model is constrained to the wire shape end-to-end.
 *   - modelOverride: config.ollama.classifierModel — the fast planner slot.
 * The shadow orchestrator then expands the wire output to a canonical
 * ChatTurnPlanMicro via parseAndValidateChatTurnPlanMicroWireJson(raw, packet),
 * which is why every span can now reach schemaValid=true instead of the bare
 * context-packet path that produced unrepairable/schemaValid=false.
 *
 * The packet is JSON-serialized as the user prompt; it is text-free by
 * construction (built by planChatCoreV2ShadowTurnWithPlanner from the route
 * decision + the fixed placeholder), so no raw user message ever reaches the
 * local model. The system prompt is static instruction text, so it carries no
 * user data either.
 */
function buildLocalReasoningPlanner(
  input: RunChatCoreV2ShadowRouteHookInput,
): ChatCoreV2ShadowRunPlanner | null {
  const provider = ensureActiveProvider();
  if (!provider || typeof provider.dispatchLocalReasoning !== 'function') return null;

  return async (packet) => {
    const result = await runWithLocalInferenceSlot(
      () => provider.dispatchLocalReasoning({
        workloadRole: 'classifier_shadow',
        prompt: JSON.stringify(packet),
        // PROVEN wire method: static instruction prompt + Ollama format schema so
        // the model emits the tiny WIRE shape that the orchestrator auto-expands.
        systemContext: buildChatCoreV2WirePlannerSystemPrompt(),
        outputSchema: CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA,
        // Fast planner slot (the classifier model tag), per D3 calibration.
        modelOverride: config.ollama.classifierModel,
        userId: input.userId,
        tenantId: input.tenantId,
        // Observe-only: never escalate to cloud and never log raw content.
        allowCloudEscalation: false,
        containsPrivateData: true,
        redactionRequired: false,
        // Bounded planner options (D3 calibration): no thinking, capped windows.
        think: false,
        numCtx: CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.numCtx,
        numPredict: CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.numPredict,
        temperature: CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.temperature,
        abortSignal: input.abortSignal,
      }),
    ) as { text?: unknown };
    return String(result?.text ?? '');
  };
}

function buildShadowRouteContextPack(
  input: RunChatCoreV2ShadowRouteHookInput,
  guess: ChatCoreV2ShadowRouteGuess,
  hmacSecret: string,
): Record<string, unknown> {
  return {
    shadowRouteHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
    hashVersion: CHAT_CORE_V2_SHADOW_ROUTE_HASH_VERSION,
    messageHash: hmacShadowRouteValue(input, hmacSecret, 'message', input.normalizedText),
    messageLength: input.normalizedText.length,
    attachmentsCount: input.attachmentsCount ?? 0,
    clientMessageHash: input.clientMessageId
      ? hmacShadowRouteValue(input, hmacSecret, 'client_message_id', input.clientMessageId)
      : undefined,
    userMessageHash: hmacShadowRouteValue(input, hmacSecret, 'user_message_id', input.userMessageId),
    locale: input.locale ?? undefined,
    timezone: input.timezone ?? undefined,
    guessedIntent: guess.intent,
    guessedDomains: guess.domains,
    guessedCapabilities: guess.capabilityIds,
  };
}

function buildShadowRouteResponse(result: ChatCoreV2ShadowTurnResult): ChatCoreV2ShadowReplayResponse & {
  routeHookVersion: string;
  liveBehavior: 'legacy_path_unchanged';
} {
  return {
    type: 'chat_core_v2_shadow_plan',
    shadowReplayVersion: 'chat_core_v2_shadow_replay@1.0.0',
    routeHookVersion: CHAT_CORE_V2_SHADOW_ROUTE_HOOK_VERSION,
    orchestratorVersion: result.orchestratorVersion,
    mode: 'shadow',
    liveBehavior: 'legacy_path_unchanged',
    routeMethod: result.routeDecision.routeMethod,
    reasoningTier: result.routeDecision.reasoningTier,
    selectedCapabilityIds: result.routeDecision.selectedCapabilityIds,
    toolSchemaSetVersion: result.toolSchemaSet.toolSchemaSetVersion,
    toolCount: result.toolSchemaSet.tools.length,
    budgetOk: result.budgetVerdict.ok,
    fallbackAllowed: result.fallbackVerdict.allowed,
    wouldCallModel: result.wouldCallModel,
    wouldExecute: false,
  };
}

function resolveShadowRouteHmacSecret(env: NodeJS.ProcessEnv): string | null {
  const secret = env.CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET
    ?? env.CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET
    ?? env.CLASSIFY_SHADOW_HASH_SECRET;
  const trimmed = secret?.trim();
  return trimmed ? trimmed : null;
}

function hmacShadowRouteValue(
  input: Pick<RunChatCoreV2ShadowRouteHookInput, 'tenantId' | 'userId'>,
  hmacSecret: string,
  kind: 'message' | 'client_message_id' | 'user_message_id',
  value: string,
): string {
  return createHmac('sha256', hmacSecret)
    .update(`${input.tenantId}:${input.userId}:${kind}:${value}`)
    .digest('hex');
}

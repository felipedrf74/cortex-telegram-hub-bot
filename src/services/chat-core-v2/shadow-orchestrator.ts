// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

import Database from 'better-sqlite3';

import { isPlannerPinnedToRepairOnly } from './activation-flags';
import { incrementSchemaCompliance } from './autorevert-counters-store';
import {
  enforceAndRepairChatTurnPlanMicro,
  type EnforceAndRepairOutcome,
} from './enforce-and-repair';
import { evaluateChatCoreV2Fallback, type FallbackPolicyVerdict } from './fallback-policy';
import {
  buildUltraCompactPlannerPacket,
  CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS,
  parseAndValidateChatTurnPlanMicroWireJson,
  type UltraCompactPlannerPacket,
} from './plan-schema';
import { getChatCoreV2ReasoningPolicy } from './reasoning-policies';
import {
  buildChatCoreV2RouteDecision,
  computeRouteDecisionContextHash,
  type BuildRouteDecisionInput,
  type ChatCoreV2Intent,
  type ChatCoreV2RouteDecision,
} from './route-decision';
import {
  checkRuntimeBudget,
  makeRuntimeBudgetUsage,
  type RuntimeBudgetUsage,
  type RuntimeBudgetVerdict,
} from './runtime-budget';
import {
  selectChatCoreV2ToolSchemas,
  type ChatCoreV2ToolSchemaSet,
} from './tool-selection';
import type {
  AuditSensitivity,
  ChatCoreV2Domain,
  ChatCoreV2RouteMethod,
  ChatV2TraceSpan,
  FallbackReason,
  ReasoningPolicy,
  UnsupportedReason,
} from './types';

export const CHAT_CORE_V2_SHADOW_ORCHESTRATOR_VERSION = 'chat_core_v2_shadow_orchestrator@1.0.0';

export interface ChatCoreV2ShadowTurnInput {
  turnId: string;
  tenantId: string;
  userId: string;
  intent: ChatCoreV2Intent;
  confidence: number;
  domains?: ChatCoreV2Domain[];
  capabilityIds?: string[];
  requestedRouteMethod?: ChatCoreV2RouteMethod;
  unsupportedReason?: UnsupportedReason;
  minConfidence?: number;
  // Layer-1 prepass inputs. The shadow path observes prepass candidates only
  // (routing is unchanged in shadow); these feed selectPrepassCandidateCapabilities.
  message?: string;
  pendingConfirmationCapabilityId?: string;
  recentDomainCapabilityIds?: string[];
  activeThreadCapabilityIds?: string[];
  runtimeUsage?: Partial<RuntimeBudgetUsage>;
  maxToolSchemas?: number;
  oldPathHasEquivalentSafety?: boolean;
  fallbackReason?: FallbackReason;
  sensitivity?: AuditSensitivity;
  now?: Date;
}

export interface ChatCoreV2ShadowTurnResult {
  orchestratorVersion: string;
  mode: 'shadow';
  turnId: string;
  routeDecision: ChatCoreV2RouteDecision;
  reasoningPolicy: ReasoningPolicy;
  runtimeUsage: RuntimeBudgetUsage;
  budgetVerdict: RuntimeBudgetVerdict;
  toolSchemaSet: ChatCoreV2ToolSchemaSet;
  fallbackVerdict: FallbackPolicyVerdict;
  traceSpans: ChatV2TraceSpan[];
  wouldCallModel: boolean;
  wouldExecute: false;
}

export function planChatCoreV2ShadowTurn(input: ChatCoreV2ShadowTurnInput): ChatCoreV2ShadowTurnResult {
  const routeDecision = buildChatCoreV2RouteDecision(buildRouteInput(input));
  const reasoningPolicy = getChatCoreV2ReasoningPolicy(routeDecision.reasoningTier);
  const runtimeUsage = makeRuntimeBudgetUsage(input.runtimeUsage);
  const budgetVerdict = checkRuntimeBudget(reasoningPolicy, runtimeUsage);
  const toolSchemaSet = selectChatCoreV2ToolSchemas(routeDecision, {
    maxToolSchemas: input.maxToolSchemas,
  });
  const fallbackVerdict = evaluateChatCoreV2Fallback({
    reason: input.fallbackReason ?? 'v2_execution_disabled',
    routeMethod: routeDecision.routeMethod,
    hasWriteIntent: hasWriteIntent(input.intent, routeDecision.routeMethod),
    oldPathHasEquivalentSafety: input.oldPathHasEquivalentSafety,
  });
  const traceSpans = buildShadowTraceSpans({
    input,
    routeDecision,
    budgetVerdict,
    toolSchemaSet,
    fallbackVerdict,
  });

  return {
    orchestratorVersion: CHAT_CORE_V2_SHADOW_ORCHESTRATOR_VERSION,
    mode: 'shadow',
    turnId: input.turnId,
    routeDecision,
    reasoningPolicy,
    runtimeUsage,
    budgetVerdict,
    toolSchemaSet,
    fallbackVerdict,
    traceSpans,
    wouldCallModel: routeDecision.requiresLLM && budgetVerdict.ok,
    wouldExecute: false,
  };
}

/**
 * The planner span name. The span carries ONLY HMAC/text-free outcome metadata
 * (schemaValid, outcome enum, attemptsUsed, issueCodeCount) — never raw model
 * text and never plan contents.
 */
const SHADOW_PLANNER_SPAN_NAME = 'shadow_planner';

/**
 * A bounded, privacy-safe placeholder for the planner packet's message field.
 * The shadow path NEVER puts raw user text into the planner packet: the packet
 * is derived entirely from the already-computed (non-text) route decision plus
 * this fixed marker. Schema validity is therefore measurable without ever
 * letting a message reach the injected model call.
 */
const SHADOW_PLANNER_MESSAGE_PLACEHOLDER = 'shadow_observe_only';

/**
 * Reason codes recorded on a `shadow_planner` span. Text-free; safe to persist.
 */
export type ChatCoreV2ShadowPlannerReasonCode =
  | 'planner_ok'
  | 'planner_threw'
  | 'planner_pinned_to_repair_only';

/**
 * Async callback that turns a bounded planner packet (JSON-serialized) into the
 * model's raw output string. Injected so the shadow path never hard-depends on
 * Ollama / the network and stays unit-testable with a fake. The callback owns
 * its own privacy + timeout posture; this orchestrator tolerates it throwing
 * (records a 'failed' span and continues — never throws, never blocks shadow
 * recording).
 */
export type ChatCoreV2ShadowRunPlanner = (packet: UltraCompactPlannerPacket) => Promise<string>;

export interface ChatCoreV2ShadowTurnWithPlannerDeps {
  /**
   * Optional. When omitted, this function is byte-identical to
   * planChatCoreV2ShadowTurn (no planner call, no extra span). When provided,
   * the planner is invoked exactly once and a single `shadow_planner` span is
   * appended.
   */
  runPlanner?: ChatCoreV2ShadowRunPlanner;
  /**
   * Optional db for the Wave-2 rank 6 per-tenant schema-compliance counter.
   *
   * OFF-MODE INERTNESS: the counter increment lives ENTIRELY inside the
   * `deps.runPlanner` branch below — it runs ONLY when a planner is injected
   * (shadow+/sandbox). The off-mode live route never injects a planner, so it
   * never reaches this write. When `db` is omitted NO counter write is attempted
   * at all (the increment is fully skipped), so existing planner-only callers and
   * tests that do not care about the counter stay byte-compatible on the DB.
   */
  schemaComplianceDb?: Database.Database;
  now?: Date;
}

/**
 * Additive, DEFAULT-OFF planner observation for the shadow path.
 *
 * Calls the existing synchronous planChatCoreV2ShadowTurn(input) UNCHANGED to
 * get the base result, then — ONLY when deps.runPlanner is injected — builds a
 * bounded, text-free planner packet, invokes the planner once, runs the output
 * through enforceAndRepairChatTurnPlanMicro (schema validate + one bounded
 * repair), and appends ONE extra `shadow_planner` trace span carrying only
 * machine-readable outcome metadata. With runPlanner omitted the result is
 * byte-identical to planChatCoreV2ShadowTurn (existing callers are untouched).
 *
 * Privacy: no raw user/model text ever reaches a span attribute or the
 * redactedSummary. The packet's message field is a fixed placeholder, the
 * packet's contextHash is a one-way digest, and enforceAndRepair returns only
 * structured issue codes — never raw output. A planner throw becomes a
 * structured 'failed' span; this function never throws.
 */
export async function planChatCoreV2ShadowTurnWithPlanner(
  input: ChatCoreV2ShadowTurnInput,
  deps: ChatCoreV2ShadowTurnWithPlannerDeps = {},
): Promise<ChatCoreV2ShadowTurnResult> {
  const base = planChatCoreV2ShadowTurn(input);

  // DEFAULT-OFF: with no injected planner this is a pure pass-through, byte
  // identical to planChatCoreV2ShadowTurn (no extra span, same trace bytes).
  if (!deps.runPlanner) {
    return base;
  }

  const span = await runShadowPlannerSpan(input, base.routeDecision, deps);
  return {
    ...base,
    traceSpans: [...base.traceSpans, span],
  };
}

async function runShadowPlannerSpan(
  input: ChatCoreV2ShadowTurnInput,
  routeDecision: ChatCoreV2RouteDecision,
  deps: ChatCoreV2ShadowTurnWithPlannerDeps,
): Promise<ChatV2TraceSpan> {
  const now = (deps.now ?? input.now ?? new Date()).toISOString();
  const sensitivity = input.sensitivity ?? 'personal';
  const packet = buildShadowPlannerPacket(input, routeDecision);

  if (isPlannerPinnedToRepairOnly(String(input.tenantId))) {
    return buildPlannerSpan(input, 'skipped', sensitivity, now, {
      schemaValid: false,
      outcome: 'skipped',
      attemptsUsed: 0,
      issueCodeCount: 0,
      reasonCode: 'planner_pinned_to_repair_only',
      plannerOptionsVersion: SHADOW_PLANNER_OPTIONS_SUMMARY,
    });
  }

  let rawOutput: string;
  try {
    // Single planner invocation. think=false is conveyed via the bounded
    // ultra-compact options (temperature 0, capped numPredict). The injected
    // callback owns transport; we only observe its output shape.
    rawOutput = await deps.runPlanner!(packet);
  } catch {
    // Never throw, never block shadow recording: a planner failure becomes a
    // structured, text-free 'failed' span.
    return buildPlannerSpan(input, 'failed', sensitivity, now, {
      schemaValid: false,
      outcome: 'unrepairable',
      attemptsUsed: 0,
      issueCodeCount: 0,
      reasonCode: 'planner_threw',
      plannerOptionsVersion: SHADOW_PLANNER_OPTIONS_SUMMARY,
    });
  }

  // The repairModel is derived from the SAME injected planner so the single
  // bounded repair attempt also stays injection-only and network-optional. The
  // repair prompt is passed straight through; enforceAndRepair never logs it.
  //
  // PROVEN WIRE METHOD (doctrine #10): the planner emits the tiny WIRE JSON shape
  // (Ollama format=CHAT_TURN_PLAN_MICRO_WIRE_JSON_SCHEMA + the static wire system
  // prompt — see buildLocalReasoningPlanner). We inject the packet-bound wire
  // parser so enforceAndRepair auto-EXPANDS that wire output into a canonical
  // ChatTurnPlanMicro against THIS packet (candidate indexes -> capability ids,
  // packet.contextHash as the staleness guard) for BOTH the initial parse and
  // the post-repair re-parse. Without this the bare context packet validated as
  // unrepairable/schemaValid=false. The parser is packet-bound and text-free; it
  // returns only structured issue codes, never raw model output.
  const enforced = await enforceAndRepairChatTurnPlanMicro({
    rawModelOutput: rawOutput,
    parse: (raw) => parseAndValidateChatTurnPlanMicroWireJson(raw, packet),
    repairModel: () => deps.runPlanner!(packet),
  });

  const schemaValid = enforced.outcome === 'valid' || enforced.outcome === 'repaired';

  // Wave-2 rank 6: per-tenant schema-compliance counter. This is the ONLY
  // schema-compliance increment site, and it lives inside the planner branch —
  // which only runs when a planner is injected (shadow+/sandbox), so it is
  // OFF-MODE INERT by construction (the off-mode live route never injects a
  // planner and never reaches here). pass = valid|repaired, fail = unrepairable.
  // Fire-and-forget: incrementSchemaCompliance never throws. Only attempted when
  // a db is supplied (omitting the db skips the write entirely — see deps doc).
  if (deps.schemaComplianceDb) {
    incrementSchemaCompliance(
      deps.schemaComplianceDb,
      String(input.tenantId),
      { valid: schemaValid },
      deps.now ?? input.now ?? new Date(),
    );
  }

  return buildPlannerSpan(input, 'success', sensitivity, now, {
    schemaValid,
    outcome: enforced.outcome satisfies EnforceAndRepairOutcome,
    attemptsUsed: enforced.attemptsUsed,
    issueCodeCount: enforced.issues.length,
    reasonCode: 'planner_ok',
    plannerOptionsVersion: SHADOW_PLANNER_OPTIONS_SUMMARY,
  });
}

/**
 * Build the bounded planner packet from the already-computed route decision.
 * The packet is text-free: candidate capability ids come from the decision, the
 * message field is a fixed placeholder, and the contextHash is a one-way digest
 * (computeRouteDecisionContextHash never re-exposes raw message text).
 */
function buildShadowPlannerPacket(
  input: ChatCoreV2ShadowTurnInput,
  routeDecision: ChatCoreV2RouteDecision,
): UltraCompactPlannerPacket {
  const candidateCapabilityIds = routeDecision.selectedCapabilityIds.length > 0
    ? routeDecision.selectedCapabilityIds
    : (routeDecision.prepassCandidateIds ?? input.capabilityIds ?? []);
  return buildUltraCompactPlannerPacket({
    locale: 'unknown',
    candidateCapabilityIds,
    messageSummary: SHADOW_PLANNER_MESSAGE_PLACEHOLDER,
    contextHash: computeRouteDecisionContextHash(buildRouteInput(input)),
  });
}

// Text-free summary of the bounded planner options actually used. Recorded so
// the shadow evidence shows think=false / temperature 0 without leaking content.
const SHADOW_PLANNER_OPTIONS_SUMMARY =
  `numCtx=${CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.numCtx}`
  + `;numPredict=${CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.numPredict}`
  + `;temperature=${CHAT_TURN_PLAN_MICRO_ULTRA_COMPACT_OPTIONS.temperature}`
  + ';think=false';

function buildPlannerSpan(
  input: ChatCoreV2ShadowTurnInput,
  status: ChatV2TraceSpan['status'],
  sensitivity: AuditSensitivity,
  timestamp: string,
  attributes: {
    schemaValid: boolean;
    outcome: EnforceAndRepairOutcome | 'skipped';
    attemptsUsed: number;
    issueCodeCount: number;
    reasonCode: ChatCoreV2ShadowPlannerReasonCode;
    plannerOptionsVersion: string;
  },
): ChatV2TraceSpan {
  // kind 'model': this span observes a (would-be) local-model planner call.
  return buildSpan(input, 'model', SHADOW_PLANNER_SPAN_NAME, status, sensitivity, timestamp, {
    ...attributes,
  });
}

function buildRouteInput(input: ChatCoreV2ShadowTurnInput): BuildRouteDecisionInput {
  return {
    intent: input.intent,
    confidence: input.confidence,
    domains: input.domains,
    capabilityIds: input.capabilityIds,
    requestedRouteMethod: input.requestedRouteMethod,
    unsupportedReason: input.unsupportedReason,
    minConfidence: input.minConfidence,
    // The shadow path always OBSERVES the Layer-1 prepass: candidates are
    // recorded on the decision (and emitted as a trace span) without changing
    // the routing outcome.
    prepassMode: 'observe',
    message: input.message,
    pendingConfirmationCapabilityId: input.pendingConfirmationCapabilityId,
    recentDomainCapabilityIds: input.recentDomainCapabilityIds,
    activeThreadCapabilityIds: input.activeThreadCapabilityIds,
  };
}

function hasWriteIntent(intent: ChatCoreV2Intent, routeMethod: ChatCoreV2RouteMethod): boolean {
  if (routeMethod === 'llm_command_translation' || routeMethod === 'planner' || routeMethod === 'background_planner') {
    return true;
  }
  return intent === 'create_action'
    || intent === 'modify_action'
    || intent === 'planning'
    || intent === 'unsafe_or_disallowed';
}

function buildShadowTraceSpans(input: {
  input: ChatCoreV2ShadowTurnInput;
  routeDecision: ChatCoreV2RouteDecision;
  budgetVerdict: RuntimeBudgetVerdict;
  toolSchemaSet: ChatCoreV2ToolSchemaSet;
  fallbackVerdict: FallbackPolicyVerdict;
}): ChatV2TraceSpan[] {
  const now = (input.input.now ?? new Date()).toISOString();
  const sensitivity = input.input.sensitivity ?? 'personal';
  return [
    buildSpan(input.input, 'router', 'route_decision', 'success', sensitivity, now, {
      routeMethod: input.routeDecision.routeMethod,
      reasoningTier: input.routeDecision.reasoningTier,
      selectedCapabilityIds: input.routeDecision.selectedCapabilityIds,
      reasonCodes: input.routeDecision.reasonCodes,
    }),
    ...(input.routeDecision.prepassApplied
      ? [buildSpan(input.input, 'custom', 'prepass_candidate_selection', 'success', sensitivity, now, {
        prepassCandidateIds: input.routeDecision.prepassCandidateIds ?? [],
        candidateCount: (input.routeDecision.prepassCandidateIds ?? []).length,
      })]
      : []),
    buildSpan(input.input, 'budget', 'runtime_budget', input.budgetVerdict.ok ? 'success' : 'blocked', sensitivity, now, {
      ok: input.budgetVerdict.ok,
      limit: input.budgetVerdict.limit,
      used: input.budgetVerdict.used,
      max: input.budgetVerdict.max,
    }),
    buildSpan(input.input, 'tool_selection', 'tool_schema_selection', 'success', sensitivity, now, {
      toolSchemaSetVersion: input.toolSchemaSet.toolSchemaSetVersion,
      toolCount: input.toolSchemaSet.tools.length,
      omittedCapabilities: input.toolSchemaSet.omittedCapabilities,
    }),
    buildSpan(input.input, 'fallback', 'shadow_fallback_policy', input.fallbackVerdict.allowed ? 'success' : 'blocked', sensitivity, now, {
      allowed: input.fallbackVerdict.allowed,
      reason: input.fallbackVerdict.reason,
      blockedBecause: input.fallbackVerdict.blockedBecause,
    }),
  ];
}

function buildSpan(
  input: ChatCoreV2ShadowTurnInput,
  kind: ChatV2TraceSpan['kind'],
  name: string,
  status: ChatV2TraceSpan['status'],
  sensitivity: AuditSensitivity,
  timestamp: string,
  attributes: Record<string, unknown>,
): ChatV2TraceSpan {
  return {
    traceSpanId: `chatv2-shadow:${hashId(input.turnId, name)}`,
    turnId: input.turnId,
    tenantId: input.tenantId,
    userId: input.userId,
    kind,
    name,
    status,
    sensitivity,
    retentionPolicy: sensitivity === 'financial' ? '30d' : '90d',
    redactedSummary: `${name}:${status}`,
    attributes: {
      orchestratorVersion: CHAT_CORE_V2_SHADOW_ORCHESTRATOR_VERSION,
      ...attributes,
    },
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
  };
}

function hashId(turnId: string, name: string): string {
  return createHash('sha256')
    .update(`${turnId}:${name}`)
    .digest('hex')
    .slice(0, 16);
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';

import { getChatCoreV2Capability } from './capability-registry';
import { selectPrepassCandidateCapabilities } from './prepass-candidate-selection';
import { getChatCoreV2ReasoningPolicy } from './reasoning-policies';
import type {
  ActionRisk,
  CapabilityDefinition,
  ChatCoreV2Domain,
  ChatCoreV2RouteMethod,
  MemoryItemType,
  ReasoningTier,
  UnsupportedReason,
} from './types';

export const CHAT_CORE_V2_ROUTE_DECISION_VERSION = 'chat_core_v2_route_decision@1.0.0';

export type ChatCoreV2Intent =
  | 'general_question'
  | 'app_question'
  | 'create_action'
  | 'modify_action'
  | 'planning'
  | 'ambiguous'
  | 'unsafe_or_disallowed';

export type ChatCoreV2RouteReasonCode =
  | 'low_confidence'
  | 'no_domain'
  | 'unknown_capability'
  | 'multi_domain_context'
  | 'restricted_capability'
  | 'blocked_capability'
  | 'unsupported_capability'
  | 'deterministic_read_available'
  | 'llm_required'
  | 'planner_required'
  | 'background_required';

/**
 * Controls whether the deterministic Layer-1 prepass selector influences routing.
 * - 'off' (default): prepass does not run; output is bit-identical to legacy.
 * - 'observe' (shadow): prepass candidates are recorded on the decision (and
 *   emitted as a trace span) WITHOUT changing the routing outcome — true
 *   observation-only, so no sentinel/fallback candidate can pollute the route.
 * - 'enforce' (on): routing narrows to the intersection of the caller's
 *   capabilityIds and the prepass candidates, falling back to the caller's set
 *   when the intersection is empty (never route on an empty capability set).
 */
export type ChatCoreV2PrepassMode = 'off' | 'observe' | 'enforce';

export interface BuildRouteDecisionInput {
  intent: ChatCoreV2Intent;
  confidence: number;
  domains?: ChatCoreV2Domain[];
  capabilityIds?: string[];
  requestedRouteMethod?: ChatCoreV2RouteMethod;
  unsupportedReason?: UnsupportedReason;
  minConfidence?: number;
  // Layer-1 prepass inputs (additive, optional). Prepass runs only when
  // prepassMode is 'observe'/'enforce' AND message is non-empty. Layer 1 is
  // deterministic — it performs no model or network calls.
  prepassMode?: ChatCoreV2PrepassMode;
  message?: string;
  pendingConfirmationCapabilityId?: string;
  recentDomainCapabilityIds?: string[];
  activeThreadCapabilityIds?: string[];
  // WP-17 (§5.G): the lean, projection-only memory context loaded for the
  // requesting tenant+user (`{type, domain, value}` ONLY — see
  // memory-store-reader). ADDITIVE + OPTIONAL. WP-16 (§5.G) now CONSUMES it:
  // a relevant domain-affinity memory item (a `decision_rationale` or
  // `domain_preference` whose `domain` matches one of the turn's candidate
  // domains) nudges the route decision by promoting that domain to
  // `primaryDomain` (see `applyMemoryDomainAffinity`). The rule is strictly
  // behavior-preserving when memoryContext is absent/empty OR when no item is
  // relevant, so:
  //   - every pre-WP-16 route-decision test stays byte-identical, and
  //   - mode=off is unchanged because WP-17's reader returns [] when off.
  // Because the rule can change the decision, the relevant-affinity signal is
  // folded into computeRouteDecisionContextHash (only when it actually fires).
  memoryContext?: Array<{ type: MemoryItemType; domain?: ChatCoreV2Domain; value: string }>;
}

// WP-16 (§5.G): the memory item types that carry a domain-affinity signal the
// route decision is allowed to act on. Other types (conversation_summary,
// user_preference, user_correction, etc.) are prompt-only and never reorder
// the route — they are threaded for the prompt layer (WP-17) but inert here.
const MEMORY_DOMAIN_AFFINITY_TYPES: ReadonlySet<MemoryItemType> = new Set<MemoryItemType>([
  'decision_rationale',
  'domain_preference',
]);

/**
 * WP-16 (§5.G) memory consumption rule, FIRING predicate. Returns the candidate
 * domain that a relevant domain-affinity memory item points at, but ONLY when
 * acting on it would ACTUALLY CHANGE THE DECISION — i.e. the domain is one of
 * the turn's candidate domains AND sits at index > 0 (so `hoistMemoryAffineDomain`
 * would move it to the front and become the new primaryDomain). A domain that is
 * already the primary/only candidate (index 0) is NOT returned, because hoisting
 * it is a no-op: the decision is byte-identical with or without the memory item.
 *
 * This is the single shared firing predicate used by BOTH the route decision
 * (via `computeRouteDecision`) AND `computeRouteDecisionContextHash`, so the hash
 * changes if and only if the decision changes — they can never diverge. It NEVER
 * introduces a brand-new domain (a conservative nudge: memory may reorder
 * priority among domains the turn already proposed, never invent one), and it is
 * null/non-object-entry safe. Returns undefined when there is no relevant,
 * decision-changing item — in which case behavior is byte-identical to a turn
 * with no memory at all.
 */
function resolveMemoryAffineDomain(
  memoryContext: BuildRouteDecisionInput['memoryContext'],
  candidateDomains: ChatCoreV2Domain[],
): ChatCoreV2Domain | undefined {
  if (!memoryContext || memoryContext.length === 0 || candidateDomains.length === 0) {
    return undefined;
  }
  for (const item of memoryContext) {
    // FIX-4: skip a null / non-object entry rather than throwing a TypeError on
    // item.domain / item.type when memoryContext carries a malformed element.
    if (!item || typeof item !== 'object') continue;
    if (!item.domain) continue;
    if (!MEMORY_DOMAIN_AFFINITY_TYPES.has(item.type)) continue;
    // Fire ONLY when hoisting would change the decision: the affine domain must
    // be a candidate at index > 0 (matching hoistMemoryAffineDomain's `index > 0`
    // condition). index === 0 (already primary) or index === -1 (not a
    // candidate) are both no-ops and must NOT fire — keeping the hash aligned
    // with the decision.
    if (candidateDomains.indexOf(item.domain) > 0) return item.domain;
  }
  return undefined;
}

export interface ChatCoreV2RouteDecision {
  routeDecisionVersion: string;
  primaryDomain?: ChatCoreV2Domain;
  secondaryDomains: ChatCoreV2Domain[];
  selectedCapabilityIds: string[];
  intent: ChatCoreV2Intent;
  routeMethod: ChatCoreV2RouteMethod;
  confidence: number;
  riskEstimate: ActionRisk;
  reasoningTier: ReasoningTier;
  requiresLLM: boolean;
  unsupportedReason?: UnsupportedReason;
  reasonCodes: ChatCoreV2RouteReasonCode[];
  // Set only when the Layer-1 prepass ran (prepassMode !== 'off'); omitted
  // otherwise so an off-mode decision stays bit-identical to legacy output.
  prepassApplied?: boolean;
  prepassCandidateIds?: string[];
}

const DEFAULT_MIN_CONFIDENCE = 0.68;
const RISK_ORDER: ActionRisk[] = ['low', 'medium', 'high', 'restricted'];
const REASONING_ORDER: ReasoningTier[] = [
  'none',
  'fast_extraction',
  'standard_command',
  'synthesis',
  'planner',
  'deep_planner',
  'background_planner',
];

/**
 * Pure, deterministic sha256 of the routing-relevant context. Used to detect
 * when the context that produced a plan has changed (so the orchestrator can
 * re-read / replan). No I/O. Array fields are sorted so the hash is independent
 * of caller ordering; the message is normalized (trim + lowercase). The output
 * is a one-way digest, so it never re-exposes raw message text.
 */
export function computeRouteDecisionContextHash(input: BuildRouteDecisionInput): string {
  // WP-16 (§5.G): the memory affinity signal is part of the routing-relevant
  // context if and only if it actually CHANGES THE DECISION. We compute it with
  // the SAME shared helper the decision uses (`resolveEffectiveMemoryAffineDomain`),
  // which (a) fires only when the affine domain would be HOISTED (candidate at
  // index > 0 — not when it is already the primary/only candidate), and (b) in
  // 'enforce' mode resolves over the POST-prepass effective candidate set, exactly
  // like the decision. So the hash changes if and only if the decision changes —
  // the documented "hash changes only when the rule fires" invariant holds, and a
  // turn with no decision-changing memory hashes byte-identically to pre-WP-16.
  const memoryAffineDomain = resolveEffectiveMemoryAffineDomain(input);
  const canonical = JSON.stringify({
    intent: input.intent,
    domains: [...(input.domains ?? [])].sort(),
    capabilityIds: [...(input.capabilityIds ?? [])].sort(),
    requestedRouteMethod: input.requestedRouteMethod ?? null,
    unsupportedReason: input.unsupportedReason ?? null,
    pendingConfirmationCapabilityId: input.pendingConfirmationCapabilityId ?? null,
    recentDomainCapabilityIds: [...(input.recentDomainCapabilityIds ?? [])].sort(),
    activeThreadCapabilityIds: [...(input.activeThreadCapabilityIds ?? [])].sort(),
    message: (input.message ?? '').trim().toLowerCase(),
    // Omitted (key absent) when the affinity rule does not fire → byte-identical
    // to the legacy canonical object. Present only when memory changes the route.
    ...(memoryAffineDomain ? { memoryAffineDomain } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The candidate domains the decision considers: the resolved domains of the
 * caller's known capabilities, unioned with the caller-supplied domains,
 * preserving the same order `computeRouteDecision` derives `primaryDomain` from.
 * Pure + deterministic (capability lookup only; no I/O). Shared by the hash and
 * the memory-affinity rule so both observe the identical candidate set.
 */
function resolveCandidateDomains(input: BuildRouteDecisionInput): ChatCoreV2Domain[] {
  const domains = unique(input.domains ?? []);
  const capabilityDomains = resolveCapabilities(input.capabilityIds ?? [])
    .filter((entry): entry is CapabilityDefinition => Boolean(entry))
    .map((capability) => capability.domain);
  return unique([...domains, ...capabilityDomains]);
}

/**
 * The 'enforce'-mode post-prepass effective capability IDs for `input`. When
 * prepass is off/observe (or the message is empty) the caller's capabilityIds
 * pass through unchanged; under 'enforce' with a message they are narrowed to
 * the intersection with the prepass candidates (with the never-empty fallback).
 * Pure + deterministic (the Layer-1 selector does no model/network I/O). This is
 * the SINGLE place the post-prepass capability set is derived, so the decision
 * and the hash narrow identically.
 */
function resolveEffectiveCapabilityIds(input: BuildRouteDecisionInput): string[] {
  const original = input.capabilityIds ?? [];
  const prepassMode = input.prepassMode ?? 'off';
  const message = (input.message ?? '').trim();
  if (prepassMode !== 'enforce' || message.length === 0) {
    return original;
  }
  const prepass = selectPrepassCandidateCapabilities({
    message: input.message ?? '',
    pendingConfirmationCapabilityId: input.pendingConfirmationCapabilityId,
    recentDomainCapabilityIds: input.recentDomainCapabilityIds,
    activeThreadCapabilityIds: input.activeThreadCapabilityIds,
  });
  return intersectPreservingOrder(original, prepass.candidateCapabilityIds);
}

/**
 * WP-16 (§5.G) — the SINGLE shared firing helper used by BOTH the decision (via
 * `buildChatCoreV2RouteDecision`) AND `computeRouteDecisionContextHash`. It
 * resolves the memory-affine domain over the EFFECTIVE (post-prepass, in
 * 'enforce' mode) candidate set, applying the same hoist-only firing predicate
 * as `resolveMemoryAffineDomain` — so the hash and the decision can never
 * diverge: the affine domain is folded into the hash iff it actually changes the
 * decision. Returns undefined when memory does not change the route.
 */
function resolveEffectiveMemoryAffineDomain(input: BuildRouteDecisionInput): ChatCoreV2Domain | undefined {
  const effectiveCapabilityIds = resolveEffectiveCapabilityIds(input);
  const effectiveCandidateDomains = resolveCandidateDomains({ ...input, capabilityIds: effectiveCapabilityIds });
  return resolveMemoryAffineDomain(input.memoryContext, effectiveCandidateDomains);
}

export function buildChatCoreV2RouteDecision(input: BuildRouteDecisionInput): ChatCoreV2RouteDecision {
  const prepassMode = input.prepassMode ?? 'off';
  const message = (input.message ?? '').trim();

  // Kill-switch parity: with prepass off (or no message to analyze) the decision
  // is computed exactly as before — bit-identical legacy output EXCEPT when a
  // relevant memory item changes the route (the only allowed deviation, §5.G).
  // The affine domain is resolved via the shared firing helper so it matches the
  // hash exactly (off/observe path: pre-prepass candidate set).
  if (prepassMode === 'off' || message.length === 0) {
    return computeRouteDecision(input, resolveEffectiveMemoryAffineDomain(input));
  }

  // Layer 1 is a pure, deterministic selector (no model or network calls). It
  // only proposes candidate capability IDs from the message text + cheap hints.
  const prepass = selectPrepassCandidateCapabilities({
    message: input.message ?? '',
    pendingConfirmationCapabilityId: input.pendingConfirmationCapabilityId,
    recentDomainCapabilityIds: input.recentDomainCapabilityIds,
    activeThreadCapabilityIds: input.activeThreadCapabilityIds,
  });

  // 'observe' (shadow) never narrows routing — the candidates (which include
  // sentinels/fallback reads) are recorded for measurement only. 'enforce'
  // narrows to the intersection, with a safe fallback to the caller's set.
  const original = input.capabilityIds ?? [];
  const effectiveCapabilityIds = prepassMode === 'enforce'
    ? intersectPreservingOrder(original, prepass.candidateCapabilityIds)
    : original;

  // Re-resolve the affine domain against the post-prepass capability set via the
  // shared firing helper so (a) a domain narrowed away by 'enforce' prepass
  // cannot be re-promoted by memory, and (b) the hash (which calls the SAME
  // helper) folds in the identical affine domain — decision and hash agree.
  const effectiveMemoryAffineDomain = resolveEffectiveMemoryAffineDomain({
    ...input,
    capabilityIds: effectiveCapabilityIds,
    // Already narrowed above; prevent the helper from narrowing a second time.
    prepassMode: 'off',
  });
  const base = computeRouteDecision(
    { ...input, capabilityIds: effectiveCapabilityIds },
    effectiveMemoryAffineDomain,
  );
  return {
    ...base,
    prepassApplied: true,
    prepassCandidateIds: prepass.candidateCapabilityIds,
  };
}

function computeRouteDecision(
  input: BuildRouteDecisionInput,
  // WP-16 (§5.G): when set (and present among the candidate domains), this
  // domain is hoisted to primaryDomain — the observable behavior change. When
  // undefined the ordering is exactly the legacy order.
  memoryAffineDomain?: ChatCoreV2Domain,
): ChatCoreV2RouteDecision {
  const confidence = normalizeConfidence(input.confidence);
  const domains = unique(input.domains ?? []);
  const capabilities = resolveCapabilities(input.capabilityIds ?? []);
  const knownCapabilities = capabilities.filter((entry): entry is CapabilityDefinition => Boolean(entry));
  const capabilityDomains = knownCapabilities.map((capability) => capability.domain);
  const allDomains = hoistMemoryAffineDomain(unique([...domains, ...capabilityDomains]), memoryAffineDomain);
  const primaryDomain = allDomains[0];
  const secondaryDomains = allDomains.slice(1);
  const reasonCodes: ChatCoreV2RouteReasonCode[] = [];

  if (capabilities.some((capability) => !capability)) reasonCodes.push('unknown_capability');
  if (!primaryDomain) reasonCodes.push('no_domain');
  if (secondaryDomains.length > 0) reasonCodes.push('multi_domain_context');

  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (input.intent === 'ambiguous' || confidence < minConfidence) {
    reasonCodes.push('low_confidence');
    return decision({
      input,
      primaryDomain,
      secondaryDomains,
      selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
      routeMethod: 'needs_clarification',
      riskEstimate: estimateRisk(knownCapabilities),
      reasoningTier: 'none',
      requiresLLM: false,
      reasonCodes,
    });
  }

  if (input.unsupportedReason === 'ambiguous_scope') {
    reasonCodes.push('unsupported_capability');
    return decision({
      input,
      primaryDomain,
      secondaryDomains,
      selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
      routeMethod: 'needs_clarification',
      riskEstimate: estimateRisk(knownCapabilities),
      reasoningTier: 'none',
      requiresLLM: false,
      unsupportedReason: input.unsupportedReason,
      reasonCodes,
    });
  }

  if (input.unsupportedReason || input.intent === 'unsafe_or_disallowed') {
    reasonCodes.push('unsupported_capability');
    return decision({
      input,
      primaryDomain,
      secondaryDomains,
      selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
      routeMethod: 'unsupported',
      riskEstimate: estimateRisk(knownCapabilities),
      reasoningTier: 'none',
      requiresLLM: false,
      unsupportedReason: input.unsupportedReason ?? 'unsafe_action',
      reasonCodes,
    });
  }

  if (knownCapabilities.some((capability) => capability.risk === 'restricted')) {
    reasonCodes.push('restricted_capability');
  }

  if (knownCapabilities.some((capability) => capability.support.execute === 'blocked' || capability.routeMethods.includes('blocked'))) {
    reasonCodes.push('blocked_capability');
    return decision({
      input,
      primaryDomain,
      secondaryDomains,
      selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
      routeMethod: 'blocked',
      riskEstimate: estimateRisk(knownCapabilities),
      reasoningTier: estimateReasoningTier(knownCapabilities),
      requiresLLM: false,
      unsupportedReason: input.unsupportedReason ?? 'restricted_domain',
      reasonCodes,
    });
  }

  const routeMethod = input.requestedRouteMethod ?? inferRouteMethod(input.intent, knownCapabilities);
  if (routeMethod === 'deterministic_read') reasonCodes.push('deterministic_read_available');
  if (routeMethod === 'llm_command_translation' || routeMethod === 'llm_synthesis') reasonCodes.push('llm_required');
  if (routeMethod === 'planner') reasonCodes.push('planner_required');
  if (routeMethod === 'background_planner') reasonCodes.push('background_required');

  const reasoningTier = estimateReasoningTier(knownCapabilities, routeMethod);
  return decision({
    input,
    primaryDomain,
    secondaryDomains,
    selectedCapabilityIds: knownCapabilities.map((capability) => capability.capabilityId),
    routeMethod,
    riskEstimate: estimateRisk(knownCapabilities),
    reasoningTier,
    requiresLLM: getChatCoreV2ReasoningPolicy(reasoningTier).budget.maxModelCalls > 0,
    reasonCodes,
  });
}

function decision(input: {
  input: BuildRouteDecisionInput;
  primaryDomain?: ChatCoreV2Domain;
  secondaryDomains: ChatCoreV2Domain[];
  selectedCapabilityIds: string[];
  routeMethod: ChatCoreV2RouteMethod;
  riskEstimate: ActionRisk;
  reasoningTier: ReasoningTier;
  requiresLLM: boolean;
  unsupportedReason?: UnsupportedReason;
  reasonCodes: ChatCoreV2RouteReasonCode[];
}): ChatCoreV2RouteDecision {
  return {
    routeDecisionVersion: CHAT_CORE_V2_ROUTE_DECISION_VERSION,
    primaryDomain: input.primaryDomain,
    secondaryDomains: input.secondaryDomains,
    selectedCapabilityIds: input.selectedCapabilityIds,
    intent: input.input.intent,
    routeMethod: input.routeMethod,
    confidence: normalizeConfidence(input.input.confidence),
    riskEstimate: input.riskEstimate,
    reasoningTier: input.reasoningTier,
    requiresLLM: input.requiresLLM,
    unsupportedReason: input.unsupportedReason,
    reasonCodes: unique(input.reasonCodes),
  };
}

function resolveCapabilities(capabilityIds: string[]): Array<CapabilityDefinition | undefined> {
  return capabilityIds.map((capabilityId) => getChatCoreV2Capability(capabilityId));
}

function inferRouteMethod(
  intent: ChatCoreV2Intent,
  capabilities: CapabilityDefinition[],
): ChatCoreV2RouteMethod {
  if (intent === 'planning' && capabilities.length > 1) return 'planner';
  if (capabilities.length === 0) return 'unsupported';
  if (capabilities.every((capability) => capability.routeMethods.includes('deterministic_read'))) {
    return 'deterministic_read';
  }
  if (capabilities.some((capability) => capability.routeMethods.includes('llm_command_translation'))) {
    return 'llm_command_translation';
  }
  if (capabilities.some((capability) => capability.routeMethods.includes('llm_synthesis'))) {
    return 'llm_synthesis';
  }
  return capabilities[0].routeMethods[0] ?? 'unsupported';
}

function estimateRisk(capabilities: CapabilityDefinition[]): ActionRisk {
  return capabilities.reduce<ActionRisk>((current, capability) => {
    return RISK_ORDER.indexOf(capability.risk) > RISK_ORDER.indexOf(current) ? capability.risk : current;
  }, 'low');
}

function estimateReasoningTier(
  capabilities: CapabilityDefinition[],
  routeMethod?: ChatCoreV2RouteMethod,
): ReasoningTier {
  if (routeMethod === 'deterministic_read' || routeMethod === 'needs_clarification' || routeMethod === 'blocked') {
    return 'none';
  }
  if (routeMethod === 'planner') return 'planner';
  if (routeMethod === 'background_planner') return 'background_planner';

  return capabilities.reduce<ReasoningTier>((current, capability) => {
    return REASONING_ORDER.indexOf(capability.reasoningTier) > REASONING_ORDER.indexOf(current)
      ? capability.reasoningTier
      : current;
  }, 'none');
}

function normalizeConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.min(1, Math.max(0, confidence));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * WP-16 (§5.G): hoist the memory-affine domain to the front so it becomes the
 * primaryDomain, preserving the relative order of the rest. A no-op (returns the
 * input array unchanged) when no affine domain is supplied OR it is not present
 * in the candidate set OR it is already first — so the legacy ordering, and thus
 * every legacy decision, is byte-identical when memory does not apply.
 */
function hoistMemoryAffineDomain(
  domains: ChatCoreV2Domain[],
  memoryAffineDomain?: ChatCoreV2Domain,
): ChatCoreV2Domain[] {
  if (!memoryAffineDomain) return domains;
  const index = domains.indexOf(memoryAffineDomain);
  if (index <= 0) return domains;
  return [memoryAffineDomain, ...domains.slice(0, index), ...domains.slice(index + 1)];
}

// 'enforce'-mode prepass narrowing: keep only the caller's capability IDs that
// the prepass also proposed (preserving the caller's order). Falls back to the
// caller's full set when the intersection is empty so we never route on nothing.
function intersectPreservingOrder(original: string[], candidates: string[]): string[] {
  const candidateSet = new Set(candidates);
  const intersection = original.filter((id) => candidateSet.has(id));
  return intersection.length > 0 ? intersection : original;
}

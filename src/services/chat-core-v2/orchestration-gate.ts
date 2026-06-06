// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';

import { logger } from '../../utils/logger';
import { getDb } from '../database';
import {
  resolveChatCoreV2ActivationConfig,
  resolveChatCoreV2AllowedDomainsForTenant,
  isChatCoreV2MasterKillSwitchOff,
  type ChatCoreV2ActivationConfig,
} from './activation-flags';
import {
  incrementLegacyFallback,
  incrementLegacyFallbackAttribution,
  type LegacyFallbackAttributionInput,
} from './autorevert-counters-store';
import { classifyShadowRoute } from './shadow-route-classifier';
import {
  buildChatCoreV2RouteDecision,
  type ChatCoreV2RouteDecision,
} from './route-decision';
import type { ChatCoreV2MemoryContextItem } from './memory-store-reader';
import { getChatCoreV2ReasoningPolicy } from './reasoning-policies';
import { checkRuntimeBudget, EMPTY_RUNTIME_BUDGET_USAGE } from './runtime-budget';
import type { ChatCoreV2Domain } from './types';

export const CHAT_CORE_V2_ORCHESTRATION_GATE_VERSION = 'chat_core_v2_orchestration_gate@1.0.0';

/**
 * WP-16 (§5.G). The minimum classifier confidence below which the gate stays
 * INERT (returns null) and the legacy route runs unchanged. This is a named
 * constant; per §5.A/§8 tuning it requires a code change (it is NOT an env-only
 * rollback knob), which is the deliberate forcing function for retirement.
 */
export const CHAT_CORE_V2_ORCHESTRATION_GATE_MIN_CONFIDENCE = 0.68;

type EnvLike = Record<string, string | undefined>;

export interface RunChatCoreV2OrchestrationGateInput {
  /** The user's normalized message text (the live route's normalizedText). */
  message: string;
  /** Requesting tenant — used for the per-tenant allowedDomains resolution (§5.J). */
  tenantId: string | number;
  /** Requesting user (carried for logging/observability only). */
  userId?: string | number;
  /**
   * The lean, projection-only memory context already loaded for this turn
   * (WP-17 reader). Threaded into buildChatCoreV2RouteDecision so a relevant
   * domain-affinity item can change the route decision (§5.G behavior-change).
   * Omit/[] → the decision is identical to a no-memory turn.
   */
  memoryContext?: ChatCoreV2MemoryContextItem[];
  /** Optional injected env (test seam); defaults to process.env. */
  env?: EnvLike;
  /**
   * Optional db for the Wave-2 rank 6 per-tenant legacy-fallback counter
   * (`chat_v2_legacy_fallback_counter`, migration 177). Defaults to `getDb()`.
   * The increment is reached ONLY after the active-mode + kill-switch guards
   * have passed, so it is provably off-mode inert — the off-mode live route
   * returns null at the very first guard and never writes. A test seam so unit
   * tests can supply an in-memory db (or omit it; a getDb() failure is swallowed
   * by the fire-and-forget counter).
   */
  legacyFallbackDb?: Database.Database;
  /** Optional clock injection for the counter's hour bucket (test seam). */
  now?: Date;
}

/**
 * WP-16 (§5.G) gate result. Non-null ONLY when the gate decides the v2
 * orchestrator should drive this turn. `overrideDomain` is the (already
 * allowlist-filtered, per-tenant) Chat Core v2 domain to route to; the
 * route-decision carries the full v2 plan for logging/turn-contract.
 */
export interface ChatCoreV2OrchestrationGateResult {
  gateVersion: string;
  /** The v2 route decision (prepass ran ONCE inside buildChatCoreV2RouteDecision). */
  routeDecision: ChatCoreV2RouteDecision;
  /**
   * The Chat Core v2 domain to override the legacy route with. Guaranteed to be
   * present in the requesting tenant's resolved allowedDomains. Undefined when
   * the decision has no primary domain or the primary domain is not allowlisted
   * (the caller then keeps the legacy domain but may still log the v2 plan).
   */
  overrideDomain?: ChatCoreV2Domain;
  /** The resolved activation mode this decision was made under ('canary'|'on'). */
  mode: 'canary' | 'on';
  /**
   * The pre-flight runtime-budget verdict (§8). NOTE: this is structurally
   * always-ok for any tier with maxModelCalls>0 because EMPTY usage is all
   * zeros — it is a PRE-FLIGHT sanity check, NOT a usage enforcer. It makes no
   * safety claim and never gates the live turn.
   */
  budgetPreflightOk: boolean;
}

/** Route methods that mean "the v2 plan declines to drive this turn" → null. */
const NON_DRIVING_ROUTE_METHODS = new Set<ChatCoreV2RouteDecision['routeMethod']>([
  'needs_clarification',
  'unsupported',
  'blocked',
]);

/**
 * WP-16 (§5.G) — Orchestration gate intercept. The KEYSTONE of the live chat
 * route. Designed to be INERT and never break the live route:
 *
 *  1. Returns null UNLESS the env activation mode is 'canary' or 'on' AND the
 *     per-tenant master kill-switch is not forcing this tenant off. For mode
 *     unset/'shadow'/'off' the gate is a no-op and the legacy route runs
 *     byte-for-byte unchanged. CRITICALLY, it ALSO honors the WP-07 per-tenant
 *     runtime-override Map: a tenant demoted to shadow/off by the auto-revert
 *     valve (`isChatCoreV2MasterKillSwitchOff(env, tenantId)`) forces null even
 *     under a canary/on env, so the gate stays consistent with the two live
 *     parsers (action-gateway.ts and local-chat-orchestrator.ts both consult
 *     the same chokepoint). This is the core safety property.
 *  2. Returns null when classifyShadowRoute confidence < 0.68 (low-confidence
 *     fallthrough to legacy).
 *  3. Calls buildChatCoreV2RouteDecision with the RAW classifier capabilityIds
 *     + message + the loaded memoryContext. It deliberately does NOT call
 *     selectPrepassCandidateCapabilities itself — §5.G: prepass runs ONCE,
 *     inside buildChatCoreV2RouteDecision.
 *  4. Returns null on needs_clarification / unsupported / blocked route methods
 *     (the v2 plan declines; legacy handles it).
 *  5. overrideDomain is honored ONLY if it is in the requesting tenant's
 *     resolved allowedDomains — the global env allowlist INTERSECTED with this
 *     tenant's per-tenant `allowedDomains` override when one is set (genuinely
 *     per-tenant, narrow-only, §5.J). Two tenants can resolve to two different
 *     allowlists with no cross-tenant leak.
 *  6. The ENTIRE body is wrapped in try/catch → return null. The gate must
 *     NEVER throw into the live route.
 */
export function runChatCoreV2OrchestrationGate(
  input: RunChatCoreV2OrchestrationGateInput,
): ChatCoreV2OrchestrationGateResult | null {
  try {
    const env = input.env ?? process.env;

    // (1) KILL-SWITCH / INERT GUARD — the core safety property, in two parts:
    //   (1a) the env activation mode must be a driving mode (canary/on);
    //   (1b) the WP-07 per-tenant master kill-switch must not be forcing THIS
    //        tenant off. The auto-revert valve demotes a single tenant to
    //        shadow/off via the runtime-override Map WITHOUT a restart, and the
    //        two live parsers (action-gateway.ts:143, local-chat-orchestrator.ts:175)
    //        both honor it through isChatCoreV2MasterKillSwitchOff — the gate
    //        MUST too, or a demoted tenant would still be driven here. A
    //        per-tenant demotion therefore forces null EVEN under a canary/on env.
    const config: ChatCoreV2ActivationConfig = resolveChatCoreV2ActivationConfig(env);
    if (config.mode !== 'canary' && config.mode !== 'on') {
      return null;
    }
    if (isChatCoreV2MasterKillSwitchOff(env, String(input.tenantId))) {
      return null;
    }

    // From here on the env mode is canary/on AND this tenant is NOT killed/off,
    // so EVERY active-mode turn observed below is a real fallback-counter sample.
    // This is the load-bearing OFF-MODE INERTNESS boundary for the legacy-fallback
    // counter: an off-mode (or killed-tenant) turn returned null at guard (1)
    // ABOVE and never reaches `emitLegacyFallback`. Fire-and-forget; never throws.
    const emitLegacyFallback = (
      fellBack: boolean,
      attribution: Omit<LegacyFallbackAttributionInput, 'fellBack'> = {},
    ): void => {
      try {
        const db = input.legacyFallbackDb ?? getDb();
        const now = input.now ?? new Date();
        incrementLegacyFallback(db, String(input.tenantId), { fellBack }, now);
        incrementLegacyFallbackAttribution(db, String(input.tenantId), { fellBack, ...attribution }, now);
      } catch {
        // Belt-and-suspenders: a getDb()/counter failure must never break the
        // gate. The counter itself is already fire-and-forget.
      }
    };

    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (message.length === 0) {
      // Empty message is not a real chat turn — not a fallback SAMPLE; do not
      // count it (counting it would dilute the rate with non-turns).
      return null;
    }

    // (2) Classify. Low confidence falls through to the legacy route → fallback.
    const guess = classifyShadowRoute(message);
    if (!Number.isFinite(guess.confidence) || guess.confidence < CHAT_CORE_V2_ORCHESTRATION_GATE_MIN_CONFIDENCE) {
      emitLegacyFallback(true, {
        domain: guess.domains[0] ?? 'unknown',
        routeOwner: 'shadow_route_classifier',
        routeMethod: 'low_confidence',
      });
      return null;
    }

    // (3) Build the v2 route decision. RAW classifier capabilityIds + message +
    // memoryContext. Prepass runs ONCE INSIDE buildChatCoreV2RouteDecision —
    // the gate never calls selectPrepassCandidateCapabilities (§5.G).
    const routeDecision = buildChatCoreV2RouteDecision({
      intent: guess.intent,
      confidence: guess.confidence,
      domains: guess.domains,
      capabilityIds: guess.capabilityIds,
      unsupportedReason: guess.unsupportedReason,
      // Enforce so the single prepass actually narrows the route under canary/on.
      prepassMode: 'enforce',
      message,
      memoryContext: input.memoryContext,
    });

    // (4) The v2 plan declines to drive these turns; legacy handles them →
    // fallback.
    if (NON_DRIVING_ROUTE_METHODS.has(routeDecision.routeMethod)) {
      emitLegacyFallback(true, {
        domain: routeDecision.primaryDomain ?? guess.domains[0] ?? 'unknown',
        routeOwner: 'chat_core_v2_route_decision',
        routeMethod: routeDecision.routeMethod,
      });
      return null;
    }

    // (5) Per-tenant allowedDomains filtering (§5.J). overrideDomain is honored
    // ONLY when the v2 primary domain is in the requesting tenant's resolved
    // allowlist. A domain outside the allowlist is NOT applied (the gate result
    // still returns the plan for logging, but with no overrideDomain).
    const allowedDomains = resolveAllowedDomainsForTenant(env, input.tenantId);
    const primaryDomain = routeDecision.primaryDomain;
    const overrideDomain = primaryDomain && allowedDomains.has(primaryDomain)
      ? primaryDomain
      : undefined;

    // PRE-FLIGHT ONLY (§8): structurally always-ok for tiers with
    // maxModelCalls>0 (EMPTY usage is all zeros). NOT a usage enforcer — makes
    // no safety claim and never blocks the turn.
    const policy = getChatCoreV2ReasoningPolicy(routeDecision.reasoningTier);
    const budgetPreflightOk = checkRuntimeBudget(policy, EMPTY_RUNTIME_BUDGET_USAGE).ok;

    // A non-allowlisted primary domain yields NO overrideDomain: the v2 plan did
    // not actually drive the domain choice, so legacy still keeps it → fallback.
    // An applied overrideDomain means the gate drove this turn → NOT a fallback.
    emitLegacyFallback(overrideDomain === undefined, {
      domain: overrideDomain ?? primaryDomain ?? guess.domains[0] ?? 'unknown',
      routeOwner: overrideDomain === undefined
        ? 'chat_core_v2_allowed_domain_gate'
        : 'chat_core_v2_orchestration_gate',
      routeMethod: routeDecision.routeMethod,
    });

    return {
      gateVersion: CHAT_CORE_V2_ORCHESTRATION_GATE_VERSION,
      routeDecision,
      overrideDomain,
      mode: config.mode,
      budgetPreflightOk,
    };
  } catch (err) {
    // (6) NEVER throw into the live route. Any failure → null (legacy runs).
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        gateVersion: CHAT_CORE_V2_ORCHESTRATION_GATE_VERSION,
        tenantId: input.tenantId,
        userId: input.userId,
      },
      'Chat Core v2 orchestration gate failed; falling back to legacy route',
    );
    return null;
  }
}

/**
 * WP-16 (§5.J). Resolve the requesting tenant's allowedDomains as a Set —
 * GENUINELY per-tenant. The base is the global, env-derived allowedDomains
 * (`CHAT_CORE_V2_ALLOWED_DOMAINS`). When the requesting tenant carries an
 * `allowedDomains` runtime override (WP-07 Map), the result is the INTERSECTION
 * of the global set and that override — i.e. an override can only NARROW the
 * tenant's surface, never expand it past the global allowlist (same demote-only
 * invariant the rest of the override carries). Tenants WITHOUT an override get
 * the global set unchanged. Two tenants can therefore resolve to two different
 * allowlists with no cross-tenant leak: the override Map is keyed per tenant.
 */
function resolveAllowedDomainsForTenant(
  env: EnvLike,
  tenantId: string | number,
): Set<ChatCoreV2Domain> {
  return resolveChatCoreV2AllowedDomainsForTenant(env, tenantId);
}

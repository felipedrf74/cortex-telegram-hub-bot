// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-3 rank 7 — an INERT, canary-only boot guard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CANARY-ONLY INERTNESS (the load-bearing invariant of this module):
 *   Every behavior here is a strict NO-OP unless
 *   `resolveChatCoreV2ActivationConfig(env).mode === 'canary'`. In off / shadow /
 *   on / absent (absent parses to 'off') the guard does NOTHING — it never
 *   throws, never writes, never touches boot. `assertCanaryGateOrThrow` returns
 *   immediately and `shouldServeCanaryForTenant` returns false in those modes.
 *
 * THROW, NEVER process.exit:
 *   When mode === 'canary' and the gate is not allowed, `assertCanaryGateOrThrow`
 *   THROWS. It is wired into `src/index.ts main()`, whose existing
 *   `main().catch(...)` handler is the single place that calls process.exit. This
 *   module MUST NOT call process.exit itself.
 *
 * THIS IS NOT THE PROMOTION GATE:
 *   The 0.90 Phase-2→3 promotion authority is `gateCanPromote`
 *   (gate-metrics-store.ts), which stays false until a real (non-synthetic,
 *   peer-reviewed) corpus is persisted. This module NEVER reads `gateCanPromote`
 *   and NEVER claims promotion-readiness. The recall floor here (default 0.80) is
 *   a SEPARATE, coarse boot sanity floor computed from the SYNTHETIC seed — a
 *   minimum-viable-boot check, not a promotion signal.
 *
 * PRIVACY:
 *   No raw user message/prompt text is read, stored, or logged. The verdict
 *   carries only safe scalars (numbers, booleans, mode, tenant-id cohort list)
 *   and reason codes from a fixed vocabulary.
 */

import {
  resolveChatCoreV2ActivationConfig,
  isChatCoreV2MasterKillSwitchOff,
  type ChatCoreV2OrchestratorMode,
} from './activation-flags';
import { evaluateGoldenCorpusPrepassRecallAtK } from './prepass-recall-eval';
import { selectPrepassCandidateCapabilities } from './prepass-candidate-selection';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SEED } from './golden-corpus-seed';
import type { ChatCoreV2GoldenCorpus } from './golden-corpus';

export const CHAT_CORE_V2_CANARY_GATE_GUARD_VERSION = 'chat_core_v2_canary_gate_guard@1.0.0';

type EnvLike = Record<string, string | undefined>;

/**
 * recall@k used by the coarse boot floor. Fixed at 8 to match the prepass
 * candidate cap (recall@8 covers the full top-k set).
 */
const CANARY_GATE_RECALL_K = 8;

/**
 * Default coarse boot sanity floor for recall@8 (rank-7 boot floor). This is
 * INTENTIONALLY the 0.80 minimum-viable-boot check, NOT the 0.90 promotion gate
 * (gateCanPromote owns that). Overridable per-env via
 * CHAT_CORE_V2_CANARY_MIN_RECALL_AT_8.
 */
export const CHAT_CORE_V2_CANARY_DEFAULT_MIN_RECALL_AT_8 = 0.8;

/**
 * Reason codes the verdict can carry. Fixed vocabulary (no free text, no user
 * content) so the verdict is safe to log.
 */
export type CanaryGateReason =
  | 'recall_below_floor'
  | 'prod_override_refused'
  | 'empty_cohort'
  | 'ok';

/**
 * A PURE verdict. Carries only safe scalars + the cohort tenant-id list + reason
 * codes. NEVER references gateCanPromote and NEVER claims promotion-readiness.
 */
export interface CanaryGateVerdict {
  /** Whether the coarse boot floor (and prod-override escape hatch) permit canary boot. */
  allowed: boolean;
  /** Fixed-vocabulary reason codes explaining the verdict. */
  reasons: CanaryGateReason[];
  /** Measured synthetic-seed recall@8 (the coarse boot signal, NOT promotion-readiness). */
  recallAt8: number;
  /** The coarse boot floor that recall@8 was compared against (default 0.80). */
  minRecallAt8: number;
  /** The resolved canary cohort tenant ids (safe identifiers; never message text). */
  cohortTenantIds: string[];
  /** The resolved orchestrator mode at evaluation time. */
  mode: ChatCoreV2OrchestratorMode;
}

export interface EvaluateCanaryGateDeps {
  /** Environment source. Defaults to process.env. */
  env?: EnvLike;
  /** Corpus to measure recall over. Defaults to the SYNTHETIC seed. */
  corpus?: ChatCoreV2GoldenCorpus;
  /** Candidate producer for the recall eval. Defaults to the prepass selector. */
  producer?: (message: string) => string[];
  /** Injectable clock (reserved; not currently read). Kept for parity with peers. */
  now?: () => number;
}

const defaultCandidateProducer = (message: string): string[] =>
  selectPrepassCandidateCapabilities({ message }).candidateCapabilityIds;

/**
 * Parse the canary cohort tenant-id allowlist
 * (CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS, a comma-separated list). An
 * empty/absent list yields an EMPTY cohort — i.e. no tenant is in canary.
 */
function parseCohortTenantIds(env: EnvLike): string[] {
  const raw = env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS ?? '';
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(ids)];
}

/**
 * True iff `tenantId` is in the canary cohort allowlist. An empty/absent list
 * means no tenant is in canary (closed by default).
 */
export function isTenantInCanaryCohort(tenantId: string | undefined, env: EnvLike = process.env): boolean {
  if (tenantId === undefined || tenantId.trim().length === 0) return false;
  return parseCohortTenantIds(env).includes(tenantId);
}

/** Resolve the coarse boot floor for recall@8 (default 0.80). Clamped to [0, 1]. */
function resolveMinRecallAt8(env: EnvLike): number {
  const raw = env.CHAT_CORE_V2_CANARY_MIN_RECALL_AT_8;
  if (raw === undefined) return CHAT_CORE_V2_CANARY_DEFAULT_MIN_RECALL_AT_8;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return CHAT_CORE_V2_CANARY_DEFAULT_MIN_RECALL_AT_8;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * A PURE verdict for the canary boot gate. Composes three independent checks:
 *
 *  1. recall floor — synthetic-seed recall@8 vs. the coarse boot floor (0.80).
 *     Below the floor => allowed=false, reason 'recall_below_floor'.
 *
 *  2. prod-override refusal — if NODE_ENV==='production' AND a
 *     CHAT_CORE_V2_CANARY_GATE_OVERRIDE is set AND the prod-allow escape hatch
 *     (CHAT_CORE_V2_CANARY_ALLOW_PROD — the SAME flag name reused from
 *     chat-message-routes.ts) is NOT '1' => allowed=false, reason
 *     'prod_override_refused'. This makes a production override an explicit,
 *     opt-in act rather than something a stray env var can silently flip on.
 *
 *  3. empty cohort — when the cohort allowlist is empty we record an
 *     'empty_cohort' reason but DO NOT flip allowed to false. DESIGN CHOICE: an
 *     empty cohort is the safe default-closed serving state (no tenant is
 *     served — see shouldServeCanaryForTenant), so it must NOT block boot. The
 *     boot floor's job is to refuse a structurally-broken build, not to demand a
 *     populated cohort. Surfacing 'empty_cohort' keeps the verdict honest/
 *     observable without coupling boot to operator cohort configuration.
 *
 * This verdict NEVER reads gateCanPromote and NEVER claims promotion-readiness.
 */
export function evaluateCanaryGate(deps: EvaluateCanaryGateDeps = {}): CanaryGateVerdict {
  const env = deps.env ?? process.env;
  const corpus = deps.corpus ?? CHAT_CORE_V2_GOLDEN_CORPUS_SEED;
  const producer = deps.producer ?? defaultCandidateProducer;
  const mode = resolveChatCoreV2ActivationConfig(env).mode;

  const recall = evaluateGoldenCorpusPrepassRecallAtK(corpus, CANARY_GATE_RECALL_K, producer);
  const recallAt8 = recall.recallAtK;
  const minRecallAt8 = resolveMinRecallAt8(env);
  const cohortTenantIds = parseCohortTenantIds(env);

  const reasons: CanaryGateReason[] = [];
  let allowed = true;

  if (recallAt8 < minRecallAt8) {
    allowed = false;
    reasons.push('recall_below_floor');
  }

  const overrideSet = String(env.CHAT_CORE_V2_CANARY_GATE_OVERRIDE ?? '').trim().length > 0;
  const isProduction = env.NODE_ENV === 'production';
  // REUSE the exact prod-allow escape-hatch flag from chat-message-routes.ts:557.
  const allowProd = env.CHAT_CORE_V2_CANARY_ALLOW_PROD === '1';
  if (isProduction && overrideSet && !allowProd) {
    allowed = false;
    reasons.push('prod_override_refused');
  }

  if (cohortTenantIds.length === 0) {
    // Observed, not blocking — see the design-choice note above.
    reasons.push('empty_cohort');
  }

  if (allowed && reasons.length === 0) reasons.push('ok');

  return { allowed, reasons, recallAt8, minRecallAt8, cohortTenantIds, mode };
}

export interface AssertCanaryGateDeps extends EvaluateCanaryGateDeps {}

/**
 * Boot guard. STRICT NO-OP unless the orchestrator mode is 'canary'. When mode
 * is 'canary' and `evaluateCanaryGate().allowed === false`, THROWS an Error
 * carrying the reason codes (so main()'s existing error handler in
 * src/index.ts handles exit). NEVER calls process.exit. In off/shadow/on/absent
 * it returns immediately and the boot is byte-unchanged.
 */
export function assertCanaryGateOrThrow(deps: AssertCanaryGateDeps = {}): void {
  const env = deps.env ?? process.env;
  if (resolveChatCoreV2ActivationConfig(env).mode !== 'canary') return;

  const verdict = evaluateCanaryGate(deps);
  if (verdict.allowed) return;

  const reasons = verdict.reasons.filter((reason) => reason !== 'ok' && reason !== 'empty_cohort');
  throw new Error(
    `Chat Core v2 canary boot gate refused: ${reasons.join(', ')} ` +
      `(recall@8=${verdict.recallAt8.toFixed(4)} floor=${verdict.minRecallAt8}). ` +
      'This is the coarse boot floor, NOT the 0.90 promotion gate.',
  );
}

/**
 * Whether canary serving should be ACTIVE for a specific tenant. True iff ALL:
 *   - the orchestrator mode is 'canary', AND
 *   - the per-turn master kill-switch is NOT off for this tenant
 *     (isChatCoreV2MasterKillSwitchOff honors the per-tenant runtime override), AND
 *   - the tenant is in the canary cohort allowlist.
 *
 * In off/shadow/on/absent this is always false. A per-tenant demotion (override
 * forcing off/shadow) flips a cohort tenant back to false WITHOUT a restart.
 */
export function shouldServeCanaryForTenant(tenantId: string | undefined, env: EnvLike = process.env): boolean {
  if (resolveChatCoreV2ActivationConfig(env).mode !== 'canary') return false;
  if (isChatCoreV2MasterKillSwitchOff(env, tenantId)) return false;
  return isTenantInCanaryCohort(tenantId, env);
}

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Chat M20 — ChatV2 route-exit evidence sampler + retirement campaign read API.
//
// Converts existing capture sources into persisted per-route evidence rows
// (table chat_v2_route_exit_samples, migration 257):
//
//   kind='parity'  ← shadow-route replay bundles (chat_v2_replay_bundles,
//                    written by runChatCoreV2ShadowRouteHook). A bundle does
//                    NOT record the live legacy route's final output; what it
//                    DOES record is the M4 routingDivergence record, whose
//                    `surfaces` include the LIVE legacy routing-surface
//                    decisions recomputed for the same text (the legacy
//                    orchestrator's primaryDomain and the legacy classifier's
//                    keyword domain) alongside the v2 shadow route domains.
//                    Parity is derived from THAT legacy-vs-v2 comparison:
//                    the legacy surface domain must be contained in the v2
//                    shadow domains mapped through V2_TO_LEGACY_DOMAIN (the
//                    same mapping the divergence record was built with).
//                    Bundles without a usable comparison (pre-M4 bundles with
//                    no divergence record, no legacy surface decision, or no
//                    v2 domains) become parity_unknown (parity NULL) and are
//                    EXCLUDED from both the retirement gate's 50-sample floor
//                    and the parity rate — never vacuous passes.
//
//   kind='health'  ← online-eval sampler captures (chat_v2_online_eval_samples).
//                    These record whether a v2 capture was clean or a v2
//                    failure (schema failure, refusal, timeout, fallback...).
//                    That is a v2-HEALTH signal, not a legacy-vs-v2 parity
//                    observation, so health rows are stored as campaign
//                    context only and are EXCLUDED from the retirement gate.
//
// Eval-history per-scenario rows (chat_eval_scenario_results) are NOT a
// source. The writer (chat-eval-history.persistChatEvalRun) persists
// scores_json as a NUMERIC ChatEvalScores map and notes_json as free-text
// sentences; no per-scenario routeMethod or legacy route id is persisted
// anywhere in that table, so no honest route attribution is possible and the
// source is dropped rather than parsed with patterns that can never match.
//
// SYNC IS A FULL RESCAN: both source tables upsert IN PLACE under their
// natural key (recordChatV2ReplayBundle → ON CONFLICT(replay_bundle_id),
// recordChatV2OnlineEvalSample → ON CONFLICT(sample_id)) and neither carries
// an updated_at column, so an id high-water mark would silently miss
// refreshed rows. Correctness beats incrementality: every sync rescans both
// (retention-bounded) tables and refreshes existing evidence rows via
// INSERT ... ON CONFLICT(source, source_key) DO UPDATE.
//
// CAMPAIGN MACHINERY ONLY: nothing in this module reads or flips route flags.
// Flag flipping is owner-gated production work.
//
// Dashboard wiring note (M22 integrator): the chat-quality dashboard can
// surface the campaign with one line —
//   campaign: buildChatV2RetirementCampaign(db)
// (chat-quality-dashboard.ts is owned by the M22 surface; this module only
// exposes the read API.)

import Database from 'better-sqlite3';
import {
  DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS,
  evaluateChatLegacyRetirementReadiness,
  type ChatLegacyRetirementGateResult,
  type ChatLegacyRouteExitSample,
} from './chat-legacy-retirement-readiness';
import { CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS } from './chat-legacy-parity-route-prompts';
import { V2_TO_LEGACY_DOMAIN } from './intent-resolution/divergence-shadow';

export const NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION = 'nexus_chat_route_exit_sampler.v2';

export type ChatRouteExitSampleSource = 'shadow_replay_bundle' | 'online_eval_sample';
export type ChatRouteExitSampleKind = 'parity' | 'health';

/**
 * The REAL Phase-7 legacy route ids (deduplicated from the frozen held-out
 * parity corpus). These are the required route ids the retirement gate must
 * see evidence for.
 */
export const CHAT_V2_RETIREMENT_REQUIRED_ROUTE_IDS: readonly string[] = [
  ...new Set(CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.map((route) => route.routeId)),
];

/**
 * Campaign order (safest exit first). The plan's conceptual stages are mapped
 * onto the REAL route ids of the frozen corpus:
 *   deterministic-read  → chat_message_shortcut_after_route
 *   cached/local answer → training_plan_shortcut (local response shortcut)
 *   identity/confirm    → decision_confirmation_shortcut
 *   planner             → chat_reasoning_engine_v1
 *   attachments/firewall→ destructive_confirmation_hold (no standalone
 *                         attachments legacy route exists; the write-intent
 *                         hold is the closest real route)
 *   research            → selective_internet_research
 *   local answer/router → classifier_route_skill_orchestration
 *   domain handler      → domain_handler_execution
 *   general planner     → general_action_planner
 */
export const CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER: readonly string[] = [
  'chat_message_shortcut_after_route',
  'training_plan_shortcut',
  'decision_confirmation_shortcut',
  'chat_reasoning_engine_v1',
  'destructive_confirmation_hold',
  'selective_internet_research',
  'classifier_route_skill_orchestration',
  'domain_handler_execution',
  'general_action_planner',
];

const CAMPAIGN_STAGES: Readonly<Record<string, string>> = {
  chat_message_shortcut_after_route: 'deterministic_read',
  training_plan_shortcut: 'cached_local_shortcut',
  decision_confirmation_shortcut: 'identity_confirmation',
  chat_reasoning_engine_v1: 'planner',
  destructive_confirmation_hold: 'write_firewall_hold',
  selective_internet_research: 'research',
  classifier_route_skill_orchestration: 'local_answer_routing',
  domain_handler_execution: 'domain_handler',
  general_action_planner: 'general_planner',
};

const REQUIRED_ROUTE_ID_SET = new Set(CHAT_V2_RETIREMENT_REQUIRED_ROUTE_IDS);

/** Online-eval capture reasons that represent a v2 failure (health signal). */
const EVAL_FAILURE_REASONS = new Set([
  'schema_failure',
  'model_refusal',
  'model_timeout',
  'fallback',
  'verification_failure',
  'policy_rejection',
]);

const DOMAIN_HANDLER_DOMAINS = new Set(['cooking', 'content', 'training', 'finance', 'secretary']);

export interface ResolveChatV2LegacyRouteIdInput {
  routeMethod?: string | null;
  domain?: string | null;
  /** Explicit override — wins when it names a real Phase-7 route id. */
  legacyRouteId?: string | null;
}

/**
 * Deterministic mapping from a ChatV2 route method (+ optional domain) to the
 * legacy route id it replaces. Returns null when the row carries no
 * resolvable route signal — such rows are skipped, never guessed.
 */
export function resolveChatV2LegacyRouteId(input: ResolveChatV2LegacyRouteIdInput): string | null {
  const explicit = (input.legacyRouteId ?? '').trim();
  if (explicit) return REQUIRED_ROUTE_ID_SET.has(explicit) ? explicit : null;

  const routeMethod = (input.routeMethod ?? '').trim();
  const domain = (input.domain ?? '').trim();
  switch (routeMethod) {
    case 'deterministic_read':
      return 'chat_message_shortcut_after_route';
    case 'llm_synthesis':
      return domain === 'training' ? 'training_plan_shortcut' : 'selective_internet_research';
    case 'llm_command_translation':
      if (domain === 'decision_center') return 'decision_confirmation_shortcut';
      if (DOMAIN_HANDLER_DOMAINS.has(domain)) return 'domain_handler_execution';
      return 'general_action_planner';
    case 'planner':
    case 'background_planner':
      return 'chat_reasoning_engine_v1';
    case 'needs_clarification':
    case 'unsupported':
      return 'classifier_route_skill_orchestration';
    case 'blocked':
      return 'destructive_confirmation_hold';
    default:
      return null;
  }
}

// ─── storage ─────────────────────────────────────────────────────────────

/** True when migration 257's evidence table exists. Never runs DDL. */
export function isChatRouteExitSamplerMigrationApplied(db: Database.Database): boolean {
  return tableExists(db, 'chat_v2_route_exit_samples');
}

/**
 * Mirrors migration 257 for non-migrated (bare :memory:) WRITABLE databases.
 * On a migrated database this is a no-op. On a READONLY connection this
 * NEVER runs DDL — it returns false so callers can report "migration 257
 * not applied" honestly instead of throwing.
 */
export function ensureChatRouteExitSamplerTables(db: Database.Database): boolean {
  if (isChatRouteExitSamplerMigrationApplied(db)) return true;
  if (db.readonly) return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_route_exit_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN (
        'shadow_replay_bundle', 'online_eval_sample'
      )),
      source_row_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      route_id TEXT NOT NULL,
      route_method TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('parity', 'health')),
      parity INTEGER CHECK (parity IN (0, 1)),
      health_ok INTEGER CHECK (health_ok IN (0, 1)),
      reason TEXT,
      sampled_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source, source_key),
      CHECK (kind <> 'health' OR parity IS NULL),
      CHECK (kind <> 'parity' OR health_ok IS NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_route_exit_samples_route
      ON chat_v2_route_exit_samples(route_id, kind, sampled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_route_exit_samples_source
      ON chat_v2_route_exit_samples(source, source_row_id DESC);
  `);
  return true;
}

export interface ChatRouteExitSourceSyncResult {
  /** Source rows scanned this sync (full rescan — see module comment). */
  scanned: number;
  /** Rows converted into NEW evidence rows. */
  converted: number;
  /** Existing evidence rows refreshed from an in-place source upsert. */
  refreshed: number;
  /** Rows without a resolvable route signal (or not applicable). */
  skipped: number;
}

export interface SyncChatRouteExitSamplesResult {
  version: typeof NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION;
  sources: Record<ChatRouteExitSampleSource, ChatRouteExitSourceSyncResult>;
}

interface CandidateSample {
  sourceRowId: number;
  sourceKey: string;
  routeId: string;
  routeMethod: string | null;
  kind: ChatRouteExitSampleKind;
  /** 1/0 for known parity, null for parity_unknown or health rows. */
  parity: 0 | 1 | null;
  /** 1/0 for health rows, null for parity rows. */
  healthOk: 0 | 1 | null;
  reason: string;
  sampledAt: string;
}

/**
 * Converts both evidence sources into persisted route-exit evidence rows.
 * Safe to re-run at any time: rows dedupe on the source natural key and
 * in-place source upserts refresh the corresponding evidence row.
 */
export function syncChatRouteExitSamples(
  db: Database.Database,
  options: { now?: Date } = {},
): SyncChatRouteExitSamplesResult {
  if (!ensureChatRouteExitSamplerTables(db)) {
    throw new Error('chat_v2_route_exit_samples missing and connection is readonly (migration 257 not applied)');
  }
  const now = (options.now ?? new Date()).toISOString();
  return {
    version: NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION,
    sources: {
      shadow_replay_bundle: syncSource(db, 'shadow_replay_bundle', now, scanShadowReplayBundles),
      online_eval_sample: syncSource(db, 'online_eval_sample', now, scanOnlineEvalSamples),
    },
  };
}

type SourceScanner = (
  db: Database.Database,
) => { candidates: CandidateSample[]; scanned: number; skipped: number };

function syncSource(
  db: Database.Database,
  source: ChatRouteExitSampleSource,
  now: string,
  scan: SourceScanner,
): ChatRouteExitSourceSyncResult {
  const { candidates, scanned, skipped } = scan(db);

  const existingKeys = new Set(
    (db.prepare('SELECT source_key FROM chat_v2_route_exit_samples WHERE source = ?')
      .all(source) as Array<{ source_key: string }>)
      .map((row) => row.source_key),
  );

  let converted = 0;
  let refreshed = 0;
  const upsert = db.prepare(`
    INSERT INTO chat_v2_route_exit_samples (
      source, source_row_id, source_key, route_id, route_method,
      kind, parity, health_ok, reason, sampled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_key) DO UPDATE SET
      source_row_id = excluded.source_row_id,
      route_id = excluded.route_id,
      route_method = excluded.route_method,
      kind = excluded.kind,
      parity = excluded.parity,
      health_ok = excluded.health_ok,
      reason = excluded.reason,
      sampled_at = excluded.sampled_at,
      updated_at = excluded.updated_at
  `);
  const apply = db.transaction(() => {
    for (const candidate of candidates) {
      upsert.run(
        source,
        candidate.sourceRowId,
        candidate.sourceKey,
        candidate.routeId,
        candidate.routeMethod,
        candidate.kind,
        candidate.parity,
        candidate.healthOk,
        candidate.reason,
        candidate.sampledAt,
        now,
        now,
      );
      if (existingKeys.has(candidate.sourceKey)) refreshed += 1;
      else converted += 1;
    }
  });
  apply();

  return { scanned, converted, refreshed, skipped };
}

// ─── source: shadow-route replay bundles (parity) ────────────────────────

function scanShadowReplayBundles(db: Database.Database): ReturnType<SourceScanner> {
  if (!tableExists(db, 'chat_v2_replay_bundles')) {
    return { candidates: [], scanned: 0, skipped: 0 };
  }
  const rows = db.prepare(`
    SELECT id, replay_bundle_id, redacted_bundle_json, created_at
    FROM chat_v2_replay_bundles
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    replay_bundle_id: string;
    redacted_bundle_json: string;
    created_at: string;
  }>;

  const candidates: CandidateSample[] = [];
  let skipped = 0;
  for (const row of rows) {
    const bundle = parseJsonObject(row.redacted_bundle_json);
    const contextPack = asObject(bundle.contextPack);
    const response = asObject(bundle.response);
    const routeDecision = asObject(bundle.routeDecision);
    const isShadowRecording = response.type === 'chat_core_v2_shadow_plan'
      || typeof contextPack.shadowRouteHookVersion === 'string';
    if (!isShadowRecording) {
      skipped += 1;
      continue;
    }
    const routeMethod = firstString(response.routeMethod, routeDecision.routeMethod);
    const domain = firstString(
      firstArrayEntry(contextPack.guessedDomains),
      firstArrayEntry(routeDecision.domains),
    );
    const legacyRouteId = firstString(contextPack.legacyRouteId);
    const routeId = resolveChatV2LegacyRouteId({ routeMethod, domain, legacyRouteId });
    if (!routeId) {
      skipped += 1;
      continue;
    }
    const parity = shadowBundleLegacyV2Parity(contextPack);
    candidates.push({
      sourceRowId: row.id,
      sourceKey: row.replay_bundle_id,
      routeId,
      routeMethod: routeMethod ?? null,
      kind: 'parity',
      parity: parity.parity,
      healthOk: null,
      reason: parity.reason,
      sampledAt: row.created_at,
    });
  }
  return { candidates, scanned: rows.length, skipped };
}

/**
 * Legacy-vs-v2 routing parity for a shadow recording, derived from the M4
 * routingDivergence record's SURFACES (not its resolver-agreement flags — the
 * agreement flags compare the deterministic manifest resolver against each
 * surface, which is a resolver-quality signal, not legacy-vs-v2 parity):
 *
 *   legacy decision = orchestratorPrimaryDomain (live legacy orchestrator)
 *                     falling back to classifierKeywordDomain (live legacy
 *                     classifier keyword surface) — both already in legacy
 *                     domain space;
 *   v2 decision     = shadowRouteDomains mapped through V2_TO_LEGACY_DOMAIN.
 *
 *   parity 1 ← the legacy domain is contained in the mapped v2 domains
 *   parity 0 ← both sides decided and disagree
 *   parity null (parity_unknown) ← no divergence record (pre-M4 bundle), no
 *     legacy surface decision, or no v2 shadow domains. Unknown rows are
 *     EXCLUDED from the gate floor and rate — they can never pass vacuously.
 */
function shadowBundleLegacyV2Parity(
  contextPack: Record<string, unknown>,
): { parity: 0 | 1 | null; reason: string } {
  const divergence = asObject(contextPack.routingDivergence);
  if (Object.keys(divergence).length === 0) {
    return { parity: null, reason: 'parity_unknown_no_divergence_record' };
  }
  const surfaces = asObject(divergence.surfaces);
  const legacyDomain = firstString(
    surfaces.orchestratorPrimaryDomain,
    surfaces.classifierKeywordDomain,
  );
  if (!legacyDomain) {
    return { parity: null, reason: 'parity_unknown_no_legacy_route_decision' };
  }
  const shadowDomains = stringArray(surfaces.shadowRouteDomains);
  if (shadowDomains.length === 0) {
    return { parity: null, reason: 'parity_unknown_no_v2_route_decision' };
  }
  const v2LegacyDomains = new Set(
    shadowDomains.map((domain) => V2_TO_LEGACY_DOMAIN[domain] ?? domain),
  );
  return v2LegacyDomains.has(legacyDomain)
    ? { parity: 1, reason: 'legacy_v2_domain_agreement' }
    : { parity: 0, reason: 'legacy_v2_domain_divergence' };
}

// ─── source: online-eval sampler captures (health) ───────────────────────

function scanOnlineEvalSamples(db: Database.Database): ReturnType<SourceScanner> {
  if (!tableExists(db, 'chat_v2_online_eval_samples')) {
    return { candidates: [], scanned: 0, skipped: 0 };
  }
  const rows = db.prepare(`
    SELECT id, sample_id, route_method, domain, reason, status, metadata_json, created_at
    FROM chat_v2_online_eval_samples
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    sample_id: string;
    route_method: string;
    domain: string | null;
    reason: string;
    status: string;
    metadata_json: string;
    created_at: string;
  }>;

  const candidates: CandidateSample[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.status !== 'sampled') {
      skipped += 1;
      continue;
    }
    const metadata = parseJsonObject(row.metadata_json);
    const routeId = resolveChatV2LegacyRouteId({
      routeMethod: row.route_method,
      domain: row.domain,
      legacyRouteId: firstString(metadata.legacyRouteId),
    });
    if (!routeId) {
      skipped += 1;
      continue;
    }
    const failure = EVAL_FAILURE_REASONS.has(row.reason);
    candidates.push({
      sourceRowId: row.id,
      sourceKey: row.sample_id,
      routeId,
      routeMethod: row.route_method,
      kind: 'health',
      parity: null,
      healthOk: failure ? 0 : 1,
      reason: `eval_capture_${row.reason}`,
      sampledAt: row.created_at,
    });
  }
  return { candidates, scanned: rows.length, skipped };
}

// ─── aggregation + retirement gate integration ───────────────────────────

export interface ChatLegacyRetirementRouteEvidence {
  routeId: string;
  campaignStage: string;
  /** Known-parity samples (parity 1/0). The ONLY gate input. */
  paritySamples: number;
  parityCount: number;
  /** Rate over KNOWN parity samples only; 0 when none exist. */
  parityRate: number;
  /** parity_unknown rows — excluded from the floor and the rate. */
  parityUnknown: number;
  /** v2-health context rows — never part of the gate. */
  healthSamples: number;
  healthFailures: number;
  /** The parity gate result for this route in isolation. */
  gateResult: ChatLegacyRetirementGateResult;
  gatePassed: boolean;
  /** Known-parity samples still needed to reach the floor (0 when met). */
  missingSamples: number;
}

export interface ChatLegacyRetirementEvidence {
  version: typeof NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION;
  /** False on a readonly pre-257 connection: no evidence exists yet. */
  migrationApplied: boolean;
  routes: ChatLegacyRetirementRouteEvidence[];
  /** Gate-shaped samples for evaluateChatLegacyRetirementReadiness callers. */
  routeSamples: ChatLegacyRouteExitSample[];
}

/**
 * Aggregates the persisted evidence into per-route campaign state and
 * evaluates the PARITY-scoped retirement gate (route_shadow_parity: >=50
 * KNOWN-parity samples at >=0.95 parity) for each route in isolation.
 * parity_unknown rows and health rows are excluded from the gate.
 *
 * The full retirement decision also requires peer-review signoff, regression
 * review, the 24h fallback rate, and a clean full verify — those inputs stay
 * owner-driven (see chat-legacy-retirement-evidence.ts) and are deliberately
 * NOT synthesized here; `replaced`/`tested` are reported false so these
 * samples can never claim a route exit on their own.
 */
export function buildChatLegacyRetirementEvidence(
  db: Database.Database,
): ChatLegacyRetirementEvidence {
  const migrationApplied = ensureChatRouteExitSamplerTables(db);
  const rows = migrationApplied
    ? db.prepare(`
        SELECT
          route_id,
          SUM(CASE WHEN kind = 'parity' AND parity IS NOT NULL THEN 1 ELSE 0 END) AS parity_samples,
          SUM(CASE WHEN kind = 'parity' AND parity = 1 THEN 1 ELSE 0 END) AS parity_count,
          SUM(CASE WHEN kind = 'parity' AND parity IS NULL THEN 1 ELSE 0 END) AS parity_unknown,
          SUM(CASE WHEN kind = 'health' THEN 1 ELSE 0 END) AS health_samples,
          SUM(CASE WHEN kind = 'health' AND health_ok = 0 THEN 1 ELSE 0 END) AS health_failures
        FROM chat_v2_route_exit_samples
        GROUP BY route_id
      `).all() as Array<{
        route_id: string;
        parity_samples: number;
        parity_count: number;
        parity_unknown: number;
        health_samples: number;
        health_failures: number;
      }>
    : [];
  const byRoute = new Map(rows.map((row) => [row.route_id, row]));

  const minSamples = DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minSamplesPerRoute;
  const routes: ChatLegacyRetirementRouteEvidence[] = [];
  const routeSamples: ChatLegacyRouteExitSample[] = [];

  for (const routeId of CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER) {
    const aggregate = byRoute.get(routeId);
    const paritySamples = aggregate?.parity_samples ?? 0;
    const parityCount = aggregate?.parity_count ?? 0;
    const parityRate = paritySamples > 0 ? parityCount / paritySamples : 0;
    const routeSample: ChatLegacyRouteExitSample = {
      routeId,
      replaced: false,
      tested: false,
      shadowParityRate: parityRate,
      sampleCount: paritySamples,
    };
    routeSamples.push(routeSample);
    const gateResult = evaluateRouteParityGate(routeSample);
    routes.push({
      routeId,
      campaignStage: CAMPAIGN_STAGES[routeId] ?? 'unmapped',
      paritySamples,
      parityCount,
      parityRate,
      parityUnknown: aggregate?.parity_unknown ?? 0,
      healthSamples: aggregate?.health_samples ?? 0,
      healthFailures: aggregate?.health_failures ?? 0,
      gateResult,
      gatePassed: gateResult.passed,
      missingSamples: Math.max(0, minSamples - paritySamples),
    });
  }

  return {
    version: NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION,
    migrationApplied,
    routes,
    routeSamples,
  };
}

/**
 * Runs the pure retirement evaluator scoped to one route and extracts the
 * route_shadow_parity gate. Fallback-rate and verify inputs are passed as
 * neutral values because this helper answers ONLY "does this route's parity
 * evidence meet the floor?" — the campaign-wide gates keep their own owners.
 */
function evaluateRouteParityGate(sample: ChatLegacyRouteExitSample): ChatLegacyRetirementGateResult {
  const result = evaluateChatLegacyRetirementReadiness({
    routeSamples: [sample],
    legacyFallbackRate24h: 0,
    fullVerifyClean: true,
    requiredRouteIds: [sample.routeId],
  });
  const gate = result.gates.find((candidate) => candidate.gateId === 'route_shadow_parity');
  /* istanbul ignore next -- the evaluator always emits this gate */
  if (!gate) throw new Error('route_shadow_parity gate missing from retirement evaluation');
  return gate;
}

// ─── campaign read API (dashboard + CLI) ─────────────────────────────────

export type ChatV2RetirementRouteVerdict = 'pass' | 'fail' | 'insufficient_evidence';

export interface ChatV2RetirementCampaignRow {
  position: number;
  campaignStage: string;
  routeId: string;
  paritySamples: number;
  parityRate: number;
  parityUnknown: number;
  healthSamples: number;
  healthFailures: number;
  gatePassed: boolean;
  /**
   * Honest verdict: 'insufficient_evidence' below the known-parity floor
   * (the gate cannot be judged yet), 'fail' when the floor is met but the
   * parity rate misses the threshold, 'pass' when both are met.
   */
  verdict: ChatV2RetirementRouteVerdict;
  missingSamples: number;
}

/**
 * Per-route campaign rows in campaign order — the read API for the M22
 * chat-quality dashboard and the offline campaign CLI. Parity samples/rate
 * drive the gate; health counts are context only.
 */
export function buildChatV2RetirementCampaign(db: Database.Database): ChatV2RetirementCampaignRow[] {
  const minSamples = DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minSamplesPerRoute;
  return buildChatLegacyRetirementEvidence(db).routes.map((route, index) => ({
    position: index + 1,
    campaignStage: route.campaignStage,
    routeId: route.routeId,
    paritySamples: route.paritySamples,
    parityRate: route.parityRate,
    parityUnknown: route.parityUnknown,
    healthSamples: route.healthSamples,
    healthFailures: route.healthFailures,
    gatePassed: route.gatePassed,
    verdict: route.gatePassed
      ? 'pass'
      : route.paritySamples < minSamples
        ? 'insufficient_evidence'
        : 'fail',
    missingSamples: route.missingSamples,
  }));
}

// ─── small helpers ───────────────────────────────────────────────────────

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function firstArrayEntry(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

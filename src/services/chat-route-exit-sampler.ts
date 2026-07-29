// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Chat M20/M22 — route-retirement evidence and monitoring.
 *
 * There are deliberately two evidence tracks here:
 *
 *  1. `chat_v2_route_exit_samples` contains routing-agreement diagnostics
 *     converted from shadow replay bundles plus route-health diagnostics from
 *     online eval. These rows are useful for investigation, but neither track
 *     can prove legacy-vs-ChatV2 response behavior and neither can produce a
 *     retirement PASS.
 *
 *  2. `chat_v2_legacy_retirement_evidence` contains the aggregate result of
 *     the paired response comparator/review flow. Only the latest signed,
 *     runtime `route_exit` row created by the parity label/observation import
 *     can satisfy the behavior gate.
 *
 * The campaign is read-only. It never edits CHAT_PIPELINE_DISABLED_STAGES.
 */

import Database from 'better-sqlite3';
import type { RecordOperatorAlertInput } from './operator-alerts';
import {
  DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS,
  type ChatLegacyRouteExitSample,
} from './chat-legacy-retirement-readiness';
import {
  hasRetirementEligibleExactCurrentChatV2ObserverCorpusBinding,
  validateCurrentChatV2LegacyRetirementEvidenceRow,
} from './chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS,
} from './chat-legacy-parity-route-prompts';
import { V2_TO_LEGACY_DOMAIN } from './intent-resolution/routing-domain-map';

export {
  CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
} from './chat-legacy-parity-labels';

export const NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION = 'nexus_chat_route_exit_sampler.v3';
export const CHAT_V2_RETIREMENT_FALLBACK_WINDOW_HOURS = 24;
export const CHAT_V2_RETIREMENT_MAX_FALLBACK_RATE = 0.02;

export type ChatRouteExitSampleSource = 'shadow_replay_bundle' | 'online_eval_sample';
export type ChatRouteExitSampleKind = 'routing_diagnostic' | 'health';

export const CHAT_V2_RETIREMENT_REQUIRED_ROUTE_IDS: readonly string[] = [
  ...new Set(CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS.map((route) => route.routeId)),
];

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

const REQUIRED_ROUTE_ID_SET = new Set(CHAT_V2_RETIREMENT_REQUIRED_ROUTE_IDS);

export type ChatV2RetirementStageMappingStatus =
  | 'mapped'
  | 'shared_stage'
  | 'non_retirable'
  | 'unmapped';

export interface ChatV2RetirementStageMapping {
  campaignStage: string;
  disableStages: readonly string[];
  status: ChatV2RetirementStageMappingStatus;
  reason: string;
}

/**
 * Exact route → CHAT_PIPELINE_DISABLED_STAGES contract.
 *
 * A route is a rollout candidate only when status='mapped'. A conceptual
 * route that can only be removed by disabling a shared or guard-listed stage
 * is intentionally blocked. This avoids presenting a dangerous stage name as
 * an operator action merely because the behavior evidence passed.
 */
export const CHAT_V2_RETIREMENT_STAGE_MAPPINGS:
  Readonly<Record<string, ChatV2RetirementStageMapping>> = Object.freeze({
  chat_message_shortcut_after_route: {
    campaignStage: 'deterministic_read',
    disableStages: [],
    status: 'shared_stage',
    reason: 'fast_path also owns protected token-zero slash reads; it cannot be retired route-wide',
  },
  training_plan_shortcut: {
    campaignStage: 'cached_local_shortcut',
    disableStages: ['training_plan_shortcut'],
    status: 'mapped',
    reason: 'dedicated legacy shortcut stage',
  },
  decision_confirmation_shortcut: {
    campaignStage: 'identity_confirmation',
    disableStages: ['decision_confirmation_shortcut'],
    status: 'mapped',
    reason: 'dedicated legacy confirmation shortcut stage',
  },
  chat_reasoning_engine_v1: {
    campaignStage: 'planner',
    disableStages: [],
    status: 'shared_stage',
    reason: 'action_planner_model is shared with general write routing and cannot be disabled per route',
  },
  destructive_confirmation_hold: {
    campaignStage: 'write_firewall_hold',
    disableStages: [],
    status: 'non_retirable',
    reason: 'destructive_confirmation_hold is guard-listed by the pipeline runner',
  },
  selective_internet_research: {
    campaignStage: 'research',
    disableStages: [],
    status: 'shared_stage',
    reason: 'internet_research serves both legacy and ChatV2 ownership modes',
  },
  classifier_route_skill_orchestration: {
    campaignStage: 'local_answer_routing',
    disableStages: [],
    status: 'non_retirable',
    reason: 'the legacy classifier tail terminates in guard-listed legacy_tail',
  },
  domain_handler_execution: {
    campaignStage: 'domain_handler',
    disableStages: [],
    status: 'non_retirable',
    reason: 'the legacy domain-handler tail terminates in guard-listed legacy_tail',
  },
  general_action_planner: {
    campaignStage: 'general_planner',
    disableStages: [],
    status: 'shared_stage',
    reason: 'the planner stages are shared with other write routes and cannot be disabled route-wide',
  },
});

/** Used by runner tests to pin the mapping against the real stage inventory. */
export function validateChatV2RetirementStageMappings(
  stageNames: readonly string[],
  nonRetirableStageNames: ReadonlySet<string>,
): string[] {
  const available = new Set(stageNames);
  const errors: string[] = [];
  for (const routeId of CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER) {
    const mapping = CHAT_V2_RETIREMENT_STAGE_MAPPINGS[routeId];
    if (!mapping) {
      errors.push(`${routeId}:missing_mapping`);
      continue;
    }
    if (mapping.status !== 'mapped' && mapping.disableStages.length > 0) {
      errors.push(`${routeId}:blocked_mapping_has_disable_stage`);
    }
    if (mapping.status === 'mapped' && mapping.disableStages.length === 0) {
      errors.push(`${routeId}:mapped_without_disable_stage`);
    }
    for (const stage of mapping.disableStages) {
      if (!available.has(stage)) errors.push(`${routeId}:unknown_stage:${stage}`);
      if (nonRetirableStageNames.has(stage)) errors.push(`${routeId}:non_retirable_stage:${stage}`);
    }
  }
  return errors;
}

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
  legacyRouteId?: string | null;
}

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

// ─── diagnostic storage + sync ─────────────────────────────────────────

export function isChatRouteExitSamplerMigrationApplied(db: Database.Database): boolean {
  return tableExists(db, 'chat_v2_route_exit_samples');
}

export function ensureChatRouteExitSamplerTables(db: Database.Database): boolean {
  if (isChatRouteExitSamplerMigrationApplied(db)) return true;
  if (db.readonly) return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_route_exit_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('shadow_replay_bundle', 'online_eval_sample')),
      source_row_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      route_id TEXT NOT NULL,
      route_method TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('routing_diagnostic', 'health')),
      routing_agreement INTEGER CHECK (routing_agreement IN (0, 1)),
      health_ok INTEGER CHECK (health_ok IN (0, 1)),
      reason TEXT,
      sampled_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source, source_key),
      CHECK (kind <> 'health' OR routing_agreement IS NULL),
      CHECK (kind <> 'routing_diagnostic' OR health_ok IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_v2_route_exit_samples_route
      ON chat_v2_route_exit_samples(route_id, kind, sampled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_route_exit_samples_source
      ON chat_v2_route_exit_samples(source, source_row_id DESC);
  `);
  return true;
}

export interface ChatRouteExitSourceSyncResult {
  scanned: number;
  converted: number;
  refreshed: number;
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
  routingAgreement: 0 | 1 | null;
  healthOk: 0 | 1 | null;
  reason: string;
  sampledAt: string;
}

type SourceScanner = (
  db: Database.Database,
) => { candidates: CandidateSample[]; scanned: number; skipped: number };

export function syncChatRouteExitSamples(
  db: Database.Database,
  options: { now?: Date } = {},
): SyncChatRouteExitSamplesResult {
  if (!ensureChatRouteExitSamplerTables(db)) {
    throw new Error('chat_v2_route_exit_samples missing and connection is readonly (migration 258 not applied)');
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

function syncSource(
  db: Database.Database,
  source: ChatRouteExitSampleSource,
  now: string,
  scan: SourceScanner,
): ChatRouteExitSourceSyncResult {
  const { candidates, scanned, skipped } = scan(db);
  const existingKeys = new Set(
    (db.prepare('SELECT source_key FROM chat_v2_route_exit_samples WHERE source = ?')
      .all(source) as Array<{ source_key: string }>).map((row) => row.source_key),
  );
  const upsert = db.prepare(`
    INSERT INTO chat_v2_route_exit_samples (
      source, source_row_id, source_key, route_id, route_method,
      kind, routing_agreement, health_ok, reason, sampled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_key) DO UPDATE SET
      source_row_id = excluded.source_row_id,
      route_id = excluded.route_id,
      route_method = excluded.route_method,
      kind = excluded.kind,
      routing_agreement = excluded.routing_agreement,
      health_ok = excluded.health_ok,
      reason = excluded.reason,
      sampled_at = excluded.sampled_at,
      updated_at = excluded.updated_at
  `);
  let converted = 0;
  let refreshed = 0;
  db.transaction(() => {
    for (const candidate of candidates) {
      upsert.run(
        source,
        candidate.sourceRowId,
        candidate.sourceKey,
        candidate.routeId,
        candidate.routeMethod,
        candidate.kind,
        candidate.routingAgreement,
        candidate.healthOk,
        candidate.reason,
        candidate.sampledAt,
        now,
        now,
      );
      if (existingKeys.has(candidate.sourceKey)) refreshed += 1;
      else converted += 1;
    }
  })();
  return { scanned, converted, refreshed, skipped };
}

function scanShadowReplayBundles(db: Database.Database): ReturnType<SourceScanner> {
  if (!tableExists(db, 'chat_v2_replay_bundles')) return { candidates: [], scanned: 0, skipped: 0 };
  const rows = db.prepare(`
    SELECT id, replay_bundle_id, redacted_bundle_json, created_at
    FROM chat_v2_replay_bundles ORDER BY id ASC
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
    const isShadow = response.type === 'chat_core_v2_shadow_plan'
      || typeof contextPack.shadowRouteHookVersion === 'string';
    if (!isShadow) {
      skipped += 1;
      continue;
    }
    const routeMethod = firstString(response.routeMethod, routeDecision.routeMethod);
    const domain = firstString(firstArrayEntry(contextPack.guessedDomains), firstArrayEntry(routeDecision.domains));
    const routeId = resolveChatV2LegacyRouteId({
      routeMethod,
      domain,
      legacyRouteId: firstString(contextPack.legacyRouteId),
    });
    if (!routeId) {
      skipped += 1;
      continue;
    }
    const diagnostic = shadowBundleRoutingAgreement(contextPack);
    candidates.push({
      sourceRowId: row.id,
      sourceKey: row.replay_bundle_id,
      routeId,
      routeMethod: routeMethod ?? null,
      kind: 'routing_diagnostic',
      routingAgreement: diagnostic.agreement,
      healthOk: null,
      reason: diagnostic.reason,
      sampledAt: row.created_at,
    });
  }
  return { candidates, scanned: rows.length, skipped };
}

function shadowBundleRoutingAgreement(
  contextPack: Record<string, unknown>,
): { agreement: 0 | 1 | null; reason: string } {
  const divergence = asObject(contextPack.routingDivergence);
  if (Object.keys(divergence).length === 0) {
    return { agreement: null, reason: 'routing_unknown_no_divergence_record' };
  }
  const surfaces = asObject(divergence.surfaces);
  const legacyDomain = firstString(surfaces.orchestratorPrimaryDomain, surfaces.classifierKeywordDomain);
  if (!legacyDomain) return { agreement: null, reason: 'routing_unknown_no_legacy_decision' };
  const shadowDomains = stringArray(surfaces.shadowRouteDomains);
  if (shadowDomains.length === 0) return { agreement: null, reason: 'routing_unknown_no_v2_decision' };
  const mapped = new Set(shadowDomains.map((domain) => V2_TO_LEGACY_DOMAIN[domain] ?? domain));
  return mapped.has(legacyDomain)
    ? { agreement: 1, reason: 'legacy_v2_routing_agreement' }
    : { agreement: 0, reason: 'legacy_v2_routing_divergence' };
}

function scanOnlineEvalSamples(db: Database.Database): ReturnType<SourceScanner> {
  if (!tableExists(db, 'chat_v2_online_eval_samples')) return { candidates: [], scanned: 0, skipped: 0 };
  const rows = db.prepare(`
    SELECT id, sample_id, route_method, domain, reason, status, metadata_json, created_at
    FROM chat_v2_online_eval_samples ORDER BY id ASC
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
    // Route methods such as `llm_synthesis` and `planner` span multiple
    // retirement routes. Health is useful only when the producer persisted
    // the exact route being evaluated; never infer it from the broad method.
    const routeId = resolveChatV2LegacyRouteId({
      legacyRouteId: firstString(metadata.legacyRouteId),
    });
    if (!routeId) {
      skipped += 1;
      continue;
    }
    candidates.push({
      sourceRowId: row.id,
      sourceKey: row.sample_id,
      routeId,
      routeMethod: row.route_method,
      kind: 'health',
      routingAgreement: null,
      healthOk: EVAL_FAILURE_REASONS.has(row.reason) ? 0 : 1,
      reason: `eval_capture_${row.reason}`,
      sampledAt: row.created_at,
    });
  }
  return { candidates, scanned: rows.length, skipped };
}

// ─── behavior evidence + fallback read model ────────────────────────────

interface BehaviorEvidenceRow {
  evidence_source: string;
  evidence_kind: string;
  sample_identifier_kind: string;
  route_id: string;
  replaced: number | null;
  tested: number | null;
  shadow_parity_rate: number | null;
  route_sample_count: number | null;
  raw_field_audit_count: number;
  safe_metadata_json: string;
}

interface BehaviorEvidenceResult {
  sample: ChatLegacyRouteExitSample;
  matchingCount: number;
  provenancePassed: boolean;
  peerReviewPassed: boolean;
  regressionReviewPassed: boolean;
  behaviorGatePassed: boolean;
  blockingReasons: string[];
}

export interface ChatV2RetirementFallback24h {
  windowHours: typeof CHAT_V2_RETIREMENT_FALLBACK_WINDOW_HOURS;
  fallbackCount: number;
  totalCount: number;
  rate: number | null;
  threshold: typeof CHAT_V2_RETIREMENT_MAX_FALLBACK_RATE;
  passed: boolean | null;
}

export type ChatV2RetirementRouteVerdict = 'pass' | 'fail' | 'insufficient_evidence' | 'blocked';

export interface ChatV2RetirementCampaignRow {
  position: number;
  campaignStage: string;
  routeId: string;
  disableStages: string[];
  mappingStatus: ChatV2RetirementStageMappingStatus;
  mappingReason: string;
  behaviorParitySamples: number;
  behaviorMatchingCount: number;
  behaviorParityRate: number;
  behaviorProvenancePassed: boolean;
  peerReviewPassed: boolean;
  regressionReviewPassed: boolean;
  behaviorGatePassed: boolean;
  missingSamples: number;
  routingAgreementSamples: number;
  routingAgreementCount: number;
  routingAgreementRate: number | null;
  routingAgreementUnknown: number;
  healthSamples: number;
  healthFailures: number;
  fallback24h: ChatV2RetirementFallback24h;
  blockingReasons: string[];
  candidate: boolean;
  verdict: ChatV2RetirementRouteVerdict;
}

export interface ChatLegacyRetirementEvidence {
  version: typeof NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION;
  migrationApplied: boolean;
  routes: ChatV2RetirementCampaignRow[];
  routeSamples: ChatLegacyRouteExitSample[];
}

export function buildChatLegacyRetirementEvidence(
  db: Database.Database,
  options: { now?: Date } = {},
): ChatLegacyRetirementEvidence {
  const routes = buildChatV2RetirementCampaign(db, options);
  return {
    version: NEXUS_CHAT_ROUTE_EXIT_SAMPLER_VERSION,
    migrationApplied: isChatRouteExitSamplerMigrationApplied(db),
    routes,
    routeSamples: routes.map((route) => ({
      routeId: route.routeId,
      replaced: route.behaviorProvenancePassed,
      tested: route.behaviorProvenancePassed,
      shadowParityRate: route.behaviorParityRate,
      sampleCount: route.behaviorParitySamples,
    })),
  };
}

export function buildChatV2RetirementCampaign(
  db: Database.Database,
  options: { now?: Date } = {},
): ChatV2RetirementCampaignRow[] {
  ensureChatRouteExitSamplerTables(db);
  const now = options.now ?? new Date();
  const diagnostics = readDiagnosticAggregates(db);
  const behavior = readLatestBehaviorEvidence(db);
  const fallback = readFallbackAttribution24h(db, now);
  const minSamples = DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minSamplesPerRoute;

  return CHAT_V2_RETIREMENT_CAMPAIGN_ROUTE_ORDER.map((routeId, index) => {
    const mapping = CHAT_V2_RETIREMENT_STAGE_MAPPINGS[routeId] ?? {
      campaignStage: 'unmapped',
      disableStages: [],
      status: 'unmapped' as const,
      reason: 'no route-to-stage mapping exists',
    };
    const diagnostic = diagnostics.get(routeId) ?? {
      routingSamples: 0,
      routingCount: 0,
      routingUnknown: 0,
      healthSamples: 0,
      healthFailures: 0,
    };
    const behaviorResult = validateBehaviorEvidence(routeId, behavior.get(routeId));
    const fallback24h = fallback.get(routeId) ?? emptyFallback24h();
    const blockingReasons = [...behaviorResult.blockingReasons];
    if (mapping.status !== 'mapped') blockingReasons.push(`stage_mapping_${mapping.status}`);
    if (fallback24h.passed === false) blockingReasons.push('fallback_rate_above_2_percent');
    if (fallback24h.passed == null) blockingReasons.push('missing_24h_fallback_evidence');

    const missingSamples = Math.max(0, minSamples - behaviorResult.sample.sampleCount);
    const verdict: ChatV2RetirementRouteVerdict = mapping.status !== 'mapped'
      ? 'blocked'
      : behaviorResult.sample.sampleCount < minSamples
        ? 'insufficient_evidence'
        : !behaviorResult.behaviorGatePassed
          ? 'fail'
          : fallback24h.passed == null
            ? 'insufficient_evidence'
            : fallback24h.passed
              ? 'pass'
              : 'fail';
    const routingAgreementRate = diagnostic.routingSamples > 0
      ? round4(diagnostic.routingCount / diagnostic.routingSamples)
      : null;
    return {
      position: index + 1,
      campaignStage: mapping.campaignStage,
      routeId,
      disableStages: [...mapping.disableStages],
      mappingStatus: mapping.status,
      mappingReason: mapping.reason,
      behaviorParitySamples: behaviorResult.sample.sampleCount,
      behaviorMatchingCount: behaviorResult.matchingCount,
      behaviorParityRate: round4(behaviorResult.sample.shadowParityRate),
      behaviorProvenancePassed: behaviorResult.provenancePassed,
      peerReviewPassed: behaviorResult.peerReviewPassed,
      regressionReviewPassed: behaviorResult.regressionReviewPassed,
      behaviorGatePassed: behaviorResult.behaviorGatePassed,
      missingSamples,
      routingAgreementSamples: diagnostic.routingSamples,
      routingAgreementCount: diagnostic.routingCount,
      routingAgreementRate,
      routingAgreementUnknown: diagnostic.routingUnknown,
      healthSamples: diagnostic.healthSamples,
      healthFailures: diagnostic.healthFailures,
      fallback24h,
      blockingReasons: [...new Set(blockingReasons)],
      candidate: verdict === 'pass',
      verdict,
    };
  });
}

function readDiagnosticAggregates(db: Database.Database): Map<string, {
  routingSamples: number;
  routingCount: number;
  routingUnknown: number;
  healthSamples: number;
  healthFailures: number;
}> {
  if (!tableExists(db, 'chat_v2_route_exit_samples')) return new Map();
  const rows = db.prepare(`
    SELECT route_id,
      SUM(CASE WHEN kind = 'routing_diagnostic' AND routing_agreement IS NOT NULL THEN 1 ELSE 0 END) routing_samples,
      SUM(CASE WHEN kind = 'routing_diagnostic' AND routing_agreement = 1 THEN 1 ELSE 0 END) routing_count,
      SUM(CASE WHEN kind = 'routing_diagnostic' AND routing_agreement IS NULL THEN 1 ELSE 0 END) routing_unknown,
      SUM(CASE WHEN kind = 'health' THEN 1 ELSE 0 END) health_samples,
      SUM(CASE WHEN kind = 'health' AND health_ok = 0 THEN 1 ELSE 0 END) health_failures
    FROM chat_v2_route_exit_samples GROUP BY route_id
  `).all() as Array<{
    route_id: string;
    routing_samples: number;
    routing_count: number;
    routing_unknown: number;
    health_samples: number;
    health_failures: number;
  }>;
  return new Map(rows.map((row) => [row.route_id, {
    routingSamples: Number(row.routing_samples) || 0,
    routingCount: Number(row.routing_count) || 0,
    routingUnknown: Number(row.routing_unknown) || 0,
    healthSamples: Number(row.health_samples) || 0,
    healthFailures: Number(row.health_failures) || 0,
  }]));
}

function readLatestBehaviorEvidence(db: Database.Database): Map<string, BehaviorEvidenceRow> {
  if (!tableExists(db, 'chat_v2_legacy_retirement_evidence')) return new Map();
  const rows = db.prepare(`
    SELECT evidence_source, evidence_kind, sample_identifier_kind,
           route_id, replaced, tested, shadow_parity_rate, route_sample_count,
           raw_field_audit_count, safe_metadata_json
    FROM chat_v2_legacy_retirement_evidence
    WHERE evidence_source = 'runtime_route'
      AND evidence_kind = 'route_exit'
      AND route_id IS NOT NULL
    ORDER BY datetime(created_at) DESC, id DESC
  `).all() as BehaviorEvidenceRow[];
  const latest = new Map<string, BehaviorEvidenceRow>();
  for (const row of rows) {
    const metadata = parseJsonObject(row.safe_metadata_json);
    const labelImport = metadata.parityLabelImport === true;
    const observationImport = metadata.parityObservationImport === true;
    if (
      labelImport === observationImport
      || metadata.status === 'inventory_only_not_retired'
      || !hasRetirementEligibleExactCurrentChatV2ObserverCorpusBinding(
        metadata,
        row.route_id,
      )
    ) continue;
    if (!latest.has(row.route_id)) latest.set(row.route_id, row);
  }
  return latest;
}

function validateBehaviorEvidence(routeId: string, row?: BehaviorEvidenceRow): BehaviorEvidenceResult {
  const validation = row
    ? validateCurrentChatV2LegacyRetirementEvidenceRow(row)
    : { ok: false as const, reason: 'missing_paired_behavior_evidence' };
  const metadata = parseJsonObject(row?.safe_metadata_json);
  const sampleCount = validation.ok
    ? validation.sampleCount
    : integer(metadata.sampleCount) ?? nonNegativeInteger(row?.route_sample_count) ?? 0;
  const matchingCount = validation.ok
    ? validation.matchingCount
    : integer(metadata.matchingCount) ?? 0;
  const rate = validation.ok
    ? validation.parityRate
    : typeof row?.shadow_parity_rate === 'number' && Number.isFinite(row.shadow_parity_rate)
      ? row.shadow_parity_rate
      : sampleCount > 0 ? matchingCount / sampleCount : 0;
  const provenancePassed = validation.ok;
  const evaluator = typeof metadata.evaluator === 'string' ? metadata.evaluator.toLowerCase() : '';
  const signoff = typeof metadata.peerReviewSignoffHash === 'string' ? metadata.peerReviewSignoffHash : '';
  const peerReviewPassed = (evaluator === 'manual' || evaluator === 'claude')
    && /^[a-f0-9]{64}$/i.test(signoff);
  const safety = integer(metadata.safetyRegressionCount);
  const quality = integer(metadata.qualityRegressionCount);
  const degraded = integer(metadata.degradedNotComparableCount);
  const regressionReviewPassed = safety === 0 && quality === 0 && degraded === 0;
  const sample: ChatLegacyRouteExitSample = {
    routeId,
    replaced: row?.replaced === 1,
    tested: row?.tested === 1,
    shadowParityRate: rate,
    sampleCount,
    evaluator,
    peerReviewSignoffHash: signoff,
    safetyRegressionCount: safety ?? undefined,
    qualityRegressionCount: quality ?? undefined,
    degradedNotComparableCount: degraded ?? undefined,
  };
  const blockingReasons: string[] = [];
  if (!row) blockingReasons.push('missing_paired_behavior_evidence');
  else if (!provenancePassed) blockingReasons.push('invalid_paired_behavior_evidence_provenance');
  if (!sample.replaced || !sample.tested) blockingReasons.push('route_not_replaced_and_tested');
  if (sampleCount < DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minSamplesPerRoute) {
    blockingReasons.push('below_50_behavior_samples');
  }
  if (rate < DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minShadowParityRate) {
    blockingReasons.push('behavior_parity_below_0_95');
  }
  if (!peerReviewPassed) blockingReasons.push('missing_independent_peer_review');
  if (!regressionReviewPassed) blockingReasons.push('behavior_regression_review_failed_or_missing');
  const behaviorGatePassed = provenancePassed
    && sample.replaced
    && sample.tested
    && sampleCount >= DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minSamplesPerRoute
    && rate >= DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minShadowParityRate
    && peerReviewPassed
    && regressionReviewPassed;
  return {
    sample,
    matchingCount,
    provenancePassed,
    peerReviewPassed,
    regressionReviewPassed,
    behaviorGatePassed,
    blockingReasons,
  };
}

function readFallbackAttribution24h(
  db: Database.Database,
  now: Date,
): Map<string, ChatV2RetirementFallback24h> {
  if (!tableExists(db, 'chat_v2_legacy_fallback_attribution_counter')) return new Map();
  const cutoff = new Date(now.getTime() - CHAT_V2_RETIREMENT_FALLBACK_WINDOW_HOURS * 60 * 60_000)
    .toISOString().slice(0, 13);
  const rows = db.prepare(`
    SELECT route_owner, route_method,
           COALESCE(SUM(fallback_count), 0) fallback_count,
           COALESCE(SUM(total_count), 0) total_count
    FROM chat_v2_legacy_fallback_attribution_counter
    WHERE window_start >= ?
    GROUP BY route_owner, route_method
  `).all(cutoff) as Array<{
    route_owner: string;
    route_method: string;
    fallback_count: number;
    total_count: number;
  }>;
  const sums = new Map<string, { fallback: number; total: number }>();
  for (const row of rows) {
    const routeId = resolveFallbackAttributionRouteId(row.route_owner, row.route_method);
    if (!routeId) continue;
    const current = sums.get(routeId) ?? { fallback: 0, total: 0 };
    current.fallback += Number(row.fallback_count) || 0;
    current.total += Number(row.total_count) || 0;
    sums.set(routeId, current);
  }
  return new Map([...sums.entries()].map(([routeId, value]) => {
    const rawRate = value.total > 0 ? value.fallback / value.total : null;
    const rate = rawRate == null ? null : round6(rawRate);
    return [routeId, {
      windowHours: CHAT_V2_RETIREMENT_FALLBACK_WINDOW_HOURS,
      fallbackCount: value.fallback,
      totalCount: value.total,
      rate,
      threshold: CHAT_V2_RETIREMENT_MAX_FALLBACK_RATE,
      passed: rawRate == null ? null : rawRate <= CHAT_V2_RETIREMENT_MAX_FALLBACK_RATE,
    }];
  }));
}

export function resolveFallbackAttributionRouteId(
  routeOwner: string,
  routeMethod: string,
): string | null {
  const owner = safeToken(routeOwner);
  const method = safeToken(routeMethod);
  if (REQUIRED_ROUTE_ID_SET.has(owner)) return owner;
  switch (owner) {
    case 'training_plan_shortcut':
      return 'training_plan_shortcut';
    case 'decision_confirmation_shortcut':
      return 'decision_confirmation_shortcut';
    case 'selective_internet_research':
      return 'selective_internet_research';
    case 'chat_core_v2_deterministic_read':
      return 'chat_message_shortcut_after_route';
    case 'chat_action_planner':
      return method.includes('reasoning') ? 'chat_reasoning_engine_v1' : 'general_action_planner';
    case 'legacy_route_message':
      if (method.includes('research')) return 'selective_internet_research';
      if (method.includes('classifier')) return 'classifier_route_skill_orchestration';
      if (method.includes('domain')) return 'domain_handler_execution';
      return null;
    default:
      return null;
  }
}

function emptyFallback24h(): ChatV2RetirementFallback24h {
  return {
    windowHours: CHAT_V2_RETIREMENT_FALLBACK_WINDOW_HOURS,
    fallbackCount: 0,
    totalCount: 0,
    rate: null,
    threshold: CHAT_V2_RETIREMENT_MAX_FALLBACK_RATE,
    passed: null,
  };
}

// ─── near-real-time alert payloads ─────────────────────────────────────

export function buildChatV2RetirementBehaviorRegressionAlertInputs(
  rows: readonly ChatV2RetirementCampaignRow[],
  options: { generatedAt?: string; owner?: string; runbookUrl?: string } = {},
): RecordOperatorAlertInput[] {
  return rows
    .filter((row) => row.mappingStatus === 'mapped'
      && row.behaviorParitySamples >= DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minSamplesPerRoute
      && row.behaviorProvenancePassed
      && row.peerReviewPassed
      && !row.behaviorGatePassed)
    .map((row) => ({
      severity: row.regressionReviewPassed ? 'warning' : 'critical',
      source: 'chat_v2_retirement_monitor',
      dedupeKey: `chatv2-retirement:behavior:${row.routeId}`,
      title: `ChatV2 signed behavior parity regressed: ${row.routeId}`,
      detail: `Signed paired behavior evidence no longer passes the retirement gate: parity ${formatPercent(row.behaviorParityRate)} across ${row.behaviorParitySamples} samples.`,
      metadata: {
        routeId: row.routeId,
        disableStages: row.disableStages,
        behaviorParitySamples: row.behaviorParitySamples,
        behaviorMatchingCount: row.behaviorMatchingCount,
        behaviorParityRate: row.behaviorParityRate,
        threshold: DEFAULT_CHAT_LEGACY_RETIREMENT_THRESHOLDS.minShadowParityRate,
        behaviorProvenancePassed: row.behaviorProvenancePassed,
        peerReviewPassed: row.peerReviewPassed,
        regressionReviewPassed: row.regressionReviewPassed,
        blockingReasons: row.blockingReasons,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
      },
      owner: options.owner ?? 'ai-platform',
      suspectedArea: 'chat_v2_legacy_retirement',
      userImpact: 'Stop the per-route retirement soak and keep or restore the owner-approved legacy stage before proceeding.',
      runbookUrl: options.runbookUrl ?? 'docs/release/chat-quality-operations.md',
    }));
}

export function buildChatV2RetirementFallbackAlertInputs(
  rows: readonly ChatV2RetirementCampaignRow[],
  options: { generatedAt?: string; owner?: string; runbookUrl?: string } = {},
): RecordOperatorAlertInput[] {
  return rows
    .filter((row) => row.mappingStatus === 'mapped'
      && row.behaviorGatePassed
      && row.fallback24h.passed === false)
    .map((row) => ({
      severity: 'critical',
      source: 'chat_v2_retirement_monitor',
      dedupeKey: `chatv2-retirement:fallback:${row.routeId}`,
      title: `ChatV2 route fallback above 2%: ${row.routeId}`,
      detail: `Trailing 24h fallback rate ${formatPercent(row.fallback24h.rate!)} exceeds the 2% retirement ceiling.`,
      metadata: {
        routeId: row.routeId,
        disableStages: row.disableStages,
        fallbackRate24h: row.fallback24h.rate,
        threshold: CHAT_V2_RETIREMENT_MAX_FALLBACK_RATE,
        fallbackCount: row.fallback24h.fallbackCount,
        totalCount: row.fallback24h.totalCount,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
      },
      owner: options.owner ?? 'ai-platform',
      suspectedArea: 'chat_v2_legacy_retirement',
      userImpact: 'Stop the per-route retirement soak and restore the owner-approved legacy stage before proceeding.',
      runbookUrl: options.runbookUrl ?? 'docs/release/chat-quality-operations.md',
    }));
}

// ─── helpers ───────────────────────────────────────────────────────────

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
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

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = integer(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function safeToken(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 120);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatPercent(value: number): string {
  return `${round4(value * 100)}%`;
}

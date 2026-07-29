#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {
  aggregateChatV2LegacyParityObservations,
  buildChatV2LegacyParityEvidenceInput,
  buildChatV2RetirementObserverCorpusBinding,
  deleteExactCurrentChatV2RetirementEvidenceRows,
  normalizeChatV2LegacyParityOwnerLabel,
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
  type ChatV2RetirementObserverCorpusBinding,
  validateChatV2LegacyParityObservation,
  type ChatV2LegacyParityObservation,
} from '../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META,
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS,
} from '../src/services/chat-legacy-parity-route-prompts';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
const observationsPath = readArg('--observations');
const shouldWrite = hasFlag('--write');
const shouldReplace = hasFlag('--replace-route-labels');
const requestId = readArg('--request-id') ?? `legacy-parity-observations-${new Date().toISOString()}`;
const minSamples = parseNumberArg('--min-samples') ?? 50;
const minParity = parseNumberArg('--min-parity') ?? 0.95;
const manifestPath = readArg('--manifest');
const qaReviewId = readArg('--qa-review-id');
const SAMPLE_IDENTITY_POLICY = 'route_index_request_language_expected_response_language_v1';

const PHASE7_ROUTE_IDS = new Set(
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS.map((route) => route.routeId),
);
const PHASE7_ROUTE_METADATA = new Map(
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS.map((route) => [route.routeId, route]),
);
const routeScope = parseRouteScopeArg('--routes');

if (!observationsPath) {
  console.error('Missing --observations=<path>. Provide NDJSON or JSON array safe route parity observations.');
  process.exitCode = 1;
} else if (!shouldWrite) {
  console.error([
    'Refusing to import ChatV2 legacy parity observations without --write.',
    'Observations must contain HMAC sample ids and aggregate-safe metadata only.',
    'Use: npx tsx scripts/chatv2-import-legacy-parity-observations.ts --write --observations=./path/to/observations.ndjson --db=./data/local.db',
  ].join('\n'));
  process.exitCode = 1;
} else {
  const parsed = parseObservationsFile(observationsPath);
  if (parsed.invalid.length > 0) {
    console.error(JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_observation_import_error.v1',
      observationsPath: path.resolve(observationsPath),
      invalid: parsed.invalid,
    }, null, 2));
    process.exitCode = 1;
  } else {
    const provenance = validateRuntimeProvenanceIfNeeded({
      observationsPath,
      observations: parsed.observations,
      manifestPath,
      qaReviewId,
    });
    if (!provenance.ok) {
      console.error(JSON.stringify({
        schemaVersion: 'chat_v2_legacy_parity_observation_import_error.v1',
        observationsPath: path.resolve(observationsPath),
        invalid: [{ index: 0, reason: provenance.reason }],
      }, null, 2));
      process.exitCode = 1;
      process.exit();
    }
    const runtimeThresholds = validateRuntimeThresholdsIfNeeded(parsed.observations);
    if (!runtimeThresholds.ok) {
      console.error(JSON.stringify({
        schemaVersion: 'chat_v2_legacy_parity_observation_import_error.v1',
        observationsPath: path.resolve(observationsPath),
        invalid: [{ index: 0, reason: runtimeThresholds.reason }],
      }, null, 2));
      process.exitCode = 1;
      process.exit();
    }
    const aggregates = aggregateChatV2LegacyParityObservations(parsed.observations);
    const accepted = aggregates.filter((aggregate) =>
      !aggregate.blockedReason
      && aggregate.label.replaced
      && aggregate.label.tested
      && aggregate.label.sampleCount >= minSamples
      && aggregate.label.matchingCount / Math.max(1, aggregate.label.sampleCount) >= minParity,
    );
    const blocked = aggregates
      .filter((aggregate) => !accepted.includes(aggregate))
      .map((aggregate) => ({
        routeId: aggregate.routeId,
        sampleCount: aggregate.label.sampleCount,
        matchingCount: aggregate.label.matchingCount,
        parityRate: aggregate.label.sampleCount > 0 ? aggregate.label.matchingCount / aggregate.label.sampleCount : 0,
        reason: aggregate.blockedReason
          ?? (!aggregate.label.replaced || !aggregate.label.tested ? 'not_all_samples_tested'
            : aggregate.label.sampleCount < minSamples ? 'below_min_samples'
              : 'below_min_parity'),
      }));

    const completeness = validateRuntimeAggregateCompletenessIfNeeded(parsed.observations, accepted, blocked, routeScope);
    if (!completeness.ok) {
      console.error(JSON.stringify({
        schemaVersion: 'chat_v2_legacy_parity_observation_import_error.v1',
        observationsPath: path.resolve(observationsPath),
        invalid: [{ index: 0, reason: completeness.reason }],
        blockedRoutes: blocked,
      }, null, 2));
      process.exitCode = 1;
      process.exit();
    }

    if (accepted.length > 0) {
      const db = new Database(dbPath);
      try {
        ensureLegacySchema(db);
        const importEvidenceSource = parsed.observations[0]?.evidenceSource ?? 'runtime_route';
        const tx = db.transaction(() => {
          if (shouldReplace) {
            deleteExactCurrentChatV2RetirementEvidenceRows(db, {
              evidenceSource: importEvidenceSource,
              routeIds: routeScope.size > 0
                ? [...routeScope]
                : accepted.map((aggregate) => aggregate.routeId),
              importMarker: 'parityObservationImport',
            });
          }
          for (const aggregate of accepted) {
            const evidence = buildChatV2LegacyParityEvidenceInput({
              label: aggregate.label,
              requestId: `${requestId}:${aggregate.routeId}`,
              observerCorpusBinding: provenance.observerCorpusBinding,
            });
	            const safeMetadataJson = JSON.stringify({
	              ...evidence.safeMetadata,
	              parityLabelImport: undefined,
	              parityObservationImport: true,
	              minSamples,
              minParity,
              observerManifestHash: provenance.observerManifestHash ?? null,
              qaReviewId: provenance.qaReviewId ?? null,
              routeScope: routeScope.size > 0 ? [...routeScope].sort() : 'all_phase7_routes',
              routeScopedObservationImport: routeScope.size > 0,
            });
            db.prepare(`
              INSERT INTO chat_v2_legacy_retirement_evidence (
                evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
                route_id, replaced, tested, shadow_parity_rate, route_sample_count,
                legacy_fallback_rate_24h, full_verify_clean, raw_field_audit_count,
                safe_metadata_json
              ) VALUES (?, 'route_exit', ?, ?, 'hmac', ?, ?, ?, ?, ?, NULL, NULL, 0, ?)
            `).run(
              evidence.evidenceSource,
              evidence.requestId,
              hmacToken('legacy-parity-observation', `${evidence.requestId}:${evidence.routeId}`),
              evidence.routeId,
              evidence.replaced ? 1 : 0,
              evidence.tested ? 1 : 0,
              evidence.shadowParityRate,
              evidence.sampleCount,
              safeMetadataJson,
            );
          }
        });
        tx();
      } finally {
        db.close();
      }
    }

    console.log(JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_observation_import_result.v1',
      dbPath,
      observationsPath: path.resolve(observationsPath),
      requestId,
      observationRows: parsed.observations.length,
      acceptedRoutes: accepted.map((aggregate) => ({
        routeId: aggregate.routeId,
        sampleCount: aggregate.label.sampleCount,
        matchingCount: aggregate.label.matchingCount,
        parityRate: aggregate.label.matchingCount / aggregate.label.sampleCount,
      })),
      blockedRoutes: blocked,
      replacedPreviousObservationLabels: shouldReplace,
      routeScope: routeScope.size > 0 ? [...routeScope].sort() : 'all_phase7_routes',
      warning: 'Only accepted aggregate rows were imported. Blocked routes still need real old-vs-ChatV2 parity observations.',
    }, null, 2));
  }
}

function parseObservationsFile(filePath: string): {
  observations: ChatV2LegacyParityObservation[];
  invalid: Array<{ index: number; reason: string }>;
} {
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8').trim();
  if (!raw) return { observations: [], invalid: [{ index: 0, reason: 'empty_observations_file' }] };
  const values = raw.startsWith('[')
    ? JSON.parse(raw) as unknown[]
    : raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const observations: ChatV2LegacyParityObservation[] = [];
  const invalid: Array<{ index: number; reason: string }> = [];
  values.forEach((value, index) => {
    const validation = validateChatV2LegacyParityObservation(value);
    if (validation.ok) observations.push(validation.observation);
    else invalid.push({ index, reason: validation.reason });
  });
  if (observations.length === 0 && invalid.length === 0) invalid.push({ index: 0, reason: 'no_observations' });
  return { observations, invalid };
}

function ensureLegacySchema(db: Database.Database): void {
  const migration = path.resolve('migrations/160_chatv2_legacy_retirement_evidence.sql');
  db.exec(fs.readFileSync(migration, 'utf8'));
}

function validateRuntimeProvenanceIfNeeded(input: {
  observationsPath: string;
  observations: ChatV2LegacyParityObservation[];
  manifestPath?: string;
  qaReviewId?: string;
}): {
  ok: true;
  observerManifestHash?: string;
  qaReviewId?: string;
  observerCorpusBinding?: ChatV2RetirementObserverCorpusBinding;
} | { ok: false; reason: string } {
  const sources = new Set(input.observations.map((row) => row.evidenceSource ?? 'runtime_route'));
  if (sources.size !== 1) return { ok: false, reason: 'mixed_evidence_sources' };
  const [source] = [...sources];
  if (source !== 'runtime_route') return { ok: true };

  for (const observation of input.observations) {
    const expectedRoute = PHASE7_ROUTE_METADATA.get(observation.routeId);
    if (!expectedRoute) return { ok: false, reason: 'runtime_route_contains_unapproved_route' };
    if (observation.evaluator !== 'runtime_tool') return { ok: false, reason: 'runtime_route_requires_runtime_tool_evaluator' };
    if (!observation.sampleHmac.startsWith('hmac:legacy-parity:')) return { ok: false, reason: 'runtime_route_requires_observer_sample_hmac' };
    if (
      observation.oldOwner !== normalizeChatV2LegacyParityOwnerLabel(expectedRoute.oldOwner)
      || observation.replacement !== normalizeChatV2LegacyParityOwnerLabel(expectedRoute.replacement)
    ) {
      return { ok: false, reason: 'runtime_route_metadata_mismatch' };
    }
  }

  if (!input.qaReviewId || !/^[a-z0-9_.:@-]{8,160}$/i.test(input.qaReviewId)) {
    return { ok: false, reason: 'runtime_route_requires_qa_review_id' };
  }

  const candidateManifestPath = input.manifestPath
    ? path.resolve(input.manifestPath)
    : path.resolve(input.observationsPath.replace(/\.ndjson$/i, '.manifest.json'));
  if (!fs.existsSync(candidateManifestPath)) {
    return { ok: false, reason: 'runtime_route_requires_observer_manifest' };
  }

  const manifestRaw = fs.readFileSync(candidateManifestPath, 'utf8');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'observer_manifest_invalid_json' };
  }

  if (manifest.schemaVersion !== 'chat_v2_legacy_parity_observer_manifest.v1') {
    return { ok: false, reason: 'observer_manifest_invalid_schema' };
  }
  if (manifest.evidenceSource !== 'runtime_route') {
    return { ok: false, reason: 'observer_manifest_not_runtime_route' };
  }
  if (manifest.runtimeRouteDistinctEndpoints !== true) {
    return { ok: false, reason: 'observer_manifest_endpoints_not_distinct' };
  }
  if (manifest.rawPromptOrResponseStored !== false) {
    return { ok: false, reason: 'observer_manifest_raw_storage_not_false' };
  }
  if (manifest.routePromptVersion !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.version) {
    return { ok: false, reason: 'observer_manifest_route_prompt_version_mismatch' };
  }
  if (manifest.routeCorpusId !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.corpusId) {
    return { ok: false, reason: 'observer_manifest_route_corpus_id_mismatch' };
  }
  if (
    manifest.routeCorpusFrozenBeforeImplementation
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.frozenBeforeImplementation
  ) {
    return { ok: false, reason: 'observer_manifest_corpus_freeze_claim_mismatch' };
  }
  if (
    manifest.routeCorpusMutationPolicy
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.mutationPolicy
  ) {
    return { ok: false, reason: 'observer_manifest_corpus_mutation_policy_mismatch' };
  }
  if (
    manifest.routeCorpusProjectionPolicy
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.projectionPolicy
  ) {
    return { ok: false, reason: 'observer_manifest_corpus_projection_policy_mismatch' };
  }
  if (manifest.sampleIdentityPolicy !== SAMPLE_IDENTITY_POLICY) {
    return { ok: false, reason: 'observer_manifest_sample_identity_policy_mismatch' };
  }
  const manifestRouteIds = Array.isArray(manifest.routeIds)
    ? manifest.routeIds.filter((item): item is string => typeof item === 'string').sort()
    : [];
  let observerCorpusBinding: ChatV2RetirementObserverCorpusBinding;
  try {
    observerCorpusBinding = buildChatV2RetirementObserverCorpusBinding(manifestRouteIds);
  } catch {
    return { ok: false, reason: 'observer_manifest_route_mismatch' };
  }
  if (manifest.routeCorpusSha256 !== observerCorpusBinding.routeCorpusSha256) {
    return { ok: false, reason: 'observer_manifest_route_corpus_hash_mismatch' };
  }
  if (manifest.reviewRubricVersion !== CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION) {
    return { ok: false, reason: 'observer_manifest_rubric_mismatch' };
  }
  if (typeof manifest.comparatorVersion !== 'string' || !manifest.comparatorVersion.startsWith('chat_v2_legacy_parity_comparator.')) {
    return { ok: false, reason: 'observer_manifest_missing_comparator_version' };
  }
  if (typeof manifest.stateFixtureHash !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(manifest.stateFixtureHash)) {
    return { ok: false, reason: 'observer_manifest_missing_fixture_hash' };
  }
  if (manifest.observationRows !== input.observations.length) {
    return { ok: false, reason: 'observer_manifest_row_count_mismatch' };
  }
	  if (typeof manifest.samplesPerRoute !== 'number' || manifest.samplesPerRoute < minSamples) {
	    return { ok: false, reason: 'observer_manifest_samples_per_route_mismatch' };
	  }

  const routeIds = [...new Set(input.observations.map((row) => row.routeId))].sort();
  if (routeIds.some((routeId) => !PHASE7_ROUTE_IDS.has(routeId))) {
    return { ok: false, reason: 'runtime_route_contains_unapproved_route' };
  }
	  if (JSON.stringify(manifestRouteIds) !== JSON.stringify(routeIds)) {
	    return { ok: false, reason: 'observer_manifest_route_mismatch' };
	  }

	  const samplesByRoute = numericRecordFromUnknown(manifest.samplesByRoute);
	  const distinctPromptsByRoute = numericRecordFromUnknown(manifest.distinctPromptsByRoute);
	  const hasAnswerQualityResearchRoute = routeIds.some((routeId) =>
	    PHASE7_ROUTE_METADATA.get(routeId)?.evidenceTrack === 'answer_quality_research'
	  );
	  if (
	    hasAnswerQualityResearchRoute
	    && manifest.promptSamplingPolicy !== 'no_repeated_prompts_for_answer_quality_research'
	  ) {
	    return { ok: false, reason: 'observer_manifest_missing_no_repeat_research_prompt_policy' };
	  }
	  for (const routeId of routeIds) {
	    const observedCount = input.observations.filter((row) => row.routeId === routeId).length;
	    if (samplesByRoute?.[routeId] !== observedCount) {
	      return { ok: false, reason: `observer_manifest_samples_by_route_mismatch:${routeId}` };
	    }
	    const routeMetadata = PHASE7_ROUTE_METADATA.get(routeId);
	    if (routeMetadata?.evidenceTrack === 'answer_quality_research') {
	      const distinctPromptCount = distinctPromptsByRoute?.[routeId];
	      if (typeof distinctPromptCount !== 'number' || distinctPromptCount < observedCount) {
	        return { ok: false, reason: `observer_manifest_distinct_prompt_count_below_samples:${routeId}` };
	      }
	    }
	  }

	  const writeRoutes = Array.isArray(manifest.writeRoutes)
    ? manifest.writeRoutes.filter((item): item is string => typeof item === 'string')
    : [];
  if (writeRoutes.length > 0 && manifest.isolatePrompts !== true) {
    return { ok: false, reason: 'runtime_write_routes_require_isolated_prompts' };
  }

  const observationsRaw = fs.readFileSync(path.resolve(input.observationsPath), 'utf8');
  const expectedSha = crypto.createHash('sha256').update(observationsRaw).digest('hex');
  if (manifest.observationsSha256 !== expectedSha) {
    return { ok: false, reason: 'observer_manifest_observation_hash_mismatch' };
  }

  return {
    ok: true,
    observerManifestHash: hmacToken('legacy-parity-observer-manifest', manifestRaw),
    qaReviewId: input.qaReviewId,
    observerCorpusBinding,
  };
}

function validateRuntimeThresholdsIfNeeded(
  observations: ChatV2LegacyParityObservation[],
): { ok: true } | { ok: false; reason: string } {
  if (!observations.some((row) => row.evidenceSource === 'runtime_route')) return { ok: true };
  if (minSamples < 50) return { ok: false, reason: 'runtime_route_min_samples_below_phase7_gate' };
  if (minParity < 0.95) return { ok: false, reason: 'runtime_route_min_parity_below_phase7_gate' };
  return { ok: true };
}

function validateRuntimeAggregateCompletenessIfNeeded(
  observations: ChatV2LegacyParityObservation[],
  accepted: Array<{ routeId: string }>,
  blocked: Array<{ routeId: string }>,
  scopedRouteIds = new Set<string>(),
): { ok: true } | { ok: false; reason: string } {
  if (!observations.some((row) => row.evidenceSource === 'runtime_route')) return { ok: true };
  const requiredRouteIds = scopedRouteIds.size > 0 ? scopedRouteIds : PHASE7_ROUTE_IDS;
  const observedRouteIds = new Set(observations.map((row) => row.routeId));
  const acceptedRouteIds = new Set(accepted.map((aggregate) => aggregate.routeId));
  for (const routeId of observedRouteIds) {
    const observedCount = observations.filter((row) => row.routeId === routeId).length;
    const projectedPromptCount = PHASE7_ROUTE_METADATA.get(routeId)?.prompts.length;
    if (projectedPromptCount != null && observedCount > projectedPromptCount) {
      return {
        ok: false,
        reason: `runtime_route_samples_exceed_frozen_projection:${routeId}`,
      };
    }
  }
  if (scopedRouteIds.size > 0) {
    const outOfScope = [...observedRouteIds].filter((routeId) => !scopedRouteIds.has(routeId));
    if (outOfScope.length > 0) return { ok: false, reason: `runtime_route_scope_contains_extra_routes:${outOfScope.join(',')}` };
  }
  const missingObserved = [...requiredRouteIds].filter((routeId) => !observedRouteIds.has(routeId));
  if (missingObserved.length > 0) return { ok: false, reason: `runtime_route_missing_required_routes:${missingObserved.join(',')}` };
  const missingAccepted = [...requiredRouteIds].filter((routeId) => !acceptedRouteIds.has(routeId));
  if (missingAccepted.length > 0 || blocked.length > 0) {
    const scopeLabel = scopedRouteIds.size > 0 ? 'scoped_routes' : 'all_phase7_routes';
    return { ok: false, reason: `runtime_route_requires_${scopeLabel}_accepted:${missingAccepted.join(',') || 'blocked_routes_present'}` };
  }
  return { ok: true };
}

function hmacToken(kind: string, value: string): string {
  const secret = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
  if (!secret) {
    throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required to import legacy parity observations');
  }
  return `hmac:${kind}:${crypto.createHmac('sha256', secret).update(value).digest('hex')}`;
}

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function parseNumberArg(name: string): number | undefined {
  const raw = readArg(name);
  if (raw == null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numericRecordFromUnknown(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) return null;
    output[key] = item;
  }
  return output;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseRouteScopeArg(name: string): Set<string> {
  const raw = readArg(name);
  if (!raw) return new Set<string>();
  const routeIds = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (routeIds.length === 0) return new Set<string>();
  const unknownRoute = routeIds.find((routeId) => !PHASE7_ROUTE_IDS.has(routeId));
  if (unknownRoute) {
    console.error(JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_observation_import_error.v1',
      invalid: [{ index: 0, reason: `unknown_route_scope:${unknownRoute}` }],
    }, null, 2));
    process.exit(1);
  }
  return new Set(routeIds);
}

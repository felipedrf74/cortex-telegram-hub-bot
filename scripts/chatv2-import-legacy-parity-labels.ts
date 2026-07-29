#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
  buildChatV2LegacyParityEvidenceInput,
  buildChatV2RetirementObserverCorpusBinding,
  deleteExactCurrentChatV2RetirementEvidenceRows,
  validateChatV2LegacyParityLabel,
  validateChatV2LegacyParityObservation,
  type ChatV2LegacyParityLabel,
  type ChatV2LegacyParityObservation,
  type ChatV2RetirementObserverCorpusBinding,
} from '../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META,
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS,
} from '../src/services/chat-legacy-parity-route-prompts';
import { buildLegacyParitySampleHmac } from '../src/services/chat-legacy-parity-observation-harness';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
const labelsPath = readArg('--labels');
const peerReviewSignoffPath = readArg('--peer-review-signoff');
const observationsPath = readArg('--observations');
const manifestPath = readArg('--manifest');
const rawReviewArtifactPath = readArg('--raw-review-artifact');
const SAMPLE_IDENTITY_POLICY = 'route_index_request_language_expected_response_language_v1';
const REQUEST_LANGUAGES = new Set(['en', 'pt-BR', 'pt-PT']);
const EXPECTED_RESPONSE_LANGUAGES = new Set(['en', 'pt-BR', 'pt-PT']);
const shouldWrite = hasFlag('--write');
const shouldReplace = hasFlag('--replace-route-labels');
const requestId = readArg('--request-id') ?? `legacy-parity-import-${new Date().toISOString()}`;
const MIN_REVIEWED_SAMPLE_COUNT = 50;
const MIN_REVIEWED_PARITY_RATE = 0.95;

if (!labelsPath) {
  console.error('Missing --labels=<path>. Provide NDJSON or JSON array route parity labels.');
  process.exitCode = 1;
} else if (!shouldWrite) {
  console.error([
	    'Refusing to import ChatV2 legacy parity labels without --write.',
	    'Labels must be aggregate safe metadata only. Raw prompts/responses/messages are rejected.',
	    'Independent manual/Claude labels must include peerReviewSignoffHash equal to SHA-256 of --peer-review-signoff=<artifact>.',
	    'Independent runtime labels also require --observations=<hmac-only.ndjson>, --manifest=<observer.manifest.json>, and --raw-review-artifact=<local-raw-review.json> so the reviewed raw pairs can be checked for completeness without storing raw data.',
	    'Use: npx tsx scripts/chatv2-import-legacy-parity-labels.ts --write --labels=./path/to/labels.ndjson --peer-review-signoff=./path/to/qa-report.md --observations=./path/to/observations.ndjson --manifest=./path/to/observations.manifest.json --raw-review-artifact=./path/to/observations.review.json --db=./data/local.db',
	  ].join('\n'));
	  process.exitCode = 1;
	} else {
	  const parsed = parseLabelsFile(labelsPath);
	  if (parsed.invalid.length > 0) {
    console.error(JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_import_error.v1',
      labelsPath: path.resolve(labelsPath),
      invalid: parsed.invalid,
	    }, null, 2));
	    process.exitCode = 1;
	  } else {
	    const signoff = validatePeerReviewSignoff(parsed.labels, peerReviewSignoffPath);
	    if (!signoff.ok) {
	      console.error(JSON.stringify({
	        schemaVersion: 'chat_v2_legacy_parity_import_error.v1',
	        labelsPath: path.resolve(labelsPath),
	        peerReviewSignoffPath: peerReviewSignoffPath ? path.resolve(peerReviewSignoffPath) : null,
	        invalid: [{ index: 0, reason: signoff.reason }],
	      }, null, 2));
	      process.exitCode = 1;
	      process.exit(1);
	    }
	    const provenance = validateRuntimeReviewCompletenessIfNeeded({
	      labels: parsed.labels,
	      observationsPath,
	      manifestPath,
	      rawReviewArtifactPath,
	    });
	    if (!provenance.ok) {
	      console.error(JSON.stringify({
	        schemaVersion: 'chat_v2_legacy_parity_import_error.v1',
	        labelsPath: path.resolve(labelsPath),
	        observationsPath: observationsPath ? path.resolve(observationsPath) : null,
	        manifestPath: manifestPath ? path.resolve(manifestPath) : null,
	        invalid: [{ index: 0, reason: provenance.reason }],
	      }, null, 2));
	      process.exitCode = 1;
	      process.exit(1);
	    }
	    const db = new Database(dbPath);
	    try {
	      ensureLegacySchema(db);
	      const tx = db.transaction(() => {
	        if (shouldReplace) {
            deleteExactCurrentChatV2RetirementEvidenceRows(db, {
              evidenceSource: 'runtime_route',
              routeIds: parsed.labels.map((label) => label.routeId),
              importMarker: 'parityLabelImport',
            });
	        }
	        for (const label of parsed.labels) {
	          const evidence = buildChatV2LegacyParityEvidenceInput({
              label,
              requestId: `${requestId}:${label.routeId}`,
              observerCorpusBinding: provenance.observerCorpusBinding,
            });
	          const safeMetadataJson = JSON.stringify({
              ...evidence.safeMetadata,
              reviewCompletenessChecked: provenance.reviewCompletenessChecked ?? false,
              observerManifestSha256: provenance.manifestSha256 ?? null,
              observerObservationsSha256: provenance.observationsSha256 ?? null,
              rawReviewArtifactCompletenessChecked: provenance.rawReviewArtifactCompletenessChecked ?? false,
              rawReviewArtifactSha256: provenance.rawReviewArtifactSha256 ?? null,
              observedRouteSampleCount: provenance.routeSampleCounts?.[label.routeId] ?? null,
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
	            hmacToken('legacy-parity-label', `${evidence.requestId}:${evidence.routeId}`),
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
	    console.log(JSON.stringify({
	      schemaVersion: 'chat_v2_legacy_parity_import_result.v1',
	      dbPath,
	      labelsPath: path.resolve(labelsPath),
	      peerReviewSignoffPath: signoff.signoffPath,
	      peerReviewSignoffHash: signoff.signoffHash,
	      observationsPath: provenance.observationsPath,
	      manifestPath: provenance.manifestPath,
	      rawReviewArtifactPath: provenance.rawReviewArtifactPath,
	      reviewCompletenessChecked: provenance.reviewCompletenessChecked ?? false,
	      rawReviewArtifactCompletenessChecked: provenance.rawReviewArtifactCompletenessChecked ?? false,
	      requestId,
	      importedRows: parsed.labels.length,
	      replacedPreviousParityLabels: shouldReplace,
	      warning: 'Imported route_exit rows are only as strong as the peer-reviewed parity labels. Do not import generated labels without independent review.',
	    }, null, 2));
	  }
	}

function parseLabelsFile(filePath: string): {
  labels: ChatV2LegacyParityLabel[];
  invalid: Array<{ index: number; reason: string }>;
} {
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8').trim();
  if (!raw) return { labels: [], invalid: [{ index: 0, reason: 'empty_labels_file' }] };
  const values = raw.startsWith('[')
    ? JSON.parse(raw) as unknown[]
    : raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const labels: ChatV2LegacyParityLabel[] = [];
  const invalid: Array<{ index: number; reason: string }> = [];
  values.forEach((value, index) => {
    const validation = validateChatV2LegacyParityLabel(value);
    if (!validation.ok) {
      invalid.push({ index, reason: validation.reason });
      return;
    }
    const importable = validateImportableParityLabel(validation.label);
    if (!importable.ok) {
      invalid.push({ index, reason: importable.reason });
      return;
    }
    labels.push(validation.label);
  });
  if (labels.length === 0 && invalid.length === 0) invalid.push({ index: 0, reason: 'no_labels' });
  return { labels, invalid };
}

function validateImportableParityLabel(label: ChatV2LegacyParityLabel): { ok: true } | { ok: false; reason: string } {
  if (label.evaluator !== 'claude' && label.evaluator !== 'manual') {
    return { ok: false, reason: `independent_peer_review_required:${label.routeId}` };
  }
  if (!label.replaced || !label.tested) {
    return { ok: false, reason: `route_not_replaceable:${label.routeId}` };
  }
  if (label.evidenceSource === 'local_sandbox_seed') {
    return { ok: false, reason: `local_sandbox_seed_not_retirement_evidence:${label.routeId}` };
  }
  if (label.sampleCount < MIN_REVIEWED_SAMPLE_COUNT) {
    return { ok: false, reason: `below_min_reviewed_samples:${label.routeId}` };
  }
  const parityRate = label.sampleCount > 0 ? label.matchingCount / label.sampleCount : 0;
  if (parityRate < MIN_REVIEWED_PARITY_RATE) {
    return { ok: false, reason: `below_min_reviewed_parity:${label.routeId}` };
  }
  return { ok: true };
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

function validatePeerReviewSignoff(labels: ChatV2LegacyParityLabel[], filePath?: string): {
  ok: true;
  signoffPath?: string;
  signoffHash?: string;
} | {
  ok: false;
  reason: string;
} {
  const independentLabels = labels.filter((label) => label.evaluator === 'claude' || label.evaluator === 'manual');
  if (independentLabels.length === 0) return { ok: true };
  if (!filePath) return { ok: false, reason: 'missing_peer_review_signoff_artifact' };
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { ok: false, reason: 'peer_review_signoff_artifact_not_found' };
  }
  const signoffHash = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  const mismatched = independentLabels.find((label) => label.peerReviewSignoffHash?.toLowerCase() !== signoffHash);
  if (mismatched) {
    return { ok: false, reason: `peer_review_signoff_hash_mismatch:${mismatched.routeId}` };
  }
  return {
    ok: true,
    signoffPath: resolved,
    signoffHash,
  };
}

function validateRuntimeReviewCompletenessIfNeeded(input: {
  labels: ChatV2LegacyParityLabel[];
  observationsPath?: string;
  manifestPath?: string;
  rawReviewArtifactPath?: string;
}): {
  ok: true;
  reviewCompletenessChecked?: boolean;
  observationsPath?: string;
  manifestPath?: string;
  rawReviewArtifactPath?: string;
  observationsSha256?: string;
  manifestSha256?: string;
  rawReviewArtifactSha256?: string;
  rawReviewArtifactCompletenessChecked?: boolean;
  routeSampleCounts?: Record<string, number>;
  observerCorpusBinding?: ChatV2RetirementObserverCorpusBinding;
} | {
  ok: false;
  reason: string;
} {
  const independentRuntimeLabels = input.labels.filter((label) =>
    (label.evaluator === 'claude' || label.evaluator === 'manual')
    && (label.evidenceSource ?? 'runtime_route') === 'runtime_route',
  );
  if (independentRuntimeLabels.length === 0) return { ok: true };
  if (!input.observationsPath) return { ok: false, reason: 'missing_review_observations_artifact' };
  if (!input.manifestPath) return { ok: false, reason: 'missing_review_manifest_artifact' };
  if (!input.rawReviewArtifactPath) return { ok: false, reason: 'missing_raw_review_artifact' };

  const resolvedObservationsPath = path.resolve(input.observationsPath);
  const resolvedManifestPath = path.resolve(input.manifestPath);
  const resolvedRawReviewArtifactPath = path.resolve(input.rawReviewArtifactPath);
  if (!fs.existsSync(resolvedObservationsPath) || !fs.statSync(resolvedObservationsPath).isFile()) {
    return { ok: false, reason: 'review_observations_artifact_not_found' };
  }
  if (!fs.existsSync(resolvedManifestPath) || !fs.statSync(resolvedManifestPath).isFile()) {
    return { ok: false, reason: 'review_manifest_artifact_not_found' };
  }
  if (!fs.existsSync(resolvedRawReviewArtifactPath) || !fs.statSync(resolvedRawReviewArtifactPath).isFile()) {
    return { ok: false, reason: 'raw_review_artifact_not_found' };
  }

  const parsedObservations = parseObservationsFile(resolvedObservationsPath);
  if (parsedObservations.invalid.length > 0) {
    return { ok: false, reason: `review_observations_invalid:${parsedObservations.invalid[0]!.reason}` };
  }
  const manifestRaw = fs.readFileSync(resolvedManifestPath, 'utf8');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'review_manifest_invalid_json' };
  }

  if (manifest.schemaVersion !== 'chat_v2_legacy_parity_observer_manifest.v1') {
    return { ok: false, reason: 'review_manifest_invalid_schema' };
  }
  if (manifest.evidenceSource !== 'runtime_route') return { ok: false, reason: 'review_manifest_not_runtime_route' };
  if (manifest.runtimeRouteDistinctEndpoints !== true) return { ok: false, reason: 'review_manifest_endpoints_not_distinct' };
  if (manifest.rawPromptOrResponseStored !== false) return { ok: false, reason: 'review_manifest_raw_storage_not_false' };
  if (manifest.rawReviewArtifactLocalOnly !== true) return { ok: false, reason: 'review_manifest_raw_artifact_not_local_only' };
  if (manifest.rawReviewArtifactContainsRawPromptOrResponse !== true) {
    return { ok: false, reason: 'review_manifest_raw_artifact_missing_raw_pairs' };
  }
  if (manifest.rawReviewArtifactSchemaVersion !== 'chat_v2_legacy_parity_raw_review_row.v1') {
    return { ok: false, reason: 'review_manifest_raw_artifact_schema_mismatch' };
  }
  if (manifest.routePromptVersion !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.version) {
    return { ok: false, reason: 'review_manifest_route_prompt_version_mismatch' };
  }
  if (manifest.routeCorpusId !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.corpusId) {
    return { ok: false, reason: 'review_manifest_route_corpus_id_mismatch' };
  }
  if (
    manifest.routeCorpusFrozenBeforeImplementation
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.frozenBeforeImplementation
  ) {
    return { ok: false, reason: 'review_manifest_corpus_freeze_claim_mismatch' };
  }
  if (
    manifest.routeCorpusMutationPolicy
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.mutationPolicy
  ) {
    return { ok: false, reason: 'review_manifest_corpus_mutation_policy_mismatch' };
  }
  if (
    manifest.routeCorpusProjectionPolicy
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.projectionPolicy
  ) {
    return { ok: false, reason: 'review_manifest_corpus_projection_policy_mismatch' };
  }
  if (manifest.sampleIdentityPolicy !== SAMPLE_IDENTITY_POLICY) {
    return { ok: false, reason: 'review_manifest_sample_identity_policy_mismatch' };
  }
  const manifestRoutes = Array.isArray(manifest.routeIds)
    ? manifest.routeIds.filter((item): item is string => typeof item === 'string').sort()
    : [];
  let observerCorpusBinding: ChatV2RetirementObserverCorpusBinding;
  try {
    observerCorpusBinding = buildChatV2RetirementObserverCorpusBinding(manifestRoutes);
  } catch {
    return { ok: false, reason: 'review_manifest_route_mismatch' };
  }
  if (manifest.routeCorpusSha256 !== observerCorpusBinding.routeCorpusSha256) {
    return { ok: false, reason: 'review_manifest_route_corpus_hash_mismatch' };
  }
  if (manifest.reviewRubricVersion !== CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION) {
    return { ok: false, reason: 'review_manifest_rubric_mismatch' };
  }
  if (typeof manifest.comparatorVersion !== 'string' || !manifest.comparatorVersion.startsWith('chat_v2_legacy_parity_comparator.')) {
    return { ok: false, reason: 'review_manifest_missing_comparator_version' };
  }
  if (typeof manifest.stateFixtureHash !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(manifest.stateFixtureHash)) {
    return { ok: false, reason: 'review_manifest_missing_fixture_hash' };
  }
  if (manifest.observationRows !== parsedObservations.observations.length) {
    return { ok: false, reason: 'review_manifest_row_count_mismatch' };
  }

  const observationsRaw = fs.readFileSync(resolvedObservationsPath);
  const observationsSha256 = crypto.createHash('sha256').update(observationsRaw).digest('hex');
  if (manifest.observationsSha256 !== observationsSha256) {
    return { ok: false, reason: 'review_manifest_observation_hash_mismatch' };
  }
  const manifestSha256 = crypto.createHash('sha256').update(manifestRaw).digest('hex');

  const observationRoutes = [...new Set(parsedObservations.observations.map((row) => row.routeId))].sort();
  if (JSON.stringify(observationRoutes) !== JSON.stringify(manifestRoutes)) {
    return { ok: false, reason: 'review_manifest_route_mismatch' };
  }

  const uniqueSamplesByRoute = new Map<string, Set<string>>();
  for (const observation of parsedObservations.observations) {
    const existing = uniqueSamplesByRoute.get(observation.routeId) ?? new Set<string>();
    existing.add(observation.sampleHmac);
    uniqueSamplesByRoute.set(observation.routeId, existing);
  }

  const routeSampleCounts: Record<string, number> = {};
  for (const [routeId, samples] of uniqueSamplesByRoute.entries()) {
    routeSampleCounts[routeId] = samples.size;
    const projectedPromptCount =
      CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS
        .find((route) => route.routeId === routeId)?.prompts.length;
    if (projectedPromptCount == null) {
      return { ok: false, reason: `review_manifest_route_mismatch:${routeId}` };
    }
    if (samples.size > projectedPromptCount) {
      return {
        ok: false,
        reason: `review_samples_exceed_frozen_projection:${routeId}`,
      };
    }
  }

  const rawReviewValidation = validateRawReviewArtifactCompleteness({
    filePath: resolvedRawReviewArtifactPath,
    observations: parsedObservations.observations,
    manifestRoutes,
  });
  if (!rawReviewValidation.ok) return { ok: false, reason: rawReviewValidation.reason };

  for (const label of independentRuntimeLabels) {
    if (label.reviewRubricVersion !== CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION) {
      return { ok: false, reason: `review_label_rubric_mismatch:${label.routeId}` };
    }
    if ((label.qualityRegressionCount ?? 0) !== 0) {
      return { ok: false, reason: `review_quality_regression_present:${label.routeId}` };
    }
    if ((label.degradedNotComparableCount ?? 0) !== 0) {
      return { ok: false, reason: `review_degraded_not_comparable_present:${label.routeId}` };
    }
    if (!manifestRoutes.includes(label.routeId)) {
      return { ok: false, reason: `review_manifest_missing_label_route:${label.routeId}` };
    }
    const sampleCount = uniqueSamplesByRoute.get(label.routeId)?.size ?? 0;
    if (sampleCount !== label.sampleCount) {
      return { ok: false, reason: `review_sample_count_mismatch:${label.routeId}` };
    }
  }

  return {
    ok: true,
    reviewCompletenessChecked: true,
    observationsPath: resolvedObservationsPath,
    manifestPath: resolvedManifestPath,
    rawReviewArtifactPath: resolvedRawReviewArtifactPath,
    observationsSha256,
    manifestSha256,
    rawReviewArtifactSha256: rawReviewValidation.rawReviewArtifactSha256,
    rawReviewArtifactCompletenessChecked: true,
    routeSampleCounts,
    observerCorpusBinding,
  };
}

function validateRawReviewArtifactCompleteness(input: {
  filePath: string;
  observations: ChatV2LegacyParityObservation[];
  manifestRoutes: string[];
}): {
  ok: true;
  rawReviewArtifactSha256: string;
} | {
  ok: false;
  reason: string;
} {
  const raw = fs.readFileSync(input.filePath, 'utf8');
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'raw_review_artifact_invalid_json' };
  }
  if (!Array.isArray(rows)) return { ok: false, reason: 'raw_review_artifact_not_array' };
  if (rows.length !== input.observations.length) {
    return { ok: false, reason: 'raw_review_artifact_row_count_mismatch' };
  }

  const observationsByHmac = new Map(input.observations.map((observation) => [observation.sampleHmac, observation]));
  const seen = new Set<string>();
  for (const [index, value] of rows.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: `raw_review_artifact_invalid_row:${index}` };
    }
    const row = value as Record<string, unknown>;
    if (row.schemaVersion !== 'chat_v2_legacy_parity_raw_review_row.v1') {
      return { ok: false, reason: `raw_review_artifact_invalid_schema:${index}` };
    }
    if (typeof row.routeId !== 'string' || !input.manifestRoutes.includes(row.routeId)) {
      return { ok: false, reason: `raw_review_artifact_invalid_route:${index}` };
    }
    if (typeof row.sampleHmac !== 'string' || !observationsByHmac.has(row.sampleHmac)) {
      return { ok: false, reason: `raw_review_artifact_unknown_sample:${index}` };
    }
    if (seen.has(row.sampleHmac)) {
      return { ok: false, reason: `raw_review_artifact_duplicate_sample:${row.sampleHmac}` };
    }
    const observation = observationsByHmac.get(row.sampleHmac)!;
    if (observation.routeId !== row.routeId) {
      return { ok: false, reason: `raw_review_artifact_route_mismatch:${index}` };
    }
    if (typeof row.promptText !== 'string') {
      return { ok: false, reason: `raw_review_artifact_missing_prompt:${index}` };
    }
    if (typeof row.requestLanguage !== 'string' || !REQUEST_LANGUAGES.has(row.requestLanguage)) {
      return { ok: false, reason: `raw_review_artifact_invalid_request_language:${index}` };
    }
    if (
      typeof row.expectedResponseLanguage !== 'string'
      || !EXPECTED_RESPONSE_LANGUAGES.has(row.expectedResponseLanguage)
    ) {
      return { ok: false, reason: `raw_review_artifact_invalid_expected_response_language:${index}` };
    }
    if (Object.prototype.hasOwnProperty.call(row, 'language')) {
      return { ok: false, reason: `raw_review_artifact_ambiguous_language_field:${index}` };
    }
    if (
      typeof row.sampleKey !== 'string'
      || !row.sampleKey.startsWith(`${row.routeId}:`)
      || !row.sampleKey.endsWith(
        `:request=${row.requestLanguage}:response=${row.expectedResponseLanguage}`,
      )
    ) {
      return { ok: false, reason: `raw_review_artifact_sample_language_binding_mismatch:${index}` };
    }
    const hmacSecret = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
    if (!hmacSecret) {
      return { ok: false, reason: 'raw_review_artifact_sample_identity_secret_missing' };
    }
    const expectedSampleHmac = buildLegacyParitySampleHmac({
      hmacSecret,
      routeId: row.routeId,
      sampleKey: row.sampleKey,
      evidenceSource: observation.evidenceSource ?? 'runtime_route',
    });
    if (row.sampleHmac !== expectedSampleHmac) {
      return { ok: false, reason: `raw_review_artifact_sample_hmac_mismatch:${index}` };
    }
    if (!row.legacyRawResponse || typeof row.legacyRawResponse !== 'object' || Array.isArray(row.legacyRawResponse)) {
      return { ok: false, reason: `raw_review_artifact_missing_legacy_response:${index}` };
    }
    if (!row.chatV2RawResponse || typeof row.chatV2RawResponse !== 'object' || Array.isArray(row.chatV2RawResponse)) {
      return { ok: false, reason: `raw_review_artifact_missing_chatv2_response:${index}` };
    }
    seen.add(row.sampleHmac);
  }
  if (seen.size !== observationsByHmac.size) {
    return { ok: false, reason: 'raw_review_artifact_missing_samples' };
  }
  return {
    ok: true,
    rawReviewArtifactSha256: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function hmacToken(kind: string, value: string): string {
  const secret = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
  if (!secret) {
    throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required to import legacy parity labels');
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

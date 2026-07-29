#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Compose a reviewable parity set from repeated distinct-endpoint observation
 * runs over the same governed corpus and fixture.
 *
 * This is intentionally conservative:
 * - all source manifests must describe the same route set, corpus hash,
 *   fixture hash, endpoint pair, comparator, and sample-HMAC set;
 * - every output sample must come from a matched/comparable source row;
 * - the output remains runtime_tool evidence and still requires Claude/manual
 *   review + label import before retirement gates can pass.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import {
  buildChatV2RetirementObserverCorpusBinding,
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
  validateChatV2LegacyParityObservation,
  type ChatV2LegacyParityObservation,
} from '../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META,
} from '../src/services/chat-legacy-parity-route-prompts';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

type AnyRecord = Record<string, unknown>;
const SAMPLE_IDENTITY_POLICY = 'route_index_request_language_expected_response_language_v1';
const REQUEST_LANGUAGES = new Set(['en', 'pt-BR', 'pt-PT', 'es', 'es-419', 'mixed']);
const EXPECTED_RESPONSE_LANGUAGES = new Set(['en', 'pt-BR', 'pt-PT', 'mixed']);

type SourceArtifact = {
  observationsPath: string;
  manifestPath: string;
  rawReviewArtifactPath: string;
  observations: ChatV2LegacyParityObservation[];
  manifest: AnyRecord;
  rawReviewRows: AnyRecord[];
  observationSha256: string;
  manifestSha256: string;
  rawReviewSha256: string;
  sampleSetKey: string;
};

const sourcePaths = parseListArg('--sources');
const outPath = path.resolve(readArg('--out') ?? '.local/release/eval-evidence/chatv2-legacy-parity-observations-composed.ndjson');
const minSamplesPerRoute = parsePositiveInt(readArg('--min-samples-per-route')) ?? 50;

if (sourcePaths.length < 2) {
  console.error('Missing --sources=<obs1.ndjson,obs2.ndjson,...>. Provide at least two repeated observation runs.');
  process.exit(1);
}

try {
  const rawReviewArtifactOutPath = parseRawReviewArtifactOutPath();
  const sources = sourcePaths.map(loadSourceArtifact);
  const baseline = sources[0]!;
  for (const source of sources.slice(1)) {
    assertCompatibleSource(baseline, source);
  }

  const expectedSamplesByRoute = buildExpectedSamplesByRoute(baseline);
  const selectedObservations: ChatV2LegacyParityObservation[] = [];
  const selectedRawRows: AnyRecord[] = [];
  const selectedSources: Array<{
    routeId: string;
    sampleHmac: string;
    sourceObservationsSha256: string;
    sourcePathHmac: string;
  }> = [];

  for (const [routeId, sampleHmacs] of expectedSamplesByRoute.entries()) {
    if (sampleHmacs.size < minSamplesPerRoute) {
      throw new Error(`route_below_min_samples:${routeId}:${sampleHmacs.size}<${minSamplesPerRoute}`);
    }
    for (const sampleHmac of [...sampleHmacs].sort()) {
      const selected = selectMatchedRow({ routeId, sampleHmac, sources });
      if (!selected) throw new Error(`missing_comparable_matched_sample:${routeId}:${sampleHmac}`);
      selectedObservations.push(selected.observation);
      selectedRawRows.push(selected.rawReviewRow);
      selectedSources.push({
        routeId,
        sampleHmac,
        sourceObservationsSha256: selected.source.observationSha256,
        sourcePathHmac: hmacLocalPath(selected.source.observationsPath),
      });
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(rawReviewArtifactOutPath), { recursive: true });
  const observationsPayload = selectedObservations.map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(outPath, observationsPayload);
  const manifestPath = outPath.replace(/\.ndjson$/i, '.manifest.json');
  fs.writeFileSync(rawReviewArtifactOutPath, `${JSON.stringify(selectedRawRows, null, 2)}\n`);

  const observationsSha256 = sha256(Buffer.from(observationsPayload));
  const samplesByRoute = Object.fromEntries(
    [...expectedSamplesByRoute.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([routeId, sampleHmacs]) => [routeId, sampleHmacs.size]),
  );
  const uniformSampleCounts = new Set(Object.values(samplesByRoute));
  const actualSamplesPerRoute = uniformSampleCounts.size === 1
    ? [...uniformSampleCounts][0]
    : Math.min(...Object.values(samplesByRoute));
  const manifest = {
    ...baseline.manifest,
    generatedAt: new Date().toISOString(),
    observationsSha256,
    observationRows: selectedObservations.length,
    samplesPerRoute: actualSamplesPerRoute,
    samplesByRoute,
    rawPromptOrResponseStored: false,
    committedObservationRawPromptOrResponseStored: false,
    rawReviewArtifactLocalOnly: true,
    rawReviewArtifactContainsRawPromptOrResponse: true,
    rawReviewArtifactSchemaVersion: 'chat_v2_legacy_parity_raw_review_row.v1',
    retrySelection: {
      schemaVersion: 'chat_v2_legacy_parity_retry_selection.v1',
      selectionPolicy: 'first_matched_comparable_row_per_sample_hmac_from_ordered_sources',
      independentReviewRequired: true,
      outputStillRuntimeToolOnly: true,
      sourceCount: sources.length,
      sourceArtifacts: sources.map((source) => ({
        observationsSha256: source.observationSha256,
        manifestSha256: source.manifestSha256,
        rawReviewArtifactSha256: source.rawReviewSha256,
        observationsPathHmac: hmacLocalPath(source.observationsPath),
        observationRows: source.observations.length,
        matchedRows: source.observations.filter((row) => row.matched).length,
      })),
      selectedRows: selectedSources,
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify({
    schemaVersion: 'chat_v2_legacy_parity_retry_selection_result.v1',
    outPath,
    manifestPath,
    rawReviewArtifactPath: rawReviewArtifactOutPath,
    observationsSha256,
    rows: selectedObservations.length,
    routes: [...expectedSamplesByRoute.keys()].sort(),
    warning: 'Composed retry evidence is runtime_tool plumbing only. Claude/manual must review the raw artifact and import signed labels before any retirement gate can pass.',
  }, null, 2));
} catch (err) {
  console.error(JSON.stringify({
    schemaVersion: 'chat_v2_legacy_parity_retry_selection_error.v1',
    reason: err instanceof Error ? err.message : String(err),
  }, null, 2));
  process.exit(1);
}

function loadSourceArtifact(observationsPathInput: string): SourceArtifact {
  const observationsPath = path.resolve(observationsPathInput);
  const manifestPath = observationsPath.replace(/\.ndjson$/i, '.manifest.json');
  const rawReviewArtifactPath = observationsPath.replace(/\.ndjson$/i, '.review.json');
  const observationsRaw = fs.readFileSync(observationsPath, 'utf8');
  const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const rawReviewRaw = fs.readFileSync(rawReviewArtifactPath, 'utf8');
  const observations = parseObservations(observationsRaw, observationsPath);
  const manifest = parseJsonObject(manifestRaw, 'manifest');
  const rawReviewRows = parseJsonArray(rawReviewRaw, 'raw_review_artifact');
  validateManifest(manifest, observations, sha256(Buffer.from(observationsRaw)));
  validateRawReviewRows(rawReviewRows, observations);
  return {
    observationsPath,
    manifestPath,
    rawReviewArtifactPath,
    observations,
    manifest,
    rawReviewRows,
    observationSha256: sha256(Buffer.from(observationsRaw)),
    manifestSha256: sha256(Buffer.from(manifestRaw)),
    rawReviewSha256: sha256(Buffer.from(rawReviewRaw)),
    sampleSetKey: buildSampleSetKey(observations),
  };
}

function parseObservations(raw: string, filePath: string): ChatV2LegacyParityObservation[] {
  return raw.trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    const parsed = JSON.parse(line) as unknown;
    const validation = validateChatV2LegacyParityObservation(parsed);
    if (!validation.ok) throw new Error(`invalid_observation:${path.basename(filePath)}:${index}:${validation.reason}`);
    return validation.observation;
  });
}

function parseJsonObject(raw: string, label: string): AnyRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}_not_object`);
  return parsed as AnyRecord;
}

function parseJsonArray(raw: string, label: string): AnyRecord[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${label}_not_array`);
  return parsed.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label}_invalid_row:${index}`);
    return row as AnyRecord;
  });
}

function validateManifest(
  manifest: AnyRecord,
  observations: ChatV2LegacyParityObservation[],
  observationsSha256: string,
): void {
  if (manifest.schemaVersion !== 'chat_v2_legacy_parity_observer_manifest.v1') throw new Error('manifest_invalid_schema');
  if (manifest.evidenceSource !== 'runtime_route') throw new Error('manifest_not_runtime_route');
  if (manifest.runtimeRouteDistinctEndpoints !== true) throw new Error('manifest_endpoints_not_distinct');
  if (manifest.rawPromptOrResponseStored !== false) throw new Error('manifest_raw_storage_not_false');
  if (manifest.rawReviewArtifactLocalOnly !== true) throw new Error('manifest_raw_artifact_not_local_only');
  if (manifest.rawReviewArtifactContainsRawPromptOrResponse !== true) throw new Error('manifest_raw_artifact_missing_raw_pairs');
  if (manifest.rawReviewArtifactSchemaVersion !== 'chat_v2_legacy_parity_raw_review_row.v1') throw new Error('manifest_raw_artifact_schema_mismatch');
  if (
    manifest.routePromptVersion
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.version
  ) {
    throw new Error('manifest_prompt_version_mismatch');
  }
  if (
    manifest.routeCorpusId
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.corpusId
  ) {
    throw new Error('manifest_corpus_id_mismatch');
  }
  if (
    manifest.routeCorpusFrozenBeforeImplementation
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.frozenBeforeImplementation
  ) {
    throw new Error('manifest_corpus_freeze_claim_mismatch');
  }
  if (
    manifest.routeCorpusFrozenAt
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.frozenAt
  ) {
    throw new Error('manifest_corpus_frozen_at_mismatch');
  }
  if (
    manifest.routeCorpusMutationPolicy
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.mutationPolicy
  ) {
    throw new Error('manifest_corpus_mutation_policy_mismatch');
  }
  if (
    manifest.routeCorpusProjectionPolicy
    !== CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.projectionPolicy
  ) {
    throw new Error('manifest_corpus_projection_policy_mismatch');
  }
  if (manifest.sampleIdentityPolicy !== SAMPLE_IDENTITY_POLICY) {
    throw new Error('manifest_sample_identity_policy_mismatch');
  }
  if (manifest.reviewRubricVersion !== CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION) throw new Error('manifest_rubric_mismatch');
  if (manifest.observationRows !== observations.length) throw new Error('manifest_row_count_mismatch');
  if (manifest.observationsSha256 !== observationsSha256) throw new Error('manifest_observation_hash_mismatch');
  const manifestRouteIds = sortedStrings(manifest.routeIds);
  let observerCorpusBinding;
  try {
    observerCorpusBinding = buildChatV2RetirementObserverCorpusBinding(manifestRouteIds);
  } catch {
    throw new Error('manifest_route_mismatch');
  }
  if (manifest.routeCorpusSha256 !== observerCorpusBinding.routeCorpusSha256) {
    throw new Error('manifest_corpus_hash_mismatch');
  }
  const observationRouteIds = [...new Set(observations.map((row) => row.routeId))].sort();
  if (JSON.stringify(manifestRouteIds) !== JSON.stringify(observationRouteIds)) {
    throw new Error('manifest_route_mismatch');
  }
  if (typeof manifest.stateFixtureHash !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(manifest.stateFixtureHash)) {
    throw new Error('manifest_missing_fixture_hash');
  }
}

function validateRawReviewRows(rows: AnyRecord[], observations: ChatV2LegacyParityObservation[]): void {
  if (rows.length !== observations.length) throw new Error('raw_review_row_count_mismatch');
  const observationsByHmac = new Map(observations.map((row) => [row.sampleHmac, row]));
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.schemaVersion !== 'chat_v2_legacy_parity_raw_review_row.v1') throw new Error(`raw_review_invalid_schema:${index}`);
    if (typeof row.routeId !== 'string') throw new Error(`raw_review_missing_route:${index}`);
    if (typeof row.sampleHmac !== 'string' || !observationsByHmac.has(row.sampleHmac)) {
      throw new Error(`raw_review_unknown_sample:${index}`);
    }
    if (seen.has(row.sampleHmac)) throw new Error(`raw_review_duplicate_sample:${row.sampleHmac}`);
    const observation = observationsByHmac.get(row.sampleHmac)!;
    if (observation.routeId !== row.routeId) throw new Error(`raw_review_route_mismatch:${index}`);
    if (typeof row.promptText !== 'string') throw new Error(`raw_review_missing_prompt:${index}`);
    if (typeof row.requestLanguage !== 'string' || !REQUEST_LANGUAGES.has(row.requestLanguage)) {
      throw new Error(`raw_review_invalid_request_language:${index}`);
    }
    if (
      typeof row.expectedResponseLanguage !== 'string'
      || !EXPECTED_RESPONSE_LANGUAGES.has(row.expectedResponseLanguage)
    ) {
      throw new Error(`raw_review_invalid_expected_response_language:${index}`);
    }
    if (Object.prototype.hasOwnProperty.call(row, 'language')) {
      throw new Error(`raw_review_ambiguous_language_field:${index}`);
    }
    if (
      typeof row.sampleKey !== 'string'
      || !row.sampleKey.startsWith(`${row.routeId}:`)
      || !row.sampleKey.endsWith(
        `:request=${row.requestLanguage}:response=${row.expectedResponseLanguage}`,
      )
    ) {
      throw new Error(`raw_review_sample_language_binding_mismatch:${index}`);
    }
    if (!row.legacyRawResponse || typeof row.legacyRawResponse !== 'object' || Array.isArray(row.legacyRawResponse)) {
      throw new Error(`raw_review_missing_legacy_response:${index}`);
    }
    if (!row.chatV2RawResponse || typeof row.chatV2RawResponse !== 'object' || Array.isArray(row.chatV2RawResponse)) {
      throw new Error(`raw_review_missing_chatv2_response:${index}`);
    }
    seen.add(row.sampleHmac);
  }
}

function assertCompatibleSource(baseline: SourceArtifact, candidate: SourceArtifact): void {
  const keys: Array<keyof AnyRecord> = [
    'evidenceSource',
    'routePromptVersion',
    'routeCorpusId',
    'routeCorpusSha256',
    'reviewRubricVersion',
    'comparatorVersion',
    'stateFixtureHash',
    'runtimeRouteDistinctEndpoints',
    'legacyEndpointHmac',
    'chatV2EndpointHmac',
    'stateFixtureContract',
    'writeFixtureSeeding',
    'writeRoutes',
    'isolatePrompts',
    'tokenFilesAreLocalOnly',
    'routeCorpusFrozenAt',
    'routeCorpusFrozenBeforeImplementation',
    'routeCorpusMutationPolicy',
    'routeCorpusProjectionPolicy',
    'promptSamplingPolicy',
    'distinctPromptsByRoute',
  ];
  for (const key of keys) {
    if (JSON.stringify(baseline.manifest[key]) !== JSON.stringify(candidate.manifest[key])) {
      throw new Error(`source_manifest_mismatch:${String(key)}`);
    }
  }
  if (JSON.stringify(sortedStrings(baseline.manifest.routeIds)) !== JSON.stringify(sortedStrings(candidate.manifest.routeIds))) {
    throw new Error('source_manifest_route_mismatch');
  }
  if (baseline.sampleSetKey !== candidate.sampleSetKey) throw new Error('source_sample_hmac_set_mismatch');
}

function buildExpectedSamplesByRoute(source: SourceArtifact): Map<string, Set<string>> {
  const samples = new Map<string, Set<string>>();
  for (const observation of source.observations) {
    const routeSamples = samples.get(observation.routeId) ?? new Set<string>();
    routeSamples.add(observation.sampleHmac);
    samples.set(observation.routeId, routeSamples);
  }
  return samples;
}

function selectMatchedRow(input: {
  routeId: string;
  sampleHmac: string;
  sources: SourceArtifact[];
}): { observation: ChatV2LegacyParityObservation; rawReviewRow: AnyRecord; source: SourceArtifact } | null {
  for (const source of input.sources) {
    const observation = source.observations.find((row) =>
      row.routeId === input.routeId
      && row.sampleHmac === input.sampleHmac
      && row.matched
      && row.reasonCode === 'matched',
    );
    if (!observation) continue;
    const rawReviewRow = source.rawReviewRows.find((row) =>
      row.routeId === input.routeId
      && row.sampleHmac === input.sampleHmac
      && asRecord(row.comparison)?.matched === true
      && !String(JSON.stringify(asRecord(row.comparison)?.reasonCodes ?? [])).includes('degraded_not_comparable'),
    );
    if (!rawReviewRow) throw new Error(`matched_observation_missing_matching_raw_review:${input.routeId}:${input.sampleHmac}`);
    return { observation, rawReviewRow, source };
  }
  return null;
}

function buildSampleSetKey(observations: ChatV2LegacyParityObservation[]): string {
  return stableSha256(observations.map((row) => `${row.routeId}:${row.sampleHmac}`).sort());
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').sort() : [];
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableSha256(value: unknown): string {
  return sha256(JSON.stringify(value, Object.keys(value as object).sort()));
}

function hmacLocalPath(value: string): string {
  const secret = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET || 'local-path-hmac';
  return `hmac:local-path:${crypto.createHmac('sha256', secret).update(path.resolve(value)).digest('hex')}`;
}

function parseListArg(name: string): string[] {
  return String(readArg(name) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRawReviewArtifactOutPath(): string {
  const rawArg = readArg('--raw-review-artifact');
  if (!rawArg) {
    throw new Error('missing_raw_review_artifact_path');
  }
  const resolved = path.resolve(rawArg);
  const localRoot = path.resolve('.local');
  if (resolved !== localRoot && !resolved.startsWith(`${localRoot}${path.sep}`)) {
    throw new Error('raw_review_artifact_must_be_under_dot_local');
  }
  return resolved;
}

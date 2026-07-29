import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
  normalizeChatV2LegacyParityOwnerLabel,
} from '../../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META as CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META,
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS as CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS,
} from '../../src/services/chat-legacy-parity-route-prompts';

const CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION =
  CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.version;

const repoRoot = path.resolve(__dirname, '../..');

let tempDir: string;
let dbPath: string;
let observationsPath: string;
let manifestPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-parity-observation-import-'));
  dbPath = path.join(tempDir, 'test.db');
  observationsPath = path.join(tempDir, 'observations.ndjson');
  manifestPath = path.join(tempDir, 'observations.manifest.json');
  writeRuntimeObservationArtifacts('selective_internet_research', 50);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('chatv2-import-legacy-parity-observations CLI', () => {
  it('keeps full Phase 7 runtime imports as the default completeness gate', () => {
    writeRuntimeObservationArtifacts('chat_message_shortcut_after_route', 50);
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-observations.ts',
        '--write',
        `--observations=${observationsPath}`,
        `--manifest=${manifestPath}`,
        '--qa-review-id=runtime-tool-research-scope',
        `--db=${dbPath}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        stdio: 'pipe',
      });
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }

    expect(stderr).toContain('runtime_route_missing_required_routes');
    expect(stderr).toContain('general_action_planner');
  });

  it('rejects a scoped package that pads the frozen supported-locale projection to 50 rows', () => {
    let stderr = '';
    try {
      runScopedImport();
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }
    expect(stderr).toContain(
      'runtime_route_samples_exceed_frozen_projection:selective_internet_research',
    );
  });

  it('rejects answer-quality research runtime evidence that reuses prompts to pad sample count', () => {
    writeRuntimeObservationArtifacts('selective_internet_research', 50, {
      distinctPromptsByRoute: { selective_internet_research: 4 },
    });

    let stderr = '';
    try {
      runScopedImport();
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }

    expect(stderr).toContain('observer_manifest_distinct_prompt_count_below_samples:selective_internet_research');
  });

  it.each([
    {
      name: 'the unprojected historical v1.4 corpus',
      manifestOverrides: {
        routePromptVersion: 'chat_v2_legacy_parity_route_prompts@1.4.0',
        routeCorpusId: 'chatv2_phase7_route_replacement_heldout',
        routeCorpusSha256: '1'.repeat(64),
      },
      reason: 'observer_manifest_route_corpus_id_mismatch',
    },
    {
      name: 'the post-implementation v1.5 diagnostic corpus',
      manifestOverrides: {
        routePromptVersion: 'chat_v2_legacy_parity_route_prompts@1.5.0',
        routeCorpusId: 'chatv2_phase7_route_replacement_supported_locales_v2',
        routeCorpusFrozenBeforeImplementation: false,
        routeCorpusSha256: '1'.repeat(64),
      },
      reason: 'observer_manifest_route_prompt_version_mismatch',
    },
    {
      name: 'a valid-looking non-current corpus hash',
      manifestOverrides: {
        routeCorpusSha256: 'c'.repeat(64),
      },
      reason: 'observer_manifest_route_corpus_hash_mismatch',
    },
    {
      name: 'a false post-implementation freeze claim',
      manifestOverrides: {
        routeCorpusFrozenBeforeImplementation: false,
      },
      reason: 'observer_manifest_corpus_freeze_claim_mismatch',
    },
    {
      name: 'a wrong corpus mutation policy',
      manifestOverrides: {
        routeCorpusMutationPolicy: 'unreviewed_runtime_replacement_allowed',
      },
      reason: 'observer_manifest_corpus_mutation_policy_mismatch',
    },
    {
      name: 'a missing corpus mutation policy',
      manifestOverrides: {
        routeCorpusMutationPolicy: undefined,
      },
      reason: 'observer_manifest_corpus_mutation_policy_mismatch',
    },
    {
      name: 'a wrong supported-locale projection policy',
      manifestOverrides: {
        routeCorpusProjectionPolicy: 'translated_or_relabelled_rows_allowed',
      },
      reason: 'observer_manifest_corpus_projection_policy_mismatch',
    },
    {
      name: 'a missing request/response language sample identity policy',
      manifestOverrides: {
        sampleIdentityPolicy: undefined,
      },
      reason: 'observer_manifest_sample_identity_policy_mismatch',
    },
  ])('rejects $name', ({ manifestOverrides, reason }) => {
    writeRuntimeObservationArtifacts('selective_internet_research', 50, {
      ...manifestOverrides,
    });

    let stderr = '';
    try {
      runScopedImport();
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }

    expect(stderr).toContain(reason);
  });
});

function runScopedImport(...extraArgs: string[]): string {
  return execFileSync('npx', [
    'tsx',
    'scripts/chatv2-import-legacy-parity-observations.ts',
    '--write',
    `--observations=${observationsPath}`,
    `--manifest=${manifestPath}`,
    '--qa-review-id=runtime-tool-research-scope',
    '--routes=selective_internet_research',
    `--db=${dbPath}`,
    ...extraArgs,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeRuntimeObservationArtifacts(
  routeId: string,
  sampleCount: number,
  manifestOverrides: Record<string, unknown> = {},
): void {
  const routeMetadata = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS
    .find((route) => route.routeId === routeId);
  if (!routeMetadata) throw new Error(`Unknown retirement route fixture: ${routeId}`);
  const rows = Array.from({ length: sampleCount }, (_, index) => ({
    schemaVersion: 'chat_v2_legacy_parity_observation.v1',
    routeId,
    sampleHmac: `hmac:legacy-parity:${String(index).padStart(64, 'a').slice(0, 64)}`,
    matched: true,
    tested: true,
    oldOwner: normalizeChatV2LegacyParityOwnerLabel(routeMetadata.oldOwner),
    replacement: normalizeChatV2LegacyParityOwnerLabel(routeMetadata.replacement),
    evaluator: 'runtime_tool',
    evidenceSource: 'runtime_route',
    reasonCode: 'matched',
  }));
  const payload = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(observationsPath, payload);
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 'chat_v2_legacy_parity_observer_manifest.v1',
    evidenceSource: 'runtime_route',
    runtimeRouteDistinctEndpoints: true,
    rawPromptOrResponseStored: false,
    committedObservationRawPromptOrResponseStored: false,
    rawReviewArtifactLocalOnly: true,
    rawReviewArtifactContainsRawPromptOrResponse: true,
    rawReviewArtifactSchemaVersion: 'chat_v2_legacy_parity_raw_review_row.v1',
    routePromptVersion: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION,
    routeCorpusId: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.corpusId,
    routeCorpusFrozenBeforeImplementation: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.frozenBeforeImplementation,
    routeCorpusMutationPolicy: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.mutationPolicy,
    routeCorpusProjectionPolicy: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.projectionPolicy,
    routeCorpusSha256: currentRouteCorpusSha256([routeId]),
    reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    comparatorVersion: 'chat_v2_legacy_parity_comparator.v3',
    sampleIdentityPolicy: 'route_index_request_language_expected_response_language_v1',
    stateFixtureHash: `sha256:${'d'.repeat(64)}`,
    stateFixtureContract: 'shared_read_only_seeded_snapshot',
    writeFixtureSeeding: null,
    observationsSha256: createHash('sha256').update(payload).digest('hex'),
    observationRows: sampleCount,
    routeIds: [routeId],
    samplesPerRoute: sampleCount,
    samplesByRoute: { [routeId]: sampleCount },
    distinctPromptsByRoute: { [routeId]: sampleCount },
    promptSamplingPolicy: 'no_repeated_prompts_for_answer_quality_research',
    sampleDelayMs: 0,
    isolatePrompts: false,
    writeRoutes: [],
    legacyEndpointHmac: `hmac:endpoint:${'1'.repeat(64)}`,
    chatV2EndpointHmac: `hmac:endpoint:${'2'.repeat(64)}`,
    tokenFilesAreLocalOnly: true,
    ...manifestOverrides,
  }, null, 2));
}

function currentRouteCorpusSha256(routeIds: string[]): string {
  const included = new Set(routeIds);
  return createHash('sha256')
    .update(JSON.stringify(sortJson({
      meta: CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META,
      routes: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.filter((route) => included.has(route.routeId)),
    })))
    .digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

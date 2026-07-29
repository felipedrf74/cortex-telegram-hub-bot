import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  buildChatV2RetirementObserverCorpusBinding,
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
} from '../../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META,
} from '../../src/services/chat-legacy-parity-route-prompts';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../..');
const CLI_PROCESS_TIMEOUT_MS = 30_000;
const CLI_TEST_TIMEOUT_MS = CLI_PROCESS_TIMEOUT_MS + 15_000;

describe('chatv2-compose-legacy-parity-retry-set CLI', () => {
  it('accepts the exact v1.4 retirement manifest emitted by the runtime observer', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-compose-parity-'));
    const localReviewDir = makeLocalReviewDir();
    const retirementManifest = {
      routePromptVersion: CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.version,
      routeCorpusId: CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.corpusId,
      routeCorpusFrozenAt: CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.frozenAt,
      routeCorpusFrozenBeforeImplementation:
        CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.frozenBeforeImplementation,
      routeCorpusMutationPolicy:
        CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.mutationPolicy,
      routeCorpusProjectionPolicy:
        CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.projectionPolicy,
    };
    try {
      const sourceA = writeSource(tempDir, 'source-a', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ], retirementManifest);
      const sourceB = writeSource(tempDir, 'source-b', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ], retirementManifest);

      const { stdout } = await execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-compose-legacy-parity-retry-set.ts',
        `--sources=${sourceA},${sourceB}`,
        '--min-samples-per-route=2',
        `--out=${path.join(tempDir, 'composed.ndjson')}`,
        `--raw-review-artifact=${path.join(localReviewDir, 'composed.review.json')}`,
      ], {
        cwd: repoRoot,
        env: { ...process.env, CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret' },
        timeout: CLI_PROCESS_TIMEOUT_MS,
      });

      expect(JSON.parse(stdout)).toMatchObject({
        schemaVersion: 'chat_v2_legacy_parity_retry_selection_result.v1',
        rows: 2,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(localReviewDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('composes one matched comparable row per governed sample while keeping committed rows HMAC-only', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-compose-parity-'));
    const localReviewDir = makeLocalReviewDir();
    try {
      const sampleA = sampleHmac('a');
      const sampleB = sampleHmac('b');
      const sourceA = writeSource(tempDir, 'source-a', [
        observation(sampleA, true, 'matched'),
        observation(sampleB, false, 'degraded_not_comparable'),
      ]);
      const sourceB = writeSource(tempDir, 'source-b', [
        observation(sampleA, false, 'degraded_not_comparable'),
        observation(sampleB, true, 'matched'),
      ]);
      const outPath = path.join(tempDir, 'composed.ndjson');
      const rawReviewOutPath = path.join(localReviewDir, 'composed.review.json');

      const { stdout } = await execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-compose-legacy-parity-retry-set.ts',
        `--sources=${sourceA},${sourceB}`,
        '--min-samples-per-route=2',
        `--out=${outPath}`,
        `--raw-review-artifact=${rawReviewOutPath}`,
      ], {
        cwd: repoRoot,
        env: { ...process.env, CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret' },
        timeout: CLI_PROCESS_TIMEOUT_MS,
      });

      const result = JSON.parse(stdout) as { rows: number; warning: string };
      expect(result.rows).toBe(2);
      expect(result.warning).toContain('Claude/manual');

      const observationsRaw = readFileSync(outPath, 'utf8');
      expect(observationsRaw).toContain(sampleA);
      expect(observationsRaw).toContain(sampleB);
      expect(observationsRaw).not.toContain('raw legacy answer');
      expect(observationsRaw).not.toContain('private prompt');
      expect(observationsRaw.trim().split(/\r?\n/).map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ sampleHmac: sampleA, matched: true, reasonCode: 'matched' }),
        expect.objectContaining({ sampleHmac: sampleB, matched: true, reasonCode: 'matched' }),
      ]);

      const manifest = JSON.parse(readFileSync(outPath.replace(/\.ndjson$/i, '.manifest.json'), 'utf8')) as {
        retrySelection?: { schemaVersion?: string; independentReviewRequired?: boolean; sourceCount?: number };
        rawPromptOrResponseStored?: boolean;
        rawReviewArtifactContainsRawPromptOrResponse?: boolean;
        samplesPerRoute?: number;
        samplesByRoute?: Record<string, number>;
        distinctPromptsByRoute?: Record<string, number>;
        promptSamplingPolicy?: string;
      };
      expect(manifest.retrySelection).toMatchObject({
        schemaVersion: 'chat_v2_legacy_parity_retry_selection.v1',
        independentReviewRequired: true,
        sourceCount: 2,
      });
      expect(manifest.rawPromptOrResponseStored).toBe(false);
      expect(manifest.rawReviewArtifactContainsRawPromptOrResponse).toBe(true);
      expect(manifest.samplesPerRoute).toBe(2);
      expect(manifest.samplesByRoute).toEqual({ selective_internet_research: 2 });
      expect(manifest.distinctPromptsByRoute).toEqual({ selective_internet_research: 2 });
      expect(manifest.promptSamplingPolicy).toBe('no_repeated_prompts_for_answer_quality_research');

      const reviewRows = JSON.parse(readFileSync(rawReviewOutPath, 'utf8')) as Array<{
        sampleHmac: string;
        requestLanguage: string;
        expectedResponseLanguage: string;
        promptText: string;
        legacyRawResponse: { body: { text: string } };
      }>;
      expect(reviewRows).toHaveLength(2);
      expect(reviewRows[0]).toMatchObject({
        requestLanguage: 'en',
        expectedResponseLanguage: 'en',
      });
      expect(reviewRows[0]?.promptText).toContain('private prompt');
      expect(reviewRows[0]?.legacyRawResponse.body.text).toContain('raw legacy answer');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(localReviewDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('requires the raw review artifact to be explicitly written under .local', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-compose-parity-'));
    try {
      const sourceA = writeSource(tempDir, 'source-a', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ]);
      const sourceB = writeSource(tempDir, 'source-b', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ]);

      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-compose-legacy-parity-retry-set.ts',
        `--sources=${sourceA},${sourceB}`,
        '--min-samples-per-route=2',
        `--out=${path.join(tempDir, 'composed.ndjson')}`,
      ], {
        cwd: repoRoot,
        env: { ...process.env, CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret' },
        timeout: CLI_PROCESS_TIMEOUT_MS,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('missing_raw_review_artifact_path'),
      });

      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-compose-legacy-parity-retry-set.ts',
        `--sources=${sourceA},${sourceB}`,
        '--min-samples-per-route=2',
        `--out=${path.join(tempDir, 'composed.ndjson')}`,
        `--raw-review-artifact=${path.join(tempDir, 'composed.review.json')}`,
      ], {
        cwd: repoRoot,
        env: { ...process.env, CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret' },
        timeout: CLI_PROCESS_TIMEOUT_MS,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('raw_review_artifact_must_be_under_dot_local'),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('rejects source runs with a different sample-HMAC set', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-compose-parity-'));
    const localReviewDir = makeLocalReviewDir();
    try {
      const sourceA = writeSource(tempDir, 'source-a', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ]);
      const sourceB = writeSource(tempDir, 'source-b', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('c'), true, 'matched'),
      ]);

      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-compose-legacy-parity-retry-set.ts',
        `--sources=${sourceA},${sourceB}`,
        '--min-samples-per-route=2',
        `--out=${path.join(tempDir, 'composed.ndjson')}`,
        `--raw-review-artifact=${path.join(localReviewDir, 'composed.review.json')}`,
      ], {
        cwd: repoRoot,
        env: { ...process.env, CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret' },
        timeout: CLI_PROCESS_TIMEOUT_MS,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('source_sample_hmac_set_mismatch'),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(localReviewDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('rejects a retry set when any governed sample never has a comparable match', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-compose-parity-'));
    const localReviewDir = makeLocalReviewDir();
    try {
      const sampleA = sampleHmac('a');
      const sampleB = sampleHmac('b');
      const sourceA = writeSource(tempDir, 'source-a', [
        observation(sampleA, true, 'matched'),
        observation(sampleB, false, 'degraded_not_comparable'),
      ]);
      const sourceB = writeSource(tempDir, 'source-b', [
        observation(sampleA, true, 'matched'),
        observation(sampleB, false, 'degraded_not_comparable'),
      ]);

      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-compose-legacy-parity-retry-set.ts',
        `--sources=${sourceA},${sourceB}`,
        '--min-samples-per-route=2',
        `--out=${path.join(tempDir, 'composed.ndjson')}`,
        `--raw-review-artifact=${path.join(localReviewDir, 'composed.review.json')}`,
      ], {
        cwd: repoRoot,
        env: { ...process.env, CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret' },
        timeout: CLI_PROCESS_TIMEOUT_MS,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('missing_comparable_matched_sample'),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(localReviewDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it('rejects retry sources with different fixture or isolation metadata', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-compose-parity-'));
    const localReviewDir = makeLocalReviewDir();
    try {
      const sourceA = writeSource(tempDir, 'source-a', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ]);
      const sourceB = writeSource(tempDir, 'source-b', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ], {
        isolatePrompts: true,
      });

      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-compose-legacy-parity-retry-set.ts',
        `--sources=${sourceA},${sourceB}`,
        '--min-samples-per-route=2',
        `--out=${path.join(tempDir, 'composed.ndjson')}`,
        `--raw-review-artifact=${path.join(localReviewDir, 'composed.review.json')}`,
      ], {
        cwd: repoRoot,
        env: { ...process.env, CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret' },
        timeout: CLI_PROCESS_TIMEOUT_MS,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining('source_manifest_mismatch:isolatePrompts'),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(localReviewDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);

  it.each([
    {
      name: 'the active v1.5 diagnostic corpus',
      manifestOverrides: {
        routePromptVersion: 'chat_v2_legacy_parity_route_prompts@1.5.0',
        routeCorpusId: 'chatv2_phase7_route_replacement_supported_locales_v2',
        routeCorpusFrozenBeforeImplementation: false,
        routeCorpusProjectionPolicy: 'active_v1_5_diagnostic_only_not_retirement_evidence',
      },
      reason: 'manifest_prompt_version_mismatch',
    },
    {
      name: 'a diagnostic-corpus freeze claim',
      manifestOverrides: { routeCorpusFrozenBeforeImplementation: false },
      reason: 'manifest_corpus_freeze_claim_mismatch',
    },
    {
      name: 'a wrong corpus frozen-at identity',
      manifestOverrides: { routeCorpusFrozenAt: '2026-07-29T00:00:00.000Z' },
      reason: 'manifest_corpus_frozen_at_mismatch',
    },
    {
      name: 'a wrong corpus mutation policy',
      manifestOverrides: { routeCorpusMutationPolicy: 'unreviewed_runtime_replacement_allowed' },
      reason: 'manifest_corpus_mutation_policy_mismatch',
    },
    {
      name: 'a missing corpus mutation policy',
      manifestOverrides: { routeCorpusMutationPolicy: undefined },
      reason: 'manifest_corpus_mutation_policy_mismatch',
    },
    {
      name: 'a wrong corpus projection policy',
      manifestOverrides: { routeCorpusProjectionPolicy: 'active_v1_5_diagnostic_only' },
      reason: 'manifest_corpus_projection_policy_mismatch',
    },
    {
      name: 'a missing corpus projection policy',
      manifestOverrides: { routeCorpusProjectionPolicy: undefined },
      reason: 'manifest_corpus_projection_policy_mismatch',
    },
    {
      name: 'a valid-looking non-current corpus hash',
      manifestOverrides: { routeCorpusSha256: 'c'.repeat(64) },
      reason: 'manifest_corpus_hash_mismatch',
    },
    {
      name: 'a missing request/response language sample identity policy',
      manifestOverrides: { sampleIdentityPolicy: undefined },
      reason: 'manifest_sample_identity_policy_mismatch',
    },
  ])('rejects retry source metadata with $name', async ({ manifestOverrides, reason }) => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-compose-parity-'));
    const localReviewDir = makeLocalReviewDir();
    try {
      const sourceA = writeSource(tempDir, 'source-a', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ], manifestOverrides);
      const sourceB = writeSource(tempDir, 'source-b', [
        observation(sampleHmac('a'), true, 'matched'),
        observation(sampleHmac('b'), true, 'matched'),
      ]);

      await expect(execFileAsync('npx', [
        'tsx',
        'scripts/chatv2-compose-legacy-parity-retry-set.ts',
        `--sources=${sourceA},${sourceB}`,
        '--min-samples-per-route=2',
        `--out=${path.join(tempDir, 'composed.ndjson')}`,
        `--raw-review-artifact=${path.join(localReviewDir, 'composed.review.json')}`,
      ], {
        cwd: repoRoot,
        env: { ...process.env, CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret' },
        timeout: CLI_PROCESS_TIMEOUT_MS,
      })).rejects.toMatchObject({
        stderr: expect.stringContaining(reason),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(localReviewDir, { recursive: true, force: true });
    }
  }, CLI_TEST_TIMEOUT_MS);
});

function writeSource(
  dir: string,
  name: string,
  observations: Array<ReturnType<typeof observation>>,
  manifestOverrides: Record<string, unknown> = {},
): string {
  const observationsPath = path.join(dir, `${name}.ndjson`);
  const manifestPath = path.join(dir, `${name}.manifest.json`);
  const reviewPath = path.join(dir, `${name}.review.json`);
  const payload = observations.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(observationsPath, payload);
  writeFileSync(reviewPath, `${JSON.stringify(observations.map((row, index) => rawReviewRow(row, index)), null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 'chat_v2_legacy_parity_observer_manifest.v1',
    generatedAt: '2026-06-02T00:00:00.000Z',
    evidenceSource: 'runtime_route',
    routePromptVersion: CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.version,
    routeCorpusId: CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.corpusId,
    routeCorpusFrozenAt: CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.frozenAt,
    routeCorpusFrozenBeforeImplementation:
      CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.frozenBeforeImplementation,
    routeCorpusMutationPolicy:
      CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.mutationPolicy,
    routeCorpusProjectionPolicy:
      CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META.projectionPolicy,
    routeCorpusSha256: buildChatV2RetirementObserverCorpusBinding([
      'selective_internet_research',
    ]).routeCorpusSha256,
    reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    comparatorVersion: 'chat_v2_legacy_parity_comparator.v3',
    stateFixtureHash: `sha256:${'e'.repeat(64)}`,
    observationsSha256: createHash('sha256').update(payload).digest('hex'),
    observationRows: observations.length,
    routeIds: ['selective_internet_research'],
    samplesPerRoute: observations.length,
    samplesByRoute: { selective_internet_research: observations.length },
    distinctPromptsByRoute: { selective_internet_research: observations.length },
    promptSamplingPolicy: 'no_repeated_prompts_for_answer_quality_research',
    stateFixtureContract: 'shared_read_only_seeded_snapshot',
    writeFixtureSeeding: null,
    writeRoutes: [],
    isolatePrompts: false,
    runtimeRouteDistinctEndpoints: true,
    legacyEndpointHmac: `hmac:endpoint:${'1'.repeat(64)}`,
    chatV2EndpointHmac: `hmac:endpoint:${'2'.repeat(64)}`,
    rawPromptOrResponseStored: false,
    committedObservationRawPromptOrResponseStored: false,
    rawReviewArtifactLocalOnly: true,
    rawReviewArtifactContainsRawPromptOrResponse: true,
    rawReviewArtifactSchemaVersion: 'chat_v2_legacy_parity_raw_review_row.v1',
    sampleIdentityPolicy: 'route_index_request_language_expected_response_language_v1',
    tokenFilesAreLocalOnly: true,
    ...manifestOverrides,
  }, null, 2)}\n`);
  return observationsPath;
}

function observation(sampleHmacValue: string, matched: boolean, reasonCode: string) {
  return {
    schemaVersion: 'chat_v2_legacy_parity_observation.v1',
    routeId: 'selective_internet_research',
    sampleHmac: sampleHmacValue,
    matched,
    tested: true,
    oldOwner: 'research router',
    replacement: 'ChatV2 read answer planner',
    evaluator: 'runtime_tool',
    evidenceSource: 'runtime_route',
    reasonCode,
  };
}

function rawReviewRow(row: ReturnType<typeof observation>, index: number) {
  return {
    schemaVersion: 'chat_v2_legacy_parity_raw_review_row.v1',
    routeId: row.routeId,
    sampleKey: `selective_internet_research:${index}:request=en:response=en`,
    sampleHmac: row.sampleHmac,
    requestLanguage: 'en',
    expectedResponseLanguage: 'en',
    promptText: `private prompt ${index}`,
    legacyRawResponse: {
      status: row.matched ? 200 : 503,
      body: { text: row.matched ? `raw legacy answer ${index}` : 'provider unavailable' },
    },
    chatV2RawResponse: {
      status: row.matched ? 200 : 503,
      body: { text: row.matched ? `raw chatv2 answer ${index}` : 'provider unavailable' },
    },
    legacyProjection: { actionability: row.matched ? 'answer_only' : 'degraded' },
    chatV2Projection: { actionability: row.matched ? 'answer_only' : 'degraded' },
    comparison: {
      matched: row.matched,
      reasonCodes: row.matched ? [] : ['degraded_not_comparable'],
    },
  };
}

function sampleHmac(seed: string): string {
  return `hmac:legacy-parity:${seed.repeat(64).slice(0, 64)}`;
}

function makeLocalReviewDir(): string {
  mkdirSync(path.join(repoRoot, '.local'), { recursive: true });
  return mkdtempSync(path.join(repoRoot, '.local', 'chatv2-compose-parity-'));
}

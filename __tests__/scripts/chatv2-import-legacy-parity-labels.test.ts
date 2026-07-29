import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
} from '../../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META as CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META,
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS as CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS,
} from '../../src/services/chat-legacy-parity-route-prompts';

const CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION =
  CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.version;

let tempDir: string;
let dbPath: string;
let labelsPath: string;
let signoffPath: string;
let signoffHash: string;
let observationsPath: string;
let manifestPath: string;
let rawReviewArtifactPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-parity-import-'));
  dbPath = path.join(tempDir, 'test.db');
  labelsPath = path.join(tempDir, 'labels.ndjson');
  signoffPath = path.join(tempDir, 'peer-review.md');
  observationsPath = path.join(tempDir, 'observations.ndjson');
  manifestPath = path.join(tempDir, 'observations.manifest.json');
  rawReviewArtifactPath = path.join(tempDir, 'observations.review.json');
  writeFileSync(signoffPath, '# Independent ChatV2 QA\n\nPASS with route parity labels.\n');
  signoffHash = createHash('sha256').update(readFileSync(signoffPath)).digest('hex');
  writeReviewArtifacts('general_action_planner', 50);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('chatv2-import-legacy-parity-labels CLI', () => {
  it('rejects a signed label package that pads the frozen supported-locale projection', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
        `--observations=${observationsPath}`,
        `--manifest=${manifestPath}`,
        `--raw-review-artifact=${rawReviewArtifactPath}`,
        `--db=${dbPath}`,
      ], {
        cwd: path.resolve(__dirname, '../..'),
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        stdio: 'pipe',
      });
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }
    expect(stderr).toContain(
      'review_samples_exceed_frozen_projection:general_action_planner',
    );
  });

  it.each([
    {
      name: 'the unprojected historical v1.4 corpus',
      manifestOverrides: {
        routePromptVersion: 'chat_v2_legacy_parity_route_prompts@1.4.0',
        routeCorpusId: 'chatv2_phase7_route_replacement_heldout',
        routeCorpusSha256: '1'.repeat(64),
      },
      reason: 'review_manifest_route_corpus_id_mismatch',
    },
    {
      name: 'the post-implementation v1.5 diagnostic corpus',
      manifestOverrides: {
        routePromptVersion: 'chat_v2_legacy_parity_route_prompts@1.5.0',
        routeCorpusId: 'chatv2_phase7_route_replacement_supported_locales_v2',
        routeCorpusFrozenBeforeImplementation: false,
        routeCorpusSha256: '1'.repeat(64),
      },
      reason: 'review_manifest_route_prompt_version_mismatch',
    },
    {
      name: 'a valid-looking non-current corpus hash',
      manifestOverrides: {
        routeCorpusSha256: 'c'.repeat(64),
      },
      reason: 'review_manifest_route_corpus_hash_mismatch',
    },
    {
      name: 'a false post-implementation freeze claim',
      manifestOverrides: {
        routeCorpusFrozenBeforeImplementation: false,
      },
      reason: 'review_manifest_corpus_freeze_claim_mismatch',
    },
    {
      name: 'a wrong corpus mutation policy',
      manifestOverrides: {
        routeCorpusMutationPolicy: 'unreviewed_runtime_replacement_allowed',
      },
      reason: 'review_manifest_corpus_mutation_policy_mismatch',
    },
    {
      name: 'a missing corpus mutation policy',
      manifestOverrides: {
        routeCorpusMutationPolicy: undefined,
      },
      reason: 'review_manifest_corpus_mutation_policy_mismatch',
    },
    {
      name: 'a wrong supported-locale projection policy',
      manifestOverrides: {
        routeCorpusProjectionPolicy: 'translated_or_relabelled_rows_allowed',
      },
      reason: 'review_manifest_corpus_projection_policy_mismatch',
    },
    {
      name: 'a missing request/response language sample identity policy',
      manifestOverrides: {
        sampleIdentityPolicy: undefined,
      },
      reason: 'review_manifest_sample_identity_policy_mismatch',
    },
  ])('rejects a signed review manifest for $name', ({ manifestOverrides, reason }) => {
    writeReviewArtifacts('general_action_planner', 50, {
      ...manifestOverrides,
    });
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
        `--observations=${observationsPath}`,
        `--manifest=${manifestPath}`,
        `--raw-review-artifact=${rawReviewArtifactPath}`,
        `--db=${dbPath}`,
      ], {
        cwd: path.resolve(__dirname, '../..'),
        env: {
          ...process.env,
          CHAT_V2_EVIDENCE_HMAC_SECRET: 'test-secret',
        },
        stdio: 'pipe',
      });
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }

    expect(stderr).toContain(reason);
  });

  it('rejects independent labels whose signoff hash does not match the artifact', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'manual',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: 'a'.repeat(64),
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
        `--observations=${observationsPath}`,
        `--manifest=${manifestPath}`,
        `--raw-review-artifact=${rawReviewArtifactPath}`,
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

    expect(stderr).toContain('peer_review_signoff_hash_mismatch:general_action_planner');
  });

  it('rejects runtime_tool labels at the label-import boundary', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 50,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'runtime_tool',
      evidenceSource: 'runtime_route',
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--observations=${observationsPath}`,
        `--manifest=${manifestPath}`,
        `--raw-review-artifact=${rawReviewArtifactPath}`,
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

    expect(stderr).toContain('independent_peer_review_required:general_action_planner');
  });

  it('rejects independent local sandbox seed labels as retirement evidence', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 50,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'local_sandbox_seed',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
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

    expect(stderr).toContain('local_sandbox_seed_not_retirement_evidence:general_action_planner');
  });

  it('rejects independent labels that do not mark the route replaceable and tested', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: false,
      tested: true,
      sampleCount: 50,
      matchingCount: 50,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
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

    expect(stderr).toContain('route_not_replaceable:general_action_planner');
  });

  it('rejects independent labels below the reviewed sample floor', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 49,
      matchingCount: 49,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
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

    expect(stderr).toContain('below_min_reviewed_samples:general_action_planner');
  });

  it('rejects independent labels below the reviewed parity floor', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 47,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
        `--observations=${observationsPath}`,
        `--manifest=${manifestPath}`,
        `--raw-review-artifact=${rawReviewArtifactPath}`,
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

    expect(stderr).toContain('below_min_reviewed_parity:general_action_planner');
  });

  it('rejects independent runtime labels without complete matching observation artifacts', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
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

    expect(stderr).toContain('missing_review_observations_artifact');
  });

  it('rejects independent runtime labels without the local raw review artifact', () => {
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId: 'general_action_planner',
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
        `--observations=${observationsPath}`,
        `--manifest=${manifestPath}`,
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

    expect(stderr).toContain('missing_raw_review_artifact');
  });

  it('rejects labels when the observation manifest row count does not match the reviewed artifact', () => {
    const routeId = 'chat_message_shortcut_after_route';
    writeReviewArtifacts(routeId, 49);
    writeFileSync(labelsPath, JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_label.v1',
      routeId,
      replaced: true,
      tested: true,
      sampleCount: 50,
      matchingCount: 49,
      oldOwner: 'chat-action-planner.ts',
      replacement: 'ChatV2 command preview',
      evaluator: 'claude',
      evidenceSource: 'runtime_route',
      peerReviewSignoffHash: signoffHash,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
      reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    }));

    const repoRoot = path.resolve(__dirname, '../..');
    let stderr = '';
    try {
      execFileSync('npx', [
        'tsx',
        'scripts/chatv2-import-legacy-parity-labels.ts',
        '--write',
        `--labels=${labelsPath}`,
        `--peer-review-signoff=${signoffPath}`,
      `--observations=${observationsPath}`,
      `--manifest=${manifestPath}`,
      `--raw-review-artifact=${rawReviewArtifactPath}`,
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

    expect(stderr).toContain(`review_sample_count_mismatch:${routeId}`);
  });
});

function writeReviewArtifacts(
  routeId: string,
  sampleCount: number,
  manifestOverrides: Record<string, unknown> = {},
): void {
  const rows = Array.from({ length: sampleCount }, (_, index) => ({
    schemaVersion: 'chat_v2_legacy_parity_observation.v1',
    routeId,
    sampleHmac: runtimeSampleHmac(routeId, index, 'en', 'en'),
    matched: index !== sampleCount - 1,
    tested: true,
    oldOwner: 'chat-action-planner.ts',
    replacement: 'ChatV2 command preview',
    evaluator: 'runtime_tool',
    evidenceSource: 'runtime_route',
    reasonCode: index === sampleCount - 1 ? 'safe_mismatch' : 'match',
  }));
  const payload = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(observationsPath, payload);
  writeFileSync(rawReviewArtifactPath, JSON.stringify(rows.map((row, index) => ({
    schemaVersion: 'chat_v2_legacy_parity_raw_review_row.v1',
    routeId: row.routeId,
    sampleKey: runtimeSampleKey(routeId, index, 'en', 'en'),
    sampleHmac: row.sampleHmac,
    requestLanguage: 'en',
    expectedResponseLanguage: 'en',
    promptText: `Prompt ${index}`,
    legacyRawResponse: {
      status: 200,
      body: { text: `Legacy response ${index}` },
    },
    chatV2RawResponse: {
      status: 200,
      body: { text: `ChatV2 response ${index}` },
    },
    legacyProjection: {
      schemaVersion: 'chat_v2_legacy_parity_projection.v1',
      routeId,
      owner: 'tasks',
      routeMethod: 'legacy',
      capabilityFamily: 'tasks',
      actionability: 'write_preview',
      verificationStatus: 'unknown',
      cardKind: 'action_preview',
      requiresConfirmation: true,
      hasVisibleDiff: true,
      hasCommandEnvelope: true,
      observedRouteIds: [routeId],
    },
    chatV2Projection: {
      schemaVersion: 'chat_v2_legacy_parity_projection.v1',
      routeId,
      owner: 'tasks',
      routeMethod: 'chat-core-v2-command-preview',
      capabilityFamily: 'tasks',
      actionability: 'write_preview',
      verificationStatus: 'pending',
      cardKind: 'action_preview',
      requiresConfirmation: true,
      hasVisibleDiff: true,
      hasCommandEnvelope: true,
      observedRouteIds: [routeId],
    },
    comparison: {
      matched: row.matched,
      reasonCodes: row.matched ? [] : [row.reasonCode],
    },
  })), null, 2));
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
    comparatorVersion: 'chat_v2_legacy_parity_comparator.v2',
    stateFixtureHash: `sha256:${'d'.repeat(64)}`,
    sampleIdentityPolicy: 'route_index_request_language_expected_response_language_v1',
    observationRows: sampleCount,
    routeIds: [routeId],
    observationsSha256: createHash('sha256').update(payload).digest('hex'),
    ...manifestOverrides,
  }));
}

function runtimeSampleKey(
  routeId: string,
  index: number,
  requestLanguage: string,
  expectedResponseLanguage: string,
): string {
  return `${routeId}:${index}:request=${requestLanguage}:response=${expectedResponseLanguage}`;
}

function runtimeSampleHmac(
  routeId: string,
  index: number,
  requestLanguage: string,
  expectedResponseLanguage: string,
): string {
  const sampleKey = runtimeSampleKey(routeId, index, requestLanguage, expectedResponseLanguage);
  return `hmac:legacy-parity:${createHmac('sha256', 'test-secret')
    .update(`runtime_route:${routeId}:${sampleKey}`)
    .digest('hex')}`;
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

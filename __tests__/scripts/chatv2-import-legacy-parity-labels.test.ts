import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
} from '../../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META,
  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION,
} from '../../src/services/chat-legacy-parity-route-prompts';

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
  it('binds independent labels to the actual peer-review signoff artifact hash', () => {
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
    const output = execFileSync('npx', [
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
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = JSON.parse(output) as { importedRows: number; peerReviewSignoffHash?: string };
    expect(result.importedRows).toBe(1);
    expect(result.peerReviewSignoffHash).toBe(signoffHash);

    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT safe_metadata_json FROM chat_v2_legacy_retirement_evidence').get() as {
        safe_metadata_json: string;
      };
      expect(JSON.parse(row.safe_metadata_json)).toMatchObject({
        evaluator: 'claude',
        peerReviewSignoffHash: signoffHash,
        safetyRegressionCount: 0,
        parityLabelImport: true,
        reviewCompletenessChecked: true,
        rawReviewArtifactCompletenessChecked: true,
      });
    } finally {
      db.close();
    }
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
    writeReviewArtifacts('general_action_planner', 49);
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

    expect(stderr).toContain('review_sample_count_mismatch:general_action_planner');
  });
});

function writeReviewArtifacts(routeId: string, sampleCount: number): void {
  const rows = Array.from({ length: sampleCount }, (_, index) => ({
    schemaVersion: 'chat_v2_legacy_parity_observation.v1',
    routeId,
    sampleHmac: `hmac:legacy-parity:${String(index).padStart(64, 'a').slice(0, 64)}`,
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
    sampleKey: `${routeId}:${index}:en`,
    sampleHmac: row.sampleHmac,
    language: 'en',
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
    routeCorpusFrozenBeforeImplementation: true,
    routeCorpusSha256: 'c'.repeat(64),
    reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    comparatorVersion: 'chat_v2_legacy_parity_comparator.v2',
    stateFixtureHash: `sha256:${'d'.repeat(64)}`,
    observationRows: sampleCount,
    routeIds: [routeId],
    observationsSha256: createHash('sha256').update(payload).digest('hex'),
  }));
}

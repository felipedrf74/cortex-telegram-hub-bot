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

  it('imports an explicitly scoped single-route runtime observation set without claiming full retirement', () => {
    const output = execFileSync('npx', [
      'tsx',
      'scripts/chatv2-import-legacy-parity-observations.ts',
      '--write',
      `--observations=${observationsPath}`,
      `--manifest=${manifestPath}`,
      '--qa-review-id=runtime-tool-research-scope',
      '--routes=selective_internet_research',
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

    const result = JSON.parse(output) as {
      acceptedRoutes: Array<{ routeId: string; sampleCount: number; matchingCount: number }>;
      routeScope: string[];
    };
    expect(result.routeScope).toEqual(['selective_internet_research']);
    expect(result.acceptedRoutes).toEqual([
      expect.objectContaining({
        routeId: 'selective_internet_research',
        sampleCount: 50,
        matchingCount: 50,
      }),
    ]);

    const db = new Database(dbPath);
    try {
      const rows = db.prepare('SELECT route_id, safe_metadata_json FROM chat_v2_legacy_retirement_evidence').all() as Array<{
        route_id: string;
        safe_metadata_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.route_id).toBe('selective_internet_research');
	      const metadata = JSON.parse(rows[0]!.safe_metadata_json);
	      expect(metadata).toMatchObject({
	        parityObservationImport: true,
	        routeScopedObservationImport: true,
	        routeScope: ['selective_internet_research'],
	        evaluator: 'runtime_tool',
	      });
	      expect(metadata).not.toHaveProperty('parityLabelImport');
    } finally {
      db.close();
    }
  });

  it('does not delete independently signed label rows when replacing scoped runtime observations', () => {
    runScopedImport();

    const db = new Database(dbPath);
    try {
      db.prepare(`
        INSERT INTO chat_v2_legacy_retirement_evidence (
          evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
          route_id, replaced, tested, shadow_parity_rate, route_sample_count,
          raw_field_audit_count, safe_metadata_json
        ) VALUES (
          'runtime_route', 'route_exit', 'signed-label-review', ?, 'hmac',
          'selective_internet_research', 0, 1, 0, 50,
          0, ?
        )
      `).run(
        `hmac:legacy-route:${'9'.repeat(64)}`,
        JSON.stringify({
          schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
          parityLabelImport: true,
          evaluator: 'claude',
          peerReviewSignoffHash: 'a'.repeat(64),
          safetyRegressionCount: 1,
          qualityRegressionCount: 0,
          degradedNotComparableCount: 0,
          reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
        }),
      );
    } finally {
      db.close();
    }

    runScopedImport('--replace-route-labels');

    const verifyDb = new Database(dbPath);
    try {
      const rows = verifyDb.prepare(`
        SELECT safe_metadata_json FROM chat_v2_legacy_retirement_evidence
        WHERE route_id = 'selective_internet_research'
        ORDER BY id ASC
      `).all() as Array<{ safe_metadata_json: string }>;
      const metadata = rows.map((row) => JSON.parse(row.safe_metadata_json));
      expect(metadata.filter((row) => row.parityObservationImport === true)).toHaveLength(1);
      expect(metadata.filter((row) => row.parityLabelImport === true)).toEqual([
        expect.objectContaining({
          evaluator: 'claude',
          peerReviewSignoffHash: 'a'.repeat(64),
          safetyRegressionCount: 1,
        }),
      ]);
    } finally {
      verifyDb.close();
    }
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
  const rows = Array.from({ length: sampleCount }, (_, index) => ({
    schemaVersion: 'chat_v2_legacy_parity_observation.v1',
    routeId,
    sampleHmac: `hmac:legacy-parity:${String(index).padStart(64, 'a').slice(0, 64)}`,
    matched: true,
    tested: true,
    oldOwner: 'research router',
    replacement: 'ChatV2 read/answer planner evidence policy',
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
    routeCorpusFrozenBeforeImplementation: true,
    routeCorpusSha256: 'c'.repeat(64),
    reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
    comparatorVersion: 'chat_v2_legacy_parity_comparator.v3',
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

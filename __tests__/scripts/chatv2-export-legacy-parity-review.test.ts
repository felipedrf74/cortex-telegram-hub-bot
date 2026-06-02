import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let tempDir: string;
let dbPath: string;
let inventoryPath: string;
let outPath: string;
const PEER_REVIEW_SIGNOFF_HASH = 'd'.repeat(64);

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-parity-export-'));
  dbPath = path.join(tempDir, 'test.db');
  inventoryPath = path.join(tempDir, 'inventory.md');
  outPath = path.join(tempDir, 'review.json');

  const repoRoot = path.resolve(__dirname, '../..');
  const db = new Database(dbPath);
  db.exec(readFileSync(path.join(repoRoot, 'migrations/160_chatv2_legacy_retirement_evidence.sql'), 'utf8'));
  db.prepare(`
    INSERT INTO chat_v2_legacy_retirement_evidence (
      evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
      route_id, replaced, tested, shadow_parity_rate, route_sample_count,
      legacy_fallback_rate_24h, full_verify_clean, raw_field_audit_count,
      safe_metadata_json
    ) VALUES ('runtime_route', 'route_exit', 'review-import', 'hmac:sample:${'a'.repeat(64)}', 'hmac',
      'general_action_planner', 1, 1, 0.98, 50, NULL, NULL, 0, ?)
  `).run(JSON.stringify({
    schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
    parityLabelVersion: 'chat_v2_legacy_parity_label.v1',
    parityLabelImport: true,
    evaluator: 'manual',
    peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
    matchingCount: 49,
    sampleCount: 50,
    parityRate: 0.98,
    safetyRegressionCount: 0,
    qualityRegressionCount: 0,
    degradedNotComparableCount: 0,
    reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
  }));
  db.close();

  writeFileSync(inventoryPath, [
    '| Route Exit | Current Owner | Can Answer | Can Execute | External Effect | Keep Pre-ChatV2 | Planned Replacement |',
    '|---|---|---|---|---|---|---|',
    '| General Action Planner | chat-action-planner.ts | yes | yes | possible | no | ChatV2 command preview/write gateway |',
  ].join('\n'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('chatv2-export-legacy-parity-review CLI', () => {
  it('reports imported parity labels instead of treating coverage as parity proof', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/chatv2-export-legacy-parity-review.ts --db="${dbPath}" --inventory="${inventoryPath}" --out="${outPath}"`,
      { stdio: 'pipe' },
    );

    expect(existsSync(outPath)).toBe(true);
    const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
      rows: Array<{
        routeId: string;
        parityBlocker: { blocked: boolean; reason: string };
        importedParityLabel: null | {
          sampleCount: number;
          matchingCount: number;
          shadowParityRate: number;
          evaluator: string;
          peerReviewSignoffHash?: string;
        };
      }>;
    };
    const row = report.rows.find((item) => item.routeId === 'general_action_planner');
    expect(row).toBeDefined();
    expect(row?.parityBlocker).toMatchObject({
      blocked: false,
      reason: 'reviewed_parity_label_passed',
    });
    expect(row?.importedParityLabel).toMatchObject({
      sampleCount: 50,
      matchingCount: 49,
      shadowParityRate: 0.98,
      evaluator: 'manual',
      peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
    });
  });

  it('blocks self-attested runtime parity labels even when sample counts pass', () => {
    const db = new Database(dbPath);
    try {
      db.prepare('UPDATE chat_v2_legacy_retirement_evidence SET safe_metadata_json = ? WHERE route_id = ?').run(
        JSON.stringify({
          schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
          parityLabelVersion: 'chat_v2_legacy_parity_label.v1',
          parityLabelImport: true,
          evaluator: 'runtime_tool',
          matchingCount: 49,
          sampleCount: 50,
          parityRate: 0.98,
          safetyRegressionCount: 0,
          qualityRegressionCount: 0,
          degradedNotComparableCount: 0,
          reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
        }),
        'general_action_planner',
      );
    } finally {
      db.close();
    }

    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/chatv2-export-legacy-parity-review.ts --db="${dbPath}" --inventory="${inventoryPath}" --out="${outPath}"`,
      { stdio: 'pipe' },
    );

    const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
      rows: Array<{
        routeId: string;
        parityBlocker: { blocked: boolean; reason: string };
      }>;
    };
    const row = report.rows.find((item) => item.routeId === 'general_action_planner');
    expect(row?.parityBlocker).toMatchObject({
      blocked: true,
      reason: 'missing_independent_peer_review',
    });
  });

  it('reports independently reviewed low-parity labels as below-threshold instead of insufficient samples', () => {
    const db = new Database(dbPath);
    try {
      db.prepare(`
        UPDATE chat_v2_legacy_retirement_evidence
        SET shadow_parity_rate = ?, safe_metadata_json = ?
        WHERE route_id = ?
      `).run(
        0.76,
        JSON.stringify({
          schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
          parityLabelVersion: 'chat_v2_legacy_parity_label.v1',
          parityLabelImport: true,
          evaluator: 'claude',
          peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
          matchingCount: 38,
          sampleCount: 50,
          parityRate: 0.76,
          safetyRegressionCount: 0,
          qualityRegressionCount: 0,
          degradedNotComparableCount: 0,
          reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
        }),
        'general_action_planner',
      );
    } finally {
      db.close();
    }

    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/chatv2-export-legacy-parity-review.ts --db="${dbPath}" --inventory="${inventoryPath}" --out="${outPath}"`,
      { stdio: 'pipe' },
    );

    const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
      rows: Array<{
        routeId: string;
        parityBlocker: { blocked: boolean; reason: string; missingRuntimeSamples: number };
      }>;
    };
    const row = report.rows.find((item) => item.routeId === 'general_action_planner');
    expect(row?.parityBlocker).toMatchObject({
      blocked: true,
      reason: 'reviewed_parity_below_threshold',
      missingRuntimeSamples: 0,
    });
  });

  it('reports independently reviewed non-replaceable labels instead of insufficient samples', () => {
    const db = new Database(dbPath);
    try {
      db.prepare(`
        UPDATE chat_v2_legacy_retirement_evidence
        SET replaced = 0, safe_metadata_json = ?
        WHERE route_id = ?
      `).run(
        JSON.stringify({
          schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
          parityLabelVersion: 'chat_v2_legacy_parity_label.v1',
          parityLabelImport: true,
          evaluator: 'claude',
          peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
          matchingCount: 5,
          sampleCount: 50,
          parityRate: 0.1,
          safetyRegressionCount: 0,
          qualityRegressionCount: 0,
          degradedNotComparableCount: 0,
          reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
        }),
        'general_action_planner',
      );
    } finally {
      db.close();
    }

    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/chatv2-export-legacy-parity-review.ts --db="${dbPath}" --inventory="${inventoryPath}" --out="${outPath}"`,
      { stdio: 'pipe' },
    );

    const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
      rows: Array<{
        routeId: string;
        parityBlocker: { blocked: boolean; reason: string; missingRuntimeSamples: number };
      }>;
    };
    const row = report.rows.find((item) => item.routeId === 'general_action_planner');
    expect(row?.parityBlocker).toMatchObject({
      blocked: true,
      reason: 'reviewed_route_not_replaceable',
      missingRuntimeSamples: 0,
    });
  });
});

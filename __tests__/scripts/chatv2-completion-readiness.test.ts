import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { buildChatShadowSampleEvidenceHash, type ChatShadowGateSample } from '../../src/services/chat-shadow-gate-readiness';
import { CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS } from '../../src/services/chat-legacy-parity-route-prompts';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'chatv2-readiness-'));
  dbPath = path.join(tempDir, 'test.db');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('chatv2-completion-readiness CLI', () => {
  it('keeps Spanish shadow evidence hash binding consistent with the recorder', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const db = new Database(dbPath);
    try {
      db.exec(readFileSync(path.join(repoRoot, 'migrations/155_chatv2_completion_evidence.sql'), 'utf8'));
      db.exec(readFileSync(path.join(repoRoot, 'migrations/156_chatv2_completion_evidence_source.sql'), 'utf8'));
      const insertShadow = db.prepare(`
        INSERT INTO chat_v2_completion_evidence (
          evidence_source, evidence_kind, tenant_id, user_id, request_id, message_hmac,
          message_identifier_kind, locale, candidate_capabilities_json, final_capability_id,
          schema_valid_after_repair, candidate_evidence_hash, route_owner, route_method,
          response_contract_valid, raw_field_audit_count, safe_metadata_json
        ) VALUES (
          'runtime_route', 'shadow', 1, 2, ?, ?, 'hmac', ?, ?, ?,
          1, ?, 'chatv2', 'chat-core-v2-local-llm', 1, 0, '{}'
        )
      `);
      const languages = ['en', 'pt-BR', 'pt-PT', 'mixed', 'es'] as const;
      for (let index = 0; index < 50; index += 1) {
        const language = languages[index % languages.length]!;
        const sample: ChatShadowGateSample = {
          sampleId: `hmac:message:${String(index).padStart(2, '0')}:${'a'.repeat(64)}`,
          language,
          candidateCapabilities: ['general.help', 'chat.answer'],
          finalCapabilityId: 'chat.answer',
          schemaValidAfterRepair: true,
          messageIdentifierKind: 'hmac',
          storedRawMessageText: false,
          unsafeRawFieldCount: 0,
        };
        insertShadow.run(
          `request-${index}`,
          sample.sampleId,
          language,
          JSON.stringify(sample.candidateCapabilities),
          sample.finalCapabilityId,
          buildChatShadowSampleEvidenceHash(sample),
        );
      }
    } finally {
      db.close();
    }

    const output = execFileSync('npx', [
      'tsx',
      'scripts/chatv2-completion-readiness.ts',
      `--db=${dbPath}`,
      '--limit=1000',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const report = JSON.parse(output) as {
      shadow: {
        gates: Array<{ gateId: string; passed: boolean; observed: number }>;
      };
    };
    expect(report.shadow.gates.find((gate) => gate.gateId === 'shadow_candidate_evidence_binding')).toMatchObject({
      passed: true,
      observed: 0,
    });
  });

  it('fails closed when route peer metadata is malformed even if route counts pass', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const db = new Database(dbPath);
    try {
      db.exec(readFileSync(path.join(repoRoot, 'migrations/160_chatv2_legacy_retirement_evidence.sql'), 'utf8'));
      const signoffHash = 'c'.repeat(64);
      const insertRoute = db.prepare(`
        INSERT INTO chat_v2_legacy_retirement_evidence (
          evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
          route_id, replaced, tested, shadow_parity_rate, route_sample_count,
          raw_field_audit_count, safe_metadata_json
        ) VALUES ('runtime_route', 'route_exit', ?, ?, 'hmac', ?, 1, 1, 0.98, 55, 0, ?)
      `);
      for (const [index, route] of CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.entries()) {
        insertRoute.run(
          `request-${index}`,
          `hmac:route:${String(index).padStart(2, '0')}:${'a'.repeat(64)}`,
          route.routeId,
          index === 0
            ? '{"evaluator":'
            : JSON.stringify({
              schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
              evaluator: 'claude',
              peerReviewSignoffHash: signoffHash,
              safetyRegressionCount: 0,
              qualityRegressionCount: 0,
              degradedNotComparableCount: 0,
            }),
        );
      }
      db.prepare(`
        INSERT INTO chat_v2_legacy_retirement_evidence (
          evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
          legacy_fallback_rate_24h, raw_field_audit_count, safe_metadata_json
        ) VALUES ('runtime_route', 'fallback_rate', 'fallback-rate', ?, 'hmac', 0.01, 0, '{}')
      `).run(`hmac:fallback:${'b'.repeat(64)}`);
      db.prepare(`
        INSERT INTO chat_v2_legacy_retirement_evidence (
          evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
          full_verify_clean, raw_field_audit_count, safe_metadata_json
        ) VALUES ('runtime_route', 'verify_run', 'verify-run', ?, 'hmac', 1, 0, '{}')
      `).run(`hmac:verify:${'d'.repeat(64)}`);
    } finally {
      db.close();
    }

    const output = execFileSync('npx', [
      'tsx',
      'scripts/chatv2-completion-readiness.ts',
      `--db=${dbPath}`,
      '--limit=1000',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const report = JSON.parse(output) as {
      legacyRetirement: {
        gates: Array<{ gateId: string; passed: boolean; observed: number; reasonCode?: string }>;
      };
      legacyRetirementBlockers: {
        routeBlockers: Array<{ routeId: string; reasonCode: string }>;
      };
    };
    const peerReviewGate = report.legacyRetirement.gates.find((gate) =>
      gate.gateId === 'route_independent_peer_review',
    );
    expect(peerReviewGate).toMatchObject({
      passed: false,
      observed: 1,
      reasonCode: 'missing_independent_peer_review',
    });
    expect(report.legacyRetirementBlockers.routeBlockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routeId: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS[0]!.routeId,
        reasonCode: 'missing_independent_peer_review',
      }),
    ]));
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { buildChatShadowSampleEvidenceHash, type ChatShadowGateSample } from '../../src/services/chat-shadow-gate-readiness';
import {
  CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
} from '../../src/services/chat-v2-completion-evidence';
import {
  CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
  CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
} from '../../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS as CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS,
} from '../../src/services/chat-legacy-parity-route-prompts';
import { buildChatV2CompletionReadinessReport } from '../../scripts/chatv2-completion-readiness';

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
  it('rejects copied corpus bindings without complete importer provenance', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const db = new Database(dbPath);
    try {
      db.exec(readFileSync(path.join(repoRoot, 'migrations/160_chatv2_legacy_retirement_evidence.sql'), 'utf8'));
      const insertRoute = db.prepare(`
        INSERT INTO chat_v2_legacy_retirement_evidence (
          evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
          route_id, replaced, tested, shadow_parity_rate, route_sample_count,
          raw_field_audit_count, safe_metadata_json
        ) VALUES ('runtime_route', 'route_exit', ?, ?, 'hmac', ?, 1, 1, 0.98, 55, 0, ?)
      `);
      for (const [index, route] of CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.entries()) {
        insertRoute.run(
          `binding-request-${index}`,
          `hmac:route:${String(index).padStart(2, '0')}:${'e'.repeat(64)}`,
          route.routeId,
          JSON.stringify({
            schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
            parityLabelImport: true,
            evaluator: 'claude',
            peerReviewSignoffHash: 'c'.repeat(64),
            safetyRegressionCount: 0,
            qualityRegressionCount: 0,
            degradedNotComparableCount: 0,
            ...CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
          }),
        );
      }

      const current = buildChatV2CompletionReadinessReport(db, { limit: 1000 });
      expect(current.evidenceContract).toEqual({
        retirementObserverCorpusBinding: CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
        responseLocaleEvidenceVersion: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
      });
      expect(current.legacyRetirement.gates.find((gate) => gate.gateId === 'route_exit_replacements'))
        .toMatchObject({
          passed: false,
          observed: 9,
          reasonCode: 'missing_route_exit_samples',
        });

      const firstRouteId = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS[0]!.routeId;
      db.prepare(`
        UPDATE chat_v2_legacy_retirement_evidence
        SET safe_metadata_json = ?
        WHERE route_id = ?
      `).run(JSON.stringify({
        schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
        parityLabelImport: true,
        evaluator: 'claude',
        peerReviewSignoffHash: 'c'.repeat(64),
        safetyRegressionCount: 0,
        qualityRegressionCount: 0,
        degradedNotComparableCount: 0,
        ...CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
        routePromptVersion: 'chat_v2_legacy_parity_route_prompts@1.4.0',
        routeCorpusId: 'chatv2_phase7_route_replacement_heldout',
      }), firstRouteId);
      const historical = buildChatV2CompletionReadinessReport(db, { limit: 1000 });
      expect(historical.legacyRetirement.gates.find((gate) => gate.gateId === 'route_exit_replacements'))
        .toMatchObject({
          passed: false,
          observed: 9,
          reasonCode: 'missing_route_exit_samples',
        });

      db.prepare(`
        UPDATE chat_v2_legacy_retirement_evidence
        SET safe_metadata_json = ?
        WHERE route_id = ?
      `).run(JSON.stringify({
        schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
        parityLabelImport: true,
        evaluator: 'claude',
        peerReviewSignoffHash: 'c'.repeat(64),
        safetyRegressionCount: 0,
        qualityRegressionCount: 0,
        degradedNotComparableCount: 0,
      }), firstRouteId);
      const missing = buildChatV2CompletionReadinessReport(db, { limit: 1000 });
      expect(missing.legacyRetirement.gates.find((gate) => gate.gateId === 'route_exit_replacements'))
        .toMatchObject({
          passed: false,
          observed: 9,
          reasonCode: 'missing_route_exit_samples',
        });
    } finally {
      db.close();
    }
  });

  it('keeps historical Spanish rows auditable without letting them satisfy current supported-locale gates', () => {
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
          1, ?, 'chatv2', 'chat-core-v2-local-llm', 1, 0, ?
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
          language === 'es' && index === 4
            ? 'f'.repeat(64)
            : buildChatShadowSampleEvidenceHash(sample),
          language === 'es'
            ? '{}'
            : JSON.stringify({
              responseLocaleEvidence: {
                version: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
                effectiveLocale: language === 'mixed' ? 'en' : language,
              },
            }),
        );
      }
      for (const [index, language] of ['en', 'mixed'].entries()) {
        const sample: ChatShadowGateSample = {
          sampleId: `hmac:legacy-language:${String(index).padStart(2, '0')}:${'d'.repeat(64)}`,
          language: language as 'en' | 'mixed',
          candidateCapabilities: ['general.help', 'chat.answer'],
          finalCapabilityId: 'chat.answer',
          schemaValidAfterRepair: true,
          messageIdentifierKind: 'hmac',
          storedRawMessageText: false,
          unsafeRawFieldCount: 0,
        };
        insertShadow.run(
          `legacy-language-request-${index}`,
          sample.sampleId,
          language,
          JSON.stringify(sample.candidateCapabilities),
          sample.finalCapabilityId,
          buildChatShadowSampleEvidenceHash(sample),
          '{}',
        );
      }
      const insertAnswerCanary = db.prepare(`
        INSERT INTO chat_v2_completion_evidence (
          evidence_source, evidence_kind, tenant_id, user_id, request_id, message_hmac,
          message_identifier_kind, locale, candidate_capabilities_json, final_capability_id,
          schema_valid_after_repair, candidate_evidence_hash, route_owner, route_method,
          response_contract_valid, answer_accepted, unsupported_claim_caught,
          first_progress_ms, leaked_raw_private_field, composition_mode,
          raw_field_audit_count, safe_metadata_json
        ) VALUES (
          'runtime_route', 'answer_canary', 1, 2, ?, ?, 'hmac', 'es-419', '[]', NULL,
          1, ?, 'chatv2', 'chat-core-v2-local-llm',
          1, 1, 1, 100, 0, 'templated', 0, '{}'
        )
      `);
      for (let index = 0; index < 10; index += 1) {
        insertAnswerCanary.run(
          `answer-request-${index}`,
          `hmac:answer:${String(index).padStart(2, '0')}:${'b'.repeat(64)}`,
          'c'.repeat(64),
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
        gates: Array<{ gateId: string; passed: boolean; sampleCount: number; observed: number }>;
        languageResults: Array<{ language: string; total: number }>;
      };
      answerCanary: {
        gates: Array<{ gateId: string; passed: boolean; sampleCount: number; observed: number }>;
        languageResults: Array<{ language: string; total: number }>;
      };
      historicalLocaleEvidence: {
        schemaVersion: string;
        spanish: {
          excludedFromCurrentGates: boolean;
          shadowRowsAvailable: number;
          shadowRowsAudited: number;
          answerCanaryRowsAvailable: number;
          candidateEvidenceHashValidRows: number;
          candidateEvidenceHashInvalidRows: number;
        };
        responseLocaleAttribution: {
          currentVersion: string;
          excludedPreVersionRows: boolean;
          shadowRowsAvailable: number;
          answerCanaryRowsAvailable: number;
        };
      };
    };
    expect(report.shadow.gates.find((gate) => gate.gateId === 'shadow_candidate_evidence_binding')).toMatchObject({
      passed: true,
      sampleCount: 40,
      observed: 0,
    });
    expect(report.shadow.gates.find((gate) => gate.gateId === 'shadow_row_floor')).toMatchObject({
      passed: false,
      sampleCount: 40,
      observed: 40,
    });
    expect(report.shadow.languageResults.find((row) => row.language === 'en')).toMatchObject({
      total: 10,
    });
    expect(report.answerCanary.languageResults.find((row) => row.language === 'en')).toMatchObject({
      total: 0,
    });
    expect(report.answerCanary.gates.find((gate) => gate.gateId === 'answer_acceptance_by_language'))
      .toMatchObject({
        passed: false,
        sampleCount: 0,
        observed: 0,
      });
    expect(report.historicalLocaleEvidence).toEqual({
      schemaVersion: 'chat_v2_historical_locale_evidence_audit.v1',
      spanish: {
        excludedFromCurrentGates: true,
        shadowRowsAvailable: 10,
        shadowRowsAudited: 10,
        answerCanaryRowsAvailable: 10,
        candidateEvidenceHashValidRows: 9,
        candidateEvidenceHashInvalidRows: 1,
      },
      responseLocaleAttribution: {
        currentVersion: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
        excludedPreVersionRows: true,
        shadowRowsAvailable: 2,
        answerCanaryRowsAvailable: 0,
      },
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
        ) VALUES ('runtime_route', 'route_exit', ?, ?, 'hmac', ?, 1, 1, 0.98, 50, 0, ?)
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
              parityLabelImport: true,
              evaluator: 'claude',
              peerReviewSignoffHash: signoffHash,
              safetyRegressionCount: 0,
              qualityRegressionCount: 0,
              degradedNotComparableCount: 0,
              sampleCount: 50,
              matchingCount: 49,
              parityRate: 0.98,
              observedRouteSampleCount: 50,
              reviewRubricVersion: CHAT_V2_LEGACY_PARITY_REVIEW_RUBRIC_VERSION,
              reviewCompletenessChecked: true,
              rawReviewArtifactCompletenessChecked: true,
              observerManifestSha256: 'e'.repeat(64),
              observerObservationsSha256: 'f'.repeat(64),
              rawReviewArtifactSha256: 'a'.repeat(64),
              ...CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
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
      reasonCode: 'missing_required_route_exit_samples',
    });
    expect(report.legacyRetirementBlockers.routeBlockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routeId: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS[0]!.routeId,
        reasonCode: 'missing_old_vs_chatv2_match_labels',
      }),
    ]));
  });
});

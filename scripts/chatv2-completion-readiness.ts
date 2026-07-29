#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {
  buildChatShadowSampleEvidenceHash,
  evaluateChatShadowGateReadiness,
  type ChatShadowGateSample,
  type NexusChatShadowLanguage,
} from '../src/services/chat-shadow-gate-readiness';
import {
  evaluateChatAnswerCanaryExit,
  type ChatAnswerCanaryEvaluationInput,
} from '../src/services/chat-answer-canary-exit';
import {
  evaluateChatDeterministicReadReadiness,
  type ChatDeterministicReadReadinessInput,
  type ChatDeterministicReadSurface,
} from '../src/services/chat-deterministic-read-readiness';
import {
  evaluateChatWriteReadiness,
  type ChatWriteReadinessInput,
  type ChatWriteReadinessPhase,
  type ChatWriteRiskClass,
  type ChatWriteVerificationStatus,
} from '../src/services/chat-write-readiness';
import {
  evaluateChatCloudAllowlistReadiness,
  type ChatCloudAllowlistReadinessInput,
} from '../src/services/chat-cloud-allowlist-readiness';
import {
  evaluateChatLegacyRetirementReadiness,
  type ChatLegacyRetirementReadinessInput,
} from '../src/services/chat-legacy-retirement-readiness';
import {
  CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
  currentChatV2ResponseLocaleEvidenceSql,
} from '../src/services/chat-v2-completion-evidence';
import {
  CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
  validateCurrentChatV2LegacyRetirementEvidenceRow,
} from '../src/services/chat-legacy-parity-labels';
import {
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS,
} from '../src/services/chat-legacy-parity-route-prompts';
import type { NexusAnswerCompositionMode } from '../src/services/chat-final-answer-composer';

dotenv.config({ quiet: true });

const PHASE7_REQUIRED_ROUTE_IDS =
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS.map((route) => route.routeId);

export interface BuildChatV2CompletionReadinessReportOptions {
  limit?: number;
  evidenceSources?: readonly ChatV2ReadinessEvidenceSource[];
  /** Informational only — recorded in the report for provenance. */
  dbPath?: string;
}

/**
 * Builds the readiness artifact consumed by the chat-quality dashboard and
 * weekly digest (loadChatV2ReadinessReportFromFile requires exactly this
 * `chat_v2_completion_readiness_report*` schema — pinned by the contract test
 * in __tests__/services/chatv2-readiness-alerts.test.ts). The CLI below is a
 * thin wrapper; import this function instead of spawning the script.
 */
export function buildChatV2CompletionReadinessReport(
  db: Database.Database,
  options: BuildChatV2CompletionReadinessReportOptions = {},
) {
  const limit = options.limit ?? 500;
  const evidenceSources: ChatV2ReadinessEvidenceSource[] =
    options.evidenceSources && options.evidenceSources.length > 0
      ? [...new Set(options.evidenceSources)]
      : ['runtime_route'];
  const legacyRetirementInput = loadLegacyRetirementInput(db, limit, evidenceSources);
  const historicalLocaleEvidence = loadHistoricalLocaleEvidenceAudit(db, limit, evidenceSources);
  return {
    schemaVersion: 'chat_v2_completion_readiness_report.v1' as const,
    generatedAt: new Date().toISOString(),
    dbPath: options.dbPath ?? null,
    limit,
    evidenceSources,
    evidenceContract: {
      retirementObserverCorpusBinding: CHAT_V2_RETIREMENT_OBSERVER_CORPUS_BINDING,
      responseLocaleEvidenceVersion: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
    },
    historicalLocaleEvidence,
    shadow: evaluateChatShadowGateReadiness({ samples: loadShadowSamples(db, limit, evidenceSources) }),
    answerCanary: evaluateChatAnswerCanaryExit(loadAnswerCanaryInput(db, limit, evidenceSources)),
    deterministicRead: evaluateChatDeterministicReadReadiness(
      loadDeterministicReadInput(db, limit, evidenceSources),
    ),
    writePreview: evaluateChatWriteReadiness(loadWriteInput(db, 'write_preview', limit, evidenceSources)),
    confirmedWrites: evaluateChatWriteReadiness(loadWriteInput(db, 'confirmed_writes', limit, evidenceSources)),
    cloudAllowlist: evaluateChatCloudAllowlistReadiness(loadCloudAllowlistInput(db, limit, evidenceSources)),
    legacyRetirement: evaluateChatLegacyRetirementReadiness(legacyRetirementInput),
    legacyRetirementBlockers: buildLegacyRetirementBlockers(legacyRetirementInput),
  };
}

if (require.main === module) {
  const limit = parsePositiveInt(readArg('--limit')) ?? 500;
  const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
  const failOnBlocked = hasFlag('--fail-on-blocked');
  const evidenceSources = parseEvidenceSources(readArg('--source') ?? readArg('--sources'));

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const result = buildChatV2CompletionReadinessReport(db, { limit, evidenceSources, dbPath });

  console.log(JSON.stringify(result, null, 2));

  if (failOnBlocked && (
    !result.shadow.passed
    || !result.answerCanary.passed
    || !result.deterministicRead.passed
    || !result.writePreview.passed
    || !result.confirmedWrites.passed
    || !result.cloudAllowlist.passed
    || !result.legacyRetirement.passed
  )) {
    process.exitCode = 1;
  }
}

function loadShadowSamples(
  db: Database.Database,
  limit: number,
  evidenceSources: readonly ChatV2ReadinessEvidenceSource[],
): ChatShadowGateSample[] {
  if (!tableExists(db, 'chat_v2_completion_evidence')) return [];
  if (!columnExists(db, 'chat_v2_completion_evidence', 'evidence_source')) return [];
  const sourceFilter = buildSourceFilter(evidenceSources);
  const rows = db.prepare(`
    SELECT message_hmac, locale, candidate_capabilities_json, final_capability_id,
           schema_valid_after_repair, message_identifier_kind, candidate_evidence_hash,
           raw_field_audit_count
    FROM chat_v2_completion_evidence
    WHERE evidence_kind = 'shadow'
      AND evidence_source IN (${sourceFilter.placeholders})
      AND NOT ${historicalSpanishLocaleSql('locale')}
      AND ${currentChatV2ResponseLocaleEvidenceSql()}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, limit) as Array<{
    message_hmac: string;
    locale: string;
    candidate_capabilities_json: string;
    final_capability_id: string | null;
    schema_valid_after_repair: number;
    message_identifier_kind: string;
    candidate_evidence_hash: string;
    raw_field_audit_count: number;
  }>;

  return rows.map((row) => ({
    sampleId: row.message_hmac,
    language: normalizeEvidenceLanguage(row.locale),
    candidateCapabilities: parseStringArray(row.candidate_capabilities_json),
    finalCapabilityId: row.final_capability_id ?? undefined,
    schemaValidAfterRepair: row.schema_valid_after_repair === 1,
    messageIdentifierKind: row.message_identifier_kind === 'hmac' ? 'hmac' : 'raw',
    storedRawMessageText: false,
    unsafeRawFieldCount: Math.max(0, Number(row.raw_field_audit_count || 0)),
    candidateEvidenceHash: row.candidate_evidence_hash,
  }));
}

function loadAnswerCanaryInput(
  db: Database.Database,
  limit: number,
  evidenceSources: readonly ChatV2ReadinessEvidenceSource[],
): ChatAnswerCanaryEvaluationInput {
  if (!tableExists(db, 'chat_v2_completion_evidence')) {
    return {
      acceptanceSamples: [],
      unsupportedClaimSamples: [],
      progressSamples: [],
      privacySamples: [],
      compositionSamples: [],
    };
  }
  if (!columnExists(db, 'chat_v2_completion_evidence', 'evidence_source')) {
    return emptyAnswerCanaryInput();
  }
  const sourceFilter = buildSourceFilter(evidenceSources);
  const rows = db.prepare(`
    SELECT message_hmac, locale, answer_accepted, unsupported_claim_caught,
           first_progress_ms, leaked_raw_private_field, composition_mode
    FROM chat_v2_completion_evidence
    WHERE evidence_kind = 'answer_canary'
      AND evidence_source IN (${sourceFilter.placeholders})
      AND NOT ${historicalSpanishLocaleSql('locale')}
      AND ${currentChatV2ResponseLocaleEvidenceSql()}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, limit) as Array<{
    message_hmac: string;
    locale: string;
    answer_accepted: number | null;
    unsupported_claim_caught: number | null;
    first_progress_ms: number | null;
    leaked_raw_private_field: number;
    composition_mode: string | null;
  }>;

  return {
    acceptanceSamples: rows
      .filter((row) => row.answer_accepted != null)
      .map((row) => ({
        sampleId: row.message_hmac,
        language: normalizeEvidenceLanguage(row.locale),
        accepted: row.answer_accepted === 1,
      })),
    unsupportedClaimSamples: rows
      .filter((row) => row.unsupported_claim_caught != null)
      .map((row) => ({
        sampleId: row.message_hmac,
        caughtByDeterministicCritic: row.unsupported_claim_caught === 1,
      })),
    progressSamples: rows
      .filter((row) => row.first_progress_ms != null)
      .map((row) => ({
        sampleId: row.message_hmac,
        firstProgressMs: Math.max(0, Number(row.first_progress_ms)),
      })),
    privacySamples: rows.map((row) => ({
      sampleId: row.message_hmac,
      leakedRawPrivateField: row.leaked_raw_private_field === 1,
    })),
    compositionSamples: rows
      .map((row) => ({ sampleId: row.message_hmac, mode: asCompositionMode(row.composition_mode) }))
      .filter((sample): sample is { sampleId: string; mode: NexusAnswerCompositionMode } => sample.mode != null),
  };
}

interface HistoricalLocaleEvidenceAudit {
  schemaVersion: 'chat_v2_historical_locale_evidence_audit.v1';
  spanish: {
    excludedFromCurrentGates: true;
    shadowRowsAvailable: number;
    shadowRowsAudited: number;
    answerCanaryRowsAvailable: number;
    candidateEvidenceHashValidRows: number;
    candidateEvidenceHashInvalidRows: number;
  };
  responseLocaleAttribution: {
    currentVersion: typeof CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION;
    excludedPreVersionRows: true;
    shadowRowsAvailable: number;
    answerCanaryRowsAvailable: number;
  };
}

/**
 * Spanish response evidence predates the EN/PT-only product contract. It
 * remains visible here for immutable-evidence audit, but is never projected
 * into a supported language bucket or passed to a current readiness gate.
 */
function loadHistoricalLocaleEvidenceAudit(
  db: Database.Database,
  limit: number,
  evidenceSources: readonly ChatV2ReadinessEvidenceSource[],
): HistoricalLocaleEvidenceAudit {
  const empty = (): HistoricalLocaleEvidenceAudit => ({
    schemaVersion: 'chat_v2_historical_locale_evidence_audit.v1',
    spanish: {
      excludedFromCurrentGates: true,
      shadowRowsAvailable: 0,
      shadowRowsAudited: 0,
      answerCanaryRowsAvailable: 0,
      candidateEvidenceHashValidRows: 0,
      candidateEvidenceHashInvalidRows: 0,
    },
    responseLocaleAttribution: {
      currentVersion: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
      excludedPreVersionRows: true,
      shadowRowsAvailable: 0,
      answerCanaryRowsAvailable: 0,
    },
  });
  if (!tableExists(db, 'chat_v2_completion_evidence')) return empty();
  if (!columnExists(db, 'chat_v2_completion_evidence', 'evidence_source')) return empty();

  const sourceFilter = buildSourceFilter(evidenceSources);
  const counts = db.prepare(`
    SELECT evidence_kind AS evidenceKind, COUNT(*) AS count
    FROM chat_v2_completion_evidence
    WHERE evidence_source IN (${sourceFilter.placeholders})
      AND ${historicalSpanishLocaleSql('locale')}
    GROUP BY evidence_kind
  `).all(...sourceFilter.values) as Array<{ evidenceKind: string; count: number }>;
  const countFor = (kind: string): number =>
    Number(counts.find((row) => row.evidenceKind === kind)?.count ?? 0);
  const preVersionCounts = db.prepare(`
    SELECT evidence_kind AS evidenceKind, COUNT(*) AS count
    FROM chat_v2_completion_evidence
    WHERE evidence_source IN (${sourceFilter.placeholders})
      AND evidence_kind IN ('shadow', 'answer_canary')
      AND NOT ${historicalSpanishLocaleSql('locale')}
      AND COALESCE(${currentChatV2ResponseLocaleEvidenceSql()}, 0) = 0
    GROUP BY evidence_kind
  `).all(...sourceFilter.values) as Array<{ evidenceKind: string; count: number }>;
  const preVersionCountFor = (kind: string): number =>
    Number(preVersionCounts.find((row) => row.evidenceKind === kind)?.count ?? 0);

  const shadowRows = db.prepare(`
    SELECT message_hmac, candidate_capabilities_json, final_capability_id,
           schema_valid_after_repair, message_identifier_kind,
           candidate_evidence_hash, raw_field_audit_count
    FROM chat_v2_completion_evidence
    WHERE evidence_kind = 'shadow'
      AND evidence_source IN (${sourceFilter.placeholders})
      AND ${historicalSpanishLocaleSql('locale')}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, limit) as Array<{
    message_hmac: string;
    candidate_capabilities_json: string;
    final_capability_id: string | null;
    schema_valid_after_repair: number;
    message_identifier_kind: string;
    candidate_evidence_hash: string;
    raw_field_audit_count: number;
  }>;

  let candidateEvidenceHashValidRows = 0;
  for (const row of shadowRows) {
    const historicalSample = {
      sampleId: row.message_hmac,
      language: 'es',
      candidateCapabilities: parseStringArray(row.candidate_capabilities_json),
      finalCapabilityId: row.final_capability_id ?? undefined,
      schemaValidAfterRepair: row.schema_valid_after_repair === 1,
      messageIdentifierKind: row.message_identifier_kind === 'hmac' ? 'hmac' : 'raw',
      storedRawMessageText: false,
      unsafeRawFieldCount: Math.max(0, Number(row.raw_field_audit_count || 0)),
      candidateEvidenceHash: row.candidate_evidence_hash,
    } as unknown as ChatShadowGateSample;
    if (row.candidate_evidence_hash === buildChatShadowSampleEvidenceHash(historicalSample)) {
      candidateEvidenceHashValidRows += 1;
    }
  }

  return {
    schemaVersion: 'chat_v2_historical_locale_evidence_audit.v1',
    spanish: {
      excludedFromCurrentGates: true,
      shadowRowsAvailable: countFor('shadow'),
      shadowRowsAudited: shadowRows.length,
      answerCanaryRowsAvailable: countFor('answer_canary'),
      candidateEvidenceHashValidRows,
      candidateEvidenceHashInvalidRows: shadowRows.length - candidateEvidenceHashValidRows,
    },
    responseLocaleAttribution: {
      currentVersion: CHAT_V2_RESPONSE_LOCALE_EVIDENCE_VERSION,
      excludedPreVersionRows: true,
      shadowRowsAvailable: preVersionCountFor('shadow'),
      answerCanaryRowsAvailable: preVersionCountFor('answer_canary'),
    },
  };
}

function loadDeterministicReadInput(
  db: Database.Database,
  limit: number,
  evidenceSources: readonly ChatV2ReadinessEvidenceSource[],
): ChatDeterministicReadReadinessInput {
  if (!tableExists(db, 'chat_v2_deterministic_read_evidence')) {
    return { readSamples: [], tokenZeroSamples: [] };
  }
  const sourceFilter = buildSourceFilter(evidenceSources);
  const rows = db.prepare(`
    SELECT evidence_kind, sample_hmac, token_zero_surface, response_contract_valid,
           tenant_user_isolation_passed, token_zero_preserved
    FROM chat_v2_deterministic_read_evidence
    WHERE evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, limit) as Array<{
    evidence_kind: string;
    sample_hmac: string;
    token_zero_surface: string | null;
    response_contract_valid: number;
    tenant_user_isolation_passed: number;
    token_zero_preserved: number | null;
  }>;

  return {
    readSamples: rows
      .filter((row) => row.evidence_kind === 'deterministic_read')
      .map((row) => ({
        sampleId: row.sample_hmac,
        responseContractValid: row.response_contract_valid === 1,
        tenantUserIsolationPassed: row.tenant_user_isolation_passed === 1,
      })),
    tokenZeroSamples: rows
      .filter((row) => row.evidence_kind === 'token_zero_surface')
      .map((row) => {
        const surface = asTokenZeroSurface(row.token_zero_surface);
        return surface ? {
          sampleId: row.sample_hmac,
          surface,
          preserved: row.token_zero_preserved === 1,
        } : null;
      })
      .filter((sample): sample is { sampleId: string; surface: ChatDeterministicReadSurface; preserved: boolean } =>
        sample != null,
      ),
  };
}

function loadWriteInput(
  db: Database.Database,
  phase: ChatWriteReadinessPhase,
  limit: number,
  evidenceSources: readonly ChatV2ReadinessEvidenceSource[],
): ChatWriteReadinessInput {
  if (!tableExists(db, 'chat_v2_write_evidence')) {
    return { phase, samples: [] };
  }
  const sourceFilter = buildSourceFilter(evidenceSources);
  const rows = db.prepare(`
    SELECT sample_hmac, risk_class, preview_valid, diff_required, visible_diff_present,
           executed, validated_before_execution, success_claimed, verification_status,
           escalated_per_policy, idempotency_passed, retry_cancel_passed
    FROM chat_v2_write_evidence
    WHERE phase = ?
      AND evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(phase, ...sourceFilter.values, limit) as Array<{
    sample_hmac: string;
    risk_class: string;
    preview_valid: number;
    diff_required: number;
    visible_diff_present: number;
    executed: number;
    validated_before_execution: number;
    success_claimed: number;
    verification_status: string;
    escalated_per_policy: number;
    idempotency_passed: number;
    retry_cancel_passed: number;
  }>;

  return {
    phase,
    samples: rows
      .map((row) => {
        const riskClass = asRiskClass(row.risk_class);
        const verificationStatus = asVerificationStatus(row.verification_status);
        return riskClass && verificationStatus ? {
          sampleId: row.sample_hmac,
          riskClass,
          previewValid: row.preview_valid === 1,
          diffRequired: row.diff_required === 1,
          visibleDiffPresent: row.visible_diff_present === 1,
          executed: row.executed === 1,
          validatedBeforeExecution: row.validated_before_execution === 1,
          successClaimed: row.success_claimed === 1,
          verificationStatus,
          escalatedPerPolicy: row.escalated_per_policy === 1,
          idempotencyPassed: row.idempotency_passed === 1,
          retryCancelPassed: row.retry_cancel_passed === 1,
        } : null;
      })
      .filter((sample): sample is ChatWriteReadinessInput['samples'][number] => sample != null),
  };
}

function loadCloudAllowlistInput(
  db: Database.Database,
  limit: number,
  evidenceSources: readonly ChatV2ReadinessEvidenceSource[],
): ChatCloudAllowlistReadinessInput {
  if (!tableExists(db, 'chat_v2_cloud_allowlist_evidence')) {
    return { totalTurns: 0, cloudTurns: 0, packetSamples: [] };
  }
  const sourceFilter = buildSourceFilter(evidenceSources);
  const rows = db.prepare(`
    SELECT sample_hmac, sent_to_cloud, raw_private_field_count, denied, denial_reason,
           denial_reason_observable, hmac_entity_id_count, non_hmac_entity_id_count,
           hmac_evidence_fingerprint_count, non_hmac_evidence_fingerprint_count
    FROM chat_v2_cloud_allowlist_evidence
    WHERE evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, limit) as Array<{
    sample_hmac: string;
    sent_to_cloud: number;
    raw_private_field_count: number;
    denied: number;
    denial_reason: string | null;
    denial_reason_observable: number;
    hmac_entity_id_count: number;
    non_hmac_entity_id_count: number;
    hmac_evidence_fingerprint_count: number;
    non_hmac_evidence_fingerprint_count: number;
  }>;

  return {
    totalTurns: rows.length,
    cloudTurns: rows.filter((row) => row.sent_to_cloud === 1).length,
    packetSamples: rows.map((row) => ({
      sampleId: row.sample_hmac,
      sentToCloud: row.sent_to_cloud === 1,
      rawPrivateFieldCount: Math.max(0, Number(row.raw_private_field_count || 0)),
      denied: row.denied === 1,
      denialReason: row.denial_reason ?? undefined,
      denialReasonObservable: row.denial_reason_observable === 1,
      hmacEntityIdCount: Math.max(0, Number(row.hmac_entity_id_count || 0)),
      nonHmacEntityIdCount: Math.max(0, Number(row.non_hmac_entity_id_count || 0)),
      hmacEvidenceFingerprintCount: Math.max(0, Number(row.hmac_evidence_fingerprint_count || 0)),
      nonHmacEvidenceFingerprintCount: Math.max(0, Number(row.non_hmac_evidence_fingerprint_count || 0)),
    })),
  };
}

function loadLegacyRetirementInput(
  db: Database.Database,
  limit: number,
  evidenceSources: readonly ChatV2ReadinessEvidenceSource[],
): ChatLegacyRetirementReadinessInput {
  if (!tableExists(db, 'chat_v2_legacy_retirement_evidence')) {
    return {
      routeSamples: [],
      legacyFallbackRate24h: Number.NaN,
      fullVerifyClean: false,
    };
  }
  const sourceFilter = buildSourceFilter(evidenceSources);
  const rows = db.prepare(`
    SELECT evidence_source, evidence_kind, sample_identifier_kind,
           route_id, replaced, tested, shadow_parity_rate,
           route_sample_count, legacy_fallback_rate_24h, full_verify_clean,
           raw_field_audit_count, safe_metadata_json
    FROM chat_v2_legacy_retirement_evidence
    WHERE evidence_source IN (${sourceFilter.placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...sourceFilter.values, limit) as Array<{
    evidence_source: string;
    evidence_kind: string;
    sample_identifier_kind: string;
    route_id: string | null;
    replaced: number | null;
    tested: number | null;
    shadow_parity_rate: number | null;
    route_sample_count: number | null;
    legacy_fallback_rate_24h: number | null;
    full_verify_clean: number | null;
    raw_field_audit_count: number;
    safe_metadata_json: string | null;
  }>;

  const routeRowsById = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.evidence_kind !== 'route_exit' || !row.route_id) continue;
    if (!validateCurrentChatV2LegacyRetirementEvidenceRow(row).ok) continue;
    const existing = routeRowsById.get(row.route_id) ?? [];
    existing.push(row);
    routeRowsById.set(row.route_id, existing);
  }
  const routeSamples = [...routeRowsById.entries()].flatMap(([routeId, routeRows]) => {
    const selected = routeRows[0];
    if (!selected) return [];
    const peerMetadata = parseRoutePeerMetadata(selected.safe_metadata_json);
    return [{
      routeId,
      replaced: selected.replaced === 1,
      tested: selected.tested === 1,
      shadowParityRate: typeof selected.shadow_parity_rate === 'number' ? selected.shadow_parity_rate : 0,
      sampleCount: typeof selected.route_sample_count === 'number' ? selected.route_sample_count : 0,
      evaluator: peerMetadata.evaluator,
      peerReviewSignoffHash: peerMetadata.peerReviewSignoffHash,
      safetyRegressionCount: peerMetadata.safetyRegressionCount,
      qualityRegressionCount: peerMetadata.qualityRegressionCount,
      degradedNotComparableCount: peerMetadata.degradedNotComparableCount,
    }];
  });
  return {
    routeSamples,
    legacyFallbackRate24h: rows.find((row) => row.evidence_kind === 'fallback_rate')?.legacy_fallback_rate_24h ?? Number.NaN,
    fullVerifyClean: rows.find((row) => row.evidence_kind === 'verify_run')?.full_verify_clean === 1,
    requiredRouteIds: PHASE7_REQUIRED_ROUTE_IDS,
  };
}

function parseRoutePeerMetadata(safeMetadataJson?: string | null): {
  evaluator?: string;
  peerReviewSignoffHash?: string;
  safetyRegressionCount?: number;
  qualityRegressionCount?: number;
  degradedNotComparableCount?: number;
} {
  if (!safeMetadataJson) return {};
  try {
    const parsed = JSON.parse(safeMetadataJson) as Record<string, unknown>;
    const evaluator = typeof parsed.evaluator === 'string' ? parsed.evaluator.trim().toLowerCase() : undefined;
    const peerReviewSignoffHash = typeof parsed.peerReviewSignoffHash === 'string'
      && /^[a-f0-9]{64}$/i.test(parsed.peerReviewSignoffHash.trim())
      ? parsed.peerReviewSignoffHash.trim().toLowerCase()
      : undefined;
    return {
      evaluator: evaluator || undefined,
      peerReviewSignoffHash,
      safetyRegressionCount: typeof parsed.safetyRegressionCount === 'number'
        && Number.isInteger(parsed.safetyRegressionCount)
        ? parsed.safetyRegressionCount
        : undefined,
      qualityRegressionCount: typeof parsed.qualityRegressionCount === 'number'
        && Number.isInteger(parsed.qualityRegressionCount)
        ? parsed.qualityRegressionCount
        : undefined,
      degradedNotComparableCount: typeof parsed.degradedNotComparableCount === 'number'
        && Number.isInteger(parsed.degradedNotComparableCount)
        ? parsed.degradedNotComparableCount
        : undefined,
    };
  } catch {
    return {};
  }
}

function buildLegacyRetirementBlockers(input: ChatLegacyRetirementReadinessInput): {
  schemaVersion: 'chat_v2_legacy_retirement_blockers.v1';
  routeBlockers: Array<{
    routeId: string;
    reasonCode: 'missing_old_vs_chatv2_match_labels'
      | 'insufficient_parity_samples'
      | 'below_shadow_parity_threshold'
      | 'missing_independent_peer_review'
      | 'missing_safety_regression_review'
      | 'chatv2_worse_safety_regression'
      | 'missing_quality_regression_review'
      | 'chatv2_worse_quality_regression'
      | 'missing_degraded_not_comparable_review'
      | 'degraded_not_comparable_present';
    replaced: boolean;
    tested: boolean;
    sampleCount: number;
    requiredSampleCount: number;
    shadowParityRate: number;
    requiredShadowParityRate: number;
  }>;
  note: string;
} {
  const requiredSampleCount = 50;
  const requiredShadowParityRate = 0.95;
  return {
    schemaVersion: 'chat_v2_legacy_retirement_blockers.v1',
    routeBlockers: input.routeSamples
      .concat((input.requiredRouteIds ?? [])
        .filter((routeId) => !input.routeSamples.some((sample) => sample.routeId === routeId))
        .map((routeId) => ({
          routeId,
          replaced: false,
          tested: false,
          shadowParityRate: 0,
          sampleCount: 0,
        })))
      .map((sample) => {
        let reasonCode: 'missing_old_vs_chatv2_match_labels'
          | 'insufficient_parity_samples'
          | 'below_shadow_parity_threshold'
          | 'missing_independent_peer_review'
          | 'missing_safety_regression_review'
          | 'chatv2_worse_safety_regression'
          | 'missing_quality_regression_review'
          | 'chatv2_worse_quality_regression'
          | 'missing_degraded_not_comparable_review'
          | 'degraded_not_comparable_present'
          | null = null;
        if (!sample.replaced || !sample.tested) reasonCode = 'missing_old_vs_chatv2_match_labels';
        else if (sample.sampleCount < requiredSampleCount) reasonCode = 'insufficient_parity_samples';
        else if (sample.shadowParityRate < requiredShadowParityRate) reasonCode = 'below_shadow_parity_threshold';
        else if (!hasIndependentPeerReview(sample)) reasonCode = 'missing_independent_peer_review';
        else if (sample.safetyRegressionCount == null) reasonCode = 'missing_safety_regression_review';
        else if (sample.safetyRegressionCount > 0) reasonCode = 'chatv2_worse_safety_regression';
        else if (sample.qualityRegressionCount == null) reasonCode = 'missing_quality_regression_review';
        else if (sample.qualityRegressionCount > 0) reasonCode = 'chatv2_worse_quality_regression';
        else if (sample.degradedNotComparableCount == null) reasonCode = 'missing_degraded_not_comparable_review';
        else if (sample.degradedNotComparableCount > 0) reasonCode = 'degraded_not_comparable_present';
        if (!reasonCode) return null;
        return {
          routeId: sample.routeId,
          reasonCode,
          replaced: sample.replaced,
          tested: sample.tested,
          sampleCount: sample.sampleCount,
          requiredSampleCount,
          shadowParityRate: sample.shadowParityRate,
          requiredShadowParityRate,
        };
      })
      .filter((sample): sample is NonNullable<typeof sample> => sample != null),
    note: 'Coverage rows are not parity proof. Phase 7 requires HMAC-only old-vs-ChatV2 observations or peer-reviewed aggregate labels before any legacy natural-language route is disabled.',
  };
}

function hasIndependentPeerReview(sample: {
  evaluator?: string;
  peerReviewSignoffHash?: string;
}): boolean {
  const evaluator = String(sample.evaluator ?? '').trim().toLowerCase();
  return (evaluator === 'claude' || evaluator === 'manual')
    && /^[a-f0-9]{64}$/i.test(String(sample.peerReviewSignoffHash ?? '').trim());
}

type ChatV2ReadinessEvidenceSource = 'runtime_route' | 'local_sandbox_seed';

function parseEvidenceSources(value: string | null): ChatV2ReadinessEvidenceSource[] {
  const parsed = String(value ?? 'runtime_route')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item): item is ChatV2ReadinessEvidenceSource =>
      item === 'runtime_route' || item === 'local_sandbox_seed',
    );
  return parsed.length > 0 ? [...new Set(parsed)] : ['runtime_route'];
}

function buildSourceFilter(evidenceSources: readonly ChatV2ReadinessEvidenceSource[]): {
  placeholders: string;
  values: ChatV2ReadinessEvidenceSource[];
} {
  const values = [...new Set(evidenceSources)];
  return {
    placeholders: values.map(() => '?').join(', '),
    values,
  };
}

function historicalSpanishLocaleSql(columnName: 'locale'): string {
  return `(
    lower(trim(${columnName})) = 'es'
    OR lower(trim(${columnName})) LIKE 'es-%'
    OR lower(trim(${columnName})) GLOB 'es_*'
  )`;
}

function emptyAnswerCanaryInput(): ChatAnswerCanaryEvaluationInput {
  return {
    acceptanceSamples: [],
    unsupportedClaimSamples: [],
    progressSamples: [],
    privacySamples: [],
    compositionSamples: [],
  };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function normalizeEvidenceLanguage(value: string | null | undefined): NexusChatShadowLanguage {
  const raw = String(value ?? '').trim();
  if (/^pt[-_]?br$/i.test(raw)) return 'pt-BR';
  if (/^pt[-_]?pt$/i.test(raw)) return 'pt-PT';
  if (/^pt\b/i.test(raw)) return 'pt-BR';
  if (/^en\b/i.test(raw)) return 'en';
  if (/mixed/i.test(raw)) return 'mixed';
  return 'en';
}

function parseStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return parseStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function asCompositionMode(value: unknown): NexusAnswerCompositionMode | null {
  return value === 'templated'
    || value === 'model_constrained'
    || value === 'background_model'
    || value === 'cloud_allowlist'
    ? value
    : null;
}

function asTokenZeroSurface(value: unknown): ChatDeterministicReadSurface | null {
  return value === 'slash' || value === 'button' || value === 'api' ? value : null;
}

function asRiskClass(value: unknown): ChatWriteRiskClass | null {
  return value === 'A' || value === 'B' || value === 'C' ? value : null;
}

function asVerificationStatus(value: unknown): ChatWriteVerificationStatus | null {
  return value === 'verified'
    || value === 'partial'
    || value === 'failed'
    || value === 'indeterminate'
    || value === 'not_required'
    ? value
    : null;
}

function readArg(name: string): string | null {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

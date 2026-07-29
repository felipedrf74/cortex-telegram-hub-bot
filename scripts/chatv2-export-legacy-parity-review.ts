#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {
  validateCurrentChatV2LegacyRetirementEvidenceRow,
} from '../src/services/chat-legacy-parity-labels';
import {
  currentChatV2ResponseLocaleEvidenceSql,
} from '../src/services/chat-v2-completion-evidence';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
const inventoryPath = readArg('--inventory') ?? 'docs/ai/chatv2-route-exit-inventory.md';
const outPath = readArg('--out') ?? '.local/release/eval-evidence/chatv2-legacy-parity-review-latest.json';

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const inventoryRows = parseRouteExitInventory(inventoryPath);
  const routeCoverage = computeRouteCoverage(db);
  const importedParity = loadImportedParityLabels(db);
  const rows = inventoryRows.map((row) => {
    const coverage = routeCoverage[row.routeId] ?? {
      runtimeSamples: 0,
      validSamples: 0,
      sources: [],
      routeMethods: [],
      finalCapabilities: [],
    };
    const parity = importedParity[row.routeId];
    return {
      schemaVersion: 'chat_v2_legacy_parity_review_row.v1',
      routeId: row.routeId,
      routeLabel: row.label,
      currentOwner: row.currentOwner,
      plannedReplacement: row.plannedReplacement,
      keepPreChatV2: row.keepPreChatV2,
      canExecute: row.canExecute,
      externalEffect: row.externalEffect,
      runtimeSamples: coverage.runtimeSamples,
      validSamples: coverage.validSamples,
      coverageRate: coverage.runtimeSamples > 0 ? coverage.validSamples / coverage.runtimeSamples : 0,
      sourceTables: coverage.sources,
      observedRouteMethods: coverage.routeMethods,
      observedFinalCapabilities: coverage.finalCapabilities,
      parityLabelNeeded: !row.keepPreChatV2 || row.canExecute || row.externalEffect,
      parityBlocker: buildParityBlocker(row, coverage, parity),
      importedParityLabel: parity
        ? {
          replaced: parity.replaced,
          tested: parity.tested,
          sampleCount: parity.sampleCount,
          matchingCount: parity.matchingCount,
          shadowParityRate: parity.shadowParityRate,
          evaluator: parity.evaluator,
          peerReviewSignoffHash: parity.peerReviewSignoffHash,
          evidenceSource: parity.evidenceSource,
          safetyRegressionCount: parity.safetyRegressionCount,
          qualityRegressionCount: parity.qualityRegressionCount,
          degradedNotComparableCount: parity.degradedNotComparableCount,
        }
        : null,
      importLabelTemplate: {
        schemaVersion: 'chat_v2_legacy_parity_label.v1',
        routeId: row.routeId,
        replaced: false,
        tested: false,
        sampleCount: coverage.runtimeSamples,
        matchingCount: 0,
        oldOwner: row.currentOwner,
        replacement: row.plannedReplacement,
        evaluator: 'manual',
        peerReviewSignoffHash: '<sha256-of-independent-peer-review-report>',
        evidenceSource: 'runtime_route',
        safetyRegressionCount: 0,
        qualityRegressionCount: 0,
        degradedNotComparableCount: 0,
        reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
      },
    };
  });
  const report = {
    schemaVersion: 'chat_v2_legacy_parity_review_report.v1',
    generatedAt: new Date().toISOString(),
    dbPath,
    inventoryPath,
    rows,
    warning: 'This is safe aggregate coverage only, not parity proof. A reviewer must compare old/new behavior and import aggregate labels with chatv2-import-legacy-parity-labels.ts.',
  };
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    schemaVersion: 'chat_v2_legacy_parity_review_export_result.v1',
    outPath: path.resolve(outPath),
    rows: rows.length,
    parityLabelsNeeded: rows.filter((row) => row.parityLabelNeeded).length,
    blockedRows: rows.filter((row) => row.parityBlocker.blocked).length,
  }, null, 2));
} finally {
  db.close();
}

type InventoryRow = {
  label: string;
  routeId: string;
  currentOwner: string;
  plannedReplacement: string;
  keepPreChatV2: boolean;
  canExecute: boolean;
  externalEffect: boolean;
};

type RouteCoverage = {
  runtimeSamples: number;
  validSamples: number;
  sources: string[];
  routeMethods: string[];
  finalCapabilities: string[];
};

type ImportedParityLabel = {
  replaced: boolean;
  tested: boolean;
  sampleCount: number;
  matchingCount: number;
  shadowParityRate: number;
  evaluator: string;
  peerReviewSignoffHash?: string;
  evidenceSource: string;
  safetyRegressionCount: number;
  qualityRegressionCount: number;
  degradedNotComparableCount: number;
};

type ParityBlocker =
  | {
    blocked: false;
    reason: 'not_required_for_legacy_retirement'
      | 'reviewed_parity_label_passed';
    minimumRequiredSamples: number;
    missingRuntimeSamples: number;
  }
  | {
    blocked: true;
    reason: 'insufficient_runtime_samples'
      | 'missing_independent_peer_review'
      | 'missing_old_vs_chatv2_matching_count'
      | 'reviewed_parity_below_threshold'
      | 'reviewed_route_not_replaceable'
      | 'safety_regression_present'
      | 'quality_regression_present'
      | 'degraded_not_comparable_present'
      | 'missing_review_regression_counts';
    minimumRequiredSamples: number;
    missingRuntimeSamples: number;
  };

function parseRouteExitInventory(filePath: string): InventoryRow[] {
  const content = fs.readFileSync(path.resolve(filePath), 'utf8');
  return content
    .split(/\r?\n/)
    .filter((line) => line.startsWith('| ') && !line.includes('---'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 7 && cells[0] !== 'Route Exit')
    .map((cells) => ({
      label: stripMarkdown(cells[0]!),
      routeId: slugify(stripMarkdown(cells[0]!)),
      currentOwner: stripMarkdown(cells[1] ?? ''),
      canExecute: /^yes|preview|task|confirmed/i.test(stripMarkdown(cells[3] ?? '')),
      externalEffect: /^yes|possible|native|web|task/i.test(stripMarkdown(cells[4] ?? '')),
      keepPreChatV2: /^yes/i.test(stripMarkdown(cells[5] ?? '')),
      plannedReplacement: stripMarkdown(cells[6] ?? ''),
    }))
    .filter((row) => row.routeId.length > 0);
}

function computeRouteCoverage(db: Database.Database): Record<string, RouteCoverage> {
  const coverage: Record<string, RouteCoverage> = {};
  addCompletionCoverage(db, coverage);
  addDeterministicReadCoverage(db, coverage);
  addWriteCoverage(db, coverage);
  return coverage;
}

function buildParityBlocker(row: InventoryRow, coverage: RouteCoverage, parity?: ImportedParityLabel): ParityBlocker {
  const minimumRequiredSamples = 50;
  const parityRequired = !row.keepPreChatV2 || row.canExecute || row.externalEffect;
  if (!parityRequired) {
    return {
      blocked: false,
      reason: 'not_required_for_legacy_retirement',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  if (parity
    && parity.sampleCount >= minimumRequiredSamples
    && parity.safetyRegressionCount === 0
    && parity.qualityRegressionCount === 0
    && parity.degradedNotComparableCount === 0
    && hasIndependentPeerReview(parity)
    && (!parity.replaced || !parity.tested)) {
    return {
      blocked: true,
      reason: 'reviewed_route_not_replaceable',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  if (parity
    && parity.replaced
    && parity.tested
    && parity.sampleCount >= minimumRequiredSamples
    && parity.shadowParityRate >= 0.95
    && parity.safetyRegressionCount === 0
    && parity.qualityRegressionCount === 0
    && parity.degradedNotComparableCount === 0
    && hasIndependentPeerReview(parity)) {
    return {
      blocked: false,
      reason: 'reviewed_parity_label_passed',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  if (parity
    && parity.replaced
    && parity.tested
    && parity.sampleCount >= minimumRequiredSamples
    && parity.shadowParityRate < 0.95
    && parity.safetyRegressionCount === 0
    && parity.qualityRegressionCount === 0
    && parity.degradedNotComparableCount === 0
    && hasIndependentPeerReview(parity)) {
    return {
      blocked: true,
      reason: 'reviewed_parity_below_threshold',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  if (parity
    && parity.replaced
    && parity.tested
    && parity.sampleCount >= minimumRequiredSamples
    && parity.shadowParityRate >= 0.95
    && parity.safetyRegressionCount > 0) {
    return {
      blocked: true,
      reason: 'safety_regression_present',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  if (parity
    && parity.replaced
    && parity.tested
    && parity.sampleCount >= minimumRequiredSamples
    && parity.shadowParityRate >= 0.95
    && parity.safetyRegressionCount === 0
    && parity.qualityRegressionCount > 0) {
    return {
      blocked: true,
      reason: 'quality_regression_present',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  if (parity
    && parity.replaced
    && parity.tested
    && parity.sampleCount >= minimumRequiredSamples
    && parity.shadowParityRate >= 0.95
    && parity.safetyRegressionCount === 0
    && !hasIndependentPeerReview(parity)) {
    return {
      blocked: true,
      reason: 'missing_independent_peer_review',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  if (parity
    && parity.replaced
    && parity.tested
    && parity.sampleCount >= minimumRequiredSamples
    && parity.shadowParityRate >= 0.95
    && parity.safetyRegressionCount === 0
    && parity.qualityRegressionCount === 0
    && parity.degradedNotComparableCount > 0) {
    return {
      blocked: true,
      reason: 'degraded_not_comparable_present',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  if (parity
    && parity.replaced
    && parity.tested
    && parity.sampleCount >= minimumRequiredSamples
    && parity.shadowParityRate >= 0.95
    && (!Number.isInteger(parity.qualityRegressionCount) || !Number.isInteger(parity.degradedNotComparableCount))) {
    return {
      blocked: true,
      reason: 'missing_review_regression_counts',
      minimumRequiredSamples,
      missingRuntimeSamples: 0,
    };
  }
  const missingRuntimeSamples = Math.max(0, minimumRequiredSamples - coverage.runtimeSamples);
  if (missingRuntimeSamples > 0) {
    return {
      blocked: true,
      reason: 'insufficient_runtime_samples',
      minimumRequiredSamples,
      missingRuntimeSamples,
    };
  }
  return {
    blocked: true,
    reason: 'missing_old_vs_chatv2_matching_count',
    minimumRequiredSamples,
    missingRuntimeSamples: 0,
  };
}

function loadImportedParityLabels(db: Database.Database): Record<string, ImportedParityLabel> {
  if (!tableExists(db, 'chat_v2_legacy_retirement_evidence')) return {};
  const rows = db.prepare(`
    SELECT evidence_source, evidence_kind, sample_identifier_kind,
           route_id, replaced, tested, shadow_parity_rate, route_sample_count,
           raw_field_audit_count, safe_metadata_json,
           datetime(created_at) AS created_at, id
    FROM chat_v2_legacy_retirement_evidence
    WHERE evidence_kind = 'route_exit'
      AND route_id IS NOT NULL
      AND raw_field_audit_count = 0
    ORDER BY route_id, datetime(created_at) DESC, id DESC
  `).all() as Array<{
    evidence_kind: string;
    sample_identifier_kind: string;
    route_id: string;
    replaced: number | null;
    tested: number | null;
    shadow_parity_rate: number | null;
    route_sample_count: number | null;
    evidence_source: string;
    raw_field_audit_count: number;
    safe_metadata_json: string | null;
    created_at: string;
    id: number;
  }>;

  const byRoute: Record<string, ImportedParityLabel> = {};
  for (const row of rows) {
    if (byRoute[row.route_id]) continue;
    const validation = validateCurrentChatV2LegacyRetirementEvidenceRow(row);
    if (!validation.ok || validation.metadata.parityLabelImport !== true) continue;
    const metadata = validation.metadata;
    const sampleCount = validation.sampleCount;
    const shadowParityRate = validation.parityRate;
    const matchingCount = validation.matchingCount;
    byRoute[row.route_id] = {
      replaced: row.replaced === 1,
      tested: row.tested === 1,
      sampleCount,
      matchingCount,
      shadowParityRate,
      evaluator: typeof metadata.evaluator === 'string' ? metadata.evaluator : 'unknown',
      peerReviewSignoffHash: typeof metadata.peerReviewSignoffHash === 'string'
        ? metadata.peerReviewSignoffHash
        : undefined,
      evidenceSource: row.evidence_source,
      safetyRegressionCount: integerFromUnknown(metadata.safetyRegressionCount) ?? 0,
      qualityRegressionCount: integerFromUnknown(metadata.qualityRegressionCount) ?? Number.NaN,
      degradedNotComparableCount: integerFromUnknown(metadata.degradedNotComparableCount) ?? Number.NaN,
    };
  }
  return byRoute;
}

function hasIndependentPeerReview(parity: ImportedParityLabel): boolean {
  const evaluator = parity.evaluator.trim().toLowerCase();
  return (evaluator === 'claude' || evaluator === 'manual')
    && /^[a-f0-9]{64}$/i.test(String(parity.peerReviewSignoffHash ?? '').trim());
}

function addCompletionCoverage(db: Database.Database, coverage: Record<string, RouteCoverage>): void {
  if (!tableExists(db, 'chat_v2_completion_evidence')) return;
  const rows = db.prepare(`
    SELECT route_owner, route_method, final_capability_id, response_contract_valid, COUNT(*) AS count
    FROM chat_v2_completion_evidence
    WHERE evidence_source = 'runtime_route'
      AND evidence_kind = 'shadow'
      AND ${currentChatV2ResponseLocaleEvidenceSql()}
    GROUP BY route_owner, route_method, final_capability_id, response_contract_valid
  `).all() as Array<{
    route_owner: string;
    route_method: string | null;
    final_capability_id: string | null;
    response_contract_valid: number;
    count: number;
  }>;
  for (const row of rows) {
    const routeIds = routeIdsForCompletion(row);
    for (const routeId of routeIds) {
      addCoverage(coverage, routeId, {
        source: 'chat_v2_completion_evidence',
        routeMethod: row.route_method ?? 'unknown',
        finalCapability: row.final_capability_id ?? 'unknown',
        count: row.count,
        valid: row.response_contract_valid === 1 ? row.count : 0,
      });
    }
  }
}

function addDeterministicReadCoverage(db: Database.Database, coverage: Record<string, RouteCoverage>): void {
  if (!tableExists(db, 'chat_v2_deterministic_read_evidence')) return;
  const rows = db.prepare(`
    SELECT evidence_kind, read_kind, token_zero_surface, response_contract_valid, COUNT(*) AS count
    FROM chat_v2_deterministic_read_evidence
    WHERE evidence_source = 'runtime_route'
    GROUP BY evidence_kind, read_kind, token_zero_surface, response_contract_valid
  `).all() as Array<{
    evidence_kind: string;
    read_kind: string;
    token_zero_surface: string | null;
    response_contract_valid: number;
    count: number;
  }>;
  for (const row of rows) {
    const routeIds = new Set<string>();
    if (row.evidence_kind === 'token_zero_surface') {
      routeIds.add('token_zero_message_shortcuts');
      if (row.token_zero_surface === 'slash') routeIds.add('deterministic_slash_fast_path');
      if (row.token_zero_surface === 'button') routeIds.add('decision_confirmation_shortcut');
    }
    if (row.evidence_kind === 'deterministic_read') {
      routeIds.add('deterministic_slash_fast_path');
      routeIds.add('chat_message_shortcut_after_route');
    }
    for (const routeId of routeIds) {
      addCoverage(coverage, routeId, {
        source: 'chat_v2_deterministic_read_evidence',
        routeMethod: row.token_zero_surface ?? row.read_kind,
        finalCapability: row.read_kind,
        count: row.count,
        valid: row.response_contract_valid === 1 ? row.count : 0,
      });
    }
  }
}

function addWriteCoverage(db: Database.Database, coverage: Record<string, RouteCoverage>): void {
  if (!tableExists(db, 'chat_v2_write_evidence')) return;
  const rows = db.prepare(`
    SELECT phase, risk_class, validated_before_execution, verification_status, COUNT(*) AS count
    FROM chat_v2_write_evidence
    WHERE evidence_source = 'runtime_route'
    GROUP BY phase, risk_class, validated_before_execution, verification_status
  `).all() as Array<{
    phase: string;
    risk_class: string;
    validated_before_execution: number;
    verification_status: string;
    count: number;
  }>;
  for (const row of rows) {
    const routeIds = new Set<string>([
      'general_action_planner',
      'chat_reasoning_engine_v1',
    ]);
    if (row.risk_class === 'C') routeIds.add('destructive_confirmation_hold');
    for (const routeId of routeIds) {
      const valid = row.validated_before_execution === 1
        && (row.verification_status === 'verified' || row.verification_status === 'not_required')
        ? row.count
        : 0;
      addCoverage(coverage, routeId, {
        source: 'chat_v2_write_evidence',
        routeMethod: row.phase,
        finalCapability: `risk_${row.risk_class}`,
        count: row.count,
        valid,
      });
    }
  }
}

function routeIdsForCompletion(row: { route_owner: string; route_method: string | null; final_capability_id: string | null }): string[] {
  const routeIds = new Set<string>();
  const method = (row.route_method ?? '').toLowerCase();
  const owner = (row.route_owner ?? '').toLowerCase();
  const capability = (row.final_capability_id ?? '').toLowerCase();
  if (method.includes('idempotency')) routeIds.add('idempotent_replay_findcompletedassistantforclientmessage');
  if (method.includes('fast-path')) {
    routeIds.add('deterministic_slash_fast_path');
    routeIds.add('token_zero_message_shortcuts');
  }
  if (method.includes('authenticated-identity')) routeIds.add('authenticated_identity_fast_path');
  if (method.includes('chat-reasoning-engine')) routeIds.add('chat_reasoning_engine_v1');
  if (method.includes('confirmation')) routeIds.add('destructive_confirmation_hold');
  if (method.includes('classifier') || method.includes('keyword')) routeIds.add('classifier_route_skill_orchestration');
  if (owner && !['chat', 'general'].includes(owner)) routeIds.add('domain_handler_execution');
  if (capability.includes('content') || owner === 'content') routeIds.add('domain_handler_execution');
  return [...routeIds];
}

function addCoverage(
  coverage: Record<string, RouteCoverage>,
  routeId: string,
  input: { source: string; routeMethod: string; finalCapability: string; count: number; valid: number },
): void {
  const existing = coverage[routeId] ?? {
    runtimeSamples: 0,
    validSamples: 0,
    sources: [],
    routeMethods: [],
    finalCapabilities: [],
  };
  existing.runtimeSamples += input.count;
  existing.validSamples += input.valid;
  existing.sources = addUnique(existing.sources, input.source);
  existing.routeMethods = addUnique(existing.routeMethods, input.routeMethod).slice(0, 12);
  existing.finalCapabilities = addUnique(existing.finalCapabilities, input.finalCapability).slice(0, 12);
  coverage[routeId] = existing;
}

function addUnique(values: string[], next: string): string[] {
  return values.includes(next) ? values : [...values, next];
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function parseSafeMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function integerFromUnknown(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

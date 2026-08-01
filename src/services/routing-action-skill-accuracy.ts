// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cache-only Phase 7 action-skill agreement evaluator.
 *
 * This module never imports a provider and never performs a network call. It
 * scores only predictions retained in routing_manifest_skill_classify_cache
 * under the exact manifest prompt, per-item request, provider, model, usage
 * category, successful api_usage row, and run identity requested by the
 * operator. The Phase 4 routing_llm_classify_cache remains independent.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import {
  buildClassifierCandidateShortlist,
  buildManifestClassifierPrompt,
} from '../router/classifier-prompt-builder';
import { loadPrompt } from '../utils/prompt-loader';
import { getDb } from './database';
import {
  getRoutingLabelCandidates,
  type RoutingCorpusItem,
} from './routing-corpus';

export const ROUTING_ACTION_SKILL_ACCURACY_VERSION = 'routing-action-skill-accuracy@1.0.0';
export const ROUTING_ACTION_SKILL_REQUEST_BUILDER_VERSION = 'manifest-classifier-request@1.0.0';
export const ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT = 300;
export const ROUTING_ACTION_SKILL_MIN_AGREEMENT = 0.95;
export const ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE = 'system';
export const ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY = 'routing_action_skill_cache_refresh';
export const ROUTING_ACTION_SKILL_USAGE_JOB_NAME = 'routing_action_skill_cache_refresh';
export const ROUTING_ACTION_SKILL_USAGE_USER_ID = 0;
export const ROUTING_ACTION_SKILL_USAGE_TENANT_ID = 0;

const ROUTING_ACTION_SKILL_MIN_DOMAIN_LABELS = 20;
const ROUTING_ACTION_SKILL_MIN_SKILL_LABELS = 20;
const ROUTING_ACTION_SKILL_MIN_SPECIAL_LABELS = 8;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const RUNTIME_SHA_HEX = /^[a-f0-9]{40}$/;
const PLAN_DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface RoutingActionSkillSourceIdentity {
  runtimeSha: string;
  artifactDigest: string;
  releaseRunId: string;
  promptSha256: string;
  requestBuilderVersion: string;
  provider: string;
  model: string;
  usageCategory: string;
  requestSource: typeof ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE;
  baseCategory: typeof ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY;
  jobName: typeof ROUTING_ACTION_SKILL_USAGE_JOB_NAME;
  userId: typeof ROUTING_ACTION_SKILL_USAGE_USER_ID;
  tenantId: typeof ROUTING_ACTION_SKILL_USAGE_TENANT_ID;
}

export interface RoutingActionSkillRequestIdentity {
  requestText: string;
  requestSha256: string;
}

export interface RoutingActionSkillMetric {
  skill: string;
  support: number;
  predicted: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
}

export interface RoutingActionSkillSpecialLabelMetric {
  label: string;
  support: number;
  covered: number;
  predictedAbstentions: number;
  correctAbstentions: number;
  abstentionAgreement: number | null;
}

export interface RoutingActionSkillGateResult {
  passed: boolean;
  requiredItemCount: number;
  requiredCovered: number;
  minimumAgreement: number;
  reasons: string[];
}

export interface RoutingActionSkillAccuracyReport {
  version: string;
  generatedAt: string;
  corpusIdentityDigest: string;
  sourceIdentity: RoutingActionSkillSourceIdentity;
  releaseEvidence: {
    hardBudgetUsd: number | null;
    planDigests: string[];
    completedPlanDigests: string[];
    terminalPlanSequence: number | null;
    terminalPlanDigest: string | null;
    terminalPlanStatus: 'active' | 'failed' | 'completed' | null;
  };
  itemCount: number;
  covered: number;
  uncovered: number;
  coverage: number | null;
  correct: number;
  agreement: number | null;
  expectedSkillRows: number;
  expectedAbstentionRows: number;
  predictedAbstentions: number;
  perSkill: RoutingActionSkillMetric[];
  specialLabels: RoutingActionSkillSpecialLabelMetric[];
  gate: RoutingActionSkillGateResult;
}

export interface RoutingActionSkillCorpusIdentity {
  digest: string;
  itemCount: number;
}

export interface RoutingActionSkillSourceIdentityInput {
  runtimeSha: string;
  artifactDigest: string;
  provider: string;
  model: string;
  usageCategory: string;
}

/** Stable corpus binding for owner plans and separately authorized refreshes. */
export function buildRoutingActionSkillCorpusIdentity(
  db: Database.Database = getDb(),
): RoutingActionSkillCorpusIdentity {
  const items = listLabeledRoutingCorpusItemsReadOnly(db);
  return {
    digest: routingActionSkillCorpusIdentityDigest(items),
    itemCount: items.length,
  };
}

/** Bind evidence to the exact checked-in prompt bytes served in production. */
export function buildRoutingActionSkillSourceIdentity(
  input: RoutingActionSkillSourceIdentityInput,
): RoutingActionSkillSourceIdentity {
  const runtimeSha = requireDigest(input.runtimeSha, RUNTIME_SHA_HEX, 'runtimeSha');
  const artifactDigest = requireDigest(
    input.artifactDigest,
    SHA256_HEX,
    'artifactDigest',
  );
  const provider = requireNonEmpty(input.provider, 'provider');
  const model = requireNonEmpty(input.model, 'model');
  const usageCategory = requireNonEmpty(input.usageCategory, 'usageCategory');
  const prompt = loadPrompt('classifier-manifest');
  const generated = `${buildManifestClassifierPrompt()}\n`;
  if (prompt !== generated) {
    throw new Error(
      'Manifest classifier prompt artifact is stale; regenerate prompts/classifier-manifest.md before evaluation',
    );
  }
  return {
    runtimeSha,
    artifactDigest,
    releaseRunId: buildRoutingActionSkillReleaseRunId(runtimeSha, artifactDigest),
    promptSha256: sha256(prompt),
    requestBuilderVersion: ROUTING_ACTION_SKILL_REQUEST_BUILDER_VERSION,
    provider,
    model,
    usageCategory,
    requestSource: ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE,
    baseCategory: ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY,
    jobName: ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
    userId: ROUTING_ACTION_SKILL_USAGE_USER_ID,
    tenantId: ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
  };
}

/** Stable metering identity shared by every bounded plan for one exact release. */
export function buildRoutingActionSkillReleaseRunId(
  runtimeSha: string,
  artifactDigest: string,
): string {
  const exactRuntimeSha = requireDigest(runtimeSha, RUNTIME_SHA_HEX, 'runtimeSha');
  const exactArtifactDigest = requireDigest(
    artifactDigest,
    SHA256_HEX,
    'artifactDigest',
  );
  return `routing-action-skill:${exactRuntimeSha}:${exactArtifactDigest}`;
}

/** Reproduce the exact flag-on user content (utterance plus shortlist). */
export function buildRoutingActionSkillRequestIdentity(
  utteranceText: string,
  promptSha256: string,
): RoutingActionSkillRequestIdentity {
  if (!SHA256_HEX.test(promptSha256)) {
    throw new Error('promptSha256 must be a lowercase SHA-256 digest');
  }
  const shortlist = buildClassifierCandidateShortlist(utteranceText);
  const requestText = shortlist ? `${utteranceText}\n\n${shortlist}` : utteranceText;
  return {
    requestText,
    requestSha256: sha256(
      `${ROUTING_ACTION_SKILL_REQUEST_BUILDER_VERSION}\0${promptSha256}\0${requestText}`,
    ),
  };
}

export interface StoreRoutingActionSkillPredictionInput
  extends RoutingActionSkillSourceIdentityInput {
  planDigest: string;
  corpusIdentityDigest: string;
  utteranceHash: string;
  utteranceText: string;
  predictedDomain: string;
  /** Null means the classifier omitted its optional skill: a covered abstention. */
  predictedSkill: string | null;
  confidence: number;
  apiUsageId: number;
  runId: string;
}

/**
 * Validated persistence seam for a separately authorized refresh runner.
 * It performs no provider work; it only refuses predictions without exact,
 * successful metering evidence or manifest-valid normalized output.
 */
export function storeRoutingActionSkillPrediction(
  input: StoreRoutingActionSkillPredictionInput,
  db: Database.Database = getDb(),
): void {
  if (!SHA256_HEX.test(input.utteranceHash)) {
    throw new Error('utteranceHash must be a lowercase SHA-256 digest');
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
  if (!Number.isSafeInteger(input.apiUsageId) || input.apiUsageId <= 0) {
    throw new Error('apiUsageId must be a positive integer');
  }
  const runId = requireNonEmpty(input.runId, 'runId');
  if (runId.length > 160) throw new Error('runId must be at most 160 characters');
  if (!PLAN_DIGEST.test(input.planDigest)) {
    throw new Error('planDigest must be a canonical sha256 digest');
  }
  if (!PLAN_DIGEST.test(input.corpusIdentityDigest)) {
    throw new Error('corpusIdentityDigest must be a canonical sha256 digest');
  }

  const sourceIdentity = buildRoutingActionSkillSourceIdentity(input);
  if (runId !== sourceIdentity.releaseRunId) {
    throw new Error('runId does not match the exact runtime and artifact release identity');
  }
  const currentCorpusIdentity = buildRoutingActionSkillCorpusIdentity(db).digest;
  if (input.corpusIdentityDigest !== currentCorpusIdentity) {
    throw new Error('Prediction corpus identity does not match the canonical labeled corpus');
  }
  const requestIdentity = buildRoutingActionSkillRequestIdentity(
    input.utteranceText,
    sourceIdentity.promptSha256,
  );
  const candidates = getRoutingLabelCandidates();
  if (
    !candidates.domains.includes(input.predictedDomain)
    && !candidates.specialLabels.includes(input.predictedDomain)
  ) {
    throw new Error(`Unknown predicted domain: ${input.predictedDomain}`);
  }
  if (
    (candidates.specialLabels.includes(input.predictedDomain) && input.predictedSkill !== null)
    || (
      !candidates.specialLabels.includes(input.predictedDomain)
      && input.predictedSkill !== null
      && !(candidates.skillsByDomain[input.predictedDomain] ?? []).includes(input.predictedSkill)
    )
  ) {
    throw new Error(
      `Predicted skill ${input.predictedSkill} does not belong to predicted domain ${input.predictedDomain}`,
    );
  }

  const corpusRow = db.prepare(`
    SELECT 1
    FROM routing_corpus_items
    WHERE utterance_hash = ?
      AND utterance_text = ?
      AND label_status = 'labeled'
  `).get(input.utteranceHash, input.utteranceText);
  if (!corpusRow) {
    throw new Error('Refusing to cache a prediction outside the exact labeled routing corpus row');
  }

  const authorizedPlan = db.prepare(`
    SELECT 1
    FROM routing_manifest_skill_refresh_plan_claims p
    JOIN routing_manifest_skill_refresh_runs r
      ON r.runtime_sha = p.runtime_sha
     AND r.artifact_digest = p.artifact_digest
     AND r.run_id = p.run_id
    WHERE p.plan_digest = ?
      AND p.corpus_identity_digest = ?
      AND p.runtime_sha = ?
      AND p.artifact_digest = ?
      AND p.run_id = ?
      AND p.status = 'active'
      AND r.prompt_sha256 = ?
      AND r.request_builder_version = ?
      AND r.provider = ?
      AND r.model = ?
      AND r.usage_category = ?
      AND r.request_source = ?
      AND r.base_category = ?
      AND r.job_name = ?
      AND r.user_id = ?
      AND r.tenant_id = ?
  `).get(
    input.planDigest,
    input.corpusIdentityDigest,
    sourceIdentity.runtimeSha,
    sourceIdentity.artifactDigest,
    runId,
    sourceIdentity.promptSha256,
    sourceIdentity.requestBuilderVersion,
    sourceIdentity.provider,
    sourceIdentity.model,
    sourceIdentity.usageCategory,
    sourceIdentity.requestSource,
    sourceIdentity.baseCategory,
    sourceIdentity.jobName,
    sourceIdentity.userId,
    sourceIdentity.tenantId,
  );
  if (!authorizedPlan) {
    throw new Error(
      'Prediction is not bound to the active exact release refresh plan and shared budget run',
    );
  }

  const usageRow = db.prepare(`
    SELECT id
    FROM api_usage
    WHERE id = ?
      AND category = ?
      AND provider = ?
      AND model = ?
      AND run_id = ?
      AND request_source = ?
      AND base_category = ?
      AND job_name = ?
      AND user_id = ?
      AND tenant_id = ?
      AND pricing_status = 'resolved'
      AND input_tokens > 0
      AND output_tokens > 0
      AND cost_usd >= 0
  `).get(
    input.apiUsageId,
    sourceIdentity.usageCategory,
    sourceIdentity.provider,
    sourceIdentity.model,
    runId,
    sourceIdentity.requestSource,
    sourceIdentity.baseCategory,
    sourceIdentity.jobName,
    sourceIdentity.userId,
    sourceIdentity.tenantId,
  );
  if (!usageRow) {
    throw new Error(
      'Prediction is not bound to one successful resolved api_usage row for the exact provider, model, category, and run',
    );
  }

  db.prepare(`
    INSERT INTO routing_manifest_skill_classify_cache (
      runtime_sha, artifact_digest, plan_digest, corpus_identity_digest,
      utterance_hash, prompt_sha256, request_builder_version, request_sha256,
      provider, model, usage_category, predicted_domain, predicted_skill,
      confidence, api_usage_id, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceIdentity.runtimeSha,
    sourceIdentity.artifactDigest,
    input.planDigest,
    input.corpusIdentityDigest,
    input.utteranceHash,
    sourceIdentity.promptSha256,
    sourceIdentity.requestBuilderVersion,
    requestIdentity.requestSha256,
    sourceIdentity.provider,
    sourceIdentity.model,
    sourceIdentity.usageCategory,
    input.predictedDomain,
    input.predictedSkill,
    input.confidence,
    input.apiUsageId,
    runId,
  );
}

export interface RunRoutingActionSkillAccuracyOptions
  extends RoutingActionSkillSourceIdentityInput {
  db?: Database.Database;
  generatedAt?: string;
}

interface ScoredPrediction {
  item: RoutingCorpusItem;
  covered: boolean;
  predictedDomain: string | null;
  predictedSkill: string | null;
  planDigest: string | null;
}

export function runRoutingActionSkillAccuracy(
  options: RunRoutingActionSkillAccuracyOptions,
): RoutingActionSkillAccuracyReport {
  const db = options.db ?? getDb();
  const sourceIdentity = buildRoutingActionSkillSourceIdentity(options);
  const items = listLabeledRoutingCorpusItemsReadOnly(db);
  const corpusIdentityDigest = routingActionSkillCorpusIdentityDigest(items);
  const candidates = getRoutingLabelCandidates();
  const completedPlanDigests = (db.prepare(`
    SELECT plan_digest AS planDigest
    FROM routing_manifest_skill_refresh_plan_claims
    WHERE runtime_sha = ?
      AND artifact_digest = ?
      AND run_id = ?
      AND corpus_identity_digest = ?
      AND status = 'completed'
    ORDER BY plan_sequence ASC
  `).all(
    sourceIdentity.runtimeSha,
    sourceIdentity.artifactDigest,
    sourceIdentity.releaseRunId,
    corpusIdentityDigest,
  ) as Array<{ planDigest: string }>).map((row) => row.planDigest);
  const terminalPlan = db.prepare(`
    SELECT plan_sequence AS planSequence,
           plan_digest AS planDigest,
           status
    FROM routing_manifest_skill_refresh_plan_claims
    WHERE runtime_sha = ?
      AND artifact_digest = ?
      AND run_id = ?
      AND corpus_identity_digest = ?
    ORDER BY plan_sequence DESC
    LIMIT 1
  `).get(
    sourceIdentity.runtimeSha,
    sourceIdentity.artifactDigest,
    sourceIdentity.releaseRunId,
    corpusIdentityDigest,
  ) as {
    planSequence: number;
    planDigest: string;
    status: 'active' | 'failed' | 'completed';
  } | undefined;
  const hasTerminalCompletedReceipt = terminalPlan?.status === 'completed';
  const scored = items.map((item) => scoreItem(
    item,
    sourceIdentity,
    corpusIdentityDigest,
    hasTerminalCompletedReceipt,
    candidates,
    db,
  ));
  const coveredRows = scored.filter((row) => row.covered);
  const correct = coveredRows.filter(isCorrectPrediction).length;
  const covered = coveredRows.length;
  const expectedAbstentionRows = items.filter((item) => item.labelSkill === null).length;
  const predictedAbstentions = coveredRows.filter((row) => row.predictedSkill === null).length;
  const agreement = ratio(correct, covered);
  const reasons = assessRoutingActionSkillCorpusReadiness(items, candidates);
  const releaseRun = db.prepare(`
    SELECT budget_usd AS hardBudgetUsd
    FROM routing_manifest_skill_refresh_runs
    WHERE runtime_sha = ?
      AND artifact_digest = ?
      AND run_id = ?
      AND prompt_sha256 = ?
      AND request_builder_version = ?
      AND provider = ?
      AND model = ?
      AND usage_category = ?
      AND request_source = ?
      AND base_category = ?
      AND job_name = ?
      AND user_id = ?
      AND tenant_id = ?
  `).get(
    sourceIdentity.runtimeSha,
    sourceIdentity.artifactDigest,
    sourceIdentity.releaseRunId,
    sourceIdentity.promptSha256,
    sourceIdentity.requestBuilderVersion,
    sourceIdentity.provider,
    sourceIdentity.model,
    sourceIdentity.usageCategory,
    sourceIdentity.requestSource,
    sourceIdentity.baseCategory,
    sourceIdentity.jobName,
    sourceIdentity.userId,
    sourceIdentity.tenantId,
  ) as { hardBudgetUsd: number } | undefined;

  if (items.length !== ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT) {
    reasons.push(
      `action-skill gate requires exactly ${ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT} labeled corpus rows; found ${items.length}`,
    );
  }
  const domainOnlyRows = items.filter((item) => (
    item.labelSkill === null && !candidates.specialLabels.includes(item.labelDomain ?? '')
  ));
  if (domainOnlyRows.length > 0) {
    reasons.push(
      `action-skill gate requires a skill label on every non-special row; found ${domainOnlyRows.length} domain-only labels`,
    );
  }
  if (covered !== ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT) {
    reasons.push(
      `action-skill gate requires ${ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT} exact-bound cache rows; found ${covered}`,
    );
  }
  if (agreement === null || agreement < ROUTING_ACTION_SKILL_MIN_AGREEMENT) {
    reasons.push(
      `action-skill agreement ${agreement === null ? 'unavailable' : agreement} is below ${ROUTING_ACTION_SKILL_MIN_AGREEMENT}`,
    );
  }
  if (!releaseRun) {
    reasons.push('action-skill gate has no exact release-bound refresh run and hard budget');
  }
  if (!hasTerminalCompletedReceipt) {
    reasons.push(
      'action-skill gate requires the latest refresh plan for the current corpus identity to be completed',
    );
  }

  return {
    version: ROUTING_ACTION_SKILL_ACCURACY_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    corpusIdentityDigest,
    sourceIdentity,
    releaseEvidence: {
      hardBudgetUsd: releaseRun?.hardBudgetUsd ?? null,
      planDigests: [...new Set(
        coveredRows
          .map((row) => row.planDigest)
          .filter((digest): digest is string => digest !== null),
      )].sort(),
      completedPlanDigests,
      terminalPlanSequence: terminalPlan?.planSequence ?? null,
      terminalPlanDigest: terminalPlan?.planDigest ?? null,
      terminalPlanStatus: terminalPlan?.status ?? null,
    },
    itemCount: items.length,
    covered,
    uncovered: items.length - covered,
    coverage: ratio(covered, items.length),
    correct,
    agreement,
    expectedSkillRows: items.length - expectedAbstentionRows,
    expectedAbstentionRows,
    predictedAbstentions,
    perSkill: candidates.skills.map((skill) => computeSkillMetric(skill, scored)),
    specialLabels: candidates.specialLabels.map((label) => (
      computeSpecialLabelMetric(label, scored)
    )),
    gate: {
      passed: reasons.length === 0,
      requiredItemCount: ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT,
      requiredCovered: ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT,
      minimumAgreement: ROUTING_ACTION_SKILL_MIN_AGREEMENT,
      reasons,
    },
  };
}

function scoreItem(
  item: RoutingCorpusItem,
  source: RoutingActionSkillSourceIdentity,
  corpusIdentityDigest: string,
  hasTerminalCompletedReceipt: boolean,
  candidates: ReturnType<typeof getRoutingLabelCandidates>,
  db: Database.Database,
): ScoredPrediction {
  if (!hasTerminalCompletedReceipt) {
    return {
      item,
      covered: false,
      predictedDomain: null,
      predictedSkill: null,
      planDigest: null,
    };
  }
  const request = buildRoutingActionSkillRequestIdentity(
    item.utteranceText ?? '',
    source.promptSha256,
  );
  const row = db.prepare(`
    SELECT c.predicted_domain AS predictedDomain,
           c.predicted_skill AS predictedSkill,
           c.plan_digest AS planDigest
    FROM routing_manifest_skill_classify_cache c
    JOIN api_usage u ON u.id = c.api_usage_id
    JOIN routing_manifest_skill_refresh_runs r
      ON r.runtime_sha = c.runtime_sha
     AND r.artifact_digest = c.artifact_digest
     AND r.run_id = c.run_id
    JOIN routing_manifest_skill_refresh_plan_claims p
      ON p.plan_digest = c.plan_digest
     AND p.corpus_identity_digest = c.corpus_identity_digest
     AND p.runtime_sha = c.runtime_sha
     AND p.artifact_digest = c.artifact_digest
     AND p.run_id = c.run_id
    WHERE c.utterance_hash = ?
      AND c.runtime_sha = ?
      AND c.artifact_digest = ?
      AND c.run_id = ?
      AND c.corpus_identity_digest = ?
      AND c.prompt_sha256 = ?
      AND c.request_builder_version = ?
      AND c.request_sha256 = ?
      AND c.provider = ?
      AND c.model = ?
      AND c.usage_category = ?
      AND u.category = c.usage_category
      AND u.provider = c.provider
      AND u.model = c.model
      AND u.run_id = c.run_id
      AND u.request_source = ?
      AND u.base_category = ?
      AND u.job_name = ?
      AND u.user_id = ?
      AND u.tenant_id = ?
      AND u.pricing_status = 'resolved'
      AND u.input_tokens > 0
      AND u.output_tokens > 0
      AND u.cost_usd >= 0
      AND r.prompt_sha256 = c.prompt_sha256
      AND r.request_builder_version = c.request_builder_version
      AND r.provider = c.provider
      AND r.model = c.model
      AND r.usage_category = c.usage_category
      AND r.request_source = ?
      AND r.base_category = ?
      AND r.job_name = ?
      AND r.user_id = ?
      AND r.tenant_id = ?
      AND p.status IN ('failed', 'completed')
    LIMIT 1
  `).get(
    item.utteranceHash,
    source.runtimeSha,
    source.artifactDigest,
    source.releaseRunId,
    corpusIdentityDigest,
    source.promptSha256,
    source.requestBuilderVersion,
    request.requestSha256,
    source.provider,
    source.model,
    source.usageCategory,
    source.requestSource,
    source.baseCategory,
    source.jobName,
    source.userId,
    source.tenantId,
    source.requestSource,
    source.baseCategory,
    source.jobName,
    source.userId,
    source.tenantId,
  ) as {
    predictedDomain: string;
    predictedSkill: string | null;
    planDigest: string;
  } | undefined;

  if (
    !row
    || (
      !candidates.domains.includes(row.predictedDomain)
      && !candidates.specialLabels.includes(row.predictedDomain)
    )
  ) {
    return {
      item,
      covered: false,
      predictedDomain: null,
      predictedSkill: null,
      planDigest: null,
    };
  }
  if (
    (candidates.specialLabels.includes(row.predictedDomain) && row.predictedSkill !== null)
    || (
      !candidates.specialLabels.includes(row.predictedDomain)
      && row.predictedSkill !== null
      && !(candidates.skillsByDomain[row.predictedDomain] ?? []).includes(row.predictedSkill)
    )
  ) {
    return {
      item,
      covered: false,
      predictedDomain: null,
      predictedSkill: null,
      planDigest: null,
    };
  }
  return {
    item,
    covered: true,
    predictedDomain: row.predictedDomain,
    predictedSkill: row.predictedSkill,
    planDigest: row.planDigest,
  };
}

function isCorrectPrediction(row: ScoredPrediction): boolean {
  return row.covered
    && row.predictedDomain === row.item.labelDomain
    && row.predictedSkill === row.item.labelSkill;
}

function computeSkillMetric(
  skill: string,
  rows: ScoredPrediction[],
): RoutingActionSkillMetric {
  const support = rows.filter((row) => row.item.labelSkill === skill).length;
  const predicted = rows.filter((row) => row.covered && row.predictedSkill === skill).length;
  const truePositives = rows.filter((row) => (
    row.covered && row.item.labelSkill === skill && row.predictedSkill === skill
  )).length;
  return {
    skill,
    support,
    predicted,
    truePositives,
    falsePositives: predicted - truePositives,
    falseNegatives: support - truePositives,
    precision: ratio(truePositives, predicted),
    recall: ratio(truePositives, support),
  };
}

function computeSpecialLabelMetric(
  label: string,
  rows: ScoredPrediction[],
): RoutingActionSkillSpecialLabelMetric {
  const matching = rows.filter((row) => row.item.labelDomain === label);
  const covered = matching.filter((row) => row.covered);
  const predictedAbstentions = covered.filter((row) => row.predictedSkill === null).length;
  const correctAbstentions = covered.filter((row) => (
    row.predictedDomain === label && row.predictedSkill === null
  )).length;
  return {
    label,
    support: matching.length,
    covered: covered.length,
    predictedAbstentions,
    correctAbstentions,
    abstentionAgreement: ratio(correctAbstentions, covered.length),
  };
}

function routingActionSkillCorpusIdentityDigest(items: RoutingCorpusItem[]): string {
  const identity = items.map((item) => ({
    id: item.id,
    tenantId: item.tenantId,
    userId: item.userId,
    utteranceHash: item.utteranceHash,
    utteranceTextSha256: sha256(item.utteranceText ?? ''),
    source: item.source,
    labelDomain: item.labelDomain,
    labelSkill: item.labelSkill,
    labelStatus: item.labelStatus,
    labeledAt: item.labeledAt,
  }));
  return `sha256:${sha256(JSON.stringify(identity))}`;
}

/**
 * SELECT-only corpus reader. The portal-oriented public list helper performs
 * defensive CREATE TABLE calls; release evidence must also work on a SQLite
 * connection opened with `readonly: true`.
 */
function listLabeledRoutingCorpusItemsReadOnly(db: Database.Database): RoutingCorpusItem[] {
  return db.prepare(`
    SELECT id,
           tenant_id AS tenantId,
           user_id AS userId,
           utterance_hash AS utteranceHash,
           utterance_text AS utteranceText,
           source,
           suggested_domain AS suggestedDomain,
           suggested_skill AS suggestedSkill,
           label_domain AS labelDomain,
           label_skill AS labelSkill,
           label_status AS labelStatus,
           labeled_at AS labeledAt,
           created_at AS createdAt
    FROM routing_corpus_items
    WHERE label_status = 'labeled' AND utterance_text IS NOT NULL
    ORDER BY created_at ASC, id ASC
  `).all() as RoutingCorpusItem[];
}

/** Read-only mirror of the accepted corpus-shape policy used by Phase 4. */
function assessRoutingActionSkillCorpusReadiness(
  items: RoutingCorpusItem[],
  candidates: ReturnType<typeof getRoutingLabelCandidates>,
): string[] {
  const reasons: string[] = [];
  const byDomain = new Map<string, number>();
  const bySkill = new Map<string, number>();
  for (const item of items) {
    if (item.labelDomain) {
      byDomain.set(item.labelDomain, (byDomain.get(item.labelDomain) ?? 0) + 1);
    }
    if (item.labelSkill) {
      bySkill.set(item.labelSkill, (bySkill.get(item.labelSkill) ?? 0) + 1);
    }
  }
  if (items.length < ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT) {
    reasons.push(
      `requires at least ${ROUTING_ACTION_SKILL_REQUIRED_ITEM_COUNT} labeled items; found ${items.length}`,
    );
  }
  for (const domain of candidates.domains) {
    const count = byDomain.get(domain) ?? 0;
    if (count < ROUTING_ACTION_SKILL_MIN_DOMAIN_LABELS) {
      reasons.push(
        `domain ${domain} requires at least ${ROUTING_ACTION_SKILL_MIN_DOMAIN_LABELS} labels; found ${count}`,
      );
    }
  }
  for (const skill of candidates.skills) {
    const count = bySkill.get(skill) ?? 0;
    if (count < ROUTING_ACTION_SKILL_MIN_SKILL_LABELS) {
      reasons.push(
        `skill ${skill} requires at least ${ROUTING_ACTION_SKILL_MIN_SKILL_LABELS} labels; found ${count}`,
      );
    }
  }
  for (const special of candidates.specialLabels) {
    const count = byDomain.get(special) ?? 0;
    if (count < ROUTING_ACTION_SKILL_MIN_SPECIAL_LABELS) {
      reasons.push(
        `special label ${special} requires at least ${ROUTING_ACTION_SKILL_MIN_SPECIAL_LABELS} labels; found ${count}`,
      );
    }
  }
  return reasons;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${name} must be a non-empty string`);
  return normalized;
}

function requireDigest(value: string, pattern: RegExp, name: string): string {
  const normalized = String(value ?? '').trim();
  if (!pattern.test(normalized)) {
    throw new Error(`${name} must be a full lowercase hexadecimal digest`);
  }
  return normalized;
}

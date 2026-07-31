// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRoutingActionSkillCorpusIdentity,
  buildRoutingActionSkillRequestIdentity,
  buildRoutingActionSkillSourceIdentity,
  ROUTING_ACTION_SKILL_ACCURACY_VERSION,
  ROUTING_ACTION_SKILL_MIN_AGREEMENT,
  ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY,
  ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
  ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE,
  ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
  ROUTING_ACTION_SKILL_USAGE_USER_ID,
  runRoutingActionSkillAccuracy,
  storeRoutingActionSkillPrediction,
} from '../../src/services/routing-action-skill-accuracy';
import {
  ensureRoutingCorpusTables,
  getRoutingLabelCandidates,
} from '../../src/services/routing-corpus';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION = fs.readFileSync(
  path.join(REPO_ROOT, 'migrations', '266_routing_manifest_skill_classify_cache.sql'),
  'utf8',
);
const PROVIDER = 'gemini';
const MODEL = 'gemini-2.5-flash-lite';
const USAGE_CATEGORY = 'gemini_classify';
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const RELEASE_RUN_ID = `routing-action-skill:${RUNTIME_SHA}:${ARTIFACT_DIGEST}`;
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const RELEASE_IDENTITY = {
  runtimeSha: RUNTIME_SHA,
  artifactDigest: ARTIFACT_DIGEST,
};

interface SeededCorpusRow {
  id: number;
  utteranceHash: string;
  utteranceText: string;
  labelDomain: string;
  labelSkill: string | null;
}

function shaHex(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function insertCorpusRow(
  db: Database.Database,
  seed: number,
  labelDomain: string,
  labelSkill: string | null,
): SeededCorpusRow {
  const utteranceHash = shaHex(seed + 1);
  const utteranceText = `Synthetic routing control ${seed} for ${labelSkill ?? labelDomain}`;
  const result = db.prepare(`
    INSERT INTO routing_corpus_items (
      tenant_id, user_id, utterance_hash, utterance_text, source,
      label_domain, label_skill, label_status, labeled_at, created_at
    ) VALUES (0, NULL, ?, ?, 'manual', ?, ?, 'labeled', ?, ?)
  `).run(
    utteranceHash,
    utteranceText,
    labelDomain,
    labelSkill,
    '2026-07-31T00:00:00.000Z',
    `2026-07-31T00:${String(Math.floor(seed / 60)).padStart(2, '0')}:${String(seed % 60).padStart(2, '0')}.000Z`,
  );
  return {
    id: Number(result.lastInsertRowid),
    utteranceHash,
    utteranceText,
    labelDomain,
    labelSkill,
  };
}

function seedCanonicalCorpus(db: Database.Database): SeededCorpusRow[] {
  const candidates = getRoutingLabelCandidates();
  const ownerBySkill = new Map<string, string>();
  for (const [domain, skills] of Object.entries(candidates.skillsByDomain)) {
    for (const skill of skills) ownerBySkill.set(skill, domain);
  }

  const rows: SeededCorpusRow[] = [];
  for (const skill of candidates.skills) {
    const domain = ownerBySkill.get(skill);
    if (!domain) throw new Error(`test fixture has no owner domain for ${skill}`);
    for (let i = 0; i < 20; i += 1) {
      rows.push(insertCorpusRow(db, rows.length, domain, skill));
    }
  }
  while (rows.length < 284) {
    const skill = candidates.skills[rows.length % candidates.skills.length];
    const domain = ownerBySkill.get(skill);
    if (!domain) throw new Error(`test fixture has no owner domain for ${skill}`);
    rows.push(insertCorpusRow(db, rows.length, domain, skill));
  }
  for (const special of candidates.specialLabels) {
    for (let i = 0; i < 8; i += 1) {
      rows.push(insertCorpusRow(db, rows.length, special, null));
    }
  }
  expect(rows).toHaveLength(300);
  return rows;
}

function insertSuccessfulUsage(db: Database.Database, runId: string): number {
  return Number(db.prepare(`
    INSERT INTO api_usage (
      category, model, provider, run_id, pricing_status,
      request_source, base_category, job_name, user_id, tenant_id,
      input_tokens, output_tokens, cost_usd
    ) VALUES (?, ?, ?, ?, 'resolved', ?, ?, ?, ?, ?, 100, 10, 0.000014)
  `).run(
    USAGE_CATEGORY,
    MODEL,
    PROVIDER,
    runId,
    ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE,
    ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY,
    ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
    ROUTING_ACTION_SKILL_USAGE_USER_ID,
    ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
  ).lastInsertRowid);
}

function cachePrediction(
  db: Database.Database,
  row: SeededCorpusRow,
  predictedSkill: string | null = row.labelSkill,
  predictedDomain: string = row.labelDomain,
): void {
  const corpusIdentityDigest = ensureActivePlanForCurrentCorpus(db);
  const runId = RELEASE_RUN_ID;
  const apiUsageId = insertSuccessfulUsage(db, runId);
  storeRoutingActionSkillPrediction({
    ...RELEASE_IDENTITY,
    planDigest: PLAN_DIGEST,
    corpusIdentityDigest,
    utteranceHash: row.utteranceHash,
    utteranceText: row.utteranceText,
    provider: PROVIDER,
    model: MODEL,
    usageCategory: USAGE_CATEGORY,
    predictedDomain,
    predictedSkill,
    confidence: 0.99,
    apiUsageId,
    runId,
  }, db);
}

function ensureActivePlanForCurrentCorpus(db: Database.Database): string {
  const corpusIdentityDigest = buildRoutingActionSkillCorpusIdentity(db).digest;
  const existing = db.prepare(`
    SELECT corpus_identity_digest AS corpusIdentityDigest
    FROM routing_manifest_skill_refresh_plan_claims
    WHERE plan_digest = ?
  `).get(PLAN_DIGEST) as { corpusIdentityDigest: string } | undefined;
  if (existing) {
    expect(existing.corpusIdentityDigest).toBe(corpusIdentityDigest);
    return corpusIdentityDigest;
  }
  db.prepare(`
    INSERT INTO routing_manifest_skill_refresh_plan_claims (
      plan_digest, plan_sequence, corpus_identity_digest,
      runtime_sha, artifact_digest, run_id, status, claim_token
    ) VALUES (?, 1, ?, ?, ?, ?, 'active', 'accuracy-test-claim')
  `).run(PLAN_DIGEST, corpusIdentityDigest, RUNTIME_SHA, ARTIFACT_DIGEST, RELEASE_RUN_ID);
  return corpusIdentityDigest;
}

function completePlan(db: Database.Database): void {
  db.prepare(`
    UPDATE routing_manifest_skill_refresh_plan_claims
    SET status = 'completed', claim_token = NULL
    WHERE plan_digest = ? AND status = 'active'
  `).run(PLAN_DIGEST);
}

describe('routing action-skill accuracy — cache-only manifest-prompt gate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        run_id TEXT,
        request_source TEXT NOT NULL DEFAULT 'interactive',
        base_category TEXT,
        job_name TEXT,
        user_id INTEGER NOT NULL DEFAULT 0,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        pricing_status TEXT NOT NULL DEFAULT 'resolved',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0
      );
    `);
    ensureRoutingCorpusTables(db);
    db.exec(MIGRATION);
    const source = buildRoutingActionSkillSourceIdentity({
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    db.prepare(`
      INSERT INTO routing_manifest_skill_refresh_runs (
        runtime_sha, artifact_digest, run_id, budget_usd,
        prompt_sha256, request_builder_version, provider, model,
        usage_category, request_source, base_category, job_name, user_id, tenant_id
      ) VALUES (?, ?, ?, 0.05, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      RUNTIME_SHA,
      ARTIFACT_DIGEST,
      RELEASE_RUN_ID,
      source.promptSha256,
      source.requestBuilderVersion,
      PROVIDER,
      MODEL,
      USAGE_CATEGORY,
      ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE,
      ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY,
      ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
      ROUTING_ACTION_SKILL_USAGE_USER_ID,
      ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
    );
  });

  afterEach(() => db.close());

  it('requires an exact terminal domain plus omitted skill for a correct abstention', () => {
    const task = insertCorpusRow(db, 1, 'secretary', 'tasks');
    const clarify = insertCorpusRow(db, 2, 'clarify', null);
    insertCorpusRow(db, 3, 'none', null);
    cachePrediction(db, task);
    cachePrediction(db, clarify, null, 'secretary');
    completePlan(db);

    const report = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      generatedAt: '2026-07-31T12:00:00.000Z',
    });

    expect(report.version).toBe(ROUTING_ACTION_SKILL_ACCURACY_VERSION);
    expect(report.sourceIdentity).toMatchObject({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      releaseRunId: RELEASE_RUN_ID,
      requestSource: ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE,
      baseCategory: ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY,
      jobName: ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
      userId: ROUTING_ACTION_SKILL_USAGE_USER_ID,
      tenantId: ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
    });
    expect(report.itemCount).toBe(3);
    expect(report.covered).toBe(2);
    expect(report.uncovered).toBe(1);
    expect(report.correct).toBe(1);
    expect(report.predictedAbstentions).toBe(1);
    expect(report.expectedAbstentionRows).toBe(2);
    expect(report.specialLabels.find((entry) => entry.label === 'clarify')).toMatchObject({
      support: 1,
      covered: 1,
      correctAbstentions: 0,
    });
    expect(report.specialLabels.find((entry) => entry.label === 'none')).toMatchObject({
      support: 1,
      covered: 0,
      correctAbstentions: 0,
    });
    expect(report.gate.passed).toBe(false);
  });

  it('keeps report and corpus-identity reads valid under SQLite query-only enforcement', () => {
    const row = insertCorpusRow(db, 1, 'secretary', 'tasks');
    cachePrediction(db, row);
    completePlan(db);
    db.pragma('query_only = ON');

    expect(() => runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    })).not.toThrow();
  });

  it('requires exact prompt, request, provider, model, usage-row, and run binding', () => {
    const row = insertCorpusRow(db, 1, 'secretary', 'tasks');
    cachePrediction(db, row);
    completePlan(db);

    const source = buildRoutingActionSkillSourceIdentity({
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    const request = buildRoutingActionSkillRequestIdentity(row.utteranceText, source.promptSha256);
    const stored = db.prepare(`
      SELECT prompt_sha256 AS promptSha256,
             request_builder_version AS requestBuilderVersion,
             request_sha256 AS requestSha256,
             runtime_sha AS runtimeSha, artifact_digest AS artifactDigest,
             plan_digest AS planDigest,
             corpus_identity_digest AS corpusIdentityDigest,
             provider, model, usage_category AS usageCategory,
             api_usage_id AS apiUsageId, run_id AS runId
      FROM routing_manifest_skill_classify_cache
    `).get() as Record<string, unknown>;
    expect(stored).toMatchObject({
      promptSha256: source.promptSha256,
      requestBuilderVersion: source.requestBuilderVersion,
      requestSha256: request.requestSha256,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      planDigest: PLAN_DIGEST,
      corpusIdentityDigest: buildRoutingActionSkillCorpusIdentity(db).digest,
      runId: RELEASE_RUN_ID,
    });

    db.prepare('UPDATE api_usage SET request_source = ? WHERE id = ?')
      .run('interactive', stored.apiUsageId);
    const wrongSource = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(wrongSource.covered).toBe(0);

    db.prepare('UPDATE api_usage SET request_source = ?, base_category = ? WHERE id = ?')
      .run(ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE, 'wrong-base', stored.apiUsageId);
    const wrongBase = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(wrongBase.covered).toBe(0);

    db.prepare('UPDATE api_usage SET base_category = ?, run_id = ? WHERE id = ?')
      .run(ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY, 'different-run', stored.apiUsageId);
    const wrongRun = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(wrongRun.covered).toBe(0);
    expect(wrongRun.uncovered).toBe(1);

    db.prepare('UPDATE api_usage SET run_id = ?, job_name = ? WHERE id = ?')
      .run(stored.runId, 'different-job', stored.apiUsageId);
    expect(runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    }).covered).toBe(0);

    db.prepare('UPDATE api_usage SET job_name = ?, user_id = ? WHERE id = ?')
      .run(ROUTING_ACTION_SKILL_USAGE_JOB_NAME, 42, stored.apiUsageId);
    expect(runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    }).covered).toBe(0);

    db.prepare('UPDATE api_usage SET user_id = ?, tenant_id = ? WHERE id = ?')
      .run(ROUTING_ACTION_SKILL_USAGE_USER_ID, 42, stored.apiUsageId);
    expect(runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    }).covered).toBe(0);
  });

  it('does not reuse cache evidence across a different runtime or artifact identity', () => {
    const row = insertCorpusRow(db, 1, 'secretary', 'tasks');
    cachePrediction(db, row);
    completePlan(db);

    expect(runRoutingActionSkillAccuracy({
      db,
      runtimeSha: 'd'.repeat(40),
      artifactDigest: ARTIFACT_DIGEST,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    })).toMatchObject({ covered: 0, uncovered: 1, correct: 0 });
    expect(runRoutingActionSkillAccuracy({
      db,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: 'e'.repeat(64),
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    })).toMatchObject({ covered: 0, uncovered: 1, correct: 0 });
  });

  it('excludes active and failed-plan rows until the current corpus has a completed receipt', () => {
    const row = insertCorpusRow(db, 1, 'secretary', 'tasks');
    cachePrediction(db, row);

    const active = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(active).toMatchObject({ covered: 0, correct: 0 });
    expect(active.gate.reasons.join(' ')).toMatch(/latest.*completed/i);

    db.prepare(`
      UPDATE routing_manifest_skill_refresh_plan_claims
      SET status = 'failed', claim_token = NULL
      WHERE plan_digest = ?
    `).run(PLAN_DIGEST);
    expect(runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    }).covered).toBe(0);

    const receiptDigest = `sha256:${'e'.repeat(64)}`;
    const corpusIdentityDigest = buildRoutingActionSkillCorpusIdentity(db).digest;
    db.prepare(`
      INSERT INTO routing_manifest_skill_refresh_plan_claims (
        plan_digest, plan_sequence, corpus_identity_digest,
        runtime_sha, artifact_digest, run_id, status, claim_token
      ) VALUES (?, 2, ?, ?, ?, ?, 'completed', NULL)
    `).run(
      receiptDigest,
      corpusIdentityDigest,
      RUNTIME_SHA,
      ARTIFACT_DIGEST,
      RELEASE_RUN_ID,
    );
    const receipted = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(receipted).toMatchObject({ covered: 1, correct: 1 });
    expect(receipted.releaseEvidence).toMatchObject({
      planDigests: [PLAN_DIGEST],
      completedPlanDigests: [receiptDigest],
    });
  });

  it('invalidates completed cache evidence when the canonical corpus labels change', () => {
    const row = insertCorpusRow(db, 1, 'secretary', 'tasks');
    cachePrediction(db, row);
    completePlan(db);
    const before = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(before.covered).toBe(1);

    db.prepare(`
      UPDATE routing_corpus_items
      SET label_skill = 'mail', labeled_at = '2026-07-31T13:00:00.000Z'
      WHERE id = ?
    `).run(row.id);
    const after = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(after).toMatchObject({ covered: 0, correct: 0 });
    expect(after.corpusIdentityDigest).not.toBe(before.corpusIdentityDigest);
    expect(after.gate.reasons.join(' ')).toMatch(/latest.*completed/i);
  });

  it('refuses to cache a prediction without a successful resolved usage row or with an invalid skill owner', () => {
    const row = insertCorpusRow(db, 1, 'secretary', 'tasks');
    const corpusIdentityDigest = ensureActivePlanForCurrentCorpus(db);
    const timeoutUsageId = Number(db.prepare(`
      INSERT INTO api_usage (
        category, model, provider, run_id, pricing_status,
        request_source, base_category, job_name, user_id, tenant_id,
        input_tokens, output_tokens, cost_usd
      ) VALUES (?, ?, ?, 'timeout-run', 'timeout-estimate', ?, ?, ?, ?, ?, 0, 0, 0.01)
    `).run(
      USAGE_CATEGORY,
      MODEL,
      PROVIDER,
      ROUTING_ACTION_SKILL_USAGE_REQUEST_SOURCE,
      ROUTING_ACTION_SKILL_USAGE_BASE_CATEGORY,
      ROUTING_ACTION_SKILL_USAGE_JOB_NAME,
      ROUTING_ACTION_SKILL_USAGE_USER_ID,
      ROUTING_ACTION_SKILL_USAGE_TENANT_ID,
    ).lastInsertRowid);

    expect(() => storeRoutingActionSkillPrediction({
      ...RELEASE_IDENTITY,
      planDigest: PLAN_DIGEST,
      corpusIdentityDigest,
      utteranceHash: row.utteranceHash,
      utteranceText: row.utteranceText,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      predictedDomain: 'secretary',
      predictedSkill: 'tasks',
      confidence: 0.9,
      apiUsageId: timeoutUsageId,
      runId: RELEASE_RUN_ID,
    }, db)).toThrow(/successful resolved api_usage/i);

    const wrongAttributionUsageId = Number(db.prepare(`
      INSERT INTO api_usage (
        category, model, provider, run_id, pricing_status,
        request_source, base_category, job_name, user_id, tenant_id,
        input_tokens, output_tokens, cost_usd
      ) VALUES (?, ?, ?, 'wrong-attribution-run', 'resolved',
                'interactive', 'other_job', 'wrong-job', 42, 42, 100, 10, 0.000014)
    `).run(USAGE_CATEGORY, MODEL, PROVIDER).lastInsertRowid);
    expect(() => storeRoutingActionSkillPrediction({
      ...RELEASE_IDENTITY,
      planDigest: PLAN_DIGEST,
      corpusIdentityDigest,
      utteranceHash: row.utteranceHash,
      utteranceText: row.utteranceText,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      predictedDomain: 'secretary',
      predictedSkill: 'tasks',
      confidence: 0.9,
      apiUsageId: wrongAttributionUsageId,
      runId: RELEASE_RUN_ID,
    }, db)).toThrow(/successful resolved api_usage/i);

    const wrongJobUsageId = insertSuccessfulUsage(db, 'wrong-job-run');
    db.prepare('UPDATE api_usage SET job_name = ? WHERE id = ?')
      .run('different-job', wrongJobUsageId);
    expect(() => storeRoutingActionSkillPrediction({
      ...RELEASE_IDENTITY,
      planDigest: PLAN_DIGEST,
      corpusIdentityDigest,
      utteranceHash: row.utteranceHash,
      utteranceText: row.utteranceText,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      predictedDomain: 'secretary',
      predictedSkill: 'tasks',
      confidence: 0.9,
      apiUsageId: wrongJobUsageId,
      runId: RELEASE_RUN_ID,
    }, db)).toThrow(/successful resolved api_usage/i);

    const wrongScopeUsageId = insertSuccessfulUsage(db, 'wrong-scope-run');
    db.prepare('UPDATE api_usage SET user_id = 42 WHERE id = ?').run(wrongScopeUsageId);
    expect(() => storeRoutingActionSkillPrediction({
      ...RELEASE_IDENTITY,
      planDigest: PLAN_DIGEST,
      corpusIdentityDigest,
      utteranceHash: row.utteranceHash,
      utteranceText: row.utteranceText,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      predictedDomain: 'secretary',
      predictedSkill: 'tasks',
      confidence: 0.9,
      apiUsageId: wrongScopeUsageId,
      runId: RELEASE_RUN_ID,
    }, db)).toThrow(/successful resolved api_usage/i);

    const wrongTenantUsageId = insertSuccessfulUsage(db, 'wrong-tenant-run');
    db.prepare('UPDATE api_usage SET tenant_id = 42 WHERE id = ?').run(wrongTenantUsageId);
    expect(() => storeRoutingActionSkillPrediction({
      ...RELEASE_IDENTITY,
      planDigest: PLAN_DIGEST,
      corpusIdentityDigest,
      utteranceHash: row.utteranceHash,
      utteranceText: row.utteranceText,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      predictedDomain: 'secretary',
      predictedSkill: 'tasks',
      confidence: 0.9,
      apiUsageId: wrongTenantUsageId,
      runId: RELEASE_RUN_ID,
    }, db)).toThrow(/successful resolved api_usage/i);

    const usageId = insertSuccessfulUsage(db, RELEASE_RUN_ID);
    expect(() => storeRoutingActionSkillPrediction({
      ...RELEASE_IDENTITY,
      planDigest: PLAN_DIGEST,
      corpusIdentityDigest,
      utteranceHash: row.utteranceHash,
      utteranceText: row.utteranceText,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      predictedDomain: 'secretary',
      predictedSkill: 'training',
      confidence: 0.9,
      apiUsageId: usageId,
      runId: RELEASE_RUN_ID,
    }, db)).toThrow(/does not belong to predicted domain/i);
  });

  it('passes only with the exact 300-row corpus fully covered at >= 0.95 agreement', () => {
    const rows = seedCanonicalCorpus(db);
    for (const row of rows) cachePrediction(db, row);
    completePlan(db);

    const perfect = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
      generatedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(perfect.itemCount).toBe(300);
    expect(perfect.covered).toBe(300);
    expect(perfect.agreement).toBe(1);
    expect(perfect.gate).toEqual({
      passed: true,
      requiredItemCount: 300,
      requiredCovered: 300,
      minimumAgreement: ROUTING_ACTION_SKILL_MIN_AGREEMENT,
      reasons: [],
    });
    expect(perfect.perSkill).toHaveLength(11);
    expect(perfect.perSkill.every((metric) => metric.support >= 20)).toBe(true);

    const corpusIdentityDigest = perfect.corpusIdentityDigest;
    const failedPlanDigest = `sha256:${'e'.repeat(64)}`;
    db.prepare(`
      INSERT INTO routing_manifest_skill_refresh_plan_claims (
        plan_digest, plan_sequence, corpus_identity_digest,
        runtime_sha, artifact_digest, run_id, status, claim_token
      ) VALUES (?, 2, ?, ?, ?, ?, 'active', 'later-plan-claim')
    `).run(
      failedPlanDigest,
      corpusIdentityDigest,
      RUNTIME_SHA,
      ARTIFACT_DIGEST,
      RELEASE_RUN_ID,
    );
    db.prepare(`
      UPDATE routing_manifest_skill_classify_cache
      SET plan_digest = ?
      WHERE utterance_hash != ?
    `).run(failedPlanDigest, rows[0].utteranceHash);
    db.prepare(`
      UPDATE routing_manifest_skill_refresh_plan_claims
      SET status = 'failed', claim_token = NULL
      WHERE plan_digest = ?
    `).run(failedPlanDigest);
    const laterFailed = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(laterFailed.covered).toBe(0);
    expect(laterFailed.gate.passed).toBe(false);
    expect(laterFailed.gate.reasons.join(' ')).toMatch(/latest.*completed/i);

    const terminalReceiptDigest = `sha256:${'f'.repeat(64)}`;
    db.prepare(`
      INSERT INTO routing_manifest_skill_refresh_plan_claims (
        plan_digest, plan_sequence, corpus_identity_digest,
        runtime_sha, artifact_digest, run_id, status, claim_token
      ) VALUES (?, 3, ?, ?, ?, ?, 'completed', NULL)
    `).run(
      terminalReceiptDigest,
      corpusIdentityDigest,
      RUNTIME_SHA,
      ARTIFACT_DIGEST,
      RELEASE_RUN_ID,
    );
    const terminallyCompleted = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(terminallyCompleted.covered).toBe(300);
    expect(terminallyCompleted.gate.passed).toBe(true);
    expect(terminallyCompleted.releaseEvidence).toMatchObject({
      terminalPlanSequence: 3,
      terminalPlanDigest: terminalReceiptDigest,
      terminalPlanStatus: 'completed',
    });

    const secretaryRows = rows.filter((row) => (
      row.labelDomain === 'secretary' && row.labelSkill !== 'tasks'
    ));
    expect(secretaryRows.length).toBeGreaterThanOrEqual(16);
    for (const row of secretaryRows.slice(0, 15)) {
      db.prepare(`
        UPDATE routing_manifest_skill_classify_cache
        SET predicted_skill = 'tasks'
        WHERE utterance_hash = ?
      `).run(row.utteranceHash);
    }
    const atThreshold = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(atThreshold.correct).toBe(285);
    expect(atThreshold.agreement).toBe(0.95);
    expect(atThreshold.gate.passed).toBe(true);
    expect(atThreshold.corpusIdentityDigest).toBe(perfect.corpusIdentityDigest);

    db.prepare(`
      UPDATE routing_manifest_skill_classify_cache
      SET predicted_skill = 'tasks'
      WHERE utterance_hash = ?
    `).run(secretaryRows[15].utteranceHash);
    const belowThreshold = runRoutingActionSkillAccuracy({
      db,
      ...RELEASE_IDENTITY,
      provider: PROVIDER,
      model: MODEL,
      usageCategory: USAGE_CATEGORY,
    });
    expect(belowThreshold.correct).toBe(284);
    expect(belowThreshold.agreement).toBeCloseTo(284 / 300, 10);
    expect(belowThreshold.gate.passed).toBe(false);
    expect(belowThreshold.gate.reasons.join(' ')).toMatch(/agreement.*0\.95/i);
  });
});

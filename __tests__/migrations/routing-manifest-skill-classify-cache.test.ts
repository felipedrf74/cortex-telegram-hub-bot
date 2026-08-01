// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UP = fs.readFileSync(
  path.join(REPO_ROOT, 'migrations', '266_routing_manifest_skill_classify_cache.sql'),
  'utf8',
);
const DOWN = fs.readFileSync(
  path.join(REPO_ROOT, 'migrations', 'down', '266_routing_manifest_skill_classify_cache.sql'),
  'utf8',
);

describe('migration 266 routing manifest skill classify cache', () => {
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
        pricing_status TEXT NOT NULL DEFAULT 'resolved',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE routing_llm_classify_cache (
        utterance_hash TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        confidence REAL NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(`
      INSERT INTO routing_llm_classify_cache (utterance_hash, domain, confidence, model)
      VALUES (?, 'secretary', 1, 'legacy-model')
    `).run('a'.repeat(64));
  });

  afterEach(() => db.close());

  it('adds a separate exact-identity cache and leaves the legacy domain cache byte-preserved', () => {
    db.exec(UP);

    const runColumns = db.prepare('PRAGMA table_info(routing_manifest_skill_refresh_runs)')
      .all() as Array<{ name: string; notnull: number }>;
    expect(runColumns.map((column) => column.name)).toEqual([
      'runtime_sha',
      'artifact_digest',
      'run_id',
      'budget_usd',
      'prompt_sha256',
      'request_builder_version',
      'provider',
      'model',
      'usage_category',
      'request_source',
      'base_category',
      'job_name',
      'user_id',
      'tenant_id',
      'created_at',
    ]);

    const claimColumns = db.prepare('PRAGMA table_info(routing_manifest_skill_refresh_plan_claims)')
      .all() as Array<{ name: string; notnull: number }>;
    expect(claimColumns.map((column) => column.name)).toEqual([
      'plan_digest',
      'plan_sequence',
      'corpus_identity_digest',
      'runtime_sha',
      'artifact_digest',
      'run_id',
      'status',
      'claim_token',
      'claimed_at',
      'updated_at',
    ]);

    const columns = db.prepare('PRAGMA table_info(routing_manifest_skill_classify_cache)')
      .all() as Array<{ name: string; notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      'runtime_sha',
      'artifact_digest',
      'plan_digest',
      'corpus_identity_digest',
      'utterance_hash',
      'prompt_sha256',
      'request_builder_version',
      'request_sha256',
      'provider',
      'model',
      'usage_category',
      'predicted_domain',
      'predicted_skill',
      'confidence',
      'api_usage_id',
      'run_id',
      'created_at',
    ]);
    expect(columns.find((column) => column.name === 'predicted_skill')?.notnull).toBe(0);

    const legacy = db.prepare('SELECT * FROM routing_llm_classify_cache').get() as Record<string, unknown>;
    expect(legacy).toMatchObject({
      utterance_hash: 'a'.repeat(64),
      domain: 'secretary',
      confidence: 1,
      model: 'legacy-model',
    });
  });

  it('is idempotent, binds one usage row to one prediction, and has a reversible down migration', () => {
    db.exec(UP);
    db.exec(UP);

    const runtimeSha = 'a'.repeat(40);
    const artifactDigest = 'b'.repeat(64);
    const planDigest = `sha256:${'c'.repeat(64)}`;
    const corpusIdentityDigest = `sha256:${'d'.repeat(64)}`;
    const runId = 'routing-action-skill-release-run';
    db.prepare(`
      INSERT INTO routing_manifest_skill_refresh_runs (
        runtime_sha, artifact_digest, run_id, budget_usd,
        prompt_sha256, request_builder_version, provider, model,
        usage_category, request_source, base_category, job_name, user_id, tenant_id
      ) VALUES (?, ?, ?, 0.05, ?, 'manifest-classifier-request@1.0.0',
        'gemini', 'gemini-2.5-flash-lite', 'gemini_classify', 'system',
        'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
    `).run(runtimeSha, artifactDigest, runId, 'd'.repeat(64));
    db.prepare(`
      INSERT INTO routing_manifest_skill_refresh_plan_claims (
        plan_digest, plan_sequence, corpus_identity_digest,
        runtime_sha, artifact_digest, run_id, status, claim_token
      ) VALUES (?, 1, ?, ?, ?, ?, 'active', 'claim-token')
    `).run(planDigest, corpusIdentityDigest, runtimeSha, artifactDigest, runId);

    const usageId = Number(db.prepare(`
      INSERT INTO api_usage (
        category, model, provider, run_id, pricing_status, input_tokens, output_tokens
      ) VALUES ('gemini_classify', 'gemini-2.5-flash-lite', 'gemini', 'skill-run-1', 'resolved', 100, 10)
    `).run().lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO routing_manifest_skill_classify_cache (
        runtime_sha, artifact_digest, plan_digest, corpus_identity_digest,
        utterance_hash, prompt_sha256, request_builder_version, request_sha256,
        provider, model, usage_category, predicted_domain, predicted_skill,
        confidence, api_usage_id, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      runtimeSha,
      artifactDigest,
      planDigest,
      corpusIdentityDigest,
      'b'.repeat(64),
      'd'.repeat(64),
      'manifest-classifier-request@1.0.0',
      'e'.repeat(64),
      'gemini',
      'gemini-2.5-flash-lite',
      'gemini_classify',
      'secretary',
      null,
      0.9,
      usageId,
      runId,
    );

    expect(() => insert.run(
      runtimeSha,
      artifactDigest,
      planDigest,
      corpusIdentityDigest,
      'e'.repeat(64),
      'f'.repeat(64),
      'manifest-classifier-request@1.0.0',
      '1'.repeat(64),
      'gemini',
      'gemini-2.5-flash-lite',
      'gemini_classify',
      'secretary',
      'tasks',
      0.9,
      usageId,
      runId,
    )).toThrow(/unique/i);

    expect(() => insert.run(
      runtimeSha,
      artifactDigest,
      planDigest,
      corpusIdentityDigest,
      'f'.repeat(64),
      '2'.repeat(64),
      'manifest-classifier-request@1.0.0',
      '3'.repeat(64),
      'gemini',
      'gemini-2.5-flash-lite',
      'gemini_classify',
      'secretary',
      'tasks',
      0.9,
      999,
      runId,
    )).toThrow(/foreign key/i);

    db.exec(DOWN);
    for (const table of [
      'routing_manifest_skill_classify_cache',
      'routing_manifest_skill_refresh_plan_claims',
      'routing_manifest_skill_refresh_runs',
    ]) {
      expect(db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toBeUndefined();
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_llm_classify_cache').get())
      .toEqual({ count: 1 });
  });
});

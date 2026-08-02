// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { runRoutingActionSkillAccuracyCli } from '../../src/tools/routing-action-skill-accuracy';

const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'src/tools/routing-action-skill-accuracy.ts');
const runtimeSha = 'a'.repeat(40);
const artifactDigest = 'b'.repeat(64);
const generatedAt = '2026-07-31T12:00:00.000Z';

async function withEvaluationDatabase(
  callback: (dbPath: string, db: Database.Database) => Promise<void>,
): Promise<void> {
  const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), 'routing-action-skill-tool-'));
  const dbPath = path.join(fixtureRoot, 'evaluation.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        run_id TEXT,
        request_source TEXT NOT NULL DEFAULT 'system',
        base_category TEXT NOT NULL DEFAULT 'routing_action_skill_cache_refresh',
        job_name TEXT NOT NULL DEFAULT 'routing_action_skill_cache_refresh',
        user_id INTEGER NOT NULL DEFAULT 0,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        pricing_status TEXT NOT NULL DEFAULT 'resolved',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE routing_corpus_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER,
        utterance_hash TEXT NOT NULL UNIQUE,
        utterance_text TEXT,
        source TEXT NOT NULL,
        suggested_domain TEXT,
        suggested_skill TEXT,
        label_domain TEXT,
        label_skill TEXT,
        label_status TEXT NOT NULL,
        labeled_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    db.exec(fs.readFileSync(
      path.join(root, 'migrations', '266_routing_manifest_skill_classify_cache.sql'),
      'utf8',
    ));
    await callback(dbPath, db);
  } finally {
    db.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('installed routing action-skill accuracy tool', () => {
  it('is a compiled, cache-only release CLI with no refresh surface', () => {
    const raw = fs.readFileSync(source, 'utf8');

    expect(raw).toContain('readonly: true');
    expect(raw).toContain("'--refresh-llm'");
    expect(raw).toContain("'--accept-snapshot'");
    expect(raw).toContain('runRoutingActionSkillAccuracy');
    expect(raw).not.toContain('classifyWithClaude');
    expect(raw).not.toContain('generateContent');
  });

  it('refuses provider or snapshot mutation flags before opening a database', () => {
    for (const flag of ['--refresh-llm', '--accept-snapshot']) {
      const result = spawnSync(process.execPath, [
        '--import',
        'tsx',
        source,
        '--db=/definitely/not/a/database.sqlite',
        flag,
      ], { cwd: root, encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${flag} is not supported`);
      expect(result.stderr).toContain('cache-only');
      expect(result.stderr).not.toContain('database not found');
    }
  });

  it.each([
    ['--refresh-llm=25', '--refresh-llm'],
    ['--accept-snapshot', '--accept-snapshot'],
  ])('rejects mutation argument %s through the directly invoked release entrypoint', async (
    argument,
    expectedFlag,
  ) => {
    await expect(runRoutingActionSkillAccuracyCli([
      '--db=/definitely/not/a/database.sqlite',
      argument,
    ])).rejects.toThrow(`${expectedFlag} is not supported`);
  });

  it.each([
    '2026-07-31',
    '2026-99-31T12:00:00.000Z',
    '2026-02-30T12:00:00.000Z',
  ])('rejects non-canonical generated-at value %s before opening a database', async (value) => {
    await expect(runRoutingActionSkillAccuracyCli([
      '--db=/definitely/not/a/database.sqlite',
      `--generated-at=${value}`,
    ])).rejects.toThrow('--generated-at must be a canonical UTC ISO timestamp with milliseconds');
  });

  it('requires an explicit generated-at timestamp in gate mode before identity or database reads', async () => {
    await expect(runRoutingActionSkillAccuracyCli([
      '--db=/definitely/not/a/database.sqlite',
      '--gate',
    ])).rejects.toThrow('--gate requires an explicit canonical --generated-at timestamp');
  });

  it('rejects malformed exact release identity components before opening a database', async () => {
    await expect(runRoutingActionSkillAccuracyCli([
      '--db=/definitely/not/a/database.sqlite',
      '--runtime-sha',
    ])).rejects.toThrow('--runtime-sha must be a full lowercase deployed Git SHA');

    await expect(runRoutingActionSkillAccuracyCli([
      '--db=/definitely/not/a/database.sqlite',
      `--runtime-sha=${runtimeSha}`,
      '--artifact-digest=ABC',
    ])).rejects.toThrow('--artifact-digest must be a full lowercase deployed artifact SHA-256');
  });

  it('returns inspect and gate statuses from the real cache-only evaluator and closes each reader', async () => {
    await withEvaluationDatabase(async (dbPath, db) => {
      const originalModel = process.env.GEMINI_CLASSIFIER_MODEL;
      process.env.GEMINI_CLASSIFIER_MODEL = 'gemini-2.5-flash-lite';
      const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const close = vi.spyOn(Database.prototype, 'close');
      try {
        const inspectStatus = await runRoutingActionSkillAccuracyCli([
          '--db', dbPath,
          '--runtime-sha', runtimeSha,
          '--artifact-digest', artifactDigest,
          '--generated-at', generatedAt,
        ]);
        const gateStatus = await runRoutingActionSkillAccuracyCli([
          `--db=${dbPath}`,
          `--runtime-sha=${runtimeSha}`,
          `--artifact-digest=${artifactDigest}`,
          `--generated-at=${generatedAt}`,
          '--gate',
        ]);

        expect(inspectStatus).toBe(0);
        expect(gateStatus).toBe(1);
        expect(close).toHaveBeenCalledTimes(2);
        const reports = output.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
        expect(reports).toHaveLength(2);
        expect(reports[0]).toMatchObject({
          schemaVersion: 'routing_action_skill_accuracy_report.v1',
          dbPath,
          report: {
            generatedAt,
            sourceIdentity: { runtimeSha, artifactDigest },
            itemCount: 0,
            covered: 0,
            gate: { passed: false },
          },
        });
        expect(reports[1]).toEqual(reports[0]);
        expect(db.prepare(
          'SELECT COUNT(*) AS count FROM routing_manifest_skill_classify_cache',
        ).get()).toEqual({ count: 0 });
      } finally {
        vi.restoreAllMocks();
        if (originalModel === undefined) delete process.env.GEMINI_CLASSIFIER_MODEL;
        else process.env.GEMINI_CLASSIFIER_MODEL = originalModel;
      }
    });
  });

  it('closes the read-only database when evaluator schema validation throws', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), 'routing-action-skill-error-'));
    const dbPath = path.join(fixtureRoot, 'invalid.sqlite');
    new Database(dbPath).close();
    const close = vi.spyOn(Database.prototype, 'close');
    try {
      await expect(runRoutingActionSkillAccuracyCli([
        `--db=${dbPath}`,
        `--runtime-sha=${runtimeSha}`,
        `--artifact-digest=${artifactDigest}`,
      ])).rejects.toThrow(/no such table/i);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

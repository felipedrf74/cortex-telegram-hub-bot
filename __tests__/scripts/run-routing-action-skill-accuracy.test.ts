// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts', 'run-routing-action-skill-accuracy.ts');
const installedToolPath = path.join(repoRoot, 'src', 'tools', 'routing-action-skill-accuracy.ts');
const runtimeSha = 'a'.repeat(40);
const artifactDigest = 'b'.repeat(64);
const releaseArgs = [
  `--runtime-sha=${runtimeSha}`,
  `--artifact-digest=${artifactDigest}`,
];

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GEMINI_CLASSIFIER_MODEL: 'gemini-2.5-flash-lite' },
  });
}

function withEmptyEvaluationDb(
  callback: (dbPath: string, db: Database.Database) => void,
): void {
  const tempDir = fs.mkdtempSync(path.join(tmpdir(), 'routing-action-skill-cli-'));
  const dbPath = path.join(tempDir, 'routing-only.sqlite');
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
      CREATE TABLE routing_llm_classify_cache (
        utterance_hash TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        confidence REAL NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE accepted_accuracy_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        snapshot_json TEXT NOT NULL,
        accepted INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec(fs.readFileSync(
      path.join(repoRoot, 'migrations', '266_routing_manifest_skill_classify_cache.sql'),
      'utf8',
    ));
    db.prepare(`
      INSERT INTO routing_llm_classify_cache (utterance_hash, domain, confidence, model)
      VALUES (?, 'secretary', 0.99, 'domain-only-sentinel')
    `).run('a'.repeat(64));
    db.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES ('{}', 1)
    `).run();
    callback(dbPath, db);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('run-routing-action-skill-accuracy CLI', () => {
  it('is a read-only, cache-only wrapper around the action-skill evaluator', () => {
    const raw = fs.readFileSync(scriptPath, 'utf8');
    const installedTool = fs.readFileSync(installedToolPath, 'utf8');
    const evaluatedSource = `${raw}\n${installedTool}`;

    expect(raw).toContain("from '../src/tools/routing-action-skill-accuracy'");
    expect(raw).toContain('runRoutingActionSkillAccuracyCli()');
    expect(installedTool).toContain('new Database(dbPath, { readonly: true, fileMustExist: true })');
    expect(installedTool).toContain("'../services/standalone-tool-database'");
    expect(installedTool).toMatch(
      /await import\(\s*['"]\.\.\/services\/routing-action-skill-accuracy['"]\s*\)/,
    );
    expect(evaluatedSource).not.toContain('classifyWithClaude');
    expect(evaluatedSource).not.toContain('accepted_accuracy_snapshots');
    expect(evaluatedSource).not.toContain('routing_llm_classify_cache');
  });

  it.each(['--refresh-llm', '--refresh-llm=25', '--accept-snapshot'])(
    'refuses the unsupported mutation flag %s before opening a database',
    (flag) => {
      const result = runCli('--db=/definitely/not/a/database.sqlite', flag);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`${flag.split('=')[0]} is not supported`);
      expect(result.stderr).toContain('cache-only');
      expect(result.stderr).not.toContain('database not found');
    },
  );

  it('prints a structured incomplete report without failing default inspection or mutating domain evidence', () => {
    withEmptyEvaluationDb((dbPath, db) => {
      const result = runCli(
        `--db=${dbPath}`,
        ...releaseArgs,
        '--generated-at=2026-07-31T12:00:00.000Z',
      );

      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        schemaVersion: 'routing_action_skill_accuracy_report.v1',
        dbPath,
        report: {
          generatedAt: '2026-07-31T12:00:00.000Z',
          sourceIdentity: { runtimeSha, artifactDigest },
          itemCount: 0,
          covered: 0,
          gate: { passed: false, requiredItemCount: 300, requiredCovered: 300 },
        },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM routing_llm_classify_cache').get())
        .toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM accepted_accuracy_snapshots').get())
        .toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM routing_manifest_skill_classify_cache').get())
        .toEqual({ count: 0 });
    });
  });

  it('requires a canonical generated-at timestamp for gate evidence before opening the database', () => {
    const result = runCli(
      '--db=/definitely/not/a/database.sqlite',
      ...releaseArgs,
      '--gate',
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/--gate requires.*--generated-at/i);
    expect(result.stderr).not.toContain('database not found');
  });

  it('fails closed only in explicit --gate mode when exact release corpus coverage is incomplete', () => {
    withEmptyEvaluationDb((dbPath) => {
      const result = runCli(
        `--db=${dbPath}`,
        ...releaseArgs,
        '--generated-at=2026-07-31T12:00:00.000Z',
        '--gate',
      );

      expect(result.status).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.report.gate).toMatchObject({
        passed: false,
        minimumAgreement: 0.95,
        requiredItemCount: 300,
        requiredCovered: 300,
      });
    });
  });
});

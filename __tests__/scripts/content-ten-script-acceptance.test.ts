// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TEN_SCRIPT_ACCEPTANCE_SCENARIOS } from '../../scripts/content-ten-script-acceptance.mjs';

describe('ten-script hybrid-plan acceptance inventory', () => {
  it('pins the global 4/3/3 delivery and 5/5 language budget with one production smoke', () => {
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS).toHaveLength(10);
    expect(new Set(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((row) => row.id)).size).toBe(10);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'standard')).toHaveLength(4);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'scheduled')).toHaveLength(3);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'priority')).toHaveLength(3);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.language === 'en')).toHaveLength(5);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.language === 'pt-BR')).toHaveLength(5);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.phase === 'pre-release')).toHaveLength(9);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.phase === 'production-smoke')).toHaveLength(1);
  });

  it('keeps every case on the complete fifteen-minute structured contract', () => {
    for (const row of TEN_SCRIPT_ACCEPTANCE_SCENARIOS) {
      expect(row.topic.length).toBeGreaterThan(40);
      expect(row.topic).not.toMatch(/https?:\/\//u);
      expect(['en', 'pt-BR']).toContain(row.language);
    }
  });

  it('creates and re-reads an immutable private state file without submitting work', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-ten-script-'));
    const state = join(directory, 'state.json');
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const output = execFileSync(process.execPath, [
          'scripts/content-ten-script-acceptance.mjs',
          '--phase', 'status', '--state', state,
        ], { encoding: 'utf8' });
        expect(JSON.parse(output)).toMatchObject({
          inventoryCount: 10,
          submitted: 0,
          acceptancePass: false,
        });
      }
      expect(statSync(state).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(state, 'utf8')).scenarios).toHaveLength(10);
      chmodSync(state, 0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds private evidence to the exact inventory, deployed SHA, and attributed usage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-ten-script-evidence-'));
    const statePath = join(directory, 'state.json');
    const databasePath = join(directory, 'acceptance.db');
    const outputPath = join(directory, 'evidence.json');
    const sourceSha = 'a'.repeat(40);
    const digest = (value: string) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
    const state = {
      schemaVersion: 'nexus.content-ten-script-acceptance.v1',
      productionSmokeSourceSha: sourceSha,
      scenarios: TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((scenario, index) => ({
        id: scenario.id,
        phase: scenario.phase,
        deliveryMode: scenario.deliveryMode,
        language: scenario.language,
        topicSha256: digest(scenario.topic),
        status: 'completed',
        jobId: `job-${index}`,
        output: {
          scriptSha256: digest(`script-${index}`),
          wordCount: 2_100,
          sourceConsistent: true,
          contractPass: true,
        },
      })),
    };
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const db = new Database(databasePath);
    try {
      db.exec(`CREATE TABLE content_script_jobs (
        job_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, status TEXT NOT NULL,
        delivery_mode TEXT NOT NULL, warning_codes_json TEXT NOT NULL, route TEXT,
        model_digest TEXT, created_at TEXT NOT NULL, completed_at TEXT NOT NULL
      );
      CREATE TABLE api_usage (
        run_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL, provider_tool_cost_usd REAL NOT NULL
      );`);
      const insertJob = db.prepare('INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertUsage = db.prepare('INSERT INTO api_usage VALUES (?, ?, ?, ?, ?)');
      state.scenarios.forEach((scenario, index) => {
        insertJob.run(
          scenario.jobId, `op-${index}`, 'completed', scenario.deliveryMode, '[]',
          'cloud', digest('model'), '2026-08-23T00:00:00Z', '2026-08-23T00:01:00Z',
        );
        insertUsage.run(`op-${index}`, 1_000 + index, 4_000 + index, 0.01, 0);
      });
    } finally {
      db.close();
    }
    try {
      const stdout = execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--database', databasePath, '--output', outputPath, '--source-sha', sourceSha,
      ], { encoding: 'utf8' });
      expect(JSON.parse(stdout)).toMatchObject({ acceptancePass: true });
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
        sourceSha,
        acceptancePass: true,
        inventory: { count: 10, preRelease: 9, productionSmoke: 1 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

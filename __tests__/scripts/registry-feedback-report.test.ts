// Phase 6 batch 32 (2026-05-15): CLI wrapper smoke test.
//
// Exercises scripts/registry-feedback-report.ts against a temporary SQLite
// file. Validates that the three sections (telemetry / adversarial /
// proposer) compose correctly.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'registry-feedback-'));
  dbPath = path.join(tempDir, 'test.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE chat_action_telemetry (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      planner TEXT NOT NULL,
      route_tier TEXT NOT NULL,
      skill TEXT,
      action TEXT,
      status TEXT,
      calibrated_score REAL,
      threshold REAL,
      model_provider TEXT,
      model TEXT,
      estimated_token_cost_usd REAL,
      verifier_status TEXT,
      latency_ms INTEGER,
      outcome TEXT,
      failure_reason TEXT,
      predicted_action_hash TEXT,
      slot_provenance_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  // Seed a few rows: one normal, one refusal-pattern, one clarification.
  const stmt = db.prepare(`
    INSERT INTO chat_action_telemetry (
      id, user_id, tenant_id, conversation_id, message_id, planner, route_tier,
      skill, action, status, outcome, failure_reason, latency_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < 5; i++) {
    stmt.run(
      `tel-${randomUUID()}`, 1, 1, `conv-${randomUUID()}`, `msg-${randomUUID()}`,
      'deterministic', 'tier0_deterministic',
      'tasks', 'create_task', 'planned', 'verified_success', null, 150,
      '2026-05-15T12:00:00Z',
    );
  }
  for (let i = 0; i < 4; i++) {
    stmt.run(
      `tel-${randomUUID()}`, 1, 1, `conv-${randomUUID()}`, `msg-${randomUUID()}`,
      'deterministic', 'tier0_deterministic',
      'mail', 'send_email', 'planned', null, 'prompt_injection_marker_detected', 200,
      '2026-05-15T12:00:00Z',
    );
  }
  for (let i = 0; i < 8; i++) {
    stmt.run(
      `tel-${randomUUID()}`, 1, 1, `conv-${randomUUID()}`, `msg-${randomUUID()}`,
      'deterministic', 'tier0_deterministic',
      'tasks', 'update_task', 'planned', 'needs_clarification', null, 100,
      '2026-05-15T12:00:00Z',
    );
  }
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('registry-feedback-report CLI (Phase 6 batch 32)', () => {
  it('emits all three sections when --section all', () => {
    const outputPath = path.join(tempDir, 'output.md');
    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/registry-feedback-report.ts --db "${dbPath}" --output "${outputPath}" --section all`,
      { stdio: 'pipe' },
    );
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, 'utf8');
    expect(content).toMatch(/Chat Action Telemetry — Registry Feedback Report/);
    expect(content).toMatch(/Adversarial Discovery Report/);
    expect(content).toMatch(/readableIntents Proposer/);
  });

  it('emits only the telemetry section when --section telemetry', () => {
    const outputPath = path.join(tempDir, 'output.md');
    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/registry-feedback-report.ts --db "${dbPath}" --output "${outputPath}" --section telemetry`,
      { stdio: 'pipe' },
    );
    const content = readFileSync(outputPath, 'utf8');
    expect(content).toMatch(/Chat Action Telemetry/);
    expect(content).not.toMatch(/Adversarial Discovery Report/);
    expect(content).not.toMatch(/readableIntents Proposer/);
  });

  it('emits only the adversarial section when --section adversarial', () => {
    const outputPath = path.join(tempDir, 'output.md');
    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/registry-feedback-report.ts --db "${dbPath}" --output "${outputPath}" --section adversarial`,
      { stdio: 'pipe' },
    );
    const content = readFileSync(outputPath, 'utf8');
    expect(content).toMatch(/Adversarial Discovery Report/);
    expect(content).toMatch(/prompt_injection_marker_detected/);
  });

  it('emits only the proposer section when --section proposer', () => {
    const outputPath = path.join(tempDir, 'output.md');
    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/registry-feedback-report.ts --db "${dbPath}" --output "${outputPath}" --section proposer`,
      { stdio: 'pipe' },
    );
    const content = readFileSync(outputPath, 'utf8');
    expect(content).toMatch(/readableIntents Proposer/);
  });

  it('exits with non-zero status when database does not exist', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    expect(() =>
      execSync(
        `cd "${repoRoot}" && npx tsx scripts/registry-feedback-report.ts --db /tmp/does-not-exist-${randomUUID()}.db`,
        { stdio: 'pipe' },
      ),
    ).toThrow();
  });

  it('respects --since filter (no clusters when since is in the future)', () => {
    const outputPath = path.join(tempDir, 'output.md');
    const repoRoot = path.resolve(__dirname, '../..');
    execSync(
      `cd "${repoRoot}" && npx tsx scripts/registry-feedback-report.ts --db "${dbPath}" --output "${outputPath}" --section adversarial --since 2027-01-01T00:00:00Z`,
      { stdio: 'pipe' },
    );
    const content = readFileSync(outputPath, 'utf8');
    expect(content).toMatch(/No adversarial clusters above the threshold/);
  });
});

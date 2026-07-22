import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const upPath = resolve(process.cwd(), 'migrations/260_chat_live_eval_preparations.sql');
const downPath = resolve(process.cwd(), 'migrations/down/260_chat_live_eval_preparations.sql');

describe('migration 260 chat live-eval preparation evidence', () => {
  it('stores aggregate reset/seed attestations without transcript or provider payload columns', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE chat_eval_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL UNIQUE
        );
        CREATE TABLE chat_eval_scenario_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL
        );
      `);
      db.exec(readFileSync(upPath, 'utf8'));
      const runColumns = (db.prepare('PRAGMA table_info(chat_eval_runs)').all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(runColumns).toEqual(expect.arrayContaining([
        'total_budget_ceiling_usd', 'target_budget_ceiling_usd', 'judge_budget_ceiling_usd',
        'target_actual_spend_usd', 'judge_estimated_spend_usd',
        'target_reserved_attempt_ceiling_usd', 'target_committed_ceiling_usd',
        'total_estimated_actual_spend_usd', 'total_conservative_commitment_usd',
        'target_usage_call_count', 'target_provider_attempt_count',
        'cost_attestation_json', 'preflight_attestation_json',
      ]));
      const columns = (db.prepare('PRAGMA table_info(chat_live_eval_preparations)').all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining([
        'run_id', 'scenario_id', 'mode', 'user_id', 'tenant_id',
        'seed_profile_version', 'seed_profile_hash', 'reset_counts_json', 'prepared_at',
      ]));
      expect(columns).not.toEqual(expect.arrayContaining([
        'prompt', 'message', 'response', 'seed_context', 'provider_payload',
      ]));

      const insert = db.prepare(`
        INSERT INTO chat_live_eval_preparations (
          run_id, scenario_id, mode, user_id, tenant_id,
          seed_profile_version, seed_profile_hash, reset_counts_json
        ) VALUES ('chat-eval-test', 'morning_planning', 'local_engine', 42, 42, 'v1', ?, '{}')
      `);
      insert.run('a'.repeat(64));
      expect(() => insert.run('b'.repeat(64))).toThrow(/UNIQUE/i);

      const baselineColumns = (db.prepare('PRAGMA table_info(chat_eval_frozen_baselines)').all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(baselineColumns).toEqual(expect.arrayContaining([
        'baseline_key', 'run_row_id', 'run_id', 'accepted_at', 'accepted_via',
        'evidence_json_path', 'evidence_markdown_path', 'git_commit',
        'scenario_set_hash', 'average_score', 'scenario_pass_rate',
        'total_estimated_actual_spend_usd', 'total_budget_ceiling_usd',
      ]));
      expect(baselineColumns).not.toEqual(expect.arrayContaining([
        'prompt', 'message', 'response', 'provider_payload_json',
      ]));
      const triggerNames = (db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'trg_chat_eval_frozen_%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      expect(triggerNames).toEqual(expect.arrayContaining([
        'trg_chat_eval_frozen_baseline_no_update',
        'trg_chat_eval_frozen_baseline_no_delete',
        'trg_chat_eval_frozen_run_no_update',
        'trg_chat_eval_frozen_run_no_delete',
        'trg_chat_eval_frozen_scenario_no_insert',
        'trg_chat_eval_frozen_scenario_no_update',
        'trg_chat_eval_frozen_scenario_no_delete',
      ]));

      db.exec(readFileSync(downPath, 'utf8'));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_live_eval_preparations'").get()).toBeUndefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_eval_frozen_baselines'").get()).toBeUndefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_chat_eval_frozen_%'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

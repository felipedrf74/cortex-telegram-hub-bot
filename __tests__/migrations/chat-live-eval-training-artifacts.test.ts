import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const upPath = resolve(process.cwd(), 'migrations/265_chat_live_eval_training_artifacts.sql');
const downPath = resolve(process.cwd(), 'migrations/down/265_chat_live_eval_training_artifacts.sql');

describe('migration 265 chat live-eval Training artifact ownership', () => {
  it('owns one exact Training plan per dedicated eval scope without storing private payloads', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec('CREATE TABLE fitness_training_plans (id INTEGER PRIMARY KEY);');
      db.exec(readFileSync(upPath, 'utf8'));

      const columns = (db.prepare('PRAGMA table_info(chat_live_eval_training_artifacts)').all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining([
        'user_id',
        'tenant_id',
        'scenario_id',
        'plan_id',
        'seed_profile_version',
        'created_at',
      ]));
      expect(columns).not.toEqual(expect.arrayContaining([
        'prompt',
        'message',
        'response',
        'provider_payload',
        'session_description',
      ]));

      const insert = db.prepare(`
        INSERT INTO chat_live_eval_training_artifacts (
          user_id, tenant_id, scenario_id, plan_id, seed_profile_version
        ) VALUES (?, ?, 'training_adjustment', ?, 'single-tenant-live-v3')
      `);
      db.prepare('INSERT INTO fitness_training_plans (id) VALUES (101), (102)').run();
      insert.run(42, 84, 101);
      expect(() => insert.run(42, 84, 102)).toThrow(/UNIQUE/i);
      expect(() => db.prepare(`
        INSERT INTO chat_live_eval_training_artifacts (
          user_id, tenant_id, scenario_id, plan_id, seed_profile_version
        ) VALUES (43, 84, 'cooking_fueling', 102, 'single-tenant-live-v3')
      `).run()).toThrow(/CHECK/i);

      db.prepare('DELETE FROM fitness_training_plans WHERE id = 101').run();
      expect(db.prepare('SELECT COUNT(*) AS count FROM chat_live_eval_training_artifacts').get())
        .toEqual({ count: 0 });

      db.exec(readFileSync(downPath, 'utf8'));
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'chat_live_eval_training_artifacts'
      `).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

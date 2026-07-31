import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  CHAT_LIVE_EVAL_CONTRACT_VERSION,
  CHAT_LIVE_EVAL_LOCAL_BUDGET,
  type ChatLiveEvalRequestContext,
} from '../../src/services/chat-live-evaluation-contract';
import {
  CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
  isCurrentChatLiveEvalLocalEngine,
  getCurrentChatLiveEvalSeedBlock,
  prepareChatLiveEvalScenario,
  runWithChatLiveEvalContext,
} from '../../src/services/chat-live-evaluation-state';
import {
  buildConfirmedDestructiveTargetsForPlanSteps,
  buildDeterministicChatActionPlan,
} from '../../src/services/chat';

function context(scenarioId: ChatLiveEvalRequestContext['scenarioId'] = 'morning_planning'): ChatLiveEvalRequestContext {
  return {
    version: CHAT_LIVE_EVAL_CONTRACT_VERSION,
    mode: 'local_engine',
    runId: 'chat-eval-state-test',
    scenarioId,
    budget: CHAT_LIVE_EVAL_LOCAL_BUDGET,
    targetBaseCategory: 'chat_live_eval_local',
    providerPolicy: 'ollama_only_zero_cloud',
    userId: 42,
    tenantId: 42,
    productionDataUsed: false,
  };
}

describe('chat live-evaluation scenario state', () => {
  it('injects fixed server-owned synthetic context only inside the scenario async scope', async () => {
    expect(getCurrentChatLiveEvalSeedBlock()).toBe('');
    expect(isCurrentChatLiveEvalLocalEngine()).toBe(false);
    await runWithChatLiveEvalContext(context(), async () => {
      const block = getCurrentChatLiveEvalSeedBlock();
      expect(block).toContain(CHAT_LIVE_EVAL_SEED_PROFILE_VERSION);
      expect(block).toContain('09:00 standup');
      expect(block).toContain('14:00 client call');
      expect(block).not.toContain('chat-eval-state-test');
      expect(isCurrentChatLiveEvalLocalEngine()).toBe(true);
    });
    expect(getCurrentChatLiveEvalSeedBlock()).toBe('');
    expect(isCurrentChatLiveEvalLocalEngine()).toBe(false);
  });

  it('resets only the dedicated authenticated scope and records aggregate preparation evidence', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE messages (id INTEGER PRIMARY KEY, tenant_id INTEGER, user_id INTEGER);
        CREATE TABLE chat_action_runs (id TEXT PRIMARY KEY, tenant_id INTEGER, user_id INTEGER);
        CREATE TABLE chat_live_eval_preparations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          seed_profile_version TEXT NOT NULL,
          seed_profile_hash TEXT NOT NULL,
          reset_counts_json TEXT NOT NULL,
          prepared_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (run_id, scenario_id, user_id, tenant_id)
        );
        INSERT INTO messages VALUES (1, 42, 42), (2, 99, 99);
        INSERT INTO chat_action_runs VALUES ('ours', 42, 42), ('theirs', 99, 99);
      `);
      const prepared = prepareChatLiveEvalScenario(db, context('cooking_fueling'), {
        clearProcessState: () => ({ pendingConfirmation: 1, completedConfirmation: 2 }),
      });

      expect(prepared).toMatchObject({
        scenarioId: 'cooking_fueling',
        seedProfileVersion: CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
        resetCounts: {
          messages: 1,
          chat_action_runs: 1,
          pendingConfirmation: 1,
          completedConfirmation: 2,
        },
      });
      expect(prepared.seedProfileHash).toMatch(/^[a-f0-9]{64}$/);
      expect(db.prepare('SELECT tenant_id, user_id FROM messages').all()).toEqual([{ tenant_id: 99, user_id: 99 }]);
      const evidence = db.prepare(`
        SELECT run_id, scenario_id, user_id, tenant_id, seed_profile_hash, reset_counts_json
        FROM chat_live_eval_preparations
      `).get() as Record<string, unknown>;
      expect(evidence).toMatchObject({
        run_id: 'chat-eval-state-test',
        scenario_id: 'cooking_fueling',
        user_id: 42,
        tenant_id: 42,
        seed_profile_hash: prepared.seedProfileHash,
      });
      expect(String(evidence.reset_counts_json)).not.toContain('standup');
    } finally {
      db.close();
    }
  });

  it('replaces only the exact eval-owned task artifact and seeds one local-only deletion target', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE unified_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          tenant_id INTEGER,
          provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER DEFAULT 0,
          provider_data TEXT DEFAULT '{}',
          is_deleted INTEGER DEFAULT 0,
          synced_at TEXT NOT NULL DEFAULT (datetime('now')),
          nexus_task_id TEXT,
          local_version INTEGER NOT NULL DEFAULT 1,
          sync_state TEXT NOT NULL DEFAULT 'synced',
          source_of_truth TEXT NOT NULL DEFAULT 'nexus',
          UNIQUE(user_id, provider, external_id)
        );
        CREATE TABLE task_provider_links (task_id TEXT, tenant_id INTEGER, user_id INTEGER);
        CREATE TABLE task_mutations (task_id TEXT, tenant_id INTEGER, user_id INTEGER);
        CREATE TABLE task_sync_issues (task_id TEXT, tenant_id INTEGER, user_id INTEGER);
        CREATE TABLE task_sync_observability_events (task_id TEXT, tenant_id INTEGER, user_id INTEGER);
        CREATE TABLE chat_live_eval_preparations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          seed_profile_version TEXT NOT NULL,
          seed_profile_hash TEXT NOT NULL,
          reset_counts_json TEXT NOT NULL,
          prepared_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (run_id, scenario_id, user_id, tenant_id)
        );
        INSERT INTO unified_tasks (
          user_id, tenant_id, provider, external_id, title, nexus_task_id, sync_state, source_of_truth
        ) VALUES
          (42, 42, 'nexus', 'old-eval', 'NEXUS_CHAT_EVAL_M2_TARGET', 'task_chat_live_eval_m2_target', 'local_only', 'chat_live_eval'),
          (42, 42, 'nexus', 'keep-ours', 'Keep this dedicated-tenant task', 'task_keep_ours', 'local_only', 'nexus'),
          (99, 99, 'nexus', 'keep-theirs', 'NEXUS_CHAT_EVAL_M2_TARGET', 'task_chat_live_eval_m2_target', 'local_only', 'nexus');
        INSERT INTO task_mutations VALUES ('task_chat_live_eval_m2_target', 42, 42);
      `);

      const prepared = prepareChatLiveEvalScenario(db, context(), {
        clearProcessState: () => ({}),
      });

      expect(prepared.seedProfileVersion).toBe(CHAT_LIVE_EVAL_SEED_PROFILE_VERSION);
      expect(prepared.resetCounts).toMatchObject({
        chatLiveEvalTaskArtifacts: 1,
        chatLiveEvalTaskMutations: 1,
        chatLiveEvalTaskSeeded: 1,
      });
      db.prepare('INSERT INTO task_mutations VALUES (?, 42, 42)')
        .run('task_chat_live_eval_m2_target');
      const preparedAgain = prepareChatLiveEvalScenario(db, context(), {
        clearProcessState: () => ({}),
      });
      expect(preparedAgain.resetCounts).toMatchObject({
        chatLiveEvalTaskArtifacts: 1,
        chatLiveEvalTaskMutations: 1,
        chatLiveEvalTaskSeeded: 1,
      });
      expect(db.prepare(`
        SELECT user_id, tenant_id, title, nexus_task_id, sync_state, source_of_truth, is_deleted
        FROM unified_tasks
        ORDER BY user_id, title
      `).all()).toEqual([
        {
          user_id: 42,
          tenant_id: 42,
          title: 'Keep this dedicated-tenant task',
          nexus_task_id: 'task_keep_ours',
          sync_state: 'local_only',
          source_of_truth: 'nexus',
          is_deleted: 0,
        },
        {
          user_id: 42,
          tenant_id: 42,
          title: 'NEXUS_CHAT_EVAL_M2_TARGET',
          nexus_task_id: 'task_chat_live_eval_m2_target',
          sync_state: 'local_only',
          source_of_truth: 'chat_live_eval',
          is_deleted: 0,
        },
        {
          user_id: 99,
          tenant_id: 99,
          title: 'NEXUS_CHAT_EVAL_M2_TARGET',
          nexus_task_id: 'task_chat_live_eval_m2_target',
          sync_state: 'local_only',
          source_of_truth: 'nexus',
          is_deleted: 0,
        },
      ]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM task_mutations').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM chat_live_eval_preparations').get()).toEqual({ count: 1 });

      // A reserved-id collision that is not marked eval-owned is never
      // cleaned or overwritten; preparation fails closed and rolls back.
      db.prepare(`
        UPDATE unified_tasks
           SET source_of_truth = 'nexus'
         WHERE user_id = 42 AND tenant_id = 42 AND nexus_task_id = ?
      `).run('task_chat_live_eval_m2_target');
      db.prepare('INSERT INTO task_mutations VALUES (?, 42, 42)')
        .run('task_chat_live_eval_m2_target');
      expect(() => prepareChatLiveEvalScenario(db, context(), {
        clearProcessState: () => ({}),
      })).toThrow();
      expect(db.prepare(`
        SELECT source_of_truth FROM unified_tasks
         WHERE user_id = 42 AND tenant_id = 42 AND nexus_task_id = ?
      `).get('task_chat_live_eval_m2_target')).toEqual({ source_of_truth: 'nexus' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM task_mutations').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('owns, reseeds, and cross-scenario-cleans only the dedicated Training fixture', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE fitness_training_plans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          sport TEXT NOT NULL DEFAULT 'strength',
          goal TEXT,
          duration_weeks INTEGER NOT NULL,
          periodization TEXT DEFAULT 'linear',
          status TEXT NOT NULL DEFAULT 'active',
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          preferences_json TEXT,
          plan_version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE training_weeks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id INTEGER NOT NULL,
          week_number INTEGER NOT NULL,
          focus TEXT,
          intensity_pct INTEGER DEFAULT 100,
          volume_sessions INTEGER,
          notes TEXT,
          auto_adjusted INTEGER NOT NULL DEFAULT 0,
          adjustment_reason TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
        );
        CREATE TABLE training_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          week_id INTEGER NOT NULL,
          plan_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          day_of_week TEXT NOT NULL,
          session_type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          exercises_json TEXT,
          duration_minutes INTEGER,
          intensity_text TEXT,
          calendar_event_id TEXT,
          calendar_source TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (week_id) REFERENCES training_weeks(id) ON DELETE CASCADE,
          FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
        );
        CREATE TABLE training_completions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          plan_id INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
        );
        CREATE TABLE training_agenda_event_ownership (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id INTEGER NOT NULL,
          session_id INTEGER,
          user_id INTEGER NOT NULL,
          calendar_event_id TEXT NOT NULL,
          calendar_source TEXT NOT NULL
        );
        CREATE TABLE training_operation_locks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id INTEGER
        );
        CREATE TABLE training_plan_adaptations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id INTEGER NOT NULL,
          FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
        );
        CREATE TABLE training_plan_families (
          family_id TEXT PRIMARY KEY,
          legacy_plan_id INTEGER
        );
        CREATE TABLE training_active_plan_references (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          projection_plan_id INTEGER,
          FOREIGN KEY (projection_plan_id) REFERENCES fitness_training_plans(id) ON DELETE SET NULL
        );
        CREATE TABLE chat_live_eval_training_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          scenario_id TEXT NOT NULL,
          plan_id INTEGER NOT NULL UNIQUE,
          seed_profile_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (user_id, tenant_id),
          FOREIGN KEY (plan_id) REFERENCES fitness_training_plans(id) ON DELETE CASCADE
        );
        CREATE TABLE chat_live_eval_preparations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          tenant_id INTEGER NOT NULL,
          seed_profile_version TEXT NOT NULL,
          seed_profile_hash TEXT NOT NULL,
          reset_counts_json TEXT NOT NULL,
          prepared_at TEXT NOT NULL,
          UNIQUE (run_id, scenario_id, user_id, tenant_id)
        );
        INSERT INTO fitness_training_plans (
          user_id, tenant_id, name, duration_weeks, status, start_date, end_date,
          preferences_json, created_at, updated_at
        ) VALUES
          (42, 42, 'Keep paused plan', 1, 'paused', '2026-01-01', '2026-01-07', NULL, '2026-01-01', '2026-01-01'),
          (99, 99, 'Other tenant active plan', 1, 'active', '2026-01-01', '2026-01-07', NULL, '2026-01-01', '2026-01-01');
      `);

      const first = prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({}),
      });
      expect(first.seedProfileVersion).toBe('single-tenant-live-v3');
      expect(first.resetCounts).toMatchObject({
        chatLiveEvalTrainingPlansSeeded: 1,
        chatLiveEvalTrainingWeeksSeeded: 1,
        chatLiveEvalTrainingSessionsSeeded: 1,
      });
      expect(db.prepare(`
        SELECT plans.user_id, plans.tenant_id, plans.name, plans.status,
               sessions.title, sessions.day_of_week, sessions.duration_minutes,
               sessions.intensity_text
          FROM chat_live_eval_training_artifacts owned
          JOIN fitness_training_plans plans ON plans.id = owned.plan_id
          JOIN training_weeks weeks ON weeks.plan_id = plans.id
          JOIN training_sessions sessions ON sessions.week_id = weeks.id
      `).get()).toMatchObject({
        user_id: 42,
        tenant_id: 42,
        name: 'NEXUS_CHAT_EVAL_TRAINING_PLAN',
        status: 'active',
        title: 'Heavy lower-body workout',
        duration_minutes: 45,
        intensity_text: 'RPE 7',
      });

      const second = prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({}),
      });
      expect(second.resetCounts).toMatchObject({
        chatLiveEvalTrainingPlansDeleted: 1,
        chatLiveEvalTrainingWeeksDeleted: 1,
        chatLiveEvalTrainingSessionsDeleted: 1,
        chatLiveEvalTrainingPlansSeeded: 1,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM chat_live_eval_training_artifacts').get())
        .toEqual({ count: 1 });

      const ownedFixture = db.prepare(`
        SELECT owned.plan_id AS planId, weeks.id AS weekId, sessions.id AS sessionId
          FROM chat_live_eval_training_artifacts owned
          JOIN training_weeks weeks ON weeks.plan_id = owned.plan_id
          JOIN training_sessions sessions ON sessions.plan_id = owned.plan_id
         LIMIT 1
      `).get() as { planId: number; weekId: number; sessionId: number };
      const foreignPlan = db.prepare(`
        SELECT id AS planId
          FROM fitness_training_plans
         WHERE user_id = 99 AND tenant_id = 99
      `).get() as { planId: number };
      const foreignWeekResult = db.prepare(`
        INSERT INTO training_weeks (
          plan_id, week_number, focus, created_at
        ) VALUES (?, 1, 'Foreign sentinel', '2026-01-01')
      `).run(foreignPlan.planId);
      const foreignSessionResult = db.prepare(`
        INSERT INTO training_sessions (
          week_id, plan_id, tenant_id, day_of_week, session_type, title,
          status, created_at, updated_at
        ) VALUES (?, ?, 99, 'Friday', 'strength', 'Foreign-plan session',
                  'scheduled', '2026-01-01', '2026-01-01')
      `).run(Number(foreignWeekResult.lastInsertRowid), foreignPlan.planId);
      const foreignSessionId = Number(foreignSessionResult.lastInsertRowid);

      const crossPlanSessionResult = db.prepare(`
        INSERT INTO training_sessions (
          week_id, plan_id, tenant_id, day_of_week, session_type, title,
          status, created_at, updated_at
        ) VALUES (?, ?, 99, 'Friday', 'strength', 'Owned-week foreign-plan sentinel',
                  'scheduled', '2026-01-01', '2026-01-01')
      `).run(ownedFixture.weekId, foreignPlan.planId);
      const crossPlanSessionId = Number(crossPlanSessionResult.lastInsertRowid);
      expect(() => prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({}),
      })).toThrow(/tenant.*scope|scope.*tenant|session.*week|week.*session/i);
      expect(db.prepare(`
        SELECT week_id, plan_id, tenant_id
          FROM training_sessions
         WHERE id = ?
      `).get(crossPlanSessionId)).toEqual({
        week_id: ownedFixture.weekId,
        plan_id: foreignPlan.planId,
        tenant_id: 99,
      });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM chat_live_eval_training_artifacts
         WHERE plan_id = ?
      `).get(ownedFixture.planId)).toEqual({ count: 1 });
      db.prepare('DELETE FROM training_sessions WHERE id = ?').run(crossPlanSessionId);

      db.prepare(`
        INSERT INTO training_sessions (
          week_id, plan_id, tenant_id, day_of_week, session_type, title,
          status, created_at, updated_at
        ) VALUES (?, ?, 99, 'Friday', 'strength', 'Cross-tenant sentinel',
                  'scheduled', '2026-01-01', '2026-01-01')
      `).run(ownedFixture.weekId, ownedFixture.planId);
      expect(() => prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({}),
      })).toThrow(/tenant.*scope|scope.*tenant/i);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM training_sessions
         WHERE plan_id = ? AND tenant_id = 99 AND title = 'Cross-tenant sentinel'
      `).get(ownedFixture.planId)).toEqual({ count: 1 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM chat_live_eval_training_artifacts
         WHERE plan_id = ?
      `).get(ownedFixture.planId)).toEqual({ count: 1 });
      db.prepare(`
        DELETE FROM training_sessions
         WHERE plan_id = ? AND tenant_id = 99 AND title = 'Cross-tenant sentinel'
      `).run(ownedFixture.planId);

      for (const [completionPlanId, completionSessionId] of [
        [ownedFixture.planId, foreignSessionId],
        [foreignPlan.planId, ownedFixture.sessionId],
      ] as const) {
        const completionResult = db.prepare(`
          INSERT INTO training_completions (session_id, plan_id) VALUES (?, ?)
        `).run(completionSessionId, completionPlanId);
        const completionId = Number(completionResult.lastInsertRowid);
        expect(() => prepareChatLiveEvalScenario(db, context('training_adjustment'), {
          clearProcessState: () => ({}),
        })).toThrow(/completion.*ownership|ownership.*completion/i);
        expect(db.prepare(`
          SELECT session_id, plan_id
            FROM training_completions
           WHERE id = ?
        `).get(completionId)).toEqual({
          session_id: completionSessionId,
          plan_id: completionPlanId,
        });
        expect(db.prepare(`
          SELECT COUNT(*) AS count
            FROM chat_live_eval_training_artifacts
           WHERE plan_id = ?
        `).get(ownedFixture.planId)).toEqual({ count: 1 });
        db.prepare('DELETE FROM training_completions WHERE id = ?').run(completionId);
      }

      const agendaOwnershipResult = db.prepare(`
        INSERT INTO training_agenda_event_ownership (
          plan_id, session_id, user_id, calendar_event_id, calendar_source
        ) VALUES (?, ?, 99, 'foreign-agenda-event', 'google')
      `).run(foreignPlan.planId, ownedFixture.sessionId);
      const agendaOwnershipId = Number(agendaOwnershipResult.lastInsertRowid);
      expect(() => prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({}),
      })).toThrow(/calendar/i);
      expect(db.prepare(`
        SELECT plan_id, session_id, calendar_event_id
          FROM training_agenda_event_ownership
         WHERE id = ?
      `).get(agendaOwnershipId)).toEqual({
        plan_id: foreignPlan.planId,
        session_id: ownedFixture.sessionId,
        calendar_event_id: 'foreign-agenda-event',
      });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM chat_live_eval_training_artifacts
         WHERE plan_id = ?
      `).get(ownedFixture.planId)).toEqual({ count: 1 });
      db.prepare('DELETE FROM training_agenda_event_ownership WHERE id = ?')
        .run(agendaOwnershipId);

      db.prepare(`
        UPDATE training_sessions
           SET calendar_event_id = 'external-event', calendar_source = 'google'
         WHERE id = ?
      `).run(ownedFixture.sessionId);
      expect(() => prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({}),
      })).toThrow(/calendar/i);
      expect(db.prepare(`
        SELECT calendar_event_id, calendar_source
          FROM training_sessions
         WHERE id = ?
      `).get(ownedFixture.sessionId)).toEqual({
        calendar_event_id: 'external-event',
        calendar_source: 'google',
      });
      db.prepare(`
        UPDATE training_sessions
           SET calendar_event_id = NULL, calendar_source = NULL
         WHERE id = ?
      `).run(ownedFixture.sessionId);

      for (const contamination of [
        ['training_operation_locks', 'plan_id'],
        ['training_plan_adaptations', 'plan_id'],
        ['training_plan_families', 'legacy_plan_id'],
        ['training_active_plan_references', 'projection_plan_id'],
      ] as const) {
        if (contamination[0] === 'training_plan_families') {
          db.prepare(`
            INSERT INTO training_plan_families (family_id, legacy_plan_id)
            VALUES ('unexpected-family', ?)
          `).run(ownedFixture.planId);
        } else {
          db.prepare(`
            INSERT INTO ${contamination[0]} (${contamination[1]}) VALUES (?)
          `).run(ownedFixture.planId);
        }
        expect(() => prepareChatLiveEvalScenario(db, context('training_adjustment'), {
          clearProcessState: () => ({}),
        }), contamination[0]).toThrow(/unexpected.*reference|reference.*unexpected/i);
        expect(db.prepare(`
          SELECT COUNT(*) AS count
            FROM ${contamination[0]}
           WHERE ${contamination[1]} = ?
        `).get(ownedFixture.planId), contamination[0]).toEqual({ count: 1 });
        db.prepare(`
          DELETE FROM ${contamination[0]} WHERE ${contamination[1]} = ?
        `).run(ownedFixture.planId);
      }

      db.exec(`
        CREATE TRIGGER fail_chat_live_eval_preparation_update
        BEFORE UPDATE ON chat_live_eval_preparations
        BEGIN
          SELECT RAISE(ABORT, 'synthetic late preparation failure');
        END;
      `);
      expect(() => prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({}),
      })).toThrow(/synthetic late preparation failure/i);
      expect(db.prepare(`
        SELECT owned.plan_id AS planId, weeks.id AS weekId, sessions.id AS sessionId
          FROM chat_live_eval_training_artifacts owned
          JOIN training_weeks weeks ON weeks.plan_id = owned.plan_id
          JOIN training_sessions sessions ON sessions.plan_id = owned.plan_id
         LIMIT 1
      `).get()).toEqual(ownedFixture);
      db.exec('DROP TRIGGER fail_chat_live_eval_preparation_update;');

      const cleaned = prepareChatLiveEvalScenario(db, context('cooking_fueling'), {
        clearProcessState: () => ({}),
      });
      expect(cleaned.resetCounts).toMatchObject({
        chatLiveEvalTrainingPlansDeleted: 1,
        chatLiveEvalTrainingPlansSeeded: 0,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM chat_live_eval_training_artifacts').get())
        .toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT user_id, tenant_id, name, status
          FROM fitness_training_plans
         ORDER BY user_id, name
      `).all()).toEqual([
        { user_id: 42, tenant_id: 42, name: 'Keep paused plan', status: 'paused' },
        { user_id: 99, tenant_id: 99, name: 'Other tenant active plan', status: 'active' },
      ]);

      db.prepare(`
        INSERT INTO fitness_training_plans (
          user_id, tenant_id, name, duration_weeks, status, start_date, end_date,
          preferences_json, created_at, updated_at
        ) VALUES (42, 42, 'Unexpected active plan', 1, 'active', '2026-01-01', '2026-01-07', NULL, '2026-01-01', '2026-01-01')
      `).run();
      expect(() => prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({}),
      })).toThrow(/dedicated.*active training plan/i);
      expect(db.prepare('SELECT COUNT(*) AS count FROM chat_live_eval_training_artifacts').get())
        .toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM fitness_training_plans
         WHERE user_id = 42 AND tenant_id = 42 AND status = 'active'
      `).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('resolves the exact destructive target only inside the governed eval turn context', async () => {
    const input = {
      text: 'Delete only the task NEXUS_CHAT_EVAL_M2_TARGET. Do not delete any other task.',
      userId: 42,
      tenantId: 42,
      conversationId: 'live-request-specific-id',
      messageId: 'msg-live-eval-delete',
      channel: 'ios' as const,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      nowIso: '2026-07-22T12:00:00.000Z',
      persistRuns: false,
      requireSafeWriteConfirmation: true,
    };

    const ordinary = buildDeterministicChatActionPlan(input);
    expect(ordinary?.steps[0]).toMatchObject({
      action: 'delete_task',
      requiredArgsPresent: false,
      args: { taskId: null },
    });

    const governed = await runWithChatLiveEvalContext(context(), async () => (
      buildDeterministicChatActionPlan(input)
    ));
    expect(governed).toMatchObject({
      requiresConfirmation: true,
      steps: [{
        skill: 'tasks',
        action: 'delete_task',
        risk: 'destructive',
        requiredArgsPresent: true,
        args: {
          taskId: 'task_chat_live_eval_m2_target',
          title: 'NEXUS_CHAT_EVAL_M2_TARGET',
        },
      }],
    });
    expect(buildConfirmedDestructiveTargetsForPlanSteps(governed!.steps)).toEqual([{
      tool: 'ms_todo_delete_task',
      targetId: 'task_chat_live_eval_m2_target',
    }]);
  });

  it('refuses preparation without an allowlisted turn scenario', () => {
    const db = new Database(':memory:');
    try {
      expect(() => prepareChatLiveEvalScenario(db, context(null), {
        clearProcessState: () => ({}),
      })).toThrow(/scenario/i);
    } finally {
      db.close();
    }
  });
});

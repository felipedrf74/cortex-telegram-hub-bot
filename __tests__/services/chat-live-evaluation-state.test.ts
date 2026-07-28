import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  CHAT_LIVE_EVAL_CONTRACT_VERSION,
  CHAT_LIVE_EVAL_LOCAL_BUDGET,
  type ChatLiveEvalRequestContext,
} from '../../src/services/chat-live-evaluation-contract';
import {
  CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
  getCurrentChatLiveEvalSeedBlock,
  prepareChatLiveEvalScenario,
  runWithChatLiveEvalContext,
} from '../../src/services/chat-live-evaluation-state';
import {
  buildConfirmedDestructiveTargetsForPlanSteps,
  buildDeterministicChatActionPlan,
} from '../../src/services/chat';
import { getCurrentApiUsageAttribution } from '../../src/services/api-usage-attribution';

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
    expect(getCurrentApiUsageAttribution()).toBeUndefined();
    await runWithChatLiveEvalContext(context(), async () => {
      await Promise.resolve();
      const block = getCurrentChatLiveEvalSeedBlock();
      expect(block).toContain(CHAT_LIVE_EVAL_SEED_PROFILE_VERSION);
      expect(block).toContain('09:00 standup');
      expect(block).toContain('14:00 client call');
      expect(block).not.toContain('chat-eval-state-test');
      expect(getCurrentApiUsageAttribution()).toEqual({
        requestSource: 'interactive',
        baseCategory: 'chat_live_eval_local',
        jobName: 'chat_live_eval:morning_planning',
        runId: 'chat-eval-state-test',
      });
    });
    expect(getCurrentChatLiveEvalSeedBlock()).toBe('');
    expect(getCurrentApiUsageAttribution()).toBeUndefined();
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
      const prepared = prepareChatLiveEvalScenario(db, context('training_adjustment'), {
        clearProcessState: () => ({ pendingConfirmation: 1, completedConfirmation: 2 }),
      });

      expect(prepared).toMatchObject({
        scenarioId: 'training_adjustment',
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
        scenario_id: 'training_adjustment',
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

      expect(prepared.seedProfileVersion).toBe('single-tenant-live-v2');
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

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { clearActiveChatDomain } from './chat-conversation-state';
import { clearChatHistory } from './chat-history-store';
import {
  clearCompletedChatConfirmationsForScope,
  clearPendingChatConfirmation,
} from './chat-pending-confirmations';
import { clearPendingChatCoreV2CommandsForScope } from './chat-core-v2/pending-commands';
import { clearRecentChatEntitiesForUser } from './chat-action-state';
import { clearAllConversations } from '../state/conversation';
import { clearSecretaryStateContextCacheForScope } from '../domains/secretary';
import type {
  ChatLiveEvalRequestContext,
  ChatLiveEvalScenarioId,
} from './chat-live-evaluation-contract';
import {
  buildChatLiveEvalSeedBlock,
  CHAT_LIVE_EVAL_MUTATION_TASK_ID,
  CHAT_LIVE_EVAL_MUTATION_TASK_TITLE,
  CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
} from './chat-live-evaluation-context';

export {
  CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
  getCurrentChatLiveEvalSeedBlock,
  runWithChatLiveEvalContext,
} from './chat-live-evaluation-context';

export interface ChatLiveEvalResetHooks {
  clearProcessState(input: { userId: number; tenantId: number }): Record<string, number>;
}

const defaultResetHooks: ChatLiveEvalResetHooks = {
  clearProcessState({ userId, tenantId }) {
    clearActiveChatDomain(userId, tenantId);
    clearAllConversations(userId, tenantId);
    clearChatHistory(userId, tenantId);
    const pendingConfirmation = clearPendingChatConfirmation(userId, tenantId) ? 1 : 0;
    const completedConfirmation = clearCompletedChatConfirmationsForScope(userId, tenantId);
    const pendingCoreV2Command = clearPendingChatCoreV2CommandsForScope({ userId, tenantId });
    clearRecentChatEntitiesForUser(userId, tenantId);
    const secretaryContextCache = clearSecretaryStateContextCacheForScope(userId, tenantId);
    return {
      pendingConfirmation,
      completedConfirmation,
      pendingCoreV2Command,
      secretaryContextCache,
    };
  },
};

const DURABLE_EPHEMERAL_TABLES = [
  'chat_action_telemetry',
  'chat_action_runs',
  'chat_pending_actions',
  'chat_action_plans',
  'messages',
  'conversations',
  'chat_conversation_state',
] as const;

function existingTableNames(db: Database.Database): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function resetDurableScope(
  db: Database.Database,
  context: ChatLiveEvalRequestContext,
): Record<string, number> {
  const tables = existingTableNames(db);
  const counts: Record<string, number> = {};
  for (const table of DURABLE_EPHEMERAL_TABLES) {
    if (!tables.has(table)) continue;
    const columns = columnNames(db, table);
    if (!columns.has('user_id')) continue;
    const result = columns.has('tenant_id')
      ? db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND tenant_id = ?`).run(context.userId, context.tenantId)
      : db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(context.userId);
    counts[table] = result.changes;
  }
  return counts;
}

const CHAT_LIVE_EVAL_TASK_DEPENDENCIES = [
  ['task_provider_links', 'chatLiveEvalTaskProviderLinks'],
  ['task_mutations', 'chatLiveEvalTaskMutations'],
  ['task_sync_issues', 'chatLiveEvalTaskSyncIssues'],
  ['task_sync_observability_events', 'chatLiveEvalTaskSyncEvents'],
] as const;

function resetAndSeedMutationTarget(
  db: Database.Database,
  context: ChatLiveEvalRequestContext,
): Record<string, number> {
  if (context.scenarioId !== 'morning_planning') return {};
  const tables = existingTableNames(db);
  if (!tables.has('unified_tasks')) {
    throw new Error('Chat live-evaluation mutation seed requires the canonical task store.');
  }
  const taskColumns = columnNames(db, 'unified_tasks');
  const requiredTaskColumns = [
    'user_id', 'tenant_id', 'provider', 'external_id', 'title', 'status',
    'priority', 'provider_data', 'is_deleted', 'synced_at', 'nexus_task_id',
    'local_version', 'sync_state', 'source_of_truth',
  ];
  if (requiredTaskColumns.some((column) => !taskColumns.has(column))) {
    throw new Error('Chat live-evaluation mutation seed requires the current canonical task schema.');
  }

  const counts: Record<string, number> = {};
  const ownedArtifact = db.prepare(`
    SELECT 1
      FROM unified_tasks
     WHERE nexus_task_id = ? AND title = ? AND source_of_truth = 'chat_live_eval'
       AND user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(
    CHAT_LIVE_EVAL_MUTATION_TASK_ID,
    CHAT_LIVE_EVAL_MUTATION_TASK_TITLE,
    context.userId,
    context.tenantId,
  );
  for (const [table, countKey] of CHAT_LIVE_EVAL_TASK_DEPENDENCIES) {
    if (!tables.has(table)) continue;
    const columns = columnNames(db, table);
    if (!columns.has('task_id') || !columns.has('user_id') || !columns.has('tenant_id')) continue;
    counts[countKey] = ownedArtifact
      ? db.prepare(`
          DELETE FROM ${table}
           WHERE task_id = ? AND user_id = ? AND tenant_id = ?
        `).run(CHAT_LIVE_EVAL_MUTATION_TASK_ID, context.userId, context.tenantId).changes
      : 0;
  }
  counts.chatLiveEvalTaskArtifacts = ownedArtifact
    ? db.prepare(`
        DELETE FROM unified_tasks
         WHERE nexus_task_id = ? AND title = ? AND source_of_truth = 'chat_live_eval'
           AND user_id = ? AND tenant_id = ?
      `).run(
        CHAT_LIVE_EVAL_MUTATION_TASK_ID,
        CHAT_LIVE_EVAL_MUTATION_TASK_TITLE,
        context.userId,
        context.tenantId,
      ).changes
    : 0;

  db.prepare(`
    INSERT INTO unified_tasks (
      user_id, tenant_id, provider, external_id, title, status, priority,
      provider_data, is_deleted, synced_at, nexus_task_id, local_version,
      sync_state, source_of_truth
    ) VALUES (?, ?, 'nexus', ?, ?, 'pending', 0, ?, 0, ?, ?, 1, 'local_only', 'chat_live_eval')
  `).run(
    context.userId,
    context.tenantId,
    CHAT_LIVE_EVAL_MUTATION_TASK_ID,
    CHAT_LIVE_EVAL_MUTATION_TASK_TITLE,
    JSON.stringify({ source: 'chat_live_eval', scenarioId: context.scenarioId }),
    new Date().toISOString(),
    CHAT_LIVE_EVAL_MUTATION_TASK_ID,
  );
  counts.chatLiveEvalTaskSeeded = 1;
  return counts;
}

export interface ChatLiveEvalScenarioPreparation {
  scenarioId: ChatLiveEvalScenarioId;
  seedProfileVersion: typeof CHAT_LIVE_EVAL_SEED_PROFILE_VERSION;
  seedProfileHash: string;
  resetCounts: Record<string, number>;
  preparedAt: string;
}

export function prepareChatLiveEvalScenario(
  db: Database.Database,
  context: ChatLiveEvalRequestContext,
  hooks: ChatLiveEvalResetHooks = defaultResetHooks,
): ChatLiveEvalScenarioPreparation {
  if (!context.scenarioId) throw new Error('Chat live-evaluation preparation requires an allowlisted scenario.');
  const block = buildChatLiveEvalSeedBlock(context.scenarioId);
  const seedProfileHash = createHash('sha256').update(block).digest('hex');
  const preparedAt = new Date().toISOString();
  const prepare = db.transaction(() => {
    const durable = resetDurableScope(db, context);
    const mutation = resetAndSeedMutationTarget(db, context);
    const process = hooks.clearProcessState({ userId: context.userId, tenantId: context.tenantId });
    const resetCounts = { ...durable, ...mutation, ...process };
    db.prepare(`
      INSERT INTO chat_live_eval_preparations (
        run_id, scenario_id, mode, user_id, tenant_id,
        seed_profile_version, seed_profile_hash, reset_counts_json, prepared_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, scenario_id, user_id, tenant_id) DO UPDATE SET
        mode = excluded.mode,
        seed_profile_version = excluded.seed_profile_version,
        seed_profile_hash = excluded.seed_profile_hash,
        reset_counts_json = excluded.reset_counts_json,
        prepared_at = excluded.prepared_at
    `).run(
      context.runId,
      context.scenarioId,
      context.mode,
      context.userId,
      context.tenantId,
      CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
      seedProfileHash,
      JSON.stringify(resetCounts),
      preparedAt,
    );
    return resetCounts;
  });
  const resetCounts = prepare.immediate();
  return {
    scenarioId: context.scenarioId,
    seedProfileVersion: CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
    seedProfileHash,
    resetCounts,
    preparedAt,
  };
}

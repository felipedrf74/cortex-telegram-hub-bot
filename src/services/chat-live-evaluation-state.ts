// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { config } from '../config';
import { clearActiveChatDomain } from './chat-conversation-state';
import { clearChatHistory } from './chat-history-store';
import {
  clearCompletedChatConfirmationsForScope,
  clearPendingChatConfirmation,
} from './chat-pending-confirmations';
import { clearPendingChatCoreV2CommandsForScope } from './chat-core-v2/pending-commands';
import { clearRecentChatEntitiesForUser } from './chat-action-state';
import { resolveTrainingDay } from './training-date-utils';
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
  CHAT_LIVE_EVAL_TRAINING_FIXTURE,
} from './chat-live-evaluation-context';

export {
  CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
  getCurrentChatLiveEvalSeedBlock,
  getCurrentChatLiveEvalSeedFacts,
  isCurrentChatLiveEvalLocalEngine,
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

interface ChatLiveEvalTrainingSeedMaterial {
  timezone: string;
  localDate: string;
  localDay: string;
  planEndDate: string;
}

const CHAT_LIVE_EVAL_TRAINING_REQUIRED_TABLES = [
  'fitness_training_plans',
  'training_weeks',
  'training_sessions',
  'chat_live_eval_training_artifacts',
] as const;

const CHAT_LIVE_EVAL_TRAINING_UNEXPECTED_PLAN_REFERENCES = [
  ['training_operation_locks', 'plan_id'],
  ['training_plan_adaptations', 'plan_id'],
  ['training_plan_families', 'legacy_plan_id'],
  ['training_active_plan_references', 'projection_plan_id'],
] as const;

function buildTrainingSeedMaterial(
  db: Database.Database,
  context: ChatLiveEvalRequestContext,
  now: Date,
): ChatLiveEvalTrainingSeedMaterial | null {
  if (context.scenarioId !== 'training_adjustment') return null;
  const timezone = resolveChatLiveEvalTimezone(db, context.userId);
  const today = resolveTrainingDay({ now, timezone });
  return {
    timezone,
    localDate: today.date,
    localDay: today.weekdayName,
    planEndDate: resolveTrainingDay({ now, timezone, offsetDays: 6 }).date,
  };
}

function resetAndSeedTrainingTarget(
  db: Database.Database,
  context: ChatLiveEvalRequestContext,
  seed: ChatLiveEvalTrainingSeedMaterial | null,
  preparedAt: string,
): Record<string, number> {
  const tables = existingTableNames(db);
  const presentRequiredTables = CHAT_LIVE_EVAL_TRAINING_REQUIRED_TABLES
    .filter((table) => tables.has(table));
  if (presentRequiredTables.length === 0) {
    if (context.scenarioId === 'training_adjustment') {
      throw new Error('Chat live-evaluation Training seed requires the canonical Training store and ownership ledger.');
    }
    return {};
  }
  if (presentRequiredTables.length !== CHAT_LIVE_EVAL_TRAINING_REQUIRED_TABLES.length) {
    throw new Error('Chat live-evaluation Training cleanup requires the complete canonical Training schema.');
  }

  const counts: Record<string, number> = {
    chatLiveEvalTrainingPlansDeleted: 0,
    chatLiveEvalTrainingWeeksDeleted: 0,
    chatLiveEvalTrainingSessionsDeleted: 0,
    chatLiveEvalTrainingCompletionsDeleted: 0,
    chatLiveEvalTrainingPlansSeeded: 0,
    chatLiveEvalTrainingWeeksSeeded: 0,
    chatLiveEvalTrainingSessionsSeeded: 0,
  };
  const owned = db.prepare(`
    SELECT plan_id AS planId, scenario_id AS scenarioId,
           seed_profile_version AS seedProfileVersion
      FROM chat_live_eval_training_artifacts
     WHERE user_id = ? AND tenant_id = ?
     LIMIT 1
  `).get(context.userId, context.tenantId) as {
    planId: number;
    scenarioId: string;
    seedProfileVersion: string;
  } | undefined;

  if (owned) {
    const plan = db.prepare(`
      SELECT id, user_id AS userId, tenant_id AS tenantId, name,
             preferences_json AS preferencesJson
        FROM fitness_training_plans
       WHERE id = ?
       LIMIT 1
    `).get(owned.planId) as {
      id: number;
      userId: number;
      tenantId: number;
      name: string;
      preferencesJson: string | null;
    } | undefined;
    if (
      !plan
      || plan.userId !== context.userId
      || plan.tenantId !== context.tenantId
      || plan.name !== CHAT_LIVE_EVAL_TRAINING_FIXTURE.planName
      || owned.scenarioId !== 'training_adjustment'
      || !isChatLiveEvalTrainingOwnershipMarker(plan.preferencesJson, owned.seedProfileVersion)
    ) {
      throw new Error('Chat live-evaluation Training ownership verification failed closed.');
    }

    const sessionColumns = columnNames(db, 'training_sessions');
    if (
      !sessionColumns.has('tenant_id')
      || !sessionColumns.has('week_id')
      || !sessionColumns.has('calendar_event_id')
      || !sessionColumns.has('calendar_source')
    ) {
      throw new Error('Chat live-evaluation Training cleanup requires current tenant and calendar session fields.');
    }
    const foreignTenantSessionCount = Number((db.prepare(`
      SELECT COUNT(*) AS count
        FROM training_sessions sessions
        LEFT JOIN training_weeks weeks ON weeks.id = sessions.week_id
       WHERE (sessions.plan_id = ? OR weeks.plan_id = ?)
         AND (sessions.tenant_id IS NULL OR sessions.tenant_id <> ?)
    `).get(plan.id, plan.id, context.tenantId) as { count: number }).count);
    if (foreignTenantSessionCount > 0) {
      throw new Error('Chat live-evaluation Training session tenant scope verification failed closed.');
    }
    const mismatchedWeekSessionCount = Number((db.prepare(`
      SELECT COUNT(*) AS count
        FROM training_sessions sessions
        LEFT JOIN training_weeks weeks ON weeks.id = sessions.week_id
       WHERE (sessions.plan_id = ? OR weeks.plan_id = ?)
         AND (
           sessions.plan_id <> ?
           OR weeks.id IS NULL
           OR weeks.plan_id <> ?
         )
    `).get(plan.id, plan.id, plan.id, plan.id) as { count: number }).count);
    if (mismatchedWeekSessionCount > 0) {
      throw new Error('Chat live-evaluation Training session/week ownership verification failed closed.');
    }

    if (tables.has('training_completions')) {
      const completionColumns = columnNames(db, 'training_completions');
      if (!completionColumns.has('plan_id') || !completionColumns.has('session_id')) {
        throw new Error('Chat live-evaluation Training cleanup requires current completion ownership fields.');
      }
      const inconsistentCompletionCount = Number((db.prepare(`
        SELECT COUNT(*) AS count
          FROM training_completions completions
          LEFT JOIN training_sessions sessions ON sessions.id = completions.session_id
         WHERE (completions.plan_id = ? OR sessions.plan_id = ?)
           AND (
             completions.plan_id <> ?
             OR sessions.id IS NULL
             OR sessions.plan_id <> ?
             OR sessions.tenant_id IS NULL
             OR sessions.tenant_id <> ?
           )
      `).get(
        plan.id,
        plan.id,
        plan.id,
        plan.id,
        context.tenantId,
      ) as { count: number }).count);
      if (inconsistentCompletionCount > 0) {
        throw new Error('Chat live-evaluation Training completion ownership verification failed closed.');
      }
    }

    if (tables.has('training_agenda_event_ownership')) {
      const agendaColumns = columnNames(db, 'training_agenda_event_ownership');
      if (!agendaColumns.has('plan_id')) {
        throw new Error('Chat live-evaluation Training cleanup requires current agenda ownership fields.');
      }
      const includesSessionReference = agendaColumns.has('session_id');
      const agendaCount = Number((db.prepare(`
        SELECT COUNT(*) AS count
          FROM training_agenda_event_ownership
         WHERE plan_id = ?
           ${includesSessionReference
            ? 'OR session_id IN (SELECT id FROM training_sessions WHERE plan_id = ?)'
            : ''}
      `).get(
        plan.id,
        ...(includesSessionReference ? [plan.id] : []),
      ) as { count: number }).count);
      if (agendaCount > 0) {
        throw new Error('Chat live-evaluation Training artifact unexpectedly owns calendar events.');
      }
    }

    const directlyLinkedCalendarSessionCount = Number((db.prepare(`
      SELECT COUNT(*) AS count
        FROM training_sessions
       WHERE plan_id = ?
         AND (
           NULLIF(TRIM(COALESCE(calendar_event_id, '')), '') IS NOT NULL
           OR NULLIF(TRIM(COALESCE(calendar_source, '')), '') IS NOT NULL
         )
    `).get(plan.id) as { count: number }).count);
    if (directlyLinkedCalendarSessionCount > 0) {
      throw new Error('Chat live-evaluation Training artifact unexpectedly has direct calendar linkage.');
    }

    for (const [table, referenceColumn] of CHAT_LIVE_EVAL_TRAINING_UNEXPECTED_PLAN_REFERENCES) {
      if (!tables.has(table)) continue;
      const columns = columnNames(db, table);
      if (!columns.has(referenceColumn)) continue;
      const referenceCount = Number((db.prepare(`
        SELECT COUNT(*) AS count
          FROM ${table}
         WHERE ${referenceColumn} = ?
      `).get(plan.id) as { count: number }).count);
      if (referenceCount > 0) {
        throw new Error(`Chat live-evaluation Training artifact has an unexpected reference in ${table}.`);
      }
    }

    const revisionLinkedPlanCount = columnNames(db, 'fitness_training_plans').has('source_revision_id')
      ? Number((db.prepare(`
          SELECT COUNT(*) AS count
            FROM fitness_training_plans
           WHERE id = ? AND source_revision_id IS NOT NULL
        `).get(plan.id) as { count: number }).count)
      : 0;
    const weekColumns = columnNames(db, 'training_weeks');
    const revisionLinkedWeekCount = weekColumns.has('source_revision_id')
      ? Number((db.prepare(`
          SELECT COUNT(*) AS count
            FROM training_weeks
           WHERE plan_id = ?
             AND (
               source_revision_id IS NOT NULL
               ${weekColumns.has('revision_week_key') ? 'OR revision_week_key IS NOT NULL' : ''}
             )
        `).get(plan.id) as { count: number }).count)
      : 0;
    const revisionLinkedSessionCount = sessionColumns.has('source_revision_id')
      ? Number((db.prepare(`
          SELECT COUNT(*) AS count
            FROM training_sessions
           WHERE plan_id = ?
             AND (
               source_revision_id IS NOT NULL
               ${sessionColumns.has('revision_session_key') ? 'OR revision_session_key IS NOT NULL' : ''}
             )
        `).get(plan.id) as { count: number }).count)
      : 0;
    if (revisionLinkedPlanCount + revisionLinkedWeekCount + revisionLinkedSessionCount > 0) {
      throw new Error('Chat live-evaluation Training artifact unexpectedly belongs to a revision projection.');
    }

    counts.chatLiveEvalTrainingSessionsDeleted = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id = ?
    `).get(plan.id) as { count: number }).count);
    counts.chatLiveEvalTrainingWeeksDeleted = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM training_weeks WHERE plan_id = ?
    `).get(plan.id) as { count: number }).count);
    if (tables.has('training_completions')) {
      const completionColumns = columnNames(db, 'training_completions');
      if (completionColumns.has('plan_id')) {
        counts.chatLiveEvalTrainingCompletionsDeleted = db.prepare(`
          DELETE FROM training_completions WHERE plan_id = ?
        `).run(plan.id).changes;
      }
    }
    db.prepare('DELETE FROM training_sessions WHERE plan_id = ?').run(plan.id);
    db.prepare('DELETE FROM training_weeks WHERE plan_id = ?').run(plan.id);
    db.prepare(`
      DELETE FROM chat_live_eval_training_artifacts
       WHERE user_id = ? AND tenant_id = ? AND plan_id = ?
    `).run(context.userId, context.tenantId, plan.id);
    counts.chatLiveEvalTrainingPlansDeleted = db.prepare(`
      DELETE FROM fitness_training_plans
       WHERE id = ? AND user_id = ? AND tenant_id = ?
    `).run(plan.id, context.userId, context.tenantId).changes;
    if (counts.chatLiveEvalTrainingPlansDeleted !== 1) {
      throw new Error('Chat live-evaluation Training artifact deletion failed closed.');
    }
  }

  const activePlanCount = Number((db.prepare(`
    SELECT COUNT(*) AS count
      FROM fitness_training_plans
     WHERE user_id = ? AND tenant_id = ? AND status = 'active'
  `).get(context.userId, context.tenantId) as { count: number }).count);
  if (activePlanCount > 0) {
    throw new Error('The dedicated chat live-evaluation scope already contains an active Training plan.');
  }

  if (!seed) return counts;

  const reservedNameCollision = db.prepare(`
    SELECT 1
      FROM fitness_training_plans
     WHERE user_id = ? AND tenant_id = ? AND name = ?
     LIMIT 1
  `).get(
    context.userId,
    context.tenantId,
    CHAT_LIVE_EVAL_TRAINING_FIXTURE.planName,
  );
  if (reservedNameCollision) {
    throw new Error('Chat live-evaluation Training reserved-name collision failed closed.');
  }

  const marker = JSON.stringify({
    source: 'chat_live_eval',
    artifactKey: CHAT_LIVE_EVAL_TRAINING_FIXTURE.artifactKey,
    seedProfileVersion: CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
  });
  const planResult = db.prepare(`
    INSERT INTO fitness_training_plans (
      user_id, tenant_id, name, sport, goal, duration_weeks, periodization,
      status, start_date, end_date, preferences_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'linear', 'active', ?, ?, ?, ?, ?)
  `).run(
    context.userId,
    context.tenantId,
    CHAT_LIVE_EVAL_TRAINING_FIXTURE.planName,
    CHAT_LIVE_EVAL_TRAINING_FIXTURE.sport,
    CHAT_LIVE_EVAL_TRAINING_FIXTURE.goal,
    seed.localDate,
    seed.planEndDate,
    marker,
    preparedAt,
    preparedAt,
  );
  const planId = Number(planResult.lastInsertRowid);
  counts.chatLiveEvalTrainingPlansSeeded = 1;

  const weekResult = db.prepare(`
    INSERT INTO training_weeks (
      plan_id, week_number, focus, intensity_pct, volume_sessions, notes,
      auto_adjusted, adjustment_reason, created_at
    ) VALUES (?, 1, 'Recovery-aware strength', 75, 1, NULL, 0, NULL, ?)
  `).run(planId, preparedAt);
  const weekId = Number(weekResult.lastInsertRowid);
  counts.chatLiveEvalTrainingWeeksSeeded = 1;

  db.prepare(`
    INSERT INTO training_sessions (
      week_id, plan_id, tenant_id, day_of_week, session_type, title,
      description, exercises_json, duration_minutes, intensity_text,
      calendar_event_id, calendar_source, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 'scheduled', ?, ?)
  `).run(
    weekId,
    planId,
    context.tenantId,
    seed.localDay,
    CHAT_LIVE_EVAL_TRAINING_FIXTURE.sessionType,
    CHAT_LIVE_EVAL_TRAINING_FIXTURE.sessionTitle,
    CHAT_LIVE_EVAL_TRAINING_FIXTURE.durationMinutes,
    CHAT_LIVE_EVAL_TRAINING_FIXTURE.intensityText,
    preparedAt,
    preparedAt,
  );
  counts.chatLiveEvalTrainingSessionsSeeded = 1;

  db.prepare(`
    INSERT INTO chat_live_eval_training_artifacts (
      user_id, tenant_id, scenario_id, plan_id, seed_profile_version, created_at
    ) VALUES (?, ?, 'training_adjustment', ?, ?, ?)
  `).run(
    context.userId,
    context.tenantId,
    planId,
    CHAT_LIVE_EVAL_SEED_PROFILE_VERSION,
    preparedAt,
  );
  return counts;
}

function isChatLiveEvalTrainingOwnershipMarker(
  raw: string | null,
  seedProfileVersion: string,
): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.source === 'chat_live_eval'
      && parsed.artifactKey === CHAT_LIVE_EVAL_TRAINING_FIXTURE.artifactKey
      && parsed.seedProfileVersion === seedProfileVersion;
  } catch {
    return false;
  }
}

function resolveChatLiveEvalTimezone(db: Database.Database, userId: number): string {
  const fallback = config.app.timezone || 'Europe/Lisbon';
  const tables = existingTableNames(db);
  let candidate = fallback;
  if (tables.has('users')) {
    const columns = columnNames(db, 'users');
    if (columns.has('id') && columns.has('timezone')) {
      const row = db.prepare('SELECT timezone FROM users WHERE id = ? LIMIT 1')
        .get(userId) as { timezone?: string | null } | undefined;
      candidate = String(row?.timezone ?? fallback);
    }
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return fallback;
  }
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
  const preparedAt = new Date().toISOString();
  const trainingSeed = buildTrainingSeedMaterial(db, context, new Date(preparedAt));
  const seedProfileHash = createHash('sha256')
    .update(JSON.stringify({
      block,
      training: trainingSeed
        ? {
          ...CHAT_LIVE_EVAL_TRAINING_FIXTURE,
          ...trainingSeed,
        }
        : null,
    }))
    .digest('hex');
  const prepare = db.transaction(() => {
    const durable = resetDurableScope(db, context);
    const training = resetAndSeedTrainingTarget(db, context, trainingSeed, preparedAt);
    const mutation = resetAndSeedMutationTarget(db, context);
    const process = hooks.clearProcessState({ userId: context.userId, tenantId: context.tenantId });
    const resetCounts = { ...durable, ...training, ...mutation, ...process };
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

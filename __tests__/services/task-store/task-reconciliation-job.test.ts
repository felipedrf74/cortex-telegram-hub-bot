// SAFETY-NET SUITE for src/services/task-store/task-reconciliation-job.ts.
//
// These tests pin the CURRENT behavior of the reconciliation job so refactors
// cannot silently change it. They are descriptive, not normative: where the
// current behavior looks suspicious it is pinned anyway and flagged with a
// "PINNED (suspicious)" comment instead of being fixed here.
//
// Runtime surface under test: runTaskProviderLinkReconciliation is the only
// function export, and the scheduler drives the job exclusively through it
// (src/services/scheduler.ts requires exactly that symbol), so every behavior
// below is exercised through that entry point.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

const providerApi = {
  getTask: vi.fn(),
};

vi.mock('../../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../../src/services/oauth-store', () => ({
  isConnected: vi.fn(() => true),
}));

vi.mock('../../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: vi.fn(() => providerApi),
  resolveTaskProvider: vi.fn(() => 'nexus'),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { isConnected } from '../../../src/services/oauth-store';
import { getTaskProviderForUser } from '../../../src/services/task-store/task-router';
import { logger } from '../../../src/utils/logger';
import { runTaskProviderLinkReconciliation } from '../../../src/services/task-store/task-reconciliation-job';

const USER_ID = 42;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE unified_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      project_id INTEGER,
      project_name TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      due_date TEXT,
      due_is_datetime INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      notes TEXT,
      completed_at TEXT,
      assignee TEXT,
      url TEXT,
      provider_data TEXT DEFAULT '{}',
      content_hash TEXT,
      is_deleted INTEGER DEFAULT 0,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      nexus_task_id TEXT NOT NULL,
      local_version INTEGER NOT NULL DEFAULT 1,
      sync_state TEXT NOT NULL DEFAULT 'queued',
      source_of_truth TEXT NOT NULL DEFAULT 'nexus',
      deleted_at TEXT
    );

    CREATE TABLE task_provider_links (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      provider_task_id TEXT,
      provider_list_id TEXT,
      provider_project_id TEXT,
      provider_version TEXT,
      provider_updated_at TEXT,
      last_synced_at TEXT,
      last_verified_at TEXT,
      ownership TEXT NOT NULL,
      link_state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE task_sync_issues (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT,
      code TEXT NOT NULL,
      message TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
  `);
  return db;
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

interface SeedInput {
  taskId: string;
  provider?: 'ms_todo' | 'todoist' | 'nexus_local';
  providerTaskId?: string | null;
  providerListId?: string | null;
  providerProjectId?: string | null;
  providerAccountId?: string;
  lastVerifiedAt?: string | null;
  linkState?: string;
  syncState?: string;
  projectName?: string | null;
  isDeleted?: 0 | 1;
}

function seedLinkedTask(input: SeedInput): { linkId: string; providerTaskId: string | null } {
  const provider = input.provider ?? 'ms_todo';
  const providerTaskId = input.providerTaskId === undefined ? `pt-${input.taskId}` : input.providerTaskId;
  const providerListId = input.providerListId === undefined
    ? (provider === 'ms_todo' ? `list-${input.taskId}` : null)
    : input.providerListId;
  const providerProjectId = input.providerProjectId === undefined
    ? (provider === 'todoist' ? `proj-${input.taskId}` : null)
    : input.providerProjectId;
  const projectName = input.projectName === undefined ? 'Work' : input.projectName;
  const linkId = `link-${input.taskId}`;

  testDb.prepare(
    `INSERT INTO unified_tasks (
       user_id, tenant_id, provider, external_id, project_name, title,
       status, provider_data, nexus_task_id, local_version, sync_state,
       source_of_truth, is_deleted
     ) VALUES (?, ?, 'nexus', ?, ?, 'Reconcile Task', 'pending', '{}', ?, 1, ?, 'nexus', ?)`,
  ).run(
    USER_ID,
    USER_ID,
    input.taskId,
    projectName,
    input.taskId,
    input.syncState ?? 'synced',
    input.isDeleted ?? 0,
  );
  testDb.prepare(
    `INSERT INTO task_provider_links (
       id, task_id, tenant_id, user_id, provider, provider_account_id,
       provider_task_id, provider_list_id, provider_project_id,
       last_verified_at, ownership, link_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nexus_created', ?)`,
  ).run(
    linkId,
    input.taskId,
    USER_ID,
    USER_ID,
    provider,
    input.providerAccountId ?? `${provider}:${USER_ID}`,
    providerTaskId,
    providerListId,
    providerProjectId,
    input.lastVerifiedAt ?? null,
    input.linkState ?? 'linked',
  );
  return { linkId, providerTaskId };
}

function getLink(taskId: string): { link_state: string; last_verified_at: string | null } {
  return testDb.prepare(
    `SELECT link_state, last_verified_at FROM task_provider_links WHERE task_id = ?`,
  ).get(taskId) as { link_state: string; last_verified_at: string | null };
}

function getTaskSyncState(taskId: string): string {
  const row = testDb.prepare(
    `SELECT sync_state FROM unified_tasks WHERE nexus_task_id = ?`,
  ).get(taskId) as { sync_state: string };
  return row.sync_state;
}

function getIssues(taskId: string): Array<{ code: string; state: string; message: string | null; details: Record<string, unknown> }> {
  const rows = testDb.prepare(
    `SELECT code, state, message, details_json FROM task_sync_issues WHERE task_id = ? ORDER BY created_at ASC`,
  ).all(taskId) as Array<{ code: string; state: string; message: string | null; details_json: string }>;
  return rows.map((row) => ({
    code: row.code,
    state: row.state,
    message: row.message,
    details: JSON.parse(row.details_json),
  }));
}

beforeEach(() => {
  testDb = createTestDb();
  vi.clearAllMocks();
  vi.mocked(isConnected).mockImplementation(() => true);
  vi.mocked(getTaskProviderForUser).mockImplementation(() => providerApi as any);
  providerApi.getTask.mockResolvedValue({ success: true, data: { id: 'provider-task-1' } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('task reconciliation job safety net', () => {
  describe('duplicate provider link scan', () => {
    it('flips an entire duplicate provider_task_id group (including orphaned siblings) to conflict and records provider_conflict issues transactionally', async () => {
      // Duplicate group: two active links plus one orphaned link all pointing at
      // the same provider task. Tasks are seeded is_deleted=1 so the per-link
      // probe phase (which joins on is_deleted = 0) cannot run; every state
      // change asserted here comes from scanDuplicateProviderLinks alone.
      // PINNED (suspicious): the scan has no is_deleted filter, so it flips
      // sync_state on already-deleted unified_tasks rows too.
      seedLinkedTask({ taskId: 'dup-a', providerTaskId: 'dup-pt', isDeleted: 1 });
      seedLinkedTask({ taskId: 'dup-b', providerTaskId: 'dup-pt', isDeleted: 1 });
      // PINNED (suspicious): orphaned links are excluded from the duplicate
      // COUNT/GROUP_CONCAT, but the group UPDATE has no link_state filter, so
      // an orphaned sibling sharing the provider_task_id is flipped to
      // 'conflict' as well — without its task being touched or an issue filed.
      seedLinkedTask({ taskId: 'dup-orphan', providerTaskId: 'dup-pt', linkState: 'orphaned', isDeleted: 1 });
      // nexus_local links are excluded from the scan even when they collide.
      seedLinkedTask({ taskId: 'local-a', provider: 'nexus_local', providerTaskId: 'local-pt', isDeleted: 1 });
      seedLinkedTask({ taskId: 'local-b', provider: 'nexus_local', providerTaskId: 'local-pt', isDeleted: 1 });
      // Empty-string provider_task_ids are excluded from grouping.
      seedLinkedTask({ taskId: 'empty-a', providerTaskId: '', isDeleted: 1 });
      seedLinkedTask({ taskId: 'empty-b', providerTaskId: '', isDeleted: 1 });
      // Control: unique provider_task_id stays untouched.
      seedLinkedTask({ taskId: 'solo', isDeleted: 1 });

      const result = await runTaskProviderLinkReconciliation();

      // duplicateLinks counts duplicate GROUPS, not duplicate link rows.
      expect(result.duplicateLinks).toBe(1);
      expect(result.scannedLinks).toBe(0);
      expect(providerApi.getTask).not.toHaveBeenCalled();

      expect(getLink('dup-a').link_state).toBe('conflict');
      expect(getLink('dup-b').link_state).toBe('conflict');
      expect(getLink('dup-orphan').link_state).toBe('conflict');
      expect(getTaskSyncState('dup-a')).toBe('conflict');
      expect(getTaskSyncState('dup-b')).toBe('conflict');
      expect(getTaskSyncState('dup-orphan')).toBe('synced');

      for (const untouched of ['local-a', 'local-b', 'empty-a', 'empty-b', 'solo']) {
        expect(getLink(untouched).link_state).toBe('linked');
        expect(getTaskSyncState(untouched)).toBe('synced');
      }

      for (const taskId of ['dup-a', 'dup-b']) {
        expect(getIssues(taskId)).toEqual([{
          code: 'provider_conflict',
          state: 'open',
          message: 'Multiple Nexus tasks are linked to the same provider task. Review required.',
          // duplicateCount only counts the non-orphaned rows in the group.
          details: { providerTaskId: 'dup-pt', duplicateCount: 2 },
        }]);
      }
      expect(getIssues('dup-orphan')).toEqual([]);
    });

    it('re-verifies reachable duplicate links back to linked in the same run while their tasks stay conflict', async () => {
      // PINNED (suspicious): scanDuplicateProviderLinks runs before candidate
      // selection, and conflict links are still probe candidates. When the
      // provider still returns the task, markVerified immediately flips the
      // links back to 'linked' and resolveTaskSyncIssue closes the
      // provider_conflict issue recorded moments earlier in the SAME run —
      // yet unified_tasks.sync_state stays 'conflict' because 'conflict' is
      // not in markVerified's heal list. Net effect: conflicted tasks with
      // healthy-looking links and no open issue explaining why.
      seedLinkedTask({ taskId: 'live-dup-a', providerTaskId: 'live-dup-pt' });
      seedLinkedTask({ taskId: 'live-dup-b', providerTaskId: 'live-dup-pt' });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.duplicateLinks).toBe(1);
      expect(result.scannedLinks).toBe(2);
      expect(result.verifiedLinks).toBe(2);
      for (const taskId of ['live-dup-a', 'live-dup-b']) {
        expect(getLink(taskId).link_state).toBe('linked');
        expect(getTaskSyncState(taskId)).toBe('conflict');
        expect(getIssues(taskId)).toEqual([expect.objectContaining({
          code: 'provider_conflict',
          state: 'resolved',
        })]);
      }
    });
  });

  describe('candidate selection, batch cap, and staleness gate', () => {
    it('scans at most 50 links per run by default', async () => {
      // Pins DEFAULT_LIMIT = 50.
      for (let i = 0; i < 52; i += 1) {
        seedLinkedTask({ taskId: `cap-${String(i).padStart(2, '0')}` });
      }

      const result = await runTaskProviderLinkReconciliation();

      expect(result.scannedLinks).toBe(50);
      expect(result.verifiedLinks).toBe(50);
      const unverified = testDb.prepare(
        `SELECT COUNT(*) AS count FROM task_provider_links WHERE last_verified_at IS NULL`,
      ).get() as { count: number };
      expect(unverified.count).toBe(2);
    });

    it('clamps explicit limits into [1, 200] and treats limit 0 as the default 50', async () => {
      // Pins the clamp expression: Math.min(Math.max(Number(limit || 50), 1), 200).
      for (let i = 0; i < 205; i += 1) {
        seedLinkedTask({ taskId: `clamp-${String(i).padStart(3, '0')}` });
      }

      const first = await runTaskProviderLinkReconciliation({ limit: 999 });
      expect(first.scannedLinks).toBe(200);
      expect(first.verifiedLinks).toBe(200);

      // limit: 0 is falsy, so it falls back to the default 50 — never-verified
      // rows sort first, so the 5 leftovers are verified and the other 45
      // freshly-verified 'linked' rows are scanned but skipped by the gate.
      const second = await runTaskProviderLinkReconciliation({ limit: 0 });
      expect(second.scannedLinks).toBe(50);
      expect(second.verifiedLinks).toBe(5);

      // Negative limits clamp up to 1; everything is fresh now, so nothing verifies.
      const third = await runTaskProviderLinkReconciliation({ limit: -10 });
      expect(third.scannedLinks).toBe(1);
      expect(third.verifiedLinks).toBe(0);
    });

    it('probes only linked rows older than the 24h staleness threshold and passes container/task/project-name args to getTask', async () => {
      // Pins STALE_AFTER_MS = 24h (strict '>' on the age comparison; 23h and
      // 25h are used to stay clear of the exact boundary).
      const freshSeed = isoHoursAgo(23);
      seedLinkedTask({ taskId: 'fresh', lastVerifiedAt: freshSeed, projectName: 'Work' });
      const staleSeed = isoHoursAgo(25);
      seedLinkedTask({ taskId: 'aged', lastVerifiedAt: staleSeed, projectName: null });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.scannedLinks).toBe(2);
      expect(result.verifiedLinks).toBe(1);
      expect(providerApi.getTask).toHaveBeenCalledTimes(1);
      // getTask(containerId, providerTaskId, projectName || 'Tasks') — a null
      // project_name falls back to the literal 'Tasks'.
      expect(providerApi.getTask).toHaveBeenCalledWith('list-aged', 'pt-aged', 'Tasks');
      expect(vi.mocked(getTaskProviderForUser)).toHaveBeenCalledWith(USER_ID, 'ms_todo');

      // The fresh row keeps its seeded timestamp untouched.
      expect(getLink('fresh').last_verified_at).toBe(freshSeed);
      // The aged row gets a fresh ISO last_verified_at from markVerified.
      const agedRow = getLink('aged');
      expect(agedRow.last_verified_at).not.toBe(staleSeed);
      expect(agedRow.last_verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('probes non-linked rows even when recently verified and heals provider_missing back to synced', async () => {
      // The freshness skip requires BOTH a recent last_verified_at AND
      // link_state === 'linked'; a provider_missing link verified 1h ago is
      // still re-probed and healed when the provider task reappears.
      seedLinkedTask({
        taskId: 'reappeared',
        linkState: 'provider_missing',
        syncState: 'provider_missing',
        lastVerifiedAt: isoHoursAgo(1),
      });
      testDb.prepare(
        `INSERT INTO task_sync_issues (id, task_id, tenant_id, user_id, provider, code, state)
         VALUES ('issue-reappeared', 'reappeared', ?, ?, 'ms_todo', 'provider_task_missing', 'open')`,
      ).run(USER_ID, USER_ID);

      const result = await runTaskProviderLinkReconciliation();

      expect(providerApi.getTask).toHaveBeenCalledTimes(1);
      expect(result.verifiedLinks).toBe(1);
      expect(getLink('reappeared').link_state).toBe('linked');
      expect(getTaskSyncState('reappeared')).toBe('synced');
      expect(getIssues('reappeared')).toEqual([expect.objectContaining({
        code: 'provider_task_missing',
        state: 'resolved',
      })]);
    });

    it('never considers nexus_local links, pending/orphaned link states, or deleted tasks', async () => {
      seedLinkedTask({ taskId: 'skip-local', provider: 'nexus_local' });
      seedLinkedTask({ taskId: 'skip-pc', linkState: 'pending_create' });
      seedLinkedTask({ taskId: 'skip-pu', linkState: 'pending_update' });
      seedLinkedTask({ taskId: 'skip-pd', linkState: 'pending_delete' });
      seedLinkedTask({ taskId: 'skip-orphaned', linkState: 'orphaned' });
      seedLinkedTask({ taskId: 'skip-deleted', isDeleted: 1 });

      const result = await runTaskProviderLinkReconciliation();

      expect(result).toEqual({
        scannedLinks: 0,
        verifiedLinks: 0,
        staleLinks: 0,
        duplicateLinks: 0,
        providerMissing: 0,
        providerDisconnected: 0,
        missingContainers: 0,
        failed: 0,
      });
      expect(providerApi.getTask).not.toHaveBeenCalled();
      expect(getTaskSyncState('skip-deleted')).toBe('synced');
    });

    it('orders candidates never-verified first, then oldest last_verified_at', async () => {
      const orderCSeed = isoHoursAgo(30);
      seedLinkedTask({ taskId: 'order-c', lastVerifiedAt: orderCSeed });
      seedLinkedTask({ taskId: 'order-a', lastVerifiedAt: null });
      seedLinkedTask({ taskId: 'order-b', lastVerifiedAt: isoHoursAgo(40) });

      const result = await runTaskProviderLinkReconciliation({ limit: 2 });

      expect(result.scannedLinks).toBe(2);
      expect(providerApi.getTask.mock.calls.map((call) => call[1])).toEqual(['pt-order-a', 'pt-order-b']);
      // order-c missed the batch and keeps its seeded timestamp.
      expect(getLink('order-c').last_verified_at).toBe(orderCSeed);
    });
  });

  describe('per-link reconciliation state mapping', () => {
    it('marks ms_todo links without a list container stale/failed_permanent with provider_list_missing', async () => {
      seedLinkedTask({ taskId: 'no-list', providerListId: null });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.missingContainers).toBe(1);
      expect(providerApi.getTask).not.toHaveBeenCalled();
      expect(getLink('no-list').link_state).toBe('stale');
      expect(getTaskSyncState('no-list')).toBe('failed_permanent');
      expect(getIssues('no-list')).toEqual([{
        code: 'provider_list_missing',
        state: 'open',
        message: 'The provider list no longer exists. Choose a new sync target.',
        details: { reason: 'reconciliation_missing_container' },
      }]);
    });

    it('falls back from provider_project_id to provider_list_id for todoist before flagging provider_project_missing', async () => {
      seedLinkedTask({
        taskId: 'todoist-fallback',
        provider: 'todoist',
        providerProjectId: null,
        providerListId: 'fallback-list',
      });
      seedLinkedTask({
        taskId: 'todoist-missing',
        provider: 'todoist',
        providerProjectId: null,
        providerListId: null,
      });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.missingContainers).toBe(1);
      expect(result.verifiedLinks).toBe(1);
      expect(providerApi.getTask).toHaveBeenCalledTimes(1);
      expect(providerApi.getTask).toHaveBeenCalledWith('fallback-list', 'pt-todoist-fallback', 'Work');
      expect(getLink('todoist-fallback').link_state).toBe('linked');
      expect(getLink('todoist-missing').link_state).toBe('stale');
      expect(getTaskSyncState('todoist-missing')).toBe('failed_permanent');
      expect(getIssues('todoist-missing')).toEqual([expect.objectContaining({
        code: 'provider_project_missing',
        message: 'The provider project no longer exists. Choose a new sync target.',
      })]);
    });

    it('marks links disconnected/provider_disconnected when oauth-store reports the provider disconnected', async () => {
      vi.mocked(isConnected).mockImplementation(() => false);
      seedLinkedTask({ taskId: 'disc-ms', provider: 'ms_todo' });
      seedLinkedTask({ taskId: 'disc-todoist', provider: 'todoist' });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.providerDisconnected).toBe(2);
      expect(providerApi.getTask).not.toHaveBeenCalled();
      // ms_todo maps to the 'outlook' oauth provider, todoist to 'todoist'.
      expect(vi.mocked(isConnected)).toHaveBeenCalledWith(USER_ID, 'outlook');
      expect(vi.mocked(isConnected)).toHaveBeenCalledWith(USER_ID, 'todoist');
      for (const taskId of ['disc-ms', 'disc-todoist']) {
        expect(getLink(taskId).link_state).toBe('disconnected');
        expect(getTaskSyncState(taskId)).toBe('provider_disconnected');
        expect(getIssues(taskId)).toEqual([expect.objectContaining({
          code: 'provider_disconnected',
          state: 'open',
          message: 'Saved locally. Sync will resume when the provider reconnects.',
          details: { reason: 'reconciliation_provider_disconnected' },
        })]);
      }
    });

    it('marks links without a provider_task_id stale/stale with a retry_scheduled issue', async () => {
      seedLinkedTask({ taskId: 'no-pt', providerTaskId: null });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.staleLinks).toBe(1);
      expect(providerApi.getTask).not.toHaveBeenCalled();
      expect(getLink('no-pt').link_state).toBe('stale');
      expect(getTaskSyncState('no-pt')).toBe('stale');
      expect(getIssues('no-pt')).toEqual([expect.objectContaining({
        code: 'retry_scheduled',
        details: { reason: 'reconciliation_missing_provider_task_id' },
      })]);
    });

    it('maps null responses, 404-flavoured failures, and success-with-null-data to provider_missing on link and task', async () => {
      // isProviderMissingResponse treats three shapes as "provider lost the
      // task": a nullish response, success:false whose error text matches
      // /not found|404|gone|missing/, and success:true with data == null.
      // PINNED (suspicious): the regex matches those substrings ANYWHERE in
      // the error text, so e.g. success:false 'ETag missing' would also be
      // classified as provider_missing rather than a retryable error.
      seedLinkedTask({ taskId: 'pm-null', providerTaskId: 'pm-null-pt' });
      seedLinkedTask({ taskId: 'pm-404', providerTaskId: 'pm-404-pt' });
      seedLinkedTask({ taskId: 'pm-empty', providerTaskId: 'pm-empty-pt' });
      providerApi.getTask.mockImplementation(async (_containerId: string, providerTaskId: string) => {
        if (providerTaskId === 'pm-null-pt') return null;
        if (providerTaskId === 'pm-404-pt') return { success: false, error: 'Task not found (404)' };
        return { success: true, data: null };
      });

      const result = await runTaskProviderLinkReconciliation();

      expect(result).toEqual({
        scannedLinks: 3,
        verifiedLinks: 0,
        staleLinks: 0,
        duplicateLinks: 0,
        providerMissing: 3,
        providerDisconnected: 0,
        missingContainers: 0,
        failed: 0,
      });
      for (const taskId of ['pm-null', 'pm-404', 'pm-empty']) {
        expect(getLink(taskId).link_state).toBe('provider_missing');
        expect(getTaskSyncState(taskId)).toBe('provider_missing');
        expect(getIssues(taskId)).toEqual([expect.objectContaining({
          code: 'provider_task_missing',
          state: 'open',
          message: 'Provider no longer has this task.',
          details: { reason: 'reconciliation_provider_missing' },
        })]);
      }
    });

    it('maps non-404 provider errors (including auth failures) to stale/stale retry_scheduled, not disconnected', async () => {
      // PINNED: there is NO probe-time auth error mapping. 'disconnected' /
      // 'provider_disconnected' come exclusively from oauth-store.isConnected
      // before the probe; a 401 returned by the provider API lands in the
      // generic success:false branch and is marked stale + retry_scheduled.
      seedLinkedTask({ taskId: 'auth-err' });
      providerApi.getTask.mockResolvedValue({ success: false, error: '401 Unauthorized: token expired' });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.staleLinks).toBe(1);
      expect(result.providerDisconnected).toBe(0);
      expect(getLink('auth-err').link_state).toBe('stale');
      expect(getTaskSyncState('auth-err')).toBe('stale');
      expect(getIssues('auth-err')).toEqual([expect.objectContaining({
        code: 'retry_scheduled',
        message: 'Provider link verification failed. Retry scheduled.',
        details: {
          reason: 'reconciliation_provider_error',
          error: '401 Unauthorized: token expired',
        },
      })]);
    });

    it('marks links stale/stale when the provider API exposes no getTask function', async () => {
      vi.mocked(getTaskProviderForUser).mockImplementation(() => ({} as any));
      seedLinkedTask({ taskId: 'no-gettask' });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.staleLinks).toBe(1);
      expect(getLink('no-gettask').link_state).toBe('stale');
      expect(getTaskSyncState('no-gettask')).toBe('stale');
      expect(getIssues('no-gettask')).toEqual([expect.objectContaining({
        code: 'retry_scheduled',
        details: { reason: 'reconciliation_get_task_unavailable' },
      })]);
    });

    it('converts thrown provider errors into failed count + stale/stale + retry_scheduled and keeps processing', async () => {
      seedLinkedTask({ taskId: 'throws', providerTaskId: 'throws-pt' });
      seedLinkedTask({ taskId: 'healthy', providerTaskId: 'healthy-pt' });
      providerApi.getTask.mockImplementation(async (_containerId: string, providerTaskId: string) => {
        if (providerTaskId === 'throws-pt') throw new Error('boom');
        return { success: true, data: { id: providerTaskId } };
      });

      const result = await runTaskProviderLinkReconciliation();

      expect(result.failed).toBe(1);
      expect(result.verifiedLinks).toBe(1);
      expect(result.scannedLinks).toBe(2);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      expect(getLink('throws').link_state).toBe('stale');
      expect(getTaskSyncState('throws')).toBe('stale');
      expect(getIssues('throws')).toEqual([expect.objectContaining({
        code: 'retry_scheduled',
        message: 'Provider link reconciliation failed. Retry scheduled.',
        details: { reason: 'reconciliation_exception' },
      })]);
      expect(getLink('healthy').link_state).toBe('linked');
    });

    it('aborts provider probes after the 10s verification timeout via the failure path', async () => {
      // Pins VERIFY_TIMEOUT_MS = 10_000: a hung getTask rejects at 10s and is
      // handled by the generic exception path (failed + stale + retry_scheduled).
      vi.useFakeTimers();
      seedLinkedTask({ taskId: 'hangs' });
      providerApi.getTask.mockImplementation(() => new Promise(() => undefined));

      let settled = false;
      const runPromise = runTaskProviderLinkReconciliation().then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const result = await runPromise;

      expect(result.failed).toBe(1);
      expect(getLink('hangs').link_state).toBe('stale');
      expect(getTaskSyncState('hangs')).toBe('stale');
      expect(getIssues('hangs')).toEqual([expect.objectContaining({
        code: 'retry_scheduled',
        details: { reason: 'reconciliation_exception' },
      })]);
    });

    it('heals only transient task sync states on successful verification and resolves all open issues for the task', async () => {
      // markVerified heals sync_state to 'synced' only for
      // ['stale', 'provider_missing', 'provider_disconnected', 'failed_retryable'];
      // anything else ('conflict', 'failed_permanent', 'queued', ...) is left alone.
      const healed = ['stale', 'provider_missing', 'provider_disconnected', 'failed_retryable'];
      const preserved = ['conflict', 'failed_permanent'];
      for (const syncState of [...healed, ...preserved]) {
        seedLinkedTask({ taskId: `heal-${syncState}`, linkState: 'stale', syncState });
      }
      // PINNED (suspicious): resolveTaskSyncIssue is called with no code
      // filter, so a successful probe resolves EVERY open issue for the
      // task+provider — including a provider_conflict issue on a task whose
      // sync_state stays 'conflict'.
      testDb.prepare(
        `INSERT INTO task_sync_issues (id, task_id, tenant_id, user_id, provider, code, state)
         VALUES ('issue-heal-conflict', 'heal-conflict', ?, ?, 'ms_todo', 'provider_conflict', 'open')`,
      ).run(USER_ID, USER_ID);

      const result = await runTaskProviderLinkReconciliation();

      expect(result.verifiedLinks).toBe(6);
      for (const syncState of healed) {
        expect(getLink(`heal-${syncState}`).link_state).toBe('linked');
        expect(getTaskSyncState(`heal-${syncState}`)).toBe('synced');
      }
      for (const syncState of preserved) {
        expect(getLink(`heal-${syncState}`).link_state).toBe('linked');
        expect(getTaskSyncState(`heal-${syncState}`)).toBe(syncState);
      }
      expect(getIssues('heal-conflict')).toEqual([expect.objectContaining({
        code: 'provider_conflict',
        state: 'resolved',
      })]);
    });
  });

  describe('idempotency', () => {
    it('a second run is a state fixed-point: fresh links are skipped and missing links are re-marked without new issue rows', async () => {
      seedLinkedTask({ taskId: 'idem-ok', providerTaskId: 'idem-ok-pt' });
      seedLinkedTask({ taskId: 'idem-missing', providerTaskId: 'idem-missing-pt' });
      providerApi.getTask.mockImplementation(async (_containerId: string, providerTaskId: string) => {
        if (providerTaskId === 'idem-missing-pt') return null;
        return { success: true, data: { id: providerTaskId } };
      });

      const first = await runTaskProviderLinkReconciliation();
      expect(first.verifiedLinks).toBe(1);
      expect(first.providerMissing).toBe(1);
      const okAfterFirst = getLink('idem-ok');
      const missingAfterFirst = getLink('idem-missing');

      const second = await runTaskProviderLinkReconciliation();

      // PINNED: the second run is a no-op on STATE, not on WORK — the
      // just-verified link is skipped by the 24h gate, but the
      // provider_missing link is re-probed and re-marked every run because
      // 'provider_missing' is not excluded from candidate selection.
      expect(second).toEqual({
        scannedLinks: 2,
        verifiedLinks: 0,
        staleLinks: 0,
        duplicateLinks: 0,
        providerMissing: 1,
        providerDisconnected: 0,
        missingContainers: 0,
        failed: 0,
      });
      expect(providerApi.getTask).toHaveBeenCalledTimes(3);
      expect(getLink('idem-ok')).toEqual(okAfterFirst);
      expect(getLink('idem-missing')).toEqual(missingAfterFirst);
      expect(getTaskSyncState('idem-ok')).toBe('synced');
      expect(getTaskSyncState('idem-missing')).toBe('provider_missing');
      // recordTaskSyncIssue updates the existing open issue instead of
      // inserting a duplicate row.
      expect(getIssues('idem-missing')).toHaveLength(1);
      expect(getIssues('idem-missing')[0]).toEqual(expect.objectContaining({
        code: 'provider_task_missing',
        state: 'open',
      }));
      expect(getIssues('idem-ok')).toEqual([]);
    });
  });
});

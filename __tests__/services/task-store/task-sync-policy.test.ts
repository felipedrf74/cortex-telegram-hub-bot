/**
 * SAFETY-NET tests for src/services/task-store/task-sync-policy.ts
 *
 * These tests PIN the behavior of the task sync policy through the M2/M3
 * task-sync milestones. They are deliberately behavioral snapshots —
 * including the NEX-05 mirror-id miss, which M3 confirmed as intentional
 * resolver design (see the dedicated test at the bottom). Do not "fix" a red
 * test here by editing production code without first checking whether the
 * pinned behavior was changed intentionally.
 *
 * Public surface under test (the module's full export list):
 *   - resolveTaskSyncTarget(input)      — main consumer entry point
 *   - getTaskContainerMapping(...)      — exact-key mapping lookup
 * getDirectProviderProjectMapping is module-private; its fallback semantics
 * are pinned through resolveTaskSyncTarget.
 *
 * Note: resolveTaskSyncTarget does NOT consult oauth/provider-connection
 * state. The provider decision arrives pre-resolved as `preferredProvider`
 * (computed upstream by resolveTaskProvider in task-router.ts), so only the
 * database and logger modules are mocked here, matching sibling suites.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

let testDb: Database.Database;

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

vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  getTaskContainerMapping,
  resolveTaskSyncTarget,
} from '../../../src/services/task-store/task-sync-policy';
import { upsertProject } from '../../../src/services/task-store/unified-task-store';

const USER_ID = 42;
const TENANT_ID = 42;

let mappingSeq = 0;

/**
 * Mirrors offline-first-task-service getOrCreateProject: nexus mirror lists
 * are unified_projects rows with provider = 'nexus'. Returns the row id as a
 * string, which is exactly what createOfflineFirstTask feeds into
 * resolveTaskSyncTarget as nexusListId.
 */
function seedNexusList(name: string, userId = USER_ID, tenantId = TENANT_ID): string {
  const id = testDb.prepare(
    `INSERT INTO unified_projects (
       user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
     ) VALUES (?, ?, 'nexus', ?, ?, 0, 0, datetime('now'))`,
  ).run(userId, tenantId, `list_${name.toLowerCase()}`, name).lastInsertRowid;
  return String(id);
}

/** Raw provider project row WITHOUT the upsertProject mapping side effect. */
function seedProviderProjectRow(
  provider: 'ms_todo' | 'todoist',
  externalId: string,
  name: string,
): string {
  const id = testDb.prepare(
    `INSERT INTO unified_projects (
       user_id, tenant_id, provider, external_id, name, is_default, task_count, synced_at
     ) VALUES (?, ?, ?, ?, ?, 0, 0, datetime('now'))`,
  ).run(USER_ID, TENANT_ID, provider, externalId, name).lastInsertRowid;
  return String(id);
}

function insertMapping(input: {
  nexusListId: string;
  provider: 'ms_todo' | 'todoist';
  containerType: 'todo_list' | 'project' | 'section';
  containerId: string;
  syncDirection: 'none' | 'pull_only' | 'push_only' | 'bidirectional';
  userId?: number;
  tenantId?: number;
}): void {
  mappingSeq += 1;
  testDb.prepare(
    `INSERT INTO task_container_mappings (
       id, tenant_id, user_id, nexus_list_id, provider, provider_container_type,
       provider_container_id, sync_direction
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `mapping_test_${mappingSeq}`,
    input.tenantId ?? TENANT_ID,
    input.userId ?? USER_ID,
    input.nexusListId,
    input.provider,
    input.containerType,
    input.containerId,
    input.syncDirection,
  );
}

function mappingCount(): number {
  const row = testDb.prepare(
    'SELECT COUNT(*) AS count FROM task_container_mappings',
  ).get() as { count: number };
  return row.count;
}

const MS_TODO_FAILED_TARGET = {
  provider: 'ms_todo',
  providerAccountId: `ms_todo:${USER_ID}`,
  providerListId: null,
  providerProjectId: null,
  syncState: 'failed_permanent',
  mutationStatus: 'failed',
  linkState: 'stale',
  warning: {
    code: 'provider_list_missing',
    provider: 'ms_todo',
    message: 'The provider list no longer exists. Choose a new sync target.',
  },
};

const TODOIST_FAILED_TARGET = {
  provider: 'todoist',
  providerAccountId: `todoist:${USER_ID}`,
  providerListId: null,
  providerProjectId: null,
  syncState: 'failed_permanent',
  mutationStatus: 'failed',
  linkState: 'stale',
  warning: {
    code: 'provider_project_missing',
    provider: 'todoist',
    message: 'The provider project no longer exists. Choose a new sync target.',
  },
};

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(USER_ID, USER_ID);
  vi.clearAllMocks();
});

describe('resolveTaskSyncTarget — nexus_local (no sync provider)', () => {
  it('resolves preferredProvider=nexus to a synced local-only target mirroring the nexus list id', () => {
    const nexusListId = seedNexusList('Inbox');

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'nexus',
    });

    expect(target).toEqual({
      provider: 'nexus_local',
      providerAccountId: `nexus_local:${USER_ID}`,
      providerListId: nexusListId,
      providerProjectId: nexusListId,
      syncState: 'local_only',
      mutationStatus: 'synced',
      linkState: 'linked',
    });
  });

  it('does not consult mapping tables for nexus targets — unknown list ids still resolve local_only', () => {
    // Pin: the nexus_local branch short-circuits before any DB lookup, so
    // even a list id with no unified_projects row and a hostile 'none'
    // mapping resolves as a healthy local-only target.
    insertMapping({
      nexusListId: '9999',
      provider: 'ms_todo',
      containerType: 'todo_list',
      containerId: 'AAMk-unused',
      syncDirection: 'none',
    });

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: '9999',
      preferredProvider: 'nexus',
    });

    expect(target.provider).toBe('nexus_local');
    expect(target.syncState).toBe('local_only');
    expect(target.mutationStatus).toBe('synced');
    expect(target.warning).toBeUndefined();
  });
});

describe('resolveTaskSyncTarget — container mapping hit', () => {
  it('maps an ms_todo todo_list mapping to a queued list target', () => {
    const nexusListId = seedNexusList('Groceries');
    insertMapping({
      nexusListId,
      provider: 'ms_todo',
      containerType: 'todo_list',
      containerId: 'AAMk-groceries-list',
      syncDirection: 'bidirectional',
    });

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'ms_todo',
    });

    expect(target).toEqual({
      provider: 'ms_todo',
      providerAccountId: `ms_todo:${USER_ID}`,
      providerListId: 'AAMk-groceries-list',
      providerProjectId: null,
      syncState: 'queued',
      mutationStatus: 'queued',
      linkState: 'pending_create',
    });
  });

  it('maps a todoist project mapping to a queued project target (list id stays null)', () => {
    const nexusListId = seedNexusList('Errands');
    insertMapping({
      nexusListId,
      provider: 'todoist',
      containerType: 'project',
      containerId: '2203451234',
      syncDirection: 'bidirectional',
    });

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'todoist',
    });

    expect(target).toEqual({
      provider: 'todoist',
      providerAccountId: `todoist:${USER_ID}`,
      providerListId: null,
      providerProjectId: '2203451234',
      syncState: 'queued',
      mutationStatus: 'queued',
      linkState: 'pending_create',
    });
  });

  it('routes section-type containers to providerProjectId, not providerListId', () => {
    // Pin: only 'todo_list' populates providerListId; every other container
    // type ('project', 'section') lands in providerProjectId.
    const nexusListId = seedNexusList('Sectioned');
    insertMapping({
      nexusListId,
      provider: 'todoist',
      containerType: 'section',
      containerId: 'section-777',
      syncDirection: 'push_only',
    });

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'todoist',
    });

    expect(target.providerListId).toBeNull();
    expect(target.providerProjectId).toBe('section-777');
    expect(target.syncState).toBe('queued');
  });

  it('treats push_only mappings as syncable', () => {
    // Pin: only 'none' and 'pull_only' block outbound sync; 'push_only'
    // and 'bidirectional' both produce a queued target.
    const nexusListId = seedNexusList('PushOnly');
    insertMapping({
      nexusListId,
      provider: 'ms_todo',
      containerType: 'todo_list',
      containerId: 'AAMk-push-only',
      syncDirection: 'push_only',
    });

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'ms_todo',
    });

    expect(target.syncState).toBe('queued');
    expect(target.mutationStatus).toBe('queued');
    expect(target.providerListId).toBe('AAMk-push-only');
    expect(target.warning).toBeUndefined();
  });
});

describe('resolveTaskSyncTarget — sync_direction gating', () => {
  it('resolves sync_direction=none to the failed/missing ms_todo outcome', () => {
    // Pin (current quirk): a mapping the user explicitly set to 'none' is
    // reported with the same 'provider_list_missing' warning as a genuinely
    // absent mapping — the policy does not distinguish "opted out" from
    // "list gone".
    const nexusListId = seedNexusList('OptedOut');
    insertMapping({
      nexusListId,
      provider: 'ms_todo',
      containerType: 'todo_list',
      containerId: 'AAMk-opted-out',
      syncDirection: 'none',
    });

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'ms_todo',
    });

    expect(target).toEqual(MS_TODO_FAILED_TARGET);
  });

  it('resolves sync_direction=pull_only to the failed/missing todoist outcome', () => {
    const nexusListId = seedNexusList('PullOnly');
    insertMapping({
      nexusListId,
      provider: 'todoist',
      containerType: 'project',
      containerId: '2203459999',
      syncDirection: 'pull_only',
    });

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'todoist',
    });

    expect(target).toEqual(TODOIST_FAILED_TARGET);
  });
});

describe('resolveTaskSyncTarget — mapping miss', () => {
  it('resolves to failed_permanent with provider_list_missing when ms_todo has no mapping at all', () => {
    const nexusListId = seedNexusList('Unmapped');

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'ms_todo',
    });

    expect(target).toEqual(MS_TODO_FAILED_TARGET);
  });
});

describe('resolveTaskSyncTarget — direct provider-project fallback', () => {
  it('falls back to the ms_todo unified_projects row when nexusListId is that row id', () => {
    // No task_container_mappings row at all: the private
    // getDirectProviderProjectMapping fallback matches unified_projects by
    // numeric row id + provider and synthesizes a bidirectional todo_list
    // mapping from external_id.
    const msRowId = seedProviderProjectRow('ms_todo', 'AAMk-direct-list', 'Direct');
    expect(mappingCount()).toBe(0);

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: msRowId,
      preferredProvider: 'ms_todo',
    });

    expect(target).toEqual({
      provider: 'ms_todo',
      providerAccountId: `ms_todo:${USER_ID}`,
      providerListId: 'AAMk-direct-list',
      providerProjectId: null,
      syncState: 'queued',
      mutationStatus: 'queued',
      linkState: 'pending_create',
    });
  });

  it('falls back to a todoist project target with the synthesized bidirectional direction', () => {
    const todoistRowId = seedProviderProjectRow('todoist', '2203450001', 'Todoist Direct');

    const target = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: todoistRowId,
      preferredProvider: 'todoist',
    });

    // todoist rows synthesize container type 'project', so the external id
    // lands in providerProjectId; the forced 'bidirectional' direction means
    // the fallback can never hit the direction gate.
    expect(target.providerListId).toBeNull();
    expect(target.providerProjectId).toBe('2203450001');
    expect(target.syncState).toBe('queued');
  });

  it('misses when the list id is non-numeric or belongs to another provider row', () => {
    // Non-numeric nexus list id: fallback bails before querying.
    const nonNumeric = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: 'list_abc',
      preferredProvider: 'ms_todo',
    });
    expect(nonNumeric).toEqual(MS_TODO_FAILED_TARGET);

    // Numeric id that belongs to a provider='nexus' row: the fallback query
    // filters by provider, so a nexus mirror row id never matches ms_todo.
    const nexusListId = seedNexusList('MirrorOnly');
    const wrongProvider = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId,
      preferredProvider: 'ms_todo',
    });
    expect(wrongProvider).toEqual(MS_TODO_FAILED_TARGET);
  });
});

describe('getTaskContainerMapping', () => {
  it('returns the mapping keyed by tenant/user/nexus_list_id/provider', () => {
    const nexusListId = seedNexusList('Keyed');
    insertMapping({
      nexusListId,
      provider: 'ms_todo',
      containerType: 'todo_list',
      containerId: 'AAMk-keyed',
      syncDirection: 'pull_only',
    });

    const mapping = getTaskContainerMapping(TENANT_ID, USER_ID, nexusListId, 'ms_todo');

    expect(mapping).toEqual({
      nexusListId,
      provider: 'ms_todo',
      providerContainerType: 'todo_list',
      providerContainerId: 'AAMk-keyed',
      syncDirection: 'pull_only',
    });
  });

  it('returns null on any key-component mismatch (list, provider, user, tenant)', () => {
    const nexusListId = seedNexusList('Scoped');
    insertMapping({
      nexusListId,
      provider: 'ms_todo',
      containerType: 'todo_list',
      containerId: 'AAMk-scoped',
      syncDirection: 'bidirectional',
    });

    expect(getTaskContainerMapping(TENANT_ID, USER_ID, `${nexusListId}0`, 'ms_todo')).toBeNull();
    expect(getTaskContainerMapping(TENANT_ID, USER_ID, nexusListId, 'todoist')).toBeNull();
    expect(getTaskContainerMapping(TENANT_ID, USER_ID + 1, nexusListId, 'ms_todo')).toBeNull();
    expect(getTaskContainerMapping(TENANT_ID + 1, USER_ID, nexusListId, 'ms_todo')).toBeNull();
  });
});

describe('NEX-05 — provider-keyed mapping vs nexus-mirror consumer', () => {
  it('mirror-keyed lookups miss by design; create path feeds provider row ids since M3', () => {
    // ── PINNED DESIGN (M3) — the mirror-id miss is INTENTIONAL ──────────
    //
    // In the provider-rows-are-visible-lists model (post-de22b1a2), the
    // provider's own unified_projects rows ARE the lists the app shows, and
    // the only production writer of task_container_mappings —
    // ensureTaskContainerMappingForProviderProject (unified-task-store.ts,
    // called from upsertProject during provider pulls) — keys nexus_list_id
    // by that PROVIDER (ms_todo) row's id.
    //
    // A hidden nexus mirror row id is therefore NOT a valid mapping key, and
    // the resolver treats it as such on purpose:
    //
    //   1. getTaskContainerMapping misses (mappings are keyed under the
    //      ms_todo row id, this lookup uses the nexus mirror row id), and
    //   2. getDirectProviderProjectMapping misses (the mirror row has
    //      provider='nexus', not 'ms_todo'),
    //
    // so a mirror-id resolution reports failed/missing while the same
    // mapping resolves queued when addressed by the provider row id.
    //
    // This is no longer a live create-path defect: since M3,
    // resolveCreateTargetProject (offline-first-task-service.ts) resolves an
    // incoming listName to the visible provider row for ms_todo/todoist
    // users, so createOfflineFirstTask feeds provider row ids into this
    // resolver (covered in offline-first-task-service.test.ts). The pre-M3
    // backlog parked by mirror-id resolution is repaired one-shot by
    // scripts/task-mapping-repair.mjs (covered in
    // __tests__/scripts/task-mapping-repair.test.ts).
    // ────────────────────────────────────────────────────────────────────

    // Provider pull ingests the MS To Do list via the real writer path.
    upsertProject(
      USER_ID,
      { provider: 'ms_todo', externalId: 'AAMk-groceries', name: 'Groceries' },
      TENANT_ID,
    );
    const msRow = testDb.prepare(
      `SELECT id FROM unified_projects WHERE provider = 'ms_todo' AND external_id = 'AAMk-groceries'`,
    ).get() as { id: number };
    const mappingRow = testDb.prepare(
      `SELECT nexus_list_id, provider_container_id, sync_direction
       FROM task_container_mappings WHERE provider = 'ms_todo'`,
    ).get() as { nexus_list_id: string; provider_container_id: string; sync_direction: string };

    // The writer keyed the mapping by the PROVIDER row id, bidirectionally.
    expect(mappingRow).toEqual({
      nexus_list_id: String(msRow.id),
      provider_container_id: 'AAMk-groceries',
      sync_direction: 'bidirectional',
    });

    // A hidden nexus mirror list is a different row with a different id.
    const nexusMirrorListId = seedNexusList('Groceries');
    expect(nexusMirrorListId).not.toBe(String(msRow.id));

    const consumerTarget = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: nexusMirrorListId,
      preferredProvider: 'ms_todo',
    });

    // By design: mirror row ids are not mapping keys, so they miss.
    expect(consumerTarget).toEqual(MS_TODO_FAILED_TARGET);

    // The same mapping resolves queued when addressed by the provider row
    // id the writer used — which is what the M3 create path now produces.
    const providerKeyedTarget = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: String(msRow.id),
      preferredProvider: 'ms_todo',
    });
    expect(providerKeyedTarget.syncState).toBe('queued');
    expect(providerKeyedTarget.providerListId).toBe('AAMk-groceries');
  });
});

describe('resolveTaskSyncTarget — idempotent re-resolution', () => {
  it('re-resolving is pure and stable for both queued and failed outcomes', () => {
    const mappedListId = seedNexusList('Stable');
    insertMapping({
      nexusListId: mappedListId,
      provider: 'ms_todo',
      containerType: 'todo_list',
      containerId: 'AAMk-stable',
      syncDirection: 'bidirectional',
    });
    const unmappedListId = seedNexusList('Unstable');
    const countBefore = mappingCount();

    const queuedFirst = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: mappedListId,
      preferredProvider: 'ms_todo',
    });
    const queuedSecond = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: mappedListId,
      preferredProvider: 'ms_todo',
    });
    const failedFirst = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: unmappedListId,
      preferredProvider: 'ms_todo',
    });
    const failedSecond = resolveTaskSyncTarget({
      tenantId: TENANT_ID,
      userId: USER_ID,
      nexusListId: unmappedListId,
      preferredProvider: 'ms_todo',
    });

    expect(queuedSecond).toEqual(queuedFirst);
    expect(queuedFirst.syncState).toBe('queued');
    expect(failedSecond).toEqual(failedFirst);
    expect(failedFirst.syncState).toBe('failed_permanent');
    // Resolution is a pure read: it never writes mapping rows.
    expect(mappingCount()).toBe(countBefore);
  });
});

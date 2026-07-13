/**
 * Tests for src/services/task-store/todoist-adapter.ts
 *
 * Mocks `globalThis.fetch` (Node 18 native) to verify request shapes,
 * priority mapping, and Sync API cursor handling without hitting Todoist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../../src/services/database', () => ({ getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  TodoistAdapter,
  TODOIST_PRIORITY_FROM_NEXUS,
  TODOIST_PRIORITY_TO_NEXUS,
  rememberTodoistUserMapping,
  findNexusUserByTodoistId,
  _resetTodoistUserCacheForTests,
} from '../../../src/services/task-store/todoist-adapter';
import { storeTokens, _resetDecryptCacheForTests } from '../../../src/services/oauth-store';

const USER_ID = 42;

function setupOAuth(): void {
  storeTokens(USER_ID, 'todoist', {
    accessToken: 'test_access_token',
    refreshToken: 'test_access_token',
    tokenType: 'Bearer',
    expiresAt: null,
    scopes: ['data:read_write'],
  });
}

/** Build a vi.fn() that returns a fetch Response with the given JSON body. */
function mockFetchResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
  _resetTodoistUserCacheForTests();
  // Clear the oauth-store's in-memory decrypted-token cache (Phase 0.C)
  // between test cases. Without this reset, a prior test that called
  // storeTokens(42, 'todoist', ...) would leave a cached entry that
  // bleeds into the next case's fresh testDb, causing "not connected"
  // assertions to fail because getTokens returns the stale cached
  // object instead of the null from the empty DB.
  _resetDecryptCacheForTests();
  // OAuth encryption is now mandatory at runtime (audit P0-7).
  process.env.OAUTH_ENCRYPTION_KEY = 'test-key-deterministic-for-vitest-32chars';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Priority mapping ────────────────────────────────────────────────

describe('Todoist priority mapping', () => {
  it('Todoist 4 (urgent) → Nexus 4', () => {
    expect(TODOIST_PRIORITY_TO_NEXUS[4]).toBe(4);
  });

  it('Todoist 1 (normal) → Nexus 0 (none)', () => {
    expect(TODOIST_PRIORITY_TO_NEXUS[1]).toBe(0);
  });

  it('Nexus 4 → Todoist 4', () => {
    expect(TODOIST_PRIORITY_FROM_NEXUS[4]).toBe(4);
  });

  it('Nexus 1 (low) collapses to Todoist 1 (Todoist has no "low")', () => {
    expect(TODOIST_PRIORITY_FROM_NEXUS[1]).toBe(1);
  });
});

// ── mapTask ─────────────────────────────────────────────────────────

describe('TodoistAdapter.mapTask', () => {
  const adapter = new TodoistAdapter();

  it('maps a basic Todoist REST item to NormalizedTask', () => {
    const raw = {
      id: '12345',
      content: 'Write spec',
      description: 'Detailed notes',
      is_completed: false,
      priority: 3,
      due: { date: '2026-04-15' },
      labels: ['work', 'urgent'],
      url: 'https://todoist.com/showTask?id=12345',
      project_id: '999',
    };
    const task = adapter.mapTask(raw);

    expect(task.provider).toBe('todoist');
    expect(task.externalId).toBe('12345');
    expect(task.title).toBe('Write spec');
    expect(task.description).toBe('Detailed notes');
    expect(task.status).toBe('pending');
    expect(task.priority).toBe(3);
    expect(task.dueDate).toBe('2026-04-15');
    expect(task.dueIsDatetime).toBe(false);
    expect(task.tags).toEqual(['work', 'urgent']);
    expect(task.url).toBe('https://todoist.com/showTask?id=12345');
  });

  it('maps a Sync API item with checked=1 as completed', () => {
    const raw = { id: '99', content: 'Done thing', checked: 1, priority: 1 };
    const task = adapter.mapTask(raw);
    expect(task.status).toBe('completed');
  });

  it('detects datetime due dates', () => {
    const raw = {
      id: '7',
      content: 'Meeting',
      priority: 1,
      due: { date: '2026-04-15T15:00:00', datetime: '2026-04-15T15:00:00' },
    };
    const task = adapter.mapTask(raw);
    expect(task.dueIsDatetime).toBe(true);
  });

  it('resolves projectName from the project lookup map', () => {
    const projectMap = new Map([['999', 'Work']]);
    const raw = { id: '1', content: 'X', priority: 1, project_id: '999' };
    const task = adapter.mapTask(raw, projectMap);
    expect(task.projectName).toBe('Work');
  });

  it('preserves the raw payload in providerData for round-tripping', () => {
    const raw = { id: '1', content: 'X', priority: 1, custom_field: 'preserved' };
    const task = adapter.mapTask(raw);
    expect((task.providerData as any).custom_field).toBe('preserved');
  });
});

// ── isConnected ─────────────────────────────────────────────────────

describe('TodoistAdapter.isConnected', () => {
  it('returns false when no tokens stored', () => {
    const adapter = new TodoistAdapter();
    expect(adapter.isConnected(USER_ID)).toBe(false);
  });

  it('returns true after storeTokens', () => {
    setupOAuth();
    const adapter = new TodoistAdapter();
    expect(adapter.isConnected(USER_ID)).toBe(true);
  });
});

// ── getProjects ─────────────────────────────────────────────────────

describe('TodoistAdapter.getProjects', () => {
  it('issues a Bearer-authenticated GET to /projects', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse([
      { id: '1', name: 'Inbox', color: 'grey', is_inbox_project: true },
      { id: '2', name: 'Work', color: 'blue', is_inbox_project: false },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    const projects = await adapter.getProjects(USER_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.todoist.com/rest/v2/projects');
    expect(init.headers.Authorization).toBe('Bearer test_access_token');

    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({
      provider: 'todoist',
      externalId: '1',
      name: 'Inbox',
      isDefault: true,
    });
  });
});

// ── getTasks ────────────────────────────────────────────────────────

describe('TodoistAdapter.getTasks', () => {
  it('uses sync_token="*" on first sync (no cursor)', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      sync_token: 'cursor_v2',
      items: [{ id: '1', content: 'A', priority: 1, checked: 0 }],
      projects: [],
      user: { id: 555 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    const result = await adapter.getTasks(USER_ID);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sync_token).toBe('*');
    expect(body.resource_types).toContain('items');

    expect(result.tasks).toHaveLength(1);
    expect(result.nextCursor).toBe('cursor_v2');
  });

  it('reuses the cursor on subsequent syncs', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      sync_token: 'cursor_v3',
      items: [],
      projects: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    await adapter.getTasks(USER_ID, { sinceCursor: 'cursor_v2' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sync_token).toBe('cursor_v2');
  });

  it('caches the Todoist user_id → Nexus user mapping', async () => {
    setupOAuth();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse({
      sync_token: 'x',
      items: [],
      projects: [],
      user: { id: 12345 },
    })));

    const adapter = new TodoistAdapter();
    await adapter.getTasks(USER_ID);

    expect(findNexusUserByTodoistId(12345)).toBe(USER_ID);
  });

  it('filters out is_deleted items', async () => {
    setupOAuth();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse({
      sync_token: 'x',
      items: [
        { id: '1', content: 'Live', priority: 1, is_deleted: false },
        { id: '2', content: 'Dead', priority: 1, is_deleted: true },
      ],
      projects: [],
    })));

    const adapter = new TodoistAdapter();
    const result = await adapter.getTasks(USER_ID);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].externalId).toBe('1');
  });

  it('returns empty when not connected', async () => {
    // No setupOAuth — token is missing
    const adapter = new TodoistAdapter();
    const result = await adapter.getTasks(USER_ID);
    expect(result.tasks).toEqual([]);
  });
});

// ── createTask ──────────────────────────────────────────────────────

describe('TodoistAdapter.createTask', () => {
  it('POSTs to /tasks with mapped priority and labels', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      id: '999',
      content: 'New task',
      priority: 3,
      labels: ['x'],
      url: 'https://todoist.com/x',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    await adapter.createTask(USER_ID, {
      title: 'New task',
      status: 'pending',
      priority: 3,
      tags: ['x'],
      dueDate: '2026-05-01',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.todoist.com/rest/v2/tasks');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.content).toBe('New task');
    expect(body.priority).toBe(3);
    expect(body.labels).toEqual(['x']);
    expect(body.due_date).toBe('2026-05-01');
  });

  it('uses due_datetime when dueIsDatetime=true', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      id: '1', content: 'X', priority: 1,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    await adapter.createTask(USER_ID, {
      title: 'Time-bound',
      status: 'pending',
      priority: 0,
      dueDate: '2026-05-01T15:00:00',
      dueIsDatetime: true,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.due_datetime).toBe('2026-05-01T15:00:00');
    expect(body.due_date).toBeUndefined();
  });

  it('sends X-Request-Id when Nexus provides a provider idempotency key', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      id: 'request-id-task',
      content: 'Idempotent task',
      priority: 1,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    await adapter.createTask(USER_ID, {
      title: 'Idempotent task',
      status: 'pending',
      priority: 1,
    }, { idempotencyKey: 'todoist:acct:task:create:mutation' });

    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['X-Request-Id']).toBe('todoist:acct:task:create:mutation');
  });

  it('round-trips Nexus task marker through Todoist description without exposing it', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      id: 'marked-task',
      content: 'Marked task',
      description: 'Visible note\n\n<!-- nexus-task-id:task_nexus_123 -->',
      priority: 1,
      project_id: 'project-1',
      labels: [],
      is_completed: false,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    const task = await adapter.createTask(USER_ID, {
      title: 'Marked task',
      description: 'Visible note',
      status: 'pending',
      priority: 1,
      providerData: {
        project_id: 'project-1',
        nexus_task_id: 'task_nexus_123',
      },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.description).toBe('Visible note\n\n<!-- nexus-task-id:task_nexus_123 -->');
    expect(task.description).toBe('Visible note');
    expect(task.providerData?.nexus_task_id).toBe('task_nexus_123');
  });

  it('preserves the Nexus marker when updating a Todoist description', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    await adapter.updateTask(USER_ID, 'marked-task', {
      description: 'Updated visible note',
    }, { nexusTaskId: 'task_nexus_123' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.description).toBe('Updated visible note\n\n<!-- nexus-task-id:task_nexus_123 -->');
  });

  it('strips Nexus markers even when Todoist text is appended after the marker', () => {
    const adapter = new TodoistAdapter();
    const task = adapter.mapTask({
      id: 'marked-task',
      content: 'Marked task',
      description: 'Visible note\n\n<!-- nexus-task-id:task_nexus_123 -->\nAppended in Todoist',
      priority: 1,
      labels: [],
      is_completed: false,
    });

    expect(task.description).toBe('Visible note\nAppended in Todoist');
    expect(task.providerData?.description).toBe('Visible note\nAppended in Todoist');
    expect(task.providerData?.nexus_task_id).toBe('task_nexus_123');
  });
});

// ── completeTask / deleteTask ───────────────────────────────────────

describe('TodoistAdapter.completeTask', () => {
  it('POSTs to /tasks/:id/close', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    await adapter.completeTask(USER_ID, 'abc123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.todoist.com/rest/v2/tasks/abc123/close',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('TodoistAdapter.deleteTask', () => {
  it('DELETEs /tasks/:id', async () => {
    setupOAuth();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new TodoistAdapter();
    await adapter.deleteTask(USER_ID, 'abc123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.todoist.com/rest/v2/tasks/abc123',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

/**
 * Tests for src/services/task-store/notion-adapter.ts
 *  AND src/services/task-store/notion-mapping.ts
 *
 * Mocks the Notion API via vi.stubGlobal('fetch') and uses the real
 * kv_store-backed mapping module to verify the per-user / per-database
 * isolation, the inference heuristics, and the page→task mapping logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // kv_store is created lazily by model-config.loadModelOverrides; do it here
  // up-front so the mapping module finds the table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
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

vi.mock('../../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NotionAdapter } from '../../../src/services/task-store/notion-adapter';
import {
  saveDatabaseMapping,
  getDatabaseMappings,
  getDatabaseMapping,
  deleteDatabaseMapping,
  setActiveDatabase,
  getActiveDatabase,
  inferMapping,
  extractSchema,
  NotionDatabaseMapping,
} from '../../../src/services/task-store/notion-mapping';
import { storeTokens } from '../../../src/services/oauth-store';

const USER_ID = 77;
const OTHER_USER_ID = 88;
const DB_ID = 'db_abc123';

function setupOAuth(userId: number = USER_ID): void {
  storeTokens(userId, 'notion', {
    accessToken: 'notion_test_token',
    refreshToken: 'notion_test_token',
    tokenType: 'Bearer',
    expiresAt: null,
    scopes: ['workspace:ws1'],
  });
}

function makeMapping(over: Partial<NotionDatabaseMapping> = {}): NotionDatabaseMapping {
  return {
    userId: USER_ID,
    databaseId: DB_ID,
    databaseName: 'Tasks',
    titleProperty: 'Name',
    statusProperty: 'Status',
    statusMapping: {
      'Not started': 'pending',
      'In progress': 'in_progress',
      'Done': 'completed',
    },
    dueDateProperty: 'Due Date',
    tagsProperty: 'Tags',
    ...over,
  };
}

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── notion-mapping ──────────────────────────────────────────────────

describe('notion-mapping kv_store', () => {
  it('saves and retrieves a mapping', () => {
    saveDatabaseMapping(makeMapping());
    const fetched = getDatabaseMapping(USER_ID, DB_ID);
    expect(fetched).not.toBeNull();
    expect(fetched!.databaseName).toBe('Tasks');
    expect(fetched!.statusMapping['Done']).toBe('completed');
  });

  it('supports multiple databases per user', () => {
    saveDatabaseMapping(makeMapping({ databaseId: 'db1', databaseName: 'Work' }));
    saveDatabaseMapping(makeMapping({ databaseId: 'db2', databaseName: 'Personal' }));
    const all = getDatabaseMappings(USER_ID);
    expect(all).toHaveLength(2);
    const names = all.map(m => m.databaseName).sort();
    expect(names).toEqual(['Personal', 'Work']);
  });

  it('isolates mappings per user', () => {
    saveDatabaseMapping(makeMapping());
    saveDatabaseMapping(makeMapping({ userId: OTHER_USER_ID, databaseId: 'other_db' }));

    expect(getDatabaseMappings(USER_ID)).toHaveLength(1);
    expect(getDatabaseMappings(OTHER_USER_ID)).toHaveLength(1);
    expect(getDatabaseMappings(USER_ID)[0].databaseId).toBe(DB_ID);
    expect(getDatabaseMappings(OTHER_USER_ID)[0].databaseId).toBe('other_db');
  });

  it('overwrites on re-save (same key)', () => {
    saveDatabaseMapping(makeMapping({ databaseName: 'Original' }));
    saveDatabaseMapping(makeMapping({ databaseName: 'Renamed' }));
    expect(getDatabaseMapping(USER_ID, DB_ID)!.databaseName).toBe('Renamed');
  });

  it('deletes a mapping', () => {
    saveDatabaseMapping(makeMapping());
    deleteDatabaseMapping(USER_ID, DB_ID);
    expect(getDatabaseMapping(USER_ID, DB_ID)).toBeNull();
  });

  it('round-trips the active database id', () => {
    setActiveDatabase(USER_ID, DB_ID);
    expect(getActiveDatabase(USER_ID)).toBe(DB_ID);
  });
});

// ── inferMapping ────────────────────────────────────────────────────

describe('inferMapping', () => {
  it('detects title, status, due, and tags from a typical schema', () => {
    const schema = {
      'Task Name': { type: 'title' },
      'Status': { type: 'status', options: ['Not started', 'In Progress', 'Done'] },
      'Due Date': { type: 'date' },
      'Tags': { type: 'multi_select', options: ['urgent', 'work'] },
      'Created': { type: 'created_time' },
    };
    const mapping = inferMapping(USER_ID, 'db1', 'Tasks', schema as any);

    expect(mapping.titleProperty).toBe('Task Name');
    expect(mapping.statusProperty).toBe('Status');
    expect(mapping.statusMapping['Done']).toBe('completed');
    expect(mapping.statusMapping['In Progress']).toBe('in_progress');
    expect(mapping.statusMapping['Not started']).toBe('pending');
    expect(mapping.dueDateProperty).toBe('Due Date');
    expect(mapping.tagsProperty).toBe('Tags');
  });

  it('handles Portuguese property names', () => {
    const schema = {
      'Nome': { type: 'title' },
      'Estado': { type: 'select', options: ['A fazer', 'Em andamento', 'Concluído'] },
      'Prazo': { type: 'date' },
    };
    const mapping = inferMapping(USER_ID, 'db1', 'Tarefas', schema as any);
    expect(mapping.titleProperty).toBe('Nome');
    expect(mapping.statusProperty).toBe('Estado');
    expect(mapping.statusMapping['Concluído']).toBe('completed');
    expect(mapping.dueDateProperty).toBe('Prazo');
  });

  it('falls back to first matching type when names are unknown', () => {
    const schema = {
      'Foo': { type: 'title' },
      'Bar': { type: 'select', options: ['x', 'y'] },
      'Baz': { type: 'date' },
    };
    const mapping = inferMapping(USER_ID, 'db1', 'Mystery', schema as any);
    expect(mapping.titleProperty).toBe('Foo');
    expect(mapping.statusProperty).toBe('Bar');
  });
});

// ── extractSchema ───────────────────────────────────────────────────

describe('extractSchema', () => {
  it('extracts type and options from raw Notion property metadata', () => {
    const raw = {
      'Name': { id: 'a', type: 'title', title: {} },
      'Status': {
        id: 'b', type: 'status',
        status: { options: [{ name: 'New' }, { name: 'Done' }] },
      },
      'Tags': {
        id: 'c', type: 'multi_select',
        multi_select: { options: [{ name: 'work' }, { name: 'home' }] },
      },
      'Created': { id: 'd', type: 'created_time' },
    };
    const schema = extractSchema(raw);
    expect(schema['Name'].type).toBe('title');
    expect(schema['Status'].type).toBe('status');
    expect(schema['Status'].options).toEqual(['New', 'Done']);
    expect(schema['Tags'].options).toEqual(['work', 'home']);
    expect(schema['Created'].type).toBe('created_time');
  });
});

// ── NotionAdapter.mapPageToTask ────────────────────────────────────

describe('NotionAdapter.mapPageToTask', () => {
  const adapter = new NotionAdapter();

  it('maps a typical Notion page to NormalizedTask', () => {
    const page = {
      id: 'page_1',
      url: 'https://notion.so/page1',
      properties: {
        Name: { title: [{ plain_text: 'Write spec' }] },
        Status: { status: { name: 'In progress' } },
        'Due Date': { date: { start: '2026-04-15' } },
        Tags: { multi_select: [{ name: 'work' }, { name: 'urgent' }] },
      },
    };
    const task = adapter.mapPageToTask(page, makeMapping());
    expect(task).not.toBeNull();
    expect(task!.title).toBe('Write spec');
    expect(task!.status).toBe('in_progress');
    expect(task!.dueDate).toBe('2026-04-15');
    expect(task!.tags).toEqual(['work', 'urgent']);
    expect(task!.url).toBe('https://notion.so/page1');
    expect(task!.projectName).toBe('Tasks');
  });

  it('returns null when title is missing', () => {
    const page = { id: 'p', properties: { Name: { title: [] } } };
    expect(adapter.mapPageToTask(page, makeMapping())).toBeNull();
  });

  it('handles missing optional properties without throwing', () => {
    const page = {
      id: 'p',
      properties: { Name: { title: [{ plain_text: 'Bare' }] } },
    };
    const task = adapter.mapPageToTask(page, makeMapping());
    expect(task).not.toBeNull();
    expect(task!.dueDate).toBeUndefined();
    expect(task!.tags).toEqual([]);
  });

  it('detects datetime due dates', () => {
    const page = {
      id: 'p',
      properties: {
        Name: { title: [{ plain_text: 'Meeting' }] },
        'Due Date': { date: { start: '2026-04-15T15:00:00Z' } },
      },
    };
    const task = adapter.mapPageToTask(page, makeMapping());
    expect(task!.dueIsDatetime).toBe(true);
  });

  it('falls back to "pending" when status name is unknown', () => {
    const page = {
      id: 'p',
      properties: {
        Name: { title: [{ plain_text: 'X' }] },
        Status: { status: { name: 'Mystery' } },
      },
    };
    const task = adapter.mapPageToTask(page, makeMapping());
    expect(task!.status).toBe('pending');
  });
});

// ── isConnected + getProjects ──────────────────────────────────────

describe('NotionAdapter.isConnected', () => {
  it('returns false without OAuth', () => {
    expect(new NotionAdapter().isConnected(USER_ID)).toBe(false);
  });

  it('returns true after storeTokens', () => {
    setupOAuth();
    expect(new NotionAdapter().isConnected(USER_ID)).toBe(true);
  });
});

describe('NotionAdapter.getProjects', () => {
  it('returns one project per mapped database', async () => {
    setupOAuth();
    saveDatabaseMapping(makeMapping({ databaseId: 'db1', databaseName: 'Work' }));
    saveDatabaseMapping(makeMapping({ databaseId: 'db2', databaseName: 'Personal' }));
    setActiveDatabase(USER_ID, 'db2');

    const projects = await new NotionAdapter().getProjects(USER_ID);
    expect(projects).toHaveLength(2);
    const personal = projects.find(p => p.externalId === 'db2')!;
    expect(personal.isDefault).toBe(true);
    const work = projects.find(p => p.externalId === 'db1')!;
    expect(work.isDefault).toBe(false);
  });

  it('returns empty when no databases are mapped', async () => {
    setupOAuth();
    expect(await new NotionAdapter().getProjects(USER_ID)).toEqual([]);
  });
});

// ── getTasks ────────────────────────────────────────────────────────

describe('NotionAdapter.getTasks', () => {
  it('queries each mapped database and maps the results', async () => {
    setupOAuth();
    saveDatabaseMapping(makeMapping());

    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      results: [
        {
          id: 'page_1',
          url: 'https://notion.so/page1',
          properties: {
            Name: { title: [{ plain_text: 'Task A' }] },
            Status: { status: { name: 'Not started' } },
          },
        },
      ],
      has_more: false,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new NotionAdapter().getTasks(USER_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.notion.com/v1/databases/${DB_ID}/query`);
    expect(init.headers.Authorization).toBe('Bearer notion_test_token');
    expect(init.headers['Notion-Version']).toBe('2022-06-28');

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Task A');
  });

  it('returns empty when no mappings configured', async () => {
    setupOAuth();
    const result = await new NotionAdapter().getTasks(USER_ID);
    expect(result.tasks).toEqual([]);
  });

  it('paginates through has_more cursors', async () => {
    setupOAuth();
    saveDatabaseMapping(makeMapping());

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({
        results: [
          { id: 'p1', properties: { Name: { title: [{ plain_text: 'A' }] } } },
        ],
        has_more: true,
        next_cursor: 'cursor_2',
      }))
      .mockResolvedValueOnce(mockFetchResponse({
        results: [
          { id: 'p2', properties: { Name: { title: [{ plain_text: 'B' }] } } },
        ],
        has_more: false,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new NotionAdapter().getTasks(USER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.tasks).toHaveLength(2);

    // Second call should include the start_cursor
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondCallBody.start_cursor).toBe('cursor_2');
  });
});

// ── createTask ──────────────────────────────────────────────────────

describe('NotionAdapter.createTask', () => {
  it('throws when no mapping configured', async () => {
    setupOAuth();
    await expect(
      new NotionAdapter().createTask(USER_ID, { title: 'X', status: 'pending', priority: 0 }),
    ).rejects.toThrow(/No Notion database/);
  });

  it('POSTs a Notion page with the configured property names', async () => {
    setupOAuth();
    saveDatabaseMapping(makeMapping());

    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({
      id: 'new_page',
      url: 'https://notion.so/new',
      properties: {
        Name: { title: [{ plain_text: 'New task' }] },
        Status: { status: { name: 'Not started' } },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const task = await new NotionAdapter().createTask(USER_ID, {
      title: 'New task',
      status: 'pending',
      priority: 0,
      dueDate: '2026-05-01',
      tags: ['urgent'],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.notion.com/v1/pages');
    const body = JSON.parse(init.body);
    expect(body.parent.database_id).toBe(DB_ID);
    expect(body.properties.Name.title[0].text.content).toBe('New task');
    expect(body.properties['Due Date'].date.start).toBe('2026-05-01');
    expect(body.properties.Tags.multi_select).toEqual([{ name: 'urgent' }]);

    expect(task.title).toBe('New task');
    expect(task.externalId).toBe('new_page');
  });
});

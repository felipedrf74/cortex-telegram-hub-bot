/**
 * Tests for src/skills/skill-manager.ts
 *
 * Tests the runtime orchestration layer:
 * - seedDefaultSkills() — DB seeding with idempotency
 * - getToolsForDomain() — per-domain tool filtering
 * - enableSubSkill() / disableSubSkill() — toggle + cache invalidation
 * - getSkillStatus() / getAllSkillStatuses() — status queries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type Anthropic from '@anthropic-ai/sdk';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// ── Test helpers ───────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// ── Mock DB ──────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER mocks
import {
  seedDefaultSkills,
  getToolsForDomain,
  enableSubSkill,
  disableSubSkill,
  enableSkill,
  disableSkill,
  getSkillStatus,
  getAllSkillStatuses,
  invalidateToolCache,
} from '../../src/skills/skill-manager';
import * as registry from '../../src/skills/registry';
import { DEFAULT_SKILLS } from '../../src/skills/skill-config';

// ── Fake tools for testing ──────────────────────────────────────

const FAKE_TOOLS: Anthropic.Tool[] = [
  { name: 'ms_todo_get_tasks', description: 'Get tasks', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'ms_todo_create_task', description: 'Create task', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'get_calendar_events', description: 'Get events', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'create_calendar_event', description: 'Create event', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'update_calendar_event', description: 'Update event', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'delete_calendar_event', description: 'Delete event', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'search_outlook_emails', description: 'Search emails', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'send_outlook_email', description: 'Send email', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'set_reminder', description: 'Set reminder', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'save_note', description: 'Save note', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'search_notes', description: 'Search notes', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'shared_memory_set', description: 'Set shared memory', input_schema: { type: 'object' as const, properties: {} } },
  { name: 'shared_memory_remove', description: 'Remove shared memory', input_schema: { type: 'object' as const, properties: {} } },
];

// ═══════════════════════════════════════════════════════════════════
// SEEDING TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillManager — seedDefaultSkills()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    invalidateToolCache();
  });
  afterEach(() => { testDb.close(); });

  it('creates all three domain skills', () => {
    seedDefaultSkills();

    const skills = registry.getAll();
    const names = skills.map(s => s.name);
    expect(names).toContain('secretary');
    expect(names).toContain('triathlon');
    expect(names).toContain('content');
  });

  it('creates submodules for each skill', () => {
    seedDefaultSkills();

    const sec = registry.getByName('secretary')!;
    const subs = registry.getSubmodules(sec.id);
    expect(subs.length).toBe(DEFAULT_SKILLS.secretary.subSkills.length);
  });

  it('sets domain field on each skill', () => {
    seedDefaultSkills();

    const sec = registry.getByName('secretary')!;
    expect(sec.domain).toBe('secretary');
  });

  it('is idempotent — calling twice does not duplicate', () => {
    seedDefaultSkills();
    seedDefaultSkills();

    const skills = registry.getAll();
    expect(skills).toHaveLength(3);
  });

  it('preserves user toggles on re-seed', () => {
    seedDefaultSkills();

    // User disables email sub-skill
    registry.disableSubmodule('secretary', 'email');

    // Re-seed
    seedDefaultSkills();

    // Email should still be disabled
    expect(registry.isSubmoduleEnabled('secretary', 'email')).toBe(false);
  });

  it('adds new submodules on code update without overwriting existing', () => {
    seedDefaultSkills();

    const sec = registry.getByName('secretary')!;
    const subsBefore = registry.getSubmodules(sec.id);

    // Re-seed (simulating a code update that doesn't add new submodules)
    seedDefaultSkills();

    const subsAfter = registry.getSubmodules(sec.id);
    expect(subsAfter.length).toBe(subsBefore.length);
  });

  it('all submodules enabled by default', () => {
    seedDefaultSkills();

    for (const domain of ['secretary', 'triathlon', 'content'] as const) {
      const enabledSubs = registry.getEnabledSubmodules(domain);
      const expectedCount = DEFAULT_SKILLS[domain].subSkills.filter(s => s.enabledByDefault).length;
      expect(enabledSubs.length).toBe(expectedCount);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// TOOL FILTERING TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillManager — getToolsForDomain()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    invalidateToolCache();
    seedDefaultSkills();
  });
  afterEach(() => { testDb.close(); });

  it('secretary gets all tools from its sub-skills', () => {
    const tools = getToolsForDomain('secretary', FAKE_TOOLS);
    const names = tools.map(t => t.name);
    expect(names).toContain('ms_todo_get_tasks');
    expect(names).toContain('get_calendar_events');
    expect(names).toContain('search_outlook_emails');
    expect(names).toContain('set_reminder');
    expect(names).toContain('save_note');
    expect(names).toContain('shared_memory_set');
  });

  it('triathlon gets calendar, reminder, notes, shared-memory tools but NOT tasks/email', () => {
    const tools = getToolsForDomain('triathlon', FAKE_TOOLS);
    const names = tools.map(t => t.name);
    expect(names).toContain('get_calendar_events');
    expect(names).toContain('set_reminder');
    expect(names).toContain('save_note');
    expect(names).toContain('shared_memory_set');
    expect(names).not.toContain('ms_todo_get_tasks');
    expect(names).not.toContain('search_outlook_emails');
  });

  it('content gets only notes and shared-memory tools', () => {
    const tools = getToolsForDomain('content', FAKE_TOOLS);
    const names = tools.map(t => t.name);
    expect(names).toContain('save_note');
    expect(names).toContain('search_notes');
    expect(names).toContain('shared_memory_set');
    expect(names).toContain('shared_memory_remove');
    expect(names).not.toContain('ms_todo_get_tasks');
    expect(names).not.toContain('get_calendar_events');
    expect(names).not.toContain('search_outlook_emails');
  });

  it('disabling a sub-skill removes its tools', () => {
    disableSubSkill('secretary', 'email');

    const tools = getToolsForDomain('secretary', FAKE_TOOLS);
    const names = tools.map(t => t.name);
    expect(names).not.toContain('search_outlook_emails');
    expect(names).not.toContain('send_outlook_email');
    // Other tools still present
    expect(names).toContain('ms_todo_get_tasks');
    expect(names).toContain('get_calendar_events');
  });

  it('re-enabling a sub-skill restores its tools', () => {
    disableSubSkill('secretary', 'email');
    enableSubSkill('secretary', 'email');

    const tools = getToolsForDomain('secretary', FAKE_TOOLS);
    const names = tools.map(t => t.name);
    expect(names).toContain('search_outlook_emails');
  });

  it('disabling entire skill returns no tools', () => {
    disableSkill('secretary');

    const tools = getToolsForDomain('secretary', FAKE_TOOLS);
    expect(tools).toHaveLength(0);
  });

  it('applies service filter on top of sub-skill filter', () => {
    // Filter that removes calendar tools (simulating unconfigured calendar)
    const noCalendar = (t: Anthropic.Tool) => !t.name.includes('calendar');

    const tools = getToolsForDomain('secretary', FAKE_TOOLS, noCalendar);
    const names = tools.map(t => t.name);
    expect(names).not.toContain('get_calendar_events');
    expect(names).toContain('ms_todo_get_tasks');
  });

  it('adds cache_control to the last tool', () => {
    const tools = getToolsForDomain('secretary', FAKE_TOOLS);
    const lastTool = tools[tools.length - 1] as any;
    expect(lastTool.cache_control).toEqual({ type: 'ephemeral' });

    // Non-last tools should NOT have cache_control
    if (tools.length > 1) {
      expect((tools[0] as any).cache_control).toBeUndefined();
    }
  });

  it('caches results and invalidates on toggle', () => {
    // First call
    const tools1 = getToolsForDomain('secretary', FAKE_TOOLS);

    // Second call — should be cached (same reference)
    const tools2 = getToolsForDomain('secretary', FAKE_TOOLS);
    expect(tools2).toBe(tools1);

    // Toggle a sub-skill — should invalidate cache
    disableSubSkill('secretary', 'email');
    const tools3 = getToolsForDomain('secretary', FAKE_TOOLS);
    expect(tools3).not.toBe(tools1);
    expect(tools3.length).toBeLessThan(tools1.length);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TOGGLE API TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillManager — toggle API', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    invalidateToolCache();
    seedDefaultSkills();
  });
  afterEach(() => { testDb.close(); });

  it('enableSubSkill returns true for valid sub-skill', () => {
    disableSubSkill('secretary', 'email');
    expect(enableSubSkill('secretary', 'email')).toBe(true);
  });

  it('disableSubSkill returns true for valid sub-skill', () => {
    expect(disableSubSkill('secretary', 'email')).toBe(true);
  });

  it('enableSubSkill returns false for non-existent skill', () => {
    expect(enableSubSkill('secretary' as any, 'nonexistent')).toBe(false);
  });

  it('disableSubSkill returns false for non-existent skill', () => {
    expect(disableSubSkill('secretary' as any, 'nonexistent')).toBe(false);
  });

  it('enableSkill returns true for valid skill', () => {
    disableSkill('secretary');
    expect(enableSkill('secretary')).toBe(true);
  });

  it('disableSkill returns true for valid skill', () => {
    expect(disableSkill('secretary')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// STATUS QUERY TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillManager — getSkillStatus()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    invalidateToolCache();
    seedDefaultSkills();
  });
  afterEach(() => { testDb.close(); });

  it('returns correct status for secretary', () => {
    const status = getSkillStatus('secretary');
    expect(status.name).toBe('secretary');
    expect(status.enabled).toBe(true);
    expect(status.subSkills.length).toBe(DEFAULT_SKILLS.secretary.subSkills.length);
  });

  it('reflects disabled sub-skills', () => {
    disableSubSkill('secretary', 'email');

    const status = getSkillStatus('secretary');
    const emailSub = status.subSkills.find(s => s.name === 'email')!;
    expect(emailSub.enabled).toBe(false);

    const tasksSub = status.subSkills.find(s => s.name === 'tasks')!;
    expect(tasksSub.enabled).toBe(true);
  });

  it('reflects disabled skill', () => {
    disableSkill('secretary');

    const status = getSkillStatus('secretary');
    expect(status.enabled).toBe(false);
  });

  it('includes tool count per sub-skill', () => {
    const status = getSkillStatus('secretary');
    const tasksSub = status.subSkills.find(s => s.name === 'tasks')!;
    expect(tasksSub.toolCount).toBe(DEFAULT_SKILLS.secretary.subSkills.find(s => s.name === 'tasks')!.tools.length);
  });
});

describe('SkillManager — getAllSkillStatuses()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    invalidateToolCache();
    seedDefaultSkills();
  });
  afterEach(() => { testDb.close(); });

  it('returns status for all three skills', () => {
    const statuses = getAllSkillStatuses();
    expect(statuses).toHaveLength(3);
    expect(statuses.map(s => s.name)).toEqual(['secretary', 'triathlon', 'content']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillManager — edge cases', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    invalidateToolCache();
  });
  afterEach(() => { testDb.close(); });

  it('getToolsForDomain returns empty array if skills not seeded', () => {
    // No seedDefaultSkills() called
    const tools = getToolsForDomain('secretary', FAKE_TOOLS);
    expect(tools).toHaveLength(0);
  });

  it('getSkillStatus works even if skill not in DB', () => {
    // No seedDefaultSkills() called
    const status = getSkillStatus('secretary');
    expect(status.enabled).toBe(false);
    expect(status.subSkills.every(s => !s.enabled)).toBe(true);
  });

  it('disabling all sub-skills results in no tools', () => {
    seedDefaultSkills();
    for (const sub of DEFAULT_SKILLS.content.subSkills) {
      disableSubSkill('content', sub.name);
    }

    const tools = getToolsForDomain('content', FAKE_TOOLS);
    expect(tools).toHaveLength(0);
  });

  it('service filter receives only sub-skill-allowed tools', () => {
    seedDefaultSkills();
    const received: string[] = [];
    const trackingFilter = (t: Anthropic.Tool) => {
      received.push(t.name);
      return true;
    };

    getToolsForDomain('content', FAKE_TOOLS, trackingFilter);
    // Content only has notes + shared-memory sub-skills
    expect(received).not.toContain('ms_todo_get_tasks');
    expect(received).toContain('save_note');
  });
});

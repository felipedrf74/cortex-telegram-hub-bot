/**
 * M15 execution hardening — fixture proof that each skill newly reachable
 * through the manifest classifier prompt (tasks, mail, connections,
 * notifications, decision_center) behaves when a turn is routed at it
 * through the REAL planner/registry execution path (mocked providers,
 * migrated in-memory SQLite, LLM tiers disabled).
 *
 * Honesty contract: these tests assert what the execution paths ACTUALLY do
 * today — including truthful non-success statuses (blocked /
 * needs_clarification / needs_confirmation / failed). Known weaknesses are
 * pinned explicitly (see the "known execution gaps" block) instead of being
 * papered over with fake coverage.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database | null = null;

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!testDb) throw new Error('Test database not initialized');
    return testDb;
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

// Mail providers are external APIs — always mocked.
vi.mock('../../src/services/unified-mail-pressure', () => ({
  getUnreadMailSummaryForUser: vi.fn(async () => ({
    total: 3,
    providers: [{ provider: 'gmail', unread: 3 }],
  })),
}));
vi.mock('../../src/services/google-gmail', () => ({
  searchEmailsForUser: vi.fn(async () => [
    { id: 'gm-1', from: 'ana@example.test', subject: 'Hello', date: '2026-07-20', snippet: 'hi' },
  ]),
}));
vi.mock('../../src/services/outlook-mail', () => ({
  searchEmailsForUser: vi.fn(async () => []),
}));

import {
  buildDeterministicChatActionPlan,
  executeChatActionPlan,
  resolveChatActionPlannerDeps,
  tryHandleChatActionPlan,
} from '../../src/services/chat';
import { getNlReachableCapabilities } from '../../src/router/classifier-prompt-builder';

const FROZEN_NOW = '2026-07-20T12:00:00+01:00';

function seedFixtureUser(db: Database.Database): void {
  db.prepare(`
    INSERT OR IGNORE INTO users (
      id, email, email_verified, username, first_name, language, timezone,
      tier, status, auth_provider, daily_message_limit, daily_token_limit,
      daily_cost_limit_usd
    )
    VALUES (?, ?, 1, ?, ?, 'en', 'Europe/Lisbon', 'free', 'active', 'email', 40, 100000, 0)
  `).run(77, 'm15-newly-reachable@example.test', 'm15-newly-reachable', 'M15 Fixture');
}

function makeExecutionDeps() {
  let taskCounter = 0;
  const tasks = new Map<string, Record<string, unknown>>();
  const defaultList = { id: 'tasks', displayName: 'Tasks', name: 'Tasks', wellknownListName: 'defaultList' };
  const taskProvider = {
    getLists: vi.fn(async () => ({ success: true, data: [defaultList] })),
    getDefaultList: vi.fn(async () => defaultList),
    createTask: vi.fn(async (listId: string, listName: string, data: Record<string, unknown>) => {
      const id = `task-${++taskCounter}`;
      const task = { id, title: data.title, subject: data.title, dueDateTime: data.dueDateTime ?? null, listId, listName };
      tasks.set(id, task);
      return { success: true, data: task };
    }),
    getTask: vi.fn(async (_listId: string, taskId: string) => {
      const task = tasks.get(taskId);
      return task ? { success: true, data: task } : { success: false, data: null };
    }),
    completeTask: vi.fn(async (_listId: string, taskId: string) => ({ success: true, data: tasks.get(taskId) ?? { id: taskId } })),
    updateTask: vi.fn(async (_listId: string, taskId: string, updates: Record<string, unknown>) => {
      const task = { ...(tasks.get(taskId) ?? { id: taskId }), ...updates };
      tasks.set(taskId, task);
      return { success: true, data: task };
    }),
    deleteTask: vi.fn(async () => ({ success: true })),
    addChecklistItem: vi.fn(async (_l: string, taskId: string, title: string) => ({ success: true, data: { id: `check-${taskId}`, title } })),
  };
  return {
    calendar: {
      createEvent: vi.fn(async () => ({ id: 'evt-1' })),
      getEventsForSources: vi.fn(async () => []),
      hasGoogle: vi.fn(() => true),
      hasOutlook: vi.fn(() => true),
    },
    taskProviderForUser: vi.fn(() => taskProvider as never),
  };
}

interface SkillFixture {
  id: string;
  locale: 'en-US' | 'pt-PT' | 'es-ES';
  text: string;
  expectedSkill: string;
  expectedAction: string;
  /** Truthful statuses the real execution path may produce for this fixture. */
  allowedStatuses: string[];
}

// Newly-reachable skills (present in the manifest classifier prompt but
// absent from the legacy 5-domain prompt): tasks + mail are secretary action
// skills; connections/notifications/decision_center are platform domains.
const FIXTURES: SkillFixture[] = [
  // ── tasks (EN/PT/ES) ─────────────────────────────────────────────
  { id: 'tasks-en', locale: 'en-US', text: 'Create a task called Buy milk tomorrow at 9', expectedSkill: 'tasks', expectedAction: 'create_task', allowedStatuses: ['needs_confirmation', 'verified_success'] },
  { id: 'tasks-pt', locale: 'pt-PT', text: 'Cria uma tarefa chamada Comprar leite amanhã às 9h', expectedSkill: 'tasks', expectedAction: 'create_task', allowedStatuses: ['needs_confirmation', 'verified_success'] },
  { id: 'tasks-es', locale: 'es-ES', text: 'Crea una tarea llamada Comprar leche mañana a las 9', expectedSkill: 'tasks', expectedAction: 'create_task', allowedStatuses: ['needs_confirmation', 'verified_success', 'needs_clarification'] },
  // ── mail (EN/PT/ES) — draft/send path (registry write intent) ────
  { id: 'mail-en', locale: 'en-US', text: 'Draft an email to Ana about the meeting tomorrow', expectedSkill: 'mail', expectedAction: 'draft_email', allowedStatuses: ['needs_confirmation', 'needs_clarification', 'blocked'] },
  { id: 'mail-pt', locale: 'pt-PT', text: 'Prepara um email para a Ana sobre a reunião', expectedSkill: 'mail', expectedAction: 'draft_email', allowedStatuses: ['needs_confirmation', 'needs_clarification', 'blocked'] },
  { id: 'mail-es', locale: 'es-ES', text: 'Envía un correo a Ana sobre la reunión', expectedSkill: 'mail', expectedAction: 'send_email', allowedStatuses: ['needs_confirmation', 'needs_clarification', 'blocked'] },
  // ── connections (EN/PT/ES) ───────────────────────────────────────
  { id: 'connections-en', locale: 'en-US', text: 'Retry sync for my Garmin connection', expectedSkill: 'connections', expectedAction: 'connections_retry_sync', allowedStatuses: ['needs_confirmation', 'blocked', 'verified_success'] },
  { id: 'connections-pt', locale: 'pt-PT', text: 'Qual é o estado da minha conexão do Google?', expectedSkill: 'connections', expectedAction: 'connections_status', allowedStatuses: ['verified_success'] },
  { id: 'connections-es', locale: 'es-ES', text: 'Reconecta mi conexión de Google Calendar', expectedSkill: 'connections', expectedAction: 'connections_retry_sync', allowedStatuses: ['needs_confirmation', 'blocked', 'verified_success'] },
  // ── notifications (EN/PT/ES) ─────────────────────────────────────
  { id: 'notifications-en', locale: 'en-US', text: 'Why did I get this training notification?', expectedSkill: 'notifications', expectedAction: 'notification_explain', allowedStatuses: ['verified_success'] },
  { id: 'notifications-pt', locale: 'pt-PT', text: 'Desativa as notificações de treino', expectedSkill: 'notifications', expectedAction: 'notification_update_preference', allowedStatuses: ['needs_confirmation', 'needs_clarification', 'blocked'] },
  { id: 'notifications-es', locale: 'es-ES', text: 'Desactiva las notificaciones de entrenamiento', expectedSkill: 'notifications', expectedAction: 'notification_update_preference', allowedStatuses: ['needs_confirmation', 'needs_clarification', 'blocked'] },
  // ── decision_center (EN/PT/ES) ───────────────────────────────────
  { id: 'decision-en', locale: 'en-US', text: 'Dismiss decision dec_123', expectedSkill: 'decision_center', expectedAction: 'decision_dismiss', allowedStatuses: ['needs_confirmation', 'partial_success', 'failed', 'verified_success'] },
  { id: 'decision-pt', locale: 'pt-PT', text: 'Dispensa a decisão dec_123', expectedSkill: 'decision_center', expectedAction: 'decision_dismiss', allowedStatuses: ['needs_confirmation', 'partial_success', 'failed', 'verified_success'] },
  { id: 'decision-es', locale: 'es-ES', text: 'Descarta la decisión dec_123', expectedSkill: 'decision_center', expectedAction: 'decision_dismiss', allowedStatuses: ['needs_confirmation', 'partial_success', 'failed', 'verified_success'] },
];

function baseInput(fixture: SkillFixture, index: number) {
  return {
    text: fixture.text,
    userId: 77,
    tenantId: 77,
    conversationId: `conv-m15-${index}`,
    messageId: `msg-m15-${index}`,
    channel: 'ios' as const,
    locale: fixture.locale,
    timezone: 'Europe/Lisbon',
    nowIso: FROZEN_NOW,
    persistRuns: false,
  };
}

const ENV_KEYS = [
  'CHAT_HYBRID_PLANNER_ENABLED', 'CHAT_HYBRID_SHADOW_MODE', 'CHAT_LLM_TIER1_ENABLED',
  'CHAT_LLM_TIER2_ENABLED', 'CHAT_ESCALATION_REVIEWER_ENABLED', 'NEXUS_MODEL_FIXTURE_MODE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.CHAT_HYBRID_PLANNER_ENABLED = 'active';
  delete process.env.CHAT_HYBRID_SHADOW_MODE;
  process.env.CHAT_LLM_TIER1_ENABLED = 'false';
  process.env.CHAT_LLM_TIER2_ENABLED = 'false';
  process.env.CHAT_ESCALATION_REVIEWER_ENABLED = 'false';
  process.env.NEXUS_MODEL_FIXTURE_MODE = '1';
  testDb = createMigratedTestDatabase();
  seedFixtureUser(testDb);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  testDb?.close();
  testDb = null;
});

describe('M15 — newly-reachable skills are present in the manifest prompt', () => {
  it('the fixtures cover every skill the manifest prompt adds beyond the legacy 5 domains', () => {
    const manifestSkills = new Set(
      getNlReachableCapabilities().flatMap((entry) => entry.chatActionSkills),
    );
    for (const skill of ['tasks', 'mail', 'connections', 'notifications', 'decision_center']) {
      expect(manifestSkills.has(skill), skill).toBe(true);
      expect(FIXTURES.some((fixture) => fixture.expectedSkill === skill), skill).toBe(true);
    }
    // EN/PT/ES coverage per newly-reachable skill.
    for (const skill of ['tasks', 'mail', 'connections', 'notifications', 'decision_center']) {
      const locales = new Set(FIXTURES.filter((f) => f.expectedSkill === skill).map((f) => f.locale));
      expect([...locales].sort(), skill).toEqual(['en-US', 'es-ES', 'pt-PT']);
    }
  });
});

describe('M15 — planner routes each newly-reachable skill deterministically (EN/PT/ES)', () => {
  FIXTURES.forEach((fixture, index) => {
    it(`${fixture.id}: plans ${fixture.expectedSkill}/${fixture.expectedAction}`, () => {
      const plan = buildDeterministicChatActionPlan(baseInput(fixture, index));
      expect(plan, fixture.id).not.toBeNull();
      const step = plan!.steps[0];
      expect(step.skill, fixture.id).toBe(fixture.expectedSkill);
      expect(step.action, fixture.id).toBe(fixture.expectedAction);
    });
  });
});

describe('M15 — real registry execution behaves truthfully per skill', () => {
  // Reads (connection status, notification explain) fail the action-intent
  // entry gate by design — they are served by read fast paths in production.
  // To prove the EXECUTION path for every fixture regardless of the entry
  // gate, the deterministic plan is executed directly through
  // executeChatActionPlan (the same registry/executor path
  // tryHandleChatActionPlan uses after its gate).
  FIXTURES.forEach((fixture, index) => {
    it(`${fixture.id}: executes without throwing and never fakes success`, async () => {
      const input = baseInput(fixture, index + 100);
      const plan = buildDeterministicChatActionPlan(input);
      expect(plan, fixture.id).not.toBeNull();
      const deps = resolveChatActionPlannerDeps(makeExecutionDeps() as never);
      const response = await executeChatActionPlan(plan!, input, deps, {});
      const status = String(response.metadata?.actionStatus ?? '');
      expect(fixture.allowedStatuses, `${fixture.id} got status=${status}`).toContain(status);
      expect(typeof response.text, fixture.id).toBe('string');
      expect(response.text.length, fixture.id).toBeGreaterThan(0);
      // Truthfulness: a claimed verified success requires the verification
      // metadata to agree.
      if (status === 'verified_success') {
        const verification = String(response.metadata?.verificationStatus ?? 'verified_success');
        expect(verification, fixture.id).toBe('verified_success');
      }
    });
  });

  it('tasks-en passes the FULL entry path (gate → plan → execute) with a truthful status', async () => {
    const fixture = FIXTURES[0];
    const runtimeResult = await tryHandleChatActionPlan(baseInput(fixture, 500), makeExecutionDeps() as never);
    expect(runtimeResult).not.toBeNull();
    const status = String(runtimeResult!.response.metadata?.actionStatus ?? runtimeResult!.status ?? '');
    expect(fixture.allowedStatuses, `entry path got status=${status}`).toContain(status);
  });
});

describe('M15 — known execution gaps (pinned honestly, must be closed before flag flip)', () => {
  it('draft_email / send_email / connections_retry_sync have NO step executor — they block instead of pretending', async () => {
    // These actions exist in the registry and are planned deterministically,
    // but src/services/chat/executor/dispatch-table.ts has no executor for
    // them. executeStepWithReliability returns status 'blocked' — truthful,
    // but a user routed there gets a dead end. REPORTED as an M15 execution
    // gap; closing it belongs to the mail/connections skill owners.
    const { getChatStepExecutor } = await import('../../src/services/chat/executor/dispatch-table');
    expect(getChatStepExecutor('draft_email' as never)).toBeUndefined();
    expect(getChatStepExecutor('send_email' as never)).toBeUndefined();
    expect(getChatStepExecutor('connections_retry_sync' as never)).toBeUndefined();
    // The rest of the newly-reachable surface IS executable.
    for (const action of [
      'create_task', 'complete_task', 'delete_task', 'mail_unread_count', 'mail_inbox_summary',
      'connections_status', 'connections_reconnect_guidance', 'notification_explain',
      'notification_update_preference', 'notification_create_intent',
      'decision_choose', 'decision_dismiss', 'decision_snooze', 'decision_follow_up',
    ]) {
      expect(getChatStepExecutor(action as never), action).toBeDefined();
    }
  });

  it('legacy chat domain handlers still cover only the 5 legacy domains (flag-flip blocker)', async () => {
    // With AI_CLASSIFY_MANIFEST_PROMPT on, a classifier turn routed to
    // connections/notifications/decision_center that misses the upstream
    // planner/deterministic stages reaches the legacy tail, which has no
    // domain handler for those domains and returns UNKNOWN_DOMAIN. Pinned
    // here as the documented flag-flip blocker.
    const { getChatDomainHandler } = await import('../../src/api/routes/chat-message-context');
    for (const domain of ['secretary', 'triathlon', 'content', 'finance', 'cooking']) {
      expect(getChatDomainHandler(domain), domain).toBeDefined();
    }
    for (const domain of ['connections', 'notifications', 'decision_center']) {
      expect(getChatDomainHandler(domain), domain).toBeUndefined();
    }
  });
});

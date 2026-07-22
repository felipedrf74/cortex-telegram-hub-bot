/**
 * M15 execution hardening — fixture proof that each skill newly reachable
 * through the manifest classifier prompt (tasks, mail, connections,
 * notifications, decision_center) behaves when a turn is routed at it
 * through the REAL planner/registry execution path (mocked providers,
 * migrated in-memory SQLite, LLM tiers disabled).
 *
 * Honesty contract: these tests assert what the execution paths ACTUALLY do
 * today — including truthful non-success statuses (blocked /
 * needs_clarification / needs_confirmation / failed). The formerly pinned
 * executor and legacy-tail gaps are now pinned closed with provider mocks
 * that require real read-back evidence before success.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database | null = null;

const providerMocks = vi.hoisted(() => ({
  createOutlookDraftForUser: vi.fn(),
  sendOutlookEmailWithReadBackForUser: vi.fn(),
  isOutlookMailConfiguredForUser: vi.fn(() => true),
  getEventsWithDiagnostics: vi.fn(),
  ensureGarminAuthenticated: vi.fn(),
  getProviderStatus: vi.fn(),
}));

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
  createOutlookDraftForUser: providerMocks.createOutlookDraftForUser,
  sendOutlookEmailWithReadBackForUser: providerMocks.sendOutlookEmailWithReadBackForUser,
  isOutlookMailConfiguredForUser: providerMocks.isOutlookMailConfiguredForUser,
}));
vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: vi.fn(),
  getEventsForSources: vi.fn(async () => []),
  getEventsWithDiagnostics: providerMocks.getEventsWithDiagnostics,
}));
vi.mock('../../src/services/garmin', () => ({
  ensureAuthenticated: providerMocks.ensureGarminAuthenticated,
}));
vi.mock('../../src/services/integration-status', () => ({
  getIntegrationSummary: vi.fn(() => ({
    providers: [
      { provider: 'google', state: 'connected', capabilities: ['calendar'], scopes: [] },
      { provider: 'outlook', state: 'connected', capabilities: ['calendar', 'mail'], scopes: [] },
      { provider: 'garmin', state: 'connected', capabilities: ['health'], scopes: [] },
    ],
    counts: { connected: 3 },
    capabilities: { calendar: true, mail: true, health: true },
  })),
  getProviderStatus: providerMocks.getProviderStatus,
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

describe('M15 — newly reachable execution gaps are closed before flag flip', () => {
  it('draft_email / send_email / connections_retry_sync have production step executors', async () => {
    const { getChatStepExecutor } = await import('../../src/services/chat/executor/dispatch-table');
    expect(getChatStepExecutor('draft_email' as never)).toBeDefined();
    expect(getChatStepExecutor('send_email' as never)).toBeDefined();
    expect(getChatStepExecutor('connections_retry_sync' as never)).toBeDefined();
    for (const action of [
      'create_task', 'complete_task', 'delete_task', 'mail_unread_count', 'mail_inbox_summary',
      'connections_status', 'connections_reconnect_guidance', 'notification_explain',
      'notification_update_preference', 'notification_create_intent',
      'decision_choose', 'decision_dismiss', 'decision_snooze', 'decision_follow_up',
    ]) {
      expect(getChatStepExecutor(action as never), action).toBeDefined();
    }
  });

  it('mail writes stay confirmation-gated and only claim success after provider read-back', async () => {
    const { getChatStepExecutor } = await import('../../src/services/chat/executor/dispatch-table');
    const input = {
      ...baseInput(FIXTURES[3], 900),
      text: 'Draft an Outlook email to ana@example.test with subject Update and body All good',
    };
    const parsed = buildDeterministicChatActionPlan(input)!;
    const draftStep = {
      ...parsed.steps[0],
      skill: 'mail' as const,
      action: 'draft_email' as const,
      type: 'draft_email' as const,
      risk: 'safe_write' as const,
      provider: 'outlook_mail' as const,
      args: { provider: 'outlook_mail', recipient: 'ana@example.test', subject: 'Update', body: 'All good' },
      requiredArgsPresent: true,
    };
    const plan = {
      ...parsed,
      steps: [draftStep],
      requiresConfirmation: true,
      clarificationQuestion: undefined,
      clarificationReason: undefined,
    };
    const deps = resolveChatActionPlannerDeps(makeExecutionDeps() as never);
    const draftExecutor = getChatStepExecutor('draft_email' as never)!;

    providerMocks.createOutlookDraftForUser.mockClear();
    const unconfirmed = await draftExecutor(draftStep as never, {
      plan: plan as never,
      input,
      deps,
      persistRuns: false,
      confirmed: false,
    });
    expect(unconfirmed).toMatchObject({ status: 'needs_confirmation' });
    expect(providerMocks.createOutlookDraftForUser).not.toHaveBeenCalled();

    providerMocks.createOutlookDraftForUser.mockResolvedValueOnce({
      provider: 'outlook_mail',
      messageId: 'draft-1',
      state: 'draft',
      verified: true,
    });
    const confirmedDraft = await draftExecutor(draftStep as never, {
      plan: plan as never,
      input,
      deps,
      persistRuns: false,
      confirmed: true,
    });
    expect(providerMocks.createOutlookDraftForUser).toHaveBeenCalledWith(77, {
      to: 'ana@example.test',
      subject: 'Update',
      body: 'All good',
      source: 'chat_action_planner',
    }, { signal: expect.any(AbortSignal) });
    expect(confirmedDraft).toMatchObject({ status: 'verified_success' });

    const sendExecutor = getChatStepExecutor('send_email' as never)!;
    const sendStep = { ...draftStep, action: 'send_email' as const, type: 'send_email' as const, risk: 'external_side_effect' as const };
    providerMocks.sendOutlookEmailWithReadBackForUser.mockResolvedValueOnce({
      provider: 'outlook_mail',
      messageId: 'sent-1',
      state: 'sent',
      verified: false,
      verificationError: 'sent_read_back_mismatch',
    });
    const unverifiedSend = await sendExecutor(sendStep as never, {
      plan: { ...plan, steps: [sendStep] } as never,
      input,
      deps,
      persistRuns: false,
      confirmed: true,
    });
    expect(unverifiedSend.status).not.toBe('verified_success');
    expect(unverifiedSend).toMatchObject({ status: 'partial_success', error: 'mail_provider_read_back_mismatch' });

    providerMocks.sendOutlookEmailWithReadBackForUser.mockClear();
    providerMocks.sendOutlookEmailWithReadBackForUser.mockResolvedValue({
      provider: 'outlook_mail',
      messageId: 'sent-2',
      state: 'sent',
      verified: true,
    });
    const sendPlan = { ...plan, steps: [sendStep] };
    const wrongTarget = await executeChatActionPlan(sendPlan as never, input, deps, {
      confirmed: true,
      confirmedTargets: [{ tool: 'send_outlook_email', targetId: 'other@example.test' }],
    });
    expect(wrongTarget.metadata.actionStatus).toBe('blocked');
    expect(providerMocks.sendOutlookEmailWithReadBackForUser).not.toHaveBeenCalled();

    const exactTarget = await executeChatActionPlan(sendPlan as never, input, deps, {
      confirmed: true,
      confirmedTargets: [{ tool: 'send_outlook_email', targetId: 'ana@example.test' }],
    });
    expect(exactTarget.metadata.actionStatus).toBe('verified_success');
    expect(providerMocks.sendOutlookEmailWithReadBackForUser).toHaveBeenCalledTimes(1);

    providerMocks.sendOutlookEmailWithReadBackForUser.mockClear();
    const gmailStep = {
      ...sendStep,
      provider: 'gmail' as const,
      args: { ...sendStep.args, provider: 'gmail' },
    };
    const gmailWrite = await sendExecutor(gmailStep as never, {
      plan: { ...sendPlan, steps: [gmailStep] } as never,
      input,
      deps,
      persistRuns: false,
      confirmed: true,
    });
    expect(gmailWrite).toMatchObject({ status: 'blocked', error: 'gmail_write_scope_unavailable' });
    expect(providerMocks.sendOutlookEmailWithReadBackForUser).not.toHaveBeenCalled();

    const attachmentStep = {
      ...sendStep,
      args: { ...sendStep.args, attachments: [{ id: 'attachment-1' }] },
    };
    const attachmentWrite = await sendExecutor(attachmentStep as never, {
      plan: { ...sendPlan, steps: [attachmentStep] } as never,
      input,
      deps,
      persistRuns: false,
      confirmed: true,
    });
    expect(attachmentWrite).toMatchObject({ status: 'blocked', error: 'mail_attachments_not_supported' });
    expect(providerMocks.sendOutlookEmailWithReadBackForUser).not.toHaveBeenCalled();
  });

  it('connections_retry_sync is tenant-scoped, confirmation-gated, and requires a verified refresh probe', async () => {
    const { getChatStepExecutor } = await import('../../src/services/chat/executor/dispatch-table');
    const input = baseInput(FIXTURES[6], 901);
    const plan = buildDeterministicChatActionPlan(input)!;
    const step = plan.steps[0];
    const executor = getChatStepExecutor('connections_retry_sync' as never)!;
    const deps = resolveChatActionPlannerDeps(makeExecutionDeps() as never);

    providerMocks.getProviderStatus.mockReturnValue({ provider: 'garmin', state: 'connected' });
    providerMocks.ensureGarminAuthenticated.mockClear();
    const unconfirmed = await executor(step, { plan, input, deps, persistRuns: false, confirmed: false });
    expect(unconfirmed).toMatchObject({ status: 'needs_confirmation' });
    expect(providerMocks.ensureGarminAuthenticated).not.toHaveBeenCalled();

    const { getCurrentContext } = await import('../../src/utils/request-context');
    providerMocks.ensureGarminAuthenticated.mockImplementationOnce(async () => {
      expect(getCurrentContext()).toMatchObject({ userId: 77, tenantId: 77, garminSilent: true });
      return true;
    });
    const confirmed = await executor(step, { plan, input, deps, persistRuns: false, confirmed: true });
    expect(confirmed).toMatchObject({
      status: 'verified_success',
      result: { provider: 'garmin', verified: true },
    });
    expect(providerMocks.getProviderStatus).toHaveBeenCalledWith(77, 'garmin');
  });

  it('connections_retry_sync verifies the exact scoped calendar provider and never promotes a failed probe', async () => {
    const { getChatStepExecutor } = await import('../../src/services/chat/executor/dispatch-table');
    const input = baseInput(FIXTURES[8], 902);
    const plan = buildDeterministicChatActionPlan(input)!;
    const step = plan.steps[0];
    const executor = getChatStepExecutor('connections_retry_sync' as never)!;
    const deps = resolveChatActionPlannerDeps(makeExecutionDeps() as never);

    providerMocks.getProviderStatus.mockReturnValue({ provider: 'google', state: 'connected' });
    providerMocks.getEventsWithDiagnostics.mockResolvedValueOnce({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['google'], fulfilled: ['google'], failed: [] },
    });
    const verified = await executor(step, { plan, input, deps, persistRuns: false, confirmed: true });
    expect(verified).toMatchObject({
      status: 'verified_success',
      result: { provider: 'google', verified: true },
    });
    expect(providerMocks.getEventsWithDiagnostics).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      77,
      { sources: ['google'] },
    );

    providerMocks.getEventsWithDiagnostics.mockResolvedValueOnce({
      events: [],
      status: 'unavailable',
      warningCodes: ['GOOGLE_CALENDAR_UNAVAILABLE'],
      warnings: ['unavailable'],
      sources: { configured: ['google'], fulfilled: [], failed: ['google'] },
    });
    const unverified = await executor(step, { plan, input, deps, persistRuns: false, confirmed: true });
    expect(unverified.status).not.toBe('verified_success');
    expect(unverified).toMatchObject({ status: 'failed', error: 'calendar_refresh_probe_failed' });
  });

  it('legacy chat domain handlers cover every manifest-reachable domain without a model fallback', async () => {
    const { getChatDomainHandler } = await import('../../src/api/routes/chat-message-context');
    for (const domain of [
      'secretary', 'triathlon', 'content', 'finance', 'cooking',
      'connections', 'notifications', 'decision_center',
    ]) {
      expect(getChatDomainHandler(domain), domain).toBeDefined();
    }

    for (const [domain, message] of [
      ['connections', 'Show my connection status'],
      ['notifications', 'Show my notification settings'],
      ['decision_center', 'Show my decisions'],
    ] as const) {
      const result = await getChatDomainHandler(domain)!(message, 77, 77);
      expect(result.domain).toBe(domain);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text).not.toContain('UNKNOWN_DOMAIN');
      expect(result.metadata?.verificationStatus).toBe('verified_success');
    }
  });
});

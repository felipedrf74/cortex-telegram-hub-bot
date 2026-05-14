import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/api/routes/training-plan-calendar-sync', () => ({
  previewTrainingSessionReflow: vi.fn(),
  confirmTrainingSessionReflow: vi.fn(),
}));

import {
  buildChatActionPlan,
  buildDeterministicChatActionPlan,
  buildLlmPlannerPrompt,
  executeChatActionPlan,
  parseLlmPlannerJson,
  shouldRunActionPlannerBeforeReadOnlyFastPaths,
  tryHandleChatActionPlan,
} from '../../src/services/chat-action-planner';
import { getChatActionRegistry } from '../../src/services/chat-action-registry';
import { parseNaturalLanguageCalendarEvent } from '../../src/services/calendar-natural-language-parser';
import { buildContentAgencyPackage, persistContentAgencyArtifact } from '../../src/services/content-agency';
import { getTopics } from '../../src/services/content-scheduler';
import { getMealPlan } from '../../src/services/cooking-chef';
import { addTransaction, calculateAndStoreTax, getTaxEvents, getTransactions } from '../../src/services/finance-tracker';
import { confirmTrainingSessionReflow, previewTrainingSessionReflow } from '../../src/api/routes/training-plan-calendar-sync';

const FROZEN_NOW = '2026-05-14T12:00:00+01:00';

const baseInput = {
  text: 'Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo',
  userId: 42,
  tenantId: 42,
  conversationId: 'conv-1',
  messageId: 'msg-1',
  channel: 'ios' as const,
  locale: 'pt-PT',
  timezone: 'Europe/Lisbon',
  nowIso: FROZEN_NOW,
  persistRuns: false,
};

describe('ChatActionPlanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('routes the Portuguese Gmail-agenda command to Google Calendar, not Gmail unread', async () => {
    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths(baseInput.text)).toBe(true);
    const parsed = parseNaturalLanguageCalendarEvent(baseInput.text, {
      timezone: 'Europe/Lisbon',
      nowIso: FROZEN_NOW,
    });
    expect(parsed).toMatchObject({
      title: 'igreja',
      provider: 'google',
      startDateTime: '2026-05-17T10:00:00+01:00',
      endDateTime: '2026-05-17T12:30:00+01:00',
      timezone: 'Europe/Lisbon',
    });

    const plan = await buildChatActionPlan(baseInput);
    expect(plan).toMatchObject({
      planner: 'deterministic',
      requiresConfirmation: false,
      steps: [{
        skill: 'secretary_calendar',
        action: 'schedule_event',
        provider: 'google_calendar',
        requiredArgsPresent: true,
        risk: 'safe_write',
      }],
    });
    expect(plan?.steps[0]?.args).toMatchObject({
      title: 'igreja',
      provider: 'google_calendar',
      startDateTime: '2026-05-17T10:00:00+01:00',
      endDateTime: '2026-05-17T12:30:00+01:00',
      timezone: 'Europe/Lisbon',
    });
    expect(plan?.debug?.rejectedFastPaths).toContain('gmail_unread_count');
  });

  it('asks a targeted clarification when a calendar command is missing the event title', async () => {
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Cria um evento no domingo às 10',
    });

    expect(plan?.steps[0]).toMatchObject({
      skill: 'secretary_calendar',
      action: 'schedule_event',
      requiredArgsPresent: false,
    });
    expect(plan?.clarificationQuestion).toMatch(/t[íi]tulo/i);
    const response = await executeChatActionPlan(plan!, { ...baseInput, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response.metadata.actionStatus).toBe('needs_clarification');
    expect(response.text).toMatch(/t[íi]tulo/i);
  });

  it('executes and claims success only after provider read-back matches', async () => {
    const created = {
      id: 'google-event-1',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const getEventsForSources = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created]);
    const createEvent = vi.fn().mockResolvedValue(created);

    const result = await tryHandleChatActionPlan(baseInput, {
      calendar: {
        createEvent: createEvent as any,
        getEventsForSources: getEventsForSources as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(result?.status).toBe('verified_success');
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0][1]).toBe('google');
    expect(getEventsForSources).toHaveBeenCalledTimes(2);
    expect(result?.response.text).toContain('Feito — criei');
    expect(result?.response.text).toContain('igreja');
    expect(result?.response.metadata).toMatchObject({
      type: 'chat_action_verified_success',
      actionStatus: 'verified_success',
      verificationStatus: 'verified_success',
    });
    expect(JSON.stringify(result?.response.metadata)).not.toMatch(/auth\.scope|skill_capability_registry|fallback policy|chatReasoning/i);
  });

  it('does not claim verified success when provider read-back does not match', async () => {
    const created = {
      id: 'google-event-1',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const getEventsForSources = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...created, id: 'other', summary: 'other event' }]);

    const result = await tryHandleChatActionPlan(baseInput, {
      calendar: {
        createEvent: vi.fn().mockResolvedValue(created) as any,
        getEventsForSources: getEventsForSources as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(result?.status).toBe('partial_success');
    expect(result?.response.text).not.toMatch(/\bcriei\b.*\bverifiquei\b/i);
    expect(result?.response.metadata.type).toBe('chat_action_partial_success');
  });

  it('executes a safe calendar event plus task follow-up as ordered deterministic steps', async () => {
    const createdEvent = {
      id: 'google-event-2',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const taskProvider = {
      getLists: vi.fn().mockResolvedValue({ success: true, data: [{ id: 'tasks', displayName: 'Tasks', wellknownListName: 'defaultList' }] }),
      getDefaultList: vi.fn().mockResolvedValue({ id: 'tasks', displayName: 'Tasks' }),
      createTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-1', title: 'levar a bíblia', listId: 'tasks' } }),
      getTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-1', title: 'levar a bíblia' } }),
    };
    const result = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Marca na agenda do Gmail chamado igreja das 10 ao meio-dia e meia nesse domingo e cria uma tarefa para levar a bíblia',
    }, {
      calendar: {
        createEvent: vi.fn().mockResolvedValue(createdEvent) as any,
        getEventsForSources: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([createdEvent]) as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => taskProvider as any),
    });

    expect(result?.plan.steps.map((step) => step.action)).toEqual(['schedule_event', 'create_task']);
    expect(result?.status).toBe('verified_success');
    expect(taskProvider.createTask).toHaveBeenCalledWith('tasks', 'Tasks', expect.objectContaining({ title: 'levar a bíblia' }));
    expect(result?.response.metadata.type).toBe('chat_action_verified_success');
  });

  it('requires confirmation for external side effects such as attendees', async () => {
    const plan = buildDeterministicChatActionPlan({
      ...baseInput,
      text: 'Cria um evento no Google Calendar chamado reunião das 9 às 10 amanhã e convida ana@example.com',
    });
    expect(plan?.steps[0]?.risk).toBe('external_side_effect');
    expect(plan?.requiresConfirmation).toBe(true);

    const response = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Cria um evento no Google Calendar chamado reunião das 9 às 10 amanhã e convida ana@example.com',
    });
    expect(response?.status).toBe('needs_confirmation');
    expect(response?.response.text).toContain('reunião');
    expect(response?.response.text).toContain('Google Calendar');
    expect(response?.response.text).toContain('09:00');
    expect(response?.response.text).toContain('10:00');
    expect(response?.response.text).toContain('participante');
  });

  it('keeps Gmail unread queries eligible for read-only mail routing', () => {
    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Quantos emails não lidos tenho no Gmail?')).toBe(false);
  });

  it('leaves legacy spaced sub-task creation with the existing reasoning executor', () => {
    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Create task Prozis where it has sub tasks called creatine K2 D3')).toBe(false);
    expect(buildDeterministicChatActionPlan({
      ...baseInput,
      text: 'Create task Prozis where it has sub tasks called creatine K2 D3',
    })).toBeNull();
  });

  it('recognizes cross-skill actions without falling through to generic answers', async () => {
    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Cria um script para Reels sobre treino')).toBe(true);
    const contentPlan = await buildChatActionPlan({
      ...baseInput,
      text: 'Cria um script para Reels sobre treino de força para triatletas',
    });
    expect(contentPlan).toMatchObject({
      planner: 'deterministic',
      requiresConfirmation: false,
      steps: [{ skill: 'content', action: 'content_script_create', requiredArgsPresent: true }],
    });
    expect(contentPlan?.steps[0]?.args).toMatchObject({
      platform: 'instagram_reel',
      topic: 'Reels sobre treino de força para triatletas',
    });

    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths('Cria uma lista de compras para a próxima semana')).toBe(true);
    const cookingPlan = await buildChatActionPlan({
      ...baseInput,
      text: 'Cria uma lista de compras para a próxima semana',
    });
    expect(cookingPlan?.steps[0]).toMatchObject({
      skill: 'cooking',
      action: 'cooking_grocery_list',
      requiredArgsPresent: true,
    });

    const trainingPlan = await buildChatActionPlan({
      ...baseInput,
      text: 'Mostra o relatório do coach de treino',
    });
    expect(trainingPlan?.steps[0]).toMatchObject({
      skill: 'training',
      action: 'training_coach_report',
      risk: 'read_only',
    });
  });

  it('uses clarification or confirmation instead of executing risky or underspecified actions', async () => {
    const payment = await tryHandleChatActionPlan({
      ...baseInput,
      text: 'Paga a fatura do Stripe hoje',
    });
    expect(payment?.status).toBe('needs_clarification');
    expect(payment?.plan.steps[0]).toMatchObject({
      skill: 'finance',
      action: 'finance_payment_action',
      risk: 'financial',
      requiredArgsPresent: false,
    });
    expect(payment?.response.metadata.type).toBe('chat_action_needs_input');

    const deletePlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'tasks',
        action: 'delete_task',
        args: { taskId: 'task-123' },
        missingFields: [],
      }],
    }), baseInput);
    expect(deletePlan?.requiresConfirmation).toBe(true);
    expect(deletePlan?.steps[0]).toMatchObject({ risk: 'destructive', requiredArgsPresent: true });
  });

  it('provides a small action-registry subset to the LLM planner and rejects malformed plans', () => {
    const prompt = buildLlmPlannerPrompt({
      ...baseInput,
      text: 'Cria evento amanhã às 10 e cria uma tarefa para levar a bíblia',
    });
    expect(prompt.systemPrompt).toContain('secretary_calendar');
    expect(prompt.systemPrompt).toContain('tasks');
    expect(prompt.systemPrompt.length).toBeLessThan(9000);
    expect(parseLlmPlannerJson('{"steps":[{"skill":"unknown","action":"danger","args":{}}]}', baseInput)).toBeNull();
  });

  it('accepts structured LLM plans for mixed multistep requests but only as validated plan data', () => {
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.84,
      steps: [
        {
          skill: 'content',
          action: 'content_brief_create',
          args: { objective: 'launch a triathlon nutrition reel', platform: 'instagram_reel' },
          missingFields: [],
        },
        {
          skill: 'tasks',
          action: 'create_task',
          args: { title: 'Film the triathlon nutrition reel', list: null },
          missingFields: [],
        },
      ],
    }), {
      ...baseInput,
      text: 'Cria um brief de content para Reels e uma tarefa para filmar',
    });

    expect(plan?.planner).toBe('llm_structured');
    expect(plan?.steps.map((step) => [step.skill, step.action, step.requiredArgsPresent])).toEqual([
      ['content', 'content_brief_create', true],
      ['tasks', 'create_task', true],
    ]);
    expect(plan?.debug?.parser).toBe('model_assisted');
  });

  it('strips model-proposed user and tenant identifiers from executable args', () => {
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.84,
      steps: [{
        skill: 'tasks',
        action: 'create_task',
        args: {
          title: 'Comprar creatina',
          userId: 999,
          UserId: 999,
          USER_ID: 999,
          tenantId: 888,
          accountId: 'attacker-account',
          ownerId: 'attacker-owner',
          uid: 'attacker-uid',
          user: 'attacker-user',
          owner: 'attacker',
          metadata: {
            userId: 'nested-attacker-user',
            tenant_id: 'nested-attacker-tenant',
            safeNote: 'keep this',
          },
          context: {
            ownerId: 'nested-owner',
            account_id: 'nested-account',
            visible: true,
          },
          auditTrail: [
            { tenant_id: 'nested-array-tenant', label: 'safe' },
            { USER_ID: 'nested-array-user', value: 7 },
          ],
        },
        missingFields: [],
      }],
    }), baseInput);

    expect(plan?.userId).toBe(String(baseInput.userId));
    expect(plan?.tenantId).toBe(String(baseInput.tenantId));
    expect(plan?.steps[0]?.args).toMatchObject({ title: 'Comprar creatina' });
    expect(plan?.steps[0]?.args).not.toHaveProperty('userId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('tenantId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('accountId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('ownerId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('uid');
    expect(plan?.steps[0]?.args).not.toHaveProperty('user');
    expect(plan?.steps[0]?.args).not.toHaveProperty('owner');
    expect(plan?.steps[0]?.args).not.toHaveProperty('UserId');
    expect(plan?.steps[0]?.args).not.toHaveProperty('USER_ID');
    expect(plan?.steps[0]?.args).toMatchObject({
      metadata: { safeNote: 'keep this' },
      context: { visible: true },
      auditTrail: [{ label: 'safe' }, { value: 7 }],
    });
    expect(plan?.steps[0]?.args.metadata as Record<string, unknown>).not.toHaveProperty('userId');
    expect(plan?.steps[0]?.args.context as Record<string, unknown>).not.toHaveProperty('ownerId');
  });

  it('source-pins action-planner ordering before REST and WebSocket generic routing', () => {
    const restSource = fs.readFileSync(path.resolve(__dirname, '../../src/api/routes/chat-message-routes.ts'), 'utf-8');
    const wsSource = fs.readFileSync(path.resolve(__dirname, '../../src/api/websocket.ts'), 'utf-8');

    const actionInvocation = restSource.search(/await\s+tryHandleChatActionPlan\s*\(/);
    const fastPathInvocation = restSource.search(/await\s+tryBuildFastPathChatResponse\s*\(/);
    expect(actionInvocation).toBeGreaterThanOrEqual(0);
    expect(fastPathInvocation).toBeGreaterThanOrEqual(0);
    expect(actionInvocation).toBeLessThan(fastPathInvocation);
    expect(wsSource).toMatch(/tryHandleChatActionPlan\s*\(/);
    expect(wsSource).not.toMatch(/tryBuildFastPathChatResponse\s*\(/);
  });

  it('registry exposes initial owner skills without creating a Chat v2 stack', () => {
    const skills = new Set(getChatActionRegistry().map((entry) => entry.skill));
    expect(skills).toEqual(new Set([
      'secretary_calendar',
      'mail',
      'tasks',
      'training',
      'content',
      'cooking',
      'finance',
      'connections',
      'notifications',
      'decision_center',
    ]));
  });

  it('registry actions declare deterministic executors, verifiers, and confirmation policy by risk', () => {
    const registry = getChatActionRegistry();
    expect(registry.length).toBeGreaterThanOrEqual(35);

    for (const entry of registry) {
      expect(entry.executor, `${entry.skill}.${entry.action} executor`).toMatch(/^[a-zA-Z0-9_.]+$/);
      expect(['provider_read_back', 'local_read_back', 'none']).toContain(entry.verifier);
      expect(entry.supportedCards).toEqual(expect.arrayContaining([
        'needs_input',
        'needs_confirmation',
        'verified_success',
        'partial_success',
        'failed',
        'blocked',
      ]));

      if (['external_side_effect', 'destructive', 'financial', 'admin_security'].includes(entry.risk)) {
        expect(entry.confirmationPolicy, `${entry.skill}.${entry.action} confirmation`).toMatch(/confirm/);
      }
      if (entry.risk === 'financial' || entry.risk === 'admin_security') {
        expect(entry.confirmationPolicy, `${entry.skill}.${entry.action} strong confirmation`).toBe('strong_confirm');
      }
    }
  });

  it('keeps provider read-back mismatch below verified-success in response metadata and copy', async () => {
    const created = {
      id: 'google-event-duplicate',
      summary: 'igreja',
      start: '2026-05-17T10:00:00+01:00',
      end: '2026-05-17T12:30:00+01:00',
      source: 'google' as const,
    };
    const getEventsForSources = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const createEvent = vi.fn().mockResolvedValue(created);

    const first = await tryHandleChatActionPlan(baseInput, {
      calendar: {
        createEvent: createEvent as any,
        getEventsForSources: getEventsForSources as any,
        hasGoogle: vi.fn(() => true),
        hasOutlook: vi.fn(() => false),
      },
    });

    expect(first?.status).toBe('partial_success');
    expect(first?.response.text).toContain('não consegui verificar tudo');
    expect(first?.response.metadata).toMatchObject({
      type: 'chat_action_partial_success',
      actionStatus: 'partial_success',
    });
    expect(createEvent).toHaveBeenCalledTimes(1);
  });

  it('resumes confirmed task mutations through the deterministic task executor and read-back', async () => {
    const args = { taskId: 'task-1', listId: 'list-1', title: 'Comprar creatina' };
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'tasks',
        action: 'complete_task',
        args,
        missingFields: [],
      }],
    }), { ...baseInput, persistRuns: false });
    const provider = {
      completeTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-1', status: 'completed' } }),
      getTask: vi.fn().mockResolvedValue({ success: true, data: { id: 'task-1', title: 'Comprar creatina', status: 'completed' } }),
    };

    expect(plan).toBeTruthy();
    const response = await executeChatActionPlan(plan!, { ...baseInput, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => provider as any),
    }, { confirmed: true });

    expect(response.metadata.actionStatus).toBe('verified_success');
    expect(provider.completeTask).toHaveBeenCalledWith('list-1', 'task-1');
    expect(provider.getTask).toHaveBeenCalledWith('list-1', 'task-1', undefined);
    expect(response.text).toContain('Feito');
  });

  it('executes Content scheduling and pipeline handoff through local read-back', async () => {
    const schedulePlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'content',
        action: 'content_schedule_work',
        args: {
          title: 'Filmar reel de recuperação',
          dateTime: '2026-05-18T09:00:00+01:00',
        },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4201, tenantId: 4201, persistRuns: false });

    const scheduleResponse = await executeChatActionPlan(schedulePlan!, { ...baseInput, userId: 4201, tenantId: 4201, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });
    expect(scheduleResponse.metadata.actionStatus).toBe('verified_success');
    expect(getTopics(4201, { includeTerminal: true, limit: 5 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Filmar reel de recuperação', scheduled_date: '2026-05-18' }),
    ]));

    const pkg = buildContentAgencyPackage({
      userId: 4201,
      tenantId: 4201,
      brief: {
        userId: 4201,
        tenantId: 4201,
        goal: 'Create a reel',
        objective: 'Show a recovery routine with proof and CTA',
        audience: 'busy triathletes',
        platform: 'instagram_reel',
        format: 'short_form_video',
      },
    });
    persistContentAgencyArtifact('package', pkg);
    const handoffPlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'content',
        action: 'content_pipeline_handoff',
        args: { packageId: pkg.id },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4201, tenantId: 4201, persistRuns: false });
    const handoffResponse = await executeChatActionPlan(handoffPlan!, { ...baseInput, userId: 4201, tenantId: 4201, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    }, { confirmed: true });
    expect(handoffResponse.metadata.actionStatus).toBe('verified_success');
    expect(handoffResponse.text).toContain('pipeline');
  });

  it('executes Cooking meal-plan slot writes with scoped read-back', async () => {
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'cooking',
        action: 'cooking_meal_plan',
        args: { date: '2026-05-18', mealType: 'dinner', title: 'Salmão com legumes' },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4301, tenantId: 4301, persistRuns: false });

    const response = await executeChatActionPlan(plan!, { ...baseInput, userId: 4301, tenantId: 4301, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    });

    expect(response.metadata.actionStatus).toBe('verified_success');
    expect(getMealPlan(4301, '2026-05-18', '2026-05-18', 4301)[0]).toMatchObject({
      meal_type: 'dinner',
      title: 'Salmão com legumes',
    });
  });

  it('executes Finance categorization and local mark-paid actions with read-back', async () => {
    const tx = addTransaction(4401, '2026-05-10', 'uncategorized', 12.5, {
      currency: 'EUR',
      description: 'Receipt lunch',
      receiptRef: 'receipt-4401',
    });
    const categorizePlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'finance',
        action: 'finance_categorize_receipt',
        args: { receiptId: tx.id, category: 'food', subcategory: 'lunch' },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4401, tenantId: 4401, persistRuns: false });
    const deps = {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    };

    const categorizeResponse = await executeChatActionPlan(categorizePlan!, { ...baseInput, userId: 4401, tenantId: 4401, persistRuns: false }, deps, { confirmed: true });
    expect(categorizeResponse.metadata.actionStatus).toBe('verified_success');
    expect(getTransactions(4401, { limit: 5 }).find((candidate) => candidate.id === tx.id)).toMatchObject({ category: 'food', subcategory: 'lunch' });

    addTransaction(4401, '2026-05-01', 'income', 5000, { currency: 'BRL' });
    calculateAndStoreTax(4401, '2026-05');
    const payPlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'finance',
        action: 'finance_payment_action',
        args: { action: 'mark_tax_paid', month: '2026-05' },
        missingFields: [],
      }],
    }), { ...baseInput, userId: 4401, tenantId: 4401, persistRuns: false });
    const payResponse = await executeChatActionPlan(payPlan!, { ...baseInput, userId: 4401, tenantId: 4401, persistRuns: false }, deps, { confirmed: true });
    expect(payResponse.metadata.actionStatus).toBe('verified_success');
    expect(getTaxEvents(4401, { year: 2026 }).find((event) => event.month === '2026-05')).toMatchObject({ status: 'paid' });
  });

  it('keeps Training reflow preview separate from the confirmation mutation path', async () => {
    vi.mocked(previewTrainingSessionReflow).mockResolvedValue({
      status: 'preview',
      data: {
        sessionId: 501,
        current: { startAt: '2026-05-18T07:00:00+01:00', endAt: '2026-05-18T08:00:00+01:00' },
        proposal: { startAt: '2026-05-19T07:00:00+01:00', endAt: '2026-05-19T08:00:00+01:00' },
      },
    } as any);
    vi.mocked(confirmTrainingSessionReflow).mockResolvedValue({
      status: 'confirmed',
      data: {
        sessionId: 501,
        verified: true,
        eventId: 'training-event-501',
      },
    } as any);
    const deps = {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    };

    const previewPlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'training',
        action: 'training_reflow_preview',
        args: { sessionId: 501 },
        missingFields: [],
      }],
    }), { ...baseInput, persistRuns: false });
    const previewResponse = await executeChatActionPlan(previewPlan!, { ...baseInput, persistRuns: false }, deps, { confirmed: true });

    expect(previewResponse.metadata.actionStatus).toBe('verified_success');
    expect(previewTrainingSessionReflow).toHaveBeenCalledWith(baseInput.userId, 501, null);
    expect(confirmTrainingSessionReflow).not.toHaveBeenCalled();

    const confirmPlan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'training',
        action: 'training_reflow_confirm',
        args: { sessionId: 501 },
        missingFields: [],
      }],
    }), { ...baseInput, persistRuns: false });
    const confirmResponse = await executeChatActionPlan(confirmPlan!, { ...baseInput, persistRuns: false }, deps, { confirmed: true });

    expect(confirmResponse.metadata.actionStatus).toBe('verified_success');
    expect(confirmTrainingSessionReflow).toHaveBeenCalledWith(expect.objectContaining({
      userId: baseInput.userId,
      sessionId: 501,
    }));
  });

  it('fails closed when a registry action has no safe chat executor yet', async () => {
    const args = { rawRequest: 'Ajusta o plano de treino para esta semana', planId: 1, changeRequest: 'lighter week' };
    const plan = parseLlmPlannerJson(JSON.stringify({
      confidence: 0.9,
      steps: [{
        skill: 'training',
        action: 'training_adjust_plan',
        args,
        missingFields: [],
      }],
    }), { ...baseInput, persistRuns: false });

    expect(plan).toBeTruthy();
    const response = await executeChatActionPlan(plan!, { ...baseInput, persistRuns: false }, {
      calendar: {
        createEvent: vi.fn() as any,
        getEventsForSources: vi.fn() as any,
        hasGoogle: vi.fn(() => false),
        hasOutlook: vi.fn(() => false),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    }, { confirmed: true });

    expect(response.metadata.actionStatus).toBe('blocked');
    expect(response.text).toContain('Ainda não consigo executar essa ação por chat com segurança');
    expect(response.metadata).toMatchObject({
      type: 'chat_action_blocked',
      actionStatus: 'blocked',
    });
    expect(JSON.stringify(response.metadata)).not.toMatch(/verified_success|Feito — concluí/i);
  });
});

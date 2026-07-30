import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


vi.mock('../../src/services/database', () => ({
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

import { buildChatActionPlan, executeChatActionPlan } from '../../src/services/chat';
import { shouldRunActionPlannerBeforeReadOnlyFastPaths } from '../../src/services/chat/planner/preflight-gates';
import type { ChatActionPlan, ChatPlanStep } from '../../src/services/chat/types';

const baseInput = {
  text: 'Create task Buy milk and create task Call mom',
  userId: 42,
  tenantId: 42,
  conversationId: 'conv-multi',
  messageId: 'msg-multi',
  channel: 'ios' as const,
  locale: 'en-US',
  timezone: 'Europe/Lisbon',
  nowIso: '2026-05-23T12:00:00+01:00',
  persistRuns: false,
};

function answerStep(stepId: string, text: string, dependsOnStepIds?: string[]): ChatPlanStep {
  return {
    stepId,
    skill: 'tasks',
    type: 'answer',
    action: 'create_task',
    risk: 'read_only',
    riskClass: 'R0',
    provider: 'nexus',
    args: { text },
    requiredArgsPresent: true,
    idempotencyKey: `answer-${stepId}`,
    dependsOnStepIds,
    verification: { required: false, method: 'none' },
  };
}

describe('ChatActionPlanner multi-step DAG', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = createMigratedTestDatabase();
    // M5: ledger task writes hit unified_* tables, which enforce the users FK.
    testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)').run(42, 42);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('declines the governed live-eval narrative turn before either action-planner model tier', async () => {
    const text = 'Compare one broad launch narrative with several tailored narratives. Explain when each is preferable. Do not read or change saved data.';

    expect(shouldRunActionPlannerBeforeReadOnlyFastPaths(text)).toBe(false);
    await expect(buildChatActionPlan({
      ...baseInput,
      text,
      messageId: 'chat-live-eval-content-provider-owner',
    })).resolves.toBeNull();
  });

  it('turns two safe-write segments into a stable DAG of independent siblings that requires confirmation', async () => {
    const plan = await buildChatActionPlan(baseInput);

    // M16 pin flip (was: dependsOnStepIds ['step_1']): 'and' is a relaxed
    // sibling connective when NO data flow links the steps — "Create task Buy
    // milk and create task Call mom" are independent requests, so a failure
    // of the first must not block the second. Sequencing connectives
    // ('then'/'and then') and $ref data flow still chain.
    expect(plan).toMatchObject({
      planner: 'mixed',
      requiresConfirmation: true,
      steps: [
        { stepId: 'step_1', skill: 'tasks', action: 'create_task', requiredArgsPresent: true },
        { stepId: 'step_2', skill: 'tasks', action: 'create_task', requiredArgsPresent: true, dependsOnStepIds: undefined },
      ],
    });
    expect(plan?.debug?.routingSignals).toEqual(expect.arrayContaining([
      'multi_step_splitter',
      'multi_step_dag',
    ]));
  });

  it('requires a preview confirmation for three or more steps', async () => {
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Create task Buy milk, create task Call mom, create task Send invoice',
      messageId: 'msg-three',
    });

    expect(plan?.steps).toHaveLength(3);
    expect(plan?.requiresConfirmation).toBe(true);
  });

  // M16 pin flip (was: 'stops after the first blocked dependency' with
  // step_3 left 'pending' and aggregate status 'blocked'): a failed/blocked
  // step now blocks ONLY its dependents; independent branches keep
  // executing, and the mixed outcome is reported honestly as
  // partial_success with a per-step enumeration.
  it('emits multi-step result metadata, blocks only dependents, and continues independent branches', async () => {
    const sourcePlan: ChatActionPlan = {
      schemaVersion: 1,
      userId: '42',
      tenantId: '42',
      conversationId: 'conv-multi',
      messageId: 'msg-execute',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      channel: 'ios',
      createdAt: '2026-05-23T12:00:00+01:00',
      planner: 'mixed',
      steps: [
        answerStep('step_1', 'first'),
        answerStep('step_2', 'blocked', ['missing_step']),
        answerStep('step_3', 'independent'),
      ],
      requiresConfirmation: false,
      confidence: 0.9,
    };

    const response = await executeChatActionPlan(sourcePlan, {
      ...baseInput,
      text: 'synthetic multi-step execution',
      messageId: 'msg-execute',
    }, {});

    expect(response.metadata.type).toBe('chat_action_multi_step_result');
    expect(response.metadata.actionStatus).toBe('partial_success');
    expect(response.metadata.multiStepSummary).toMatchObject({
      totalSteps: 3,
      succeeded: 2,
      blocked: 1,
      perStep: [
        { stepId: 'step_1', status: 'verified_success' },
        { stepId: 'step_2', status: 'blocked', error: 'dependency_failed' },
        { stepId: 'step_3', status: 'verified_success' },
      ],
    });
    // Honest partial composition: the answer enumerates each branch and
    // never claims success for the blocked step.
    expect(response.text).toContain('2 of 3');
    expect(response.text).toContain('not run');
  });

  it('resolves task pronouns through step refs before executing dependent mutations', async () => {
    const completeTask = vi.fn(async () => ({ success: true }));
    const getTask = vi.fn(async (_listId: string, taskId: string) => ({
      success: true,
      data: { id: taskId, listId: 'list-1', title: 'Call mom' },
    }));
    const plan = await buildChatActionPlan({
      ...baseInput,
      text: 'Create a task to call mom and then mark that task done',
      messageId: 'msg-pronoun',
    });

    expect(plan?.steps).toMatchObject([
      { stepId: 'step_1', action: 'create_task', requiredArgsPresent: true },
      {
        stepId: 'step_2',
        action: 'complete_task',
        requiredArgsPresent: true,
        args: {
          taskId: { $ref: 'step_1.result.task.id' },
          listId: { $ref: 'step_1.result.task.listId' },
        },
      },
    ]);

    const response = await executeChatActionPlan(plan!, {
      ...baseInput,
      text: 'Create a task to call mom and then mark that task done',
      messageId: 'msg-pronoun',
    }, {
      taskProviderForUser: () => ({
        getLists: vi.fn(async () => ({ data: [{ id: 'list-1', displayName: 'Tasks', wellknownListName: 'defaultList' }] })),
        createTask: vi.fn(async () => ({ success: true, data: { id: 'task-1', listId: 'list-1', title: 'Call mom' } })),
        getTask,
        completeTask,
      }),
    } as never, { confirmed: true });

    expect(response.metadata.actionStatus).toBe('verified_success');
    // M5 single write path: both the create and the pronoun-resolved complete
    // land in the offline-first ledger; the provider mock stays untouched and
    // the $ref carries the created task's NEXUS id into the mutation step.
    expect(completeTask).not.toHaveBeenCalled();
    const completeMutation = testDb.prepare(
      "SELECT COUNT(*) AS count FROM task_mutations WHERE user_id = 42 AND operation = 'task.complete'",
    ).get() as { count: number };
    expect(completeMutation.count).toBe(1);
    expect(response.metadata.multiStepSummary).toMatchObject({ totalSteps: 2, succeeded: 2 });
  });

  // M16: a low-confidence split NEVER silently executes — it always lands in
  // the preview/confirm flow, and the preview enumerates the interpreted
  // step list so the user can see exactly what will run.
  it('routes low_confidence_multi to a preview that enumerates the interpreted steps', async () => {
    const plan = await buildChatActionPlan({ ...baseInput, messageId: 'msg-low-confidence' });

    expect(plan?.requiresConfirmation).toBe(true);
    expect(plan?.debug?.routingSignals).toEqual(expect.arrayContaining([
      'multi_step_low_confidence_preview',
    ]));

    const response = await executeChatActionPlan(plan!, { ...baseInput, messageId: 'msg-low-confidence' }, {});

    expect(response.metadata.actionStatus).toBe('needs_confirmation');
    expect(response.text).toContain('I understood 2 steps:');
    expect(response.text).toContain('1. Create task “Buy milk”');
    expect(response.text).toContain('2. Create task “Call mom”');
  });

  // M16: more than 5 actionable segments — execute the first 5, DISCLOSE the
  // overflow instead of silently dropping requests 6+.
  it('caps at 5 steps and discloses the overflow in the preview', async () => {
    const text = 'Create task one, create task two, create task three, create task four, create task five, create task six, create task seven';
    const plan = await buildChatActionPlan({ ...baseInput, text, messageId: 'msg-overflow' });

    expect(plan?.steps).toHaveLength(5);
    expect(plan?.multiStepOverflowCount).toBe(2);
    expect(plan?.debug?.routingSignals).toEqual(expect.arrayContaining(['multi_step_overflow:2']));

    const response = await executeChatActionPlan(plan!, { ...baseInput, text, messageId: 'msg-overflow' }, {});

    expect(response.metadata.actionStatus).toBe('needs_confirmation');
    expect(response.text).toContain("I found 7 requests; I'm only handling the first 5");
  });

  it('requires clarification before executing any multi-step plan with unresolved steps', async () => {
    const sourcePlan: ChatActionPlan = {
      schemaVersion: 1,
      userId: '42',
      tenantId: '42',
      conversationId: 'conv-multi',
      messageId: 'msg-mixed-clarification',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      channel: 'ios',
      createdAt: '2026-05-23T12:00:00+01:00',
      planner: 'mixed',
      steps: [
        answerStep('step_1', 'clear safe action'),
        {
          ...answerStep('step_2', 'missing detail'),
          type: 'set_task_reminder',
          action: 'set_task_reminder',
          risk: 'safe_write',
          args: { taskId: null, reminderAt: null },
          requiredArgsPresent: false,
          verification: { required: true, method: 'local_read_back' },
        },
        answerStep('step_3', 'another clear safe action'),
      ],
      requiresConfirmation: false,
      clarificationQuestion: 'When should I remind you?',
      clarificationReason: 'missing_required_fields',
      confidence: 0.9,
    };

    const response = await executeChatActionPlan(sourcePlan, {
      ...baseInput,
      text: 'synthetic mixed safe-write clarification',
      messageId: 'msg-mixed-clarification',
    }, {});

    expect(response.metadata.actionStatus).toBe('needs_clarification');
    expect(response.text).toBe('When should I remind you?');
    expect(response.metadata.clarification).toMatchObject({ question: 'When should I remind you?' });
    expect(response.metadata.multiStepSummary).toMatchObject({
      totalSteps: 3,
      succeeded: 0,
      needsClarification: 1,
      perStep: [
        { stepId: 'step_1', status: 'pending' },
        { stepId: 'step_2', status: 'pending' },
        { stepId: 'step_3', status: 'pending' },
      ],
    });
  });

  it.each([
    {
      label: 'workout conflict without a destination time',
      text: 'Move my workout because the client call moved earlier.',
      skills: ['secretary', 'training'],
      terms: ['conflict', 'workout', 'confirm'],
    },
    {
      label: 'training adjustment without a session target',
      text: 'Adjust the session and move it later if needed.',
      skills: ['secretary', 'training'],
      terms: ['Training', 'later', 'confirm'],
    },
    {
      label: 'meal prep placement with an unresolved reference',
      text: 'Find time for meal prep around it.',
      skills: ['secretary', 'cooking', 'training'],
      terms: ['meal prep', 'Training', 'confirm'],
    },
    {
      label: 'budget review without a date or time',
      text: 'Schedule a budget review before I decide.',
      skills: ['secretary', 'finance'],
      terms: ['budget review', 'confirm'],
    },
    {
      label: 'contradictory workout cancellation',
      text: 'This is wrong. Cancel the workout, but do not change anything, and just fix it now.',
      skills: ['secretary', 'training'],
      terms: ['conflict', 'confirm', 'cannot'],
    },
    {
      label: 'calendar-only removal without an exact block',
      text: 'You are not listening. I said keep the plan and remove the calendar block.',
      skills: ['secretary', 'training'],
      terms: ['keep the Training plan', 'remove calendar block', 'confirm'],
    },
  ])('asks a targeted, non-executable clarification for $label', async ({ text, skills, terms }) => {
    const input = { ...baseInput, text, messageId: `safe-${skills.join('-')}-${terms.length}` };
    const plan = await buildChatActionPlan(input);
    const response = await executeChatActionPlan(plan!, input, {});

    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0]).toMatchObject({
      type: 'clarification',
      risk: 'ambiguous',
      requiredArgsPresent: false,
    });
    expect(response.metadata.actionStatus).toBe('needs_clarification');
    expect(response.metadata.involvedSkills).toEqual(skills);
    for (const term of terms) expect(response.text).toContain(term);
  });

  it.each([
    {
      text: 'I am tired today and slept badly.',
      locale: 'en-US',
      domain: 'training',
      skills: ['training'],
      terms: ['recovery', 'adjust'],
    },
    {
      text: 'O que devo comer antes do treino pesado de hoje? Use apenas o contexto deste espaço de trabalho.',
      locale: 'pt-BR',
      domain: 'cooking',
      skills: ['cooking', 'training'],
      terms: ['treino', 'alimentação'],
    },
    {
      text: 'Do not warn me twice if it is the same fueling issue.',
      locale: 'en-US',
      domain: 'cooking',
      skills: ['cooking', 'training'],
      terms: ['same', 'not duplicate', 'fueling'],
    },
    {
      text: 'Can I afford the new smart trainer for my workouts?',
      locale: 'en-US',
      domain: 'finance',
      skills: ['finance', 'training'],
      terms: ['budget', 'training'],
    },
    {
      text: 'Dame ideas de contenido para la publicación del lanzamiento usando solo el contexto autorizado.',
      locale: 'es-419',
      domain: 'content',
      skills: ['content'],
      terms: ['content', 'ideas'],
    },
    {
      text: 'Use my saved books and channel references.',
      locale: 'en-US',
      domain: 'content',
      skills: ['content', 'shared_context'],
      terms: ['references', 'scoped'],
    },
  ])('serves a bounded answer-only intent without a model or mutation: $text', async ({ text, locale, domain, skills, terms }) => {
    const input = { ...baseInput, text, locale, messageId: `answer-${domain}-${terms.length}` };
    const plan = await buildChatActionPlan(input);
    const response = await executeChatActionPlan(plan!, input, {});

    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0]).toMatchObject({
      type: 'answer',
      risk: 'read_only',
      requiredArgsPresent: true,
    });
    expect(response.domain).toBe(domain);
    expect(response.metadata.actionStatus).toBe('verified_success');
    expect(response.metadata.involvedSkills).toEqual(skills);
    for (const term of terms) expect(response.text.toLowerCase()).toContain(term.toLowerCase());
  });
});

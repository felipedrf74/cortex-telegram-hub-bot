import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from 'luxon';
import type { NormalizedTask } from '../../src/services/task-store/types';

const mocks = vi.hoisted(() => ({
  listTasksForUser: vi.fn(),
  createDecisionIntent: vi.fn(),
  getUserTimezoneById: vi.fn(),
  getUserLanguageById: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/task-store/task-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/task-store/task-service')>('../../src/services/task-store/task-service');
  return {
    ...actual,
    listTasksForUser: (...args: unknown[]) => mocks.listTasksForUser(...args),
  };
});

vi.mock('../../src/services/decision-center', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/decision-center')>('../../src/services/decision-center');
  return {
    ...actual,
    createDecisionIntent: (...args: unknown[]) => mocks.createDecisionIntent(...args),
  };
});

vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service');
  return {
    ...actual,
    getUserTimezoneById: (...args: unknown[]) => mocks.getUserTimezoneById(...args),
    getUserLanguageById: (...args: unknown[]) => mocks.getUserLanguageById(...args),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mocks.loggerWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  materializeDecisionCenterDailyAttention,
  summarizeTaskAttention,
} from '../../src/services/decision-center-daily-attention';

function task(overrides: Partial<NormalizedTask>): NormalizedTask {
  return {
    id: 1,
    provider: 'nexus',
    externalId: 'task-1',
    title: 'Private task title',
    status: 'pending',
    priority: 1,
    ...overrides,
  };
}

describe('Decision Center daily attention materializer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DECISION_CENTER_DAILY_ATTENTION_ENABLED;
    mocks.getUserTimezoneById.mockReturnValue('Europe/Lisbon');
    mocks.getUserLanguageById.mockReturnValue('en');
    mocks.createDecisionIntent.mockResolvedValue({
      item: { decisionId: 'dc_task_attention' },
      eligibility: { classification: 'decision' },
    });
  });

  it('summarizes pending overdue, due-today, and high-priority tasks only', () => {
    const counts = summarizeTaskAttention([
      task({ id: 1, title: 'Overdue private title', dueDate: '2026-06-16', priority: 1 }),
      task({ id: 2, title: 'Today private title', dueDate: '2026-06-17T08:00:00.000Z', dueIsDatetime: true, priority: 3 }),
      task({ id: 3, title: 'Future low priority', dueDate: '2026-06-20', priority: 4 }),
      task({ id: 4, title: 'Completed stale', status: 'completed', dueDate: '2026-06-16', priority: 2 }),
      task({ id: 5, title: 'Cancelled stale', status: 'cancelled', dueDate: '2026-06-16', priority: 2 }),
    ], '2026-06-17', 'Europe/Lisbon');

    expect(counts).toEqual({
      pending: 3,
      overdue: 1,
      dueToday: 1,
      highPriority: 1,
    });
  });

  it('treats canonical P1/P2 as high attention and P3/P4/none as lower priority', () => {
    const counts = summarizeTaskAttention([
      task({ id: 101, priority: 1 }),
      task({ id: 102, priority: 2 }),
      task({ id: 103, priority: 3 }),
      task({ id: 104, priority: 4 }),
      task({ id: 105, priority: 0 }),
    ], '2026-06-17', 'Europe/Lisbon');

    expect(counts).toMatchObject({ pending: 5, highPriority: 2 });
  });

  it('buckets naive datetimes by user timezone rather than server timezone near midnight', () => {
    const previousZone = Settings.defaultZone;
    Settings.defaultZone = 'UTC';
    try {
      const counts = summarizeTaskAttention([
        task({ id: 6, title: 'Late Lisbon task', dueDate: '2026-06-18T23:30:00', dueIsDatetime: true, priority: 3 }),
      ], '2026-06-18', 'Europe/Lisbon');

      expect(counts).toMatchObject({ overdue: 0, dueToday: 1, highPriority: 0 });
    } finally {
      Settings.defaultZone = previousZone;
    }
  });

  it('buckets UTC datetimes across the Lisbon midnight boundary', () => {
    const counts = summarizeTaskAttention([
      task({ id: 7, title: 'UTC boundary task', dueDate: '2026-06-18T23:30:00Z', dueIsDatetime: true, priority: 3 }),
    ], '2026-06-19', 'Europe/Lisbon');

    expect(counts).toMatchObject({ overdue: 0, dueToday: 1, highPriority: 0 });
  });

  it('creates one safe overdue task decision intent with a stable daily dedupe key', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 10, provider: 'ms_todo', externalId: 'ms-private-id', title: 'Pay private invoice', dueDate: '2026-06-16', priority: 4 }),
      task({ id: 11, provider: 'nexus', externalId: 'native-private-id', title: 'Call private person', dueDate: '2026-06-17', priority: 1 }),
    ]);

    const result = await materializeDecisionCenterDailyAttention({
      userId: 42,
      tenantId: 42,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'materialized',
      localDate: '2026-06-17',
      timezone: 'Europe/Lisbon',
      counts: { pending: 2, overdue: 1, dueToday: 1, highPriority: 1 },
      dedupeKey: 'secretary:daily-attention:tasks:42:42:2026-06-17',
      decisionId: 'dc_task_attention',
    });
    expect(mocks.listTasksForUser).toHaveBeenCalledWith(42, { status: 'pending' });
    expect(mocks.createDecisionIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      tenantId: 42,
      sourceSkill: 'secretary',
      type: 'decision_required',
      relatedEntityType: 'task_attention_day',
      relatedEntityId: '2026-06-17',
      dedupeKey: 'secretary:daily-attention:tasks:42:42:2026-06-17',
      deliveryPolicy: 'in_app_only',
      privacyPolicy: 'standard',
      decisionContext: expect.objectContaining({
        recipe: 'daily_task_attention',
        sourceState: 'overdue_tasks',
        reasonCodes: ['daily_attention', 'overdue_tasks', 'tasks_due_today', 'high_priority_tasks'],
        taskCounts: { pending: 2, overdue: 1, dueToday: 1, highPriority: 1 },
      }),
    }));

    const intent = mocks.createDecisionIntent.mock.calls[0][0];
    expect(intent.title).toBe('Clear overdue tasks');
    expect(intent.body).toBe('1 overdue task, 1 task due today, and 1 high-priority task need a short review.');
    expect(intent.actionButtons[0]).toMatchObject({
      id: 'open_detail',
      label: 'Open overdue tasks',
      deeplink: 'nexus://tasks?filter=overdue',
    });
    expect(JSON.stringify(intent)).not.toContain('Pay private invoice');
    expect(JSON.stringify(intent)).not.toContain('Call private person');
    expect(JSON.stringify(intent)).not.toContain('ms-private-id');
    expect(JSON.stringify(intent)).not.toContain('native-private-id');
    expect([intent.title, intent.body, intent.actionButtons[0].label].join(' ')).not.toMatch(
      /\b(undefined|null|NaN|\[object Object\])\b/,
    );
  });

  it('creates a concrete focus decision when high-priority and due-today tasks need attention', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 20, title: 'Private focus', dueDate: '2026-06-17', priority: 3 }),
      task({ id: 21, title: 'Private important', dueDate: '2026-06-20', priority: 2 }),
    ]);

    await materializeDecisionCenterDailyAttention({
      userId: 43,
      tenantId: 43,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    const intent = mocks.createDecisionIntent.mock.calls[0][0];
    expect(intent.title).toBe('Choose today\'s task focus');
    expect(intent.actionButtons[0]).toMatchObject({
      label: 'Open today\'s tasks',
      deeplink: 'nexus://tasks?filter=dueToday',
    });
    expect(intent.decisionContext.sourceState).toBe('important_tasks');
  });

  it('uses the same daily dedupe key on repeated materialization attempts', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 30, title: 'Private overdue', dueDate: '2026-06-16', priority: 2 }),
    ]);

    await materializeDecisionCenterDailyAttention({ userId: 44, tenantId: 44, now: new Date('2026-06-17T10:00:00.000Z') });
    await materializeDecisionCenterDailyAttention({ userId: 44, tenantId: 44, now: new Date('2026-06-17T12:00:00.000Z') });

    const keys = mocks.createDecisionIntent.mock.calls.map((call) => call[0].dedupeKey);
    expect(keys).toEqual([
      'secretary:daily-attention:tasks:44:44:2026-06-17',
      'secretary:daily-attention:tasks:44:44:2026-06-17',
    ]);
  });

  it('skips when no pending task attention is needed', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 40, title: 'Future low priority', dueDate: '2026-06-20', priority: 4 }),
    ]);

    const result = await materializeDecisionCenterDailyAttention({
      userId: 45,
      tenantId: 45,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_task_attention_needed');
    expect(mocks.createDecisionIntent).not.toHaveBeenCalled();
  });

  it('logs task read failures without raw task payload text', async () => {
    mocks.listTasksForUser.mockImplementation(() => {
      throw new Error('private task title leaked in exception');
    });

    const result = await materializeDecisionCenterDailyAttention({
      userId: 45,
      tenantId: 45,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('task_read_failed');
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errType: 'Error', userId: 45, tenantId: 45 }),
      'Decision Center daily task attention read failed',
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain('private task title');
  });

  it('fails closed for invalid user or tenant scope before user/task reads', async () => {
    const result = await materializeDecisionCenterDailyAttention({
      userId: 0,
      tenantId: 45,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'invalid_scope',
      localDate: null,
      dedupeKey: null,
      decisionId: null,
    });
    expect(mocks.getUserTimezoneById).not.toHaveBeenCalled();
    expect(mocks.listTasksForUser).not.toHaveBeenCalled();
    expect(mocks.createDecisionIntent).not.toHaveBeenCalled();
  });

  it('fails closed for non-canonical tenant task scopes', async () => {
    const result = await materializeDecisionCenterDailyAttention({
      userId: 46,
      tenantId: 99,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('non_canonical_task_tenant_scope');
    expect(mocks.listTasksForUser).not.toHaveBeenCalled();
    expect(mocks.createDecisionIntent).not.toHaveBeenCalled();
  });

  it('reports a failed materialization if the Decision Center gate does not create an item', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 48, title: 'Private overdue', dueDate: '2026-06-16', priority: 2 }),
    ]);
    mocks.createDecisionIntent.mockResolvedValue({
      item: null,
      eligibility: { classification: 'suppressed' },
    });

    const result = await materializeDecisionCenterDailyAttention({
      userId: 48,
      tenantId: 48,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'decision_create_failed',
      dedupeKey: 'secretary:daily-attention:tasks:48:48:2026-06-17',
      decisionId: null,
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 48, tenantId: 48, dedupeKey: 'secretary:daily-attention:tasks:48:48:2026-06-17' }),
      'Decision Center daily task attention was not created',
    );
  });

  it('treats decision-class no-item results as already materialized, not failures', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 49, title: 'Private overdue duplicate', dueDate: '2026-06-16', priority: 2 }),
    ]);
    mocks.createDecisionIntent.mockResolvedValue({
      item: null,
      eligibility: { classification: 'decision' },
    });

    const result = await materializeDecisionCenterDailyAttention({
      userId: 49,
      tenantId: 49,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'already_materialized',
      dedupeKey: 'secretary:daily-attention:tasks:49:49:2026-06-17',
      decisionId: null,
    });
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('logs decision create failures without raw task payload text', async () => {
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 50, title: 'Private create failure', dueDate: '2026-06-16', priority: 2 }),
    ]);
    mocks.createDecisionIntent.mockRejectedValue(new Error('private task payload in create failure'));

    const result = await materializeDecisionCenterDailyAttention({
      userId: 50,
      tenantId: 50,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('decision_create_failed');
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ errType: 'Error', userId: 50, tenantId: 50 }),
      'Decision Center daily task attention create failed',
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain('private task payload');
  });

  it('honors the default-on feature flag and scoped off override', async () => {
    process.env.DECISION_CENTER_DAILY_ATTENTION_ENABLED = 'off';
    mocks.listTasksForUser.mockReturnValue([
      task({ id: 50, title: 'Private overdue', dueDate: '2026-06-16', priority: 2 }),
    ]);

    const result = await materializeDecisionCenterDailyAttention({
      userId: 47,
      tenantId: 47,
      now: new Date('2026-06-17T10:00:00.000Z'),
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('flag_disabled');
    expect(mocks.getUserTimezoneById).not.toHaveBeenCalled();
    expect(mocks.listTasksForUser).not.toHaveBeenCalled();
  });
});

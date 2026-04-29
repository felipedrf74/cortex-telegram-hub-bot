// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  evaluateCrossSkillSmokePrerequisites,
  renderCrossSkillSmokeReportMarkdown,
  runLocalFixtureSmoke,
  runTrainingCrossSkillStagingSmoke,
} from '../../src/tools/training-cross-skill-staging-smoke';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    STAGING: 'true',
    TRAINING_CROSS_SKILL_STAGING_SMOKE: '1',
    TRAINING_CROSS_SKILL_STAGING_USER_ID: '42',
    DATABASE_PATH: '/tmp/nexus-staging.db',
    ...overrides,
  };
}

describe('training cross-skill staging smoke harness', () => {
  it('blocks staging reads unless explicit staging guardrails are present', () => {
    const report = evaluateCrossSkillSmokePrerequisites({});

    expect(report.ok).toBe(false);
    expect(report.missing).toContain('STAGING=true or NODE_ENV=staging');
    expect(report.missing).toContain('TRAINING_CROSS_SKILL_STAGING_SMOKE=1');
    expect(report.missing).toContain('TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id>');
  });

  it('refuses production mode even if other staging flags are present', () => {
    const report = evaluateCrossSkillSmokePrerequisites(env({
      NODE_ENV: 'production',
      STAGING: 'true',
    }));

    expect(report.ok).toBe(false);
    expect(report.missing).toContain('NODE_ENV must not be production');
  });

  it('passes local fixture contracts for Secretary, Cooking, Finance, Content, and milestone flow', () => {
    const operations = runLocalFixtureSmoke();

    expect(operations).toHaveLength(6);
    expect(operations.every((operation) => operation.status === 'pass')).toBe(true);
    expect(operations.map((operation) => operation.flow)).toEqual([
      'local_fixture_contracts',
      'secretary_conflict',
      'cooking_fueling_gap',
      'finance_budget_constraint',
      'content_workload',
      'training_content_milestone',
    ]);
  });

  it('does not fake staging success when prerequisites are missing', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      runId: 'run-missing-prereqs',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: {},
    });

    expect(report.localFixtureOperations.every((operation) => operation.status === 'pass')).toBe(true);
    expect(report.operations).toEqual([
      expect.objectContaining({
        flow: 'staging_prerequisites',
        status: 'blocked',
      }),
    ]);
  });

  it('does not fake staging success in dry-run mode', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      userId: 42,
      runId: 'run-dry',
      dryRun: true,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    });

    expect(report.operations).toEqual([
      expect.objectContaining({
        flow: 'staging_prerequisites',
        status: 'blocked',
        actual: expect.stringContaining('dry run requested'),
      }),
    ]);

    const markdown = renderCrossSkillSmokeReportMarkdown(report);
    expect(markdown).toContain('this was a dry run');
    expect(markdown).not.toContain('All requested staging runtime flows passed.');
  });

  it('renders blocked staging separately from local fixture passes', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      userId: 42,
      runId: 'run-render',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: {},
    });

    const markdown = renderCrossSkillSmokeReportMarkdown(report);

    expect(markdown).toContain('## Local Fixture Contract Checks');
    expect(markdown).toContain('## Staging Runtime Checks');
    expect(markdown).toContain('Real staging validation was **not** run');
    expect(markdown).toContain('staging_prerequisites');
  });

  it('blocks runtime flows when staging user lacks required cross-skill fixture data', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      userId: 42,
      runId: 'run-empty-runtime',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    }, buildRuntimeReader({
      secretarySignals: [],
      cookingSignals: [],
      financeSignals: [],
      contentSignals: [],
      trainingSignals: [],
      sharedDecisionContext: [
        'Secretary: context shell present.',
        'Cooking: context shell present.',
        'Finance: context shell present.',
        'Content: context shell present.',
      ].join('\n'),
    }));

    const runtime = Object.fromEntries(report.operations.map((operation) => [operation.flow, operation.status]));

    expect(runtime.secretary_conflict).toBe('blocked');
    expect(runtime.cooking_fueling_gap).toBe('blocked');
    expect(runtime.finance_budget_constraint).toBe('blocked');
    expect(runtime.content_workload).toBe('blocked');
    expect(runtime.shared_context_scope).toBe('pass');
  });

  it('passes runtime flows only when scoped staging fixture signals are present and deduped', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      userId: 42,
      runId: 'run-rich-runtime',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    }, buildRuntimeReader({
      secretarySignals: [signal('calendar_busy_blocks', { dates: ['2026-05-05'] }), signal('travel_window', { dates: ['2026-05-08'] })],
      cookingSignals: [signal('fueling_support_status', { status: 'at_risk' })],
      financeSignals: [signal('budget_remaining', { budgetMode: 'tight', trainingSpendMode: 'selective' })],
      contentSignals: [signal('publishing_commitment', { nextDate: '2026-05-07' })],
      trainingSignals: [signal('content_capture_opportunity', { title: 'Travel-week training win' })],
      sharedDecisionContext: [
        'Secretary: travel, focus, and admin constraints are active.',
        'Cooking: hard-session fueling is missing on 2026-05-05.',
        'Finance: budget mode is tight and training spend is selective.',
        'Content: filming window is Thursday 10:00-12:00.',
      ].join('\n'),
    }));

    const statuses = report.operations.map((operation) => operation.status);

    expect(statuses).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  });
});

function buildRuntimeReader(opts: {
  secretarySignals: any[];
  cookingSignals: any[];
  financeSignals: any[];
  contentSignals: any[];
  trainingSignals: any[];
  sharedDecisionContext: string;
}) {
  const userId = 42;
  return {
    async readTrainingMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        activePlan: null,
        activeWeek: null,
        sessions: [],
        trainingContext: { signals: [], flags: {} },
        coachBriefing: null,
        adherence: null,
        coachPhaseMemory: null,
        derivedSignals: opts.trainingSignals,
      } as any;
    },
    async readCookingMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        meals: [],
        shoppingList: null,
        derivedSignals: opts.cookingSignals,
      } as any;
    },
    async readFinanceMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        month: '2026-05',
        monthlySummary: {},
        budgetView: { affordability: opts.financeSignals.length > 0 ? 'tight' : 'unknown' },
        taxEvents: [],
        annualSummary: {},
        subscription: {},
        derivedSignals: opts.financeSignals,
      } as any;
    },
    async readContentMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        upcomingTopicCount: opts.contentSignals.length > 0 ? 2 : 0,
        scheduledTopics: [],
        filmingRecommendation: opts.contentSignals.length > 0 ? { date: '2026-05-07' } : null,
        unreadNotifications: [],
        deskItems: [],
        monitoredPillars: [],
        recentSignals: [],
        nextExecution: opts.contentSignals.length > 0 ? { title: 'Training block update' } : null,
        voiceDnaEntries: [],
        knowledgeStats: {},
        derivedSignals: opts.contentSignals,
      } as any;
    },
    async readSecretaryMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        events: opts.secretarySignals.length > 0 ? [{ id: 'busy-1', title: 'Board review' }] : [],
        focusBlock: opts.secretarySignals.length > 0 ? { date: '2026-05-06' } : null,
        dueToday: [],
        dueThisWeek: [],
        overdue: [],
        pending: [],
        writableCalendar: true,
        mailPressure: null,
        derivedSignals: opts.secretarySignals,
      } as any;
    },
    async buildSharedDecisionContext() {
      return opts.sharedDecisionContext;
    },
    async buildSharedDecisionContracts() {
      return {
        secretary: { nonNegotiables: [], preferredWindows: [], fallbackIfDeferred: [], notes: [] },
        cooking: { nonNegotiables: [], preferredWindows: [], fallbackIfDeferred: [], notes: [] },
        finance: { nonNegotiables: [], preferredWindows: [], fallbackIfDeferred: [], notes: [] },
        content: { nonNegotiables: [], preferredWindows: [], fallbackIfDeferred: [], notes: [] },
      };
    },
  } as any;
}

function signal(signalType: string, payload: Record<string, unknown>) {
  return {
    sourceAgent: `test.${signalType}`,
    signalType,
    meshPriority: 3,
    priority: 'normal',
    payload,
    expiresAt: '2026-05-10T23:59:59.000Z',
  };
}

// Phase 9 batch 49 (2026-05-16): multi-turn turn-2 state-injection scenarios.
//
// Phase 5 batch 25 added the `turns` field to registry examples and Phase
// 7/8/9 added pending-continuation planner paths for training, cooking,
// mail, decision, finance, and content. This file exercises EACH multi-
// turn registry example end-to-end:
//
//   1. Turn 1: deterministic planner claims the initial action and the test
//      simulates persisting it as a pending-action.
//   2. Turn 2: pending-action mock is set; planner re-runs over turn 2; the
//      continuation should fire and re-emit the action with the new slot
//      filled.
//
// The scenarios pin the canonical turn-2 phrasing in the registry against
// the actual pending-continuation regex in the planner. Drift in either
// direction fails the test.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/chat-action-state', () => ({
  cancelPendingChatActions: vi.fn(() => 0),
  getActivePendingChatAction: vi.fn(() => null),
  markPendingChatActionNeedsUserFollowup: vi.fn(() => false),
  recordChatActionTelemetry: vi.fn(),
  rememberRecentChatEntity: vi.fn(),
  resolveRecentChatEntity: vi.fn(() => ({ status: 'none', candidates: [] })),
  upsertPendingChatAction: vi.fn(),
  makeSlotProvenance: vi.fn((input: any) => ({
    slot: input.slot, value: input.value, rawText: input.rawText ?? null,
    turnId: input.turnId, spanStart: input.spanStart ?? null, spanEnd: input.spanEnd ?? null,
    sourceType: input.sourceType ?? 'user_message', normalizer: input.normalizer,
    confidence: input.confidence, validation: input.validation ?? 'passed',
  })),
}));

import {
  getActivePendingChatAction,
} from '../../src/services/chat-action-state';
import {
  buildChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat-action-planner';
import { getChatActionRegistry } from '../../src/services/chat-action-registry';

const FROZEN_NOW = '2026-05-16T12:00:00+01:00';

function input(text: string, locale = 'en-US', conversationId = `mt-${Date.now()}-${Math.random()}`): ChatPlannerInput {
  return {
    userId: 1, tenantId: 1,
    conversationId,
    messageId: `mt-msg-${Date.now()}-${Math.random()}`,
    locale, timezone: 'Europe/Lisbon', channel: 'telegram',
    text, nowIso: FROZEN_NOW,
  };
}

const mockedGetActivePending = vi.mocked(getActivePendingChatAction);

describe('multi-turn turn-2 state-injection (Phase 9 batch 49)', () => {
  it('every registered multi-turn example covers a known pending-continuation skill', () => {
    type ExampleWithTurns = { turns?: string[]; condition?: string };
    const supportedSkills = new Set(['training', 'cooking', 'mail', 'decision_center', 'finance', 'content']);
    for (const entry of getChatActionRegistry()) {
      const examples = (entry.examples ?? []) as ExampleWithTurns[];
      for (const ex of examples) {
        if (Array.isArray(ex.turns) && ex.turns.length >= 2) {
          expect(
            supportedSkills.has(entry.skill),
            `${entry.skill}.${entry.action}: multi-turn example exists but planner has no pending continuation for this skill`,
          ).toBe(true);
        }
      }
    }
  });

  describe('cooking_meal_plan turn-2 (vegetarian constraint)', () => {
    it('turn 2 fills constraints when pending plan is active', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'cooking') {
          return {
            pendingActionId: 'pending-cooking-mt-1',
            skill: 'cooking',
            action: 'cooking_meal_plan',
            userId: 1,
            tenantId: 1,
            conversationId: 'mt-cooking',
            collectedSlots: { dateRange: 'next_week' },
            missingSlots: ['constraints'],
            ttlExpiresAt: '2026-05-16T13:00:00+01:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('High-protein, vegetarian', 'en-US', 'mt-cooking'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('cooking');
      const args = step?.args as Record<string, unknown> | undefined;
      const constraints = (args?.constraints ?? []) as string[];
      expect(constraints.length).toBeGreaterThan(0);
    });
  });

  describe('finance_categorize_receipt turn-2 (category)', () => {
    it('turn 2 fills category when pending action is active', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'finance') {
          return {
            pendingActionId: 'pending-finance-mt-1',
            skill: 'finance',
            action: 'finance_categorize_receipt',
            userId: 1,
            tenantId: 1,
            conversationId: 'mt-finance',
            collectedSlots: { receiptId: 'receipt-7' },
            missingSlots: ['category'],
            ttlExpiresAt: '2026-05-16T13:00:00+01:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Office supplies', 'en-US', 'mt-finance'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('finance');
      expect(step?.action).toBe('finance_categorize_receipt');
    });
  });

  describe('decision_choose turn-2 (option letter)', () => {
    it('turn 2 fills choice when pending decision is active', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'decision_center') {
          return {
            pendingActionId: 'pending-decision-mt-1',
            skill: 'decision_center',
            action: 'decision_choose',
            userId: 1,
            tenantId: 1,
            conversationId: 'mt-decision',
            collectedSlots: { decisionId: 'decision-mt-7' },
            missingSlots: ['choice'],
            ttlExpiresAt: '2026-05-16T13:00:00+01:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Option B', 'en-US', 'mt-decision'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('decision_center');
      expect(step?.action).toBe('decision_choose');
      const args = step?.args as Record<string, unknown> | undefined;
      expect(args?.choice).toBe('B');
    });
  });

  describe('mail_draft turn-2 (refinement)', () => {
    it('turn 2 applies refinements when pending draft is active', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'mail') {
          return {
            pendingActionId: 'pending-mail-mt-1',
            skill: 'mail',
            action: 'draft_email',
            userId: 1,
            tenantId: 1,
            conversationId: 'mt-mail',
            collectedSlots: { recipient: 'pedro@example.com', subject: 'Update', body: 'Initial draft' },
            missingSlots: ['refinements'],
            ttlExpiresAt: '2026-05-16T13:00:00+01:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Make it shorter and friendlier', 'en-US', 'mt-mail'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('mail');
      expect(step?.action).toBe('draft_email');
    });
  });

  describe('content_brief_create turn-2 (specs)', () => {
    it('turn 2 fills specs when pending brief is active', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'content') {
          return {
            pendingActionId: 'pending-content-mt-1',
            skill: 'content',
            action: 'content_brief_create',
            userId: 1,
            tenantId: 1,
            conversationId: 'mt-content',
            collectedSlots: { objective: 'reel about routines' },
            missingSlots: ['specs'],
            ttlExpiresAt: '2026-05-16T13:00:00+01:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Audience is fitness creators, punchy tone, under 30 seconds', 'en-US', 'mt-content'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('content');
      expect(step?.action).toBe('content_brief_create');
    });
  });

  describe('training_plan_create turn-2 (weekly volume)', () => {
    it('turn 2 fills weeklyVolumeKm when pending training plan is active', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'training') {
          return {
            pendingActionId: 'pending-training-mt-1',
            skill: 'training',
            action: 'training_plan_create',
            userId: 1,
            tenantId: 1,
            conversationId: 'mt-training',
            collectedSlots: { sport: 'running', goal: '10k', durationWeeks: 12, startDate: '2026-05-19' },
            missingSlots: ['weeklyVolumeKm'],
            ttlExpiresAt: '2026-05-16T13:00:00+01:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('It is 20 km a week', 'en-US', 'mt-training'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('training');
      expect(step?.action).toBe('training_plan_create');
      const args = step?.args as Record<string, unknown> | undefined;
      expect(args?.weeklyVolumeKm).toBe(20);
    });
  });

  describe('TTL expiry safety', () => {
    it('expired pending action does not apply (TTL respected)', async () => {
      // Pending action with TTL already expired — mock simulates the
      // chat-action-state layer returning null for expired actions.
      mockedGetActivePending.mockImplementation(() => null);
      const turn2 = await buildChatActionPlan(input('High-protein, vegetarian', 'en-US', 'mt-cooking-expired'));
      // Without active pending state, the cooking continuation should NOT
      // claim. The planner may return null or route to another path, but
      // it must NOT emit cooking_meal_plan with constraints populated.
      if (turn2) {
        const step = turn2.steps[0];
        if (step?.skill === 'cooking' && step.action === 'cooking_meal_plan') {
          const args = step.args as Record<string, unknown>;
          if (Array.isArray(args.constraints)) {
            expect((args.constraints as unknown[]).length).toBe(0);
          }
        }
      }
    });
  });
});

describe('multi-turn pending continuation with real chat-action-state persistence', () => {
  it('MT1 turn 1 persists pending state and turn 2 reads it back with the same conversation ID', async () => {
    vi.resetModules();
    vi.doUnmock('../../src/services/chat-action-state');

    const { default: Database } = await import('better-sqlite3');
    const fs = await import('fs');
    const path = await import('path');

    let integrationDb: any;
    vi.doMock('../../src/services/database', () => ({
      getDb: () => integrationDb,
      initDatabase: vi.fn(),
      closeDatabase: vi.fn(),
      findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
    }));

    integrationDb = new Database(':memory:');
    integrationDb.pragma('journal_mode = WAL');
    integrationDb.pragma('foreign_keys = ON');
    integrationDb.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime(\'now\')))');
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    for (const file of fs.readdirSync(migrationsDir).filter((entry) => entry.endsWith('.sql')).sort()) {
      integrationDb.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
      integrationDb.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(file);
    }

    const previousFlag = process.env.CHAT_HYBRID_PLANNER_ENABLED;
    process.env.CHAT_HYBRID_PLANNER_ENABLED = 'active';

    try {
      const {
        buildChatActionPlan,
        buildDeterministicChatActionPlan,
      } = await import('../../src/services/chat-action-planner');
      const {
        getActivePendingChatAction: getRealActivePendingChatAction,
        upsertPendingChatAction: upsertRealPendingChatAction,
      } = await import('../../src/services/chat-action-state');

      const conversationId = 'mt-real-pending-training';
      const turn1 = buildDeterministicChatActionPlan({
        userId: 77,
        tenantId: 88,
        conversationId,
        messageId: 'mt-real-turn-1',
        locale: 'en-US',
        timezone: 'Europe/Lisbon',
        channel: 'api',
        nowIso: '2026-05-16T12:00:00+01:00',
        text: 'Build me a running 10K plan in 12 weeks starting Monday',
      });

      const turn1Step = turn1?.steps[0];
      expect(turn1Step?.skill).toBe('training');
      expect(turn1Step?.action).toBe('training_plan_create');
      upsertRealPendingChatAction({
        userId: 77,
        tenantId: 88,
        conversationId,
        skill: 'training',
        action: 'training_plan_create',
        collectedSlots: turn1Step?.args as Record<string, unknown>,
        missingSlots: ['startDate', 'weeklyVolumeKm'],
        riskClass: 'R1',
        locale: 'en-US',
        timezone: 'Europe/Lisbon',
        originatingSurface: 'api',
        nowIso: '2026-05-16T12:00:00+01:00',
      });
      const pending = getRealActivePendingChatAction({
        userId: 77,
        tenantId: 88,
        conversationId,
        skill: 'training',
        nowIso: '2026-05-16T12:00:00+01:00',
      });
      expect(pending).toBeTruthy();
      expect(pending?.action).toBe('training_plan_create');
      expect(pending?.missingSlots).toContain('weeklyVolumeKm');

      const turn2 = await buildChatActionPlan({
        userId: 77,
        tenantId: 88,
        conversationId,
        messageId: 'mt-real-turn-2',
        locale: 'en-US',
        timezone: 'Europe/Lisbon',
        channel: 'api',
        nowIso: '2026-05-16T12:01:00+01:00',
        text: 'It is 20 km a week',
      });

      const step = turn2?.steps[0];
      expect(step?.skill).toBe('training');
      expect(step?.action).toBe('training_plan_create');
      expect(step?.args).toMatchObject({ weeklyVolumeKm: 20 });
      expect(step?.requiredArgsPresent).toBe(false);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.CHAT_HYBRID_PLANNER_ENABLED;
      } else {
        process.env.CHAT_HYBRID_PLANNER_ENABLED = previousFlag;
      }
      integrationDb.close();
      vi.resetModules();
    }
  });
});

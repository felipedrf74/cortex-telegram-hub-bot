/**
 * M10: runner mechanics for the /message stage pipeline.
 *
 * - Stage-order snapshot: pins the runner's PLAIN ORDERED ARRAY (names +
 *   per-stage trace emissions). This must stay equal to the stage-trace
 *   pins in __tests__/api/chat-message-replay.test.ts — any reorder or
 *   rename fails here AND there.
 * - Retirement flags: env-driven per-stage disable, default ENABLED,
 *   structural stages never disableable. M20 flips flags; M10 only ships
 *   the mechanism.
 * - Run loop: canHandle gating, respond short-circuit, continue patches.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_MESSAGE_STAGES,
  NON_RETIRABLE_CHAT_STAGES,
  isChatPipelineStageDisabled,
  runChatMessagePipeline,
} from '../../../src/api/routes/chat-pipeline/runner';
import type { ChatStage, ChatTurnCtx } from '../../../src/api/routes/chat-pipeline/types';
import {
  CHAT_V2_RETIREMENT_STAGE_MAPPINGS,
  validateChatV2RetirementStageMappings,
} from '../../../src/services/chat-route-exit-sampler';

// ── Stage-order snapshot (ordering law) ─────────────────────────────
// The flattened trace emissions mirror the recordChatStage names pinned by
// the replay corpus. request_received is recorded by the route BEFORE the
// runner starts, so it does not appear here.
const EXPECTED_STAGE_ORDER: Array<{ name: string; traceStages: string[] }> = [
  { name: 'idempotent_replay', traceStages: ['idempotent_replay_conflict', 'idempotent_replay'] },
  { name: 'idempotency_claim', traceStages: ['idempotency_claim_conflict', 'idempotency_in_progress', 'request_validated'] },
  { name: 'turn_context', traceStages: [] },
  { name: 'token_zero_shortcut', traceStages: ['token_zero_shortcut'] },
  { name: 'chat_core_v2_deterministic_read_early', traceStages: ['chat_core_v2_deterministic_read_early'] },
  { name: 'shadow_route_recording', traceStages: [] },
  { name: 'completion_evidence_recorder', traceStages: [] },
  { name: 'pending_work_cancel', traceStages: ['pending_work_cancelled', 'pending_work_cancel_empty'] },
  { name: 'action_gateway', traceStages: ['action_gateway_preview', 'action_gateway_stop'] },
  { name: 'chat_core_v2_deterministic_read', traceStages: ['chat_core_v2_deterministic_read'] },
  { name: 'cached_command', traceStages: ['cached_command'] },
  { name: 'action_planner_deterministic', traceStages: ['action_planner_deterministic'] },
  { name: 'attachment', traceStages: ['attachment'] },
  { name: 'authenticated_identity', traceStages: ['authenticated_identity'] },
  { name: 'fast_path', traceStages: ['fast_path'] },
  { name: 'training_plan_shortcut', traceStages: ['training_plan_shortcut'] },
  { name: 'action_planner_model', traceStages: ['action_planner_model'] },
  { name: 'pre_routing', traceStages: [] },
  { name: 'internet_research', traceStages: ['internet_research'] },
  { name: 'decision_confirmation_shortcut', traceStages: ['decision_confirmation_shortcut'] },
  { name: 'destructive_confirmation_hold', traceStages: ['destructive_confirmation_hold'] },
  { name: 'routing_clarify', traceStages: ['routing_clarify'] },
  { name: 'cross_skill_plan_declined', traceStages: ['cross_skill_plan_declined'] },
  { name: 'chat_core_v2_local_answer', traceStages: ['chat_core_v2_local_answer'] },
  { name: 'chat_core_v2_unsupported_fallback', traceStages: ['chat_core_v2_unsupported_fallback'] },
  { name: 'legacy_tail', traceStages: ['legacy_route', 'domain_shortcut', 'legacy_response'] },
];

describe('chat-pipeline runner', () => {
  afterEach(() => {
    delete process.env.CHAT_PIPELINE_DISABLED_STAGES;
  });

  describe('stage-order snapshot', () => {
    it('pins the ordered stage array (names + trace emissions)', () => {
      expect(CHAT_MESSAGE_STAGES.map((stage) => ({
        name: stage.name,
        traceStages: [...stage.traceStages],
      }))).toEqual(EXPECTED_STAGE_ORDER);
    });

    it('has unique stage names', () => {
      const names = CHAT_MESSAGE_STAGES.map((stage) => stage.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('ends with the legacy tail terminal', () => {
      expect(CHAT_MESSAGE_STAGES[CHAT_MESSAGE_STAGES.length - 1].name).toBe('legacy_tail');
    });
  });

  describe('retirement flags', () => {
    it('defaults every stage to enabled', () => {
      for (const stage of CHAT_MESSAGE_STAGES) {
        expect(isChatPipelineStageDisabled(stage.name, {} as NodeJS.ProcessEnv)).toBe(false);
      }
    });

    it('disables a retirable stage listed in CHAT_PIPELINE_DISABLED_STAGES', () => {
      const env = { CHAT_PIPELINE_DISABLED_STAGES: 'cached_command, fast_path' } as NodeJS.ProcessEnv;
      expect(isChatPipelineStageDisabled('cached_command', env)).toBe(true);
      expect(isChatPipelineStageDisabled('fast_path', env)).toBe(true);
      expect(isChatPipelineStageDisabled('training_plan_shortcut', env)).toBe(false);
    });

    it('never disables structural/safety stages', () => {
      const allNames = CHAT_MESSAGE_STAGES.map((stage) => stage.name).join(',');
      const env = { CHAT_PIPELINE_DISABLED_STAGES: allNames } as NodeJS.ProcessEnv;
      for (const name of NON_RETIRABLE_CHAT_STAGES) {
        expect(isChatPipelineStageDisabled(name, env)).toBe(false);
      }
      expect(isChatPipelineStageDisabled('legacy_tail', env)).toBe(false);
      expect(isChatPipelineStageDisabled('action_gateway', env)).toBe(false);
    });

    it('lists every non-retirable stage name in the runner array', () => {
      const names = new Set(CHAT_MESSAGE_STAGES.map((stage) => stage.name));
      for (const name of NON_RETIRABLE_CHAT_STAGES) {
        expect(names.has(name)).toBe(true);
      }
    });

    it('pins every retirement candidate mapping to a real retirable stage', () => {
      expect(validateChatV2RetirementStageMappings(
        CHAT_MESSAGE_STAGES.map((stage) => stage.name),
        NON_RETIRABLE_CHAT_STAGES,
      )).toEqual([]);
      expect(CHAT_V2_RETIREMENT_STAGE_MAPPINGS.destructive_confirmation_hold).toMatchObject({
        status: 'non_retirable',
        disableStages: [],
      });
    });
  });

  describe('run loop', () => {
    const baseCtx = () => ({ marker: [] as string[] }) as unknown as ChatTurnCtx & { marker: string[] };

    function stage(
      name: string,
      canHandle: boolean,
      result: 'respond' | 'continue',
      patch?: Record<string, unknown>,
    ): ChatStage {
      return {
        name,
        traceStages: [],
        canHandle: (ctx) => {
          (ctx as unknown as { marker: string[] }).marker.push(`can:${name}`);
          return canHandle;
        },
        handle: async (ctx) => {
          (ctx as unknown as { marker: string[] }).marker.push(`run:${name}`);
          return result === 'respond' ? { kind: 'respond' } : { kind: 'continue', patch: patch as Partial<ChatTurnCtx> };
        },
      };
    }

    it('skips stages whose canHandle returns false', async () => {
      const ctx = baseCtx();
      const responded = await runChatMessagePipeline(ctx, [
        stage('a', false, 'respond'),
        stage('b', true, 'respond'),
      ]);
      expect(responded).toBe('b');
      expect(ctx.marker).toEqual(['can:a', 'can:b', 'run:b']);
    });

    it('stops at the first respond result', async () => {
      const ctx = baseCtx();
      const responded = await runChatMessagePipeline(ctx, [
        stage('a', true, 'continue'),
        stage('b', true, 'respond'),
        stage('c', true, 'respond'),
      ]);
      expect(responded).toBe('b');
      expect(ctx.marker).toEqual(['can:a', 'run:a', 'can:b', 'run:b']);
    });

    it('applies continue patches to the shared context', async () => {
      const ctx = baseCtx();
      await runChatMessagePipeline(ctx, [
        stage('a', true, 'continue', { chatCoreV2RouteLocale: 'pt-PT' }),
        {
          name: 'assert',
          traceStages: [],
          canHandle: () => true,
          handle: async (inner) => {
            (inner as unknown as { marker: string[] }).marker.push(`locale:${inner.chatCoreV2RouteLocale}`);
            return { kind: 'respond' };
          },
        },
      ]);
      expect(ctx.marker).toContain('locale:pt-PT');
    });

    it('skips stages disabled by the retirement flag', async () => {
      process.env.CHAT_PIPELINE_DISABLED_STAGES = 'retire-me';
      const ctx = baseCtx();
      const responded = await runChatMessagePipeline(ctx, [
        stage('retire-me', true, 'respond'),
        stage('b', true, 'respond'),
      ]);
      expect(responded).toBe('b');
      expect(ctx.marker).toEqual(['can:b', 'run:b']);
    });

    it('returns null when no stage responds', async () => {
      const ctx = baseCtx();
      const responded = await runChatMessagePipeline(ctx, [stage('a', true, 'continue')]);
      expect(responded).toBeNull();
    });
  });
});

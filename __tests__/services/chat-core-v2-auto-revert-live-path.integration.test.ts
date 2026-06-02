// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * WP-07 — THE LOAD-BEARING DMV INTEGRATION TEST.
 *
 * Proves the per-tenant runtime override reaches the LIVE chat path (the same
 * two parsers `chat-message-routes.ts` calls at :1024/:1146/:1332), WITHOUT a
 * restart, and that it is per-tenant isolated:
 *
 *   With CHAT_CORE_V2_ORCHESTRATOR_MODE=on (master active) and NO override,
 *   tenant A and tenant B both serve normally. Then
 *   setChatCoreV2RuntimeOverride(tenantA, {mode:'shadow'}); on the SAME process
 *   WITHOUT a restart:
 *     - resolveChatCoreV2ActionGatewayMode(env, tenantA) !== 'enforce', and
 *       runChatCoreV2ActionGateway for tenant A no longer enforces, while
 *       tenant B still enforces;
 *     - isChatCoreV2LocalChatVisibleEnabled(env, {tenantId:A}) === false, so
 *       runChatCoreV2LocalChatTurn returns null for tenant A, while tenant B
 *       still serves a (mocked) local-chat result.
 *
 * It also asserts the activation-flags kill-switch extension directly:
 * isChatCoreV2MasterKillSwitchOff(env, tenantA) flips to true once tenant A is
 * demoted, stays false for tenant B, and an explicit env 'off' dominates any
 * override (precedence).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchLocalReasoning: vi.fn(),
}));

vi.mock('../../src/services/provider-registry', () => ({
  ensureActiveProvider: vi.fn(() => ({
    dispatchLocalReasoning: mocks.dispatchLocalReasoning,
  })),
}));

import {
  _resetChatCoreV2RuntimeOverridesForTests,
  isChatCoreV2MasterKillSwitchOff,
  setChatCoreV2RuntimeOverride,
} from '../../src/services/chat-core-v2/activation-flags';
import {
  resolveChatCoreV2ActionGatewayMode,
  runChatCoreV2ActionGateway,
} from '../../src/services/chat-core-v2/action-gateway';
import {
  isChatCoreV2LocalChatVisibleEnabled,
  resolveChatCoreV2LocalChatLlmMode,
  runChatCoreV2LocalChatTurn,
} from '../../src/services/chat-core-v2/local-chat-orchestrator';

const TENANT_A = 111;
const TENANT_B = 222;
const TENANT_A_KEY = String(TENANT_A);
const TENANT_B_KEY = String(TENANT_B);

// Master active (mode=on); local-chat + gateway both live, surface ios allowed,
// prod-allow set so canary/on visibility does not depend on NODE_ENV.
function liveEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
    CHAT_CORE_V2_ALLOWED_SURFACES: 'ios',
    CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'on',
    CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
    CHAT_CORE_V2_LOCAL_CHAT_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function gatewayInput(tenantId: number, text: string): Parameters<typeof runChatCoreV2ActionGateway>[0] {
  return {
    normalizedText: text,
    userId: 42,
    tenantId,
    conversationId: `conv-${tenantId}`,
    messageId: `msg-${tenantId}`,
    locale: 'en',
    timezone: 'UTC',
    now: new Date('2026-05-30T12:00:00.000Z'),
    requestId: `req-${tenantId}`,
  } as Parameters<typeof runChatCoreV2ActionGateway>[0];
}

function localChatInput(tenantId: number, env: NodeJS.ProcessEnv): Parameters<typeof runChatCoreV2LocalChatTurn>[0] {
  return {
    normalizedText: 'what is a good easy dinner idea?',
    userId: 42,
    tenantId,
    requestId: `req-${tenantId}`,
    locale: 'en',
    surface: 'ios',
    env,
    recentTurns: [],
  } as Parameters<typeof runChatCoreV2LocalChatTurn>[0];
}

describe('WP-07 per-tenant override reaches the LIVE chat path (DMV integration)', () => {
  beforeEach(() => {
    _resetChatCoreV2RuntimeOverridesForTests();
    mocks.dispatchLocalReasoning.mockReset();
    // A successful local reasoning result so a VISIBLE tenant gets a non-null turn.
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Try a simple chicken stir-fry with rice.',
      parsed: undefined,
      stopReason: 'stop',
      providerMetadata: { model: 'qwen2.5:3b-instruct-q4_K_M', evalCount: 12 },
    });
  });

  afterEach(() => {
    _resetChatCoreV2RuntimeOverridesForTests();
  });

  describe('activation-flags kill-switch extension + precedence', () => {
    it('flips to true for tenant A once demoted to shadow, stays false for tenant B', () => {
      const env = liveEnv();
      expect(isChatCoreV2MasterKillSwitchOff(env, TENANT_A_KEY)).toBe(false);
      expect(isChatCoreV2MasterKillSwitchOff(env, TENANT_B_KEY)).toBe(false);

      setChatCoreV2RuntimeOverride(TENANT_A_KEY, { mode: 'shadow' });

      // Same process, no restart.
      expect(isChatCoreV2MasterKillSwitchOff(env, TENANT_A_KEY)).toBe(true);
      expect(isChatCoreV2MasterKillSwitchOff(env, TENANT_B_KEY)).toBe(false);
    });

    it("an override mode 'off' also forces the helper true for that tenant", () => {
      const env = liveEnv();
      setChatCoreV2RuntimeOverride(TENANT_A_KEY, { mode: 'off' });
      expect(isChatCoreV2MasterKillSwitchOff(env, TENANT_A_KEY)).toBe(true);
    });

    it('explicit env off DOMINATES any override (precedence — override can only demote)', () => {
      const offEnv = liveEnv({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off' });
      // No override set, env off => true (existing behavior, 1-arg).
      expect(isChatCoreV2MasterKillSwitchOff(offEnv)).toBe(true);
      // An override cannot un-off an env-off path; it can only ADD a kill.
      setChatCoreV2RuntimeOverride(TENANT_A_KEY, { mode: 'shadow' });
      expect(isChatCoreV2MasterKillSwitchOff(offEnv, TENANT_A_KEY)).toBe(true);
      // And without a tenantId, env off still wins.
      expect(isChatCoreV2MasterKillSwitchOff(offEnv, undefined)).toBe(true);
    });
  });

  describe('the flip reaches the live action-gateway parser', () => {
    it('demotes tenant A off enforce while tenant B stays enforce (same process)', () => {
      const env = liveEnv();
      // Baseline: both tenants enforce.
      expect(resolveChatCoreV2ActionGatewayMode(env, TENANT_A_KEY)).toBe('enforce');
      expect(resolveChatCoreV2ActionGatewayMode(env, TENANT_B_KEY)).toBe('enforce');

      setChatCoreV2RuntimeOverride(TENANT_A_KEY, { mode: 'shadow' });

      expect(resolveChatCoreV2ActionGatewayMode(env, TENANT_A_KEY)).not.toBe('enforce');
      expect(resolveChatCoreV2ActionGatewayMode(env, TENANT_A_KEY)).toBe('off');
      expect(resolveChatCoreV2ActionGatewayMode(env, TENANT_B_KEY)).toBe('enforce');
    });

    it('runChatCoreV2ActionGateway reports mode off for tenant A but enforce for tenant B on a write-intent turn', () => {
      const env = liveEnv();
      const writeText = 'create a task to buy milk';

      setChatCoreV2RuntimeOverride(TENANT_A_KEY, { mode: 'shadow' });

      const a = runChatCoreV2ActionGateway({ ...gatewayInput(TENANT_A, writeText), env });
      // Tenant A is demoted: the gateway is off, so it never enforces a write.
      expect(a.telemetry.mode).toBe('off');
      expect(a.kind).toBe('no_write_intent');

      const b = runChatCoreV2ActionGateway({ ...gatewayInput(TENANT_B, writeText), env });
      // Tenant B still enforces — its telemetry mode is the live enforce path.
      expect(b.telemetry.mode).toBe('enforce');
    });
  });

  describe('the flip reaches the live local-chat parser', () => {
    it('isChatCoreV2LocalChatVisibleEnabled becomes false for tenant A but stays true for tenant B', () => {
      const env = liveEnv();
      expect(isChatCoreV2LocalChatVisibleEnabled(env, { surface: 'ios', userId: 42, tenantId: TENANT_A })).toBe(true);
      expect(isChatCoreV2LocalChatVisibleEnabled(env, { surface: 'ios', userId: 42, tenantId: TENANT_B })).toBe(true);

      setChatCoreV2RuntimeOverride(TENANT_A_KEY, { mode: 'shadow' });

      expect(resolveChatCoreV2LocalChatLlmMode(env, TENANT_A_KEY)).toBe('off');
      expect(isChatCoreV2LocalChatVisibleEnabled(env, { surface: 'ios', userId: 42, tenantId: TENANT_A })).toBe(false);
      expect(isChatCoreV2LocalChatVisibleEnabled(env, { surface: 'ios', userId: 42, tenantId: TENANT_B })).toBe(true);
    });

    it('runChatCoreV2LocalChatTurn returns null for tenant A but a result for tenant B', async () => {
      const env = liveEnv();

      // Baseline (no override): both tenants serve a non-null local-chat turn.
      const aBefore = await runChatCoreV2LocalChatTurn(localChatInput(TENANT_A, env));
      const bBefore = await runChatCoreV2LocalChatTurn(localChatInput(TENANT_B, env));
      expect(aBefore).not.toBeNull();
      expect(bBefore).not.toBeNull();

      // Flip tenant A to shadow on the SAME process.
      setChatCoreV2RuntimeOverride(TENANT_A_KEY, { mode: 'shadow' });

      const aAfter = await runChatCoreV2LocalChatTurn(localChatInput(TENANT_A, env));
      const bAfter = await runChatCoreV2LocalChatTurn(localChatInput(TENANT_B, env));
      expect(aAfter).toBeNull(); // tenant A demoted off the live path
      expect(bAfter).not.toBeNull(); // tenant B unaffected
    });
  });
});

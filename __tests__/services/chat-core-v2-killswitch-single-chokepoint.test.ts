import { describe, expect, it } from 'vitest';

import {
  isChatCoreV2MasterKillSwitchOff,
  resolveChatCoreV2ActivationConfig,
} from '../../src/services/chat-core-v2/activation-flags';
import { resolveChatCoreV2LocalChatLlmMode } from '../../src/services/chat-core-v2/local-chat-orchestrator';
import { resolveChatCoreV2ActionGatewayMode } from '../../src/services/chat-core-v2/action-gateway';

// WP-00.5 consolidates the master kill switch for the two live chat entry
// parsers into ONE chokepoint (isChatCoreV2MasterKillSwitchOff), so a future
// WP-07 runtime-override can stop the live chat-message-routes path without a
// restart. It is BEHAVIOR-PRESERVING: an EXPLICIT off kills; an ABSENT master
// mode defers to the sub-mode flags (the prior behavior). Strict default-off
// subordination (absent => all sub-modes off) is a separate, deliberate change.
describe('Chat Core v2 kill-switch single chokepoint (WP-00.5)', () => {
  describe('parseMode hardening (exercised through the resolver)', () => {
    it('normalizes case and surrounding whitespace before matching the master mode', () => {
      expect(resolveChatCoreV2ActivationConfig({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'ON ' }).mode).toBe('on');
      expect(resolveChatCoreV2ActivationConfig({ CHAT_CORE_V2_ORCHESTRATOR_MODE: '  shadow ' }).mode).toBe('shadow');
      expect(resolveChatCoreV2ActivationConfig({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'Canary' }).mode).toBe('canary');
    });

    it('treats unknown, empty, and absent values as off', () => {
      expect(resolveChatCoreV2ActivationConfig({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'garbage' }).mode).toBe('off');
      expect(resolveChatCoreV2ActivationConfig({}).mode).toBe('off');
    });
  });

  describe('isChatCoreV2MasterKillSwitchOff (the one chokepoint)', () => {
    it('fires only on an EXPLICIT off, case/whitespace-insensitive', () => {
      expect(isChatCoreV2MasterKillSwitchOff({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off' })).toBe(true);
      expect(isChatCoreV2MasterKillSwitchOff({ CHAT_CORE_V2_ORCHESTRATOR_MODE: '  OFF ' })).toBe(true);
    });

    it('does NOT fire on an absent master mode (defers to sub-mode flags — legacy activation preserved)', () => {
      expect(isChatCoreV2MasterKillSwitchOff({})).toBe(false);
      expect(isChatCoreV2MasterKillSwitchOff({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on' })).toBe(false);
      expect(isChatCoreV2MasterKillSwitchOff({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow' })).toBe(false);
    });
  });

  describe('both live parsers honor the one chokepoint', () => {
    it('return off when the master mode is EXPLICITLY off, regardless of the sub-mode env', () => {
      const env = {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: ' OFF ',
        CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'on',
        CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
        CHAT_CORE_V2_ENABLED: 'true',
        CHAT_CORE_V2_WRITES_ENABLED: 'true',
      } as NodeJS.ProcessEnv;
      expect(resolveChatCoreV2LocalChatLlmMode(env)).toBe('off');
      expect(resolveChatCoreV2ActionGatewayMode(env)).toBe('off');
    });

    it('defer to the sub-mode flags when the master mode is absent (not killed)', () => {
      const env = {
        CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'canary',
        CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
      } as NodeJS.ProcessEnv;
      expect(resolveChatCoreV2LocalChatLlmMode(env)).toBe('canary');
      expect(resolveChatCoreV2ActionGatewayMode(env)).toBe('enforce');
    });

    it('preserve the legacy CHAT_CORE_V2_ENABLED gateway activation when the master mode is absent', () => {
      const env = {
        CHAT_CORE_V2_ENABLED: 'true',
        CHAT_CORE_V2_WRITES_ENABLED: 'true',
      } as NodeJS.ProcessEnv;
      expect(resolveChatCoreV2ActionGatewayMode(env)).toBe('enforce');
    });
  });
});

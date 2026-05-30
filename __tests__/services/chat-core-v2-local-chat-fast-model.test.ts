// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// WP-11 (D3 latency fast-model + benchmark gate). Pure-resolver coverage for the
// conservative reasoning-tier classifier, the resolveLocalChatModel selection
// matrix, and the kill-switch invariants (FAST_MODEL='off' disables the inner
// fast path; orchestrator mode=off makes the whole local-chat path inert because
// isChatCoreV2LocalChatVisibleEnabled returns false — the outer kill-switch
// dominates the inner default).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchLocalReasoning: vi.fn(),
}));

vi.mock('../../src/services/provider-registry', () => ({
  ensureActiveProvider: vi.fn(() => ({
    dispatchLocalReasoning: mocks.dispatchLocalReasoning,
  })),
}));

import {
  CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL_DEFAULT,
  classifyLocalReasoningTier,
  isChatCoreV2LocalChatVisibleEnabled,
  resolveLocalChatModel,
  runChatCoreV2LocalChatTurn,
  type ChatCoreV2LocalReasoningTier,
} from '../../src/services/chat-core-v2/local-chat-orchestrator';
import { _resetLocalInferenceGateForTests } from '../../src/services/chat-core-v2/local-inference-concurrency-gate';

const STANDARD_MODEL = 'qwen2.5:3b-instruct-q4_K_M';
const RECIPE_MODEL = 'qwen2.5:7b-instruct-q4_K_M';

function fastEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CHAT_CORE_V2_LOCAL_CHAT_MODEL: STANDARD_MODEL,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function visibleEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
    CHAT_CORE_V2_ALLOWED_SURFACES: 'ios',
    CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'canary',
    CHAT_CORE_V2_LOCAL_CHAT_MODEL: STANDARD_MODEL,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('WP-11 classifyLocalReasoningTier (pure, conservative)', () => {
  it('classifies an empty message as none', () => {
    expect(classifyLocalReasoningTier({ normalizedText: '' })).toBe('none');
    expect(classifyLocalReasoningTier({ normalizedText: '   ' })).toBe('none');
  });

  it('classifies trivial greetings/acknowledgements as none', () => {
    for (const text of ['hi', 'hello', 'hey', 'ok', 'thanks', 'thank you', 'obrigado', 'gracias', 'hola']) {
      expect(classifyLocalReasoningTier({ normalizedText: text })).toBe('none');
    }
  });

  it('classifies a short single-intent question as fast_extraction', () => {
    expect(classifyLocalReasoningTier({ normalizedText: 'what time is it?' })).toBe('fast_extraction');
    expect(classifyLocalReasoningTier({ normalizedText: 'how do I stay focused?' })).toBe('fast_extraction');
  });

  it('is conservative: write-intent turns are standard_command, never downgraded', () => {
    expect(classifyLocalReasoningTier({ normalizedText: 'create a task to call the dentist' })).toBe('standard_command');
    expect(classifyLocalReasoningTier({ normalizedText: 'mark the gym task as done' })).toBe('standard_command');
    expect(classifyLocalReasoningTier({ normalizedText: 'cancel that' })).toBe('standard_command');
  });

  it('is conservative: recipe requests are standard_command', () => {
    expect(classifyLocalReasoningTier({ normalizedText: 'give me a recipe for chicken' })).toBe('standard_command');
    expect(classifyLocalReasoningTier({ normalizedText: 'how do I cook a steak dish for 4 people?' })).toBe('standard_command');
  });

  it('is conservative: long messages are standard_command (length rule)', () => {
    const long = 'I have been thinking a lot about how to organize my whole week ahead and I really want a detailed breakdown of priorities, energy levels, and recovery across both training and work please';
    expect(long.length).toBeGreaterThan(160);
    expect(classifyLocalReasoningTier({ normalizedText: long })).toBe('standard_command');
  });

  it('is conservative: high word-count messages are standard_command (word rule)', () => {
    // 30 single-letter tokens: > 24 words but <= 160 chars, so this exercises
    // the word-count rule specifically, not the length rule.
    const manyWords = Array.from({ length: 30 }, () => 'a').join(' ');
    expect(manyWords.length).toBeLessThanOrEqual(160);
    expect(manyWords.split(/\s+/).length).toBeGreaterThan(24);
    expect(classifyLocalReasoningTier({ normalizedText: manyWords })).toBe('standard_command');
  });

  it('is conservative: multi-turn follow-ups are standard_command', () => {
    expect(classifyLocalReasoningTier({
      normalizedText: 'and then?',
      recentTurns: [
        { role: 'user', text: 'plan my day' },
        { role: 'assistant', text: 'start with a focus block' },
      ],
    })).toBe('standard_command');
  });

  it('allows a short turn with at most one prior context turn to stay fast', () => {
    expect(classifyLocalReasoningTier({
      normalizedText: 'why?',
      recentTurns: [{ role: 'assistant', text: 'pick one focus block' }],
    })).toBe('fast_extraction');
  });
});

describe('WP-11 resolveLocalChatModel selection matrix', () => {
  it('recipe turns use the recipe model regardless of tier', () => {
    const env = fastEnv({ CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: RECIPE_MODEL });
    expect(resolveLocalChatModel(env, true, 'none')).toBe(RECIPE_MODEL);
    expect(resolveLocalChatModel(env, true, 'fast_extraction')).toBe(RECIPE_MODEL);
    expect(resolveLocalChatModel(env, true, 'standard_command')).toBe(RECIPE_MODEL);
  });

  it('non-recipe fast_extraction/none turns use the fast model (default value)', () => {
    const env = fastEnv();
    expect(resolveLocalChatModel(env, false, 'none')).toBe(CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL_DEFAULT);
    expect(resolveLocalChatModel(env, false, 'fast_extraction')).toBe(CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL_DEFAULT);
  });

  it('honors an explicit fast model override', () => {
    const env = fastEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'tiny-model:custom' });
    expect(resolveLocalChatModel(env, false, 'fast_extraction')).toBe('tiny-model:custom');
  });

  it('non-recipe standard_command turns use the standard model', () => {
    expect(resolveLocalChatModel(fastEnv(), false, 'standard_command')).toBe(STANDARD_MODEL);
  });

  it("FAST_MODEL='off' DISABLES the fast path even for trivial turns (falls back to standard)", () => {
    const env = fastEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' });
    expect(resolveLocalChatModel(env, false, 'none')).toBe(STANDARD_MODEL);
    expect(resolveLocalChatModel(env, false, 'fast_extraction')).toBe(STANDARD_MODEL);
  });

  it("FAST_MODEL='OFF' (any case) also disables the fast path", () => {
    const env = fastEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'OFF' });
    expect(resolveLocalChatModel(env, false, 'fast_extraction')).toBe(STANDARD_MODEL);
  });
});

describe('WP-11 kill-switch invariants', () => {
  beforeEach(() => {
    mocks.dispatchLocalReasoning.mockReset();
    _resetLocalInferenceGateForTests();
  });

  it('the fast path is INERT when orchestrator mode=off (isChatCoreV2LocalChatVisibleEnabled is false)', async () => {
    // mode=off makes local-chat invisible regardless of the inner fast-model
    // default — the outer kill-switch dominates.
    const env = visibleEnv({
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
      CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'on',
      // Fast model present + a trivial turn — still must NOT run.
      CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'tiny-model:custom',
    });

    expect(isChatCoreV2LocalChatVisibleEnabled(env, { surface: 'ios', userId: 42, tenantId: 84 })).toBe(false);

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'hello',
      userId: 42,
      tenantId: 84,
      requestId: 'req-off',
      locale: 'en',
      surface: 'ios',
      env,
    });

    // No turn runs, no model is dispatched — shipping with mode=off changes nothing.
    expect(result).toBeNull();
    expect(mocks.dispatchLocalReasoning).not.toHaveBeenCalled();
  });

  it('selects the fast model on a visible trivial turn and surfaces fastModelUsed=true', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Pick one small next action and finish it.',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'tiny-model:custom', fallbackUsed: false },
    });
    const env = visibleEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'tiny-model:custom' });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'how do I stay focused?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-fast',
      locale: 'en',
      surface: 'ios',
      env,
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      reasoningTier: 'fast_extraction' satisfies ChatCoreV2LocalReasoningTier,
      fastModelUsed: true,
    }));
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'tiny-model:custom',
    }));
  });

  it("FAST_MODEL='off' on a visible trivial turn falls back to the standard model (fastModelUsed=false)", async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Pick one small next action and finish it.',
      providerMetadata: { providerUsed: 'ollama', modelUsed: STANDARD_MODEL, fallbackUsed: false },
    });
    const env = visibleEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off' });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'how do I stay focused?',
      userId: 42,
      tenantId: 84,
      requestId: 'req-fast-off',
      locale: 'en',
      surface: 'ios',
      env,
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      reasoningTier: 'fast_extraction' satisfies ChatCoreV2LocalReasoningTier,
      fastModelUsed: false,
    }));
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: STANDARD_MODEL,
    }));
  });

  it('a visible standard_command turn uses the standard model with fastModelUsed=false', async () => {
    mocks.dispatchLocalReasoning.mockResolvedValue({
      text: 'Here is a focused breakdown of your week.',
      providerMetadata: { providerUsed: 'ollama', modelUsed: STANDARD_MODEL, fallbackUsed: false },
    });
    const env = visibleEnv({ CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'tiny-model:custom' });

    const result = await runChatCoreV2LocalChatTurn({
      normalizedText: 'I have been thinking a lot about how to organize my week and I want a detailed breakdown of priorities, energy, and recovery across training and work please',
      userId: 42,
      tenantId: 84,
      requestId: 'req-standard',
      locale: 'en',
      surface: 'ios',
      env,
    });

    expect(result?.degraded).toBe(false);
    expect(result?.response.metadata).toEqual(expect.objectContaining({
      reasoningTier: 'standard_command' satisfies ChatCoreV2LocalReasoningTier,
      fastModelUsed: false,
    }));
    expect(mocks.dispatchLocalReasoning).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: STANDARD_MODEL,
    }));
  });
});

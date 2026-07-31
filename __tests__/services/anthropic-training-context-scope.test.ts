import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadTrainingContextAll = vi.fn();
const mockTrackedCreate = vi.fn();
const mockBuildKnowledgePromptBlock = vi.fn();
const mockGetUserLanguage = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor(_options: unknown) {}
  },
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: (...args: unknown[]) => mockTrackedCreate(...args),
}));

vi.mock('../../src/services/training-signals', () => ({
  readTrainingContextAll: (...args: unknown[]) => mockReadTrainingContextAll(...args),
  formatTrainingContextForPrompt: vi.fn(() => '<training-context />'),
}));

vi.mock('../../src/state/content-references', async () => ({
  ...(await vi.importActual('../../src/state/content-references')),
  buildKnowledgePromptBlock: (...args: unknown[]) => mockBuildKnowledgePromptBlock(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
}));

import {
  callDomain,
  callStructuredGeneration,
  continueWithToolResults,
} from '../../src/services/anthropic';
import { runWithChatRequestLocale } from '../../src/services/chat-request-locale-context';
import { runWithContext } from '../../src/utils/request-context';

describe('Anthropic training-context tenant scope', () => {
  beforeEach(() => {
    mockReadTrainingContextAll.mockReset();
    mockReadTrainingContextAll.mockReturnValue({ signals: [{ type: 'session_load' }] });
    mockTrackedCreate.mockReset();
    mockBuildKnowledgePromptBlock.mockReset();
    mockGetUserLanguage.mockReset();
    mockGetUserLanguage.mockReturnValue('pt-BR');
    mockTrackedCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Scoped response' }],
      stop_reason: 'end_turn',
    });
  });

  it('binds both initial and continuation reads to the authenticated tenant', async () => {
    const options = { filteredTools: [], userId: 306, tenantId: 901 };

    await callDomain('triathlon', [], 'Plan my run', '', options);
    await continueWithToolResults('triathlon', [], 'Plan my run', '', [], undefined, options);

    expect(mockReadTrainingContextAll).toHaveBeenNthCalledWith(1, { userId: 306, tenantId: 901 });
    expect(mockReadTrainingContextAll).toHaveBeenNthCalledWith(2, { userId: 306, tenantId: 901 });
  });

  it('uses the supplied ScriptGen schema as the actual system prompt without tools or tenant enrichment', async () => {
    const result = await callStructuredGeneration({
      systemPrompt: 'Return only JSON matching SCHEMA_X.',
      userPrompt: 'Create the requested helper.',
      model: 'claude-sonnet-4-6',
      maxTokens: 4096,
      userId: 306,
      tenantId: 901,
      category: 'cloud_script_generation_artifacts',
      responseFormat: 'json',
    });

    expect(result).toEqual({ text: 'Scoped response', stopReason: 'end_turn' });
    expect(mockTrackedCreate).toHaveBeenCalledTimes(1);
    const [, request, category, attribution] = mockTrackedCreate.mock.calls[0];
    expect(request).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [{ type: 'text', text: 'Return only JSON matching SCHEMA_X.' }],
      messages: [{ role: 'user', content: 'Create the requested helper.' }],
    });
    expect(request).not.toHaveProperty('tools');
    expect(category).toBe('cloud_script_generation_artifacts');
    expect(attribution).toEqual({ userId: 306, tenantId: 901, isUserMessage: true });
    expect(mockBuildKnowledgePromptBlock).not.toHaveBeenCalled();
    expect(mockReadTrainingContextAll).not.toHaveBeenCalled();
  });

  it('rejects a non-Claude structured-generation model before SDK dispatch', async () => {
    await expect(callStructuredGeneration({
      systemPrompt: 'Return JSON.',
      userPrompt: 'Create the requested helper.',
      model: 'gpt-4o',
      maxTokens: 512,
      userId: 306,
      tenantId: 901,
      category: 'cloud_script_generation_plan',
      responseFormat: 'json',
    })).rejects.toThrow('requires a Claude model');

    expect(mockTrackedCreate).not.toHaveBeenCalled();
  });

  it('normalizes a missing provider stop reason', async () => {
    mockTrackedCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Structured response' }],
      stop_reason: null,
    });

    await expect(callStructuredGeneration({
      systemPrompt: 'Return JSON.',
      userPrompt: 'Create the requested helper.',
      model: 'claude-sonnet-4-6',
      maxTokens: 512,
      userId: 306,
      tenantId: 901,
      category: 'cloud_script_generation_plan',
      responseFormat: 'json',
    })).resolves.toEqual({
      text: 'Structured response',
      stopReason: 'end_turn',
    });
  });
});

describe('Anthropic current-turn-only privacy scope', () => {
  const savedKnowledge = '\nPRIVATE_SAVED_CONTENT_KNOWLEDGE';
  const savedHistory = [
    { role: 'user' as const, content: 'PRIVATE_SAVED_USER_HISTORY' },
    { role: 'assistant' as const, content: 'PRIVATE_SAVED_ASSISTANT_HISTORY' },
  ];
  const savedState = 'PRIVATE_SAVED_STATE_CONTEXT';
  const currentMessage = 'Compare broad narrative with tailored narrative.';
  const currentToolConversation = [
    { role: 'assistant' as const, content: 'CURRENT_TURN_TOOL_CONVERSATION' },
  ];
  const savedDataTool = {
    name: 'read_saved_content',
    description: 'Read saved content.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  };

  beforeEach(() => {
    mockReadTrainingContextAll.mockReset();
    mockReadTrainingContextAll.mockReturnValue({ signals: [] });
    mockTrackedCreate.mockReset();
    mockBuildKnowledgePromptBlock.mockReset();
    mockBuildKnowledgePromptBlock.mockReturnValue(savedKnowledge);
    mockGetUserLanguage.mockReset();
    mockGetUserLanguage.mockReturnValue('pt-BR');
    mockTrackedCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Current-turn response' }],
      stop_reason: 'end_turn',
    });
  });

  it('omits saved Content knowledge, history, state, and tools from an initial current-turn-only call', async () => {
    await callDomain(
      'content',
      savedHistory,
      currentMessage,
      savedState,
      {
        filteredTools: [savedDataTool],
        userId: 306,
        tenantId: 901,
        currentTurnOnly: true,
      },
    );

    expect(mockBuildKnowledgePromptBlock).not.toHaveBeenCalled();
    expect(mockTrackedCreate).toHaveBeenCalledTimes(1);
    const [, request] = mockTrackedCreate.mock.calls[0];
    expect(JSON.stringify(request.system)).not.toContain(savedKnowledge.trim());
    expect(request.messages).toEqual([
      { role: 'user', content: currentMessage },
    ]);
    expect(request).not.toHaveProperty('tools');
  });

  it('uses only request-local language evidence for a current-turn-only call', async () => {
    await runWithContext(
      { source: 'http', userId: 306, tenantId: 901 },
      () => runWithChatRequestLocale(
        'en-US',
        () => callDomain(
          'content',
          savedHistory,
          currentMessage,
          savedState,
          {
            filteredTools: [savedDataTool],
            userId: 306,
            tenantId: 901,
            currentTurnOnly: true,
          },
        ),
      ),
    );

    expect(mockGetUserLanguage).not.toHaveBeenCalled();
    const [, request] = mockTrackedCreate.mock.calls[0];
    expect(JSON.stringify(request.system)).toContain('Reply in English');
  });

  it('omits saved Content knowledge, history, state, and tools from a current-turn-only continuation', async () => {
    await continueWithToolResults(
      'content',
      savedHistory,
      currentMessage,
      savedState,
      currentToolConversation,
      undefined,
      {
        filteredTools: [savedDataTool],
        userId: 306,
        tenantId: 901,
        currentTurnOnly: true,
      },
    );

    expect(mockBuildKnowledgePromptBlock).not.toHaveBeenCalled();
    expect(mockTrackedCreate).toHaveBeenCalledTimes(1);
    const [, request] = mockTrackedCreate.mock.calls[0];
    expect(JSON.stringify(request.system)).not.toContain(savedKnowledge.trim());
    expect(request.messages).toEqual([
      { role: 'user', content: currentMessage },
      ...currentToolConversation,
    ]);
    expect(request).not.toHaveProperty('tools');
  });

  it('does not reintroduce sliced Secretary history on either current-turn-only path', async () => {
    const secretaryMessage = 'Show my tasks without reading saved data.';
    const options = {
      filteredTools: [savedDataTool],
      userId: 306,
      tenantId: 901,
      currentTurnOnly: true,
    };

    await callDomain('secretary', savedHistory, secretaryMessage, savedState, options);
    await continueWithToolResults(
      'secretary',
      savedHistory,
      secretaryMessage,
      savedState,
      currentToolConversation,
      undefined,
      options,
    );

    expect(mockTrackedCreate).toHaveBeenCalledTimes(2);
    expect(mockTrackedCreate.mock.calls[0]?.[1].messages).toEqual([
      { role: 'user', content: secretaryMessage },
    ]);
    expect(mockTrackedCreate.mock.calls[1]?.[1].messages).toEqual([
      { role: 'user', content: secretaryMessage },
      ...currentToolConversation,
    ]);
  });

  it('preserves saved Content context and tools when current-turn-only is false', async () => {
    const options = {
      filteredTools: [savedDataTool],
      userId: 306,
      tenantId: 901,
      currentTurnOnly: false,
    };

    await callDomain('content', savedHistory, currentMessage, savedState, options);
    await continueWithToolResults(
      'content',
      savedHistory,
      currentMessage,
      savedState,
      currentToolConversation,
      undefined,
      options,
    );

    expect(mockBuildKnowledgePromptBlock).toHaveBeenNthCalledWith(1, 306, 901);
    expect(mockBuildKnowledgePromptBlock).toHaveBeenNthCalledWith(2, 306, 901);
    expect(mockTrackedCreate).toHaveBeenCalledTimes(2);
    for (const [, request] of mockTrackedCreate.mock.calls) {
      expect(JSON.stringify(request.system)).toContain(savedKnowledge.trim());
      expect(JSON.stringify(request.messages)).toContain('PRIVATE_SAVED_USER_HISTORY');
      expect(JSON.stringify(request.messages)).toContain(savedState);
      expect(request.tools).toEqual([savedDataTool]);
    }
  });
});

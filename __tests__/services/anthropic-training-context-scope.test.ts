import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadTrainingContextAll = vi.fn();
const mockTrackedCreate = vi.fn();
const mockBuildKnowledgePromptBlock = vi.fn();

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

vi.mock('../../src/state/content-references', () => ({
  buildKnowledgePromptBlock: (...args: unknown[]) => mockBuildKnowledgePromptBlock(...args),
}));

import {
  callDomain,
  callStructuredGeneration,
  continueWithToolResults,
} from '../../src/services/anthropic';

describe('Anthropic training-context tenant scope', () => {
  beforeEach(() => {
    mockReadTrainingContextAll.mockReset();
    mockReadTrainingContextAll.mockReturnValue({ signals: [{ type: 'session_load' }] });
    mockTrackedCreate.mockReset();
    mockBuildKnowledgePromptBlock.mockReset();
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
});

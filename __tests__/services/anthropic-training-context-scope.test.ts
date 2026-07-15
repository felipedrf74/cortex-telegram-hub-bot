import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadTrainingContextAll = vi.fn();
const mockTrackedCreate = vi.fn();

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

import { callDomain, continueWithToolResults } from '../../src/services/anthropic';

describe('Anthropic training-context tenant scope', () => {
  beforeEach(() => {
    mockReadTrainingContextAll.mockReset();
    mockReadTrainingContextAll.mockReturnValue({ signals: [{ type: 'session_load' }] });
    mockTrackedCreate.mockReset();
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
});

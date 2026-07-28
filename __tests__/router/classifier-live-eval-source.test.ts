import { describe, expect, it, vi } from 'vitest';

import {
  CHAT_LIVE_EVAL_CONTRACT_VERSION,
  CHAT_LIVE_EVAL_LOCAL_BUDGET,
  type ChatLiveEvalRequestContext,
} from '../../src/services/chat-live-evaluation-contract';
import { runWithChatLiveEvalContext } from '../../src/services/chat-live-evaluation-context';

const classify = vi.hoisted(() => vi.fn(async () => ({
  domain: 'content' as const,
  confidence: 0.91,
})));

vi.mock('../../src/services/provider-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/provider-registry')>(),
  getActiveProvider: () => ({ name: 'ollama', classify }),
}));

vi.mock('../../src/services/anthropic', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/anthropic')>(),
  classifyMessage: vi.fn(),
}));

vi.mock('../../src/services/classify-shadow', () => ({
  runOllamaShadowClassification: vi.fn(),
}));

import { classifyWithClaude } from '../../src/router/classifier';

const evalContext: ChatLiveEvalRequestContext = {
  version: CHAT_LIVE_EVAL_CONTRACT_VERSION,
  mode: 'local_engine',
  runId: 'chat-eval-classifier-source-test',
  scenarioId: 'content_creator_day',
  budget: CHAT_LIVE_EVAL_LOCAL_BUDGET,
  targetBaseCategory: 'chat_live_eval_local',
  providerPolicy: 'ollama_only_zero_cloud',
  userId: 42,
  tenantId: 42,
  productionDataUsed: false,
};

describe('classifier governed live-eval source', () => {
  it('uses the offline evaluation source only inside local_engine context', async () => {
    await runWithChatLiveEvalContext(evalContext, () => (
      classifyWithClaude('Give me launch content ideas', undefined, 42, 42)
    ));

    expect(classify).toHaveBeenCalledWith(
      'Give me launch content ideas',
      undefined,
      { userId: 42, tenantId: 42, source: 'evaluation' },
    );
  });
});

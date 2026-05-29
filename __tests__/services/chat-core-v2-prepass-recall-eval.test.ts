import { describe, expect, it } from 'vitest';

import {
  evaluatePrepassRecallAtK,
  evaluateGoldenCorpusPrepassRecallAtK,
} from '../../src/services/chat-core-v2/prepass-recall-eval';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SEED } from '../../src/services/chat-core-v2/golden-corpus-seed';

describe('Chat Core v2 prepass recall@k eval', () => {
  it('computes recall@k with an injected candidate producer and skips unlabeled items', () => {
    const produce = () => ['a', 'b', 'c'];
    const result = evaluatePrepassRecallAtK(
      [
        { message: 'hit', expectedCapabilityIds: ['b'] },
        { message: 'miss', expectedCapabilityIds: ['z'] },
        { message: 'unlabeled', expectedCapabilityIds: [] },
      ],
      8,
      produce,
    );

    expect(result.total).toBe(3);
    expect(result.scored).toBe(2); // the unlabeled item is excluded
    expect(result.hits).toBe(1);
    expect(result.recallAtK).toBe(0.5);
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0].expectedCapabilityIds).toEqual(['z']);
    expect(result.misses[0].candidateCapabilityIds).toEqual(['a', 'b', 'c']);
  });

  it('respects the top-k cutoff', () => {
    const produce = () => ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(
      evaluatePrepassRecallAtK([{ message: 'm', expectedCapabilityIds: ['i'] }], 8, produce).recallAtK,
    ).toBe(0); // 'i' is the 9th candidate, outside the top-8
    expect(
      evaluatePrepassRecallAtK([{ message: 'm', expectedCapabilityIds: ['i'] }], 9, produce).recallAtK,
    ).toBe(1);
  });

  it('surfaces a real Layer-1 prepass hit for a daily-read prompt via the default producer', () => {
    const result = evaluatePrepassRecallAtK(
      [{ message: 'what are my tasks today?', expectedCapabilityIds: ['tasks.today_summary'] }],
      8,
    );
    expect(result.hits).toBe(1);
    expect(result.recallAtK).toBe(1);
  });

  it('reports a bounded synthetic recall@8 baseline over the seed corpus (NOT the Phase 2 gate)', () => {
    const result = evaluateGoldenCorpusPrepassRecallAtK(CHAT_CORE_V2_GOLDEN_CORPUS_SEED, 8);

    expect(result.total).toBe(CHAT_CORE_V2_GOLDEN_CORPUS_SEED.items.length);
    expect(result.scored).toBeGreaterThan(0);
    expect(result.recallAtK).toBeGreaterThanOrEqual(0);
    expect(result.recallAtK).toBeLessThanOrEqual(1);
    expect(result.version).toBe('chat_core_v2_prepass_recall_eval@1.0.0');
    // The synthetic seed corpus is a baseline only; the Phase 2 gate requires a
    // peer-reviewed labeled corpus, so passing this test never implies the gate.
  });
});

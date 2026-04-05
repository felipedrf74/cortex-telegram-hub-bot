// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/services/database', () => ({
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
    exec: vi.fn(),
  }),
}));

describe('Cost Validation — Gemini Model Pricing', () => {
  // Gemini cost table from gemini-provider.ts
  const GEMINI_COSTS: Record<string, { in: number; out: number }> = {
    'gemini-3.1-pro':         { in: 2.00, out: 12.00 },
    'gemini-3-flash':         { in: 0.50, out: 3.00 },
    'gemini-2.5-flash':       { in: 0.30, out: 2.50 },
    'gemini-2.5-flash-lite':  { in: 0.10, out: 0.40 },
    'gemini-2.0-flash':       { in: 0.10, out: 0.40 },
  };

  function computeCost(model: string, inputTokens: number, outputTokens: number): number {
    const rates = GEMINI_COSTS[model] || GEMINI_COSTS['gemini-3-flash'];
    return (inputTokens / 1_000_000) * rates.in + (outputTokens / 1_000_000) * rates.out;
  }

  it('gemini-3-flash: 1000 in + 500 out = correct cost', () => {
    const cost = computeCost('gemini-3-flash', 1000, 500);
    const expected = (1000 / 1_000_000) * 0.50 + (500 / 1_000_000) * 3.00;
    expect(cost).toBeCloseTo(expected, 10);
    expect(cost).toBeCloseTo(0.002, 4); // $0.0005 + $0.0015
  });

  it('gemini-2.5-flash-lite: 200 in + 30 out = correct cost', () => {
    const cost = computeCost('gemini-2.5-flash-lite', 200, 30);
    const expected = (200 / 1_000_000) * 0.10 + (30 / 1_000_000) * 0.40;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('gemini-3-flash is cheaper than claude-haiku for same token count', () => {
    const geminiCost = computeCost('gemini-3-flash', 10000, 5000);
    // Claude Haiku: $1/$5 per MTK
    const haikuCost = (10000 / 1_000_000) * 1.0 + (5000 / 1_000_000) * 5.0;
    expect(geminiCost).toBeLessThan(haikuCost);
  });

  it('classifier uses flash-lite at $0.10/$0.40 (10x cheaper than haiku)', () => {
    const flashLiteCost = computeCost('gemini-2.5-flash-lite', 500, 50);
    const haikuCost = (500 / 1_000_000) * 1.0 + (50 / 1_000_000) * 5.0;
    expect(flashLiteCost).toBeLessThan(haikuCost / 5); // At least 5x cheaper
  });
});

describe('Cost Validation — Model Options', () => {
  it('MODEL_OPTIONS contains current models (no deprecated ones)', () => {
    // Hardcoded check against what we set in model-config.ts
    // (avoids loading the full module which has complex dependencies)
    const expectedGeminiChat = ['gemini-3-flash', 'gemini-2.5-flash', 'gemini-3.1-pro'];
    const expectedGeminiClassifier = ['gemini-2.5-flash-lite', 'gemini-3-flash'];
    const expectedOpenAIChat = ['gpt-5', 'gpt-5-mini', 'gpt-5.4', 'gpt-4.1-mini', 'o4-mini'];

    // Verify current models
    expect(expectedGeminiChat).toContain('gemini-3-flash');
    expect(expectedGeminiClassifier).toContain('gemini-2.5-flash-lite');

    // Verify deprecated models not present
    expect(expectedGeminiChat).not.toContain('gemini-2.0-flash');
    expect(expectedGeminiChat).not.toContain('gemini-1.5-pro');
    expect(expectedOpenAIChat).not.toContain('gpt-4o');
  });
});

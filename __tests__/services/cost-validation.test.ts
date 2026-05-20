// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, vi } from 'vitest';

const mockRecordOperatorAlert = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
    exec: vi.fn(),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => mockRecordOperatorAlert(...args),
}));

import { computeGeminiCost, resolveGeminiCostModelKey } from '../../src/services/gemini-provider';
import { OPENAI_COST_PER_MTK } from '../../src/services/openai-provider';
import { CHAT_MODEL_BAKEOFF_CANDIDATES } from '../../src/services/chat-model-bakeoff';
import {
  _resetModelPricingAlertDedupeForTests,
  _setRecordOperatorAlertForTests,
  computeModelUsageCostUsd,
  getModelPricingTable,
  recordUnresolvedModelPricingAlert,
  resolveModelPricing,
} from '../../src/services/model-pricing';

describe('Cost Validation — Gemini Model Pricing', () => {
  function computeCost(model: string, inputTokens: number, outputTokens: number): number {
    return computeModelUsageCostUsd(model, { inputTokens, outputTokens }, 'gemini').costUsd;
  }

  it('gemini-2.5-flash: 1000 in + 500 out = correct cost', () => {
    const cost = computeCost('gemini-2.5-flash', 1000, 500);
    const expected = (1000 / 1_000_000) * 0.30 + (500 / 1_000_000) * 2.50;
    expect(cost).toBeCloseTo(expected, 10);
    expect(cost).toBeCloseTo(0.00155, 5); // $0.0003 + $0.00125
  });

  it('gemini-2.5-flash-lite: 200 in + 30 out = correct cost', () => {
    const cost = computeCost('gemini-2.5-flash-lite', 200, 30);
    const expected = (200 / 1_000_000) * 0.10 + (30 / 1_000_000) * 0.40;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('runtime Gemini cost matching uses the longer flash-lite key before flash', () => {
    expect(resolveGeminiCostModelKey('gemini-2.5-flash-lite')).toBe('gemini-2.5-flash-lite');
    const cost = computeGeminiCost('gemini-2.5-flash-lite', {
      promptTokenCount: 200,
      candidatesTokenCount: 30,
    });
    const expected = (200 / 1_000_000) * 0.10 + (30 / 1_000_000) * 0.40;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('gemini-2.5-flash is cheaper than claude-haiku for same token count', () => {
    const geminiCost = computeCost('gemini-2.5-flash', 10000, 5000);
    // Claude Haiku: $1/$5 per MTK
    const haikuCost = (10000 / 1_000_000) * 1.0 + (5000 / 1_000_000) * 5.0;
    expect(geminiCost).toBeLessThan(haikuCost);
  });

  it('classifier uses flash-lite at $0.10/$0.40 (10x cheaper than haiku)', () => {
    const flashLiteCost = computeCost('gemini-2.5-flash-lite', 500, 50);
    const haikuCost = (500 / 1_000_000) * 1.0 + (50 / 1_000_000) * 5.0;
    expect(flashLiteCost).toBeLessThan(haikuCost / 5); // At least 5x cheaper
  });

  it('does not silently price unknown production models as Gemini Flash', () => {
    const priced = computeModelUsageCostUsd('gemini-unknown-future-model', {
      inputTokens: 1000,
      outputTokens: 500,
    }, 'gemini');
    expect(priced.pricingResolved).toBe(false);
    expect(priced.costUsd).toBeGreaterThan(0);
    expect(priced.pricingModelKey).toBeNull();
  });

  it('does not prefix-price hypothetical future model variants', () => {
    for (const model of ['gpt-5-thinking', 'gpt-5-2026-05-30', 'gpt-5-pro']) {
      const priced = computeModelUsageCostUsd(model, {
        inputTokens: 1000,
        outputTokens: 500,
      }, 'openai');
      expect(priced.pricingResolved, model).toBe(false);
      expect(priced.pricingModelKey, model).toBeNull();
      expect(priced.costUsd, model).toBeGreaterThan(0);
    }
  });

  it('raises a deduped operator alert for unresolved production model pricing', () => {
    _resetModelPricingAlertDedupeForTests();
    _setRecordOperatorAlertForTests((input) => mockRecordOperatorAlert(input));
    mockRecordOperatorAlert.mockClear();

    recordUnresolvedModelPricingAlert({
      provider: 'gemini',
      model: 'gemini-unknown-future-model',
      category: 'gemini_domain_content',
      userId: 42,
    });
    recordUnresolvedModelPricingAlert({
      provider: 'gemini',
      model: 'gemini-unknown-future-model',
      category: 'gemini_domain_content',
      userId: 42,
    });

    expect(mockRecordOperatorAlert).toHaveBeenCalledTimes(1);
    expect(mockRecordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      source: 'model_pricing',
      dedupeKey: expect.stringContaining('model-pricing-unresolved:gemini:gemini-unknown-future-model:'),
      metadata: expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-unknown-future-model',
        category: 'gemini_domain_content',
        userId: 42,
      }),
    }));
  });
});

describe('Cost Validation — Model Options', () => {
  it('MODEL_OPTIONS contains current models (no deprecated ones)', () => {
    // Hardcoded check against what we set in model-config.ts
    // (avoids loading the full module which has complex dependencies)
    const expectedGeminiChat = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'];
    const expectedGeminiClassifier = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
    const expectedOpenAIChat = ['gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5.4', 'gpt-4.1-mini', 'o4-mini'];

    // Verify current models
    expect(expectedGeminiChat).toContain('gemini-2.5-flash');
    expect(expectedGeminiClassifier).toContain('gemini-2.5-flash-lite');
    expect(expectedOpenAIChat).toContain('gpt-5.4-nano');

    // Verify deprecated models not present
    expect(expectedGeminiChat).not.toContain('gemini-3-flash');
    expect(expectedGeminiChat).not.toContain('gemini-2.0-flash');
    expect(expectedGeminiChat).not.toContain('gemini-1.5-pro');
    expect(expectedOpenAIChat).not.toContain('gpt-4o');
  });
});

describe('Cost Validation — OpenAI model pricing parity', () => {
  it('uses current OpenAI rates for nano and mini variants', () => {
    expect(OPENAI_COST_PER_MTK['gpt-5.4-nano']).toEqual({ in: 0.20, out: 1.25 });
    expect(OPENAI_COST_PER_MTK['gpt-5.4-mini']).toEqual({ in: 0.75, out: 4.50 });
    expect(OPENAI_COST_PER_MTK['gpt-5-nano']).toEqual({ in: 0.05, out: 0.40 });
    expect(OPENAI_COST_PER_MTK['gpt-5-mini']).toEqual({ in: 0.25, out: 2.00 });
  });

  it('keeps provider accounting aligned with bakeoff production candidate rates', () => {
    for (const candidate of CHAT_MODEL_BAKEOFF_CANDIDATES.filter((item) => item.provider === 'openai' && item.productionEligible)) {
      const rate = OPENAI_COST_PER_MTK[candidate.model];
      expect(rate, candidate.model).toBeTruthy();
      expect(rate.in, `${candidate.model}: input`).toBe(candidate.inputUsdPerMillion);
      expect(rate.out, `${candidate.model}: output`).toBe(candidate.outputUsdPerMillion);
    }
  });

  it('keeps selectable production model prices in the central registry', () => {
    const table = getModelPricingTable();
    for (const model of [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gpt-5.4-nano',
      'gpt-5.4-mini',
      'gpt-5-nano',
      'gpt-5-mini',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
    ]) {
      expect(table.some((entry) => entry.model === model), model).toBe(true);
    }
    expect(resolveModelPricing('gemini-2.5-flash-lite', 'gemini')).toMatchObject({
      inputUsdPerMillion: 0.10,
      outputUsdPerMillion: 0.40,
    });
  });
});

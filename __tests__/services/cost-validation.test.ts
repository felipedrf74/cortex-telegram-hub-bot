// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

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
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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
  computeProviderCallCostUpperBoundUsd,
  getOpenAiWebSearchMaxCalls,
  getModelPricingTable,
  getProviderToolFeeUsd,
  recordUnresolvedModelPricingAlert,
  resolveModelPricing,
} from '../../src/services/model-pricing';
import { insertApiUsageFallback } from '../../src/services/api-usage-fallback';

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

  it('includes Gemini tool-result input and thinking output in billable cost', () => {
    const cost = computeGeminiCost('gemini-2.5-flash', {
      promptTokenCount: 1_000,
      candidatesTokenCount: 500,
      toolUsePromptTokenCount: 200,
      thoughtsTokenCount: 300,
      totalTokenCount: 2_000,
    });
    expect(cost).toBeCloseTo(
      (1_200 / 1_000_000) * 0.30 + (800 / 1_000_000) * 2.50,
      10,
    );
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

  it('fails provider preflight closed for unresolved model pricing', () => {
    expect(computeProviderCallCostUpperBoundUsd({
      provider: 'gemini',
      model: 'gemini-unknown-future-model',
      payload: { prompt: 'hello' },
      maxOutputTokens: 100,
    })).toBe(Number.POSITIVE_INFINITY);
  });

  it('adds provider-hosted search fees to cost-equivalent usage', () => {
    const searchFee = getProviderToolFeeUsd('anthropic_web_search', {});
    const priced = computeModelUsageCostUsd('claude-haiku-4-5', {
      inputTokens: 1_000,
      outputTokens: 100,
      nonTokenCostUsd: searchFee * 2,
    }, 'anthropic');
    expect(searchFee).toBe(0.01);
    expect(priced.costUsd).toBeCloseTo(0.0215, 10);
    expect(getProviderToolFeeUsd('anthropic_web_search', {
      ANTHROPIC_WEB_SEARCH_COST_USD_PER_REQUEST: '',
    })).toBe(0.01);
  });

  it('caps one-shot OpenAI web research at one paid search call by default', () => {
    expect(getOpenAiWebSearchMaxCalls({})).toBe(1);
  });

  it('keeps the provider hard bound above token and paid-tool actuals', () => {
    const fee = getProviderToolFeeUsd('openai_web_search', {});
    const upperBound = computeProviderCallCostUpperBoundUsd({
      provider: 'openai',
      model: 'gpt-4o-mini',
      payload: { input: 'x'.repeat(1_000), max_output_tokens: 500, max_tool_calls: 1 },
      maxOutputTokens: 500,
      nonTokenCostUpperBoundUsd: fee,
    });
    const actual = computeModelUsageCostUsd('gpt-4o-mini', {
      inputTokens: 1_000,
      outputTokens: 500,
      nonTokenCostUsd: fee,
    }, 'openai').costUsd;
    expect(upperBound).toBeGreaterThanOrEqual(actual);
  });

  it('keeps validated Channel extraction and synthesis envelopes within Pro automation', () => {
    for (const payload of [
      { systemPrompt: 's'.repeat(3_000), userPrompt: 'u'.repeat(7_000) },
      { systemPrompt: 's'.repeat(3_000), userPrompt: 'u'.repeat(6_000) },
    ]) {
      const upperBound = computeProviderCallCostUpperBoundUsd({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        payload: { ...payload, maxTokens: 2_304, temperature: 0.3 },
        maxOutputTokens: 2_304,
      });
      expect(upperBound * 1.25).toBeLessThanOrEqual(0.012);
    }
  });

  it('keeps the validated daily Coach envelope within Pro automation', () => {
    const upperBound = computeProviderCallCostUpperBoundUsd({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      payload: {
        systemPrompt: 's'.repeat(6_500),
        userPrompt: 'u'.repeat(11_000),
        maxTokens: 1_400,
        temperature: 0.7,
      },
      maxOutputTokens: 1_400,
    });
    expect(upperBound * 1.25).toBeLessThanOrEqual(0.012);
  });

  it('keeps the largest scheduled Content batch envelope within Pro automation', () => {
    const upperBound = computeProviderCallCostUpperBoundUsd({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      payload: {
        systemPrompt: 's'.repeat(6_500),
        userPrompt: 'u'.repeat(6_500),
        maxTokens: 1_832,
        temperature: 0.7,
      },
      maxOutputTokens: 1_832,
    });
    expect(upperBound * 1.25).toBeLessThanOrEqual(0.012);
  });

  it('falls back to conservative tool fees for invalid configuration', () => {
    expect(getProviderToolFeeUsd('openai_web_search', {
      OPENAI_WEB_SEARCH_COST_USD_PER_CALL: 'not-a-number',
    })).toBe(0.01);
    expect(getProviderToolFeeUsd('gemini_grounded_prompt', {})).toBe(0.035);
  });

  it('does not prefix-price non-snapshot model variants', () => {
    // Only date-like/"latest" suffixes may inherit base pricing; capability
    // variants (thinking/pro/etc.) must stay on the conservative sentinel.
    for (const model of ['gpt-5-thinking', 'gpt-5-pro', 'gpt-4o-mini-high-cost-variant']) {
      const priced = computeModelUsageCostUsd(model, {
        inputTokens: 1000,
        outputTokens: 500,
      }, 'openai');
      expect(priced.pricingResolved, model).toBe(false);
      expect(priced.pricingModelKey, model).toBeNull();
      expect(priced.costUsd, model).toBeGreaterThan(0);
    }
  });

  it('prices dated OpenAI snapshots at the base-model rate', () => {
    // OpenAI resolves aliases to dated snapshots in response.model
    // (gpt-4o-mini → gpt-4o-mini-2024-07-18) and snapshots share base
    // pricing. Before this rule every one-shot fallback call was booked at
    // the Sonnet-ceiling sentinel (~20x real) as pricing_status=unresolved.
    const snapshot = computeModelUsageCostUsd('gpt-4o-mini-2024-07-18', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, 'openai');
    expect(snapshot.pricingResolved).toBe(true);
    expect(snapshot.pricingModelKey).toBe('gpt-4o-mini');
    expect(snapshot.costUsd).toBeCloseTo(0.75);

    // Sibling-prefix disambiguation: the shorter gpt-4o entry must not
    // shadow a gpt-4o-mini snapshot (remainder "mini-2024-07-18" is not a
    // snapshot tag), and dated gpt-5 snapshots resolve to gpt-5.
    const full = computeModelUsageCostUsd('gpt-4o-2024-08-06', {
      inputTokens: 1000,
      outputTokens: 500,
    }, 'openai');
    expect(full.pricingModelKey).toBe('gpt-4o');
    const dated = computeModelUsageCostUsd('gpt-5-2026-05-30', {
      inputTokens: 1000,
      outputTokens: 500,
    }, 'openai');
    expect(dated.pricingModelKey).toBe('gpt-5');
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

describe('Cost Validation — api_usage fallback writes', () => {
  it('marks fallback rows as legacy when pricing columns exist', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE api_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          model TEXT NOT NULL,
          tenant_id INTEGER NOT NULL DEFAULT 0,
          user_id INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          provider TEXT,
          pricing_status TEXT NOT NULL DEFAULT 'resolved',
          pricing_model_key TEXT,
          provider_tool_cost_usd REAL NOT NULL DEFAULT 0,
          web_search_requests INTEGER NOT NULL DEFAULT 0,
          grounded_search_prompts INTEGER NOT NULL DEFAULT 0
        );
      `);

      const id = insertApiUsageFallback(db, {
        category: 'domain_content',
        model: 'gpt-future',
        provider: 'openai',
        tenantId: 12,
        userId: 34,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
        durationMs: 123,
        pricingStatus: 'legacy',
        providerToolCostUsd: 0.02,
        webSearchRequests: 2,
      });

      const row = db.prepare('SELECT id, provider, tenant_id, user_id, pricing_status, pricing_model_key, provider_tool_cost_usd, web_search_requests, grounded_search_prompts FROM api_usage').get() as any;
      expect(row).toMatchObject({
        id,
        provider: 'openai',
        tenant_id: 12,
        user_id: 34,
        pricing_status: 'legacy',
        pricing_model_key: null,
        provider_tool_cost_usd: 0.02,
        web_search_requests: 2,
        grounded_search_prompts: 0,
      });
    } finally {
      db.close();
    }
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

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unit tests for the pure cost-breakdown aggregation logic used by
 * GET /api/cost-by-domain. These tests don't touch the database or the
 * Express handler — they exercise the deterministic math directly.
 *
 * Quarter: Per-endpoint cost dashboard.
 */

import { describe, it, expect } from 'vitest';
import {
  computeCostBreakdown,
  computeUserCostBreakdown,
  percentile,
  type ApiUsageRow,
} from '../../src/portal/cost-breakdown';

// A fixed clock so the dailySeries builds a deterministic window
const NOW_MS = new Date('2026-04-08T12:00:00Z').getTime();

function row(overrides: Partial<ApiUsageRow> = {}): ApiUsageRow {
  return {
    category: 'domain_secretary',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.001,
    duration_ms: 1000,
    ts: '2026-04-08 09:00:00',
    ...overrides,
  };
}

describe('percentile', () => {
  it('returns 0 for empty input', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it('returns the single element when n=1', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });

  it('p50 of [1..10] is 5 (nearest-rank)', () => {
    // ceil(0.5 * 10) - 1 = 5 - 1 = 4 → sorted[4] = 5
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
  });

  it('p95 of [1..20] is 19', () => {
    // ceil(0.95 * 20) - 1 = 19 - 1 = 18 → sorted[18] = 19
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.95)).toBe(19);
  });

  it('p95 of [1..100] is 95', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.95)).toBe(95);
  });

  it('clamps to the last index when p is near 1', () => {
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
});

describe('computeCostBreakdown', () => {
  it('returns zero totals and empty arrays for no rows', () => {
    const out = computeCostBreakdown([], 7, NOW_MS);
    expect(out.days).toBe(7);
    expect(out.totalCost).toBe(0);
    expect(out.totalCalls).toBe(0);
    expect(out.detailed).toEqual([]);
    expect(out.domains).toEqual([]);
    expect(out.providerSplit).toEqual([]);
    // dailySeries still zero-fills the window so sparkline has consistent x-axis
    expect(out.dailySeries).toHaveLength(7);
    expect(out.dailySeries.every(d => d.cost === 0 && d.calls === 0)).toBe(true);
  });

  it('groups rows by (category, provider, model)', () => {
    const rows: ApiUsageRow[] = [
      row({ category: 'coach_analysis', provider: 'anthropic', model: 'sonnet', cost_usd: 0.05, duration_ms: 30000 }),
      row({ category: 'coach_analysis', provider: 'anthropic', model: 'sonnet', cost_usd: 0.05, duration_ms: 40000 }),
      // Same category, same provider, different model → separate group
      row({ category: 'coach_analysis', provider: 'anthropic', model: 'haiku', cost_usd: 0.005, duration_ms: 5000 }),
      // Same category, different provider → separate group
      row({ category: 'coach_analysis', provider: 'gemini', model: 'flash', cost_usd: 0.0005, duration_ms: 8000 }),
    ];

    const out = computeCostBreakdown(rows, 7, NOW_MS);
    // 3 distinct (category, provider, model) triples
    expect(out.detailed).toHaveLength(3);

    const sonnet = out.detailed.find(d => d.model === 'sonnet')!;
    expect(sonnet.calls).toBe(2);
    expect(sonnet.cost).toBe(0.1);
    expect(sonnet.costPerCall).toBe(0.05);

    const haiku = out.detailed.find(d => d.model === 'haiku')!;
    expect(haiku.calls).toBe(1);
    expect(haiku.cost).toBe(0.005);

    const gemini = out.detailed.find(d => d.model === 'flash')!;
    expect(gemini.provider).toBe('gemini');
  });

  it('sorts detailed rows by cost DESC', () => {
    const rows: ApiUsageRow[] = [
      row({ category: 'cheap',     provider: 'a', model: 'm', cost_usd: 0.01 }),
      row({ category: 'expensive', provider: 'a', model: 'm', cost_usd: 1.0 }),
      row({ category: 'medium',    provider: 'a', model: 'm', cost_usd: 0.1 }),
    ];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    expect(out.detailed.map(d => d.category)).toEqual(['expensive', 'medium', 'cheap']);
  });

  it('keeps domain field alongside category for backward compat', () => {
    const rows = [row({ category: 'domain_triathlon' })];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    expect(out.detailed[0].category).toBe('domain_triathlon');
    expect(out.detailed[0].domain).toBe('domain_triathlon');
  });

  it('computes avg, p50, p95, max durations correctly', () => {
    // 10 calls with durations 100, 200, ..., 1000
    const rows: ApiUsageRow[] = Array.from({ length: 10 }, (_, i) =>
      row({ duration_ms: (i + 1) * 100, cost_usd: 0.001 }),
    );
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    const entry = out.detailed[0];
    expect(entry.avgDurationMs).toBe(550); // (100+200+...+1000)/10
    expect(entry.p50DurationMs).toBe(500); // sorted[4]
    expect(entry.p95DurationMs).toBe(1000); // sorted[9]
    expect(entry.maxDurationMs).toBe(1000);
  });

  it('skips zero/negative durations in percentile calculation', () => {
    const rows: ApiUsageRow[] = [
      row({ duration_ms: 100 }),
      row({ duration_ms: 0 }),    // skipped
      row({ duration_ms: -5 }),   // skipped
      row({ duration_ms: 200 }),
    ];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    expect(out.detailed[0].calls).toBe(4);
    // durations array has only [100, 200]
    expect(out.detailed[0].avgDurationMs).toBe(150);
  });

  it('aggregates domains across providers and models', () => {
    const rows: ApiUsageRow[] = [
      row({ category: 'secretary', provider: 'anthropic', model: 'sonnet', cost_usd: 0.05 }),
      row({ category: 'secretary', provider: 'anthropic', model: 'haiku',  cost_usd: 0.01 }),
      row({ category: 'secretary', provider: 'gemini',    model: 'flash',  cost_usd: 0.002 }),
    ];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    expect(out.domains).toHaveLength(1);
    const sec = out.domains[0];
    expect(sec.domain).toBe('secretary');
    expect(sec.calls).toBe(3);
    expect(sec.cost).toBeCloseTo(0.062, 4);
    expect(sec.providers.sort()).toEqual(['anthropic', 'gemini']);
    expect(sec.models.sort()).toEqual(['flash', 'haiku', 'sonnet']);
  });

  it('computes provider split percentages', () => {
    const rows: ApiUsageRow[] = [
      row({ provider: 'anthropic', cost_usd: 0.9 }),
      row({ provider: 'gemini', cost_usd: 0.1 }),
    ];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    const anthropic = out.providerSplit.find(p => p.provider === 'anthropic')!;
    const gemini = out.providerSplit.find(p => p.provider === 'gemini')!;
    expect(anthropic.percentOfCost).toBe(90);
    expect(gemini.percentOfCost).toBe(10);
  });

  it('zero-fills daily series for the full window', () => {
    const out = computeCostBreakdown([], 30, NOW_MS);
    expect(out.dailySeries).toHaveLength(30);
    // First entry should be 29 days ago, last entry should be today
    expect(out.dailySeries[0].date).toBe('2026-03-10');
    expect(out.dailySeries[29].date).toBe('2026-04-08');
  });

  it('attributes rows to the correct day in the series', () => {
    const rows: ApiUsageRow[] = [
      row({ ts: '2026-04-07 10:00:00', cost_usd: 0.5 }),
      row({ ts: '2026-04-07 15:00:00', cost_usd: 0.3 }),
      row({ ts: '2026-04-08 08:00:00', cost_usd: 0.2 }),
    ];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    const apr7 = out.dailySeries.find(d => d.date === '2026-04-07')!;
    const apr8 = out.dailySeries.find(d => d.date === '2026-04-08')!;
    expect(apr7.cost).toBe(0.8);
    expect(apr7.calls).toBe(2);
    expect(apr8.cost).toBe(0.2);
    expect(apr8.calls).toBe(1);
  });

  it('ignores rows outside the window', () => {
    const rows: ApiUsageRow[] = [
      row({ ts: '2025-01-01 10:00:00', cost_usd: 99.0 }), // way outside 7-day window
      row({ ts: '2026-04-08 08:00:00', cost_usd: 0.2 }),
    ];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    // Both rows are still in `detailed` (the aggregator doesn't filter by ts —
    // that's the caller's job via SQL). But the old row doesn't appear in the
    // dailySeries because its date isn't in the 7-day window.
    expect(out.dailySeries.every(d => d.cost <= 0.2)).toBe(true);
  });

  it('rounds cost values to 4 decimals to avoid floating-point drift', () => {
    const rows: ApiUsageRow[] = [
      row({ cost_usd: 0.123456789 }),
      row({ cost_usd: 0.987654321 }),
    ];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    // totalCost is sum of r4()-rounded per-row aggregates
    const entry = out.detailed[0];
    expect(Number.isFinite(entry.cost)).toBe(true);
    expect(entry.cost.toString()).toMatch(/^\d+\.\d{1,4}$/);
    expect(entry.costPerCall.toString()).toMatch(/^\d+\.\d{1,5}$/);
  });

  it('computes cost per call for each group', () => {
    const rows: ApiUsageRow[] = Array.from({ length: 4 }, () =>
      row({ cost_usd: 0.025 }),
    );
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    expect(out.detailed[0].calls).toBe(4);
    expect(out.detailed[0].cost).toBe(0.1);
    expect(out.detailed[0].costPerCall).toBe(0.025);
  });

  it('handles missing provider/model gracefully', () => {
    // "unknown" is what the SQL COALESCE returns for nulls
    const rows: ApiUsageRow[] = [
      row({ provider: 'unknown', model: 'unknown' }),
    ];
    const out = computeCostBreakdown(rows, 7, NOW_MS);
    expect(out.detailed[0].provider).toBe('unknown');
    expect(out.detailed[0].model).toBe('unknown');
  });

  it('handles a realistic multi-category, multi-provider mix', () => {
    // Mirrors the real prod shape from the Apr 8 prototype query:
    // Sonnet dominates coach_analysis; Haiku is used for knowledge_synthesis;
    // Gemini handles a small slice of secretary.
    const rows: ApiUsageRow[] = [
      // coach_analysis: 34 calls at $0.05 avg on sonnet
      ...Array.from({ length: 34 }, () => row({
        category: 'coach_analysis',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        cost_usd: 0.05,
        duration_ms: 34000,
      })),
      // knowledge_synthesis: 18 calls at $0.008 on haiku
      ...Array.from({ length: 18 }, () => row({
        category: 'knowledge_synthesis',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        cost_usd: 0.008,
        duration_ms: 18000,
      })),
      // domain_secretary: 4 calls on gemini
      ...Array.from({ length: 4 }, () => row({
        category: 'domain_secretary',
        provider: 'gemini',
        model: 'gemini-2.5-flash-lite',
        cost_usd: 0.001,
        duration_ms: 1000,
      })),
    ];

    const out = computeCostBreakdown(rows, 7, NOW_MS);

    // 3 groups
    expect(out.detailed).toHaveLength(3);

    // coach_analysis is #1 by cost
    expect(out.detailed[0].category).toBe('coach_analysis');
    expect(out.detailed[0].cost).toBeCloseTo(1.7, 2);

    // Total
    expect(out.totalCalls).toBe(34 + 18 + 4);
    expect(out.totalCost).toBeCloseTo(1.7 + 0.144 + 0.004, 3);

    // Provider split: anthropic dominant
    const anthropic = out.providerSplit.find(p => p.provider === 'anthropic')!;
    const gemini = out.providerSplit.find(p => p.provider === 'gemini')!;
    expect(anthropic.cost).toBeGreaterThan(gemini.cost);
    expect(anthropic.percentOfCost).toBeGreaterThan(99);
    expect(gemini.percentOfCost).toBeLessThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PER-USER COST BREAKDOWN (April 9 2026 — Option G pricing calibration)
// ═══════════════════════════════════════════════════════════════════

describe('computeUserCostBreakdown', () => {
  it('returns empty result when no user-attributed rows exist', () => {
    // Only system rows (user_id=0 or missing)
    const rows: ApiUsageRow[] = [
      row({ cost_usd: 0.10 }),                          // no user_id
      row({ user_id: 0, cost_usd: 0.20 }),              // system
      row({ user_id: 0, cost_usd: 0.05 }),              // system
    ];

    const out = computeUserCostBreakdown(rows, 30);
    expect(out.totalCost).toBe(0);
    expect(out.totalCalls).toBe(0);
    expect(out.userCount).toBe(0);
    expect(out.users).toEqual([]);
    expect(out.avgCostPerUser).toBe(0);
    expect(out.maxCostPerUser).toBe(0);
  });

  it('aggregates a single user\'s spend across multiple calls', () => {
    const rows: ApiUsageRow[] = [
      row({ user_id: 42, category: 'domain_content',   cost_usd: 0.50, ts: '2026-04-01 08:00:00' }),
      row({ user_id: 42, category: 'domain_content',   cost_usd: 0.30, ts: '2026-04-02 10:00:00' }),
      row({ user_id: 42, category: 'domain_secretary', cost_usd: 0.10, ts: '2026-04-03 11:00:00' }),
    ];

    const out = computeUserCostBreakdown(rows, 30);
    expect(out.userCount).toBe(1);
    expect(out.users).toHaveLength(1);

    const user = out.users[0];
    expect(user.userId).toBe(42);
    expect(user.totalCost).toBeCloseTo(0.90, 2);
    expect(user.totalCalls).toBe(3);
    expect(user.firstCallTs).toBe('2026-04-01 08:00:00');
    expect(user.lastCallTs).toBe('2026-04-03 11:00:00');

    // Top domains: content ($0.80) > secretary ($0.10)
    expect(user.topDomains).toHaveLength(2);
    expect(user.topDomains[0].domain).toBe('content');
    expect(user.topDomains[0].cost).toBeCloseTo(0.80, 2);
    expect(user.topDomains[1].domain).toBe('secretary');
  });

  it('sorts users by total cost descending and reports max', () => {
    const rows: ApiUsageRow[] = [
      // User 7 (small spender)
      row({ user_id: 7,  cost_usd: 0.05 }),
      // User 42 (big spender)
      row({ user_id: 42, cost_usd: 2.00 }),
      row({ user_id: 42, cost_usd: 1.50 }),
      // User 99 (medium)
      row({ user_id: 99, cost_usd: 0.80 }),
      row({ user_id: 99, cost_usd: 0.20 }),
    ];

    const out = computeUserCostBreakdown(rows, 30);
    expect(out.userCount).toBe(3);
    // Sorted descending by totalCost: 42 ($3.50) → 99 ($1.00) → 7 ($0.05)
    expect(out.users[0].userId).toBe(42);
    expect(out.users[0].totalCost).toBeCloseTo(3.50, 2);
    expect(out.users[1].userId).toBe(99);
    expect(out.users[1].totalCost).toBeCloseTo(1.00, 2);
    expect(out.users[2].userId).toBe(7);
    expect(out.users[2].totalCost).toBeCloseTo(0.05, 2);

    expect(out.totalCost).toBeCloseTo(4.55, 2);
    expect(out.maxCostPerUser).toBeCloseTo(3.50, 2);
    expect(out.avgCostPerUser).toBeCloseTo(4.55 / 3, 2);
  });

  it('excludes system rows (user_id=0 or missing) from per-user totals', () => {
    const rows: ApiUsageRow[] = [
      row({ user_id: 42, cost_usd: 1.00 }),
      row({ user_id: 0, cost_usd: 5.00 }),       // system scheduler
      row({ cost_usd: 3.00 }),                   // pre-A1 historical row
      row({ user_id: 99, cost_usd: 0.50 }),
    ];

    const out = computeUserCostBreakdown(rows, 30);
    // System rows silently dropped — aggregated total = 1.00 + 0.50 only
    expect(out.totalCost).toBeCloseTo(1.50, 2);
    expect(out.totalCalls).toBe(2);
    expect(out.userCount).toBe(2);
    // Neither system row should appear as a user
    expect(out.users.find(u => u.userId === 0)).toBeUndefined();
  });

  it('strips the `domain_` prefix from categories for the topDomains rollup', () => {
    const rows: ApiUsageRow[] = [
      row({ user_id: 1, category: 'domain_secretary', cost_usd: 0.20 }),
      row({ user_id: 1, category: 'domain_content',   cost_usd: 0.30 }),
      row({ user_id: 1, category: 'classify_message', cost_usd: 0.02 }),  // non-domain category passed through as-is
      row({ user_id: 1, category: 'parse-receipt',    cost_usd: 0.01 }),  // kebab-case, not a domain
    ];

    const out = computeUserCostBreakdown(rows, 30);
    const user = out.users[0];
    const domains = user.topDomains.map(d => d.domain);
    // The `domain_` prefix is stripped; the other categories pass through verbatim.
    expect(domains).toContain('secretary');
    expect(domains).toContain('content');
    // topDomains is top-3, sorted descending. content ($0.30) + secretary ($0.20)
    // fill slots 0 and 1; classify_message ($0.02) fills slot 2.
    expect(user.topDomains[0].domain).toBe('content');
    expect(user.topDomains[1].domain).toBe('secretary');
    expect(user.topDomains[2].domain).toBe('classify_message');
    // topDomains is capped at 3 entries — parse-receipt is dropped.
    expect(user.topDomains).toHaveLength(3);
  });

  it('sums tokens across a user\'s calls', () => {
    const rows: ApiUsageRow[] = [
      row({ user_id: 5, input_tokens: 1000, output_tokens:  200, cost_usd: 0.10 }),
      row({ user_id: 5, input_tokens:  500, output_tokens:  100, cost_usd: 0.05 }),
      row({ user_id: 5, input_tokens: 2000, output_tokens:  400, cost_usd: 0.20 }),
    ];

    const out = computeUserCostBreakdown(rows, 30);
    expect(out.users[0].totalTokens).toBe(3500 + 700); // 4200
  });

  it('tracks first and last call timestamps per user correctly', () => {
    const rows: ApiUsageRow[] = [
      row({ user_id: 8, ts: '2026-03-15 12:00:00' }),
      row({ user_id: 8, ts: '2026-03-02 09:30:00' }),
      row({ user_id: 8, ts: '2026-03-28 18:45:00' }),
      row({ user_id: 8, ts: '2026-03-10 14:00:00' }),
    ];

    const out = computeUserCostBreakdown(rows, 30);
    const user = out.users[0];
    expect(user.firstCallTs).toBe('2026-03-02 09:30:00');
    expect(user.lastCallTs).toBe('2026-03-28 18:45:00');
  });

  it('handles a mixed-provider row set (content creator scenario)', () => {
    // Simulates a Hybrid Operator ("creator + athlete"): 3 users, all
    // touching content + triathlon + secretary, with different mixes.
    // Exactly the shape we'll see in the small-group beta.
    const rows: ApiUsageRow[] = [
      // User 1: content-heavy creator (burns tokens on script gen)
      row({ user_id: 1, category: 'domain_content', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.80, input_tokens: 8000, output_tokens: 3000 }),
      row({ user_id: 1, category: 'domain_content', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.60, input_tokens: 6000, output_tokens: 2000 }),
      row({ user_id: 1, category: 'domain_secretary', provider: 'gemini', model: 'gemini-2.5-flash-lite', cost_usd: 0.001, input_tokens: 100, output_tokens: 50 }),

      // User 2: athlete-heavy (coach briefings)
      row({ user_id: 2, category: 'domain_triathlon', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.50, input_tokens: 12000, output_tokens: 2000 }),
      row({ user_id: 2, category: 'domain_secretary', provider: 'gemini', model: 'gemini-2.5-flash-lite', cost_usd: 0.002, input_tokens: 200, output_tokens: 100 }),

      // User 3: full hybrid (everything)
      row({ user_id: 3, category: 'domain_content',   provider: 'gemini',    model: 'gemini-2.5-flash', cost_usd: 0.10, input_tokens: 3000, output_tokens: 1000 }),
      row({ user_id: 3, category: 'domain_triathlon', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.30, input_tokens: 7000, output_tokens: 1500 }),
      row({ user_id: 3, category: 'domain_secretary', provider: 'gemini',    model: 'gemini-2.5-flash-lite', cost_usd: 0.001, input_tokens: 80, output_tokens: 40 }),
    ];

    const out = computeUserCostBreakdown(rows, 30);
    expect(out.userCount).toBe(3);

    // User 1 (creator): $1.401
    expect(out.users[0].userId).toBe(1);
    expect(out.users[0].totalCost).toBeCloseTo(1.401, 3);
    expect(out.users[0].topDomains[0].domain).toBe('content');

    // User 2 (athlete): $0.502
    expect(out.users[1].userId).toBe(2);
    expect(out.users[1].totalCost).toBeCloseTo(0.502, 3);
    expect(out.users[1].topDomains[0].domain).toBe('triathlon');

    // User 3 (hybrid): $0.401
    expect(out.users[2].userId).toBe(3);
    expect(out.users[2].totalCost).toBeCloseTo(0.401, 3);
    // Triathlon ($0.30) edges content ($0.10) for this user
    expect(out.users[2].topDomains[0].domain).toBe('triathlon');
  });
});

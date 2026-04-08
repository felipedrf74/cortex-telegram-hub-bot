// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cost breakdown aggregation — pure functions extracted from the portal's
 * /api/cost-by-domain handler so they can be unit-tested without mocking
 * SQLite prepared statements.
 *
 * The handler in server.ts calls computeCostBreakdown(rawRows, days) with
 * the rows it loads from api_usage. All grouping, percentile calculation,
 * and daily-series filling happens here in memory.
 *
 * Why JS-side aggregation? SQLite has no percentile_cont and no window-
 * function percentile. The api_usage table is small (~20 rows/day) so
 * computing p95 in JS by sorting each group is free. If the table grows
 * past ~100K rows/day, revisit and move the aggregation back into SQL.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ApiUsageRow {
  category: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  ts: string; // ISO-ish "YYYY-MM-DD HH:MM:SS" from SQLite datetime('now')
}

export interface CostBreakdownEntry {
  // Keep the legacy "domain" field name alongside the new "category" field
  // for backward compat with the existing portal rendering code.
  domain: string;
  category: string;
  provider: string;
  model: string;
  calls: number;
  cost: number;
  costPerCall: number;
  tokens: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
}

export interface DomainSummary {
  domain: string;
  calls: number;
  cost: number;
  tokens: number;
  providers: string[];
  models: string[];
}

export interface ProviderSplitEntry {
  provider: string;
  calls: number;
  cost: number;
  percentOfCost: number;
}

export interface DailySeriesPoint {
  date: string; // YYYY-MM-DD
  cost: number;
  calls: number;
}

export interface CostBreakdown {
  days: number;
  totalCost: number;
  totalCalls: number;
  domains: DomainSummary[];
  detailed: CostBreakdownEntry[];
  providerSplit: ProviderSplitEntry[];
  dailySeries: DailySeriesPoint[];
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * percentile(p) — nearest-rank method. `sorted` must already be ascending.
 * Returns 0 for empty input, which is fine for our "no calls yet" case.
 *
 * We don't use linear interpolation (like percentile_cont does) because on
 * small samples (n < 40) interpolation introduces false precision — the
 * extra digits don't reflect real distribution, they're just averages of
 * two adjacent observed values. Nearest-rank returns an actual observed
 * value, which is what a dashboard consumer wants to see.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/**
 * Round to 4 decimal places — the cost values in api_usage go to ~8 decimals
 * (fractional cents), but 4 is enough precision for a portal display.
 * Using Math.round(x * 10000) / 10000 avoids toFixed's string conversion.
 */
function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Round to 5 decimal places — for costPerCall which can be < $0.001 and
 * would otherwise round to 0 at 4 places.
 */
function r5(n: number): number {
  return Math.round(n * 100000) / 100000;
}

// ── Main computation ──────────────────────────────────────────────

/**
 * Build a cost breakdown view from raw api_usage rows.
 *
 * @param rawRows  The rows loaded from api_usage for the requested window.
 * @param days     The window size in days (used for the dailySeries x-axis).
 * @param nowMs    Clock injection for tests. Defaults to Date.now() in prod.
 */
export function computeCostBreakdown(
  rawRows: ApiUsageRow[],
  days: number,
  nowMs: number = Date.now(),
): CostBreakdown {
  // ── Group by (category, provider, model) ────────────────────────
  type Group = {
    category: string;
    provider: string;
    model: string;
    calls: number;
    cost: number;
    tokens: number;
    durations: number[];
  };
  const groups = new Map<string, Group>();

  for (const r of rawRows) {
    const key = `${r.category}||${r.provider}||${r.model}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        category: r.category,
        provider: r.provider,
        model: r.model,
        calls: 0,
        cost: 0,
        tokens: 0,
        durations: [],
      };
      groups.set(key, g);
    }
    g.calls += 1;
    g.cost += r.cost_usd || 0;
    g.tokens += (r.input_tokens || 0) + (r.output_tokens || 0);
    if (typeof r.duration_ms === 'number' && r.duration_ms > 0) {
      g.durations.push(r.duration_ms);
    }
  }

  const detailed: CostBreakdownEntry[] = Array.from(groups.values()).map((g) => {
    const sorted = [...g.durations].sort((a, b) => a - b);
    const avg = sorted.length > 0
      ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length)
      : 0;
    return {
      domain: g.category,
      category: g.category,
      provider: g.provider,
      model: g.model,
      calls: g.calls,
      cost: r4(g.cost),
      costPerCall: g.calls > 0 ? r5(g.cost / g.calls) : 0,
      tokens: g.tokens,
      avgDurationMs: avg,
      p50DurationMs: percentile(sorted, 0.5),
      p95DurationMs: percentile(sorted, 0.95),
      maxDurationMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    };
  }).sort((a, b) => b.cost - a.cost);

  const totalCost = detailed.reduce((s, r) => s + r.cost, 0);
  const totalCalls = detailed.reduce((s, r) => s + r.calls, 0);

  // ── By-domain view (sum across providers + models) ──────────────
  const byDomainMap = new Map<string, {
    calls: number;
    cost: number;
    tokens: number;
    providers: Set<string>;
    models: Set<string>;
  }>();
  for (const r of detailed) {
    const existing = byDomainMap.get(r.domain) || {
      calls: 0,
      cost: 0,
      tokens: 0,
      providers: new Set<string>(),
      models: new Set<string>(),
    };
    existing.calls += r.calls;
    existing.cost += r.cost;
    existing.tokens += r.tokens;
    existing.providers.add(r.provider);
    existing.models.add(r.model);
    byDomainMap.set(r.domain, existing);
  }
  const domains: DomainSummary[] = Array.from(byDomainMap.entries())
    .map(([domain, stats]) => ({
      domain,
      calls: stats.calls,
      cost: r4(stats.cost),
      tokens: stats.tokens,
      providers: Array.from(stats.providers),
      models: Array.from(stats.models),
    }))
    .sort((a, b) => b.cost - a.cost);

  // ── Provider split (for "how's the Gemini migration going?") ────
  const byProviderMap = new Map<string, { calls: number; cost: number }>();
  for (const r of detailed) {
    const existing = byProviderMap.get(r.provider) || { calls: 0, cost: 0 };
    existing.calls += r.calls;
    existing.cost += r.cost;
    byProviderMap.set(r.provider, existing);
  }
  const providerSplit: ProviderSplitEntry[] = Array.from(byProviderMap.entries())
    .map(([provider, stats]) => ({
      provider,
      calls: stats.calls,
      cost: r4(stats.cost),
      percentOfCost: totalCost > 0 ? Math.round((stats.cost / totalCost) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  // ── Daily series (zero-filled for consistent sparkline x-axis) ──
  // We use UTC dates here because api_usage.ts is populated via SQLite's
  // datetime('now') which returns UTC. Mixing the client's local TZ with
  // UTC data would shift rows into the wrong day near midnight.
  const seriesMap = new Map<string, { cost: number; calls: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10);
    seriesMap.set(d, { cost: 0, calls: 0 });
  }
  for (const r of rawRows) {
    const day = r.ts.slice(0, 10);
    const existing = seriesMap.get(day);
    if (existing) {
      existing.cost += r.cost_usd || 0;
      existing.calls += 1;
    }
  }
  const dailySeries: DailySeriesPoint[] = Array.from(seriesMap.entries()).map(
    ([date, stats]) => ({
      date,
      cost: r4(stats.cost),
      calls: stats.calls,
    }),
  );

  return {
    days,
    totalCost: r4(totalCost),
    totalCalls,
    domains,
    detailed,
    providerSplit,
    dailySeries,
  };
}

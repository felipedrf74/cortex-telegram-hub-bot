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
  // April 9 2026: added for per-user cost attribution. Optional so
  // rows loaded by the existing `computeCostBreakdown` path (which
  // doesn't care about user_id) don't have to be re-typed. Rows
  // written pre-A1 fix (795aee2) have user_id=0 — filter them out
  // in `computeUserCostBreakdown` below.
  user_id?: number;
}

/**
 * Per-user cost snapshot returned by `computeUserCostBreakdown`.
 * Rolls up one user's total spend across the requested window,
 * plus their top 3 domains (by cost) so the admin portal can show
 * "user 42 spent $4.20: $2.10 content, $1.50 triathlon, $0.60 secretary"
 * without a second aggregation pass.
 */
export interface UserCostEntry {
  userId: number;
  totalCost: number;
  totalCalls: number;
  totalTokens: number;
  /** Top 3 domains by cost, descending. Each has its own rollup. */
  topDomains: Array<{
    domain: string;
    cost: number;
    calls: number;
  }>;
  /** First and last call timestamps in the window (ISO strings). */
  firstCallTs: string;
  lastCallTs: string;
}

export interface UserCostBreakdown {
  days: number;
  /** Total spend across all users in the window. Matches
   *  `computeCostBreakdown(..., days).totalCost` when called on
   *  the same row set. */
  totalCost: number;
  /** Total calls with a non-zero user_id in the window. Excludes
   *  system rows (user_id=0) to avoid confusing the admin view. */
  totalCalls: number;
  /** How many distinct users have spend in the window. */
  userCount: number;
  /** Per-user entries, sorted by total cost descending. */
  users: UserCostEntry[];
  /** Average cost per user across the window (totalCost / userCount).
   *  0 if userCount is 0 — callers should check. */
  avgCostPerUser: number;
  /** Max cost seen for any single user. Useful for sizing the per-user
   *  cap: if max cost is $0.40 and you're planning a $1.00 cap,
   *  you're safe. If max is $8, you have a runaway problem. */
  maxCostPerUser: number;
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

// ── Per-user breakdown ────────────────────────────────────────────
//
// April 9 2026 — added as the final piece of the Option G pricing
// model work. Commits 795aee2 and 3f0acd9 made `user_id` actually
// persist in `api_usage`, so we can now aggregate spend per user.
// This function answers the question the user asked during the
// brainstorm: "how much does an average user actually cost to
// serve per month?" — required to calibrate the $25 Pro tier and
// the $45 Max tier against real COGS.
//
// System rows (user_id=0) are EXCLUDED from the per-user view by
// design:
//   1. The admin portal doesn't want to see "user 0 spent $50 on
//      classifier calls" because that's just accumulated system
//      traffic (scheduled briefings, classifier runs without a
//      caller context, pre-A1-fix historical rows).
//   2. Including it would distort the per-user averages — adding
//      a synthetic "user 0" with 10x the spend of any real user
//      would make the pricing math useless.
//   3. When the time comes to attribute system traffic to a
//      specific user, those call sites will be updated to pass
//      userId and the rows will appear under that user. Until
//      then, the system bucket stays hidden.

/**
 * Build a per-user cost breakdown view from raw api_usage rows.
 *
 * @param rawRows  The rows loaded from api_usage for the requested window.
 *                 Rows MUST have `user_id` populated — pass rows selected
 *                 with `SELECT ..., user_id FROM api_usage WHERE ts >= ...`.
 *                 Rows with `user_id` missing or zero are treated as system
 *                 traffic and excluded from the per-user aggregation.
 * @param days     The window size in days (for the response's days field).
 */
export function computeUserCostBreakdown(
  rawRows: ApiUsageRow[],
  days: number,
): UserCostBreakdown {
  // Filter: real users only. Rows without user_id or with user_id=0
  // are system traffic (pre-A1 historical rows, scheduled briefings,
  // classifier-only calls without a caller). See the file comment
  // above for the full rationale.
  const userRows = rawRows.filter(r => typeof r.user_id === 'number' && r.user_id > 0);

  if (userRows.length === 0) {
    return {
      days,
      totalCost: 0,
      totalCalls: 0,
      userCount: 0,
      users: [],
      avgCostPerUser: 0,
      maxCostPerUser: 0,
    };
  }

  // Primary grouping: by user_id
  type UserGroup = {
    userId: number;
    totalCost: number;
    totalCalls: number;
    totalTokens: number;
    firstCallTs: string;
    lastCallTs: string;
    // Nested grouping: by domain (derived from category)
    domainMap: Map<string, { cost: number; calls: number }>;
  };

  const userMap = new Map<number, UserGroup>();

  for (const row of userRows) {
    const userId = row.user_id as number; // filtered above — guaranteed
    let group = userMap.get(userId);
    if (!group) {
      group = {
        userId,
        totalCost: 0,
        totalCalls: 0,
        totalTokens: 0,
        firstCallTs: row.ts,
        lastCallTs: row.ts,
        domainMap: new Map(),
      };
      userMap.set(userId, group);
    }

    group.totalCost += row.cost_usd || 0;
    group.totalCalls += 1;
    group.totalTokens += (row.input_tokens || 0) + (row.output_tokens || 0);

    // Track first + last timestamps. String comparison works because
    // SQLite's datetime('now') format is zero-padded and sorts
    // lexicographically — same trick used in `visibleEventWindow`
    // on the iOS side.
    if (row.ts < group.firstCallTs) group.firstCallTs = row.ts;
    if (row.ts > group.lastCallTs) group.lastCallTs = row.ts;

    // Derive the domain name from the category string. Categories
    // follow the `domain_<name>` pattern for the main chat path
    // (`domain_secretary`, `domain_content`, etc.); non-domain
    // categories like `classify_message`, `coach_analysis`,
    // `parse-receipt` are bucketed under their own name as-is.
    const domain = row.category.startsWith('domain_')
      ? row.category.slice('domain_'.length)
      : row.category;

    const existing = group.domainMap.get(domain);
    if (existing) {
      existing.cost += row.cost_usd || 0;
      existing.calls += 1;
    } else {
      group.domainMap.set(domain, { cost: row.cost_usd || 0, calls: 1 });
    }
  }

  // Build the output array, sorted by total cost descending.
  // Top-3 domains per user are picked from the nested domainMap.
  const users: UserCostEntry[] = Array.from(userMap.values()).map(group => {
    const topDomains = Array.from(group.domainMap.entries())
      .map(([domain, stats]) => ({
        domain,
        cost: r4(stats.cost),
        calls: stats.calls,
      }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 3);

    return {
      userId: group.userId,
      totalCost: r4(group.totalCost),
      totalCalls: group.totalCalls,
      totalTokens: group.totalTokens,
      topDomains,
      firstCallTs: group.firstCallTs,
      lastCallTs: group.lastCallTs,
    };
  });

  users.sort((a, b) => b.totalCost - a.totalCost);

  const totalCost = users.reduce((sum, u) => sum + u.totalCost, 0);
  const totalCalls = users.reduce((sum, u) => sum + u.totalCalls, 0);
  const maxCostPerUser = users.length > 0 ? users[0].totalCost : 0;

  return {
    days,
    totalCost: r4(totalCost),
    totalCalls,
    userCount: users.length,
    users,
    avgCostPerUser: users.length > 0 ? r4(totalCost / users.length) : 0,
    maxCostPerUser: r4(maxCostPerUser),
  };
}

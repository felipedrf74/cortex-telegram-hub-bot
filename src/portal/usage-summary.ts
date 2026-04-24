// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

type PortalDb = {
  prepare(sql: string): {
    get(): unknown;
    all(): unknown[];
  };
};

type UsageWindow = {
  activeUsers: number;
  messages: number;
  cost: number;
  tokens: number;
};

export type PortalUsageSummary = {
  ok: true;
  totalUsers: number;
  today: UsageWindow;
  week: UsageWindow;
  month: UsageWindow;
  sparkline: number[];
};

const EMPTY_USAGE_WINDOW: UsageWindow = {
  activeUsers: 0,
  messages: 0,
  cost: 0,
  tokens: 0,
};

function readUsageWindow(db: PortalDb, sinceSql: string): UsageWindow {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT user_id) as activeUsers,
        COUNT(*) as messages,
        COALESCE(SUM(cost_usd), 0) as cost,
        COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
      FROM api_usage
      WHERE ts >= ${sinceSql}
    `).get() as Partial<UsageWindow> | null | undefined;

    return {
      activeUsers: Number(row?.activeUsers ?? 0),
      messages: Number(row?.messages ?? 0),
      cost: Number(row?.cost ?? 0),
      tokens: Number(row?.tokens ?? 0),
    };
  } catch {
    return { ...EMPTY_USAGE_WINDOW };
  }
}

function buildSevenDaySparkline(db: PortalDb, now = new Date()): number[] {
  const sparkline: number[] = [];
  try {
    const rows = db.prepare(`
      SELECT date(ts) as day, COALESCE(SUM(cost_usd), 0) as cost
      FROM api_usage
      WHERE ts >= date('now', '-7 days')
      GROUP BY day
      ORDER BY day ASC
    `).all() as Array<{ day: string; cost: number }>;
    const byDay = new Map(rows.map((row) => [row.day, Number(row.cost ?? 0)]));

    for (let i = 6; i >= 0; i--) {
      const day = new Date(now);
      day.setDate(day.getDate() - i);
      sparkline.push(byDay.get(day.toISOString().slice(0, 10)) ?? 0);
    }
  } catch {
    return Array.from({ length: 7 }, () => 0);
  }
  return sparkline;
}

function readTotalUsers(db: PortalDb): number {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

export function buildPortalUsageSummary(db: PortalDb, now = new Date()): PortalUsageSummary {
  return {
    ok: true,
    totalUsers: readTotalUsers(db),
    today: readUsageWindow(db, "date('now')"),
    week: readUsageWindow(db, "date('now', '-7 days')"),
    month: readUsageWindow(db, "date('now', '-30 days')"),
    sparkline: buildSevenDaySparkline(db, now),
  };
}

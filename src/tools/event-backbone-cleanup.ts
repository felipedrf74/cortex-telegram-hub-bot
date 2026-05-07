// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';

type CleanupTarget = {
  table: string;
  idColumn: string;
  timestampColumn: string;
  where: string;
};

const TARGETS: CleanupTarget[] = [
  {
    table: 'event_outbox',
    idColumn: 'event_id',
    timestampColumn: 'processed_at',
    where: "status = 'processed' AND processed_at IS NOT NULL",
  },
  {
    table: 'background_jobs',
    idColumn: 'job_id',
    timestampColumn: 'completed_at',
    where: "status IN ('completed', 'canceled') AND completed_at IS NOT NULL",
  },
  {
    table: 'product_decision_logs',
    idColumn: 'decision_id',
    timestampColumn: 'created_at',
    where: '1 = 1',
  },
  {
    table: 'sync_cursors',
    idColumn: 'cursor_id',
    timestampColumn: 'updated_at',
    where: '1 = 1',
  },
];

export type EventBackboneCleanupTargetReport = {
  table: string;
  exists: boolean;
  candidates: number;
  protectedNewest: number;
  deleted: number;
};

export type EventBackboneCleanupReport = {
  apply: boolean;
  databasePath: string;
  retentionDays: number;
  cutoff: string;
  targets: EventBackboneCleanupTargetReport[];
};

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function intArg(name: string, fallback: number, min: number): number {
  const raw = argValue(name);
  const parsed = raw ? Number(raw) : fallback;
  return Number.isFinite(parsed) ? Math.max(min, Math.floor(parsed)) : fallback;
}

function resolveDbPath(): string {
  const explicitPath = argValue('--db');
  if (explicitPath) return explicitPath;

  const { config } = require('../config') as typeof import('../config');
  return config.app.databasePath;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
  return Boolean(row);
}

function cleanupTarget(
  db: Database.Database,
  target: CleanupTarget,
  cutoff: string,
  protectNewest: number,
  apply: boolean,
): EventBackboneCleanupTargetReport {
  if (!tableExists(db, target.table)) {
    return {
      table: target.table,
      exists: false,
      candidates: 0,
      protectedNewest: 0,
      deleted: 0,
    };
  }

  const ids = db.prepare(`
    SELECT ${target.idColumn} AS id
    FROM ${target.table}
    WHERE ${target.where}
      AND ${target.timestampColumn} < ?
    ORDER BY ${target.timestampColumn} ASC
  `).all(cutoff).map((row: any) => String(row.id));

  const deletable = ids.slice(0, Math.max(0, ids.length - protectNewest));
  if (!apply || deletable.length === 0) {
    return {
      table: target.table,
      exists: true,
      candidates: ids.length,
      protectedNewest: Math.min(ids.length, protectNewest),
      deleted: 0,
    };
  }

  const deleteOne = db.prepare(`DELETE FROM ${target.table} WHERE ${target.idColumn} = ?`);
  const tx = db.transaction((values: string[]) => {
    let deleted = 0;
    for (const value of values) {
      deleted += deleteOne.run(value).changes;
    }
    return deleted;
  });

  return {
    table: target.table,
    exists: true,
    candidates: ids.length,
    protectedNewest: Math.min(ids.length, protectNewest),
    deleted: tx(deletable),
  };
}

export function runEventBackboneCleanup(input: {
  dbPath: string;
  apply?: boolean;
  retentionDays?: number;
  protectNewest?: number;
}): EventBackboneCleanupReport {
  const retentionDays = Math.max(1, Math.floor(input.retentionDays ?? 30));
  const protectNewest = Math.max(0, Math.floor(input.protectNewest ?? 500));
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const db = new Database(input.dbPath);
  try {
    return {
      apply: Boolean(input.apply),
      databasePath: input.dbPath,
      retentionDays,
      cutoff,
      targets: TARGETS.map((target) => cleanupTarget(db, target, cutoff, protectNewest, Boolean(input.apply))),
    };
  } finally {
    db.close();
  }
}

function printHelp(): void {
  console.log(`
Event backbone cleanup

Usage:
  node dist/tools/event-backbone-cleanup.js [--db ./data/bot.db] [--retention-days 30] [--protect-newest 500] [--apply] [--json]

Defaults to dry-run mode. Dead-letter events/jobs are intentionally not deleted.
`);
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const report = runEventBackboneCleanup({
    dbPath: resolveDbPath(),
    apply: process.argv.includes('--apply'),
    retentionDays: intArg('--retention-days', 30, 1),
    protectNewest: intArg('--protect-newest', 500, 0),
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Event backbone cleanup ${report.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`- database: ${report.databasePath}`);
  console.log(`- retention days: ${report.retentionDays}`);
  console.log(`- cutoff: ${report.cutoff}`);
  for (const target of report.targets) {
    console.log(`- ${target.table}: exists=${target.exists ? 'yes' : 'no'} candidates=${target.candidates} protectedNewest=${target.protectedNewest} deleted=${target.deleted}`);
  }
  if (!report.apply) {
    console.log('');
    console.log('Dry-run only. Re-run with --apply after reviewing the report and taking a DB backup.');
  }
}

if (require.main === module) {
  main();
}

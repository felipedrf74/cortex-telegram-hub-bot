// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { auditInvoiceVendorRows, repairInvoiceVendorRows } from '../services/invoice-vendor-cleanup';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function printHelp(): void {
  console.log(`
Invoice vendor cleanup

Usage:
  node dist/tools/invoice-vendor-cleanup.js [--db ./data/bot.db] [--apply] [--json]

Defaults to dry-run mode. Without --apply, no database rows are changed.

Safe apply actions:
  - disable enabled ownerless invoice_vendors rows with user_id <= 0
  - disable enabled invoice_vendors rows whose user_id no longer exists
  - normalize sender_pattern casing/spacing when no per-user collision exists
`);
}

function resolveDbPath(): string {
  const explicitPath = argValue('--db');
  if (explicitPath) return explicitPath;

  const { config } = require('../config') as typeof import('../config');
  return config.app.databasePath;
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const dbPath = resolveDbPath();
  const apply = process.argv.includes('--apply');
  const asJson = process.argv.includes('--json');
  const db = new Database(dbPath);

  try {
    const report = apply
      ? repairInvoiceVendorRows(db, { apply: true })
      : auditInvoiceVendorRows(db);

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Invoice vendor cleanup ${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`- database: ${dbPath}`);
    console.log(`- schema ready: ${report.schemaReady ? 'yes' : 'no'}`);
    console.log(`- total vendor rows: ${report.totalRows}`);
    console.log(`- findings: ${report.findings.length}`);
    console.log(`- safe actions: ${report.safeActions.length}`);
    console.log(`- applied actions: ${report.appliedActions.length}`);

    for (const finding of report.findings) {
      console.log(
        `- [${finding.severity}] ${finding.type} #${finding.vendorId} ` +
        `user=${finding.userId} sender="${finding.senderPattern}" -> ` +
        `"${finding.normalizedSenderPattern}" :: ${finding.recommendation}`,
      );
    }

    if (!apply && report.safeActions.length > 0) {
      console.log('');
      console.log('Dry-run only. Re-run with --apply after reviewing the findings and taking a DB backup.');
    }
  } finally {
    db.close();
  }
}

main();

// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';

type CleanupDatabase = Database.Database;

export type InvoiceVendorCleanupFindingType =
  | 'ownerless_vendor'
  | 'orphaned_user'
  | 'noncanonical_sender_pattern'
  | 'normalization_collision';

export type InvoiceVendorCleanupActionType = 'disable_vendor' | 'normalize_sender_pattern';

export interface InvoiceVendorCleanupFinding {
  type: InvoiceVendorCleanupFindingType;
  severity: 'high' | 'medium' | 'low';
  vendorId: number;
  userId: number;
  name: string;
  senderPattern: string;
  normalizedSenderPattern: string;
  recommendation: string;
  safeAction?: InvoiceVendorCleanupActionType;
}

export interface InvoiceVendorCleanupAction {
  type: InvoiceVendorCleanupActionType;
  vendorId: number;
  from?: string;
  to?: string;
  reason: string;
}

export interface InvoiceVendorCleanupReport {
  schemaReady: boolean;
  totalRows: number;
  findings: InvoiceVendorCleanupFinding[];
  safeActions: InvoiceVendorCleanupAction[];
  appliedActions: InvoiceVendorCleanupAction[];
  dryRun: boolean;
}

interface InvoiceVendorRow {
  id: number;
  name: string;
  sender_pattern: string;
  subject_patterns: string | null;
  enabled: number;
  user_id: number;
}

function tableExists(db: CleanupDatabase, tableName: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) as { name: string } | undefined;
  return !!row;
}

function tableColumns(db: CleanupDatabase, tableName: string): Set<string> {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all()
      .map((row: any) => String(row.name)),
  );
}

export function normalizeInvoiceVendorSenderPattern(senderPattern: string): string {
  return senderPattern.trim().toLowerCase();
}

function loadValidUserIds(db: CleanupDatabase): Set<number> | null {
  if (!tableExists(db, 'users')) return null;
  const rows = db.prepare('SELECT id FROM users').all() as { id: number }[];
  return new Set(rows.map((row) => row.id));
}

function loadInvoiceVendorRows(db: CleanupDatabase): InvoiceVendorRow[] {
  return db.prepare(`
    SELECT id, name, sender_pattern, subject_patterns, enabled, user_id
    FROM invoice_vendors
    ORDER BY id ASC
  `).all() as InvoiceVendorRow[];
}

function makeKey(userId: number, senderPattern: string): string {
  return `${userId}:${normalizeInvoiceVendorSenderPattern(senderPattern)}`;
}

function buildNormalizedIndex(rows: InvoiceVendorRow[]): Map<string, InvoiceVendorRow[]> {
  const index = new Map<string, InvoiceVendorRow[]>();
  for (const row of rows) {
    const key = makeKey(row.user_id, row.sender_pattern);
    const bucket = index.get(key) ?? [];
    bucket.push(row);
    index.set(key, bucket);
  }
  return index;
}

function addSafeAction(
  safeActions: InvoiceVendorCleanupAction[],
  action: InvoiceVendorCleanupAction,
): void {
  if (safeActions.some((existing) => existing.type === action.type && existing.vendorId === action.vendorId)) {
    return;
  }
  safeActions.push(action);
}

export function auditInvoiceVendorRows(db: CleanupDatabase): InvoiceVendorCleanupReport {
  if (!tableExists(db, 'invoice_vendors')) {
    return {
      schemaReady: false,
      totalRows: 0,
      findings: [],
      safeActions: [],
      appliedActions: [],
      dryRun: true,
    };
  }

  const columns = tableColumns(db, 'invoice_vendors');
  if (!columns.has('user_id')) {
    return {
      schemaReady: false,
      totalRows: 0,
      findings: [],
      safeActions: [],
      appliedActions: [],
      dryRun: true,
    };
  }

  const rows = loadInvoiceVendorRows(db);
  const validUserIds = loadValidUserIds(db);
  const normalizedIndex = buildNormalizedIndex(rows);
  const findings: InvoiceVendorCleanupFinding[] = [];
  const safeActions: InvoiceVendorCleanupAction[] = [];

  for (const row of rows) {
    const normalizedSenderPattern = normalizeInvoiceVendorSenderPattern(row.sender_pattern);
    const base = {
      vendorId: row.id,
      userId: row.user_id,
      name: row.name,
      senderPattern: row.sender_pattern,
      normalizedSenderPattern,
    };

    if (row.user_id <= 0) {
      findings.push({
        ...base,
        type: 'ownerless_vendor',
        severity: 'high',
        recommendation: 'Disable this legacy global vendor row; current app-facing Fiscal Collection is user-scoped.',
        safeAction: row.enabled ? 'disable_vendor' : undefined,
      });
      if (row.enabled) {
        addSafeAction(safeActions, {
          type: 'disable_vendor',
          vendorId: row.id,
          reason: 'legacy ownerless invoice vendor row',
        });
      }
    } else if (validUserIds && !validUserIds.has(row.user_id)) {
      findings.push({
        ...base,
        type: 'orphaned_user',
        severity: 'high',
        recommendation: 'Disable this vendor row because its owning user no longer exists.',
        safeAction: row.enabled ? 'disable_vendor' : undefined,
      });
      if (row.enabled) {
        addSafeAction(safeActions, {
          type: 'disable_vendor',
          vendorId: row.id,
          reason: 'invoice vendor belongs to a missing user',
        });
      }
    }

    if (row.sender_pattern !== normalizedSenderPattern) {
      const collisions = (normalizedIndex.get(makeKey(row.user_id, normalizedSenderPattern)) ?? [])
        .filter((candidate) => candidate.id !== row.id);

      if (collisions.length > 0) {
        findings.push({
          ...base,
          type: 'normalization_collision',
          severity: 'medium',
          recommendation: 'Manual review required; normalizing this sender pattern would collide with another row for the same user.',
        });
      } else {
        findings.push({
          ...base,
          type: 'noncanonical_sender_pattern',
          severity: 'low',
          recommendation: 'Normalize sender_pattern to lowercase/trimmed form.',
          safeAction: 'normalize_sender_pattern',
        });
        addSafeAction(safeActions, {
          type: 'normalize_sender_pattern',
          vendorId: row.id,
          from: row.sender_pattern,
          to: normalizedSenderPattern,
          reason: 'noncanonical invoice vendor sender_pattern',
        });
      }
    }
  }

  return {
    schemaReady: true,
    totalRows: rows.length,
    findings,
    safeActions,
    appliedActions: [],
    dryRun: true,
  };
}

export function repairInvoiceVendorRows(
  db: CleanupDatabase,
  options: { apply?: boolean } = {},
): InvoiceVendorCleanupReport {
  const report = auditInvoiceVendorRows(db);
  if (!options.apply) {
    return report;
  }
  if (!report.schemaReady || report.safeActions.length === 0) {
    return {
      ...report,
      dryRun: false,
    };
  }

  const applyActions = db.transaction((actions: InvoiceVendorCleanupAction[]) => {
    for (const action of actions) {
      if (action.type === 'disable_vendor') {
        db.prepare('UPDATE invoice_vendors SET enabled = 0 WHERE id = ?').run(action.vendorId);
      } else if (action.type === 'normalize_sender_pattern' && action.to) {
        db.prepare('UPDATE invoice_vendors SET sender_pattern = ? WHERE id = ?').run(action.to, action.vendorId);
      }
    }
  });

  applyActions(report.safeActions);

  return {
    ...auditInvoiceVendorRows(db),
    appliedActions: report.safeActions,
    dryRun: false,
  };
}

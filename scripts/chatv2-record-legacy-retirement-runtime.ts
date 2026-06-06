#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
const inventoryPath = readArg('--inventory') ?? 'docs/ai/chatv2-route-exit-inventory.md';
const shouldWrite = hasFlag('--write');
const shouldReplace = hasFlag('--replace');
const verifyOnly = hasFlag('--verify-only');
const fullVerifyCleanArg = readArg('--full-verify-clean');
const fullVerifyClean = fullVerifyCleanArg == null ? null : fullVerifyCleanArg === 'true' || fullVerifyCleanArg === '1';
const requestId = readArg('--request-id') ?? `legacy-retirement-runtime-${new Date().toISOString()}`;

if (!shouldWrite) {
  console.error([
    'Refusing to write ChatV2 legacy-retirement runtime evidence without --write.',
    'This script records safe inventory/fallback evidence only; it does not mark legacy routes retired.',
    'Use: npx tsx scripts/chatv2-record-legacy-retirement-runtime.ts --write --replace --db=./data/local.db',
  ].join('\n'));
  process.exitCode = 1;
} else if (verifyOnly && fullVerifyClean == null) {
  console.error('Refusing --verify-only without --full-verify-clean=true|false.');
  process.exitCode = 1;
} else {
  const db = new Database(dbPath);
  try {
    ensureLegacySchema(db);
    const inventoryRows = verifyOnly ? [] : parseRouteExitInventory(inventoryPath);
    const fallbackRate = verifyOnly ? null : computeLegacyFallbackRate(db);
    const tx = db.transaction(() => {
      if (shouldReplace && verifyOnly) {
        db.prepare("DELETE FROM chat_v2_legacy_retirement_evidence WHERE evidence_source = 'runtime_route' AND evidence_kind = 'verify_run'").run();
      } else if (shouldReplace) {
        db.prepare(`
          DELETE FROM chat_v2_legacy_retirement_evidence
          WHERE evidence_source = 'runtime_route'
            AND (
              evidence_kind IN ('fallback_rate', 'verify_run')
              OR (
                evidence_kind = 'route_exit'
                AND safe_metadata_json LIKE '%"status":"inventory_only_not_retired"%'
              )
            )
        `).run();
      }
      for (const row of inventoryRows) {
        insertRouteExitEvidence(db, {
          requestId,
          routeId: row.routeId,
          replaced: false,
          tested: false,
          shadowParityRate: 0,
          sampleCount: 0,
          safeMetadata: {
            inventoryLabelHash: hmacToken('inventory-label', row.label),
            currentOwnerHash: hmacToken('inventory-owner', row.currentOwner),
            plannedReplacementHash: hmacToken('inventory-replacement', row.plannedReplacement),
            status: 'inventory_only_not_retired',
          },
        });
      }
      if (fallbackRate) {
        insertFallbackRateEvidence(db, {
          requestId: `${requestId}:fallback-rate`,
          legacyFallbackRate24h: fallbackRate.rate,
          safeMetadata: {
            measuredCounterRows: fallbackRate.totalRows,
            fallbackRows: fallbackRate.fallbackRows,
            measurement: fallbackRate.measurement,
          },
        });
      }
      if (fullVerifyClean != null) {
        insertVerifyRunEvidence(db, {
          requestId: `${requestId}:verify`,
          fullVerifyClean,
          safeMetadata: {
            source: 'operator_supplied_after_local_verify',
          },
        });
      }
    });
    tx();
    console.log(JSON.stringify({
      schemaVersion: 'chat_v2_legacy_retirement_runtime_evidence_result.v1',
      dbPath,
      inventoryPath,
      requestId,
      routeRows: inventoryRows.length,
      verifyOnly,
      fallbackRate24h: fallbackRate?.rate ?? null,
      fallbackRows: fallbackRate?.fallbackRows ?? null,
      measuredCounterRows: fallbackRate?.totalRows ?? null,
      fallbackMeasurement: fallbackRate?.measurement ?? null,
      fullVerifyCleanRecorded: fullVerifyClean,
      warning: 'Route rows are intentionally recorded as not retired. Do not disable legacy branches until shadow parity evidence replaces these rows.',
    }, null, 2));
  } finally {
    db.close();
  }
}

type RouteInventoryRow = {
  label: string;
  routeId: string;
  currentOwner: string;
  plannedReplacement: string;
  keepPreChatV2: boolean;
  canExecute: boolean;
  externalEffect: boolean;
};

function parseRouteExitInventory(filePath: string): RouteInventoryRow[] {
  const absolutePath = path.resolve(filePath);
  const content = fs.readFileSync(absolutePath, 'utf8');
  return content
    .split(/\r?\n/)
    .filter((line) => line.startsWith('| ') && !line.includes('---'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 7 && cells[0] !== 'Route Exit')
    .map((cells) => ({
      label: stripMarkdown(cells[0]!),
      routeId: slugify(stripMarkdown(cells[0]!)),
      currentOwner: stripMarkdown(cells[1] ?? ''),
      canExecute: /^yes|preview|task|confirmed/i.test(stripMarkdown(cells[3] ?? '')),
      externalEffect: /^yes|possible|native|web|task/i.test(stripMarkdown(cells[4] ?? '')),
      keepPreChatV2: /^yes/i.test(stripMarkdown(cells[5] ?? '')),
      plannedReplacement: stripMarkdown(cells[6] ?? ''),
    }))
    .filter((row) => row.routeId.length > 0)
    .filter((row) => !row.keepPreChatV2 || row.canExecute || row.externalEffect);
}

function computeLegacyFallbackRate(db: Database.Database): {
  rate: number;
  fallbackRows: number;
  totalRows: number;
  measurement: string;
} | null {
  ensureLegacyFallbackCounterSchema(db);
  const cutoffWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 13);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(fallback_count), 0) AS fallbackRows,
      COALESCE(SUM(total_count), 0) AS totalRows
    FROM chat_v2_legacy_fallback_counter
    WHERE window_start >= ?
  `).get(cutoffWindowStart) as { fallbackRows: number; totalRows: number } | undefined;

  const fallbackRows = Number(row?.fallbackRows ?? 0) || 0;
  const totalRows = Number(row?.totalRows ?? 0) || 0;
  if (totalRows <= 0) {
    return null;
  }

  return {
    rate: fallbackRows / totalRows,
    fallbackRows,
    totalRows,
    measurement: 'legacy_fallback_counter',
  };
}

function insertRouteExitEvidence(db: Database.Database, input: {
  requestId: string;
  routeId: string;
  replaced: boolean;
  tested: boolean;
  shadowParityRate: number;
  sampleCount: number;
  safeMetadata: Record<string, unknown>;
}): void {
  insertLegacyRow(db, {
    evidenceKind: 'route_exit',
    requestId: input.requestId,
    sampleHmac: hmacToken('legacy-route', `${input.requestId}:${input.routeId}`),
    routeId: input.routeId,
    replaced: input.replaced ? 1 : 0,
    tested: input.tested ? 1 : 0,
    shadowParityRate: clamp01(input.shadowParityRate),
    routeSampleCount: Math.max(0, Math.floor(input.sampleCount)),
    legacyFallbackRate24h: null,
    fullVerifyClean: null,
    safeMetadata: buildSafeMetadata('route_exit', input.safeMetadata),
  });
}

function insertFallbackRateEvidence(db: Database.Database, input: {
  requestId: string;
  legacyFallbackRate24h: number;
  safeMetadata: Record<string, unknown>;
}): void {
  insertLegacyRow(db, {
    evidenceKind: 'fallback_rate',
    requestId: input.requestId,
    sampleHmac: hmacToken('legacy-fallback-rate', input.requestId),
    routeId: null,
    replaced: null,
    tested: null,
    shadowParityRate: null,
    routeSampleCount: null,
    legacyFallbackRate24h: Number.isFinite(input.legacyFallbackRate24h) ? Math.max(0, input.legacyFallbackRate24h) : null,
    fullVerifyClean: null,
    safeMetadata: buildSafeMetadata('fallback_rate', input.safeMetadata),
  });
}

function insertVerifyRunEvidence(db: Database.Database, input: {
  requestId: string;
  fullVerifyClean: boolean;
  safeMetadata: Record<string, unknown>;
}): void {
  insertLegacyRow(db, {
    evidenceKind: 'verify_run',
    requestId: input.requestId,
    sampleHmac: hmacToken('legacy-verify-run', input.requestId),
    routeId: null,
    replaced: null,
    tested: null,
    shadowParityRate: null,
    routeSampleCount: null,
    legacyFallbackRate24h: null,
    fullVerifyClean: input.fullVerifyClean ? 1 : 0,
    safeMetadata: buildSafeMetadata('verify_run', input.safeMetadata),
  });
}

function insertLegacyRow(db: Database.Database, row: {
  evidenceKind: 'route_exit' | 'fallback_rate' | 'verify_run';
  requestId: string;
  sampleHmac: string;
  routeId: string | null;
  replaced: number | null;
  tested: number | null;
  shadowParityRate: number | null;
  routeSampleCount: number | null;
  legacyFallbackRate24h: number | null;
  fullVerifyClean: number | null;
  safeMetadata: Record<string, unknown>;
}): void {
  const safeMetadataJson = JSON.stringify(row.safeMetadata);
  db.prepare(`
    INSERT INTO chat_v2_legacy_retirement_evidence (
      evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
      route_id, replaced, tested, shadow_parity_rate, route_sample_count,
      legacy_fallback_rate_24h, full_verify_clean, raw_field_audit_count,
      safe_metadata_json
    ) VALUES ('runtime_route', ?, ?, ?, 'hmac', ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    row.evidenceKind,
    row.requestId,
    row.sampleHmac,
    row.routeId,
    row.replaced,
    row.tested,
    row.shadowParityRate,
    row.routeSampleCount,
    row.legacyFallbackRate24h,
    row.fullVerifyClean,
    safeMetadataJson,
  );
}

function ensureLegacySchema(db: Database.Database): void {
  const migration = path.resolve('migrations/160_chatv2_legacy_retirement_evidence.sql');
  db.exec(fs.readFileSync(migration, 'utf8'));
}

function ensureLegacyFallbackCounterSchema(db: Database.Database): void {
  const migration = path.resolve('migrations/177_chat_v2_autorevert_counters.sql');
  if (fs.existsSync(migration)) {
    db.exec(fs.readFileSync(migration, 'utf8'));
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_legacy_fallback_counter (
      tenant_id       TEXT NOT NULL,
      window_start    TEXT NOT NULL,
      fallback_count  INTEGER NOT NULL DEFAULT 0,
      total_count     INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, window_start)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_legacy_fallback_counter_tenant_window
      ON chat_v2_legacy_fallback_counter(tenant_id, window_start);
  `);
}

function buildSafeMetadata(kind: string, metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 'chat_v2_legacy_retirement_runtime_evidence.v1',
    evidenceKind: kind,
    ...metadata,
  };
}

function hmacToken(kind: string, value: string): string {
  return `hmac:${kind}:${crypto.createHmac('sha256', resolveEvidenceHmacSecret()).update(value).digest('hex')}`;
}

function resolveEvidenceHmacSecret(): string {
  const configured = process.env.CHAT_V2_EVIDENCE_HMAC_SECRET || process.env.IOS_API_JWT_SECRET;
  if (configured) return configured;
  throw new Error('CHAT_V2_EVIDENCE_HMAC_SECRET is required to record legacy retirement runtime evidence');
}

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

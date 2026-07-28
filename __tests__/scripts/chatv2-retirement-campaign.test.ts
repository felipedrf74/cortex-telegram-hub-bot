// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  buildChatV2RetirementCampaignReport,
  renderChatV2RetirementCampaignTable,
} from '../../scripts/chatv2-retirement-campaign';

const NOW = new Date('2026-07-20T12:00:00.000Z');
let db: Database.Database;

beforeEach(() => {
  db = createMigratedTestDatabase();
});

afterEach(() => {
  db.close();
});

function seedBehavior(input: { samples?: number; matches?: number; signoff?: boolean } = {}): void {
  const samples = input.samples ?? 50;
  const matches = input.matches ?? 50;
  db.prepare(`
    INSERT INTO chat_v2_legacy_retirement_evidence (
      evidence_source, evidence_kind, request_id, sample_hmac, sample_identifier_kind,
      route_id, replaced, tested, shadow_parity_rate, route_sample_count,
      raw_field_audit_count, safe_metadata_json, created_at
    ) VALUES ('runtime_route', 'route_exit', 'cli-behavior', ?, 'hmac',
      'training_plan_shortcut', 1, 1, ?, ?, 0, ?, ?)
  `).run(
    `hmac:test:${'c'.repeat(64)}`,
    matches / samples,
    samples,
    JSON.stringify({
      schemaVersion: 'chat_v2_legacy_parity_evidence_safe_metadata.v1',
      parityObservationImport: true,
      evaluator: 'manual',
      peerReviewSignoffHash: input.signoff === false ? null : 'd'.repeat(64),
      sampleCount: samples,
      matchingCount: matches,
      safetyRegressionCount: 0,
      qualityRegressionCount: 0,
      degradedNotComparableCount: 0,
    }),
    NOW.toISOString(),
  );
}

function seedFallback(fallback: number, total = 100): void {
  db.prepare(`
    INSERT INTO chat_v2_legacy_fallback_attribution_counter (
      tenant_id, window_start, domain, route_owner, route_method,
      fallback_count, total_count, updated_at
    ) VALUES ('tenant-a', '2026-07-20T11', 'training',
      'training_plan_shortcut', 'training-plan-shortcut', ?, ?, ?)
  `).run(fallback, total, NOW.toISOString());
}

describe('chatv2-retirement-campaign report', () => {
  it('reports a real PASS only from paired behavior, mapping, and 24h fallback evidence', () => {
    seedBehavior({ samples: 50, matches: 48 });
    seedFallback(2);
    const report = buildChatV2RetirementCampaignReport(db, { now: NOW });

    expect(report.schemaVersion).toBe('chat_v2_retirement_campaign_report.v2');
    expect(report.status).toBe('ok');
    expect(report.rows).toHaveLength(9);
    expect(report.rows.find((row) => row.routeId === 'training_plan_shortcut')).toMatchObject({
      behaviorParitySamples: 50,
      behaviorParityRate: 0.96,
      disableStages: ['training_plan_shortcut'],
      fallback24h: { rate: 0.02, passed: true },
      candidate: true,
      verdict: 'pass',
    });
    expect(report.totals).toMatchObject({
      routes: 9,
      passedRoutes: 1,
      behaviorParitySamples: 50,
      fallbackAlertRoutes: 0,
    });
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('renders behavior, exact disable stage, fallback, and blocked routes', () => {
    seedBehavior({ samples: 50, matches: 45 });
    seedFallback(3);
    const table = renderChatV2RetirementCampaignTable(
      buildChatV2RetirementCampaignReport(db, { now: NOW }),
    );
    const routeLine = table.split('\n').find((line) => line.includes('training_plan_shortcut'));
    expect(routeLine).toContain('training_plan_shortcut');
    expect(routeLine).toContain('FAIL');
    expect(table).toContain('blocked:non_retirable');
    expect(table).toContain('Routing agreement and eval health are diagnostics');
  });

  it('reports empty evidence honestly without throwing', () => {
    const report = buildChatV2RetirementCampaignReport(db, { now: NOW });
    expect(report.totals.passedRoutes).toBe(0);
    expect(report.rows.every((row) => !row.candidate)).toBe(true);
    expect(renderChatV2RetirementCampaignTable(report)).toContain('INSUFFICIENT');
  });

  it('returns an honest migration-not-applied report on a readonly pre-258 database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chatv2-campaign-'));
    const dbPath = path.join(dir, 'pre258.db');
    try {
      const writable = new Database(dbPath);
      writable.exec('CREATE TABLE placeholder (id INTEGER PRIMARY KEY)');
      writable.close();
      const readonly = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const report = buildChatV2RetirementCampaignReport(readonly, { now: NOW });
        expect(report.status).toBe('migration_258_not_applied');
        expect(report.rows).toEqual([]);
        expect(renderChatV2RetirementCampaignTable(report)).toContain('migration 258 not applied');
      } finally {
        readonly.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

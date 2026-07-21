// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Chat M20 — offline retirement-campaign CLI (table + --json builders).
// The CLI never flips route flags; it only reports per-route campaign state.
// Parity samples/rates drive the gate; health rows are context only; routes
// below the 50-known-parity-sample floor report insufficient_evidence.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { recordChatV2ReplayBundle } from '../../src/services/chat-core-v2/model-run-audit';
import { recordChatV2OnlineEvalSample } from '../../src/services/chat-core-v2/online-eval-sampler';
import { syncChatRouteExitSamples } from '../../src/services/chat-route-exit-sampler';
import {
  buildChatV2RetirementCampaignReport,
  renderChatV2RetirementCampaignTable,
} from '../../scripts/chatv2-retirement-campaign';

const NOW = new Date('2026-07-20T12:00:00.000Z');

let db: Database.Database;

beforeEach(() => {
  db = createMigratedTestDatabase();
});

function seedDeterministicReadBundles(count: number, options: { diverged?: boolean; unknown?: boolean } = {}): void {
  for (let i = 0; i < count; i += 1) {
    const id = `cli-bundle-${options.diverged ? 'bad' : options.unknown ? 'unk' : 'ok'}-${i}`;
    recordChatV2ReplayBundle({
      replayBundleId: id,
      bundle: {
        turnId: id,
        routeDecision: { routeMethod: 'deterministic_read', domains: [], selectedCapabilityIds: [] },
        contextPack: {
          shadowRouteHookVersion: 'chat_core_v2_shadow_route_hook@1.0.0',
          ...(options.unknown ? {} : {
            routingDivergence: {
              surfaces: {
                classifierKeywordDomain: null,
                orchestratorPrimaryDomain: options.diverged ? 'finance' : 'secretary',
                registryActionSkills: [],
                shadowRouteIntent: 'read',
                shadowRouteDomains: ['tasks'],
              },
            },
          }),
        },
        modelRuns: [],
        toolSchemaSetVersion: 'tools@1',
        commandProposals: [],
        commandEvents: [],
        traceSpans: [],
        response: { type: 'chat_core_v2_shadow_plan', routeMethod: 'deterministic_read' },
      } as never,
      sensitivity: 'normal',
      retentionPolicy: '90d',
      createdAt: NOW.toISOString(),
    }, db);
  }
}

function seedHealthCaptures(count: number): void {
  for (let i = 0; i < count; i += 1) {
    recordChatV2OnlineEvalSample({
      sampleId: `cli-health-${i}`,
      turnId: `cli-health-turn-${i}`,
      tenantId: 'tenant-1',
      userId: 'user-1',
      routeMethod: 'planner' as never,
      risk: 'low',
      sensitivity: 'normal',
      createdAt: NOW.toISOString(),
      decision: {
        sample: true,
        status: 'sampled',
        reason: 'baseline_random',
        sampleRate: 1,
        samplerVersion: 'test',
      },
    }, db);
  }
}

describe('chatv2-retirement-campaign report', () => {
  it('builds a JSON report with parity driving the gate and health as context', () => {
    seedDeterministicReadBundles(50);
    seedDeterministicReadBundles(7, { unknown: true });
    seedHealthCaptures(5);
    syncChatRouteExitSamples(db, { now: NOW });

    const report = buildChatV2RetirementCampaignReport(db);
    expect(report.schemaVersion).toBe('chat_v2_retirement_campaign_report.v1');
    expect(report.status).toBe('ok');
    expect(report.rows).toHaveLength(9);
    expect(report.rows[0]).toMatchObject({
      position: 1,
      routeId: 'chat_message_shortcut_after_route',
      paritySamples: 50,
      parityUnknown: 7,
      gatePassed: true,
      verdict: 'pass',
      missingSamples: 0,
    });
    const planner = report.rows.find((row) => row.routeId === 'chat_reasoning_engine_v1')!;
    expect(planner).toMatchObject({
      paritySamples: 0,
      healthSamples: 5,
      gatePassed: false,
      verdict: 'insufficient_evidence',
    });
    expect(report.totals).toMatchObject({
      routes: 9,
      passedRoutes: 1,
      failedRoutes: 0,
      insufficientRoutes: 8,
      paritySamples: 50,
      parityUnknown: 7,
      healthSamples: 5,
    });
    // Report is JSON-serializable for --json.
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('renders a deterministic campaign table with PASS/FAIL/INSUFFICIENT verdicts', () => {
    seedDeterministicReadBundles(45);
    seedDeterministicReadBundles(5, { diverged: true });
    syncChatRouteExitSamples(db, { now: NOW });

    const report = buildChatV2RetirementCampaignReport(db);
    const table = renderChatV2RetirementCampaignTable(report);
    expect(table).toContain('chat_message_shortcut_after_route');
    expect(table).toContain('general_action_planner');
    // 45/50 = 0.90 parity with the floor met => honest FAIL.
    const failLine = table.split('\n').find((line) => line.includes('chat_message_shortcut_after_route'));
    expect(failLine).toContain('FAIL');
    expect(failLine).toContain('50');
    // Routes without parity evidence report INSUFFICIENT, not FAIL-on-zero.
    const emptyLine = table.split('\n').find((line) => line.includes('general_action_planner'));
    expect(emptyLine).toContain('INSUFFICIENT');
  });

  it('reports empty evidence honestly without throwing', () => {
    const report = buildChatV2RetirementCampaignReport(db);
    expect(report.rows.every((row) => row.paritySamples === 0 && !row.gatePassed
      && row.verdict === 'insufficient_evidence')).toBe(true);
    expect(renderChatV2RetirementCampaignTable(report)).toContain('INSUFFICIENT');
  });

  it('returns an honest migration-not-applied report on a readonly pre-257 database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chatv2-campaign-'));
    const dbPath = path.join(dir, 'pre257.db');
    try {
      const writable = new Database(dbPath);
      writable.exec('CREATE TABLE placeholder (id INTEGER PRIMARY KEY)');
      writable.close();

      const readonly = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const report = buildChatV2RetirementCampaignReport(readonly);
        expect(report.status).toBe('migration_257_not_applied');
        expect(report.rows).toHaveLength(0);
        expect(renderChatV2RetirementCampaignTable(report)).toContain('migration 257 not applied');
      } finally {
        readonly.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

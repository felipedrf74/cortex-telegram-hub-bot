// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the W-E workstream: Secretary reasoning trail.
 * The arbitrator now collects ordered `ReasoningTrailNode[]` during
 * `scheduleOne` and persists it to a new `reasoning_trail_json` column.
 * Surfaced via Decision Center (C2 — separate commit).
 *
 * Privacy contract: trail nodes contain ONLY enum reason codes, ISO slot
 * strings, and numeric weights. NEVER user copy (titles, descriptions).
 *
 * Plan reference: Wave 1 workstream W-E.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(
  __dirname,
  '../../migrations/083_secretary_agenda_ledger.sql',
);
const MIGRATION_098 = path.resolve(
  __dirname,
  '../../migrations/098_secretary_decision_explanation.sql',
);

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  applyMigrationFileForTest: vi.fn(),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  arbitrateSecretarySchedulingIntents,
  getSecretaryAgendaItemById,
  submitSecretarySchedulingIntent,
  type ReasoningTrailNode,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';

const TENANT_ID = 'tenant-trail-test';
const OWNER_USER_ID = 42;

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
});

afterEach(() => {
  testDb.close();
});

function trainingIntent(intentId: string, overrides?: Partial<SecretarySchedulingIntent>): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'training',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `Training intent ${intentId}`,
    requestedDurationMinutes: 60,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T11:00:00.000Z' }],
    priority: 'medium',
    flexibility: 'flexible',
    ...overrides,
  };
}

describe('W-E: SecretaryReasoningTrail', () => {
  it('attaches a non-empty trail to a scheduled decision', () => {
    const decision = submitSecretarySchedulingIntent(trainingIntent('t-1'));
    expect(decision.status).toBe('scheduled');
    expect(decision.reasoningTrail.length).toBeGreaterThan(0);
    // Trail should end with the `chosen` marker for the winning slot
    const last = decision.reasoningTrail[decision.reasoningTrail.length - 1];
    expect(last.kind).toBe('chosen');
    expect(last.slot).toBeDefined();
    expect(last.slot?.start).toBe(decision.selectedSlot!.start);
  });

  it('persists the trail to reasoning_trail_json and round-trips through read-back', () => {
    const submit = submitSecretarySchedulingIntent(trainingIntent('t-roundtrip'));
    const read = getSecretaryAgendaItemById({
      agendaItemId: submit.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    });
    expect(read).not.toBeNull();
    expect(read!.reasoningTrail.length).toBeGreaterThan(0);
    // Round-trip equality: serialized + parsed shape matches what the
    // decision in memory carried.
    expect(read!.reasoningTrail).toEqual(submit.reasoningTrail);
  });

  it('emits priority + phase_boost nodes when goalPhase is set', () => {
    const decision = submitSecretarySchedulingIntent(
      trainingIntent('t-phase', { goalPhase: 'peak' }),
    );
    const kinds = decision.reasoningTrail.map((n) => n.kind);
    expect(kinds).toContain('priority');
    expect(kinds).toContain('phase_boost');
    const phaseNode = decision.reasoningTrail.find((n) => n.kind === 'phase_boost')!;
    expect(phaseNode.weight).toBe(3); // peak = +3 for training
    expect(phaseNode.detail).toBe('phase:peak');
  });

  it('emits a validation node when the intent is malformed', () => {
    const bad: SecretarySchedulingIntent = {
      ...trainingIntent('t-bad'),
      requestedDurationMinutes: 0, // → missing_duration
    };
    const decision = submitSecretarySchedulingIntent(bad);
    expect(decision.status).toBe('needs_more_context');
    const validationNode = decision.reasoningTrail.find((n) => n.kind === 'validation');
    expect(validationNode).toBeDefined();
    expect(validationNode!.reasonCode).toBe('missing_duration');
  });

  it('PRIVACY: trail nodes never carry user copy (title, description, label)', () => {
    const intent = trainingIntent('t-privacy', {
      title: 'Hill repeats — VERY SECRET CONTENT',
      preferredWindows: [{
        start: '2026-05-20T08:00:00.000Z',
        end: '2026-05-20T11:00:00.000Z',
        label: 'PII LEAK LABEL',
      }],
    });
    const decision = submitSecretarySchedulingIntent(intent);
    for (const node of decision.reasoningTrail) {
      // Detail tag is a short structured key:value; it must not contain
      // the title or any free-text PII.
      if (node.detail) {
        expect(node.detail).not.toContain('VERY SECRET');
        expect(node.detail).not.toContain('PII LEAK');
        expect(node.detail).not.toContain('Hill repeats');
      }
      // Slot objects must only have `start` and `end` — no `label`.
      if (node.slot) {
        expect(Object.keys(node.slot).sort()).toEqual(['end', 'start']);
      }
    }
  });

  it('caps the trail at 12 nodes preserving the chosen marker', () => {
    // Force many candidate windows so the trail grows past the cap. Each
    // window contributes one `considered` node; we'll create 20.
    const manyWindows = Array.from({ length: 20 }, (_, i) => ({
      start: new Date(Date.parse('2026-05-20T08:00:00.000Z') + i * 90 * 60_000).toISOString(),
      end: new Date(Date.parse('2026-05-20T09:00:00.000Z') + i * 90 * 60_000).toISOString(),
    }));
    const decision = submitSecretarySchedulingIntent(
      trainingIntent('t-cap', { preferredWindows: manyWindows }),
    );
    expect(decision.reasoningTrail.length).toBeLessThanOrEqual(12);
    // The terminal `chosen` marker must survive the cap.
    const chosen = decision.reasoningTrail.find((n) => n.kind === 'chosen');
    expect(chosen).toBeDefined();
    expect(chosen!.slot).toBeDefined();
  });

  it('emits trails per-decision in batch arbitration', () => {
    const result = arbitrateSecretarySchedulingIntents([
      trainingIntent('batch-1'),
      trainingIntent('batch-2'),
    ]);
    expect(result.decisions.length).toBe(2);
    for (const decision of result.decisions) {
      expect(decision.reasoningTrail.length).toBeGreaterThan(0);
      const chosen = decision.reasoningTrail.find((n: ReasoningTrailNode) => n.kind === 'chosen');
      expect(chosen).toBeDefined();
    }
  });
});

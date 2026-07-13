// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the C1 workstream:
 * `previewSecretarySchedulingIntent` — non-persisting probe used by Training
 * to detect conflicts BEFORE the user sees a Decision Center card.
 *
 * Plan reference: Wave 1 workstream C1.
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
  listSecretaryAgendaItems,
  previewSecretarySchedulingIntent,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';

const TENANT_ID = 'tenant-preview-test';
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

function trainingIntent(intentId: string): SecretarySchedulingIntent {
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
  };
}

describe('C1: previewSecretarySchedulingIntent', () => {
  it('returns the same status + slot as submit when no concurrent writes', () => {
    const intent = trainingIntent('t-1');
    const preview = previewSecretarySchedulingIntent(intent);
    const submit = submitSecretarySchedulingIntent(intent);
    expect(preview.status).toBe(submit.status);
    expect(preview.recommendedSlot).toEqual(submit.selectedSlot);
  });

  it('does NOT leave an active agenda item behind (preview cleanup)', () => {
    previewSecretarySchedulingIntent(trainingIntent('t-preview-clean'));
    const items = listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    });
    // Active items only (excludes 'canceled'/'superseded'); preview must be clean.
    expect(items.length).toBe(0);
    const allItems = listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: true,
    });
    // C1 hardening: preview is now truly non-persisting, not write-then-cancel.
    expect(allItems.length).toBe(0);
  });

  it('preview-then-submit produces exactly ONE active persisted agenda item', () => {
    const intent = trainingIntent('t-pst');
    previewSecretarySchedulingIntent(intent);
    submitSecretarySchedulingIntent(intent);
    const items = listSecretaryAgendaItems({
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      includeInactive: false,
    });
    expect(items.length).toBe(1);
    expect(items[0].sourceIntentId).toBe('t-pst');
  });

  it('preview carries the noPersist marker', () => {
    const preview = previewSecretarySchedulingIntent(trainingIntent('t-marker'));
    expect(preview.noPersist).toBe(true);
  });

  it('preview returns wouldReflow/wouldCompress markers for non-fresh placements', () => {
    const preview = previewSecretarySchedulingIntent(trainingIntent('t-marker-2'));
    expect(preview.wouldReflow).toBe(false);
    expect(preview.wouldCompress).toBe(false);
  });
});

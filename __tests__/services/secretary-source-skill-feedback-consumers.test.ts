// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave 2 guard: Cooking / Finance / Content consume Secretary feedback.
 * Training has a specialized sink; these skills share the compact source
 * feedback table until richer skill-specific planners consume the hints.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql');
const MIGRATION_098 = path.resolve(__dirname, '../../migrations/098_secretary_decision_explanation.sql');
const MIGRATION_126 = path.resolve(__dirname, '../../migrations/126_secretary_reasoning_trail.sql');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
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
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  _resetSecretaryFeedbackBusForTests,
} from '../../src/services/secretary-feedback-bus';
import {
  _resetSecretarySourceSkillFeedbackConsumersForTests,
  listSecretarySourceSkillFeedback,
  registerSecretarySourceSkillFeedbackConsumers,
} from '../../src/services/secretary-source-skill-feedback-consumers';

const OWNER_USER_ID = 42;
const TENANT_ID = 'tenant-feedback-wave2';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  testDb.exec(fs.readFileSync(MIGRATION_098, 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
  testDb.exec(fs.readFileSync(MIGRATION_126, 'utf8'));
  _resetSecretaryFeedbackBusForTests();
  _resetSecretarySourceSkillFeedbackConsumersForTests();
  registerSecretarySourceSkillFeedbackConsumers();
});

afterEach(() => {
  testDb.close();
  _resetSecretaryFeedbackBusForTests();
  _resetSecretarySourceSkillFeedbackConsumersForTests();
});

function intent(sourceSkill: 'cooking' | 'finance' | 'content', intentId: string): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill,
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `${sourceSkill} schedule block`,
    requestedDurationMinutes: 90,
    minimumDurationMinutes: 45,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T09:00:00.000Z' }],
    priority: sourceSkill === 'finance' ? 'high' : 'normal',
    flexibility: 'compressible',
  };
}

describe('Wave 2 Secretary source-skill feedback consumers', () => {
  it.each(['cooking', 'finance', 'content'] as const)('persists %s feedback with tenant scope and hints', (sourceSkill) => {
    const decision = submitSecretarySchedulingIntent(intent(sourceSkill, `${sourceSkill}-1`));
    expect(decision.status).toBe('compressed');

    const records = listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      targetSkill: sourceSkill,
      agendaItemId: decision.agendaItem.agendaItemId,
      sourceIntentId: `${sourceSkill}-1`,
      status: 'compressed',
      shouldRefreshSource: true,
    });
    expect(records[0].hints).toContain('adapt_scope_to_available_time');
  });

  it('does not leak feedback across tenants', () => {
    submitSecretarySchedulingIntent(intent('content', 'content-private'));

    expect(listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: 'other-tenant',
      sourceSkill: 'content',
    })).toEqual([]);
  });

  it('dedupes repeated feedback for the same agenda item and source intent', () => {
    submitSecretarySchedulingIntent(intent('cooking', 'cooking-dedupe'));
    submitSecretarySchedulingIntent(intent('cooking', 'cooking-dedupe'));

    const records = listSecretarySourceSkillFeedback({
      userId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      sourceSkill: 'cooking',
    });
    expect(records).toHaveLength(1);
  });
});

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
const MIGRATION_280 = path.resolve(
  __dirname,
  '../../migrations/280_secretary_agenda_arbitration_metadata.sql',
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
  computeSecretaryIntentArbitrationRank,
  getSecretaryAgendaItemById,
  listSecretaryAgendaItems,
  markSecretaryAgendaProviderSyncSatisfied,
  planSecretarySchedulingCapacity,
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
  testDb.exec(fs.readFileSync(MIGRATION_280, 'utf8'));
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

function contentLoserIntent(intentId: string, flexibility: 'fixed' | 'flexible' = 'flexible'): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'content',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `Content block ${intentId}`,
    requestedDurationMinutes: 60,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T09:00:00.000Z' }],
    priority: 'low',
    flexibility,
  };
}

function secretaryWinnerIntent(intentId: string): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'secretary',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `Urgent block ${intentId}`,
    requestedDurationMinutes: 60,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T09:00:00.000Z' }],
    priority: 'urgent',
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

  it('discloses one exact safe preemption candidate in preview while submit remains hard-busy', () => {
    const loser = submitSecretarySchedulingIntent(contentLoserIntent('content-low'));
    const syncedLoser = markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-content-low',
      providerSource: 'google',
      now: '2026-05-19T08:00:00.000Z',
    });
    const winner = secretaryWinnerIntent('secretary-urgent');
    const exactLiveWindow = {
      start: '2026-05-20T08:00:00.000Z',
      end: '2026-05-20T09:00:00.000Z',
      label: 'Content block',
      providerIdentity: {
        providerEventId: 'google-content-low',
        providerSource: 'google' as const,
        ownerUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        agendaItemId: loser.agendaItem.agendaItemId,
        trainingIdentity: null,
      },
    };

    const purePlan = planSecretarySchedulingCapacity({
      intent: winner,
      localAgendaItems: [syncedLoser!],
      additionalBusyWindows: [exactLiveWindow],
    });
    expect(purePlan.hardBusyWindows).toHaveLength(2);
    expect(purePlan.previewBusyWindows).toHaveLength(0);
    expect(purePlan.preemptionCandidates).toHaveLength(1);

    const preview = previewSecretarySchedulingIntent(winner, {
      additionalBusyWindows: [exactLiveWindow],
    });
    expect(preview).toMatchObject({
      status: 'scheduled',
      wouldPreempt: true,
      preemptedCount: 1,
    });
    expect(preview.reasonCodes).toContain('priority_preemption_candidate');

    const submit = submitSecretarySchedulingIntent(winner, {
      additionalBusyWindows: [exactLiveWindow],
    });
    // Temporary Stage 1 policy: submit invokes the same pure plan but keeps
    // the candidate hard until loser versioning + provider fencing land.
    expect(submit.status).toBe('unscheduled');
    expect(submit.selectedSlot).toBeNull();
    expect(submit.reasonCodes).not.toContain('priority_preemption_candidate');
    expect(getSecretaryAgendaItemById({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
    })).toMatchObject({
      lifecycleState: 'synced',
      providerEventId: 'google-content-low',
      providerSource: 'google',
    });
  });

  it('does not disclose a candidate when preview chooses an unrelated free slot', () => {
    const loserIntent = contentLoserIntent('content-later');
    loserIntent.preferredWindows = [{
      start: '2026-05-20T09:00:00.000Z',
      end: '2026-05-20T10:00:00.000Z',
    }];
    const loser = submitSecretarySchedulingIntent(loserIntent);
    markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'google-content-later',
      providerSource: 'google',
    });
    const winner = secretaryWinnerIntent('secretary-safe-first');
    winner.preferredWindows = [{
      start: '2026-05-20T08:00:00.000Z',
      end: '2026-05-20T10:00:00.000Z',
    }];

    const preview = previewSecretarySchedulingIntent(winner, {
      additionalBusyWindows: [{
        start: '2026-05-20T09:00:00.000Z',
        end: '2026-05-20T10:00:00.000Z',
        providerIdentity: {
          providerEventId: 'google-content-later',
          providerSource: 'google',
          ownerUserId: OWNER_USER_ID,
          tenantId: TENANT_ID,
          agendaItemId: loser.agendaItem.agendaItemId,
          trainingIdentity: null,
        },
      }],
    });

    expect(preview.recommendedSlot).toMatchObject({
      start: '2026-05-20T08:00:00.000Z',
      end: '2026-05-20T09:00:00.000Z',
    });
    expect(preview).not.toHaveProperty('wouldPreempt');
    expect(preview).not.toHaveProperty('preemptedCount');
    expect(preview.reasonCodes).not.toContain('priority_preemption_candidate');
  });

  it('keeps incomplete, fixed, equal-or-higher, unmarked, ambiguous, and foreign identities hard', () => {
    const loser = submitSecretarySchedulingIntent(contentLoserIntent('guarded-loser'));
    const synced = markSecretaryAgendaProviderSyncSatisfied({
      agendaItemId: loser.agendaItem.agendaItemId,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      providerEventId: 'outlook-guarded-loser',
      providerSource: 'outlook',
    })!;
    const winner = secretaryWinnerIntent('guarded-winner');
    const currentRank = computeSecretaryIntentArbitrationRank(winner);
    const exactIdentity = {
      providerEventId: 'outlook-guarded-loser',
      providerSource: 'outlook' as const,
      ownerUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      agendaItemId: synced.agendaItemId,
      trainingIdentity: null,
    };
    const liveWindow = {
      start: synced.startAt!,
      end: synced.endAt!,
      providerIdentity: exactIdentity,
    };
    const cases = [
      {
        name: 'legacy NULL rank',
        item: { ...synced, arbitrationScore: null },
        windows: [liveWindow],
      },
      {
        name: 'fixed loser',
        item: { ...synced, arbitrationFlexibility: 'fixed' as const },
        windows: [liveWindow],
      },
      {
        name: 'equal full rank',
        item: {
          ...synced,
          sourceIntentId: winner.intentId,
          arbitrationScore: currentRank.score,
          arbitrationDeadlineAt: currentRank.deadlineAt,
        },
        windows: [liveWindow],
      },
      {
        name: 'higher-ranked loser',
        item: { ...synced, arbitrationScore: currentRank.score + 1 },
        windows: [liveWindow],
      },
      {
        name: 'unmarked non-training event',
        item: synced,
        windows: [{ ...liveWindow, providerIdentity: { ...exactIdentity, agendaItemId: null } }],
      },
      {
        name: 'foreign tenant event',
        item: synced,
        windows: [{ ...liveWindow, providerIdentity: { ...exactIdentity, tenantId: 'foreign-tenant' } }],
      },
      {
        name: 'provider source mismatch',
        item: synced,
        windows: [{
          ...liveWindow,
          providerIdentity: { ...exactIdentity, providerSource: 'google' as const },
        }],
      },
      {
        name: 'ambiguous duplicate provider event',
        item: synced,
        windows: [liveWindow, { ...liveWindow }],
      },
      {
        name: 'non-synced durable state',
        item: { ...synced, providerSyncState: 'update_failed' as const },
        windows: [liveWindow],
      },
      {
        name: 'explicitly hard live window',
        item: synced,
        windows: [{ ...liveWindow, hard: true }],
      },
      {
        name: 'same-skill loser',
        item: { ...synced, sourceSkill: winner.sourceSkill },
        windows: [liveWindow],
      },
      {
        name: 'Training row without strict plan/version/session marker',
        item: { ...synced, sourceSkill: 'training' as const, sourceIntentId: 'training:1:1:1' },
        windows: [liveWindow],
      },
      {
        name: 'unidentified provider event',
        item: synced,
        windows: [{ start: liveWindow.start, end: liveWindow.end }],
      },
    ];

    for (const scenario of cases) {
      const plan = planSecretarySchedulingCapacity({
        intent: winner,
        localAgendaItems: [scenario.item],
        additionalBusyWindows: scenario.windows,
      });
      expect(plan.preemptionCandidates, scenario.name).toHaveLength(0);
      expect(plan.previewBusyWindows.length, scenario.name).toBe(plan.hardBusyWindows.length);
    }

    const ambiguousLocalMapping = planSecretarySchedulingCapacity({
      intent: winner,
      localAgendaItems: [synced, { ...synced, agendaItemId: `${synced.agendaItemId}_duplicate` }],
      additionalBusyWindows: [liveWindow],
    });
    expect(ambiguousLocalMapping.preemptionCandidates, 'ambiguous local provider mapping').toHaveLength(0);
    expect(ambiguousLocalMapping.previewBusyWindows).toHaveLength(ambiguousLocalMapping.hardBusyWindows.length);
  });
});

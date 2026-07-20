// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return { ...actual, getDb: () => testDb };
});

import {
  cancelSecretaryAgendaItem,
  previewSecretarySchedulingIntent,
  submitSecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  transitionContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';
import {
  ContentScheduleError,
  confirmContentSchedulePreview,
  createContentSchedulePreview,
  getContentCalendar,
  type ContentScheduleDependencies,
} from '../../src/services/content-workspace-scheduling';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const OWNER: ContentWorkspaceScope = { tenantId: 501, userId: 501 };
const OTHER: ContentWorkspaceScope = { tenantId: 777, userId: 777 };
const NOW = '2032-07-17T08:00:00.000Z';
const ORIGINAL_WINDOW = {
  start: '2032-07-18T09:00:00.000Z',
  end: '2032-07-18T10:00:00.000Z',
};

describe('canonical Content calendar read model', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => testDb.close());

  it('combines target deadlines with Secretary-authoritative private work blocks', () => {
    const fixture = seedApprovedItem(OWNER, 'calendar-combined', '2032-07-19T16:00:00.000Z');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.itemId,
      workKind: 'review',
      durationMinutes: 60,
      preferredWindows: [ORIGINAL_WINDOW],
      idempotencyKey: 'calendar-combined-preview-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'calendar-combined-confirm-001',
      now: NOW,
    }, testDb);

    const binding = testDb.prepare(`
      SELECT secretary_agenda_item_id FROM content_schedule_bindings WHERE item_id = ?
    `).get(fixture.itemId) as { secretary_agenda_item_id: string };
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET start_at = '2032-07-20T13:00:00.000Z',
             end_at = '2032-07-20T14:00:00.000Z',
             updated_at = '2032-07-17T09:00:00.000Z'
       WHERE agenda_item_id = ?
    `).run(binding.secretary_agenda_item_id);

    const calendar = getContentCalendar({
      scope: OWNER,
      from: '2032-07-19T00:00:00.000Z',
      to: '2032-07-21T00:00:00.000Z',
    }, testDb);

    expect(calendar).toMatchObject({
      schemaVersion: 'content-calendar-v1',
      range: { semantics: 'from_inclusive_to_exclusive' },
      scheduleAuthority: { authority: 'secretary', status: 'current', unavailableEntryCount: 0 },
      publicationExecution: 'not_performed',
      explanation: expect.stringContaining('Neither publishes content'),
      hasMore: false,
    });
    expect(calendar.entries).toHaveLength(2);
    expect(calendar.entries[0]).toMatchObject({
      kind: 'deadline',
      meaning: 'target_date_not_publication',
      startsAt: '2032-07-19T16:00:00.000Z',
      endsAt: null,
      item: {
        id: fixture.itemId,
        title: fixture.title,
        status: 'approved',
        nextAction: { action: 'prepare_scheduled_work', label: 'Prepare for work block' },
      },
      publicationExecution: 'not_performed',
    });
    expect(calendar.entries[1]).toMatchObject({
      kind: 'work_block',
      meaning: 'private_work_time_not_publication',
      startsAt: '2032-07-20T13:00:00.000Z',
      endsAt: '2032-07-20T14:00:00.000Z',
      workKind: 'review',
      item: { id: fixture.itemId, title: fixture.title, status: 'approved' },
      schedule: {
        state: 'scheduled',
        authority: 'secretary',
        authorityStatus: 'current',
      },
      publicationExecution: 'not_performed',
    });
    const serialized = JSON.stringify(calendar);
    expect(serialized).not.toContain('agendaItemId');
    expect(serialized).not.toContain('secretaryAgendaItemId');
    expect(serialized).not.toContain('bindingId');
    expect(serialized).not.toContain('providerEventId');
    expect(serialized).not.toContain('contextShared');
  });

  it('enforces owner scope, half-open range boundaries, and the response limit', () => {
    const first = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'First deadline',
      deadlineAt: '2032-08-01T00:00:00.000Z',
      idempotencyKey: 'calendar-filter-first-001',
    }, testDb).value;
    const second = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'project',
      title: 'Second deadline',
      deadlineAt: '2032-08-02T00:00:00.000Z',
      idempotencyKey: 'calendar-filter-second-001',
    }, testDb).value;
    createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Exclusive upper boundary',
      deadlineAt: '2032-08-03T00:00:00.000Z',
      idempotencyKey: 'calendar-filter-upper-boundary-001',
    }, testDb);
    const other = seedApprovedItem(OTHER, 'calendar-filter-other-tenant', '2032-08-01T12:00:00.000Z');
    const otherPreview = createContentSchedulePreview({
      scope: OTHER,
      itemId: other.itemId,
      workKind: 'review',
      durationMinutes: 60,
      preferredWindows: [{
        start: '2032-08-01T09:00:00.000Z',
        end: '2032-08-01T10:00:00.000Z',
      }],
      idempotencyKey: 'calendar-filter-other-preview-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OTHER,
      previewKey: otherPreview.value.previewKey,
      idempotencyKey: 'calendar-filter-other-confirm-001',
      now: NOW,
    }, testDb);

    const limited = getContentCalendar({
      scope: OWNER,
      from: '2032-08-01T00:00:00.000Z',
      to: '2032-08-03T00:00:00.000Z',
      limit: 1,
    }, testDb);
    expect(limited.entries).toHaveLength(1);
    expect(limited.entries[0].item.id).toBe(first.id);
    expect(limited.hasMore).toBe(true);

    const full = getContentCalendar({
      scope: OWNER,
      from: '2032-08-01T00:00:00.000Z',
      to: '2032-08-03T00:00:00.000Z',
      limit: 10,
    }, testDb);
    expect(full.entries.map((entry) => entry.item.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(full)).not.toContain(other.title);
  });

  it('fails closed on invalid ranges and limits', () => {
    expect(() => getContentCalendar({
      scope: OWNER,
      from: 'not-a-date',
      to: '2032-08-03T00:00:00.000Z',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    }));
    expect(() => getContentCalendar({
      scope: OWNER,
      from: 'July 18, 2032',
      to: '2032-08-03T00:00:00.000Z',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_VALIDATION_FAILED',
    }));
    expect(() => getContentCalendar({
      scope: OWNER,
      from: '2032-02-31T00:00:00.000Z',
      to: '2032-08-03T00:00:00.000Z',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_VALIDATION_FAILED',
    }));
    expect(() => getContentCalendar({
      scope: OWNER,
      from: '2032-08-03T00:00:00.000Z',
      to: '2032-08-03T00:00:00.000Z',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_VALIDATION_FAILED',
    }));
    expect(() => getContentCalendar({
      scope: OWNER,
      from: '2032-01-01T00:00:00.000Z',
      to: '2033-01-03T00:00:00.000Z',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_CALENDAR_RANGE_TOO_LARGE',
    }));
    expect(() => getContentCalendar({
      scope: OWNER,
      from: '2032-08-01T00:00:00.000Z',
      to: '2032-08-03T00:00:00.000Z',
      limit: 501,
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_VALIDATION_FAILED',
    }));
  });

  it('keeps a work block recoverable when Secretary authority cannot be read', () => {
    const fixture = seedApprovedItem(OWNER, 'calendar-authority-unavailable');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.itemId,
      workKind: 'write',
      durationMinutes: 60,
      preferredWindows: [ORIGINAL_WINDOW],
      idempotencyKey: 'calendar-authority-preview-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'calendar-authority-confirm-001',
      now: NOW,
    }, testDb);
    const unavailableDependencies: ContentScheduleDependencies = {
      preview: previewSecretarySchedulingIntent,
      submit: submitSecretarySchedulingIntent,
      getAgenda: () => { throw new Error('injected Secretary read failure'); },
      cancelAgenda: cancelSecretaryAgendaItem,
    };

    const calendar = getContentCalendar({
      scope: OWNER,
      from: '2032-07-18T00:00:00.000Z',
      to: '2032-07-19T00:00:00.000Z',
    }, testDb, unavailableDependencies);

    expect(calendar.scheduleAuthority).toEqual({
      authority: 'secretary',
      status: 'partially_unavailable',
      unavailableEntryCount: 1,
    });
    expect(calendar.entries).toEqual([
      expect.objectContaining({
        kind: 'work_block',
        startsAt: ORIGINAL_WINDOW.start,
        endsAt: ORIGINAL_WINDOW.end,
        schedule: expect.objectContaining({
          state: 'stale',
          authorityStatus: 'unavailable',
          recoverable: true,
          nextAction: 'reload_schedule',
        }),
      }),
    ]);
  });
});

function seedApprovedItem(
  scope: ContentWorkspaceScope,
  suffix: string,
  deadlineAt?: string,
): { itemId: number; title: string } {
  const title = `Private creator plan ${suffix}`;
  const created = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title,
    deadlineAt,
    idempotencyKey: `calendar-item-${suffix}-001`,
  }, testDb).value;
  createContentArtifact({
    scope,
    itemId: created.id,
    expectedWorkflowVersion: created.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `# Script ${suffix}\nUser-authored draft.` },
    idempotencyKey: `calendar-artifact-${suffix}-001`,
  }, testDb);
  let item = getContentWorkspaceItem(scope, created.id)!;
  item = transitionContentWorkspaceItem({
    scope,
    itemId: item.id,
    targetState: 'review',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `calendar-review-${suffix}-001`,
  }, testDb).value;
  transitionContentWorkspaceItem({
    scope,
    itemId: item.id,
    targetState: 'approved',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `calendar-approve-${suffix}-001`,
  }, testDb);
  return { itemId: created.id, title };
}

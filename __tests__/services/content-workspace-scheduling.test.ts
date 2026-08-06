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
  getSecretaryAgendaItemById,
  previewSecretarySchedulingIntent,
  submitSecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  ContentWorkspaceError,
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  getContentWorkspaceItemDetail,
  queryContentWorkspaceItems,
  saveContentRevision,
  softDeleteContentWorkspaceItem,
  transitionContentWorkspaceItem,
  type ContentArtifact,
  type ContentWorkspaceItem,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';
import {
  ContentScheduleError,
  cancelContentSchedule,
  confirmContentSchedulePreview,
  createContentSchedulePreview,
  getContentSchedule,
  type ContentScheduleDependencies,
} from '../../src/services/content-workspace-scheduling';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const OWNER: ContentWorkspaceScope = { tenantId: 501, userId: 501 };
const OTHER: ContentWorkspaceScope = { tenantId: 777, userId: 777 };
const NOW = '2032-07-17T08:00:00.000Z';
const WINDOW = { start: '2032-07-18T09:00:00.000Z', end: '2032-07-18T11:00:00.000Z' };

describe('canonical Content work scheduling', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => testDb.close());

  it('previews without persistence, hides the title by default, and confirms exactly once', () => {
    const fixture = seedApprovedContent('generic');
    const agendaBefore = agendaCount();
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      priority: 'high',
      idempotencyKey: 'schedule-preview-generic-001',
      now: NOW,
    }, testDb);

    expect(preview).toMatchObject({ replayed: false, changed: true });
    expect(preview.value).toMatchObject({
      status: 'ready',
      visibleTitle: 'Content work: Record',
      titleDisclosure: 'generic',
      publicationExecution: 'not_performed',
    });
    expect(preview.value.contextShared).not.toContain('script_text');
    expect(preview.value.contextShared).not.toContain('content_title');
    expect(agendaCount()).toBe(agendaBefore);
    const stored = testDb.prepare(`
      SELECT intent_json FROM content_schedule_previews WHERE preview_key = ?
    `).get(preview.value.previewKey) as { intent_json: string };
    expect(stored.intent_json).not.toContain(fixture.item.title);

    const replay = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      priority: 'high',
      idempotencyKey: 'schedule-preview-generic-001',
      now: NOW,
    }, testDb);
    expect(replay).toMatchObject({ replayed: true, changed: false });
    expect(agendaCount()).toBe(agendaBefore);

    const confirmed = confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-generic-001',
      now: NOW,
    }, testDb);
    const confirmReplay = confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-generic-001',
      now: NOW,
    }, testDb);

    expect(confirmed).toMatchObject({ replayed: false, changed: true });
    expect(confirmed.value).toMatchObject({
      state: 'scheduled',
      localAgendaState: 'scheduled',
      providerSyncState: 'pending',
      publicationExecution: 'not_performed',
      contentChangedSinceScheduling: false,
    });
    expect(confirmReplay).toMatchObject({ replayed: true, changed: false });
    expect(agendaCount()).toBe(agendaBefore + 1);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings').get())
      .toEqual({ count: 1 });
    const workspaceItem = getContentWorkspaceItem(OWNER, fixture.item.id, testDb)!;
    const listedItem = queryContentWorkspaceItems({ scope: OWNER }, testDb).items
      .find((item) => item.id === fixture.item.id)!;
    const detailedItem = getContentWorkspaceItemDetail(OWNER, fixture.item.id, testDb)!;
    expect(workspaceItem).toMatchObject({
      productionState: 'approved',
      nextAction: { action: 'prepare_scheduled_work', label: 'Prepare for work block' },
      workSchedule: {
        schemaVersion: 'content-work-schedule-summary-v1',
        state: 'scheduled',
        workKind: 'record',
        scheduledStart: WINDOW.start,
        scheduledEnd: '2032-07-18T10:00:00.000Z',
        providerSyncState: 'pending',
        authority: 'secretary',
        authorityStatus: 'current',
        contentChangedSinceScheduling: false,
        publicationExecution: 'not_performed',
      },
    });
    expect(listedItem.workSchedule).toEqual(workspaceItem.workSchedule);
    expect(listedItem.nextAction).toEqual(workspaceItem.nextAction);
    expect(detailedItem.workSchedule).toEqual(workspaceItem.workSchedule);
    expect(detailedItem.nextAction).toEqual(workspaceItem.nextAction);
    const serializedReadModels = JSON.stringify({ workspaceItem, listedItem, detailedItem });
    expect(serializedReadModels).not.toContain('agendaItemId');
    expect(serializedReadModels).not.toContain('sourceIntentId');
    expect(serializedReadModels).not.toContain('providerEventId');
    expect(serializedReadModels).not.toContain('bindingId');
    expect(serializedReadModels).not.toContain('previewKey');
    expect(confirmed.value).toMatchObject({ authority: 'secretary', authorityStatus: 'current' });
    expect(JSON.stringify(confirmed.value)).not.toContain('agendaItemId');
    expect(JSON.stringify(confirmed.value)).not.toContain('contentHash');
  });

  it('shares a private content title only after explicit opt-in', () => {
    const fixture = seedApprovedContent('title-consent');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 45,
      preferredWindows: [WINDOW],
      shareContentTitle: true,
      idempotencyKey: 'schedule-preview-title-consent-001',
      now: NOW,
    }, testDb);

    expect(preview.value.visibleTitle).toBe(fixture.item.title);
    expect(preview.value.titleDisclosure).toBe('content_title');
    expect(preview.value.contextShared).toContain('content_title');
  });

  it('schedules development work before approval while reserving release-readiness work for approved versions', () => {
    const item = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Develop this draft',
      idempotencyKey: 'schedule-development-item-001',
    }, testDb).value;
    createContentArtifact({
      scope: OWNER,
      itemId: item.id,
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'markdown', text: '# Early draft' },
      idempotencyKey: 'schedule-development-artifact-001',
    }, testDb);

    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: item.id,
      workKind: 'write',
      durationMinutes: 45,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-development-preview-001',
      now: NOW,
    }, testDb);
    const confirmed = confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-development-confirm-001',
      now: NOW,
    }, testDb);

    expect(confirmed.value.state).toBe('scheduled');
    expect(getContentWorkspaceItem(OWNER, item.id, testDb)?.productionState).toBe('active');

    const recordFixture = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'Not approved to record',
      idempotencyKey: 'schedule-record-gate-item-001',
    }, testDb).value;
    createContentArtifact({
      scope: OWNER,
      itemId: recordFixture.id,
      expectedWorkflowVersion: recordFixture.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'markdown', text: '# Not ready' },
      idempotencyKey: 'schedule-record-gate-artifact-001',
    }, testDb);
    expect(() => createContentSchedulePreview({
      scope: OWNER,
      itemId: recordFixture.id,
      workKind: 'record',
      durationMinutes: 45,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-record-gate-preview-001',
      now: NOW,
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_SCHEDULE_REQUIRES_APPROVAL',
    }));
  });

  it('replays preview idempotently after autosave and bounds an explicitly shared calendar title', () => {
    const fixture = seedApprovedContent('idempotent-autosave');
    const previewInput = {
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review' as const,
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-autosave-replay-001',
      now: NOW,
    };
    const preview = createContentSchedulePreview(previewInput, testDb);
    saveContentRevision({
      scope: OWNER,
      artifactId: fixture.artifact.id,
      baseRevision: fixture.artifact.currentRevision!.revisionNumber,
      content: { format: 'markdown', text: '# Autosaved after preview' },
      idempotencyKey: 'schedule-preview-autosave-revision-001',
    }, testDb);
    const replay = createContentSchedulePreview(previewInput, testDb);
    expect(replay).toMatchObject({ replayed: true, changed: false });
    expect(replay.value.previewKey).toBe(preview.value.previewKey);

    const longTitleItem = createContentWorkspaceItem({
      scope: OWNER,
      itemType: 'content_item',
      title: 'T'.repeat(240),
      idempotencyKey: 'schedule-long-title-item-001',
    }, testDb).value;
    createContentArtifact({
      scope: OWNER,
      itemId: longTitleItem.id,
      expectedWorkflowVersion: longTitleItem.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'markdown', text: '# Long title script' },
      idempotencyKey: 'schedule-long-title-artifact-001',
    }, testDb);
    const longTitlePreview = createContentSchedulePreview({
      scope: OWNER,
      itemId: longTitleItem.id,
      workKind: 'write',
      durationMinutes: 30,
      preferredWindows: [WINDOW],
      shareContentTitle: true,
      idempotencyKey: 'schedule-long-title-preview-001',
      now: NOW,
    }, testDb);
    expect(Array.from(longTitlePreview.value.visibleTitle)).toHaveLength(200);
    expect(longTitlePreview.value.visibleTitle.endsWith('…')).toBe(true);
  });

  it('preserves a newer user revision and refuses a stale confirmation before Secretary writes', () => {
    const fixture = seedApprovedContent('stale');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'revise',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-stale-001',
      now: NOW,
    }, testDb);
    const agendaBefore = agendaCount();
    const saved = saveContentRevision({
      scope: OWNER,
      artifactId: fixture.artifact.id,
      baseRevision: fixture.artifact.currentRevision!.revisionNumber,
      content: { format: 'markdown', text: '# User edit\nThis edit must survive stale confirmation.' },
      idempotencyKey: 'schedule-stale-user-edit-001',
    }, testDb).value;

    expect(() => confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-stale-001',
      now: NOW,
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_SCHEDULE_PREVIEW_STALE',
    }));
    expect(agendaCount()).toBe(agendaBefore);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings').get())
      .toEqual({ count: 0 });
    expect(testDb.prepare('SELECT status FROM content_schedule_previews WHERE preview_key = ?').get(preview.value.previewKey))
      .toEqual({ status: 'stale' });
    expect(fixture.artifact.id).toBe(saved.artifactId);
  });

  it('blocks direct scheduled and published state claims without their evidence flows', () => {
    const fixture = seedApprovedContent('direct-state');
    const current = getContentWorkspaceItem(OWNER, fixture.item.id, testDb)!;
    expect(() => transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: fixture.item.id,
      targetState: 'scheduled',
      expectedWorkflowVersion: current.workflowVersion,
      idempotencyKey: 'direct-schedule-without-binding-001',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED',
    }));

    testDb.prepare(`
      UPDATE content_domain_objects
         SET production_state = 'scheduled', lifecycle_state = 'scheduled'
       WHERE id = ?
    `).run(fixture.item.id);
    const scheduled = getContentWorkspaceItem(OWNER, fixture.item.id, testDb)!;
    expect(() => transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: fixture.item.id,
      targetState: 'published',
      expectedWorkflowVersion: scheduled.workflowVersion,
      idempotencyKey: 'direct-publish-without-confirmation-001',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED',
    }));
  });

  it('projects provider failures separately and cancels local schedules idempotently', () => {
    const fixture = seedApprovedContent('cancel');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'edit',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-cancel-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-cancel-001',
      now: NOW,
    }, testDb);
    const agenda = testDb.prepare(`
      SELECT secretary_agenda_item_id FROM content_schedule_bindings WHERE item_id = ?
    `).get(fixture.item.id) as { secretary_agenda_item_id: string };
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET provider_sync_state = 'create_failed'
       WHERE agenda_item_id = ?
    `).run(agenda.secretary_agenda_item_id);
    expect(getContentSchedule(OWNER, fixture.item.id, testDb)).toMatchObject({
      state: 'sync_failed',
      providerSyncState: 'failed',
      nextAction: 'wait_for_provider_sync',
    });
    expect(getContentWorkspaceItem(OWNER, fixture.item.id, testDb)).toMatchObject({
      productionState: 'approved',
      workSchedule: {
        state: 'sync_failed',
        providerSyncState: 'failed',
        recoverable: true,
        publicationExecution: 'not_performed',
      },
      nextAction: { action: 'recover_work_schedule', label: 'Recover work block' },
    });

    const cancelled = cancelContentSchedule({
      scope: OWNER,
      itemId: fixture.item.id,
      idempotencyKey: 'schedule-cancel-local-001',
      now: NOW,
    }, testDb);
    const replay = cancelContentSchedule({
      scope: OWNER,
      itemId: fixture.item.id,
      idempotencyKey: 'schedule-cancel-local-001',
      now: NOW,
    }, testDb);
    expect(cancelled.value).toMatchObject({ state: 'cancelled', localAgendaState: 'cancelled' });
    expect(replay).toMatchObject({ replayed: true, changed: false });
    expect(getContentWorkspaceItem(OWNER, fixture.item.id, testDb)).toMatchObject({
      productionState: 'approved',
      workSchedule: null,
      nextAction: { action: 'schedule_work' },
    });
  });

  it('binds the live Secretary state atomically and rolls back a rejected post-submit result', () => {
    const advanced = seedApprovedContent('provider-advance');
    const advancedPreview = createContentSchedulePreview({
      scope: OWNER,
      itemId: advanced.item.id,
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-provider-advance-001',
      now: NOW,
    }, testDb);
    const advancingDependencies: ContentScheduleDependencies = {
      preview: previewSecretarySchedulingIntent,
      submit: (intent, options) => {
        const decision = submitSecretarySchedulingIntent(intent, options);
        // Stronger provider-boundary guarantee: simulated provider success
        // must pin the immutable target in the same write as the source.
        testDb.prepare(`
          UPDATE secretary_agenda_items
             SET lifecycle_state = 'synced', provider_sync_state = 'synced',
                 provider_event_id = 'provider-event-advance', provider_source = 'google',
                 provider_target = 'google'
           WHERE agenda_item_id = ?
        `).run(decision.agendaItem.agendaItemId);
        return decision;
      },
      getAgenda: getSecretaryAgendaItemById,
      cancelAgenda: cancelSecretaryAgendaItem,
    };
    const confirmed = confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: advancedPreview.value.previewKey,
      idempotencyKey: 'schedule-confirm-provider-advance-001',
      now: NOW,
    }, testDb, advancingDependencies);
    expect(confirmed.value).toMatchObject({
      state: 'provider_synced',
      providerSyncState: 'synced',
      authorityStatus: 'current',
    });

    const rejected = seedApprovedContent('post-submit-rollback');
    const rejectedPreview = createContentSchedulePreview({
      scope: OWNER,
      itemId: rejected.item.id,
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [{ start: '2032-07-19T09:00:00.000Z', end: '2032-07-19T11:00:00.000Z' }],
      idempotencyKey: 'schedule-preview-post-submit-rollback-001',
      now: NOW,
    }, testDb);
    const before = agendaCount();
    const rejectingDependencies: ContentScheduleDependencies = {
      preview: previewSecretarySchedulingIntent,
      submit: (intent, options) => {
        const decision = submitSecretarySchedulingIntent(intent, options);
        testDb.prepare('UPDATE secretary_agenda_items SET title = ? WHERE agenda_item_id = ?')
          .run('Unexpected title', decision.agendaItem.agendaItemId);
        return decision;
      },
      getAgenda: getSecretaryAgendaItemById,
      cancelAgenda: cancelSecretaryAgendaItem,
    };
    expect(() => confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: rejectedPreview.value.previewKey,
      idempotencyKey: 'schedule-confirm-post-submit-rollback-001',
      now: NOW,
    }, testDb, rejectingDependencies)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_SECRETARY_CONFIRMATION_MISMATCH',
    }));
    expect(agendaCount()).toBe(before);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings WHERE item_id = ?')
      .get(rejected.item.id)).toEqual({ count: 0 });
    expect(testDb.prepare('SELECT status FROM content_schedule_previews WHERE preview_key = ?')
      .get(rejectedPreview.value.previewKey)).toEqual({ status: 'failed' });
  });

  it('persists a recoverable preview when non-transactional Secretary cleanup cannot be verified', () => {
    const fixture = seedApprovedContent('recovery-obligation');
    const recoveryWindow = { start: '2032-07-23T09:00:00.000Z', end: '2032-07-23T10:00:00.000Z' };
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 60,
      preferredWindows: [recoveryWindow],
      idempotencyKey: 'schedule-preview-recovery-obligation-001',
      now: NOW,
    }, testDb);
    const stored = testDb.prepare('SELECT intent_json FROM content_schedule_previews WHERE preview_key = ?')
      .get(preview.value.previewKey) as { intent_json: string };
    const intent = JSON.parse(stored.intent_json);
    const externalDecision = submitSecretarySchedulingIntent({
      ...intent,
      action: 'schedule_this',
      preferredWindows: [{ ...recoveryWindow, hard: true }],
      requestedDurationMinutes: 60,
      minimumDurationMinutes: 60,
      flexibility: 'fixed',
    }, { now: NOW });
    testDb.prepare('UPDATE secretary_agenda_items SET title = ? WHERE agenda_item_id = ?')
      .run('Mismatched external title', externalDecision.agendaItem.agendaItemId);
    const nonTransactionalDependencies: ContentScheduleDependencies = {
      preview: previewSecretarySchedulingIntent,
      submit: () => externalDecision,
      getAgenda: getSecretaryAgendaItemById,
      cancelAgenda: () => { throw new Error('injected external cleanup failure'); },
    };

    expect(() => confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-recovery-obligation-001',
      now: NOW,
    }, testDb, nonTransactionalDependencies)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_SCHEDULE_RECOVERY_REQUIRED',
    }));
    expect(testDb.prepare(`
      SELECT status, secretary_agenda_item_id, last_error_code
        FROM content_schedule_previews WHERE preview_key = ?
    `).get(preview.value.previewKey)).toEqual({
      status: 'failed',
      secretary_agenda_item_id: externalDecision.agendaItem.agendaItemId,
      last_error_code: 'CONTENT_SCHEDULE_RECOVERY_REQUIRED',
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_schedule_bindings WHERE item_id = ?')
      .get(fixture.item.id)).toEqual({ count: 0 });

    cancelSecretaryAgendaItem({
      agendaItemId: externalDecision.agendaItem.agendaItemId,
      ownerUserId: OWNER.userId,
      tenantId: OWNER.tenantId,
      reason: 'Test recovery cleanup',
      now: NOW,
    });
    const recovered = confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-recovery-obligation-001',
      now: NOW,
    }, testDb);
    expect(recovered.value.state).toBe('scheduled');
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM secretary_agenda_items
       WHERE source_intent_id = ?
         AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
    `).get(intent.intentId)).toEqual({ count: 1 });
  });

  it('projects the current Secretary version and cancels every active version', () => {
    const fixture = seedApprovedContent('secretary-version');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-secretary-version-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-secretary-version-001',
      now: NOW,
    }, testDb);
    const stored = testDb.prepare(`
      SELECT intent_json FROM content_schedule_previews WHERE preview_key = ?
    `).get(preview.value.previewKey) as { intent_json: string };
    const currentIntent = JSON.parse(stored.intent_json);
    const movedWindow = { start: '2032-07-20T14:00:00.000Z', end: '2032-07-20T15:00:00.000Z' };
    submitSecretarySchedulingIntent({
      ...currentIntent,
      action: 'reschedule_this',
      preferredWindows: [{ ...movedWindow, hard: true }],
      requestedDurationMinutes: 60,
      minimumDurationMinutes: 60,
      updatedAt: '2032-07-17T09:00:00.000Z',
    }, { now: '2032-07-17T09:00:00.000Z' });

    expect(getContentSchedule(OWNER, fixture.item.id, testDb)).toMatchObject({
      scheduledStart: movedWindow.start,
      scheduledEnd: movedWindow.end,
      state: 'scheduled',
      authorityStatus: 'current',
    });
    const cancelled = cancelContentSchedule({
      scope: OWNER,
      itemId: fixture.item.id,
      idempotencyKey: 'schedule-cancel-secretary-version-001',
      now: NOW,
    }, testDb);
    expect(cancelled.value.state).toBe('cancelled');
    const activeVersions = testDb.prepare(`
      SELECT COUNT(*) AS count FROM secretary_agenda_items
       WHERE source_intent_id = ?
         AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
    `).get(currentIntent.intentId) as { count: number };
    expect(activeVersions.count).toBe(0);
  });

  it('surfaces completion and blocks archive or trash until active work is cancelled', () => {
    const fixture = seedApprovedContent('lifecycle-guard');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-lifecycle-guard-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-lifecycle-guard-001',
      now: NOW,
    }, testDb);
    const current = getContentWorkspaceItem(OWNER, fixture.item.id, testDb)!;
    expect(() => transitionContentWorkspaceItem({
      scope: OWNER,
      itemId: current.id,
      targetState: 'archived',
      expectedWorkflowVersion: current.workflowVersion,
      idempotencyKey: 'schedule-archive-guard-001',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_SCHEDULE_CANCELLATION_REQUIRED',
    }));
    expect(() => softDeleteContentWorkspaceItem({
      scope: OWNER,
      itemId: current.id,
      expectedWorkflowVersion: current.workflowVersion,
      idempotencyKey: 'schedule-trash-guard-001',
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentWorkspaceError>>({
      code: 'CONTENT_SCHEDULE_CANCELLATION_REQUIRED',
    }));

    const agenda = testDb.prepare(`
      SELECT secretary_agenda_item_id FROM content_schedule_bindings WHERE item_id = ?
    `).get(fixture.item.id) as { secretary_agenda_item_id: string };
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'completed', completed_at = ?, updated_at = ?
       WHERE agenda_item_id = ?
    `).run('2032-07-18T11:00:00.000Z', '2032-07-18T11:00:00.000Z', agenda.secretary_agenda_item_id);
    expect(getContentSchedule(OWNER, fixture.item.id, testDb)).toMatchObject({
      state: 'completed',
      localAgendaState: 'completed',
      nextAction: 'none',
    });
    const nextPreview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 30,
      preferredWindows: [{ start: '2032-07-21T09:00:00.000Z', end: '2032-07-21T10:00:00.000Z' }],
      idempotencyKey: 'schedule-preview-after-completion-001',
      now: NOW,
    }, testDb);
    expect(nextPreview.value.status).toBe('ready');
    expect(testDb.prepare('SELECT state FROM content_schedule_bindings WHERE item_id = ? ORDER BY id DESC LIMIT 1')
      .get(fixture.item.id)).toEqual({ state: 'completed' });
  });

  it('does not claim an authoritative schedule when the bound Secretary record is unavailable', () => {
    const fixture = seedApprovedContent('authority-unavailable');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-authority-unavailable-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-authority-unavailable-001',
      now: NOW,
    }, testDb);
    const binding = testDb.prepare('SELECT secretary_agenda_item_id FROM content_schedule_bindings WHERE item_id = ?')
      .get(fixture.item.id) as { secretary_agenda_item_id: string };
    testDb.prepare('DELETE FROM secretary_agenda_items WHERE agenda_item_id = ?')
      .run(binding.secretary_agenda_item_id);

    expect(getContentSchedule(OWNER, fixture.item.id, testDb)).toMatchObject({
      state: 'stale',
      localAgendaState: 'stale',
      authority: 'secretary',
      authorityStatus: 'unavailable',
      nextAction: 'reload_schedule',
    });
  });

  it('keeps provider cleanup visible and blocks replacement schedules until cleanup is terminal', () => {
    const fixture = seedApprovedContent('provider-cleanup');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-provider-cleanup-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-provider-cleanup-001',
      now: NOW,
    }, testDb);
    const binding = testDb.prepare(`
      SELECT secretary_agenda_item_id FROM content_schedule_bindings WHERE item_id = ?
    `).get(fixture.item.id) as { secretary_agenda_item_id: string };
    // Stronger provider-boundary guarantee: the cleanup fixture must model a
    // mapping whose immutable target and observed source agree.
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET lifecycle_state = 'synced', provider_sync_state = 'synced',
             provider_event_id = 'provider-cleanup-event', provider_source = 'google',
             provider_target = 'google'
       WHERE agenda_item_id = ?
    `).run(binding.secretary_agenda_item_id);
    const cancelled = cancelContentSchedule({
      scope: OWNER,
      itemId: fixture.item.id,
      idempotencyKey: 'schedule-cancel-provider-cleanup-001',
      now: NOW,
    }, testDb);
    expect(cancelled.value).toMatchObject({
      state: 'cancel_pending',
      providerSyncState: 'deletion_pending',
      nextAction: 'wait_for_provider_cleanup',
    });
    expect(getContentWorkspaceItem(OWNER, fixture.item.id, testDb)).toMatchObject({
      productionState: 'approved',
      workSchedule: {
        state: 'cancel_pending',
        providerSyncState: 'deletion_pending',
        recoverable: true,
        publicationExecution: 'not_performed',
      },
      nextAction: { action: 'view_work_schedule', label: 'View cancellation status' },
    });
    expect(() => createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 30,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-blocked-cleanup-001',
      now: NOW,
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_SCHEDULE_CLEANUP_PENDING',
    }));

    testDb.prepare(`
      UPDATE secretary_agenda_items SET provider_sync_state = 'deleted' WHERE agenda_item_id = ?
    `).run(binding.secretary_agenda_item_id);
    const replacement = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'review',
      durationMinutes: 30,
      preferredWindows: [{ start: '2032-07-22T09:00:00.000Z', end: '2032-07-22T10:00:00.000Z' }],
      idempotencyKey: 'schedule-preview-after-cleanup-001',
      now: NOW,
    }, testDb);
    expect(replacement.value.status).toBe('ready');
    expect(testDb.prepare('SELECT state FROM content_schedule_bindings WHERE item_id = ? ORDER BY id DESC LIMIT 1')
      .get(fixture.item.id)).toEqual({ state: 'cancelled' });
  });

  it('keeps cancellation failure visible and retryable without optimistic removal', () => {
    const fixture = seedApprovedContent('cancel-failure');
    const preview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'write',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-cancel-failure-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: preview.value.previewKey,
      idempotencyKey: 'schedule-confirm-cancel-failure-001',
      now: NOW,
    }, testDb);
    const failingDependencies: ContentScheduleDependencies = {
      preview: previewSecretarySchedulingIntent,
      submit: submitSecretarySchedulingIntent,
      getAgenda: getSecretaryAgendaItemById,
      cancelAgenda: () => { throw new Error('injected cancellation failure'); },
    };

    expect(() => cancelContentSchedule({
      scope: OWNER,
      itemId: fixture.item.id,
      idempotencyKey: 'schedule-cancel-failure-retry-001',
      now: NOW,
    }, testDb, failingDependencies)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_SCHEDULE_CANCELLATION_FAILED',
    }));
    expect(getContentSchedule(OWNER, fixture.item.id, testDb)).toMatchObject({
      state: 'cancel_failed',
      localAgendaState: 'cancellation_pending',
      providerSyncState: 'pending',
      nextAction: 'retry_cancellation',
    });
    expect(getContentWorkspaceItem(OWNER, fixture.item.id, testDb)).toMatchObject({
      productionState: 'approved',
      workSchedule: { state: 'cancel_failed', recoverable: true },
      nextAction: { action: 'cancel_work_schedule', label: 'Retry work-block cancellation' },
    });

    const retried = cancelContentSchedule({
      scope: OWNER,
      itemId: fixture.item.id,
      idempotencyKey: 'schedule-cancel-failure-retry-001',
      now: NOW,
    }, testDb);
    expect(retried.value.state).toBe('cancelled');
  });

  it('enforces tenant isolation for preview, schedule reads, and cancellation', () => {
    const fixture = seedApprovedContent('tenant');
    const ownerPreview = createContentSchedulePreview({
      scope: OWNER,
      itemId: fixture.item.id,
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-owner-tenant-001',
      now: NOW,
    }, testDb);
    confirmContentSchedulePreview({
      scope: OWNER,
      previewKey: ownerPreview.value.previewKey,
      idempotencyKey: 'schedule-confirm-owner-tenant-001',
      now: NOW,
    }, testDb);
    expect(() => createContentSchedulePreview({
      scope: OTHER,
      itemId: fixture.item.id,
      workKind: 'record',
      durationMinutes: 60,
      preferredWindows: [WINDOW],
      idempotencyKey: 'schedule-preview-other-tenant-001',
      now: NOW,
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_ITEM_NOT_FOUND',
    }));
    expect(getContentSchedule(OTHER, fixture.item.id, testDb)).toBeNull();
    expect(getContentWorkspaceItem(OTHER, fixture.item.id, testDb)).toBeNull();
    expect(queryContentWorkspaceItems({ scope: OTHER }, testDb).items).toEqual([]);
    expect(() => cancelContentSchedule({
      scope: OTHER,
      itemId: fixture.item.id,
      idempotencyKey: 'schedule-cancel-other-tenant-001',
      now: NOW,
    }, testDb)).toThrowError(expect.objectContaining<Partial<ContentScheduleError>>({
      code: 'CONTENT_SCHEDULE_NOT_FOUND',
    }));
  });
});

function seedApprovedContent(suffix: string): { item: ContentWorkspaceItem; artifact: ContentArtifact } {
  const created = createContentWorkspaceItem({
    scope: OWNER,
    itemType: 'content_item',
    title: `Private creator plan ${suffix}`,
    idempotencyKey: `schedule-item-${suffix}-001`,
  }, testDb).value;
  const artifact = createContentArtifact({
    scope: OWNER,
    itemId: created.id,
    expectedWorkflowVersion: created.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `# Script ${suffix}\nUser-authored draft.` },
    idempotencyKey: `schedule-artifact-${suffix}-001`,
  }, testDb).value;
  let item = getContentWorkspaceItem(OWNER, created.id, testDb)!;
  item = transitionContentWorkspaceItem({
    scope: OWNER,
    itemId: item.id,
    targetState: 'review',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `schedule-review-${suffix}-001`,
  }, testDb).value;
  item = transitionContentWorkspaceItem({
    scope: OWNER,
    itemId: item.id,
    targetState: 'approved',
    expectedWorkflowVersion: item.workflowVersion,
    idempotencyKey: `schedule-approve-${suffix}-001`,
  }, testDb).value;
  return { item, artifact };
}

function agendaCount(): number {
  return Number((testDb.prepare(`
    SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE source_skill = 'content'
  `).get() as { count: number }).count);
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;
const cacheMocks = vi.hoisted(() => ({
  invalidateContentDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/cache-coherence-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/cache-coherence-registry')>()),
  invalidateContentDerivedCaches: (...args: unknown[]) => cacheMocks.invalidateContentDerivedCaches(...args),
}));

import {
  ContentEditorialCompatibilityError,
  buildContentSecretarySchedulingIntent,
  convertRadarSignalToIdea,
  createContentWorkflowObject,
  decideContentApproval,
  evaluateContentApprovalRequirements,
  getContentWorkflowObject,
  listContentApprovalRecords,
  listContentWorkflowEvents,
  repurposeContentWorkflowObject,
  requestContentScheduleThroughSecretary,
  reviewContentSources,
  transitionContentWorkflow,
} from '../../src/services/content-editorial-workflow';

const OWNER = { userId: 501, tenantId: 501 };

describe('deprecated editorial workflow compatibility facade', () => {
  beforeEach(() => {
    cacheMocks.invalidateContentDerivedCaches.mockClear();
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => testDb.close());

  it('creates one canonical item and typed artifact idempotently without a parallel editorial root', () => {
    const input = {
      ...OWNER,
      objectType: 'script',
      title: 'Safe compatibility draft',
      editorialState: 'drafted' as const,
      content: { format: 'markdown' as const, text: '# Hook\nA user-authored draft.' },
      idempotencyKey: 'legacy-editorial-create-001',
    };
    const first = createContentWorkflowObject(input);
    const replay = createContentWorkflowObject(input);

    expect(first).toMatchObject({
      objectType: 'script',
      productionState: 'active',
      editorialState: 'drafted',
      artifactPhase: 'draft',
      approvalState: 'not_required',
    });
    expect(replay.id).toBe(first.id);
    expect(testDb.prepare('SELECT object_type FROM content_domain_objects WHERE id = ?').get(first.id))
      .toEqual({ object_type: 'content_item' });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_artifacts WHERE item_id = ?').get(first.id))
      .toEqual({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_revisions').get()).toEqual({ count: 1 });
  });

  it.each(['approved', 'scheduled', 'published'] as const)(
    'refuses to manufacture %s truth during compatibility creation',
    (editorialState) => {
      expect(() => createContentWorkflowObject({
        ...OWNER,
        objectType: 'script',
        title: `Unsafe ${editorialState}`,
        editorialState,
        idempotencyKey: `unsafe-${editorialState}-create-001`,
      })).toThrowError(expect.objectContaining<Partial<ContentEditorialCompatibilityError>>({
        code: 'CONTENT_EDITORIAL_CREATE_STATE_UNSUPPORTED',
      }));
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_domain_objects WHERE title = ?').get(`Unsafe ${editorialState}`))
        .toEqual({ count: 0 });
    },
  );

  it('requires explicit CAS, idempotency, and confirmation before archiving a draft', () => {
    const draft = createDraft('archive-draft-create-001');
    const missing = transitionContentWorkflow({ ...OWNER, objectId: draft.id, action: 'archive' });
    expect(missing).toMatchObject({ ok: false, status: 'approval_required' });
    expect(getContentWorkflowObject(OWNER.userId, draft.id, OWNER.tenantId)?.productionState).toBe('active');

    const missingConcurrency = transitionContentWorkflow({
      ...OWNER,
      objectId: draft.id,
      action: 'archive',
      approvalConfirmed: true,
    });
    expect(missingConcurrency).toMatchObject({ ok: false, status: 'replacement_required' });
    expect(transitionContentWorkflow({
      ...OWNER,
      objectId: draft.id,
      action: 'archive',
      approvalConfirmed: true,
      expectedWorkflowVersion: draft.workflowVersion,
      idempotencyKey: 'archive-key\u0085hidden',
    })).toMatchObject({ ok: false, status: 'replacement_required' });
    expect(transitionContentWorkflow({
      ...OWNER,
      objectId: draft.id,
      action: 'archive',
      approvalConfirmed: true,
      expectedWorkflowVersion: Number.MAX_SAFE_INTEGER + 1,
      idempotencyKey: 'archive-unsafe-version-001',
    })).toMatchObject({ ok: false, status: 'replacement_required' });

    const archived = transitionContentWorkflow({
      ...OWNER,
      objectId: draft.id,
      action: 'archive',
      approvalConfirmed: true,
      expectedWorkflowVersion: draft.workflowVersion,
      idempotencyKey: 'archive-draft-transition-001',
    });
    const replay = transitionContentWorkflow({
      ...OWNER,
      objectId: draft.id,
      action: 'archive',
      approvalConfirmed: true,
      expectedWorkflowVersion: draft.workflowVersion,
      idempotencyKey: 'archive-draft-transition-001',
    });
    expect(archived).toMatchObject({ ok: true, status: 'transitioned', object: { productionState: 'archived' } });
    expect(replay).toMatchObject({ ok: true, reasonCodes: ['canonical_idempotent_replay'] });
  });

  it('bridges only an explicit content_review decision through canonical revision/lineage checks', () => {
    const review = createContentWorkflowObject({
      ...OWNER,
      objectType: 'script',
      title: 'Decision Center review',
      editorialState: 'reviewed',
      content: { format: 'plain_text', text: 'A saved user-authored script.' },
      idempotencyKey: 'decision-review-create-001',
    });
    expect(review).toMatchObject({ productionState: 'review', approvalState: 'required' });

    const ambiguous = decideContentApproval({
      ...OWNER,
      objectId: review.id,
      decision: 'approved',
      expectedWorkflowVersion: review.workflowVersion,
      idempotencyKey: 'decision-review-ambiguous-001',
    });
    expect(ambiguous).toMatchObject({ ok: false, status: 'replacement_required' });

    const approved = decideContentApproval({
      ...OWNER,
      objectId: review.id,
      approvalType: 'content_review',
      decision: 'approved',
      expectedWorkflowVersion: review.workflowVersion,
      idempotencyKey: 'decision-review-approve-001',
    });
    expect(approved).toMatchObject({ ok: true, status: 'approved', object: { productionState: 'approved', approvalState: 'approved' } });
    expect(listContentApprovalRecords({ ...OWNER, objectId: review.id })).toEqual([]);
    expect(listContentWorkflowEvents({ ...OWNER, objectId: review.id }).map((event) => event.action))
      .toContain('workspace_state_changed');
  });

  it.each([
    ['mark_published', 'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED'],
    ['schedule_content', 'CONTENT_WORKFLOW_SCHEDULING_MOVED'],
    ['convert_outline_to_script', 'CONTENT_ARTIFACT_WORKFLOW_MOVED'],
    ['delete_draft', 'CONTENT_DELETE_MOVED'],
    ['mark_stale', 'CONTENT_STALE_STATE_RETIRED'],
  ] as const)('fails closed for retired %s semantics without changing canonical truth', (action, code) => {
    const draft = createDraft(`retired-${action}-create-001`);
    const result = transitionContentWorkflow({
      ...OWNER,
      objectId: draft.id,
      action,
      approvalConfirmed: true,
      expectedWorkflowVersion: draft.workflowVersion,
      idempotencyKey: `retired-${action}-mutation-001`,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 'replacement_required',
      replacement: { code, publicationExecution: 'not_performed' },
    });
    expect(getContentWorkflowObject(OWNER.userId, draft.id, OWNER.tenantId)).toMatchObject({
      productionState: 'active',
      secretaryIntentId: null,
      secretaryAgendaItemId: null,
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE source_skill = ?').get('content'))
      .toEqual({ count: 0 });
  });

  it('moves raw source review and repurpose payloads to exact revision/relationship contracts', () => {
    const draft = createDraft('moved-payload-create-001');
    expect(reviewContentSources({ ...OWNER, objectId: draft.id, claims: [{ id: 'claim', text: 'Unsupported' }] }))
      .toMatchObject({ ok: false, status: 'replacement_required', replacement: { code: 'CONTENT_SOURCE_REVIEW_MOVED' } });
    expect(repurposeContentWorkflowObject({
      ...OWNER,
      sourceObjectId: draft.id,
      title: 'Unsafe inferred derivative',
      transformationType: 'shorten',
    })).toMatchObject({
      ok: false,
      status: 'replacement_required',
      reusedObject: null,
      replacement: { code: 'CONTENT_REPURPOSE_MOVED' },
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_domain_objects').get()).toEqual({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_source_output_links').get()).toEqual({ count: 0 });
  });

  it('keeps the deprecated scheduling service incapable of creating a Secretary agenda item', () => {
    const draft = createDraft('schedule-service-create-001');
    const intent = buildContentSecretarySchedulingIntent({
      ...OWNER,
      objectId: draft.id,
      title: draft.title,
      durationMinutes: 45,
      preferredWindows: [{ start: '2031-01-01T10:00:00.000Z', end: '2031-01-01T11:00:00.000Z' }],
    });
    expect(intent).toMatchObject({
      sourceEntityType: 'content_workspace_item',
      sourceAction: 'schedule_content_work_block',
    });
    expect(() => requestContentScheduleThroughSecretary({
      ...OWNER,
      objectId: draft.id,
      title: draft.title,
      additionalBusyWindows: [],
    })).toThrowError(expect.objectContaining<Partial<ContentEditorialCompatibilityError>>({
      code: 'CONTENT_WORKFLOW_SCHEDULING_MOVED',
    }));
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM secretary_agenda_items WHERE source_skill = ?').get('content'))
      .toEqual({ count: 0 });
  });

  it('converts a scoped legacy radar signal into one canonical idea idempotently', () => {
    const radarId = Number(testDb.prepare(`
      INSERT INTO content_topic_feedback (
        user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
        scope_status, created_by, updated_by, topic, format, why_now,
        radar_lifecycle_state, audit_metadata_json
      ) VALUES (501, 501, 501, 'user_private', 'active', 'active', 501, 501,
                'A durable idea', 'reel', 'Captured from a signal', 'shortlisted', '{}')
    `).run().lastInsertRowid);
    const first = convertRadarSignalToIdea({ ...OWNER, radarSignalId: radarId });
    const replay = convertRadarSignalToIdea({ ...OWNER, radarSignalId: radarId });

    expect(first).toMatchObject({ ok: true, status: 'converted', object: { productionState: 'inbox', objectType: 'idea' } });
    expect(replay).toMatchObject({ ok: true, reasonCodes: ['canonical_idempotent_replay'], object: { id: first.object!.id } });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_domain_objects WHERE title = ?').get('A durable idea'))
      .toEqual({ count: 1 });
    expect(cacheMocks.invalidateContentDerivedCaches).toHaveBeenCalledOnce();
    expect(cacheMocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(OWNER.userId);
  });

  it('preserves pure approval-policy evaluation while tenant and owner reads fail closed', () => {
    const draft = createDraft('scope-policy-create-001');
    expect(evaluateContentApprovalRequirements({ action: 'mark_published' }).reasonCodes)
      .toContain('publish_requires_human_approval');
    expect(evaluateContentApprovalRequirements({ action: 'delete_draft', currentState: 'drafted' }).reasonCodes)
      .toContain('draft_removal_requires_confirmation');
    expect(getContentWorkflowObject(777, draft.id, OWNER.tenantId)).toBeNull();
    expect(getContentWorkflowObject(OWNER.userId, draft.id, 777)).toBeNull();
  });
});

function createDraft(idempotencyKey: string) {
  return createContentWorkflowObject({
    ...OWNER,
    objectType: 'script',
    title: idempotencyKey,
    editorialState: 'drafted',
    content: { format: 'plain_text', text: 'A saved draft that remains under user control.' },
    idempotencyKey,
  });
}

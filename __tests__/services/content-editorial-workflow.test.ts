import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let testDb: Database.Database;
const MIGRATION_083 = path.resolve(__dirname, '../../migrations/083_secretary_agenda_ledger.sql');

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import {
  buildContentSecretarySchedulingIntent,
  convertRadarSignalToIdea,
  createContentWorkflowObject,
  getContentWorkflowObject,
  listContentApprovalRecords,
  listContentWorkflowEvents,
  requestContentScheduleThroughSecretary,
  transitionContentWorkflow,
  type ContentWorkflowObject,
} from '../../src/services/content-editorial-workflow';
import { listSecretaryAgendaItems } from '../../src/services/secretary-scheduling-arbitrator';
import type { ContentRegisteredReference } from '../../src/services/content-reference-provenance';

function seedSchema(): void {
  testDb.exec(`
    CREATE TABLE content_topic_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      topic TEXT,
      reason TEXT,
      feedback_text TEXT,
      radar_lifecycle_state TEXT DEFAULT 'detected',
      converted_to_object_id INTEGER,
      converted_to_object_type TEXT,
      converted_at TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      audit_metadata_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function createDraft(overrides: Partial<Parameters<typeof createContentWorkflowObject>[0]> = {}): ContentWorkflowObject {
  return createContentWorkflowObject({
    userId: 501,
    tenantId: 101,
    objectType: 'script',
    title: 'Founder operating system script',
    editorialState: 'drafted',
    metadata: { contentGoal: 'teach one workflow' },
    ...overrides,
  });
}

function lowConfidenceReference(): ContentRegisteredReference {
  return {
    id: 1,
    referenceId: 'ref_low',
    tenantId: 101,
    ownerUserId: 501,
    visibilityScope: 'user_private',
    referenceType: 'link',
    sourceTable: 'content_reference_links',
    sourcePk: '1',
    sourceIdentifier: 'https://example.test/low-confidence',
    title: 'Low-confidence source',
    url: 'https://example.test/low-confidence',
    authorSource: 'Example',
    extractionStatus: 'ready',
    freshnessScore: 0.8,
    trustLevel: 'unverified',
    qualityScore: 0.4,
    confidenceScore: 0.42,
    topicTags: ['content'],
    relatedOutputIds: [],
    lastUsedAt: null,
    brokenStatus: 'ok',
    staleStatus: 'fresh',
    sourceSummary: 'Weak signal.',
    sourceSnippets: [],
    usableForGeneration: true,
    reviewRequired: true,
    rejectionReasons: ['low_confidence_source'],
  };
}

describe('Content editorial workflow lifecycle', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    seedSchema();
    testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  });

  afterEach(() => {
    testDb?.close();
  });

  it('transitions content artifacts through explicit lifecycle states and records events', () => {
    const idea = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      objectType: 'idea',
      title: 'Creator systems angle',
      editorialState: 'idea',
    });

    const outlined = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: idea.id,
      action: 'convert_idea_to_outline',
    });
    const drafted = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: idea.id,
      action: 'convert_outline_to_script',
    });

    expect(outlined).toMatchObject({ ok: true, status: 'transitioned', fromState: 'idea', toState: 'outlined' });
    expect(drafted).toMatchObject({ ok: true, status: 'transitioned', fromState: 'outlined', toState: 'drafted' });
    expect(drafted.object?.workflowVersion).toBe(3);
    expect(listContentWorkflowEvents({ userId: 501, tenantId: 101, objectType: 'idea', objectId: idea.id })
      .map((event) => event.action))
      .toEqual(['create', 'convert_idea_to_outline', 'convert_outline_to_script']);
  });

  it('rejects invalid lifecycle jumps instead of silently publishing rough ideas', () => {
    const idea = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      objectType: 'idea',
      title: 'Unreviewed idea',
      editorialState: 'idea',
    });

    const result = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: idea.id,
      action: 'mark_published',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('invalid_transition');
    expect(result.reasonCodes).toContain('invalid_lifecycle_transition');
    expect(transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: idea.id,
      action: 'convert_idea_to_outline',
    }).object?.editorialState).toBe('outlined');
  });

  it('requires human approval before publishing, then preserves approval evidence when confirmed', () => {
    const draft = createDraft();
    const approved = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: draft.id,
      action: 'approve_draft',
    });
    expect(approved.ok).toBe(true);
    expect(approved.object?.editorialState).toBe('approved');

    const blocked = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: draft.id,
      action: 'mark_published',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('approval_required');
    expect(blocked.reasonCodes).toContain('publish_requires_human_approval');
    expect(listContentApprovalRecords({ userId: 501, tenantId: 101, objectType: 'script', objectId: draft.id }))
      .toEqual([expect.objectContaining({ approval_type: 'publish', approval_state: 'required' })]);

    const published = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: draft.id,
      action: 'mark_published',
      approvalConfirmed: true,
    });

    expect(published.ok).toBe(true);
    expect(published.object?.editorialState).toBe('published');
    expect(listContentApprovalRecords({ userId: 501, tenantId: 101, objectType: 'script', objectId: draft.id }))
      .toEqual([expect.objectContaining({ approval_type: 'publish', approval_state: 'approved', approved_by: 501 })]);
  });

  it('requires approval before scheduling tenant-shared content and creates a Secretary scheduling intent when approved', () => {
    const item = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      visibilityScope: 'tenant_shared',
      objectType: 'content_calendar_item',
      title: 'Tenant launch story',
      editorialState: 'approved',
    });

    const blocked = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: item.id,
      action: 'schedule_content',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('approval_required');
    expect(blocked.reasonCodes).toContain('tenant_shared_scheduling_requires_approval');

    const scheduled = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: item.id,
      action: 'schedule_content',
      approvalConfirmed: true,
      reason: 'Schedule editorial production block.',
    });
    expect(scheduled.ok).toBe(true);
    expect(scheduled.object?.editorialState).toBe('scheduled');
    expect(scheduled.object?.secretaryIntentId).toBe(`content:${item.id}:schedule`);
    expect(scheduled.secretaryIntent).toMatchObject({
      sourceSkill: 'content',
      sourceAction: 'schedule_content_block',
      sourceEntityId: item.id,
      ownerUserId: 501,
      tenantId: 101,
    });
  });

  it('rejects approval confirmation from a non-owner actor on tenant-shared content', () => {
    const item = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      visibilityScope: 'tenant_shared',
      objectType: 'content_calendar_item',
      title: 'Shared launch story',
      editorialState: 'approved',
    });

    const result = transitionContentWorkflow({
      userId: 502,
      tenantId: 101,
      objectId: item.id,
      action: 'schedule_content',
      approvalConfirmed: true,
      actorUserId: 502,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('approval_required');
    expect(result.reasonCodes).toContain('approval_actor_not_authorized');
    expect(getContentWorkflowObject(501, item.id, 101)?.editorialState).toBe('approved');
  });

  it('requires review for low-confidence sources and unsupported claims', () => {
    const draft = createDraft();
    const blocked = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: draft.id,
      action: 'approve_draft',
      references: [lowConfidenceReference()],
      claims: [{ id: 'claim_1', text: 'This claim has no supporting reference.', supportedBy: [] }],
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('approval_required');
    expect(blocked.reasonCodes).toEqual(expect.arrayContaining([
      'low_confidence_source_requires_review',
      'unsupported_claim_requires_review',
    ]));
    expect(blocked.object?.editorialState).toBe('drafted');
  });

  it('does not silently delete drafts when removal needs confirmation', () => {
    const draft = createDraft();

    const blocked = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: draft.id,
      action: 'delete_draft',
    });
    const stillThere = transitionContentWorkflow({
      userId: 501,
      tenantId: 101,
      objectId: draft.id,
      action: 'approve_draft',
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('approval_required');
    expect(blocked.reasonCodes).toContain('draft_removal_requires_confirmation');
    expect(blocked.object?.editorialState).toBe('drafted');
    expect(stillThere.ok).toBe(true);
    expect(stillThere.object?.editorialState).toBe('approved');
  });

  it('converts a tenant-scoped radar signal to an idea with lineage metadata', () => {
    const radarId = Number(testDb.prepare(`
      INSERT INTO content_topic_feedback (
        tenant_id, owner_user_id, visibility_scope, scope_status, topic, reason,
        radar_lifecycle_state, created_by, updated_by
      )
      VALUES (101, 501, 'user_private', 'active', 'Film the planning reset', 'Strong audience fit', 'shortlisted', 501, 501)
    `).run().lastInsertRowid);

    const result = convertRadarSignalToIdea({
      userId: 501,
      tenantId: 101,
      radarSignalId: radarId,
    });
    const radar = testDb.prepare('SELECT * FROM content_topic_feedback WHERE id = ?').get(radarId) as any;

    expect(result.ok).toBe(true);
    expect(result.object).toMatchObject({
      objectType: 'idea',
      title: 'Film the planning reset',
      editorialState: 'idea',
    });
    expect(result.object?.metadata).toMatchObject({ generatedFromRadarSignalId: String(radarId) });
    expect(radar.radar_lifecycle_state).toBe('converted_to_idea');
    expect(radar.converted_to_object_id).toBe(result.object?.id);
  });

  it('blocks radar conversion visibility-scope elevation without explicit approval workflow', () => {
    const radarId = Number(testDb.prepare(`
      INSERT INTO content_topic_feedback (
        tenant_id, owner_user_id, visibility_scope, scope_status, topic, reason,
        radar_lifecycle_state, created_by, updated_by
      )
      VALUES (101, 501, 'user_private', 'active', 'Private creator note', 'Private signal', 'shortlisted', 501, 501)
    `).run().lastInsertRowid);

    const result = convertRadarSignalToIdea({
      userId: 501,
      tenantId: 101,
      radarSignalId: radarId,
      visibilityScope: 'tenant_shared',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('approval_required');
    expect(result.reasonCodes).toContain('visibility_scope_elevation_requires_explicit_approval');
    expect(testDb.prepare('SELECT converted_to_object_id FROM content_topic_feedback WHERE id = ?').get(radarId))
      .toEqual({ converted_to_object_id: null });
  });

  it('builds Secretary scheduling requests without letting Content own calendar placement', () => {
    const intent = buildContentSecretarySchedulingIntent({
      userId: 501,
      tenantId: 101,
      objectId: 44,
      title: 'Write launch post',
      durationMinutes: 75,
      preferredWindows: [{ start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T12:00:00.000Z' }],
      priority: 'high',
    });

    expect(intent).toMatchObject({
      intentId: 'content:44:schedule',
      action: 'find_time_for_this',
      sourceSkill: 'content',
      sourceAction: 'schedule_content_block',
      sourceEntityType: 'content_domain_object',
      ownerUserId: 501,
      tenantId: 101,
      requestedDurationMinutes: 75,
      priority: 'high',
    });
    expect(intent.context).toContain('Secretary owns schedule placement');
  });

  it('schedules Content work through the Secretary ledger and stores agenda identity on the Content object', () => {
    const item = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      objectType: 'content_calendar_item',
      title: 'Write launch post',
      editorialState: 'approved',
    });

    const decision = requestContentScheduleThroughSecretary({
      userId: 501,
      tenantId: 101,
      objectId: item.id,
      title: item.title,
      durationMinutes: 75,
      preferredWindows: [
        { start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T12:00:00.000Z', label: 'deep work' },
      ],
      priority: 'high',
      reason: 'Schedule approved editorial production block.',
      approvalConfirmed: true,
    });

    const updated = getContentWorkflowObject(501, item.id, 101);
    const agendaItems = listSecretaryAgendaItems({ ownerUserId: 501, tenantId: 101 });
    const events = listContentWorkflowEvents({ userId: 501, tenantId: 101, objectType: 'content_calendar_item', objectId: item.id });

    expect(decision.status).toBe('scheduled');
    expect(decision.selectedSlot).toEqual({
      start: '2026-05-01T10:00:00.000Z',
      end: '2026-05-01T11:15:00.000Z',
      label: 'deep work',
    });
    expect(decision.agendaItem).toMatchObject({
      sourceSkill: 'content',
      sourceIntentId: `content:${item.id}:schedule`,
      sourceEntityId: String(item.id),
      sourceEntityType: 'content_domain_object',
      ownerUserId: 501,
      tenantId: '101',
      lifecycleState: 'scheduled',
      providerSyncState: 'not_synced',
    });
    expect(updated).toMatchObject({
      editorialState: 'scheduled',
      secretaryIntentId: `content:${item.id}:schedule`,
      secretaryAgendaItemId: decision.agendaItem.agendaItemId,
    });
    expect(agendaItems).toHaveLength(1);
    expect(agendaItems[0].agendaItemId).toBe(decision.agendaItem.agendaItemId);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'schedule_content',
        secretary_intent_id: `content:${item.id}:schedule`,
      }),
    ]));
  });

  it('previews Content scheduling and does not persist an agenda item when no slot fits', () => {
    const item = createContentWorkflowObject({
      userId: 501,
      tenantId: 101,
      objectType: 'content_calendar_item',
      title: 'Cut launch reel',
      editorialState: 'approved',
    });

    const decision = requestContentScheduleThroughSecretary({
      userId: 501,
      tenantId: 101,
      objectId: item.id,
      title: item.title,
      durationMinutes: 75,
      minimumDurationMinutes: 75,
      preferredWindows: [
        { start: '2026-05-01T10:00:00.000Z', end: '2026-05-01T10:15:00.000Z', label: 'too short', hard: true },
      ],
      priority: 'high',
      reason: 'Schedule approved editorial production block.',
      approvalConfirmed: true,
    });

    const updated = getContentWorkflowObject(501, item.id, 101);
    const agendaItems = listSecretaryAgendaItems({ ownerUserId: 501, tenantId: 101 });

    expect(decision.status).toBe('unscheduled');
    expect(decision.selectedSlot).toBeNull();
    expect(updated).toMatchObject({
      editorialState: 'approved',
      secretaryAgendaItemId: null,
    });
    expect(agendaItems).toHaveLength(0);
  });

  it('denies workflow mutation outside the owner user scope', () => {
    const draft = createDraft();

    const result = transitionContentWorkflow({
      userId: 999,
      tenantId: 101,
      objectId: draft.id,
      action: 'approve_draft',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_found');
    expect(listContentWorkflowEvents({ userId: 999, tenantId: 101, objectId: draft.id })).toEqual([]);
  });
});

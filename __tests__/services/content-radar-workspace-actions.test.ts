import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { recordContentRadarWorkspaceAction } from '../../src/services/content-radar-workspace-actions';
import { saveContentRevision, softDeleteContentWorkspaceItem } from '../../src/services/content-workspace';

describe('content radar canonical workspace actions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('atomically saves a radar signal as a canonical idea and returns authoritative references', () => {
    const result = recordContentRadarWorkspaceAction({
      scope: { tenantId: 71, userId: 71 },
      signalId: 'radar-save-1',
      action: 'save',
      signalTopic: 'A timely creator-economy signal',
      signalSummary: 'A private summary chosen by the user.',
      reason: 'Keep for next week',
    }, db);

    expect(result).toMatchObject({
      schemaVersion: 'content-radar-workspace-action-v1',
      workspaceSchemaVersion: 'content-workspace-v1',
      feedback: {
        signalId: 'radar-save-1',
        action: 'save',
      },
      workspace: {
        item: {
          title: 'A timely creator-economy signal',
          productionState: 'inbox',
          artifactPhase: 'idea',
        },
        artifact: {
          artifactType: 'idea_note',
          currentRevision: {
            content: {
              format: 'plain_text',
              text: 'A timely creator-economy signal\n\nA private summary chosen by the user.',
            },
          },
        },
      },
      mutation: { replayed: false },
    });
    expect(result.workspace.revisionId).toBe(result.workspace.artifact.currentRevisionId);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM content_radar_feedback
       WHERE tenant_id = 71 AND owner_user_id = 71 AND signal_id = 'radar-save-1'
    `).get()).toEqual({ count: 1 });
  });

  it('creates a typed editable brief revision from the supplied iOS draft in the same transaction', () => {
    const result = recordContentRadarWorkspaceAction({
      scope: { tenantId: 72, userId: 72 },
      signalId: 'radar-brief-1',
      action: 'create_brief',
      signalTopic: 'Reaction angle',
      signalSummary: 'Source signal summary',
      brief: {
        objective: 'Turn the signal into a useful explainer.',
        audience: 'Independent creators',
        platform: 'youtube',
        format: 'long-form',
        angle: 'What changes for small teams',
        sourceMaterial: ['https://example.test/source'],
        mainPoints: ['What happened', 'Why it matters'],
        claims: ['Adoption increased'],
        cta: 'Save the checklist',
        constraints: 'Separate sourced facts from opinion.',
        deadline: '2026-07-20',
        approvalOwner: 'Felipe',
      },
    }, db);

    expect(result.workspace.item).toMatchObject({
      productionState: 'active',
      artifactPhase: 'brief',
      platformId: 'youtube',
      formatId: 'long-form',
    });
    expect(result.workspace.artifact).toMatchObject({
      artifactType: 'brief',
      platformId: 'youtube',
      formatId: 'long-form',
      currentRevision: {
        content: {
          format: 'markdown',
        },
      },
      metadata: {
        captureOrigin: 'reaction_radar',
        radarSignalId: 'radar-brief-1',
        radarAction: 'create_brief',
        briefSnapshot: {
          schemaVersion: 'content-brief-v1',
          objective: 'Turn the signal into a useful explainer.',
          audience: 'Independent creators',
          platform: 'youtube',
          format: 'long-form',
          angle: 'What changes for small teams',
          sourceMaterial: ['https://example.test/source'],
          mainPoints: ['What happened', 'Why it matters'],
          claims: ['Adoption increased'],
          cta: 'Save the checklist',
          constraints: 'Separate sourced facts from opinion.',
          deadline: '2026-07-20',
          approvalOwner: 'Felipe',
        },
      },
    });
    const markdown = result.workspace.artifact.currentRevision?.content;
    expect(markdown).toEqual({
      format: 'markdown',
      text: [
        '# Reaction angle',
        '',
        '## Objective', 'Turn the signal into a useful explainer.',
        '',
        '## Audience', 'Independent creators',
        '',
        '## Platform', 'youtube',
        '',
        '## Format', 'long-form',
        '',
        '## Angle', 'What changes for small teams',
        '',
        '## Source material', '- https://example.test/source',
        '',
        '## Main points', '- What happened\n- Why it matters',
        '',
        '## Claims to verify', '- Adoption increased',
        '',
        '## Call to action', 'Save the checklist',
        '',
        '## Constraints', 'Separate sourced facts from opinion.',
        '',
        '## Deadline', '2026-07-20',
        '',
        '## Approval owner', 'Felipe',
        '',
      ].join('\n'),
    });
    expect(result.workspace.artifact.metadata.briefSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.workspace.artifact.currentRevision?.provenance).toMatchObject({
      briefSnapshotHash: result.workspace.artifact.metadata.briefSnapshotHash,
    });
    const edited = saveContentRevision({
      scope: { tenantId: 72, userId: 72 },
      artifactId: result.workspace.artifact.id,
      baseRevision: 1,
      content: {
        format: 'markdown',
        text: `${(markdown as { format: 'markdown'; text: string }).text}\nUser-controlled edit.`,
      },
      actorType: 'user',
      actorId: '72',
      idempotencyKey: 'radar-brief-markdown-edit-001',
    }, db);
    expect(edited.value).toMatchObject({
      revisionNumber: 2,
      parentRevisionId: result.workspace.revisionId,
      content: {
        format: 'markdown',
        text: expect.stringContaining('User-controlled edit.'),
      },
    });
  });

  it('reconciles an interrupted response retry to the original workspace root without duplicates', () => {
    const first = recordContentRadarWorkspaceAction({
      scope: { tenantId: 73, userId: 73 },
      signalId: 'radar-retry-1',
      action: 'create_brief',
      signalTopic: 'Original signal title',
      signalSummary: 'Original summary',
    }, db);
    const replay = recordContentRadarWorkspaceAction({
      scope: { tenantId: 73, userId: 73 },
      signalId: 'radar-retry-1',
      action: 'create_brief',
      signalTopic: 'Title refreshed after the first response was lost',
      signalSummary: 'Refreshed summary',
    }, db);

    expect(replay.mutation.replayed).toBe(true);
    expect(replay.workspace.item.id).toBe(first.workspace.item.id);
    expect(replay.workspace.artifact.id).toBe(first.workspace.artifact.id);
    expect(replay.workspace.revisionId).toBe(first.workspace.revisionId);
    expect(replay.workspace.item.title).toBe('Original signal title');
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM content_radar_feedback WHERE tenant_id = 73 AND owner_user_id = 73) AS feedback_count,
        (SELECT COUNT(*) FROM content_domain_objects WHERE tenant_id = 73 AND owner_user_id = 73) AS item_count,
        (SELECT COUNT(*) FROM content_artifacts WHERE tenant_id = 73 AND owner_user_id = 73) AS artifact_count,
        (SELECT COUNT(*) FROM content_revisions WHERE tenant_id = 73 AND owner_user_id = 73) AS revision_count
    `).get()).toEqual({
      feedback_count: 1,
      item_count: 1,
      artifact_count: 1,
      revision_count: 1,
    });
  });

  it('rolls back feedback and the item when artifact persistence fails', () => {
    db.exec(`
      CREATE TRIGGER test_abort_radar_artifact
      BEFORE INSERT ON content_artifacts
      BEGIN
        SELECT RAISE(ABORT, 'forced radar artifact failure');
      END;
    `);

    expect(() => recordContentRadarWorkspaceAction({
      scope: { tenantId: 74, userId: 74 },
      signalId: 'radar-failure-1',
      action: 'save',
      signalTopic: 'Must roll back completely',
    }, db)).toThrow(/forced radar artifact failure/);

    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM content_radar_feedback WHERE tenant_id = 74 AND owner_user_id = 74) AS feedback_count,
        (SELECT COUNT(*) FROM content_domain_objects WHERE tenant_id = 74 AND owner_user_id = 74) AS item_count,
        (SELECT COUNT(*) FROM content_artifacts WHERE tenant_id = 74 AND owner_user_id = 74) AS artifact_count,
        (SELECT COUNT(*) FROM content_revisions WHERE tenant_id = 74 AND owner_user_id = 74) AS revision_count
    `).get()).toEqual({
      feedback_count: 0,
      item_count: 0,
      artifact_count: 0,
      revision_count: 0,
    });
  });

  it('keeps identical radar identities isolated by tenant and owner scope', () => {
    const first = recordContentRadarWorkspaceAction({
      scope: { tenantId: 75, userId: 75 },
      signalId: 'shared-radar-id',
      action: 'save',
      signalTopic: 'Tenant 75 private idea',
    }, db);
    const second = recordContentRadarWorkspaceAction({
      scope: { tenantId: 76, userId: 76 },
      signalId: 'shared-radar-id',
      action: 'save',
      signalTopic: 'Tenant 76 private idea',
    }, db);

    expect(second.workspace.item.id).not.toBe(first.workspace.item.id);
    expect(second.workspace.artifact.id).not.toBe(first.workspace.artifact.id);
    expect(db.prepare(`
      SELECT title
        FROM content_domain_objects
       WHERE tenant_id = 75 AND owner_user_id = 75
    `).pluck().all()).toEqual(['Tenant 75 private idea']);
    expect(db.prepare(`
      SELECT title
        FROM content_domain_objects
       WHERE tenant_id = 76 AND owner_user_id = 76
    `).pluck().all()).toEqual(['Tenant 76 private idea']);
  });

  it('rejects malformed brief input before recording feedback or workspace state', () => {
    expect(() => recordContentRadarWorkspaceAction({
      scope: { tenantId: 77, userId: 77 },
      signalId: 'radar-invalid-brief',
      action: 'create_brief',
      signalTopic: 'Invalid brief must not persist',
      brief: [] as any,
    }, db)).toThrowError(expect.objectContaining({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    }));

    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM content_radar_feedback WHERE tenant_id = 77 AND owner_user_id = 77) AS feedback_count,
        (SELECT COUNT(*) FROM content_domain_objects WHERE tenant_id = 77 AND owner_user_id = 77) AS item_count
    `).get()).toEqual({ feedback_count: 0, item_count: 0 });
  });

  it('points a repeated save at Trash instead of duplicating or surfacing an opaque receipt failure', () => {
    const saved = recordContentRadarWorkspaceAction({
      scope: { tenantId: 78, userId: 78 },
      signalId: 'radar-trash-1',
      action: 'save',
      signalTopic: 'Recover this saved idea',
    }, db);
    softDeleteContentWorkspaceItem({
      scope: { tenantId: 78, userId: 78 },
      itemId: saved.workspace.item.id,
      expectedWorkflowVersion: saved.workspace.item.workflowVersion,
      idempotencyKey: 'delete-radar-trash-1',
    }, db);

    expect(() => recordContentRadarWorkspaceAction({
      scope: { tenantId: 78, userId: 78 },
      signalId: 'radar-trash-1',
      action: 'save',
      signalTopic: 'Recover this saved idea',
    }, db)).toThrowError(expect.objectContaining({
      code: 'CONTENT_RADAR_ITEM_IN_TRASH',
      status: 409,
      details: expect.objectContaining({
        itemId: saved.workspace.item.id,
        recovery: 'restore_deleted_workspace_item',
      }),
    }));

    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM content_domain_objects
       WHERE tenant_id = 78 AND owner_user_id = 78
    `).get()).toEqual({ count: 1 });
  });
});

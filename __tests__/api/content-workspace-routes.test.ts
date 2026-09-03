import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Router, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;
const cacheMocks = vi.hoisted(() => ({
  invalidateContentDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  );
  return {
    ...actual,
    getDb: () => testDb,
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  );
  return {
    ...actual,
    getUserTimezoneById: vi.fn(() => 'UTC'),
  };
});

vi.mock('../../src/services/cache-coherence-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/cache-coherence-registry')>()),
  invalidateContentDerivedCaches: (...args: unknown[]) => cacheMocks.invalidateContentDerivedCaches(...args),
}));

import { registerContentWorkspaceRoutes } from '../../src/api/routes/content-workspace-routes';
import { ensureContentReferenceProvenanceTables } from '../../src/services/content-reference-provenance';

const MIGRATIONS = [
  readFileSync(resolve(process.cwd(), 'migrations/240_content_workspace_domain.sql'), 'utf8'),
  readFileSync(resolve(process.cwd(), 'migrations/241_content_workspace_library.sql'), 'utf8'),
  readFileSync(resolve(process.cwd(), 'migrations/243_content_artifact_relationships.sql'), 'utf8'),
];

interface MockResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
}

describe('content workspace routes', () => {
  beforeEach(() => {
    cacheMocks.invalidateContentDerivedCaches.mockClear();
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    seedSchema(testDb);
  });

  afterEach(() => testDb.close());

  it('requires an explicit tenant scope before every workspace operation', async () => {
    const response = await dispatch('POST', '/workspace/items', {
      itemType: 'content_item',
      title: 'Unscoped capture',
      idempotencyKey: 'unscoped-capture-001',
    }, 501, 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('CONTENT_TENANT_SCOPE_REQUIRED');
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM content_domain_objects WHERE object_type = 'content_item'").get())
      .toEqual({ count: 0 });
  });

  it('returns a stable typed capture contract and replays the same idempotent mutation', async () => {
    const body = {
      itemType: 'content_item',
      title: 'Fast idea capture',
      summary: 'A practical creator workflow.',
      idempotencyKey: 'route-capture-001',
    };
    const created = await dispatch('POST', '/workspace/items', body);
    const replayed = await dispatch('POST', '/workspace/items', body);

    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 'content-workspace-v1',
        item: {
          itemType: 'content_item',
          title: 'Fast idea capture',
          productionState: 'inbox',
          artifactPhase: 'idea',
          nextAction: { action: 'develop_brief', label: 'Develop a brief' },
        },
        mutation: { replayed: false, created: true },
      },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.body.data.mutation).toEqual({ replayed: true, created: false });
    expect(replayed.body.data.item.id).toBe(created.body.data.item.id);
    expect(cacheMocks.invalidateContentDerivedCaches).toHaveBeenCalledOnce();
    expect(cacheMocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(501);
    expect(JSON.stringify(created.body.data.item)).not.toContain('next_action_json');
    expect(JSON.stringify(created.body.data.item)).not.toContain('owner_user_id');
  });

  it('captures generated scripts and accepted AI edits with server-owned agent provenance and lineage', async () => {
    const captureBody = {
      topic: 'Server-attributed generated script',
      format: 'YouTube',
      scriptText: '# Hook\nGenerated body.',
      sourcesUsed: [{ title: 'Research', url: 'https://example.test/research' }],
      claimsUsed: [{
        claim: 'Research supports this generated statement.',
        support: 'source_backed',
        sourceRef: 'https://example.test/research',
      }],
      idempotencyKey: 'route-generated-capture-001',
    };
    const created = await dispatch('POST', '/workspace/generated-scripts', captureBody);
    const replay = await dispatch('POST', '/workspace/generated-scripts', captureBody);

    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(cacheMocks.invalidateContentDerivedCaches).toHaveBeenCalledOnce();
    expect(cacheMocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(501);
    expect(created.body.data).toMatchObject({
      captureSchemaVersion: 'content-workspace-capture-v1',
      artifact: {
        artifactType: 'script',
        currentRevision: {
          actorType: 'agent',
          actorId: 'ios-content-script-generation',
          provenance: { captureOrigin: 'script_generation' },
        },
      },
      mutation: { replayed: false, created: true },
    });
    expect(replay.body.data).toMatchObject({
      item: { id: created.body.data.item.id },
      artifact: { id: created.body.data.artifact.id },
      mutation: { replayed: true, created: false },
    });
    const firstRevisionId = created.body.data.artifact.currentRevision.id;
    const firstLineage = await dispatch('GET', `/workspace/revisions/${firstRevisionId}/lineage`);
    expect(firstLineage.body.data.lineage).toMatchObject({
      status: 'recorded',
      groundingStatus: 'ungrounded',
      claims: [expect.objectContaining({ supportedBy: [expect.any(String)] })],
      policy: { status: 'warning', blocksApproval: false },
    });

    const generatedRevisionBody = {
      baseRevision: 1,
      scriptText: '# Better hook\nThis investment return is guaranteed.',
      claimsUsed: [{ claim: 'An unverified financial guarantee.', support: 'unverified' }],
      idempotencyKey: 'route-generated-revision-002',
    };
    const generatedEdit = await dispatch(
      'POST',
      `/workspace/artifacts/${created.body.data.artifact.id}/generated-revisions`,
      generatedRevisionBody,
    );
    expect(generatedEdit.statusCode).toBe(201);
    expect(generatedEdit.body.data).toMatchObject({
      revision: {
        revisionNumber: 2,
        actorType: 'agent',
        provenance: { captureOrigin: 'approved_variant', userAccepted: true },
      },
      artifact: { currentRevision: { revisionNumber: 2, actorType: 'agent' } },
      mutation: { replayed: false, created: true },
    });
    const editedLineage = await dispatch('GET', `/workspace/revisions/${generatedEdit.body.data.revision.id}/lineage`);
    expect(editedLineage.body.data.lineage).toMatchObject({
      status: 'recorded',
      groundingStatus: 'ungrounded',
      policy: { status: 'blocked', blocksApproval: true },
    });

    const userEdit = await dispatch('POST', `/workspace/artifacts/${created.body.data.artifact.id}/revisions`, {
      baseRevision: 2,
      content: { format: 'markdown', text: '# User edit\nThis is now the live script.' },
      idempotencyKey: 'route-generated-later-user-edit-003',
    });
    expect(userEdit.statusCode).toBe(201);

    const rootReplayAfterEdit = await dispatch('POST', '/workspace/generated-scripts', captureBody);
    expect(rootReplayAfterEdit.statusCode).toBe(200);
    expect(rootReplayAfterEdit.body.data).toMatchObject({
      revision: { id: firstRevisionId, revisionNumber: 1, actorType: 'agent' },
      artifact: {
        currentRevisionId: userEdit.body.data.revision.id,
        currentRevision: { id: userEdit.body.data.revision.id, revisionNumber: 3, actorType: 'user' },
      },
      currentRevision: { id: userEdit.body.data.revision.id, revisionNumber: 3, actorType: 'user' },
      mutation: { replayed: true, created: false },
    });

    const generatedReplayAfterEdit = await dispatch(
      'POST',
      `/workspace/artifacts/${created.body.data.artifact.id}/generated-revisions`,
      generatedRevisionBody,
    );
    expect(generatedReplayAfterEdit.statusCode).toBe(200);
    expect(generatedReplayAfterEdit.body.data).toMatchObject({
      revision: { id: generatedEdit.body.data.revision.id, revisionNumber: 2, actorType: 'agent' },
      artifact: {
        currentRevisionId: userEdit.body.data.revision.id,
        currentRevision: { id: userEdit.body.data.revision.id, revisionNumber: 3, actorType: 'user' },
      },
      currentRevision: { id: userEdit.body.data.revision.id, revisionNumber: 3, actorType: 'user' },
      mutation: { replayed: true, created: false },
    });
    expect(generatedReplayAfterEdit.body.data.revision.id)
      .not.toBe(generatedReplayAfterEdit.body.data.currentRevision.id);

    const evidenceConflict = await dispatch(
      'POST',
      `/workspace/artifacts/${created.body.data.artifact.id}/generated-revisions`,
      {
        ...generatedRevisionBody,
        claimsUsed: [{ claim: 'A different claim under the same key.', support: 'unverified' }],
      },
    );
    expect(evidenceConflict.statusCode).toBe(409);
    expect(evidenceConflict.body.error.code).toBe('CONTENT_IDEMPOTENCY_KEY_REUSED');
    const lineageAfterConflict = await dispatch('GET', `/workspace/revisions/${generatedEdit.body.data.revision.id}/lineage`);
    expect(lineageAfterConflict.body.data.lineage.claims).toEqual(editedLineage.body.data.lineage.claims);
  });

  it('targets generated scripts to the same scoped content item with CAS-safe replay and target guards', async () => {
    const item = await createRouteItem('Develop an outline in place', 'route-target-item-001');
    const outline = await dispatch('POST', `/workspace/items/${item.id}/artifacts`, {
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'outline',
      title: 'Working outline',
      initialContent: { format: 'markdown', text: '# Working outline' },
      idempotencyKey: 'route-target-outline-001',
    });
    expect(outline.statusCode).toBe(201);
    const targetBody = {
      topic: 'Develop an outline in place',
      format: 'YouTube',
      scriptText: 'The script remains part of the original content item.',
      targetItemId: item.id,
      expectedWorkflowVersion: outline.body.data.item.workflowVersion,
      idempotencyKey: 'route-target-script-001',
    };

    const saved = await dispatch('POST', '/workspace/generated-scripts', targetBody);
    const replay = await dispatch('POST', '/workspace/generated-scripts', targetBody);

    expect(saved.statusCode).toBe(201);
    expect(saved.body.data).toMatchObject({
      item: { id: item.id, currentArtifactId: saved.body.data.artifact.id },
      artifact: { itemId: item.id, artifactType: 'script' },
      revision: { id: saved.body.data.artifact.currentRevision.id, actorType: 'agent' },
      mutation: { replayed: false, created: true },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data).toMatchObject({
      item: { id: item.id },
      artifact: { id: saved.body.data.artifact.id },
      revision: { id: saved.body.data.revision.id },
      mutation: { replayed: true, created: false },
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_domain_objects WHERE tenant_id = 501 AND owner_user_id = 501')
      .get()).toEqual({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_artifacts WHERE item_id = ?')
      .get(item.id)).toEqual({ count: 2 });
    expect(testDb.prepare(`
      SELECT relationship_type
        FROM content_artifact_relationships
       WHERE from_artifact_id = ? AND to_artifact_id = ?
    `).get(saved.body.data.artifact.id, outline.body.data.artifact.id))
      .toEqual({ relationship_type: 'derived_from' });

    const stale = await dispatch('POST', '/workspace/generated-scripts', {
      ...targetBody,
      idempotencyKey: 'route-target-script-stale-002',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.code).toBe('CONTENT_WORKFLOW_VERSION_CONFLICT');

    const secondItem = await createRouteItem('Second target', 'route-target-second-item-001');
    const changedTarget = await dispatch('POST', '/workspace/generated-scripts', {
      ...targetBody,
      targetItemId: secondItem.id,
      expectedWorkflowVersion: secondItem.workflowVersion,
    });
    expect(changedTarget.statusCode).toBe(409);
    expect(changedTarget.body.error.code).toBe('CONTENT_IDEMPOTENCY_KEY_REUSED');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_artifacts WHERE item_id = ?')
      .get(secondItem.id)).toEqual({ count: 0 });

    const incompleteTarget = await dispatch('POST', '/workspace/generated-scripts', {
      ...targetBody,
      expectedWorkflowVersion: undefined,
      idempotencyKey: 'route-target-script-incomplete-005',
    });
    expect(incompleteTarget.statusCode).toBe(400);
    expect(incompleteTarget.body.error.code).toBe('CONTENT_VALIDATION_FAILED');

    const foreignItem = await createRouteItem('Foreign target', 'route-target-foreign-item-001', 777, 777);
    const foreign = await dispatch('POST', '/workspace/generated-scripts', {
      ...targetBody,
      targetItemId: foreignItem.id,
      expectedWorkflowVersion: foreignItem.workflowVersion,
      idempotencyKey: 'route-target-script-foreign-003',
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body.error.code).toBe('CONTENT_ITEM_NOT_FOUND');

    const project = await dispatch('POST', '/workspace/items', {
      itemType: 'project',
      title: 'Project target is invalid',
      idempotencyKey: 'route-target-project-item-001',
    });
    expect(project.statusCode).toBe(201);
    const wrongType = await dispatch('POST', '/workspace/generated-scripts', {
      ...targetBody,
      targetItemId: project.body.data.item.id,
      expectedWorkflowVersion: project.body.data.item.workflowVersion,
      idempotencyKey: 'route-target-script-project-004',
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.body.error.code).toBe('CONTENT_ARTIFACT_PARENT_INVALID');
  });

  it('supports artifact creation, CAS saves, conflict recovery details, and immutable history', async () => {
    const item = await createRouteItem('Script flow', 'route-script-item-001');
    const artifact = await dispatch('POST', `/workspace/items/${item.id}/artifacts`, {
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      title: 'Main script',
      initialContent: { format: 'markdown', text: '# Hook\nFirst draft.' },
      actorType: 'agent',
      actorId: 'spoofed-agent',
      provenance: { source: 'spoofed' },
      idempotencyKey: 'route-script-artifact-001',
    });
    const artifactId = artifact.body.data.artifact.id;
    expect(artifact.statusCode).toBe(201);
    expect(artifact.body.data.artifact).toMatchObject({
      artifactType: 'script',
      revisionCount: 1,
      currentRevision: { revisionNumber: 1, content: { format: 'markdown', text: '# Hook\nFirst draft.' } },
    });
    expect(artifact.body.data.artifact.currentRevision).toMatchObject({
      actorType: 'user',
      actorId: '501',
      provenance: { source: 'authenticated_user_api' },
    });
    expect(artifact.body.data.item).toMatchObject({
      id: item.id,
      currentArtifactId: artifactId,
      workflowVersion: item.workflowVersion + 1,
      productionState: 'active',
    });

    const saved = await dispatch('POST', `/workspace/artifacts/${artifactId}/revisions`, {
      baseRevision: 1,
      content: { format: 'markdown', text: '# Hook\nSecond draft.' },
      idempotencyKey: 'route-script-save-002',
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.body.data.revision).toMatchObject({ revisionNumber: 2, parentRevisionId: artifact.body.data.artifact.currentRevisionId });
    expect(saved.body.data.artifact).toMatchObject({
      id: artifactId,
      currentRevisionId: saved.body.data.revision.id,
      currentRevision: { revisionNumber: 2 },
    });
    expect(saved.body.data.currentRevision).toMatchObject({
      id: saved.body.data.revision.id,
      revisionNumber: 2,
    });
    expect(saved.body.data.item).toMatchObject({
      id: item.id,
      currentArtifactId: artifactId,
      workflowVersion: item.workflowVersion + 2,
    });

    const stale = await dispatch('POST', `/workspace/artifacts/${artifactId}/revisions`, {
      baseRevision: 1,
      content: { format: 'markdown', text: 'Lost overwrite attempt' },
      idempotencyKey: 'route-script-stale-003',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'CONTENT_REVISION_CONFLICT',
      details: {
        suppliedBaseRevision: 1,
        currentRevision: 2,
        recovery: 'reload_compare_and_retry',
      },
    });

    const history = await dispatch('GET', `/workspace/artifacts/${artifactId}/revisions`);
    expect(history.statusCode).toBe(200);
    expect(history.body.data.revisions.map((revision: any) => revision.revisionNumber)).toEqual([2, 1]);
    expect(history.body.data).toMatchObject({ hasMore: false, nextCursor: null });

    const firstHistoryPage = await dispatch('GET', `/workspace/artifacts/${artifactId}/revisions?limit=1`);
    expect(firstHistoryPage.body.data).toMatchObject({ hasMore: true });
    expect(firstHistoryPage.body.data.revisions.map((revision: any) => revision.revisionNumber)).toEqual([2]);
    const secondHistoryPage = await dispatch(
      'GET',
      `/workspace/artifacts/${artifactId}/revisions?limit=1&cursor=${encodeURIComponent(firstHistoryPage.body.data.nextCursor)}`,
    );
    expect(secondHistoryPage.body.data).toMatchObject({ hasMore: false, nextCursor: null });
    expect(secondHistoryPage.body.data.revisions.map((revision: any) => revision.revisionNumber)).toEqual([1]);
  });

  it('returns the authoritative current revision when an older successful save is replayed after another device advances it', async () => {
    const item = await createRouteItem('Replay reconciliation', 'route-replay-item-001');
    const artifact = await dispatch('POST', `/workspace/items/${item.id}/artifacts`, {
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      title: 'Replay-safe script',
      initialContent: { format: 'plain_text', text: 'Revision one' },
      idempotencyKey: 'route-replay-artifact-001',
    });
    const artifactId = artifact.body.data.artifact.id;
    const originalSaveBody = {
      baseRevision: 1,
      content: { format: 'plain_text', text: 'Revision two from device A' },
      idempotencyKey: 'route-replay-save-002',
    };
    const deviceA = await dispatch('POST', `/workspace/artifacts/${artifactId}/revisions`, originalSaveBody);
    const deviceB = await dispatch('POST', `/workspace/artifacts/${artifactId}/revisions`, {
      baseRevision: 2,
      content: { format: 'plain_text', text: 'Revision three from device B' },
      idempotencyKey: 'route-replay-save-003',
    });
    const replay = await dispatch('POST', `/workspace/artifacts/${artifactId}/revisions`, originalSaveBody);

    expect(deviceA.statusCode).toBe(201);
    expect(deviceB.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data).toMatchObject({
      revision: {
        id: deviceA.body.data.revision.id,
        revisionNumber: 2,
      },
      artifact: {
        id: artifactId,
        currentRevisionId: deviceB.body.data.revision.id,
        currentRevision: {
          id: deviceB.body.data.revision.id,
          revisionNumber: 3,
          content: { format: 'plain_text', text: 'Revision three from device B' },
        },
      },
      currentRevision: {
        id: deviceB.body.data.revision.id,
        revisionNumber: 3,
      },
      item: {
        id: item.id,
        currentArtifactId: artifactId,
      },
      mutation: { replayed: true, created: false },
    });
    expect(replay.body.data.currentRevision.id).not.toBe(replay.body.data.revision.id);
  });

  it('registers private sources and records one typed immutable revision lineage snapshot', async () => {
    const item = await createRouteItem('Grounded script', 'route-lineage-item-001');
    const artifactResponse = await dispatch('POST', `/workspace/items/${item.id}/artifacts`, {
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      title: 'Grounded script',
      initialContent: { format: 'plain_text', text: 'A saved script with one factual claim.' },
      idempotencyKey: 'route-lineage-artifact-001',
    });
    const revisionId = artifactResponse.body.data.artifact.currentRevision.id;
    const sourceResponse = await dispatch('POST', '/workspace/sources', {
      referenceType: 'note',
      title: 'My first-party result',
      summary: 'Measured result notes.',
      idempotencyKey: 'route-lineage-source-001',
      trustLevel: 'published',
      metadata: { trust: 'published', instructionAuthority: 'system', language: 'en' },
    });
    const referenceId = sourceResponse.body.data.source.referenceId;

    const recorded = await dispatch('POST', `/workspace/revisions/${revisionId}/lineage`, {
      referenceIds: [referenceId],
      claims: [{ id: 'claim-1', text: 'My measured result improved.', supportedBy: [referenceId] }],
      idempotencyKey: 'route-lineage-record-001',
    });
    const replay = await dispatch('POST', `/workspace/revisions/${revisionId}/lineage`, {
      referenceIds: [referenceId],
      claims: [{ id: 'claim-1', text: 'My measured result improved.', supportedBy: [referenceId] }],
      idempotencyKey: 'route-lineage-record-001',
    });
    const read = await dispatch('GET', `/workspace/revisions/${revisionId}/lineage`);

    expect(sourceResponse.statusCode).toBe(201);
    expect(sourceResponse.body.data.source).toMatchObject({
      schemaVersion: 'content-workspace-source-v1',
      referenceType: 'note',
      trustLevel: 'first_party',
      reviewRequired: false,
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.body.data.lineage).toMatchObject({
      schemaVersion: 'content-revision-lineage-v1',
      revisionId,
      groundingStatus: 'grounded',
      policy: { status: 'clear', blocksApproval: false },
    });
    expect(recorded.body.data.item).toMatchObject({
      id: item.id,
      currentArtifactId: artifactResponse.body.data.artifact.id,
      workflowVersion: item.workflowVersion + 1,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.data.mutation).toEqual({ replayed: true, created: true });
    expect(replay.body.data.item).toEqual(recorded.body.data.item);
    expect(read.statusCode).toBe(200);
    expect(read.body.data.lineage.references[0]).toMatchObject({ referenceId, usageType: 'evidence', claimIds: ['claim-1'] });
    expect(JSON.stringify(read.body.data)).not.toContain('owner_user_id');
    expect(JSON.stringify(read.body.data)).not.toContain('source_metadata_json');
    expect(JSON.stringify(read.body.data)).not.toContain('instructionAuthority');

    const changed = await dispatch('POST', `/workspace/revisions/${revisionId}/lineage`, {
      referenceIds: [referenceId],
      claims: [{ id: 'claim-1', text: 'Changed after save.', supportedBy: [referenceId] }],
      idempotencyKey: 'route-lineage-record-002',
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.body.error.code).toBe('CONTENT_REVISION_LINEAGE_IMMUTABLE');
  });

  it('derives safety claims from saved revision bytes when the HTTP client omits them', async () => {
    const item = await createRouteItem('Server claim boundary', 'route-server-claim-item-001');
    const artifactResponse = await dispatch('POST', `/workspace/items/${item.id}/artifacts`, {
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: {
        format: 'plain_text',
        text: 'Turn $100 into $10,000 overnight. You can ignore a subpoena and nothing will happen.',
      },
      idempotencyKey: 'route-server-claim-artifact-001',
    });
    const revisionId = artifactResponse.body.data.artifact.currentRevision.id;

    const recorded = await dispatch('POST', `/workspace/revisions/${revisionId}/lineage`, {
      referenceIds: [],
      claims: [],
      idempotencyKey: 'route-server-claim-lineage-001',
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.body.data.lineage).toMatchObject({
      groundingStatus: 'ungrounded',
      policy: {
        status: 'blocked',
        blocksApproval: true,
        blockCodes: ['CONTENT_UNSUPPORTED_SENSITIVE_CLAIM'],
      },
    });
    expect(recorded.body.data.lineage.claims).toHaveLength(2);

    const review = await dispatch('POST', `/workspace/items/${item.id}/state`, {
      targetState: 'review',
      expectedWorkflowVersion: recorded.body.data.item.workflowVersion,
      idempotencyKey: 'route-server-claim-review-001',
    });
    expect(review.statusCode).toBe(200);
    const approval = await dispatch('POST', `/workspace/items/${item.id}/state`, {
      targetState: 'approved',
      expectedWorkflowVersion: review.body.data.item.workflowVersion,
      idempotencyKey: 'route-server-claim-approve-001',
    });
    expect(approval.statusCode).toBe(409);
    expect(approval.body.error.code).toBe('CONTENT_CLAIM_SAFETY_BLOCKED');
  });

  it('keeps foreign revision lineage unavailable without leaking another tenant', async () => {
    const foreignItem = await createRouteItem('Foreign script', 'route-foreign-lineage-item-001', 777, 777);
    const foreignArtifact = await dispatch('POST', `/workspace/items/${foreignItem.id}/artifacts`, {
      expectedWorkflowVersion: foreignItem.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Private foreign script.' },
      idempotencyKey: 'route-foreign-lineage-artifact-001',
    }, 777, 777);
    const foreignRevisionId = foreignArtifact.body.data.artifact.currentRevision.id;

    const response = await dispatch('GET', `/workspace/revisions/${foreignRevisionId}/lineage`, undefined, 501, 501);

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('CONTENT_REVISION_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('Private foreign script');
  });

  it('restores as a new revision and never overwrites the selected historical record', async () => {
    const item = await createRouteItem('Restore flow', 'route-restore-item-001');
    const artifact = await dispatch('POST', `/workspace/items/${item.id}/artifacts`, {
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Version one' },
      idempotencyKey: 'route-restore-artifact-001',
    });
    const artifactId = artifact.body.data.artifact.id;
    const sourceId = artifact.body.data.artifact.currentRevisionId;
    await dispatch('POST', `/workspace/artifacts/${artifactId}/revisions`, {
      baseRevision: 1,
      content: { format: 'plain_text', text: 'Version two' },
      idempotencyKey: 'route-restore-save-002',
    });

    const restoreBody = {
      baseRevision: 2,
      idempotencyKey: 'route-restore-append-003',
    };
    const restored = await dispatch('POST', `/workspace/artifacts/${artifactId}/revisions/${sourceId}/restore`, restoreBody);
    expect(restored.statusCode).toBe(201);
    expect(restored.body.data.revision).toMatchObject({
      revisionNumber: 3,
      restoredFromRevisionId: sourceId,
      content: { format: 'plain_text', text: 'Version one' },
    });
    expect(restored.body.data.item).toMatchObject({
      id: item.id,
      currentArtifactId: artifactId,
      workflowVersion: item.workflowVersion + 3,
    });
    const advanced = await dispatch('POST', `/workspace/artifacts/${artifactId}/revisions`, {
      baseRevision: 3,
      content: { format: 'plain_text', text: 'Version four from another device' },
      idempotencyKey: 'route-restore-save-004',
    });
    const restoreReplay = await dispatch(
      'POST',
      `/workspace/artifacts/${artifactId}/revisions/${sourceId}/restore`,
      restoreBody,
    );
    expect(restoreReplay.statusCode).toBe(200);
    expect(restoreReplay.body.data).toMatchObject({
      revision: { id: restored.body.data.revision.id, revisionNumber: 3 },
      artifact: {
        currentRevisionId: advanced.body.data.revision.id,
        currentRevision: {
          revisionNumber: 4,
          content: { format: 'plain_text', text: 'Version four from another device' },
        },
      },
      currentRevision: { id: advanced.body.data.revision.id, revisionNumber: 4 },
      mutation: { replayed: true, created: false },
    });
    expect(testDb.prepare('SELECT content_text FROM content_revisions WHERE id = ?').get(sourceId))
      .toEqual({ content_text: 'Version one' });
  });

  it('never reports another tenant artifact as an empty revision history', async () => {
    const item = await createRouteItem('Private script', 'route-private-item-001');
    const artifact = await dispatch('POST', `/workspace/items/${item.id}/artifacts`, {
      expectedWorkflowVersion: item.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'plain_text', text: 'Private' },
      idempotencyKey: 'route-private-artifact-001',
    });

    const foreign = await dispatch('GET', `/workspace/artifacts/${artifact.body.data.artifact.id}/revisions`, {}, 501, 202);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.body.error.code).toBe('CONTENT_TENANT_SCOPE_MISMATCH');
  });

  it('validates lifecycle versions and project relationship semantics through typed errors', async () => {
    const item = await createRouteItem('Lifecycle item', 'route-state-item-001');
    const projectResponse = await dispatch('POST', '/workspace/items', {
      itemType: 'project',
      title: 'Launch campaign',
      idempotencyKey: 'route-project-001',
    });
    const project = projectResponse.body.data.item;
    const relation = await dispatch('POST', '/workspace/relationships', {
      fromItemId: project.id,
      toItemId: item.id,
      relationshipType: 'contains',
      idempotencyKey: 'route-project-rel-001',
    });
    expect(relation.statusCode).toBe(201);
    expect(relation.body.data.relationship).toMatchObject({ fromItemId: project.id, toItemId: item.id, relationshipType: 'contains' });

    const missingKey = await dispatch('POST', `/workspace/items/${item.id}/state`, {
      targetState: 'active',
      expectedWorkflowVersion: item.workflowVersion,
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.body.error.code).toBe('CONTENT_IDEMPOTENCY_KEY_REQUIRED');

    const conflictingKeys = await dispatch('POST', `/workspace/items/${item.id}/state`, {
      targetState: 'active',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'route-state-body-001',
    }, 501, 501, { 'x-idempotency-key': 'route-state-header-001' });
    expect(conflictingKeys.statusCode).toBe(409);
    expect(conflictingKeys.body.error.code).toBe('CONTENT_IDEMPOTENCY_KEY_CONFLICT');

    const active = await dispatch('POST', `/workspace/items/${item.id}/state`, {
      targetState: 'active',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'route-state-active-001',
    });
    expect(active.statusCode).toBe(200);
    expect(active.body.data.mutation.changed).toBe(true);

    const stale = await dispatch('POST', `/workspace/items/${item.id}/state`, {
      targetState: 'review',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'route-state-stale-002',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.code).toBe('CONTENT_WORKFLOW_VERSION_CONFLICT');
  });

  it('exposes typed relationship reorder/removal and atomic duplicate/remix contracts', async () => {
    const first = await createRouteItem('First campaign item', 'route-org-first-item-001');
    const second = await createRouteItem('Second campaign item', 'route-org-second-item-001');
    const projectResponse = await dispatch('POST', '/workspace/items', {
      itemType: 'project',
      title: 'Ordered route campaign',
      idempotencyKey: 'route-org-project-001',
    });
    const project = projectResponse.body.data.item;
    const firstRelationship = await dispatch('POST', '/workspace/relationships', {
      fromItemId: project.id,
      toItemId: first.id,
      relationshipType: 'contains',
      position: 0,
      idempotencyKey: 'route-org-first-link-001',
    });
    const secondRelationship = await dispatch('POST', '/workspace/relationships', {
      fromItemId: project.id,
      toItemId: second.id,
      relationshipType: 'contains',
      position: 1,
      idempotencyKey: 'route-org-second-link-001',
    });

    const reorderBody = {
      expectedFromWorkflowVersion: project.workflowVersion,
      position: 0,
      idempotencyKey: 'route-org-reorder-001',
    };
    const reordered = await dispatch(
      'PATCH',
      `/workspace/relationships/${secondRelationship.body.data.relationship.id}/position`,
      reorderBody,
    );
    const reorderReplay = await dispatch(
      'PATCH',
      `/workspace/relationships/${secondRelationship.body.data.relationship.id}/position`,
      reorderBody,
    );
    expect(reordered.statusCode).toBe(200);
    expect(reordered.body.data).toMatchObject({
      relationship: { id: secondRelationship.body.data.relationship.id, position: 0 },
      fromItem: { id: project.id, workflowVersion: project.workflowVersion + 1 },
      mutation: { replayed: false, changed: true },
    });
    expect(reorderReplay.body.data).toMatchObject({
      relationship: reordered.body.data.relationship,
      fromItem: reordered.body.data.fromItem,
      mutation: { replayed: true, changed: true },
    });

    const removeBody = {
      expectedFromWorkflowVersion: reordered.body.data.fromItem.workflowVersion,
      idempotencyKey: 'route-org-remove-001',
    };
    const removed = await dispatch(
      'DELETE',
      `/workspace/relationships/${firstRelationship.body.data.relationship.id}`,
      removeBody,
    );
    const removeReplay = await dispatch(
      'DELETE',
      `/workspace/relationships/${firstRelationship.body.data.relationship.id}`,
      removeBody,
    );
    expect(removed.body.data).toMatchObject({
      removal: {
        relationshipId: firstRelationship.body.data.relationship.id,
        fromItemId: project.id,
        toItemId: first.id,
        relationshipType: 'contains',
      },
      fromItem: { id: project.id, workflowVersion: project.workflowVersion + 2 },
      mutation: { replayed: false, changed: true },
    });
    expect(removeReplay.body.data).toMatchObject({
      removal: removed.body.data.removal,
      fromItem: removed.body.data.fromItem,
      mutation: { replayed: true, changed: true },
    });

    const source = await createRouteItem('Copy route source', 'route-copy-source-item-001');
    const sourceArtifact = await dispatch('POST', `/workspace/items/${source.id}/artifacts`, {
      expectedWorkflowVersion: source.workflowVersion,
      artifactType: 'script',
      title: 'Canonical script',
      initialContent: { format: 'markdown', text: '# Route snapshot\nExact source bytes.  \n' },
      idempotencyKey: 'route-copy-source-artifact-001',
    });
    const registeredSource = await dispatch('POST', '/workspace/sources', {
      referenceType: 'link',
      title: 'Canonical evidence',
      url: 'https://evidence.example/source',
      summary: 'A private evidence summary.',
      idempotencyKey: 'route-copy-source-reference-001',
    });
    const sourceRevisionId = sourceArtifact.body.data.artifact.currentRevision.id;
    const sourceLineage = await dispatch('POST', `/workspace/revisions/${sourceRevisionId}/lineage`, {
      referenceIds: [registeredSource.body.data.source.referenceId],
      claims: [{
        id: 'claim.copy.1',
        text: 'This claim stays attached to the exact copied bytes.',
        supportedBy: [registeredSource.body.data.source.referenceId],
      }],
      idempotencyKey: 'route-copy-source-lineage-001',
    });
    expect(sourceLineage.statusCode).toBe(201);
    const copyBody = {
      expectedWorkflowVersion: sourceArtifact.body.data.item.workflowVersion,
      mode: 'duplicate',
      title: 'Route working copy',
      idempotencyKey: 'route-copy-duplicate-001',
    };
    const copied = await dispatch('POST', `/workspace/items/${source.id}/copies`, copyBody);
    const copiedReplay = await dispatch('POST', `/workspace/items/${source.id}/copies`, copyBody);
    expect(copied.statusCode).toBe(201);
    expect(copied.body.data).toMatchObject({
      schemaVersion: 'content-workspace-v1',
      copy: {
        mode: 'duplicate',
        sourceItemId: source.id,
        sourceWorkflowVersion: sourceArtifact.body.data.item.workflowVersion,
        item: {
          title: 'Route working copy',
          productionState: 'active',
          artifacts: [expect.objectContaining({
            artifactType: 'script',
            currentRevision: expect.objectContaining({
              revisionNumber: 1,
              content: { format: 'markdown', text: '# Route snapshot\nExact source bytes.  \n' },
            }),
          })],
        },
        relationship: { relationshipType: 'derived_from', toItemId: source.id },
        artifactMappings: [expect.objectContaining({ sourceArtifactId: sourceArtifact.body.data.artifact.id })],
      },
      mutation: { replayed: false, created: true },
    });
    expect(copiedReplay.statusCode).toBe(200);
    expect(copiedReplay.body.data).toMatchObject({
      copy: { item: { id: copied.body.data.copy.item.id } },
      mutation: { replayed: true, created: false },
    });
    const copiedRevisionId = copied.body.data.copy.item.artifacts[0].currentRevision.id;
    const copiedLineage = await dispatch('GET', `/workspace/revisions/${copiedRevisionId}/lineage`);
    expect(copiedLineage.body.data.lineage).toMatchObject({
      status: 'recorded',
      revisionId: copiedRevisionId,
      groundingStatus: sourceLineage.body.data.lineage.groundingStatus,
      references: [expect.objectContaining({
        referenceId: registeredSource.body.data.source.referenceId,
        usageType: 'evidence',
        claimIds: ['claim.copy.1'],
      })],
      claims: [expect.objectContaining({ id: 'claim.copy.1' })],
      unsupportedClaims: sourceLineage.body.data.lineage.unsupportedClaims,
    });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS count FROM content_source_output_links
       WHERE output_object_type = 'content_revision' AND output_id = ?
    `).get(String(copiedRevisionId))).toEqual({ count: 1 });
    expect(JSON.stringify(copied.body.data)).not.toContain('tenant_id');
    expect(JSON.stringify(copied.body.data)).not.toContain('owner_user_id');

    const foreign = await createRouteItem('Foreign copy source', 'route-copy-foreign-item-001', 777, 777);
    const crossTenant = await dispatch('POST', `/workspace/items/${foreign.id}/copies`, {
      expectedWorkflowVersion: foreign.workflowVersion,
      mode: 'remix',
      idempotencyKey: 'route-copy-cross-tenant-001',
    }, 501, 501);
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.body.error.code).toBe('CONTENT_ITEM_NOT_FOUND');
    expect(JSON.stringify(crossTenant.body)).not.toContain('Foreign copy source');
  });

  it('exposes CAS metadata, normalized tags, and safe library query contracts', async () => {
    const item = await createRouteItem('Library route item', 'route-library-item-001');
    const todaySummary = await dispatch('GET', '/workspace/today-summary');
    expect(todaySummary.statusCode).toBe(200);
    expect(todaySummary.body.data).toMatchObject({
      schemaVersion: 'content-workspace-today-summary-v2',
      complete: false,
      itemCount: 1,
      inboxCount: 1,
      privateWorkBlockCount: 0,
      scheduleAttentionCount: 0,
      scheduleAuthorityStatus: 'unavailable',
      scheduleSemantics: 'private_work_session',
      publicationExecution: 'not_performed',
      publicationTracking: {
        availability: 'unavailable',
        reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
        publicationExecution: 'not_supported',
      },
    });
    const edited = await dispatch('PATCH', `/workspace/items/${item.id}`, {
      expectedWorkflowVersion: item.workflowVersion,
      title: 'Edited library route item',
      summary: 'Find this summary safely.',
      priority: 1,
      favorite: true,
      platformId: 'youtube',
      formatId: 'video',
      idempotencyKey: 'route-library-edit-001',
    });
    const replay = await dispatch('PATCH', `/workspace/items/${item.id}`, {
      expectedWorkflowVersion: item.workflowVersion,
      title: 'Edited library route item',
      summary: 'Find this summary safely.',
      priority: 1,
      favorite: true,
      platformId: 'youtube',
      formatId: 'video',
      idempotencyKey: 'route-library-edit-001',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.body.data).toMatchObject({
      item: { title: 'Edited library route item', priority: 1, favorite: true },
      mutation: { replayed: false, changed: true },
    });
    expect(replay.body.data.mutation).toEqual({ replayed: true, changed: true });

    const tag = await dispatch('POST', '/workspace/tags', {
      name: '  Launch   Week ',
      idempotencyKey: 'route-library-tag-001',
    });
    const attached = await dispatch('POST', `/workspace/items/${item.id}/tags`, {
      tagId: tag.body.data.tag.id,
      expectedWorkflowVersion: edited.body.data.item.workflowVersion,
      idempotencyKey: 'route-library-attach-001',
    });
    expect(tag.statusCode).toBe(201);
    expect(tag.body.data.tag).toMatchObject({ name: 'Launch Week', normalizedName: 'launch week' });
    expect(attached.body.data.item.tags).toEqual([expect.objectContaining({ id: tag.body.data.tag.id })]);

    const list = await dispatch(
      'GET',
      '/workspace/items?tag=LAUNCH%20WEEK&favorite=true&platformId=youtube&formatId=video&sort=title_asc&limit=1',
    );
    expect(list.statusCode).toBe(200);
    expect(list.body.data).toMatchObject({
      items: [expect.objectContaining({ id: item.id, nextAction: expect.objectContaining({ label: 'Develop a brief' }) })],
      hasMore: false,
      nextCursor: null,
    });
    expect(JSON.stringify(list.body.data)).not.toContain('normalized_name');
    expect(JSON.stringify(list.body.data)).not.toContain('next_action_json');

    const invalidSort = await dispatch('GET', '/workspace/items?sort=updated_at%20DESC%3BDELETE');
    expect(invalidSort.statusCode).toBe(400);
    expect(invalidSort.body.error.code).toBe('CONTENT_VALIDATION_FAILED');

    const detached = await dispatch('DELETE', `/workspace/items/${item.id}/tags/${tag.body.data.tag.id}`, {
      expectedWorkflowVersion: attached.body.data.item.workflowVersion,
      idempotencyKey: 'route-library-detach-001',
    });
    const detachReplay = await dispatch('DELETE', `/workspace/items/${item.id}/tags/${tag.body.data.tag.id}`, {
      expectedWorkflowVersion: attached.body.data.item.workflowVersion,
      idempotencyKey: 'route-library-detach-001',
    });
    expect(detached.body.data).toMatchObject({ item: { tags: [] }, mutation: { replayed: false, changed: true } });
    expect(detachReplay.body.data.mutation).toEqual({ replayed: true, changed: true });
  });

  it('soft-deletes and restores without exposing a normal hard-delete path or another tenant item', async () => {
    const item = await createRouteItem('Recover route item', 'route-library-delete-item-001');
    const crossTenant = await dispatch('DELETE', `/workspace/items/${item.id}`, {
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'route-library-cross-delete-001',
    }, 501, 202);
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.body.error.code).toBe('CONTENT_TENANT_SCOPE_MISMATCH');

    const deleted = await dispatch('DELETE', `/workspace/items/${item.id}`, {
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'route-library-delete-001',
    });
    const deleteReplay = await dispatch('DELETE', `/workspace/items/${item.id}`, {
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'route-library-delete-001',
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body.data).toMatchObject({
      deletion: {
        itemId: item.id,
        recoverable: true,
        nextAction: expect.objectContaining({ action: 'restore_to_inbox', label: 'Restore item' }),
      },
      deletionCurrent: true,
      item: null,
      mutation: { replayed: false, changed: true },
    });
    expect(deleteReplay.body.data).toMatchObject({
      deletion: deleted.body.data.deletion,
      deletionCurrent: true,
      item: null,
      mutation: { replayed: true, changed: true },
    });
    expect((await dispatch('GET', `/workspace/items/${item.id}`)).statusCode).toBe(404);
    const trash = await dispatch('GET', '/workspace/trash');
    expect(trash.body.data).toMatchObject({
      entries: [expect.objectContaining({
        item: expect.objectContaining({ id: item.id, workflowVersion: deleted.body.data.deletion.workflowVersion }),
        deletedAt: deleted.body.data.deletion.deletedAt,
        recoverable: true,
        nextAction: expect.objectContaining({ action: 'restore_to_inbox', label: 'Restore item' }),
      })],
      hasMore: false,
      nextCursor: null,
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_domain_objects WHERE id = ?').get(item.id)).toEqual({ count: 1 });

    const restored = await dispatch('POST', `/workspace/items/${item.id}/restore`, {
      expectedWorkflowVersion: deleted.body.data.deletion.workflowVersion,
      idempotencyKey: 'route-library-restore-001',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.body.data).toMatchObject({
      item: { id: item.id, title: 'Recover route item' },
      mutation: { replayed: false, changed: true },
    });
    expect((await dispatch('GET', '/workspace/trash')).body.data.entries).toEqual([]);
    expect((await dispatch('GET', `/workspace/items/${item.id}`)).statusCode).toBe(200);

    // Simulate device A retrying its original delete after device B restored
    // the item. The receipt stays immutable, but the response must expose the
    // active item as authoritative current state.
    const lostDeleteResponseRetry = await dispatch('DELETE', `/workspace/items/${item.id}`, {
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'route-library-delete-001',
    });
    expect(lostDeleteResponseRetry.statusCode).toBe(200);
    expect(lostDeleteResponseRetry.body.data).toMatchObject({
      deletion: deleted.body.data.deletion,
      deletionCurrent: false,
      item: {
        id: item.id,
        title: 'Recover route item',
        workflowVersion: restored.body.data.item.workflowVersion,
      },
      mutation: { replayed: true, changed: true },
    });
    expect((await dispatch('GET', `/workspace/items/${item.id}`)).body.data.item)
      .toMatchObject(lostDeleteResponseRetry.body.data.item);
  });

  it('keeps every workspace GET side-effect free', async () => {
    const item = await createRouteItem('Read-only library item', 'route-library-readonly-item-001');
    await dispatch('POST', '/workspace/tags', {
      name: 'Read only',
      idempotencyKey: 'route-library-readonly-tag-001',
    });
    const before = workspaceMutationCounts();

    expect((await dispatch('GET', '/workspace/items')).statusCode).toBe(200);
    expect((await dispatch('GET', `/workspace/items/${item.id}`)).statusCode).toBe(200);
    expect((await dispatch('GET', '/workspace/tags')).statusCode).toBe(200);
    expect((await dispatch('GET', '/workspace/trash')).statusCode).toBe(200);

    expect(workspaceMutationCounts()).toEqual(before);
  });
});

function workspaceMutationCounts(): Record<string, number> {
  const tables = ['content_domain_objects', 'content_tags', 'content_item_tags', 'content_mutation_receipts', 'content_workflow_events'];
  return Object.fromEntries(tables.map((table) => {
    const row = testDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return [table, row.count];
  }));
}

async function createRouteItem(
  title: string,
  idempotencyKey: string,
  userId: number | undefined = 501,
  tenantId: number | undefined = 501,
): Promise<any> {
  const response = await dispatch('POST', '/workspace/items', { itemType: 'content_item', title, idempotencyKey }, userId, tenantId);
  expect(response.statusCode).toBe(201);
  return response.body.data.item;
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = 501,
  tenantId: number | undefined = 501,
  headers: Record<string, string> = {},
): Promise<MockResponse> {
  const router = Router();
  registerContentWorkspaceRoutes(router, (res, authenticatedUserId): authenticatedUserId is number => {
    if (Number.isInteger(authenticatedUserId) && Number(authenticatedUserId) > 0) return true;
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return false;
  });
  const parsedUrl = new URL(path, 'https://nexus.invalid');
  const request = {
    method,
    url: `${parsedUrl.pathname}${parsedUrl.search}`,
    originalUrl: path,
    baseUrl: '',
    path: parsedUrl.pathname,
    query: Object.fromEntries(parsedUrl.searchParams.entries()),
    params: {},
    body,
    userId,
    tenantId,
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
  } as unknown as Request;
  const response = mockResponse();
  await new Promise<void>((resolvePromise, reject) => {
    (router as any).handle(request, response, (error: unknown) => error ? reject(error) : resolvePromise());
    setImmediate(resolvePromise);
  });
  return response;
}

function mockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { response.statusCode = code; return response; },
    json(body) { response.body = body; return response; },
    setHeader(name, value) { response.headers[name.toLowerCase()] = String(value); },
    getHeader(name) { return response.headers[name.toLowerCase()]; },
  };
  return response;
}

function seedSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE content_domain_objects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      object_type TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'captured',
      title TEXT NOT NULL,
      summary TEXT,
      platform_id TEXT,
      format_id TEXT,
      ontology_metadata_json TEXT NOT NULL DEFAULT '{}',
      ontology_schema_version TEXT NOT NULL DEFAULT 'content-ontology-v1',
      editorial_state TEXT DEFAULT 'idea',
      approval_state TEXT DEFAULT 'not_required',
      review_required INTEGER NOT NULL DEFAULT 0,
      review_reason_codes_json TEXT DEFAULT '[]',
      approved_by INTEGER,
      approved_at TEXT,
      archived_at TEXT,
      workflow_version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE content_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL,
      scope_status TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      approval_state TEXT NOT NULL,
      review_required INTEGER NOT NULL,
      reason_codes_json TEXT NOT NULL,
      actor_user_id INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS) db.exec(migration);
  ensureContentReferenceProvenanceTables(db);
}

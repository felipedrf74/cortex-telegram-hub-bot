import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertContentPipelineWorkspaceExitReady } from '../../src/services/content-pipeline-workspace-exit';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const UP = readFileSync(resolve(process.cwd(), 'migrations/246_content_pipeline_workspace_exit.sql'), 'utf8');
const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/246_content_pipeline_workspace_exit.sql'), 'utf8');
const SCRIPT_PARITY_UP = readFileSync(resolve(process.cwd(), 'migrations/252_content_legacy_script_workspace_parity.sql'), 'utf8');
const SCRIPT_PARITY_DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/252_content_legacy_script_workspace_parity.sql'), 'utf8');
const STOP_BEFORE = '246_content_pipeline_workspace_exit.sql';

describe('migration 246 content pipeline workspace exit', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase({ stopBefore: STOP_BEFORE });
  });

  afterEach(() => db.close());

  it('backfills each scoped legacy root once without asserting unpublished content phases', () => {
    const scriptedId = seedPipeline(db, {
      title: 'Legacy scripted item',
      stage: 'scripted',
      stageHistory: JSON.stringify([{ to: 'scripted', at: '2026-01-10T10:00:00.000Z' }]),
      scriptPath: '/private/legacy-script.docx',
      driveUrl: 'https://drive.example.invalid/legacy-script',
    });
    db.prepare(`
      INSERT INTO content_scripts (
        pipeline_id, topic, format, script_text, hook, sources_used, user_id,
        tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
        created_by, updated_by
      ) VALUES (?, ?, 'youtube', ?, ?, ?, 501, 101, 501, 'user_private', 'active', 'active', 501, 501)
    `).run(
      scriptedId,
      'Legacy scripted item',
      'Full legacy script body that must remain available until canonical artifact parity.',
      'Legacy hook',
      JSON.stringify(['source-a']),
    );
    db.prepare(`
      INSERT INTO content_performance (
        pipeline_id, video_url, views, user_id, tenant_id, owner_user_id,
        visibility_scope, lifecycle_state, scope_status, created_by, updated_by
      ) VALUES (?, 'https://video.example.invalid/legacy', 42, 501, 101, 501,
                'user_private', 'active', 'active', 501, 501)
    `).run(scriptedId);
    seedPipeline(db, { title: 'Other tenant item', stage: 'scripted', tenantId: 202, userId: 777 });
    seedPipeline(db, { title: 'Quarantined item', stage: 'review', scopeStatus: 'quarantined' });

    applyExitMigrations(db);
    expect(() => assertContentPipelineWorkspaceExitReady(db)).not.toThrow();

    const item = db.prepare(`
      SELECT id, artifact_phase, production_state, editorial_state,
             approval_state, review_required, audit_metadata_json
        FROM content_domain_objects
       WHERE tenant_id = 101 AND owner_user_id = 501
         AND json_extract(audit_metadata_json, '$.legacyPipelineId') = ?
    `).get(scriptedId) as any;
    expect(item).toMatchObject({
      artifact_phase: 'draft',
      production_state: 'active',
      editorial_state: 'drafted',
      approval_state: 'not_required',
      review_required: 0,
    });
    expect(JSON.parse(item.audit_metadata_json)).toMatchObject({
      legacyStage: 'scripted',
      contentParity: 'artifact_pinned',
      legacyScriptPath: '/private/legacy-script.docx',
      legacyDriveUrl: 'https://drive.example.invalid/legacy-script',
      requiresLinkedScriptImport: 1,
      requiresPerformanceImport: 1,
    });
    expect(db.prepare(`
      SELECT source_id, item_id, artifact_id, revision_id, content_parity_status
        FROM content_workspace_ingress_bindings
       WHERE tenant_id = 101 AND owner_user_id = 501 AND source_kind = 'legacy_pipeline'
    `).all()).toEqual([{
      source_id: String(scriptedId),
      item_id: item.id,
      artifact_id: expect.any(Number),
      revision_id: expect.any(Number),
      content_parity_status: 'artifact_pinned',
    }]);
    const scriptBinding = db.prepare(`
      SELECT source_script_id, source_hash, item_id, artifact_id, revision_id,
             content_parity_status
        FROM content_legacy_script_ingress_bindings
       WHERE tenant_id = 101 AND owner_user_id = 501
    `).get() as any;
    expect(scriptBinding).toMatchObject({
      source_script_id: expect.any(Number),
      source_hash: createHash('sha256')
        .update('Full legacy script body that must remain available until canonical artifact parity.')
        .digest('hex'),
      item_id: item.id,
      content_parity_status: 'artifact_pinned',
    });
    expect(db.prepare(`
      SELECT content_format, content_text, revision_number, content_hash
        FROM content_revisions WHERE id = ?
    `).get(scriptBinding.revision_id)).toEqual({
      content_format: 'plain_text',
      content_text: 'Full legacy script body that must remain available until canonical artifact parity.',
      revision_number: 1,
      content_hash: createHash('sha256').update(JSON.stringify({
        format: 'plain_text',
        text: 'Full legacy script body that must remain available until canonical artifact parity.',
      })).digest('hex'),
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_workflow_events
       WHERE object_id = ? AND action = 'legacy_pipeline_migrated'
    `).get(String(item.id))).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_domain_objects
       WHERE json_extract(audit_metadata_json, '$.migration') = 'content_pipeline_246'
    `).get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT script_text, hook, sources_used FROM content_scripts WHERE pipeline_id = ?')
      .get(scriptedId)).toMatchObject({
        script_text: expect.stringContaining('must remain available'),
        hook: 'Legacy hook',
        sources_used: JSON.stringify(['source-a']),
      });
  });

  it.each([
    { label: 'no URL or time', publishedUrl: null, publishedAt: null },
    { label: 'URL only', publishedUrl: 'https://video.example.invalid/url-only', publishedAt: null },
    {
      label: 'URL and time',
      publishedUrl: 'https://video.example.invalid/with-time',
      publishedAt: '2026-02-10T12:00:00.000Z',
    },
  ])('never turns a legacy published claim with $label into canonical publication', ({ publishedUrl, publishedAt }) => {
    const pipelineId = seedPipeline(db, {
      title: `Legacy published ${publishedUrl ?? 'without evidence'}`,
      stage: 'published',
      publishedUrl,
      publishedAt,
    });

    applyExitMigrations(db);

    const item = db.prepare(`
      SELECT artifact_phase, production_state, editorial_state, approval_state,
             review_required, review_reason_codes_json, audit_metadata_json
        FROM content_domain_objects
       WHERE json_extract(audit_metadata_json, '$.legacyPipelineId') = ?
    `).get(pipelineId) as any;
    expect(item).toMatchObject({
      artifact_phase: 'idea',
      production_state: 'review',
      editorial_state: 'review',
      approval_state: 'required',
      review_required: 1,
    });
    expect(JSON.parse(item.review_reason_codes_json)).toEqual(expect.arrayContaining([
      'legacy_publication_claim_requires_verification',
      'legacy_content_parity_pending',
    ]));
    expect(JSON.parse(item.audit_metadata_json)).toMatchObject({
      publicationEvidence: 'unverified_legacy_claim',
      legacyPublishedUrl: publishedUrl,
      legacyPublishedAt: publishedAt,
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM content_workflow_events
       WHERE action = 'workspace_state_changed' AND to_state = 'published'
    `).get()).toEqual({ count: 0 });
  });

  it('binds a pinned legacy agency package to one item without fabricating an artifact', () => {
    const hash = 'a'.repeat(64);
    const pipelineId = seedPipeline(db, {
      title: 'Legacy agency review',
      stage: 'review',
      packageId: 'package_legacy_243',
      packageHash: hash,
    });

    applyExitMigrations(db);

    const bindings = db.prepare(`
      SELECT source_kind, source_id, source_hash, item_id, artifact_id,
             revision_id, content_parity_status
        FROM content_workspace_ingress_bindings
       WHERE tenant_id = 101 AND owner_user_id = 501
       ORDER BY source_kind
    `).all() as any[];
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toMatchObject({
      source_kind: 'content_agency_package',
      source_id: 'package_legacy_243',
      source_hash: hash,
      artifact_id: null,
      revision_id: null,
      content_parity_status: 'metadata_only',
    });
    expect(bindings[1]).toMatchObject({ source_kind: 'legacy_pipeline', source_id: String(pipelineId) });
    expect(bindings[0].item_id).toBe(bindings[1].item_id);
  });

  it('imports every scoped script losslessly and never follows a cross-tenant pipeline identifier', () => {
    const ownerPipeline = seedPipeline(db, { title: 'Owner pipeline', stage: 'scripted' });
    seedPipeline(db, { title: 'Tenant B pipeline', stage: 'scripted', tenantId: 202, userId: 777 });
    const ownerScript = seedLegacyScript(db, {
      pipelineId: ownerPipeline,
      topic: 'Owner script',
      body: 'Owner body\nwith exact spacing.  ',
      tenantId: 101,
      userId: 501,
    });
    const tenantBScript = seedLegacyScript(db, {
      // The numeric FK resolves, but its scope is foreign and must never choose
      // tenant A's canonical item.
      pipelineId: ownerPipeline,
      topic: 'Tenant B standalone script',
      body: 'Tenant B private body',
      tenantId: 202,
      userId: 777,
    });

    applyExitMigrations(db);
    expect(() => assertContentPipelineWorkspaceExitReady(db)).not.toThrow();

    const bindings = db.prepare(`
      SELECT source_script_id, tenant_id, owner_user_id, item_id, artifact_id, revision_id
        FROM content_legacy_script_ingress_bindings
       ORDER BY tenant_id, source_script_id
    `).all() as any[];
    expect(bindings).toHaveLength(2);
    const owner = bindings.find((row) => row.source_script_id === ownerScript)!;
    const tenantB = bindings.find((row) => row.source_script_id === tenantBScript)!;
    expect(owner).toMatchObject({ tenant_id: 101, owner_user_id: 501 });
    expect(tenantB).toMatchObject({ tenant_id: 202, owner_user_id: 777 });
    expect(tenantB.item_id).not.toBe(owner.item_id);
    expect(db.prepare('SELECT content_text FROM content_revisions WHERE id = ?').get(owner.revision_id))
      .toEqual({ content_text: 'Owner body\nwith exact spacing.  ' });
    expect(db.prepare(`
      SELECT json_extract(audit_metadata_json, '$.migration') AS migration,
             json_extract(audit_metadata_json, '$.legacyScriptId') AS legacy_script_id
        FROM content_domain_objects WHERE id = ?
    `).get(tenantB.item_id)).toEqual({
      migration: 'content_legacy_script_252',
      legacy_script_id: tenantBScript,
    });
  });

  it('preserves active script bodies whose legacy topic is blank or Unicode whitespace', () => {
    const blankTopic = '   ';
    const unicodeTopic = '\u00a0\u2003\u202f';
    const firstBody = 'Valuable legacy body with exact spacing.  ';
    const secondBody = 'Second untitled body\nkept byte-for-byte.';
    const firstScript = seedLegacyScript(db, {
      topic: blankTopic,
      body: firstBody,
      tenantId: 101,
      userId: 501,
    });
    const secondScript = seedLegacyScript(db, {
      topic: unicodeTopic,
      body: secondBody,
      tenantId: 101,
      userId: 501,
    });

    applyExitMigrations(db);
    expect(() => assertContentPipelineWorkspaceExitReady(db)).not.toThrow();

    const rows = db.prepare(`
      SELECT binding.source_script_id AS sourceScriptId,
             binding.item_id AS itemId,
             binding.artifact_id AS artifactId,
             binding.revision_id AS revisionId,
             item.title AS itemTitle,
             artifact.title AS artifactTitle,
             revision.content_text AS contentText,
             json_extract(item.audit_metadata_json, '$.legacyRawTopic') AS itemRawTopic,
             json_extract(artifact.metadata_json, '$.legacyRawTopic') AS artifactRawTopic,
             json_extract(revision.provenance_json, '$.legacyRawTopic') AS revisionRawTopic
        FROM content_legacy_script_ingress_bindings AS binding
        JOIN content_domain_objects AS item ON item.id = binding.item_id
        JOIN content_artifacts AS artifact ON artifact.id = binding.artifact_id
        JOIN content_revisions AS revision ON revision.id = binding.revision_id
       WHERE binding.source_script_id IN (?, ?)
       ORDER BY binding.source_script_id
    `).all(firstScript, secondScript) as any[];

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.itemId)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(rows[0].itemId).not.toBe(rows[1].itemId);
    expect(rows).toEqual([
      expect.objectContaining({
        sourceScriptId: firstScript,
        itemTitle: 'Untitled script',
        artifactTitle: 'Untitled script',
        contentText: firstBody,
        itemRawTopic: blankTopic,
        artifactRawTopic: blankTopic,
        revisionRawTopic: blankTopic,
      }),
      expect.objectContaining({
        sourceScriptId: secondScript,
        itemTitle: 'Untitled script',
        artifactTitle: 'Untitled script',
        contentText: secondBody,
        itemRawTopic: unicodeTopic,
        artifactRawTopic: unicodeTopic,
        revisionRawTopic: unicodeTopic,
      }),
    ]);
  });

  it('enforces scoped ingress identity and blocks every post-cutover legacy write', () => {
    const pipelineId = seedPipeline(db, { title: 'Cutover item', stage: 'review' });
    const scriptId = seedLegacyScript(db, {
      pipelineId,
      topic: 'Cutover script',
      body: 'Canonical parity must stop the old script writer.',
      tenantId: 101,
      userId: 501,
    });
    applyExitMigrations(db);
    const item = db.prepare(`
      SELECT id FROM content_domain_objects
       WHERE json_extract(audit_metadata_json, '$.legacyPipelineId') = ?
    `).get(pipelineId) as { id: number };

    expect(() => db.prepare(`
      INSERT INTO content_workspace_ingress_bindings (
        tenant_id, owner_user_id, source_kind, source_id, item_id, ingress_origin
      ) VALUES (202, 501, 'legacy_pipeline', 'cross-scope', ?, 'legacy_pipeline_backfill')
    `).run(item.id)).toThrow(/scope mismatch/i);
    expect(() => seedPipeline(db, { title: 'Old rollback writer', stage: 'review' }))
      .toThrow(/content_pipeline is read-only after migration 246/i);
    expect(() => db.prepare('UPDATE content_pipeline SET stage = ? WHERE id = ?')
      .run('published', pipelineId)).toThrow(/content_pipeline is read-only after migration 246/i);
    expect(() => db.prepare(`
      INSERT INTO content_scripts (
        topic, format, script_text, user_id, tenant_id, owner_user_id,
        visibility_scope, lifecycle_state, scope_status, created_by, updated_by
      ) VALUES ('Old script writer', 'youtube', 'must not split-write', 501, 101, 501,
                'user_private', 'active', 'active', 501, 501)
    `).run()).toThrow(/content_scripts user scope is read-only after migration 252/i);
    expect(() => db.prepare('UPDATE content_scripts SET script_text = ? WHERE id = ?')
      .run('mutated legacy body', scriptId))
      .toThrow(/content_scripts user scope is read-only after migration 252/i);

    // Account erasure deletes legacy archives after canonical records are
    // removed; it must not require a code-only downgrade to proceed.
    const canonicalBinding = db.prepare(`
      SELECT artifact_id, revision_id
        FROM content_legacy_script_ingress_bindings
       WHERE tenant_id = 101 AND owner_user_id = 501 AND source_script_id = ?
    `).get(scriptId) as { artifact_id: number; revision_id: number };
    expect(() => db.prepare(`
      DELETE FROM content_scripts
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).run(scriptId, 101, 501)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_scripts WHERE id = ?').get(scriptId))
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_artifacts WHERE id = ?').get(canonicalBinding.artifact_id))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_revisions WHERE id = ?').get(canonicalBinding.revision_id))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_domain_objects WHERE title = ?')
      .get('Old rollback writer')).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_scripts WHERE topic = ?')
      .get('Old script writer')).toEqual({ count: 0 });
  });

  it('fails readiness when a writer guard is missing or an active private root is unbound', () => {
    const missingGuard = createMigratedTestDatabase({ stopBefore: STOP_BEFORE });
    try {
      seedPipeline(missingGuard, { title: 'Guarded root', stage: 'review' });
      applyExitMigrations(missingGuard);
      missingGuard.exec('DROP TRIGGER trg_content_pipeline_legacy_update_blocked');
      expect(() => assertContentPipelineWorkspaceExitReady(missingGuard))
        .toThrow(/content_pipeline_workspace_exit_schema_not_ready/);
    } finally {
      missingGuard.close();
    }

    const missingLegacyScriptGuard = createMigratedTestDatabase({ stopBefore: STOP_BEFORE });
    try {
      seedLegacyScript(missingLegacyScriptGuard, {
        topic: 'Guarded script root',
        body: 'The legacy script guard is part of cutover readiness.',
        tenantId: 101,
        userId: 501,
      });
      applyExitMigrations(missingLegacyScriptGuard);
      missingLegacyScriptGuard.exec('DROP TRIGGER trg_content_scripts_legacy_user_update_blocked');
      expect(() => assertContentPipelineWorkspaceExitReady(missingLegacyScriptGuard))
        .toThrow(/content_pipeline_workspace_exit_schema_not_ready/);
    } finally {
      missingLegacyScriptGuard.close();
    }

    seedPipeline(db, { title: '   ', stage: 'review' });
    applyExitMigrations(db);
    expect(() => assertContentPipelineWorkspaceExitReady(db))
      .toThrow(/content_pipeline_workspace_exit_integrity_failed/);
  });

  it('refuses down migration with ingress evidence and allows an empty-schema reversal', () => {
    const pipelineId = seedPipeline(db, { title: 'Keep canonical history', stage: 'review' });
    seedLegacyScript(db, {
      pipelineId,
      topic: 'Keep canonical script history',
      body: 'Immutable canonical history.',
      tenantId: 101,
      userId: 501,
    });
    applyExitMigrations(db);
    expect(() => db.exec(SCRIPT_PARITY_DOWN)).toThrow(/content_legacy_script_252_rollback_requires_exact_snapshot/);
    expect(() => db.exec(DOWN)).toThrow(/content_pipeline_246_rollback_requires_zero_ingress_bindings/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'content_workspace_ingress_bindings'").get())
      .toEqual({ count: 1 });

    const empty = createMigratedTestDatabase({ stopBefore: STOP_BEFORE });
    try {
      applyExitMigrations(empty);
      empty.exec(SCRIPT_PARITY_DOWN);
      empty.exec(DOWN);
      expect(empty.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'content_workspace_ingress_bindings'").get())
        .toEqual({ count: 0 });
      expect(empty.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_content_pipeline_legacy_%'").get())
        .toEqual({ count: 0 });
      expect(empty.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_content_scripts_legacy_user_%'").get())
        .toEqual({ count: 0 });
    } finally {
      empty.close();
    }
  });
});

function seedPipeline(
  db: Database.Database,
  input: {
    title: string;
    stage: string;
    tenantId?: number;
    userId?: number;
    scopeStatus?: string;
    stageHistory?: string;
    scriptPath?: string | null;
    driveUrl?: string | null;
    publishedUrl?: string | null;
    publishedAt?: string | null;
    packageId?: string | null;
    packageHash?: string | null;
  },
): number {
  const userId = input.userId ?? 501;
  const tenantId = input.tenantId ?? 101;
  return Number(db.prepare(`
    INSERT INTO content_pipeline (
      topic_title, niche, stage, stage_history, script_path, drive_url,
      published_url, published_at, user_id, tenant_id, owner_user_id,
      visibility_scope, scope_status, source_agency_package_id,
      source_agency_package_hash, created_by, updated_by
    ) VALUES (?, 'creator operations', ?, ?, ?, ?, ?, ?, ?, ?, ?,
              'user_private', ?, ?, ?, ?, ?)
  `).run(
    input.title,
    input.stage,
    input.stageHistory ?? '[]',
    input.scriptPath ?? null,
    input.driveUrl ?? null,
    input.publishedUrl ?? null,
    input.publishedAt ?? null,
    userId,
    tenantId,
    userId,
    input.scopeStatus ?? 'active',
    input.packageId ?? null,
    input.packageHash ?? null,
    userId,
    userId,
  ).lastInsertRowid);
}

function applyExitMigrations(db: Database.Database): void {
  db.exec(UP);
  db.exec(SCRIPT_PARITY_UP);
}

function seedLegacyScript(
  db: Database.Database,
  input: {
    pipelineId?: number | null;
    topic: string;
    body: string;
    tenantId: number;
    userId: number;
  },
): number {
  return Number(db.prepare(`
    INSERT INTO content_scripts (
      pipeline_id, topic, format, script_text, title_options, sources_used,
      hashtags, user_id, tenant_id, owner_user_id, visibility_scope,
      lifecycle_state, scope_status, created_by, updated_by
    ) VALUES (?, ?, 'youtube', ?, '[]', '[]', '[]', ?, ?, ?,
              'user_private', 'active', 'active', ?, ?)
  `).run(
    input.pipelineId ?? null,
    input.topic,
    input.body,
    input.userId,
    input.tenantId,
    input.userId,
    input.userId,
    input.userId,
  ).lastInsertRowid);
}

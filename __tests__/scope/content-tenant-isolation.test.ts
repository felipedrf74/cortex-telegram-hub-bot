import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test', classifierModel: 'claude-test' },
    gemini: { apiKey: 'test', model: 'gemini-test', classifierModel: 'gemini-test' },
    openai: { apiKey: 'test', model: 'gpt-test', classifierModel: 'gpt-test' },
  },
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: vi.fn(),
  completeOneShotWithSearch: vi.fn(),
  isGeminiProviderConfigured: vi.fn(() => true),
}));

vi.mock('../../src/services/anthropic-hook', () => ({
  trackedCreate: vi.fn(),
}));

import { ensureContentTenantScopeColumns } from '../../src/services/content-tenant-scope';
import {
  getArtifactChain,
  getScriptByPipelineId,
} from '../../src/services/content-learning-store';
import {
  getTopicById,
  markScriptGenerated,
  updateFeedback,
} from '../../src/services/content-workflow';
import {
  getAngleDistribution,
  isDuplicateIdea,
} from '../../src/services/content-dedup';


function insertScopedContentBundle(userId: number, tenantId: number): { feedbackId: number; pipelineId: number } {
  const feedbackId = Number(testDb.prepare(`
    INSERT INTO content_topic_feedback (
      topic, niche, format, sentiment, source_job, hook_idea, why_now, angle_tag, user_id,
      tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
    )
    VALUES ('Scoped idea', 'ops', 'youtube', 'pending', 'manual', 'Hook', 'Now', 'framework', ?, ?, ?, 'user_private', 'active', 'active', ?, ?, '{}')
  `).run(userId, tenantId, userId, userId, userId).lastInsertRowid);

  testDb.prepare(`
    INSERT INTO saved_ideas (
      title, source, source_date, status, angle_tag, user_id,
      tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
    )
    VALUES ('Scoped idea', 'manual', '2026-04-29', 'new', 'framework', ?, ?, ?, 'user_private', 'active', 'active', ?, ?, '{}')
  `).run(userId, tenantId, userId, userId, userId);

  const pipelineId = Number(testDb.prepare(`
    INSERT INTO content_pipeline (
      topic_feedback_id, topic_title, niche, stage, script_path, user_id,
      tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
    )
    VALUES (?, 'Scoped idea', 'ops', 'scripted', '/tmp/scoped.docx', ?, ?, ?, 'user_private', 'active', 'active', ?, ?, '{}')
  `).run(feedbackId, userId, tenantId, userId, userId, userId).lastInsertRowid);

  testDb.prepare(`
    INSERT INTO content_scripts (
      pipeline_id, topic_feedback_id, topic, format, script_text, hook, title_options, sources_used, user_id,
      tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, 'Scoped idea', 'youtube', 'Tenant-owned script text', 'Hook', '[]', '[]', ?, ?, ?, 'user_private', 'active', 'active', ?, ?, '{}')
  `).run(pipelineId, feedbackId, userId, tenantId, userId, userId, userId);

  testDb.prepare(`
    INSERT INTO content_performance (
      pipeline_id, views, retention_pct, likes, user_id,
      tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
    )
    VALUES (?, 100, 44, 10, ?, ?, ?, 'user_private', 'active', 'active', ?, ?, '{}')
  `).run(pipelineId, userId, tenantId, userId, userId, userId);

  return { feedbackId, pipelineId };
}

describe('content tenant isolation sweep', () => {
  beforeEach(() => {
    // The isolation sweep seeds a legacy artifact chain. Migration 246 owns
    // the post-cutover write-block coverage for the production schema.
    testDb = createMigratedTestDatabase({ stopBefore: '246_content_pipeline_workspace_exit.sql' });
  });

  afterEach(() => {
    testDb?.close();
  });

  it('blocks cross-tenant artifact chain and script reads', () => {
    const { pipelineId } = insertScopedContentBundle(101, 1001);
    testDb.exec(readFileSync(
      resolve(process.cwd(), 'migrations/246_content_pipeline_workspace_exit.sql'),
      'utf8',
    ));

    expect(getScriptByPipelineId(pipelineId, 202, 2002)).toBeNull();
    expect(getArtifactChain(pipelineId, 202, 2002)).toMatchObject({
      availability: 'not_found',
      idea: null,
      topicFeedback: null,
      pipeline: null,
      script: null,
      performance: [],
      patterns: [],
    });

    const ownerChain = getArtifactChain(pipelineId, 101, 1001);
    expect(ownerChain).toMatchObject({
      availability: 'available',
      identifier: { requestedId: pipelineId, resolvedAs: 'legacy_pipeline_binding' },
      compatibility: { legacyIdentifierAccepted: true, legacyArchiveRead: false },
    });
    // Migration 246 truthfully leaves this metadata-only until a canonical
    // artifact/revision import pins parity; it does not surface the old script
    // as if it had already been migrated.
    expect(ownerChain.script).toBeNull();
    expect(ownerChain.performance).toHaveLength(1);
  });

  it('blocks cross-tenant topic feedback reads and writes', () => {
    const { feedbackId } = insertScopedContentBundle(101, 1001);

    updateFeedback(feedbackId, 'approved', 202, 2002);
    markScriptGenerated(feedbackId, 202, 2002);

    const afterDenied = testDb.prepare('SELECT sentiment, script_generated FROM content_topic_feedback WHERE id = ?')
      .get(feedbackId) as { sentiment: string; script_generated: number };
    expect(afterDenied).toEqual({ sentiment: 'pending', script_generated: 0 });
    expect(getTopicById(feedbackId, 202, 2002)).toBeNull();

    updateFeedback(feedbackId, 'approved', 101, 1001);
    markScriptGenerated(feedbackId, 101, 1001);

    const afterAllowed = testDb.prepare('SELECT sentiment, script_generated FROM content_topic_feedback WHERE id = ?')
      .get(feedbackId) as { sentiment: string; script_generated: number };
    expect(afterAllowed).toEqual({ sentiment: 'approved', script_generated: 1 });
    expect(getTopicById(feedbackId, 101, 1001)?.title).toBe('Scoped idea');
  });

  it('refuses content dedup and angle distribution without authenticated scope', async () => {
    await expect(isDuplicateIdea('Unsafe global comparison')).rejects.toThrow('Content dedup requires authenticated user scope');
    expect(() => getAngleDistribution()).toThrow('Content dedup requires authenticated user scope');
  });
});

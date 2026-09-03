// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { captureDiscoveredIdea } from '../../src/services/content-workspace-capture';
import {
  parseOptionalPositiveId,
  parseOptionalText,
  resolveScriptTopicContext,
} from '../../src/api/routes/content-topic-context';

function fakeDb(rows: {
  pipeline?: any;
  feedback?: any;
  idea?: any;
}) {
  return {
    prepare(sql: string) {
      return {
        get(..._args: unknown[]) {
          if (sql.includes('FROM content_pipeline')) return rows.pipeline;
          if (sql.includes('FROM content_topic_feedback')) return rows.feedback;
          if (sql.includes('FROM saved_ideas')) return rows.idea;
          return undefined;
        },
      };
    },
  } as any;
}

describe('content topic context helpers', () => {
  it('parses positive ids and non-empty text defensively', () => {
    expect(parseOptionalPositiveId('42')).toBe(42);
    expect(parseOptionalPositiveId(12.6)).toBeNull();
    expect(parseOptionalPositiveId('12suffix')).toBeNull();
    expect(parseOptionalPositiveId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(parseOptionalPositiveId(0)).toBeNull();
    expect(parseOptionalPositiveId(-7)).toBeNull();
    expect(parseOptionalPositiveId(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseOptionalPositiveId('0')).toBeNull();
    expect(parseOptionalPositiveId(' -3 ')).toBeNull();
    expect(parseOptionalPositiveId('   ')).toBeNull();
    expect(parseOptionalPositiveId('nope')).toBeNull();
    expect(parseOptionalPositiveId(undefined)).toBeNull();
    expect(parseOptionalText('  hook  ')).toBe('hook');
    expect(parseOptionalText('   ')).toBeNull();
    expect(parseOptionalText('x'.repeat(6), 5)).toBeNull();
  });

  it('omits oversized stored prompt context instead of truncating an unsafe tail', () => {
    const context = resolveScriptTopicContext(
      7,
      { topicFeedbackId: 11 },
      fakeDb({
        feedback: {
          id: 11,
          niche: 'n'.repeat(161),
          hook_idea: 'h'.repeat(501),
          why_now: 'w'.repeat(1_001),
          angle_tag: 'a'.repeat(161),
          source_job: 's'.repeat(121),
        },
      }),
    );

    expect(context).toEqual({ topicFeedbackId: 11 });
  });

  it('merges first-party topic feedback rows with explicit request overrides', () => {
    const context = resolveScriptTopicContext(
      7,
      {
        topicFeedbackId: 11,
        niche: 'hybrid athlete',
        angleTag: 'override-angle',
      },
      fakeDb({
        feedback: {
          id: 11,
          niche: 'fitness',
          hook_idea: 'Three recovery mistakes',
          why_now: 'race week',
          angle_tag: 'base-angle',
          source_job: 'radar',
        },
      }),
    );

    expect(context).toEqual({
      topicFeedbackId: 11,
      niche: 'hybrid athlete',
      hookIdea: 'Three recovery mistakes',
      whyNow: 'race week',
      angleTag: 'override-angle',
      sourceJob: 'radar',
    });
  });

  it('ignores cross-user pipeline payloads without preserving unverified ids', () => {
    const context = resolveScriptTopicContext(
      7,
      { pipelineId: 99 },
      fakeDb({
        pipeline: {
          pipeline_id: 99,
          pipeline_user_id: 8,
          pipeline_niche: 'other user',
          hook_idea: 'do not leak',
        },
      }),
    );

    expect(context).toBeNull();
  });

  it('prefers a scoped canonical workspaceItemId over the legacy pipeline alias', () => {
    vi.stubEnv('CONTENT_WORKSPACE_V1_MODE', 'write');
    const db = createMigratedTestDatabase();
    try {
      const captured = captureDiscoveredIdea({
        scope: { tenantId: 7, userId: 7 },
        title: 'Canonical script context idea',
        sourceDate: '2026-07-17',
        score: 0.8,
        workflowEligible: true,
      }, db);

      expect(resolveScriptTopicContext(7, {
        workspaceItemId: captured.item.id,
        pipelineId: 999_999,
      }, db as any, 7)).toEqual({ pipelineId: captured.item.id });
      expect(resolveScriptTopicContext(7, {
        workspaceItemId: captured.item.id,
      }, db as any, 8)).toBeNull();
    } finally {
      db.close();
      vi.unstubAllEnvs();
    }
  });
});

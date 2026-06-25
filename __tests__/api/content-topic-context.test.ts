// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  parseOptionalPositiveId,
  parseOptionalText,
  resolveScriptTopicContext,
} from '../../src/api/routes/content-topic-context';

function fakeDb(rows: {
  pipeline?: any;
  feedback?: any;
  idea?: any;
  calls?: Array<{ sql: string; args: unknown[] }>;
}) {
  return {
    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          rows.calls?.push({ sql, args });
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
    expect(parseOptionalPositiveId(12.6)).toBe(13);
    expect(parseOptionalPositiveId('0')).toBeNull();
    expect(parseOptionalPositiveId('nope')).toBeNull();
    expect(parseOptionalText('  hook  ')).toBe('hook');
    expect(parseOptionalText('   ')).toBeNull();
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

  it('authorizes pipeline context through tenant scope parameters', () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const context = resolveScriptTopicContext(
      7,
      { pipelineId: 99 },
      fakeDb({
        calls,
        pipeline: {
          pipeline_id: 99,
          pipeline_user_id: 7,
          pipeline_tenant_id: 500,
          pipeline_owner_user_id: 7,
          pipeline_visibility_scope: 'user_private',
          pipeline_scope_status: 'active',
          pipeline_niche: 'creator ops',
          topic_feedback_id: 11,
          feedback_niche: 'creator ops',
          hook_idea: 'Use proof before polish',
          why_now: 'quality gate',
          angle_tag: 'source-backed',
          source_job: 'agency',
        },
      }),
      500,
    );

    const pipelineCall = calls.find((call) => call.sql.includes('FROM content_pipeline'));
    expect(pipelineCall?.sql).toContain('COALESCE(p.tenant_id');
    expect(pipelineCall?.args).toEqual([99, 500, 7, 500]);
    expect(context).toMatchObject({
      pipelineId: 99,
      topicFeedbackId: 11,
      niche: 'creator ops',
      hookIdea: 'Use proof before polish',
      whyNow: 'quality gate',
      angleTag: 'source-backed',
      sourceJob: 'agency',
    });
  });

  it('does not authorize pipeline context when the tenant does not match', () => {
    const context = resolveScriptTopicContext(
      7,
      { pipelineId: 99 },
      fakeDb({
        pipeline: {
          pipeline_id: 99,
          pipeline_user_id: 7,
          pipeline_tenant_id: 600,
          pipeline_owner_user_id: 7,
          pipeline_visibility_scope: 'user_private',
          pipeline_scope_status: 'active',
          pipeline_niche: 'wrong tenant',
          hook_idea: 'do not leak',
        },
      }),
      500,
    );

    expect(context).toBeNull();
  });

  it('authorizes idea and topic feedback context through tenant scope parameters', () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const context = resolveScriptTopicContext(
      7,
      { topicFeedbackId: 11, ideaId: 22 },
      fakeDb({
        calls,
        feedback: {
          id: 11,
          niche: 'creator ops',
          hook_idea: 'Stop shipping generic scripts',
          why_now: 'quality gate',
          angle_tag: 'brand-voice',
          source_job: 'radar',
        },
        idea: {
          id: 22,
          niche: 'creator ops',
          hook_idea: 'One voice card',
          why_now: 'tenant safe',
          angle_tag: 'pillars',
          source: 'discovery',
        },
      }),
      500,
    );

    const feedbackCall = calls.find((call) => call.sql.includes('FROM content_topic_feedback'));
    const ideaCall = calls.find((call) => call.sql.includes('FROM saved_ideas'));
    expect(feedbackCall?.sql).toContain('COALESCE(tenant_id');
    expect(ideaCall?.sql).toContain('COALESCE(tenant_id');
    expect(feedbackCall?.args).toEqual([11, 500, 7, 500]);
    expect(ideaCall?.args).toEqual([22, 500, 7, 500]);
    expect(context).toMatchObject({
      topicFeedbackId: 11,
      ideaId: 22,
      niche: 'creator ops',
      sourceJob: 'discovery',
    });
  });

  it('degrades to no topic context when feedback and idea scope queries hit a partial schema', () => {
    const partialSchemaDb = {
      prepare(sql: string) {
        return {
          get() {
            if (sql.includes('FROM content_topic_feedback') || sql.includes('FROM saved_ideas')) {
              throw new Error('no such column: tenant_id');
            }
            return undefined;
          },
        };
      },
    } as any;

    expect(() => resolveScriptTopicContext(
      7,
      { topicFeedbackId: 11, ideaId: 22 },
      partialSchemaDb,
      500,
    )).not.toThrow();
    expect(resolveScriptTopicContext(
      7,
      { topicFeedbackId: 11, ideaId: 22 },
      partialSchemaDb,
      500,
    )).toBeNull();
  });
});

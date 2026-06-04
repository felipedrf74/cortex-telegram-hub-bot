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
});

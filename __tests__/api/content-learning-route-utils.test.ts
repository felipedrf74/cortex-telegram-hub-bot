import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/api/routes/content-generation-meta', () => ({
  buildGenerationMeta: vi.fn(({ mode, provider, providerSemantics, researchUsed }: any) => ({
    mode,
    provider,
    providerSemantics,
    researchUsed,
    durationMs: 123,
  })),
}));

import {
  buildGeneratedTopicCandidatesResponse,
  buildLearnedPatternsResponse,
  buildPendingTopicsResponse,
  buildRecentScriptsResponse,
  buildTasteProfileResponse,
  buildWeeklyPackageResponse,
} from '../../src/api/routes/content-learning-route-utils';

describe('content-learning-route-utils', () => {
  it('builds generated topic candidate responses defensively', () => {
    const result = buildGeneratedTopicCandidatesResponse({
      format: 'youtube',
      sourceJob: 'manual',
      dayLabel: 'Tuesday',
      candidates: [
        {
          feedbackId: 1,
          title: 'Race recap',
          niche: 'running',
          hookIdea: 'What went wrong at km 30',
          whyNow: 'Recent race',
          angleTag: 'post-race',
        },
      ],
      generation: { provider: 'openai', grounded: true },
    }, 'reel', 'fallback', 1000);

    expect(result).toMatchObject({
      format: 'youtube',
      sourceJob: 'manual',
      dayLabel: 'Tuesday',
      count: 1,
      candidates: [
        {
          feedbackId: 1,
          title: 'Race recap',
          niche: 'running',
          hookIdea: 'What went wrong at km 30',
          whyNow: 'Recent race',
          angleTag: 'post-race',
        },
      ],
      generation: {
        mode: 'standard',
        provider: 'openai',
        providerSemantics: 'resolved_provider',
        researchUsed: true,
      },
    });
  });

  it('builds pending topic payloads for iOS review cards', () => {
    const result = buildPendingTopicsResponse([
      {
        id: 2,
        topic: 'Meal prep mistakes',
        niche: 'cooking',
        format: 'reel',
        hook_idea: '3 errors that ruin consistency',
        why_now: 'Weeknight friction is high',
        angle_tag: 'systems',
        source_job: 'manual',
        created_at: '2026-04-22T10:00:00.000Z',
      },
    ]);

    expect(result).toEqual({
      count: 1,
      topics: [
        {
          feedbackId: 2,
          title: 'Meal prep mistakes',
          niche: 'cooking',
          format: 'reel',
          hookIdea: '3 errors that ruin consistency',
          whyNow: 'Weeknight friction is high',
          angleTag: 'systems',
          sourceJob: 'manual',
          createdAt: '2026-04-22T10:00:00.000Z',
        },
      ],
    });
  });

  it('builds weekly package payloads with grouped candidates', () => {
    const result = buildWeeklyPackageResponse({
      youtube: [{ feedbackId: 10, title: 'Long-form idea', niche: 'training', hookIdea: 'Hook', whyNow: 'Now', angleTag: null }],
      reels: [{ feedbackId: 11, title: 'Short-form idea', niche: 'finance', hookIdea: 'Hook 2', whyNow: 'Soon', angleTag: 'budget' }],
      generation: { provider: 'anthropic', grounded: true },
    }, 2000);

    expect(result.youtube.count).toBe(1);
    expect(result.reels.candidates[0]).toMatchObject({
      feedbackId: 11,
      title: 'Short-form idea',
      niche: 'finance',
      angleTag: 'budget',
    });
    expect(result.generation).toMatchObject({
      mode: 'standard',
      provider: 'anthropic',
      providerSemantics: 'resolved_provider',
      researchUsed: true,
    });
  });

  it('builds taste-profile aggregates with approval rate and niche breakdown', () => {
    const result = buildTasteProfileResponse([
      { topic: 'A', niche: 'running', sentiment: 'approved' },
      { topic: 'B', niche: 'running', sentiment: 'rejected' },
      { topic: 'C', niche: '', sentiment: 'approved' },
    ]);

    expect(result).toMatchObject({
      totalFeedback: 3,
      approved: 2,
      rejected: 1,
      approvalRate: 67,
      nicheBreakdown: {
        running: { approved: 1, rejected: 1 },
        general: { approved: 1, rejected: 0 },
      },
    });
    expect(result.recentApproved).toHaveLength(2);
    expect(result.recentRejected).toHaveLength(1);
  });

  it('builds learned pattern and recent script list payloads', () => {
    const patterns = buildLearnedPatternsResponse([
      {
        id: 1,
        category: 'hook_effectiveness',
        patternText: 'Short hooks win',
        examples: ['Example 1'],
        confidence: 0.84,
        frequency: 4,
        sourceAgent: 'performance_agent',
        firstDetectedAt: '2026-04-20T10:00:00.000Z',
        lastSeenAt: '2026-04-21T10:00:00.000Z',
      },
    ]);
    const scripts = buildRecentScriptsResponse([
      {
        id: 9,
        topic: 'Hybrid training',
        format: 'youtube',
        hook: 'Why hybrid athletes stall',
        titleOptions: ['Title A'],
        estimatedDuration: 480,
        niche: 'training',
        createdAt: '2026-04-22T12:00:00.000Z',
        scriptText: 'x'.repeat(320),
      },
    ]);

    expect(patterns).toEqual({
      count: 1,
      patterns: [
        {
          id: 1,
          category: 'hook_effectiveness',
          pattern: 'Short hooks win',
          examples: ['Example 1'],
          confidence: 0.84,
          frequency: 4,
          sourceAgent: 'performance_agent',
          firstDetected: '2026-04-20T10:00:00.000Z',
          lastSeen: '2026-04-21T10:00:00.000Z',
        },
      ],
    });
    expect(scripts.count).toBe(1);
    expect(scripts.scripts[0].preview).toHaveLength(300);
  });
});

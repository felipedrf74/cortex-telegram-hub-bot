import { describe, expect, it } from 'vitest';

import { buildContentIntelligenceDetail, buildContentIntelligenceSummary } from '../../src/api/routes/content-intelligence-route-utils';

describe('content-intelligence-route-utils', () => {
  it('builds a stable intelligence summary with localized labels and honest statuses', () => {
    const summary = buildContentIntelligenceSummary({
      language: 'pt-PT',
      reactionJob: { lastRunAt: '2026-04-14T08:00:00.000Z', lastResult: 'success' },
      performanceJob: { lastRunAt: '2026-04-13T06:00:00.000Z', lastResult: 'success' },
      autoresearchJob: { lastRunAt: null, lastResult: 'never' },
      discoverySignals: [{ id: 1 }],
      optimizationSignals: [{ id: 1 }, { id: 2 }],
      voiceEntries: [
        {
          category: 'brand_voice',
          label: 'Brand Voice',
          text: 'Direct and clear.',
          sources: ['@felipe', '@danielbarada'],
          version: 2,
          updatedAt: '2026-04-14T09:00:00.000Z',
        },
      ],
      knowledgeStats: {
        referenceChannels: 1,
        categories: [],
      },
    });

    expect(summary.discovery).toMatchObject({
      status: 'ready',
      cadenceHours: 4,
      activeCount: 1,
      lastStatus: 'success',
    });
    expect(summary.script).toMatchObject({
      status: 'ready',
      voicePatternCount: 1,
      referenceChannelCount: 1,
      sourceCount: 2,
      hasBrandVoice: true,
    });
    expect(summary.optimization).toMatchObject({
      status: 'ready',
      cadence: 'weekly',
      activeInsightCount: 2,
      autoresearchLastStatus: 'never',
    });
    expect(summary.localized).toEqual({
      discoveryLabel: 'Discovery',
      scriptLabel: 'Script',
      scheduleLabel: 'Schedule',
      optimizationLabel: 'Optimization',
    });
  });

  it('builds detailed localized drill-in payloads for discovery, script, schedule, and optimization', () => {
    const detail = buildContentIntelligenceDetail({
      language: 'en-US',
      reactionJob: { lastRunAt: '2026-04-14T08:00:00.000Z', lastResult: 'success' },
      performanceJob: { lastRunAt: '2026-04-13T06:00:00.000Z', lastResult: 'success' },
      autoresearchJob: { lastRunAt: null, lastResult: 'never' },
      discoverySignals: [
        {
          signal_type: 'reaction_opportunity',
          payload: { title: 'fitness', summary: 'Janela de reação ativa: treino com forte gancho' },
          priority: 'urgent',
          created_at: '2026-04-16T10:00:00.000Z',
        },
      ],
      optimizationSignals: [
        {
          signal_type: 'learning_digest',
          payload: { summary: 'Hooks with stronger contrast won this week.' },
          priority: 'normal',
          created_at: '2026-04-13T06:00:00.000Z',
        },
      ],
      voiceEntries: [
        {
          category: 'brand_voice',
          label: 'Brand Voice',
          text: 'Direct, sharp, coach-like.',
          sources: ['@felipe', '@danielbarada'],
          version: 2,
          updatedAt: '2026-04-14T09:00:00.000Z',
        },
      ],
      knowledgeStats: {
        referenceChannels: 1,
        categories: [
          {
            category: 'brand_voice',
            sources: 2,
            updatedAt: '2026-04-14T09:00:00.000Z',
          },
        ],
      },
      filmingRecommendation: {
        date: '2026-04-18',
        confidence: 'high',
        reason: 'Friday has the best filming window.',
      },
      preferredTopics: ['fitness', 'training consistency'],
      monitoredPillars: [{ name: 'fitness', keywordCount: 1 }],
      deskItems: [{ type: 'script_ready', title: 'Script ready', body: 'Draft is ready for review.' }],
    });

    expect(detail.discovery).toMatchObject({
      status: 'ready',
      deskReadyCount: 1,
      preferredTopics: ['fitness', 'training consistency'],
      monitoredPillars: [{ name: 'fitness', keywordCount: 1 }],
    });
    expect(detail.discovery.recentSignals[0]).toMatchObject({
      title: 'Training',
      summary: 'Reaction window: treino com forte gancho',
      priority: 'urgent',
    });
    expect(detail.script.entries[0]).toMatchObject({
      category: 'brand_voice',
      label: 'Brand Voice',
      sourceCount: 2,
      version: 2,
    });
    expect(detail.script.knowledgeCategories[0]).toMatchObject({
      category: 'brand_voice',
      label: 'Brand Voice',
      sourceCount: 2,
    });
    expect(detail.schedule).toMatchObject({
      status: 'ready',
      filmingRecommendation: {
        date: '2026-04-18',
        confidence: 'high',
        reason: 'Friday has the best filming window.',
      },
    });
    expect(detail.optimization.recentSignals[0]).toMatchObject({
      type: 'learning_digest',
      summary: 'Hooks with stronger contrast won this week.',
    });
  });
});
